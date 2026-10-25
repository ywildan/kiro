import type { ChatMessage } from '../providers/types.js';

const MESSAGE_OVERHEAD_TOKENS = 4;

/** Rough estimate used when the endpoint does not report usage. */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function estimateMessageTokens(message: ChatMessage): number {
  let total = MESSAGE_OVERHEAD_TOKENS;
  if (message.content) total += estimateTextTokens(message.content);
  if (message.tool_calls?.length) {
    total += estimateTextTokens(JSON.stringify(message.tool_calls));
  }
  if (message.name) total += estimateTextTokens(message.name);
  return total;
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

/** Compact, human-readable token counts for the status bar and notices. */
export function formatTokens(count: number): string {
  const value = Math.max(0, Math.round(count));
  if (value < 1_000) return String(value);
  if (value < 10_000) return `${Math.round(value / 100) / 10}k`;
  return `${Math.round(value / 1_000)}k`;
}

export function formatPercent(used: number, window: number): string {
  if (window <= 0) return '0%';
  return `${Math.min(999, Math.round((used / window) * 100))}%`;
}
