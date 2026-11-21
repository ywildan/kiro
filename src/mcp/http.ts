import {
  endpointFrom,
  MCP_CLIENT_NAME,
  MCP_CLIENT_VERSION,
  MCP_PROTOCOL_VERSION,
  type McpEndpoint,
  type McpHttpConfig,
} from './client.js';
import { RpcError } from './rpc.js';
import { expandHeaders } from './env.js';

/**
 * Streamable HTTP transport: one POST per JSON-RPC message, and the server
 * answers either as `application/json` or as an SSE stream that carries the
 * reply. A server may hand back `Mcp-Session-Id` on initialize, which every
 * later request repeats.
 *
 * https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
 */

export const MCP_HTTP_TIMEOUT_MS = Number(process.env.KIRO_MCP_TIMEOUT_MS ?? 30_000);
const SESSION_HEADER = 'mcp-session-id';
const MAX_BODY_CHARS = 4 * 1024 * 1024;

/** Parses the `data:` payloads of an SSE body and returns the last JSON object. */
export function readSseMessage(body: string): unknown {
  const events: unknown[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      events.push(JSON.parse(payload));
    } catch {
      // A partial or non-JSON data line is not a protocol message; skip it.
    }
  }
  // Notifications can precede the response on the same stream.
  const answered = events.filter(
    (event) => typeof event === 'object' && event !== null && 'id' in (event as Record<string, unknown>),
  );
  return answered.at(-1) ?? events.at(-1);
}

async function readBody(response: Response): Promise<string> {
  const text = await response.text();
  return text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) : text;
}

/** Turns a non-2xx answer into a message that names the status and the server's own text. */
async function describeFailure(response: Response): Promise<string> {
  const body = (await readBody(response)).trim();
  const hint = body ? `: ${body.slice(0, 300)}` : '';
  if (response.status === 401 || response.status === 403) {
    return `the server refused the request (${response.status} ${response.statusText})${hint}. Check the "headers" in the config entry.`;
  }
  return `the server answered ${response.status} ${response.statusText}${hint}`;
}

export async function connectHttp(
  name: string,
  config: McpHttpConfig,
  options: { onNotice?: (message: string) => void } = {},
): Promise<McpEndpoint> {
  const timeoutMs = config.timeoutMs ?? MCP_HTTP_TIMEOUT_MS;
  let sessionId: string | undefined;
  let protocolVersion = MCP_PROTOCOL_VERSION;
  let closed = false;
  let nextId = 1;

  const headers = (): Record<string, string> => ({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...expandHeaders(config.headers),
    ...(sessionId ? { [SESSION_HEADER]: sessionId } : {}),
    ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}),
  });

  const post = async (
    payload: Record<string, unknown>,
    method: string,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    if (closed) throw new Error('The MCP connection is closed.');
    if (signal?.aborted) throw new Error(`${method} was cancelled.`);
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetch(config.url, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(payload),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw new Error(`${method} was cancelled.`);
      const reason = (error as Error).name === 'TimeoutError'
        ? `${method} did not answer within ${timeoutMs / 1000}s.`
        : `could not reach the server: ${(error as Error).message}`;
      throw new Error(reason);
    }
    if (!response.ok) throw new Error(await describeFailure(response));
    const session = response.headers.get(SESSION_HEADER);
    if (session) sessionId = session;
    // A notification is acknowledged with 202 and no body.
    if (response.status === 202 || method === 'notifications/initialized') return undefined;
    const body = await readBody(response);
    const contentType = response.headers.get('content-type') ?? '';
    const message = contentType.includes('text/event-stream') ? readSseMessage(body) : parseJson(body);
    if (message === undefined) return undefined;
    if (typeof message !== 'object' || message === null) return undefined;
    const record = message as Record<string, unknown>;
    if (typeof record.error === 'object' && record.error !== null) {
      const error = record.error as Record<string, unknown>;
      throw new RpcError({
        code: typeof error.code === 'number' ? error.code : -32000,
        message: typeof error.message === 'string' ? error.message : 'Unknown JSON-RPC error',
        data: error.data,
      });
    }
    if (typeof record.method === 'string') {
      options.onNotice?.(`${name}: the server sent a request over HTTP (${record.method}); Kiro only handles replies here.`);
      return undefined;
    }
    return record.result;
  };

  const request = async (method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> => {
    const id = nextId++;
    return post({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }, method, signal);
  };

  let init: unknown;
  try {
    init = await request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { roots: { listChanged: false } },
      clientInfo: { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
    });
  } catch (error) {
    throw new Error(`MCP server "${name}" failed over HTTP: ${(error as Error).message}`);
  }
  const negotiated =
    typeof init === 'object' && init !== null ? (init as { protocolVersion?: string }).protocolVersion : undefined;
  if (typeof negotiated === 'string') protocolVersion = negotiated;
  await post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, 'notifications/initialized');

  const info =
    typeof init === 'object' && init !== null
      ? ((init as { serverInfo?: { name?: string; version?: string } }).serverInfo ?? {})
      : {};

  return endpointFrom(
    name,
    'http',
    {
      name: typeof info.name === 'string' ? info.name : name,
      version: typeof info.version === 'string' ? info.version : 'unknown',
    },
    request,
    async () => {
      if (closed) return;
      closed = true;
      if (!sessionId) return;
      // Best effort: a server that dislikes DELETE must not fail the quit path.
      try {
        await fetch(config.url, {
          method: 'DELETE',
          headers: headers(),
          signal: AbortSignal.timeout(2_000),
        });
      } catch {
        // Ignored on purpose: the session id expires on the server anyway.
      }
    },
  );
}

function parseJson(body: string): unknown {
  if (!body.trim()) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
