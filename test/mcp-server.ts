#!/usr/bin/env node
/**
 * A small MCP server over stdio, used by the tests and handy for a manual run:
 *
 *   node --import tsx test/mcp-server.ts
 *
 * It answers initialize, tools/list, and tools/call, and it deliberately prints
 * one non-JSON line first so the client's notice path is exercised.
 */
import { createInterface } from 'node:readline';

const TOOLS = [
  {
    name: 'lookup_time',
    description: 'Return a fixed timestamp for a zone.',
    inputSchema: {
      type: 'object',
      properties: { zone: { type: 'string', description: 'Zone name, e.g. "UTC".' } },
      required: ['zone'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'fail_tool',
    description: 'Always reports an error, to test the error path.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'rich_content',
    description: 'Returns several content blocks.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function send(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

if (process.env.MCP_BANNER !== '0') {
  process.stdout.write('mcp-server starting\n');
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return;
  }
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  if (id === undefined) return;

  if (message.jsonrpc !== '2.0') {
    send({ jsonrpc: '2.0', id, error: { code: -32600, message: 'expected jsonrpc 2.0' } });
    return;
  }

  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'kiro-test-server', version: '1.2.3' },
        },
      });
      return;
    case 'tools/list':
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    case 'tools/call': {
      const params = (message.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      if (params.name === 'lookup_time') {
        const zone = typeof params.arguments?.zone === 'string' ? params.arguments.zone : 'UTC';
        send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: `2026-01-01T00:00:00 ${zone}` }] },
        });
        return;
      }
      if (params.name === 'fail_tool') {
        send({
          jsonrpc: '2.0',
          id,
          result: { isError: true, content: [{ type: 'text', text: 'the tool refused' }] },
        });
        return;
      }
      if (params.name === 'rich_content') {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              { type: 'text', text: 'first block' },
              { type: 'image', data: 'AAAA', mimeType: 'image/png' },
              { type: 'resource', resource: { uri: 'file:///notes.md', text: 'second block' } },
            ],
          },
        });
        return;
      }
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${params.name}` } });
      return;
    }
    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    default:
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
});
