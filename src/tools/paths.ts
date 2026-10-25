import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ToolContext } from './types.js';

export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export function stringArg(
  input: Record<string, unknown>,
  key: string,
  optional = false,
): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw new Error(`Missing required argument "${key}".`);
  }
  if (typeof value !== 'string') throw new Error(`Argument "${key}" must be a string.`);
  if (!optional && value.length === 0) throw new Error(`Argument "${key}" must not be empty.`);
  if (value.includes('\0')) throw new Error(`Argument "${key}" contains a NUL byte.`);
  return value;
}

export function booleanArg(
  input: Record<string, unknown>,
  key: string,
  fallback = false,
): boolean {
  const value = input[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new Error(`Argument "${key}" must be a boolean.`);
  return value;
}

export function integerArg(
  input: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = input[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`Argument "${key}" must be an integer.`);
  }
  if (value < min || value > max) {
    throw new Error(`Argument "${key}" must be between ${min} and ${max}.`);
  }
  return value;
}

function pathEscapes(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

async function realpathLoose(target: string): Promise<string> {
  const suffix: string[] = [];
  let probe = target;
  for (let i = 0; i < 64; i++) {
    try {
      const resolved = await realpath(probe);
      return path.join(resolved, ...suffix);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = path.dirname(probe);
      if (parent === probe) return target;
      suffix.unshift(path.basename(probe));
      probe = parent;
    }
  }
  return target;
}

export interface ResolvedPath {
  abs: string;
  display: string;
  outside: boolean;
}

export async function resolvePath(ctx: ToolContext, rawPath: string): Promise<ResolvedPath> {
  const abs = path.resolve(ctx.cwd, rawPath);
  const root = await realpath(ctx.cwd);
  const realTarget = await realpathLoose(abs);
  const outside = pathEscapes(root, realTarget);
  const relative = path.relative(ctx.cwd, abs);
  return {
    abs,
    display: outside ? abs : relative.split(path.sep).join('/') || '.',
    outside,
  };
}

/** Converts absolute paths inside the workspace to short relative paths with `/` separators. */
export function displayPath(cwd: string, absolute: string): string {
  const relative = path.relative(cwd, absolute);
  if (!relative || relative === '') return '.';
  if (relative.startsWith('..') || path.isAbsolute(relative)) return absolute;
  return relative.split(path.sep).join('/');
}
