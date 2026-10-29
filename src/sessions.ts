import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ChatMessage, ToolCall } from './providers/types.js';
import { normalizeUsage, type UsageTotals } from './usage.js';

export const SESSION_VERSION = 1;

export interface SessionRecord {
  version: number;
  id: string;
  cwd: string;
  profile: string;
  model: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  /** Endpoint-reported token totals for the whole session. */
  usage?: UsageTotals;
}

export interface SessionSummary {
  id: string;
  cwd: string;
  profile: string;
  model: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface SaveSessionInput {
  id?: string;
  cwd: string;
  profile: string;
  model: string;
  title?: string;
  createdAt?: string;
  messages: ChatMessage[];
  usage?: UsageTotals;
}

export interface SessionListResult {
  sessions: SessionSummary[];
  skipped: number;
}

/** Sessions grouped by the directory they were saved from. */
export interface SessionGroup {
  cwd: string;
  sessions: SessionSummary[];
}

export interface AllSessionsResult {
  /** Sessions saved for the directory Kiro is running in. */
  current: SessionSummary[];
  /** Sessions from every other directory, newest group first. */
  others: SessionGroup[];
  skipped: number;
}

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionError';
  }
}

export function sessionsRoot(): string {
  return process.env.KIRO_SESSIONS_DIR || path.join(homedir(), '.kiro', 'sessions');
}

function projectKey(cwd: string): string {
  return createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16);
}

export function projectSessionsDir(cwd: string): string {
  return path.join(sessionsRoot(), projectKey(cwd));
}

export function isSessionId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(id);
}

function sessionFile(cwd: string, id: string): string {
  if (!isSessionId(id)) throw new SessionError(`Invalid session id "${id}".`);
  return path.join(projectSessionsDir(cwd), `${id}.json`);
}

export function newSessionId(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

export function titleFromMessages(messages: ChatMessage[]): string {
  const first = messages.find(
    (message) => message.role === 'user' && typeof message.content === 'string' && message.content.trim(),
  );
  const title = (first?.content ?? '').replace(/\s+/g, ' ').trim();
  if (!title) return 'Untitled session';
  const chars = Array.from(title);
  return chars.length > 80 ? `${chars.slice(0, 79).join('').trimEnd()}…` : title;
}

/**
 * Removes a trailing assistant tool-call round that has no results yet.
 * Saving such a state would make the next resume unusable by the provider.
 */
export function dropIncompleteToolCalls(messages: ChatMessage[]): ChatMessage[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== 'assistant' || !message.tool_calls?.length) continue;
    const pending = new Set(message.tool_calls.map((call) => call.id));
    for (let resultIndex = index + 1; resultIndex < messages.length; resultIndex++) {
      const result = messages[resultIndex]!;
      if (result.role === 'tool' && result.tool_call_id) pending.delete(result.tool_call_id);
    }
    return pending.size > 0 ? messages.slice(0, index) : messages;
  }
  return messages;
}

export function formatSessionTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeToolCall(raw: unknown, index: number): ToolCall {
  if (!isRecord(raw) || !isRecord(raw.function)) {
    throw new SessionError(`Tool call ${index + 1} in the session file is malformed.`);
  }
  const id = raw.id;
  const name = raw.function.name;
  const args = raw.function.arguments;
  if (typeof id !== 'string' || !id || typeof name !== 'string' || !name || typeof args !== 'string') {
    throw new SessionError(`Tool call ${index + 1} in the session file is malformed.`);
  }
  return { id, type: 'function', function: { name, arguments: args } };
}

function normalizeMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) throw new SessionError('Session file has no messages array.');
  const messages: ChatMessage[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) throw new SessionError('Session file contains an invalid message.');
    const role = entry.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') {
      throw new SessionError('Session file contains a message with an unknown role.');
    }
    const content = entry.content;
    if (content !== null && typeof content !== 'string') {
      throw new SessionError('Session file contains a message with invalid content.');
    }
    if ((role === 'user' || role === 'tool' || role === 'system') && typeof content !== 'string') {
      throw new SessionError(`Session file contains a ${role} message without content.`);
    }
    // System prompts are rebuilt for the current cwd on every turn.
    if (role === 'system') continue;

    const message: ChatMessage = { role, content: content as string | null };
    if (role === 'assistant' && entry.tool_calls !== undefined) {
      if (!Array.isArray(entry.tool_calls)) {
        throw new SessionError('Session file contains malformed tool calls.');
      }
      message.tool_calls = entry.tool_calls.map(normalizeToolCall);
    }
    if (typeof entry.tool_call_id === 'string') message.tool_call_id = entry.tool_call_id;
    if (typeof entry.name === 'string') message.name = entry.name;
    messages.push(message);
  }
  return messages;
}

export async function saveSession(input: SaveSessionInput): Promise<SessionRecord> {
  const messages = input.messages.filter((message) => message.role !== 'system');
  if (messages.length === 0) throw new SessionError('Cannot save an empty session.');

  const id = input.id ?? newSessionId();
  if (!isSessionId(id)) throw new SessionError(`Invalid session id "${id}".`);
  const now = new Date().toISOString();
  const record: SessionRecord = {
    version: SESSION_VERSION,
    id,
    cwd: path.resolve(input.cwd),
    profile: input.profile,
    model: input.model,
    title: input.title?.trim() || titleFromMessages(messages),
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    messages,
    usage: normalizeUsage(input.usage),
  };

  const dir = projectSessionsDir(input.cwd);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await chmod(dir, 0o700);
  } catch {
    // chmod is not meaningful on every platform.
  }

  const file = sessionFile(input.cwd, id);
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw new SessionError(`Could not save session: ${(error as Error).message}`);
  }
  return record;
}

