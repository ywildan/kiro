import type { ChatMessage, Provider } from '../providers/types.js';
import { estimateMessagesTokens } from './tokens.js';

export const COMPACT_THRESHOLD = 0.8;
export const COMPACT_KEEP_USER_TURNS = 4;
export const PLACEHOLDER_TOOL_RESULT_CHARS = 2_000;
export const MAX_SUMMARY_INPUT_CHARS = 100_000;
const MAX_TRANSCRIPT_MESSAGE_CHARS = 4_000;
const TOOL_ARGS_PREVIEW_CHARS = 500;

export const SUMMARY_PREFIX = '[Context summary — earlier turns were compacted to save space]';

export interface CompactOptions {
  messages: ChatMessage[];
  provider: Provider;
  signal?: AbortSignal;
  keepUserTurns?: number;
}

export interface CompactResult {
  messages: ChatMessage[];
  summary: string;
  beforeTokens: number;
  afterTokens: number;
  /** Number of non-system messages replaced by the summary. */
  summarizedMessages: number;
}

export function shouldCompact(
  usedTokens: number,
  contextWindow: number,
  threshold = COMPACT_THRESHOLD,
): boolean {
  return contextWindow > 0 && usedTokens >= Math.floor(contextWindow * threshold);
}

function isSummaryMessage(message: ChatMessage): boolean {
  return message.role === 'user' && (message.content ?? '').startsWith(SUMMARY_PREFIX);
}

/**
 * Index where the last `keepUserTurns` real user turns begin. Everything before
 * it can be summarized. Returns -1 when there is not enough history, or when the
 * boundary would be the first message (nothing older to summarize).
 */
export function findCompactBoundary(messages: ChatMessage[], keepUserTurns: number): number {
  const userIndices: number[] = [];
  messages.forEach((message, index) => {
    if (message.role === 'user' && !isSummaryMessage(message)) userIndices.push(index);
  });
  if (userIndices.length <= keepUserTurns) return -1;
  const boundary = userIndices[userIndices.length - keepUserTurns]!;
  return boundary > 0 ? boundary : -1;
}

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.4);
  const tail = max - head;
  return `${text.slice(0, head)}\n… [${text.length - max} characters omitted] …\n${text.slice(-tail)}`;
}

function placeholderForToolResult(message: ChatMessage): string {
  const size = message.content?.length ?? 0;
  if (size <= PLACEHOLDER_TOOL_RESULT_CHARS) return message.content ?? '';
  const name = message.name ?? 'tool';
  return `[${name} result omitted during compaction: ${size.toLocaleString()} characters]`;
}

function transcriptLine(message: ChatMessage): string {
  if (message.role === 'tool') {
    return `TOOL (${message.name ?? 'unknown'}): ${placeholderForToolResult(message)}`;
  }
  if (message.role === 'assistant') {
    const body = truncateMiddle(message.content ?? '', MAX_TRANSCRIPT_MESSAGE_CHARS);
    const calls =
      message.tool_calls
        ?.map((call) => {
          const args = truncateMiddle(call.function.arguments, TOOL_ARGS_PREVIEW_CHARS);
          return `  -> ${call.function.name}(${args})`;
        })
        .join('\n') ?? '';
    return `ASSISTANT: ${body}${calls ? `\n${calls}` : ''}`.trim();
  }
  if (message.role === 'user') {
    return `USER: ${truncateMiddle(message.content ?? '', MAX_TRANSCRIPT_MESSAGE_CHARS)}`;
  }
  return `SYSTEM: ${truncateMiddle(message.content ?? '', MAX_TRANSCRIPT_MESSAGE_CHARS)}`;
}

const SUMMARY_SYSTEM_PROMPT = [
  'You compress earlier parts of a coding-assistant conversation into a handoff note.',
  'The assistant will continue the same task after compaction, so preserve facts it needs.',
  'Write plain text with exactly these headings:',
  'Goal:',
  'Files touched:',
  'Decisions:',
  'Current state:',
  'Open TODOs:',
  'Be concise and specific. Mention file paths, commands, and errors that matter.',
  'Never invent details that are not in the transcript. If something is unknown, say so.',
].join('\n');

async function summarizeOlderMessages(
  older: ChatMessage[],
  provider: Provider,
  signal: AbortSignal | undefined,
): Promise<string> {
  const transcript = truncateMiddle(
    older.map(transcriptLine).join('\n\n'),
    MAX_SUMMARY_INPUT_CHARS,
  );
  const request: ChatMessage[] = [
    { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Summarize this earlier part of the conversation for the next turn.\n\n${transcript}`,
    },
  ];
  let text = '';
  for await (const event of provider.stream(request, [], { signal })) {
    if (event.type === 'text') text += event.text;
  }
  const trimmed = text.trim();
  if (!trimmed) throw new Error('The model returned an empty compaction summary.');
  return trimmed;
}

/**
 * Replaces older turns with a structured model-written summary while keeping
 * the system prompt and the last `keepUserTurns` user turns verbatim.
 * The boundary is always a user message, so assistant tool calls never lose
 * their tool results.
 */
export async function compactMessages(options: CompactOptions): Promise<CompactResult | null> {
  const { messages, provider, signal } = options;
  const keepUserTurns = Math.max(1, options.keepUserTurns ?? COMPACT_KEEP_USER_TURNS);
  const boundary = findCompactBoundary(messages, keepUserTurns);
  if (boundary === -1) return null;

  const leadingSystem: ChatMessage[] = [];
  let index = 0;
  while (messages[index]?.role === 'system') {
    leadingSystem.push(messages[index]!);
    index++;
  }

  const older = messages.slice(index, boundary);
  if (older.length === 0) return null;
  if (signal?.aborted) throw new Error('Compaction cancelled.');

  const summary = await summarizeOlderMessages(older, provider, signal);
  const summaryMessage: ChatMessage = {
    role: 'user',
    content: `${SUMMARY_PREFIX}\n\n${summary}`,
  };
  const kept = messages.slice(boundary);
  const next = [...leadingSystem, summaryMessage, ...kept];

  return {
    messages: next,
    summary,
    beforeTokens: estimateMessagesTokens(messages),
    afterTokens: estimateMessagesTokens(next),
    summarizedMessages: older.length,
  };
}
