import { homedir } from 'node:os';
import path from 'node:path';
import { formatSessionTime, type AllSessionsResult, type SessionSummary } from '../sessions.js';
import type { PickerRange } from './model-picker.js';

export type SessionScope = 'current' | 'others';

/** Rows the inline session picker reserves below the transcript. */
export const SESSION_INLINE_ROWS = 13;

export type SessionRow =
  | { kind: 'header'; scope: SessionScope; text: string }
  | { kind: 'session'; scope: SessionScope; session: SessionSummary };

export function sessionCounts(data: AllSessionsResult): { current: number; others: number } {
  return {
    current: data.current.length,
    others: data.others.reduce((total, group) => total + group.sessions.length, 0),
  };
}

export function sessionTabLabel(
  scope: SessionScope,
  counts: { current: number; others: number },
): string {
  return scope === 'current'
    ? `This directory (${counts.current})`
    : `Other directories (${counts.others})`;
}

/** Home-relative path so other directories read short in the picker. */
export function shortCwd(cwd: string, currentCwd: string): string {
  const resolved = path.resolve(cwd);
  if (resolved === path.resolve(currentCwd)) return '.';
  const home = homedir();
  if (resolved === home) return '~';
  if (resolved.startsWith(`${home}${path.sep}`)) return `~${resolved.slice(home.length)}`;
  return resolved;
}

/** Case-insensitive multi-term search across title, id, and directory. */
export function filterSessions(sessions: SessionSummary[], query: string): SessionSummary[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return sessions;
  return sessions.filter((session) => {
    const haystack =
      `${session.title} ${session.id} ${session.cwd} ${session.profile} ${session.model}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export function sessionRowText(session: SessionSummary, active: boolean): string {
  const marker = active ? '*' : ' ';
  const count = `${session.messageCount} msg${session.messageCount === 1 ? '' : 's'}`;
  return `${marker} ${session.id.slice(0, 8)}  ${formatSessionTime(session.updatedAt)}  ${count}  ${session.title}`;
}

/** Display rows for one tab; other directories get a header per cwd. */
export function buildSessionRows(
  data: AllSessionsResult,
  scope: SessionScope,
  currentCwd: string,
  query = '',
): SessionRow[] {
  if (scope === 'current') {
    return filterSessions(data.current, query).map((session) => ({
      kind: 'session' as const,
      scope,
      session,
    }));
  }
  const rows: SessionRow[] = [];
  for (const group of data.others) {
    const sessions = filterSessions(group.sessions, query);
    if (sessions.length === 0) continue;
    rows.push({
      kind: 'header',
      scope,
      text: `${shortCwd(group.cwd, currentCwd)} (${sessions.length})`,
    });
    for (const session of sessions) rows.push({ kind: 'session', scope, session });
  }
  return rows;
}

export function sessionRowLines(rows: SessionRow[]): number[] {
  return rows.flatMap((row, index) => (row.kind === 'session' ? [index] : []));
}

export function sessionRowItems(rows: SessionRow[]): SessionSummary[] {
  return rows.flatMap((row) => (row.kind === 'session' ? [row.session] : []));
}

/** Same as profileRange, counting sessions while skipping directory headers. */
export function sessionRange(rows: SessionRow[], start: number, end: number): PickerRange {
  const lines = sessionRowLines(rows);
  const above = lines.filter((line) => line < start).length;
  const visible = lines.filter((line) => line >= start && line < end).length;
  return {
    above,
    below: lines.length - above - visible,
    first: visible === 0 ? 0 : above + 1,
    last: above + visible,
    total: lines.length,
  };
}

export function sessionEmptyText(
  scope: SessionScope,
  query: string,
  hasSessions: boolean,
): string {
  if (query.trim()) return `No sessions match "${query}". Backspace to edit, Esc to clear.`;
  if (hasSessions) return '';
  return scope === 'current'
    ? 'No saved sessions for this directory.'
    : 'No sessions from other directories.';
}
