import { buildSystemPrompt } from './agent/prompt.js';
import { runAgentTurn } from './agent/loop.js';
import {
  COMPACT_KEEP_USER_TURNS,
  COMPACT_THRESHOLD,
  compactMessages,
  shouldCompact,
  type CompactResult,
} from './agent/compact.js';
import { contextWindowFor, type ProfileConfig } from './config.js';
import { estimateMessagesTokens } from './agent/tokens.js';
import { createProvider } from './providers/index.js';
import type { ChatMessage, ToolCall } from './providers/types.js';
import type { ToolContext } from './tools/types.js';
import {
  dropIncompleteToolCalls,
  latestSession,
  loadSession,
  newSessionId,
  saveSession,
  titleFromMessages,
  type SessionRecord,
} from './sessions.js';
import { redactSecrets } from './secrets.js';

export interface HeadlessOptions {
  config: { activeProfile: string; profiles: Record<string, ProfileConfig> };
  cwd: string;
  /**
   * The prompt text. When absent, the prompt is read from stdin, so
   * `echo "task" | kiro -p` works in shells, cron jobs, and CI.
   */
  prompt?: string;
  yolo: boolean;
  resumeId?: string;
  continueLatest: boolean;
  signal: AbortSignal;
}

/**
 * One-shot agent run without a TUI: `kiro -p "fix the tests"`.
 * Text streams to stdout; notices, tool calls, and reasoning go to stderr, so
 * `kiro -p … > out.md` stays clean for scripting. Same session store, system
 * prompt, compaction, and tools as the TUI. Approvals are denied outside
 * --yolo mode — a piped run never performs an unsupervised mutation.
 */
export async function runHeadless(options: HeadlessOptions): Promise<number> {
  const { config, cwd, yolo } = options;
  const stderr = process.stderr;
  const writeOut = process.stdout.write.bind(process.stdout);

  const prompt = (options.prompt ?? (await readStdinPrompt())).trim();
  if (!prompt) {
    stderr.write('Kiro: no prompt given. Pass one with -p "…", or pipe text into stdin.\n');
    return 2;
  }

  let session: SessionRecord | null = null;
  try {
    if (options.resumeId) {
      session = await loadSession(cwd, options.resumeId);
      if (!session) {
        stderr.write(`Kiro: session "${options.resumeId}" was not found for this directory.\n`);
        return 1;
      }
    } else if (options.continueLatest) {
      session = await latestSession(cwd);
    }
  } catch (error) {
    stderr.write(`Kiro: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const profile: ProfileConfig | undefined = config.profiles[config.activeProfile];
  if (!profile) {
    stderr.write(`Kiro: config has no profile "${config.activeProfile}".\n`);
    return 1;
  }

  const apiKey = profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined;
  if (profile.apiKeyEnv && !apiKey) {
    stderr.write(`Kiro: API key is missing: $${profile.apiKeyEnv} is not set (profile "${config.activeProfile}").\n`);
    return 1;
  }
  let provider;
  try {
    provider = createProvider(profile, apiKey);
  } catch (error) {
    stderr.write(`Kiro: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const warnedTools = new Set<string>();
  const ctx: ToolContext = {
    cwd,
    signal: options.signal,
    approve: yolo
      ? () => Promise.resolve('allow')
      : (request) => {
          if (!warnedTools.has(request.tool)) {
            warnedTools.add(request.tool);
            stderr.write(
              `# ${request.tool} denied: headless runs never approve tool calls. ` +
                `Run Kiro interactively, or pass --yolo to allow every tool.\n`,
            );
          }
          return Promise.resolve('deny');
        },
  };

  const notice = (line: string): void => {
    stderr.write(`# ${redactSecrets(line).replace(/\s+/g, ' ')}\n`);
  };

  try {
    const systemPrompt = await buildSystemPrompt(cwd);
    const working: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...((session?.messages ?? []).filter((message) => message.role !== 'system')),
    ];
    working.push({ role: 'user', content: prompt });

    const record: SessionRecord = session
      ? session
      : {
          version: 1,
          id: newSessionId(),
          cwd: cwd,
          profile: config.activeProfile,
          model: profile.model,
          title: titleFromMessages(working),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages: [],
        };

    const window = contextWindowFor(profile);
    const compactContext = async (
      items: ChatMessage[],
      signal: AbortSignal,
      compactOptions?: { force?: boolean },
    ): Promise<CompactResult | null> => {
      const used = estimateMessagesTokens(items);
      if (!compactOptions?.force && !shouldCompact(used, window, COMPACT_THRESHOLD)) return null;
      try {
        const result = await compactMessages({
          messages: items,
          provider,
          signal,
          keepUserTurns: COMPACT_KEEP_USER_TURNS,
        });
        if (result) {
          notice(
            `context compacted (~${result.beforeTokens.toLocaleString()} → ` +
              `~${result.afterTokens.toLocaleString()} tokens)`,
          );
        }
        return result;
      } catch (error) {
        notice(`could not compact: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    };

    let exitCode = 0;
    let lastTextChar = '';
    let reasoning = '';
    // Reasoning is live-only in the TUI; headless runs collapse each block to one
    // bounded stderr line so CI logs stay readable and never get key material.
    const flushReasoning = (): void => {
      if (!reasoning) return;
      const text = redactSecrets(reasoning).replace(/\s+/g, ' ').trim();
      reasoning = '';
      if (!text) return;
      const cap = 4_000;
      stderr.write(`# reasoning: ${text.length > cap ? `${text.slice(0, cap)}…` : text}\n`);
    };
    for await (const event of runAgentTurn({
      provider,
      messages: working,
      ctx,
      compactContext,
    })) {
      if (event.type === 'text') {
        flushReasoning();
        if (event.text) {
          writeOut(event.text);
          lastTextChar = event.text.at(-1) ?? lastTextChar;
        }
      } else if (event.type === 'reasoning') {
        reasoning += event.text;
      } else if (event.type === 'tool-start') {
        flushReasoning();
        stderr.write(`# ${toolCallLine(event.toolCall)}\n`);
      } else if (event.type === 'notice') {
        flushReasoning();
        notice(event.message);
      } else if (event.type === 'done') {
        flushReasoning();
        if (event.reason === 'aborted') {
          notice('turn cancelled');
          exitCode = 130;
        } else if (event.reason === 'error') exitCode = 1;
        else if (event.reason === 'max-iterations') {
          notice('the turn stopped at the tool-round cap; send another -p message to continue');
        } else if (event.reason !== 'complete') {
          exitCode = 1;
        }
      }
    }
    flushReasoning();
    // Keep shell prompts and piped files tidy without altering the model's text.
    if (lastTextChar && lastTextChar !== '\n') writeOut('\n');

    const cleaned = dropIncompleteToolCalls(working.filter((message) => message.role !== 'system'));
    if (cleaned.length > 0) {
      await saveSession({
        id: record.id,
        cwd,
        profile: config.activeProfile,
        model: profile.model,
        title: record.title || titleFromMessages(cleaned),
        createdAt: record.createdAt,
        messages: cleaned,
      });
    }
    return exitCode;
  } catch (error) {
    stderr.write(`Kiro: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function toolCallLine(call: ToolCall): string {
  let args = call.function.arguments;
  try {
    args = JSON.stringify(JSON.parse(args));
  } catch {
    // Keep raw arguments; parsing is a nicety for alignment only.
  }
  return `${call.function.name}(${redactSecrets(args.length > 200 ? `${args.slice(0, 200)}…` : args)})`;
}

/** Reads a piped prompt until EOF; no-op on an interactive terminal. */
async function readStdinPrompt(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
