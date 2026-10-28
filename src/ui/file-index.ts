import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { walkTree } from '../tools/walk.js';

const execFileAsync = promisify(execFile);

export const MAX_INDEX_FILES = 50_000;
const MAX_GIT_OUTPUT_BYTES = 20 * 1024 * 1024;

function normalize(paths: Iterable<string>): string[] {
  const unique = new Set<string>();
  for (const raw of paths) {
    const path = raw.split('\\').join('/').replace(/^\.\//, '');
    if (!path || path.includes('\n')) continue;
    unique.add(path);
  }
  return [...unique].sort((left, right) => left.localeCompare(right)).slice(0, MAX_INDEX_FILES);
}

/** Tracked and untracked files, honouring .gitignore. Null when git is unavailable or fails. */
async function gitFiles(cwd: string, signal?: AbortSignal): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      {
        cwd,
        timeout: 3000,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        signal,
      },
    );
    return normalize(stdout.split('\0'));
  } catch {
    return null;
  }
}

async function walkFiles(cwd: string, signal?: AbortSignal): Promise<string[]> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (signal?.aborted) return [];
  signal?.addEventListener('abort', onAbort, { once: true });
  const files: string[] = [];
  try {
    await walkTree({
      cwd,
      rootAbs: cwd,
      signal: controller.signal,
      visit(entry) {
        if (entry.isDir) return true;
        files.push(entry.rel);
        return files.length < MAX_INDEX_FILES;
      },
    });
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  return normalize(files);
}

/** File list for the @ menu: git first, then a .gitignore-aware walk. */
export async function listProjectFiles(cwd: string, signal?: AbortSignal): Promise<string[]> {
  if (signal?.aborted) return [];
  const fromGit = await gitFiles(cwd, signal);
  if (fromGit !== null) return fromGit;
  return walkFiles(cwd, signal);
}

function subsequence(text: string, needle: string): boolean {
  let index = 0;
  for (const char of text) {
    if (char === needle[index]) index++;
    if (index === needle.length) return true;
  }
  return false;
}

/** Ranks paths for a mention query: basename matches first, then path matches. */
export function filterFiles(files: string[], query: string, limit = 200): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return files.slice(0, limit);

  const scored: { path: string; score: number }[] = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    let score = 0;
    if (lower === needle) score = 1000;
    else if (base.startsWith(needle)) score = 900;
    else if (base.includes(needle)) score = 800;
    else if (lower.startsWith(needle)) score = 750;
    else if (lower.split('/').some((segment) => segment.startsWith(needle))) score = 700;
    else if (lower.includes(needle)) score = 600;
    else if (subsequence(base, needle)) score = 500;
    else if (subsequence(lower, needle)) score = 400;
    else continue;
    scored.push({ path: file, score });
  }

  scored.sort(
    (left, right) =>
      right.score - left.score ||
      left.path.length - right.path.length ||
      left.path.localeCompare(right.path),
  );
  return scored.slice(0, limit).map((entry) => entry.path);
}
