import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ProfileConfig } from './config.js';
import { registerSecretEnv } from './secrets.js';

export interface EnvEntry {
  key: string;
  value: string;
}

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvError';
  }
}

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Variables loaded from the file during this process; real env vars always win. */
const loadedKeys = new Set<string>();

export function envPath(): string {
  return process.env.KIRO_ENV_PATH || path.join(homedir(), '.kiro', '.env');
}

export function isValidEnvName(name: string): boolean {
  return ENV_NAME_PATTERN.test(name);
}

export function validateEnvName(name: string): string {
  const trimmed = name.trim();
  if (!isValidEnvName(trimmed)) {
    throw new EnvError(
      `Environment variable name "${trimmed}" is invalid. Use letters, digits, and underscores; ` +
        'start with a letter or underscore.',
    );
  }
  return trimmed;
}

export function defaultKeyEnv(profileName: string): string {
  const slug = profileName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `KIRO_${slug || 'PROFILE'}_API_KEY`;
}

function unquote(value: string): { value: string; quoted: boolean } {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const quote = trimmed[0];
    if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
      const inner = trimmed.slice(1, -1);
      if (quote === '"') {
        return {
          value: inner.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\'),
          quoted: true,
        };
      }
      return { value: inner, quoted: true };
    }
  }
  return { value: trimmed, quoted: false };
}

/** Parses dotenv-style text; malformed lines are ignored rather than crashing. */
export function parseEnv(text: string): EnvEntry[] {
  const entries: EnvEntry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const equals = line.indexOf('=');
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    if (!isValidEnvName(key)) continue;
    let rawValue = line.slice(equals + 1);
    const first = rawValue.trim().charAt(0);
    if (first !== '"' && first !== "'") {
      const comment = rawValue.search(/\s#/);
      if (comment !== -1) rawValue = rawValue.slice(0, comment);
    }
    entries.push({ key, value: unquote(rawValue).value });
  }
  return entries;
}

export interface LoadEnvResult {
  path: string;
  loaded: number;
  missing: boolean;
}

/**
 * Loads ~/.kiro/.env without overriding variables that are already set in the
 * real environment. Call once at startup before resolving profiles.
 */
export async function loadEnvFile(file = envPath()): Promise<LoadEnvResult> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path: file, loaded: 0, missing: true };
    }
    throw new EnvError(`Could not read ${file}: ${(error as Error).message}`);
  }
  let loaded = 0;
  for (const entry of parseEnv(text)) {
    loadedKeys.add(entry.key);
    registerSecretEnv(entry.key, entry.value, true);
    if (process.env[entry.key] === undefined) {
      process.env[entry.key] = entry.value;
      loaded++;
    }
  }
  return { path: file, loaded, missing: false };
}

function updateEnvText(text: string, name: string, value: string | null): string {
  const lines = text === '' ? [] : text.split(/\r?\n/);
  const output: string[] = [];
  let replaced = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(trimmed);
    if (!match || match[1] !== name) {
      output.push(line);
      continue;
    }
    if (replaced) continue;
    replaced = true;
    if (value !== null) output.push(`${name}=${value}`);
  }
  if (!replaced && value !== null) {
    if (output.length > 0 && output[output.length - 1] === '') output.pop();
    output.push(`${name}=${value}`);
  }
  let result = output.join('\n');
  if (result && !result.endsWith('\n')) result += '\n';
  return result;
}

/** Adds or replaces a key in ~/.kiro/.env atomically with 0600 permissions. */
export async function writeEnvValue(
  name: string,
  value: string,
  file = envPath(),
): Promise<void> {
  const key = validateEnvName(name);
  if (/[\r\n]/.test(value)) throw new EnvError('API keys cannot contain line breaks.');

  let current = '';
  try {
    current = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new EnvError(`Could not read ${file}: ${(error as Error).message}`);
    }
  }

  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await chmod(dir, 0o700);
  } catch {
    // best effort
  }

  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temp, updateEnvText(current, key, value), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw new EnvError(`Could not write ${file}: ${(error as Error).message}`);
  }
  try {
    await chmod(file, 0o600);
  } catch {
    // best effort
  }

  registerSecretEnv(key, value, true);
  if (process.env[key] === undefined || loadedKeys.has(key)) {
    process.env[key] = value;
    loadedKeys.add(key);
  }
}

export function envIsSet(name: string | undefined): boolean {
  return Boolean(name && process.env[name]);
}

export function maskKey(value: string): string {
  if (!value) return '(empty)';
  const chars = Array.from(value);
  if (chars.length <= 4) return '••••';
  const tail = chars.slice(-4).join('');
  const prefix = value.startsWith('sk-') ? 'sk-' : chars.slice(0, Math.min(3, chars.length - 4)).join('');
  return `${prefix}…${tail}`;
}

/** Human-readable key status for listings; never returns the key itself. */
export function keyStatus(profile: ProfileConfig): string {
  if (!profile.apiKeyEnv) return 'no key';
  return process.env[profile.apiKeyEnv] ? `set via $${profile.apiKeyEnv}` : `missing ($${profile.apiKeyEnv})`;
}

/** A masked preview for edit screens, or a status when there is no key. */
export function keyPreview(profile: ProfileConfig): string {
  if (!profile.apiKeyEnv) return 'no key configured';
  const value = process.env[profile.apiKeyEnv];
  if (!value) return `missing ($${profile.apiKeyEnv})`;
  return `${maskKey(value)} via $${profile.apiKeyEnv}`;
}
