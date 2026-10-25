import type { ChatMessage, Provider, TokenUsage, ToolCall } from '../providers/types.js';
import { ProviderError } from '../providers/types.js';
import type { CompactResult } from './compact.js';
import {
  executeTool,
  isReadOnlyTool,
  toolDefinitions,
  type ToolResult,
} from '../tools/index.js';
import type { ToolContext } from '../tools/types.js';

export const MAX_TOOL_ROUNDS = 25;

export interface ToolBatch {
  readOnly: boolean;
  calls: ToolCall[];
}

/** Groups contiguous read-only calls so they can run in parallel; mutations stay sequential. */
export function planToolBatches(calls: ToolCall[]): ToolBatch[] {
  const batches: ToolBatch[] = [];
  for (const call of calls) {
    const readOnly = isReadOnlyTool(call.function.name);
    const current = batches[batches.length - 1];
    if (readOnly && current?.readOnly) {
      current.calls.push(call);
    } else {
      batches.push({ readOnly, calls: [call] });
    }
  }
  return batches;
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'assistant'; content: string }
  | { type: 'tool-start'; toolCall: ToolCall }
  | { type: 'tool-end'; toolCall: ToolCall; result: ToolResult; durationMs: number }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'notice'; level: 'info' | 'error'; message: string }
  | { type: 'done'; reason: 'complete' | 'aborted' | 'max-iterations' | 'error' };