function parseSessionRecord(raw: string, id: string, expectedCwd?: string): SessionRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SessionError(`Session "${id}" is corrupted (invalid JSON).`);
  }
  if (!isRecord(parsed)) throw new SessionError(`Session "${id}" is corrupted.`);
  if (parsed.version !== SESSION_VERSION) {
    throw new SessionError(
      `Session "${id}" uses unsupported version ${String(parsed.version)}; expected ${SESSION_VERSION}.`,
    );
  }
  if (
    typeof parsed.cwd !== 'string' ||
    (expectedCwd !== undefined && path.resolve(parsed.cwd) !== path.resolve(expectedCwd))
  ) {
    throw new SessionError(`Session "${id}" belongs to a different working directory.`);
  }

  const messages = normalizeMessages(parsed.messages);
  const createdAt = typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString();
  return {
    version: SESSION_VERSION,
    id,
    cwd: path.resolve(parsed.cwd),
    profile: typeof parsed.profile === 'string' ? parsed.profile : '',
    model: typeof parsed.model === 'string' ? parsed.model : '',
    title: typeof parsed.title === 'string' && parsed.title ? parsed.title : titleFromMessages(messages),
    createdAt,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : createdAt,
    messages,
    usage: normalizeUsage(parsed.usage),
  };
}

export async function loadSession(cwd: string, id: string): Promise<SessionRecord> {
  const file = sessionFile(cwd, id);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SessionError(`Session "${id}" was not found for this directory.`);
    }
    throw new SessionError(`Could not read session "${id}": ${(error as Error).message}`);
  }
  return parseSessionRecord(raw, id, cwd);
}

function summarize(record: SessionRecord): SessionSummary {
  return {
    id: record.id,
    cwd: record.cwd,
    profile: record.profile,
    model: record.model,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    messageCount: record.messages.length,
  };
}

export async function listSessions(cwd: string, limit = 20): Promise<SessionListResult> {
  const dir = projectSessionsDir(cwd);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { sessions: [], skipped: 0 };
    throw new SessionError(`Could not list sessions: ${(error as Error).message}`);
  }

  const sessions: SessionSummary[] = [];
  let skipped = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const id = entry.name.slice(0, -'.json'.length);
    if (!isSessionId(id)) {
      skipped++;
      continue;
    }
    try {
      sessions.push(summarize(await loadSession(cwd, id)));
    } catch {
      skipped++;
    }
  }

  sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return { sessions: sessions.slice(0, limit), skipped };
}

/** Reads one project directory straight from disk, for cross-directory listing. */
async function summarizeProjectDir(dir: string, limit: number): Promise<SessionListResult> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { sessions: [], skipped: 0 };
    return { sessions: [], skipped: 1 };
  }

  const sessions: SessionSummary[] = [];
  let skipped = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const id = entry.name.slice(0, -'.json'.length);
    if (!isSessionId(id)) {
      skipped++;
      continue;
    }
    try {
      const raw = await readFile(path.join(dir, entry.name), 'utf8');
      sessions.push(summarize(parseSessionRecord(raw, id)));
    } catch {
      skipped++;
    }
  }

  sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return { sessions: sessions.slice(0, limit), skipped };
}

/**
 * Lists sessions for `cwd` and every other directory found under the sessions
 * root. Sessions are grouped by the cwd stored in each record, so a moved or
 * copied project folder still lists under its recorded directory.
 */
export async function listAllSessions(cwd: string, limitPerDir = 20): Promise<AllSessionsResult> {
  const root = sessionsRoot();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { current: [], others: [], skipped: 0 };
    }
    throw new SessionError(`Could not list sessions: ${(error as Error).message}`);
  }

  const groups = new Map<string, SessionSummary[]>();
  let skipped = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const result = await summarizeProjectDir(path.join(root, entry.name), limitPerDir);
    skipped += result.skipped;
    for (const session of result.sessions) {
      const list = groups.get(session.cwd);
      if (list) list.push(session);
      else groups.set(session.cwd, [session]);
    }
  }

  const resolved = path.resolve(cwd);
  const byUpdated = (left: SessionSummary, right: SessionSummary): number =>
    right.updatedAt.localeCompare(left.updatedAt);
  const current = (groups.get(resolved) ?? []).sort(byUpdated).slice(0, limitPerDir);
  groups.delete(resolved);
  const others: SessionGroup[] = [...groups.entries()]
    .filter(([, sessions]) => sessions.length > 0)
    .map(([dirCwd, sessions]) => ({
      cwd: dirCwd,
      sessions: sessions.sort(byUpdated).slice(0, limitPerDir),
    }))
    .sort((left, right) =>
      (right.sessions[0]?.updatedAt ?? '').localeCompare(left.sessions[0]?.updatedAt ?? ''),
    );
  return { current, others, skipped };
}

export async function latestSession(cwd: string): Promise<SessionRecord | null> {
  const { sessions } = await listSessions(cwd, 1);
  const newest = sessions[0];
  return newest ? loadSession(cwd, newest.id) : null;
}
