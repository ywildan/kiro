import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

/**
 * MCP servers come from two places, merged in this order (the first definition
 * of a name wins, matching how skills are resolved):
 *
 *   1. `<cwd>/.kiro/mcp.json`
 *   2. `~/.kiro/mcp.json`
 *
 * The `mcpServers` object matches the shape other tools use, so an existing
 * file can be copied in unchanged.
 */

export type McpTransport = 'stdio' | 'http';

export interface McpServerEntry {
  type?: McpTransport;
  /** stdio: the program to run. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http: the streamable-HTTP endpoint. */
  url?: string;
  headers?: Record<string, string>;
  /**
   * Per-call limit in milliseconds, for stdio and HTTP alike. A tool that
   * blocks, such as a long-poll `wait_for_message`, needs a large value.
   */
  timeoutMs?: number;
  /** Server-wide switch; a disabled server is listed by /mcp but never started. */
  disabled?: boolean;
}

export interface McpFile {
  /** Only stdio servers are started by this build; others are reported. */
  mcpServers: Record<string, McpServerEntry>;
}

export interface McpSource {
  path: string;
  servers: Record<string, McpServerEntry>;
}

export interface McpLoadResult {
  /** Merged servers, project first. */
  servers: Record<string, McpServerEntry>;
  sources: McpSource[];
  /** File-level problems, e.g. invalid JSON; a bad file never blocks startup. */
  problems: string[];
}

export function mcpConfigPath(cwd: string, scope: 'project' | 'user', home: string): string {
  return scope === 'project'
    ? path.join(cwd, '.kiro', 'mcp.json')
    : path.join(home, '.kiro', 'mcp.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads one file; a missing file is not a problem, a broken one is. */
export async function readMcpFile(file: string): Promise<{ servers: Record<string, McpServerEntry>; problem?: string }> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { servers: {} };
    return { servers: {}, problem: `Could not read ${file}: ${(error as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      servers: {},
      problem: `${file} is not valid JSON (${(error as Error).message}); no servers were loaded from it.`,
    };
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    return { servers: {}, problem: `${file} needs an "mcpServers" object.` };
  }
  const servers: Record<string, McpServerEntry> = {};
  for (const [name, raw] of Object.entries(parsed.mcpServers)) {
    if (!isRecord(raw)) continue;
    servers[name] = normalizeEntry(raw);
  }
  return { servers };
}

function stringMap(raw: unknown): Record<string, string> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** `timeout` is milliseconds, matching other MCP clients; `timeoutSec` is the same in seconds. */
function timeoutMsFrom(raw: Record<string, unknown>): number | undefined {
  const ms = typeof raw.timeout === 'number' ? raw.timeout : undefined;
  const sec = typeof raw.timeoutSec === 'number' ? raw.timeoutSec * 1000 : undefined;
  const value = ms ?? sec;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(value, 24 * 60 * 60 * 1000);
}

function normalizeEntry(raw: Record<string, unknown>): McpServerEntry {
  const args = Array.isArray(raw.args) ? raw.args.filter((arg): arg is string => typeof arg === 'string') : undefined;
  return {
    type:
      raw.type === 'http' || raw.type === 'stdio'
        ? raw.type
        : typeof raw.url === 'string'
          ? 'http'
          : 'stdio',
    command: typeof raw.command === 'string' ? raw.command : undefined,
    args,
    env: stringMap(raw.env),
    url: typeof raw.url === 'string' ? raw.url : undefined,
    headers: stringMap(raw.headers),
    timeoutMs: timeoutMsFrom(raw),
    disabled: raw.disabled === true,
  };
}

export async function loadMcpConfig(
  cwd: string,
  home: string,
  extraPath?: string,
): Promise<McpLoadResult> {
  const files: { scope: 'project' | 'user'; path: string }[] = [
    { scope: 'project', path: mcpConfigPath(cwd, 'project', home) },
    { scope: 'user', path: mcpConfigPath(cwd, 'user', home) },
  ];
  if (extraPath) files.push({ scope: 'user', path: extraPath });

  const servers: Record<string, McpServerEntry> = {};
  const sources: McpSource[] = [];
  const problems: string[] = [];
  for (const file of files) {
    const { servers: found, problem } = await readMcpFile(file.path);
    if (problem) problems.push(problem);
    if (Object.keys(found).length > 0) sources.push({ path: file.path, servers: found });
    for (const [name, entry] of Object.entries(found)) {
      if (!servers[name]) servers[name] = entry;
    }
  }
  return { servers, sources, problems };
}

/** Why a server cannot be started, or null when it can. */
export function mcpEntryProblem(entry: McpServerEntry): string | null {
  if (entry.disabled) return 'disabled in the config';
  if (entry.type === 'http') return entry.url ? null : 'no "url" was given';
  if (!entry.command) return 'no "command" was given';
  return null;
}

export type McpScope = 'project' | 'user';

/**
 * Writes one server into the chosen file, keeping the rest of it. A broken or
 * missing file is replaced by a fresh `mcpServers` object, because there is
 * nothing safe to merge into.
 */
export async function saveMcpServer(input: {
  cwd: string;
  home: string;
  scope: McpScope;
  name: string;
  entry: McpServerEntry;
}): Promise<{ path: string; replacedBrokenFile: boolean }> {
  if (!/^[A-Za-z0-9_.-]+$/.test(input.name)) {
    throw new Error(`Server name "${input.name}" may only use letters, digits, "_", "-", and ".".`);
  }
  const file = mcpConfigPath(input.cwd, input.scope, input.home);
  const existing = await readMcpFile(file);
  const replacedBrokenFile = existing.problem !== undefined;
  const servers: Record<string, unknown> = replacedBrokenFile ? {} : { ...existing.servers };
  servers[input.name] = serializeEntry(input.entry);

  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw new Error(`Could not write ${file}: ${(error as Error).message}`);
  }
  // The file can hold a bearer token, so keep it private where the OS supports it.
  await chmod(file, 0o600).catch(() => undefined);
  return { path: file, replacedBrokenFile };
}

/** Removes one server. Returns false when the name was not in that file. */
export async function removeMcpServer(input: {
  cwd: string;
  home: string;
  scope: McpScope;
  name: string;
}): Promise<boolean> {
  const file = mcpConfigPath(input.cwd, input.scope, input.home);
  const existing = await readMcpFile(file);
  if (existing.problem || !existing.servers[input.name]) return false;
  const servers = { ...existing.servers };
  delete servers[input.name];
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw new Error(`Could not write ${file}: ${(error as Error).message}`);
  }
  return true;
}

function serializeEntry(entry: McpServerEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (entry.type === 'http') out.type = 'http';
  if (entry.command) out.command = entry.command;
  if (entry.args && entry.args.length > 0) out.args = entry.args;
  if (entry.env) out.env = entry.env;
  if (entry.url) out.url = entry.url;
  if (entry.headers) out.headers = entry.headers;
  if (entry.timeoutMs) out.timeout = entry.timeoutMs;
  if (entry.disabled) out.disabled = true;
  return out;
}
