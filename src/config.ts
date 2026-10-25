import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { inferContextWindow } from './model/contexts.js';

export interface ProfileConfig {
  type: string;
  baseUrl: string;
  apiKeyEnv?: string;
  model: string;
  /** Models this profile can switch between without another discovery request. */
  models?: string[];
  temperature?: number;
  maxTokens?: number;
  /** Approximate model context window in tokens; used for the ctx meter and compaction. */
  contextWindow?: number;
}

export const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * The context window used for the ctx meter and auto-compaction: the explicit
 * profile value, else a guess from the model id, else the default.
 */
export function contextWindowFor(profile: ProfileConfig | undefined): number {
  if (!profile) return DEFAULT_CONTEXT_WINDOW;
  return profile.contextWindow ?? inferContextWindow(profile.model) ?? DEFAULT_CONTEXT_WINDOW;
}

export interface KiroConfig {
  activeProfile: string;
  profiles: Record<string, ProfileConfig>;
}

export interface CliOverrides {
  profile?: string;
  baseUrl?: string;
  model?: string;
}

export const DEFAULT_CONFIG: KiroConfig = {
  activeProfile: 'default',
  profiles: {
    default: {
      type: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKeyEnv: 'KIRO_API_KEY',
      model: 'model-name',
      temperature: 0.2,
      maxTokens: 4096,
    },
  },
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function configPath(): string {
  return process.env.KIRO_CONFIG_PATH || path.join(homedir(), '.kiro', 'config.json');
}

export function configDir(): string {
  return path.dirname(configPath());
}

const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function validateProfileName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new ConfigError('Profile name cannot be empty.');
  if (trimmed.length > 64) throw new ConfigError('Profile name must be at most 64 characters.');
  if (!PROFILE_NAME_PATTERN.test(trimmed)) {
    throw new ConfigError(
      `Profile name "${trimmed}" may only contain letters, digits, dashes, and underscores, ` +
        'and must start with a letter or digit.',
    );
  }
  return trimmed;
}

export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ConfigError(`Invalid baseUrl "${trimmed}". Enter a full URL such as https://api.example.com/v1.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError('baseUrl must start with http:// or https://.');
  }
  return trimmed.replace(/\/+$/, '');
}

export function suggestProfileName(base: string, model: string, existing: Iterable<string>): string {
  const slug = (text: string): string =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'model';
  const stem = `${slug(base)}-${slug(model)}`.slice(0, 60);
  const taken = new Set(existing);
  if (!taken.has(stem)) return stem;
  for (let index = 2; index < 1000; index++) {
    const candidate = `${stem}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem}-${randomBytes(3).toString('hex')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keeps config.json and the picker bounded when an endpoint offers hundreds of models. */
const MAX_STORED_MODELS = 500;

/** The stored model list always starts with the model that is actually used. */
function validateModels(name: string, raw: unknown, model: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new ConfigError(`Profile "${name}": "models" must be an array of model ids.`);
  }
  const seen = new Set([model]);
  const models = [model];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new ConfigError(`Profile "${name}": "models" must only contain non-empty strings.`);
    }
    const id = entry.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    models.push(id);
    if (models.length >= MAX_STORED_MODELS) break;
  }
  return models;
}