export interface RunTurnOptions {
  provider: Provider;
  messages: ChatMessage[];
  ctx: ToolContext;
  maxToolRounds?: number;
  /**
   * Called before each model round; returns null when the context is still small enough.
   * Pass `force` to compact regardless of the threshold (used after a context-overflow error).
   */
  compactContext?: (
    messages: ChatMessage[],
    signal: AbortSignal,
    options?: { force?: boolean },
  ) => Promise<CompactResult | null>;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function cancelledResult(): ToolResult {
  return {
    content: 'Cancelled by user before this tool ran.',
    summary: 'cancelled',
    status: 'denied',
  };
}

/**
 * Runs one user turn, appending assistant/tool messages to `messages` as it goes.
 * The messages array must already contain the system prompt and the new user message.
 */
export async function* runAgentTurn(options: RunTurnOptions): AsyncGenerator<AgentEvent> {
  const { provider, messages, ctx } = options;
  const maxRounds = options.maxToolRounds ?? MAX_TOOL_ROUNDS;
  let rounds = 0;
  let compactionAttempted = false;
  let overflowRetried = false;

  while (true) {
    if (ctx.signal.aborted) {
      yield { type: 'done', reason: 'aborted' };
      return;
    }

    if (!compactionAttempted && options.compactContext) {
      try {
        const compacted = await options.compactContext(messages, ctx.signal);
        if (compacted) {
          messages.splice(0, messages.length, ...compacted.messages);
          compactionAttempted = true;
          yield {
            type: 'notice',
            level: 'info',
            message:
              `Context was compacted: ${compacted.summarizedMessages} earlier messages summarized ` +
              `(~${compacted.beforeTokens.toLocaleString()} → ~${compacted.afterTokens.toLocaleString()} tokens).`,
          };
        }
      } catch (error) {
        compactionAttempted = true;
        if (!ctx.signal.aborted) {
          yield {
            type: 'notice',
            level: 'error',
            message: `Could not compact context: ${errorMessage(error)}`,
          };
        }
      }
    }
    if (ctx.signal.aborted) {
      yield { type: 'done', reason: 'aborted' };
      return;
    }

    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    let streamError: unknown;
    let finishReason: string | undefined;

    try {
      for await (const event of provider.stream(messages, toolDefinitions, { signal: ctx.signal })) {
        if (ctx.signal.aborted) break;
        if (event.type === 'text') {
          textParts.push(event.text);
          yield { type: 'text', text: event.text };
        } else if (event.type === 'tool_call') {
          toolCalls.push(event.toolCall);
        } else if (event.type === 'usage') {
          yield { type: 'usage', usage: event.usage };
        } else if (event.type === 'finish') {
          finishReason = event.reason;
        } else if (event.type === 'notice') {
          yield { type: 'notice', level: 'info', message: event.message };
        }
      }
    } catch (error) {
      streamError = error;
    }

    const text = textParts.join('');

    if (ctx.signal.aborted) {
      if (text) {
        messages.push({ role: 'assistant', content: text });
        yield { type: 'assistant', content: text };
      }
      yield { type: 'done', reason: 'aborted' };
      return;
    }

    if (streamError) {
      const overflow = streamError instanceof ProviderError && streamError.overflow;
      if (overflow && !overflowRetried && options.compactContext) {
        overflowRetried = true;
        compactionAttempted = true;
        let compacted: CompactResult | null = null;
        let compactError: unknown;
        try {
          compacted = await options.compactContext(messages, ctx.signal, { force: true });
        } catch (error) {
          compactError = error;
        }
        if (compacted) {
          messages.splice(0, messages.length, ...compacted.messages);
          if (!ctx.signal.aborted) {
            yield {
              type: 'notice',
              level: 'info',
              message:
                `The endpoint rejected the request as too long. ${compacted.summarizedMessages} earlier ` +
                `messages were summarized (~${compacted.beforeTokens.toLocaleString()} → ` +
                `~${compacted.afterTokens.toLocaleString()} tokens); retrying the turn.`,
            };
          }
          continue;
        }
        if (ctx.signal.aborted) continue;
        yield {
          type: 'notice',
          level: 'error',
          message: compactError
            ? `The request exceeded the model's context window and compaction failed: ${errorMessage(compactError)}`
            : `The request exceeded the model's context window, but there was nothing left to summarize. ` +
              'Set a smaller contextWindow for this profile, or start a new session.',
        };
      }
      if (text) {
        messages.push({ role: 'assistant', content: text });
        yield { type: 'assistant', content: text };
      }
      yield { type: 'notice', level: 'error', message: errorMessage(streamError) };
      yield { type: 'done', reason: 'error' };
      return;
    }

    if (finishReason === 'length') {
      yield {
        type: 'notice',
        level: 'error',
        message:
          toolCalls.length > 0
            ? 'The model hit its max_tokens limit mid-response, so tool call arguments may be incomplete. ' +
              'Raise maxTokens for this profile or ask for smaller steps.'
            : 'The model hit its max_tokens limit and the response was cut short. ' +
              'Raise maxTokens for this profile, or ask it to continue.',
      };
    }

    if (toolCalls.length === 0) {
      if (text) {
        messages.push({ role: 'assistant', content: text });
        yield { type: 'assistant', content: text };
      } else {
        yield { type: 'notice', level: 'info', message: 'The model returned an empty response.' };
      }
      yield { type: 'done', reason: 'complete' };
      return;
    }

    messages.push({
      role: 'assistant',
      content: text || null,
      tool_calls: toolCalls,
    });
    if (text) yield { type: 'assistant', content: text };

    for (const batch of planToolBatches(toolCalls)) {
      if (ctx.signal.aborted) {
        for (const toolCall of batch.calls) {
          const result = cancelledResult();
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: result.content,
          });
          yield { type: 'tool-start', toolCall };
          yield { type: 'tool-end', toolCall, result, durationMs: 0 };
        }
        continue;
      }

      if (!batch.readOnly) {
        for (const toolCall of batch.calls) {
          yield { type: 'tool-start', toolCall };
          const startedAt = Date.now();
          const result = await executeTool(toolCall.function.name, toolCall.function.arguments, ctx);
          const durationMs = Date.now() - startedAt;
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: result.content,
          });
          yield { type: 'tool-end', toolCall, result, durationMs };
        }
        continue;
      }

      for (const toolCall of batch.calls) {
        yield { type: 'tool-start', toolCall };
      }
      const outcomes = await Promise.all(
        batch.calls.map(async (toolCall) => {
          const startedAt = Date.now();
          const result = await executeTool(toolCall.function.name, toolCall.function.arguments, ctx);
          return { result, durationMs: Date.now() - startedAt };
        }),
      );
      for (const [index, outcome] of outcomes.entries()) {
        const toolCall = batch.calls[index]!;
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: outcome.result.content,
        });
        yield { type: 'tool-end', toolCall, result: outcome.result, durationMs: outcome.durationMs };
      }
    }

    rounds++;
    if (ctx.signal.aborted) {
      yield { type: 'done', reason: 'aborted' };
      return;
    }
    if (rounds >= maxRounds) {
      yield {
        type: 'notice',
        level: 'info',
        message: `Stopped after ${maxRounds} tool rounds. Send another message to continue.`,
      };
      yield { type: 'done', reason: 'max-iterations' };
      return;
    }
  }
}
