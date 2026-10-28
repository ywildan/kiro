import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { isIgnored, parseIgnoreFile, type IgnoreRule } from './ignore.js';

export const MAX_WALK_ENTRIES = 200_000;
export const ALWAYS_SKIP = new Set(['node_modules', '.git', 'dist', 'build']);

export interface WalkVisit {
  abs: string;
  rel: string;
  isDir: boolean;
}

export interface WalkOptions {
  cwd: string;
  rootAbs: string;
  signal: AbortSignal;
  visit(entry: WalkVisit): boolean | void | Promise<boolean | void>;
}

async function readIgnoreRules(dirAbs: string, baseRel: string): Promise<IgnoreRule[]> {
  try {
    return parseIgnoreFile(await readFile(path.join(dirAbs, '.gitignore'), 'utf8'), baseRel);
  } catch {
    return [];
  }
}

/** Depth-first walk that honours .gitignore and always skips heavy directories. */
export async function walkTree(options: WalkOptions): Promise<void> {
  const { cwd, rootAbs, signal, visit } = options;
  const rootRel = path.relative(cwd, rootAbs).split(path.sep).join('/');
  let visited = 0;
  let stopped = false;

  const visitDir = async (dirAbs: string, relDir: string, inherited: IgnoreRule[]): Promise<void> => {
    if (stopped || signal.aborted) return;
    const rules = [...inherited, ...(await readIgnoreRules(dirAbs, relDir))];
    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (stopped || signal.aborted) return;
      if (entry.isSymbolicLink()) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const isDir = entry.isDirectory();
      if (isDir && ALWAYS_SKIP.has(entry.name)) continue;
      if (isIgnored(rules, rel, isDir)) continue;
      visited++;
      if (visited > MAX_WALK_ENTRIES) {
        stopped = true;
        return;
      }
      const abs = path.join(dirAbs, entry.name);
      if ((await visit({ abs, rel, isDir })) === false) {
        stopped = true;
        return;
      }
      if (isDir) {
        await visitDir(abs, rel, rules);
        if (stopped) return;
      }
    }
  };

  await visitDir(rootAbs, rootRel, []);
}