function validateProfile(name: string, raw: unknown): ProfileConfig {
  if (!isRecord(raw)) {
    throw new ConfigError(`Profile "${name}" must be an object.`);
  }
  const type = raw.type;
  if (typeof type !== 'string' || !type) {
    throw new ConfigError(`Profile "${name}" is missing "type".`);
  }
  const baseUrl = raw.baseUrl;
  if (typeof baseUrl !== 'string' || !/^https?:\/\//i.test(baseUrl)) {
    throw new ConfigError(`Profile "${name}" needs a valid http(s) "baseUrl".`);
  }
  const model = raw.model;
  if (typeof model !== 'string' || !model) {
    throw new ConfigError(`Profile "${name}" is missing "model".`);
  }
  if (raw.apiKeyEnv !== undefined && typeof raw.apiKeyEnv !== 'string') {
    throw new ConfigError(`Profile "${name}": "apiKeyEnv" must be a string.`);
  }
  if (
    raw.temperature !== undefined &&
    (typeof raw.temperature !== 'number' || !Number.isFinite(raw.temperature))
  ) {
    throw new ConfigError(`Profile "${name}": "temperature" must be a number.`);
  }
  if (
    raw.maxTokens !== undefined &&
    (typeof raw.maxTokens !== 'number' || !Number.isInteger(raw.maxTokens) || raw.maxTokens <= 0)
  ) {
    throw new ConfigError(`Profile "${name}": "maxTokens" must be a positive integer.`);
  }
  if (
    raw.contextWindow !== undefined &&
    (typeof raw.contextWindow !== 'number' ||
      !Number.isInteger(raw.contextWindow) ||
      raw.contextWindow < 1_000)
  ) {
    throw new ConfigError(`Profile "${name}": "contextWindow" must be an integer of at least 1000.`);
  }
  return {
    type,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKeyEnv: typeof raw.apiKeyEnv === 'string' ? raw.apiKeyEnv : undefined,
    model,
    models: validateModels(name, raw.models, model),
    temperature: raw.temperature as number | undefined,
    maxTokens: raw.maxTokens as number | undefined,
    contextWindow: raw.contextWindow as number | undefined,
  };
}

export function validateConfig(raw: unknown): KiroConfig {
  if (!isRecord(raw)) {
    throw new ConfigError('Config must be a JSON object.');
  }
  if (!isRecord(raw.profiles) || Object.keys(raw.profiles).length === 0) {
    throw new ConfigError('Config needs a non-empty "profiles" object.');
  }
  const profiles: Record<string, ProfileConfig> = {};
  for (const [name, profile] of Object.entries(raw.profiles)) {
    profiles[name] = validateProfile(name, profile);
  }
  const activeProfile = raw.activeProfile;
  if (typeof activeProfile !== 'string' || !activeProfile) {
    throw new ConfigError('Config is missing "activeProfile".');
  }
  if (!profiles[activeProfile]) {
    throw new ConfigError(
      `Active profile "${activeProfile}" does not exist. Available profiles: ${Object.keys(profiles).join(', ')}.`,
    );
  }
  return { activeProfile, profiles };
}

export function applyOverrides(config: KiroConfig, overrides: CliOverrides): KiroConfig {
  if (!overrides.profile && !overrides.baseUrl && !overrides.model) {
    return config;
  }
  const profileName = overrides.profile ?? config.activeProfile;
  const original = overrides.profile ? config.profiles[overrides.profile] : config.profiles[config.activeProfile];
  if (!original) {
    throw new ConfigError(
      `Unknown profile "${profileName}". Available profiles: ${Object.keys(config.profiles).join(', ')}.`,
    );
  }
  const profile: ProfileConfig = {
    ...original,
    ...(overrides.baseUrl ? { baseUrl: overrides.baseUrl.replace(/\/+$/, '') } : {}),
    ...(overrides.model ? { model: overrides.model } : {}),
  };
  return {
    activeProfile: profileName,
    profiles: { ...config.profiles, [profileName]: profile },
  };
}

export interface LoadedConfig {
  config: KiroConfig;
  path: string;
  created: boolean;
  /** The parsed file as-is, used to preserve fields Kiro does not know about. */
  raw: Record<string, unknown>;
}

async function ensureConfigDir(file: string): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await chmod(dir, 0o700);
  } catch {
    // chmod is not meaningful on every platform.
  }
}

export async function loadConfig(): Promise<LoadedConfig> {
  const file = configPath();
  let created = false;
  if (!existsSync(file)) {
    await ensureConfigDir(file);
    const template = JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n';
    try {
      await writeFile(file, template, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new ConfigError(`Could not create ${file}: ${(error as Error).message}`);
      }
    }
  }

  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new ConfigError(`Could not read ${file}: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`Invalid JSON in ${file}: ${(error as Error).message}`);
  }
  if (!isRecord(parsed)) throw new ConfigError(`${file} must contain a JSON object.`);
  return { config: validateConfig(parsed), path: file, created, raw: parsed };
}

async function readRawConfig(file: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new ConfigError(`Could not read ${file}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(
      `Invalid JSON in ${file}: ${(error as Error).message}. ` +
        'Fix the file, or remove it to start from a fresh template.',
    );
  }
  if (!isRecord(parsed)) throw new ConfigError(`${file} must contain a JSON object.`);
  return parsed;
}

