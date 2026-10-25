import type { ChatMessage } from '../providers/types.js';
import { sanitizeText, summarizeToolArgs, truncateToWidth } from './text.js';
import { MAX_EXPANDED_TOOL_CHARS, type ToolViewStatus, type ViewItem } from './types.js';

export interface ResumedView {
  items: ViewItem[];
  nextId: number;
}

export interface ResumedViewOptions {
  cwd: string;
  version: string;
  sessionId: string;
}

function inferToolStatus(content: string): ToolViewStatus {
  if (/^(User denied|Cancelled by user)/i.test(content)) return 'denied';
  if (/^exit code: (?!0\b)/.test(content)) return 'error';
  if (/^(Error:|Failed to)/.test(content)) return 'error';
  return 'ok';
}

function summarizeResult(content: string): string {
  const firstLine = sanitizeText(content)
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
  return truncateToWidth(firstLine ?? 'completed', 120);
}

/** Rebuilds the visible history for a session restored from disk. */
export function buildResumedView(messages: ChatMessage[], options: ResumedViewOptions): ResumedView {
  let nextId = 1;
  const items: ViewItem[] = [{ kind: 'banner', id: 0, cwd: options.cwd, version: options.version }];
  const toolItemIndex = new Map<string, number>();
  const conversation = messages.filter((message) => message.role !== 'system');

  items.push({
    kind: 'notice',
    id: nextId++,
    level: 'info',
    text: `Resumed session ${options.sessionId} (${conversation.length} message${
      conversation.length === 1 ? '' : 's'
    }).`,
  });

  for (const message of conversation) {
    if (message.role === 'user') {
      items.push({ kind: 'user', id: nextId++, text: message.content ?? '' });
      continue;
    }

    if (message.role === 'assistant') {
      if (message.content?.trim()) {
        items.push({ kind: 'assistant', id: nextId++, text: message.content });
      }
      for (const call of message.tool_calls ?? []) {
        toolItemIndex.set(call.id, items.length);
        items.push({
          kind: 'tool',
          id: nextId++,
          callId: call.id,
          name: call.function.name,
          argsSummary: summarizeToolArgs(call.function.name, call.function.arguments),
          status: 'running',
        });
      }
      continue;
    }

    if (message.role === 'tool') {
      const content = message.content ?? '';
      const status = inferToolStatus(content);
      const resultSummary = summarizeResult(content);
      const resultFull = content.slice(0, MAX_EXPANDED_TOOL_CHARS);
      const index = message.tool_call_id ? toolItemIndex.get(message.tool_call_id) : undefined;
      if (index !== undefined) {
        const existing = items[index];
        if (existing?.kind === 'tool') {
          items[index] = { ...existing, status, resultSummary, resultFull };
          continue;
        }
      }
      items.push({
        kind: 'tool',
        id: nextId++,
        callId: message.tool_call_id ?? `orphan_${nextId}`,
        name: message.name ?? 'tool',
        argsSummary: '',
        status,
        resultSummary,
        resultFull,
      });
    }
  }

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (item?.kind === 'tool' && item.status === 'running') {
      items[index] = { ...item, status: 'error', resultSummary: 'result not recorded' };
    }
  }

  return { items, nextId };
}
