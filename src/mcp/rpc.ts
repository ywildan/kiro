/**
 * Minimal JSON-RPC 2.0 over a child process's stdio, the transport MCP calls
 * "stdio". One JSON object per line in each direction (NDJSON): the protocol
 * frames on newlines, so a pretty-printed message would break every server.
 *
 * Nothing here knows about MCP itself; `client.ts` builds the MCP handshake on
 * top, which keeps the framing testable on its own.
 */

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class RpcError extends Error {
  readonly code: number;
  constructor(error: JsonRpcError) {
    super(`JSON-RPC ${error.code}: ${error.message}`);
    this.name = 'RpcError';
    this.code = error.code;
  }
}

export class RpcTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`${method} did not answer within ${timeoutMs / 1000}s.`);
    this.name = 'RpcTimeoutError';
  }
}

type Handler = (params: unknown) => Promise<unknown> | unknown;

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  /** Aborts this one call, e.g. when the user cancels a blocking tool. */
  onAbort?: () => void;
  signal?: AbortSignal;
}

interface RpcChannelOptions {
  write: (line: string) => void;
  timeoutMs?: number;
  /** Called for `notifications/...`, logging, and malformed lines. */
  onNotice?: (message: string) => void;
}

export const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/** Correlates requests with responses and dispatches inbound requests to handlers. */
export class RpcChannel {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, Handler>();
  private readonly write: (line: string) => void;
  private readonly timeoutMs: number;
  private readonly onNotice: (message: string) => void;
  private closed = false;

  constructor(options: RpcChannelOptions) {
    this.write = options.write;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.onNotice = options.onNotice ?? (() => {});
  }

  /** Methods the server may call on the client, such as `roots/list`. */
  handle(method: string, handler: Handler): void {
    this.handlers.set(method, handler);
  }

  /**
   * `timeoutMs` overrides the channel default for one call, e.g. a blocking
   * tool. `signal` drops the call without waiting for the timeout; the server
   * still finishes on its side, so only use it when the answer is no longer
   * wanted.
   */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The MCP connection is closed.'));
    if (signal?.aborted) return Promise.reject(new Error(`${method} was cancelled.`));
    const id = this.nextId++;
    const limit = timeoutMs ?? this.timeoutMs;
    return new Promise<T>((resolve, reject) => {
      const finish = (error?: Error, value?: unknown): void => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        if (entry.signal) entry.signal.removeEventListener('abort', entry.onAbort!);
        if (error) reject(error);
        else resolve(value as T);
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (signal) signal.removeEventListener('abort', onAbort);
        reject(new RpcTimeoutError(method, limit));
      }, limit);
      timer.unref?.();
      const onAbort = (): void => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`${method} was cancelled.`));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        onAbort,
        signal,
      });
      this.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  /** Reads one line of output; anything that is not JSON-RPC is reported, not thrown. */
  receive(line: string): void {
    const text = line.trim();
    if (!text) return;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      // Servers sometimes print banners; keep them out of the transcript but visible.
      this.onNotice(`MCP server printed non-JSON output: ${text.slice(0, 200)}`);
      return;
    }
    if (Array.isArray(message)) {
      for (const entry of message) this.receiveMessage(entry);
      return;
    }
    this.receiveMessage(message);
  }

  close(): void {
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      if (pending.signal) pending.signal.removeEventListener('abort', pending.onAbort!);
      pending.reject(new Error(`The connection closed before ${pending.method} answered.`));
      this.pending.delete(id);
    }
  }

  private send(payload: Record<string, unknown>): void {
    this.write(`${JSON.stringify(payload)}\n`);
  }

  private receiveMessage(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return;
    const message = raw as Record<string, unknown>;
    const id = typeof message.id === 'number' ? message.id : undefined;

    if (typeof message.method === 'string') {
      // A request from the server expects a response; a notification does not.
      const params = message.params;
      if (id === undefined) {
        this.onNotice(`MCP notification ignored: ${message.method}`);
        return;
      }
      const handler = this.handlers.get(message.method);
      if (!handler) {
        this.send({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${message.method}` },
        });
        return;
      }
      void Promise.resolve()
        .then(() => handler(params))
        .then((result) => this.send({ jsonrpc: '2.0', id, result }))
        .catch((error: unknown) =>
          this.send({
            jsonrpc: '2.0',
            id,
            error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
          }),
        );
      return;
    }

    if (id === undefined) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (typeof message.error === 'object' && message.error !== null) {
      const error = message.error as Record<string, unknown>;
      pending.reject(
        new RpcError({
          code: typeof error.code === 'number' ? error.code : -32000,
          message: typeof error.message === 'string' ? error.message : 'Unknown JSON-RPC error',
          data: error.data,
        }),
      );
      return;
    }
    pending.resolve(message.result);
  }
}

/** Splits a byte stream into lines without assuming every chunk ends on one. */
export function createLineReader(onLine: (line: string) => void): {
  push: (chunk: string) => void;
  flush: () => void;
} {
  let buffer = '';
  return {
    push(chunk: string): void {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        onLine(line);
        index = buffer.indexOf('\n');
      }
      // A server that never sends a newline must not grow the buffer forever.
      if (buffer.length > 8 * 1024 * 1024) {
        buffer = '';
        onLine('');
      }
    },
    flush(): void {
      if (buffer) onLine(buffer);
      buffer = '';
    },
  };
}
