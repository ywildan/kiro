import { homedir } from 'node:os';
import path from 'node:path';
import type { ChatMessage } from '../providers/types.js';

export interface TranscriptMeta {
  cwd: string;
  sessionId?: string;
  profile?: string;
  model?: string;
  version?: string;
  exportedAt?: Date;
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

/** Where /export writes when the user does not give a path. */
export function defaultExportPath(sessionId: string | undefined, now = new Date()): string {
  const suffix = sessionId ? `-${sessionId.slice(0, 8)}` : '';
  return path.join(homedir(), '.kiro', 'exports', `kiro-${stamp(now)}${suffix}.md`);
}

function formatArguments(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '{}';
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return trimmed;
  }
}

/** Renders the full conversation, including complete tool arguments and results, as Markdown. */
export function renderTranscriptMarkdown(messages: ChatMessage[], meta: TranscriptMeta): string {
  const exportedAt = meta.exportedAt ?? new Date();
  const head = [
    '# Kiro transcript',
    '',
    `- Exported: ${exportedAt.toISOString()}`,
    `- Working directory: ${meta.cwd}`,
  ];
  if (meta.sessionId) head.push(`- Session: ${meta.sessionId}`);
  if (meta.profile) head.push(`- Profile: ${meta.profile}`);
  if (meta.model) head.push(`- Model: ${meta.model}`);
  if (meta.version) head.push(`- Kiro: ${meta.version}`);
  head.push('');

  const body: string[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      body.push('## System prompt', '', '```', message.content ?? '', '```', '');
      continue;
    }
    if (message.role === 'user') {
      body.push('## User', '', message.content ?? '', '');
      continue;
    }
    if (message.role === 'assistant') {
      if (message.content?.trim()) {
        body.push('## Kiro', '', message.content, '');
      }
      for (const call of message.tool_calls ?? []) {
        body.push(
          `### Tool call: ${call.function.name}`,
          '',
          '```json',
          formatArguments(call.function.arguments),
          '```',
          '',
        );
      }
      continue;
    }
    if (message.role === 'tool') {
      body.push(
        `### Tool result: ${message.name ?? 'tool'}`,
        '',
        '```',
        message.content ?? '',
        '```',
        '',
      );
    }
  }

  return `${head.join('\n')}\n${body.join('\n')}`.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
