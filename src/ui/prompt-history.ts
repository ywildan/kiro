import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

import { redactSecrets } from '../secrets.js';

/**
 * Recallable prompt history, one file per working directory, stored under
 * ~/.kiro/history/<cwd-hash>.json. Plaintext by design, like shell history:
 * it holds what the user typed (with registered key values redacted), never
 * tool output.
 */

const MAX_HISTORY = 200;

const historyCache = new Map<string, string[]>();

function historyRoot(): string {
  return process.env.KIRO_HISTORY_DIR || path.join(homedir(), '.kiro', 'history');
}

function historyFile(cwd: string): string {
  const key = createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16);
  return path.join(historyRoot(), `${key}.json`);
}

export async function loadPromptHistory(cwd: string): Promise<string[]> {
  const file = historyFile(cwd);
  const cached = historyCache.get(file);
  if (cached) return [...cached];
  let entries: string[] = [];
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (Array.isArray(parsed)) {
      entries = parsed.filter((entry: unknown): entry is string => typeof entry === 'string');
    }
  } catch {
    // No history yet.
  }
  historyCache.set(file, entries);
  return [...entries];
}

/** Applies the same dedupe/cap rules the on-disk store uses. */
export function rememberPrompt(entries: string[], prompt: string): string[] {
  const text = redactSecrets(prompt).trim();
  if (!text) return [...entries];
  const next = [...entries];
  if (next[next.length - 1] === text) return next;
  const index = next.indexOf(text);
  if (index !== -1) next.splice(index, 1); // most recent use wins
  next.push(text);
  return next.slice(-MAX_HISTORY);
}

/** Records a submitted prompt and returns the updated list for the live UI. */
export async function recordPrompt(cwd: string, prompt: string): Promise<string[]> {
  const file = historyFile(cwd);
  const entries = rememberPrompt(historyCache.get(file) ?? [], prompt);
  historyCache.set(file, entries);
  try {
    await mkdir(historyRoot(), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temp, `${JSON.stringify(entries)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, file);
  } catch {
    // History is best effort; losing a write never blocks the session.
  }
  return [...entries];
}
