import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

export interface MockToolCall {
  id?: string;
  name: string;
  arguments: string | Record<string, unknown>;
}

export interface MockUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
}

export type MockTurn =
  | { type: 'text'; text: string; chunkSize?: number; delayMs?: number; usage?: MockUsage; finishReason?: string }
  | {
      type: 'tool-calls';
      text?: string;
      calls: MockToolCall[];
      chunkSize?: number;
      delayMs?: number;
      usage?: MockUsage;
      finishReason?: string;
    }
  | { type: 'http-error'; status: number; body: string; headers?: Record<string, string> }
  | { type: 'malformed-sse'; body?: string }
  /** Sends SSE headers (and optionally some text), then drops the connection. */
  | { type: 'drop'; text?: string; chunkSize?: number; delayMs?: number }
  | { type: 'hang' };

export interface MockServerOptions {
  turns?: MockTurn[];
  port?: number;
  /**
   * Model ids served by GET /models. Leave undefined (the default) to act like
   * an endpoint that does not implement /models.
   */
  models?: string[] | null;
  /** Force a status for GET /models, e.g. 401 for a bad-key variant. */
  modelsStatus?: number;
}

export interface RecordedRequest {
  body: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
}

export interface RecordedModelRequest {
  url: string;
  headers: http.IncomingHttpHeaders;
}

export interface MockServer {
  url: string;
  port: number;
  requests: RecordedRequest[];
  modelRequests: RecordedModelRequest[];
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function splitChunks(text: string, size: number): string[] {
  if (size <= 0) return [text];
  return text.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) ?? [];
}

export const DEFAULT_TURNS: MockTurn[] = [
  {
    type: 'tool-calls',
    text: "I'll create hello.txt and inspect the directory.",
    calls: [
      { name: 'write_file', arguments: { path: 'hello.txt', content: 'hello from Kiro\n' } },
      { name: 'list_dir', arguments: { path: '.' } },
    ],
  },
  {
    type: 'tool-calls',
    text: 'Now I will run a command to confirm it exists.',
    calls: [{ name: 'run_command', arguments: { command: 'ls' } }],
  },
  {
    type: 'text',
    text: 'Done. I created hello.txt, listed the directory, and ran ls successfully.',
  },
  {
    type: 'tool-calls',
    text: 'Creating two more files.',
    calls: [
      { name: 'write_file', arguments: { path: 'second.txt', content: 'second\n' } },
      { name: 'write_file', arguments: { path: 'third.txt', content: 'third\n' } },
    ],
  },
  {
    type: 'text',
    text: 'Created second.txt and third.txt.',
  },
  {
    type: 'text',
    text:
      'This is a deliberately slow response used to test cancelling a live turn. ' +
      'It keeps streaming for several seconds, one small piece at a time, so Ctrl+C can interrupt it. '.repeat(4),
    chunkSize: 2,
    delayMs: 120,
  },
];

export async function createMockServer(options: MockServerOptions = {}): Promise<MockServer> {
  const turns = options.turns ?? DEFAULT_TURNS;
  const requests: RecordedRequest[] = [];
  const modelRequests: RecordedModelRequest[] = [];
  let turnIndex = 0;

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && requestUrl.pathname.endsWith('/models')) {
      modelRequests.push({ url: req.url ?? '', headers: req.headers });
      const status = options.modelsStatus ?? (options.models ? 200 : 404);
      if (status !== 200) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message:
                status === 401
                  ? 'Incorrect API key provided'
                  : `model list unavailable (HTTP ${status})`,
            },
          }),
        );
        return;
      }
      const ids = options.models ?? [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: ids.map((id) => ({ id, object: 'model', owned_by: 'mock' })),
        }),
      );
      return;
    }

    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }

    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
    });
    req.on('end', () => {
      void handleRequest(req, res, raw);
    });
  });

  const handleRequest = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    raw: string,
  ): Promise<void> => {
    let body: Record<string, unknown> = {};
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid request JSON' } }));
      return;
    }
    requests.push({ body, headers: req.headers });

    const turn = turns[Math.min(turnIndex, turns.length - 1)] ?? { type: 'text', text: 'No turns configured.' };
    turnIndex++;

    if (turn.type === 'http-error') {
      res.writeHead(turn.status, { 'Content-Type': 'application/json', ...turn.headers });
      res.end(turn.body);
      return;
    }
    if (turn.type === 'malformed-sse') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(turn.body ?? 'data: {"broken": \n\ndata: [DONE]\n\n');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Mock-Turn': String(turnIndex),
    });
    res.flushHeaders?.();
    const send = (payload: unknown) => {
      if (!res.destroyed) res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    const delayMs = 'delayMs' in turn ? (turn.delayMs ?? 2) : 2;
    const chunkSize = 'chunkSize' in turn ? (turn.chunkSize ?? 6) : 6;

    if (turn.type === 'drop') {
      if (turn.text) {
        for (const piece of splitChunks(turn.text, chunkSize)) {
          if (!res.destroyed) {
            send({ choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
          }
          if (delayMs) await sleep(delayMs);
        }
      }
      res.destroy();
      req.destroy();
      return;
    }

    if (turn.type === 'hang') {
      res.write(': hanging\n\n');
      await new Promise<void>((resolve) => {
        res.on('close', () => resolve());
        req.on('close', () => resolve());
      });
      return;
    }

    send({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });

    if (turn.type === 'text') {
      for (const piece of splitChunks(turn.text, chunkSize)) {
        if (!res.destroyed) {
          send({ choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
        }
        if (delayMs) await sleep(delayMs);
      }
      send({ choices: [{ index: 0, delta: {}, finish_reason: turn.finishReason ?? 'stop' }] });
    } else {
      if (turn.text) {
        for (const piece of splitChunks(turn.text, chunkSize)) {
          if (!res.destroyed) {
            send({ choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
          }
          if (delayMs) await sleep(delayMs);
        }
      }
      for (const [index, call] of turn.calls.entries()) {
        const id = call.id ?? `call_mock_${turnIndex}_${index}`;
        const args = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments);
        const pieces = splitChunks(args, chunkSize);
        send({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index, id, type: 'function', function: { name: call.name, arguments: '' } },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        for (const piece of pieces) {
          if (!res.destroyed) {
            send({
              choices: [
                {
                  index: 0,
                  delta: { tool_calls: [{ index, function: { arguments: piece } }] },
                  finish_reason: null,
                },
              ],
            });
          }
          if (delayMs) await sleep(delayMs);
        }
      }
      send({ choices: [{ index: 0, delta: {}, finish_reason: turn.finishReason ?? 'tool_calls' }] });
    }

    if ('usage' in turn && turn.usage) {
      send({
        id: 'mock',
        object: 'chat.completion.chunk',
        choices: [],
        usage: {
          total_tokens: turn.usage.prompt_tokens + turn.usage.completion_tokens,
          ...turn.usage,
        },
      });
    }

    if (!res.destroyed) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  };

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const port = address.port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    modelRequests,
    async close() {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  const port = Number(process.env.MOCK_PORT ?? 8787);
  const mock = await createMockServer({ port });
  console.log(`Mock OpenAI-compatible server listening at ${mock.url}`);
  console.log(`Use a profile with baseUrl "${mock.url}" and model "mock", e.g. KIRO_API_KEY=test.`);
  console.log('Script: write hello.txt + list_dir, then run_command ls, then a final answer.');
  const shutdown = async () => {
    await mock.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
