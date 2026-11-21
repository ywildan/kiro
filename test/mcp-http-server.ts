/**
 * A streamable-HTTP MCP server for the tests: POST /mcp, one JSON-RPC message
 * per request, the reply either as JSON or as an SSE stream. It also checks the
 * things a real server checks: the bearer token, and the session id it handed
 * out on initialize.
 *
 *   node --import tsx test/mcp-http-server.ts [port]
 *
 * Not part of the build; `src/mcp/http.ts` is what it is tested against.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

const TOKEN = 'test-token';
const SESSION = randomUUID();
const tools = [
  {
    name: 'http_echo',
    description: 'Echo the text you pass in.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'http_slow',
    description: 'Answers after a delay, to test a long tool timeout.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function reply(response: ServerResponse, payload: unknown, sse = false): void {
  const body = sse ? `event: message\ndata: ${JSON.stringify(payload)}\n\n` : JSON.stringify(payload);
  response.writeHead(200, {
    'content-type': sse ? 'text/event-stream' : 'application/json',
    'cache-control': 'no-cache',
    ...(SESSION ? { 'mcp-session-id': SESSION } : {}),
  });
  response.end(body);
}

const server = createServer((request, response) => {
  void (async () => {
    if (request.url !== '/mcp') {
      response.writeHead(404).end('not found');
      return;
    }
    if (request.method === 'DELETE') {
      response.writeHead(200).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405).end('method not allowed');
      return;
    }
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401, { 'content-type': 'application/json' }).end(
        JSON.stringify({ error: 'bad token' }),
      );
      return;
    }
    const raw = await readBody(request);
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      response.writeHead(400).end('bad json');
      return;
    }
    const id = message.id;
    const method = typeof message.method === 'string' ? message.method : '';
    if (method === 'initialize') {
      if (request.headers['mcp-session-id'] && request.headers['mcp-session-id'] !== SESSION) {
        response.writeHead(404).end('unknown session');
        return;
      }
      reply(response, {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'kiro-http-server', version: '2.0.0' },
        },
      });
      return;
    }
    if (method.startsWith('notifications/')) {
      response.writeHead(202).end();
      return;
    }
    if (request.headers['mcp-session-id'] !== SESSION) {
      response.writeHead(400).end('missing session');
      return;
    }
    if (method === 'tools/list') {
      // Sent as SSE, because a real server may choose either framing.
      reply(response, { jsonrpc: '2.0', id, result: { tools } }, true);
      return;
    }
    if (method === 'tools/call') {
      const params = (message.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      if (params.name === 'http_echo') {
        reply(response, {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: `echo: ${String(params.arguments?.text ?? '')}` }] },
        });
        return;
      }
      if (params.name === 'http_slow') {
        setTimeout(() => {
          reply(response, {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: 'slow reply arrived' }] },
          });
        }, 400);
        return;
      }
      reply(response, { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${params.name}` } });
      return;
    }
    reply(response, { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  })().catch(() => {
    if (!response.headersSent) response.writeHead(500).end('server error');
  });
});

const port = Number(process.argv[2] ?? 0);
server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  const actual = typeof address === 'object' && address ? address.port : port;
  process.stdout.write(`listening ${actual}\n`);
});
