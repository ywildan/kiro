/**
 * MCP handshake and the pieces Kiro uses: initialize, list tools, call a tool.
 *
 * The transport is chosen in `sdk.ts`: the official SDK when its optional
 * package is installed, otherwise a built-in stdio client that speaks the same
 * JSON-RPC subset. Both produce the same `McpEndpoint` shape, so the tool
 * registry never has to know which one is running.
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MCP_CLIENT_NAME = 'kiro';
export const MCP_CLIENT_VERSION = '0.4.0';

export interface McpToolInfo {
  name: string;
  description: string;
  /** JSON Schema for the arguments, as the server described them. */
  inputSchema: Record<string, unknown>;
  /** Present on newer servers; Kiro only uses it for the prompt. */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export interface McpCallResult {
  /** Text and JSON content flattened to something the model can read. */
  content: string;
  isError: boolean;
}

export interface McpEndpoint {
  serverName: string;
  /** 'sdk' when the official client is in use, 'builtin' for the fallback. */
  transport: 'sdk' | 'builtin';
  serverInfo: { name: string; version: string };
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  close(): Promise<void>;
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Working directory for the server process; defaults to the project. */
  cwd?: string;
}

/**
 * Flattens MCP content blocks into text. JSON blocks are pretty-printed so a
 * returned object stays readable, and binary blocks say what they were rather
 * than dumping base64 into the context window.
 */
export function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : '';
  }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (typeof block !== 'object' || block === null) continue;
    const entry = block as Record<string, unknown>;
    const type = typeof entry.type === 'string' ? entry.type : 'unknown';
    if (type === 'text' && typeof entry.text === 'string') {
      parts.push(entry.text);
    } else if (type === 'resource' && typeof entry.resource === 'object' && entry.resource !== null) {
      const resource = entry.resource as Record<string, unknown>;
      const text = typeof resource.text === 'string' ? resource.text : '';
      const uri = typeof resource.uri === 'string' ? resource.uri : 'resource';
      parts.push(text ? `${uri}\n${text}` : `${uri} (no text content)`);
    } else if (type === 'image') {
      parts.push('[image content omitted: Kiro cannot display images]');
    } else if (type === 'audio') {
      parts.push('[audio content omitted]');
    } else {
      parts.push(JSON.stringify(entry));
    }
  }
  return parts.join('\n').trim();
}

/** Validates and normalizes a tool list; a server may omit fields. */
export function readToolList(result: unknown): McpToolInfo[] {
  if (typeof result !== 'object' || result === null) return [];
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return [];
  const out: McpToolInfo[] = [];
  for (const raw of tools) {
    if (typeof raw !== 'object' || raw === null) continue;
    const tool = raw as Record<string, unknown>;
    const name = typeof tool.name === 'string' ? tool.name.trim() : '';
    if (!name) continue;
    const schema =
      typeof tool.inputSchema === 'object' && tool.inputSchema !== null
        ? (tool.inputSchema as Record<string, unknown>)
        : { type: 'object', properties: {} };
    const annotations =
      typeof tool.annotations === 'object' && tool.annotations !== null
        ? (tool.annotations as McpToolInfo['annotations'])
        : undefined;
    out.push({
      name,
      description: typeof tool.description === 'string' ? tool.description : '',
      inputSchema: schema,
      annotations,
    });
  }
  return out;
}

/** Builds an endpoint from an already-initialized connection. */
export function endpointFrom(
  serverName: string,
  transport: McpEndpoint['transport'],
  serverInfo: { name: string; version: string },
  call: (method: string, params?: unknown) => Promise<unknown>,
  close: () => Promise<void> | void,
): McpEndpoint {
  return {
    serverName,
    transport,
    serverInfo,
    async listTools() {
      const result = await call('tools/list', {});
      return readToolList(result);
    },
    async callTool(name, args) {
      const result = await call('tools/call', { name, arguments: args });
      const record = typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {};
      return {
        content: flattenContent(record.content),
        isError: record.isError === true,
      };
    },
    async close() {
      await close();
    },
  };
}

/** A tool name the model can call: namespaced so two servers cannot collide. */
export function mcpToolName(server: string, tool: string): string {
  const clean = (value: string) => value.replace(/[^A-Za-z0-9_]/g, '_');
  return `mcp__${clean(server)}__${clean(tool)}`;
}
