import { spawn, type ChildProcess } from 'node:child_process';

import { endpointFrom, MCP_CLIENT_NAME, MCP_CLIENT_VERSION, MCP_PROTOCOL_VERSION, type McpEndpoint, type McpServerConfig } from './client.js';
import { RpcChannel, createLineReader, RpcError } from './rpc.js';
import { childEnvFor } from './env.js';

/** How long `tools/list` and `tools/call` may take before the call fails. */
export const MCP_CALL_TIMEOUT_MS = Number(process.env.KIRO_MCP_TIMEOUT_MS ?? 30_000);

const MAX_STDERR_KEPT = 2_000;

/**
 * Starts a server process and speaks MCP over its stdio. This is the fallback
 * used when `@modelcontextprotocol/sdk` is not installed, and it is what the
 * tests exercise, so the framing is covered without an optional dependency.
 */
export async function connectStdio(
  name: string,
  config: McpServerConfig,
  options: { cwd?: string; signal?: AbortSignal; onNotice?: (message: string) => void } = {},
): Promise<McpEndpoint> {
  const notices: string[] = [];
  let child: ChildProcess;
  try {
    child = spawn(config.command, config.args ?? [], {
      cwd: config.cwd ?? options.cwd ?? process.cwd(),
      env: childEnvFor(config.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
    });
  } catch (error) {
    throw new Error(`Could not start MCP server "${name}": ${(error as Error).message}`);
  }

  let stderrTail = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-MAX_STDERR_KEPT);
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
    child.on('error', () => resolve({ code: null, signal: null }));
  });

  const rpc = new RpcChannel({
    write: (line) => {
      if (child.stdin?.writable) child.stdin.write(line);
    },
    timeoutMs: MCP_CALL_TIMEOUT_MS,
    onNotice: (message) => {
      notices.push(message);
      options.onNotice?.(`${name}: ${message}`);
    },
  });

  // A server may ask for roots or sampling; Kiro answers "not supported" so the
  // server falls back instead of waiting forever.
  rpc.handle('roots/list', () => ({ roots: [] }));
  rpc.handle('ping', () => ({}));

  const reader = createLineReader((line) => rpc.receive(line));
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => reader.push(chunk));

  const closed = new Promise<void>((resolve) => {
    void exited.then(() => {
      reader.flush();
      rpc.close();
      resolve();
    });
  });

  if (!child.pid) {
    const detail = stderrTail.trim().split('\n').slice(-3).join('\n');
    throw new Error(`Could not start MCP server "${name}"${detail ? `: ${detail}` : '.'}`);
  }

  // The handshake is the only place where a wrong protocol version is fatal:
  // the spec allows the client to continue with the version it asked for.
  let init: unknown;
  try {
    init = await rpc.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { roots: { listChanged: false } },
      clientInfo: { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
    });
    rpc.notify('notifications/initialized', {});
  } catch (error) {
    if (error instanceof RpcError) {
      throw new Error(`MCP server "${name}" rejected the handshake: ${error.message}`);
    }
    throw error;
  }

  const info =
    typeof init === 'object' && init !== null
      ? ((init as { serverInfo?: { name?: string; version?: string } }).serverInfo ?? {})
      : {};

  const endpoint = endpointFrom(
    name,
    'builtin',
    {
      name: typeof info.name === 'string' ? info.name : name,
      version: typeof info.version === 'string' ? info.version : 'unknown',
    },
    (method, params) => rpc.request(method, params),
    async () => {
      rpc.close();
      child.stdin?.end();
      // Give the server a moment to exit, then stop it: a hung server must not
      // keep the CLI alive when the user quits.
      const timer = setTimeout(() => child.kill('SIGTERM'), 500);
      timer.unref?.();
      await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 1_500))]);
      clearTimeout(timer);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  );

  // A server that dies later fails its pending calls instead of leaving them to
  // time out: rpc.close() rejects everything still waiting.
  void closed.then(() => rpc.close());

  return endpoint;
}