export interface SaveConfigOptions {
  path?: string;
}

/**
 * Writes the config atomically and keeps unknown top-level and per-profile
 * fields from the file that is currently on disk.
 */
export async function saveConfig(config: KiroConfig, options: SaveConfigOptions = {}): Promise<string> {
  const file = options.path ?? configPath();
  const normalized = validateConfig(config);
  const raw = await readRawConfig(file);
  const output = structuredClone(raw);

  const rawProfiles = isRecord(output.profiles) ? output.profiles : {};
  const profiles: Record<string, unknown> = {};
  for (const [name, profile] of Object.entries(normalized.profiles)) {
    validateProfileName(name);
    const existing = isRecord(rawProfiles[name]) ? rawProfiles[name] : {};
    const merged: Record<string, unknown> = {
      ...existing,
      type: profile.type,
      baseUrl: profile.baseUrl,
      model: profile.model,
    };
    if (profile.apiKeyEnv) merged.apiKeyEnv = profile.apiKeyEnv;
    else delete merged.apiKeyEnv;
    if (profile.temperature !== undefined) merged.temperature = profile.temperature;
    else delete merged.temperature;
    if (profile.maxTokens !== undefined) merged.maxTokens = profile.maxTokens;
    else delete merged.maxTokens;
    if (profile.contextWindow !== undefined) merged.contextWindow = profile.contextWindow;
    else delete merged.contextWindow;
    if (profile.models !== undefined) merged.models = profile.models;
    else delete merged.models;
    profiles[name] = merged;
  }

  output.activeProfile = normalized.activeProfile;
  output.profiles = profiles;
  validateConfig(output);

  await ensureConfigDir(file);
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(output, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw new ConfigError(`Could not save ${file}: ${(error as Error).message}`);
  }
  try {
    await chmod(file, 0o600);
  } catch {
    // best effort
  }
  return file;
}

/**
 * Copies a corrupt config out of the way and writes a fresh template.
 * Returns the backup path, or null when there was no file to back up.
 */
export async function recoverConfig(file = configPath()): Promise<string | null> {
  let backup: string | null = null;
  if (existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backup = `${file}.bak-${stamp}`;
    try {
      await copyFile(file, backup);
    } catch (error) {
      throw new ConfigError(`Could not back up ${file}: ${(error as Error).message}`);
    }
  }
  await ensureConfigDir(file);
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw new ConfigError(`Could not recreate ${file}: ${(error as Error).message}`);
  }
  try {
    await chmod(file, 0o600);
  } catch {
    // best effort
  }
  return backup;
}

export interface ResolvedProfile {
  name: string;
  profile: ProfileConfig;
  apiKey: string | undefined;
}

export function resolveProfile(config: KiroConfig, name = config.activeProfile): ResolvedProfile {
  const profile = config.profiles[name];
  if (!profile) {
    throw new ConfigError(
      `Unknown profile "${name}". Available profiles: ${Object.keys(config.profiles).join(', ')}.`,
    );
  }
  if (profile.type !== 'openai') {
    throw new ConfigError(
      `Profile "${name}" uses unsupported provider type "${profile.type}". Phase 1 supports "openai".`,
    );
  }
  let apiKey: string | undefined;
  if (profile.apiKeyEnv) {
    apiKey = process.env[profile.apiKeyEnv];
    if (!apiKey) {
      throw new ConfigError(
        `API key is missing: environment variable ${profile.apiKeyEnv} is not set (profile "${name}").\n` +
          `Store it with: kiro model (choose "Edit a model")\n` +
          `Or set it for this shell with: export ${profile.apiKeyEnv}=your-key`,
      );
    }
  }
  return { name, profile, apiKey };
}
