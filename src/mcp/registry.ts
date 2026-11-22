import path from 'node:path';

import type { ToolDefinition } from '../providers/types.js';
import type { ApprovalRequest, Tool, ToolContext, ToolResult } from '../tools/types.js';
import {
  mcpToolName,
  type McpEndpoint,
  type McpToolInfo,
} from './client.js';
import { loadMcpConfig, mcpEntryProblem, type McpLoadResult, type McpServerEntry } from './config.js';
import { connectStdio } from './stdio.js';
import { connectHttp } from './http.js';

/**
 * Turns a server's tools into Kiro tools, namespaced as `mcp__<server>__<tool>`.
 *
 * An MCP server can do anything its process can do, so every call asks for
 * approval by default. `annotations.readOnlyHint` only changes the wording and
 * lets read-only calls run in parallel; it never skips the prompt.
 */

export const MCP_CONNECT_TIMEOUT_MS = Number(process.env.KIRO_MCP_CONNECT_MS ?? 15_000);

export interface McpServerStatus {
  name: string;
  state: 'ready' | 'error' | 'skipped';
  transport?: 'sdk' | 'builtin' | 'http';
  detail?: string;
  tools: number;
  /** The config entry, so `/mcp` can show the command without re-reading the file. */
  entry?: McpServerEntry;
}

export interface McpSetup {
  tools: Tool[];
  definitions: ToolDefinition[];
  statuses: McpServerStatus[];
  config: McpLoadResult;
  /** Rules that must not pre-approve anything from an MCP server. */
  close(): Promise<void>;
}

/**
 * MCP calls carry no `subject`, so `evaluateRules` cannot match them and a saved
 * rule can never pre-approve one. This predicate documents that invariant for
 * callers that build a request by hand.
 */
export function mcpNeedsApproval(request: ApprovalRequest): boolean {
  return isMcpTool(request.tool) || request.subject === undefined;
}

export function isMcpTool(name: string): boolean {
  return name.startsWith('mcp__');
}

function schemaFor(tool: McpToolInfo): ToolDefinition['function']['parameters'] {
  const schema = tool.inputSchema;
  if (schema.type !== 'object' || typeof schema.properties !== 'object' || schema.properties === null) {
    // Some servers describe no arguments; the model still needs an object schema.
    return { type: 'object', properties: {}, additionalProperties: true };
  }
  return {
    type: 'object',
    properties: schema.properties as Record<string, unknown>,
    ...(Array.isArray(schema.required) ? { required: schema.required as string[] } : {}),
    ...(typeof schema.additionalProperties === 'boolean'
      ? { additionalProperties: schema.additionalProperties }
      : {}),
  };
}

function describe(server: string, tool: McpToolInfo): string {
  const readOnly = tool.annotations?.readOnlyHint === true;
  const firstLine = tool.description.split('\n')[0]?.trim() ?? '';
  const body = firstLine || `Tool "${tool.name}" from the MCP server "${server}".`;
  return `${body} (MCP server "${server}"${readOnly ? ', read-only' : ''}). Requires user approval.`;
}

function mcpTool(server: string, endpoint: McpEndpoint, info: McpToolInfo): Tool {
  const name = mcpToolName(server, info.name);
  return {
    // Always false: an MCP server decides what a tool does, so two calls of the
    // same read-only hint still run one at a time and get their own prompt.
    readOnly: false,
    mcp: true,
    definition: {
      type: 'function',
      function: {
        name,
        description: describe(server, info),
        parameters: schemaFor(info),
      },
    },
    async run(input, ctx: ToolContext): Promise<ToolResult> {
      const request: ApprovalRequest = {
        tool: name,
        title: `MCP ${server}: ${info.name}`,
        detail: `$ ${JSON.stringify(input)}\n\nRuns in the MCP server process "${server}", outside Kiro's file sandbox.`,
        // No subject: a saved rule must never pre-approve an MCP call.
        warning: 'This tool runs inside the MCP server, so Kiro cannot see or limit what it does.',
      };
      if (ctx.signal.aborted) {
        return { content: 'Cancelled by user.', summary: 'cancelled', status: 'denied' };
      }
      const decision = await ctx.approve(request);
      if (decision === 'deny') {
        return { content: 'User denied this MCP tool call.', summary: 'denied by user', status: 'denied' };
      }
      try {
        const result = await endpoint.callTool(info.name, input, ctx.signal);
        const content = result.content || '(no content)';
        return {
          content: result.isError ? `Error: ${content}` : content,
          summary: content.split('\n')[0]?.slice(0, 200) ?? info.name,
          status: result.isError ? 'error' : 'ok',
        };
      } catch (error) {
        if (ctx.signal.aborted) {
          return { content: 'Cancelled by user.', summary: 'cancelled', status: 'denied' };
        }
        return {
          content: `Error: MCP server "${server}" failed to run "${info.name}": ${(error as Error).message}`,
          summary: `${info.name} failed`,
          status: 'error',
        };
      }
    },
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s.`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Starts every enabled server and collects its tools. A server that fails is
 * reported and skipped; the session still starts, because one broken MCP entry
 * must not make the CLI unusable.
 */
export async function setupMcp(
  cwd: string,
  options: { home?: string; extraPath?: string; onNotice?: (message: string) => void } = {},
): Promise<McpSetup> {
  const home = options.home ?? process.env.HOME ?? process.env.USERPROFILE ?? '';
  const config = await loadMcpConfig(cwd, home, options.extraPath ?? process.env.KIRO_MCP_CONFIG);
  for (const problem of config.problems) options.onNotice?.(problem);

  const tools: Tool[] = [];
  const statuses: McpServerStatus[] = [];
  const endpoints: McpEndpoint[] = [];
  const names = Object.keys(config.servers).sort((left, right) => left.localeCompare(right));

  // Servers start in parallel; a slow one delays only itself.
  await Promise.all(
    names.map(async (name) => {
      const entry = config.servers[name]!;
      const problem = mcpEntryProblem(entry);
      if (problem) {
        statuses.push({ name, state: 'skipped', detail: problem, tools: 0, entry });
        return;
      }
      try {
        const endpoint = await withTimeout(
          entry.type === 'http'
            ? connectHttp(name, { url: entry.url!, headers: entry.headers, timeoutMs: entry.timeoutMs }, {
                onNotice: options.onNotice,
              })
            : connectStdio(
                name,
                { command: entry.command!, args: entry.args, env: entry.env, timeoutMs: entry.timeoutMs },
                { cwd, onNotice: options.onNotice },
              ),
          MCP_CONNECT_TIMEOUT_MS,
          `Starting MCP server "${name}"`,
        );
        const listed = await withTimeout(endpoint.listTools(), MCP_CONNECT_TIMEOUT_MS, `Listing tools from "${name}"`);
        endpoints.push(endpoint);
        for (const info of listed) tools.push(mcpTool(name, endpoint, info));
        statuses.push({
          name,
          state: 'ready',
          transport: endpoint.transport,
          detail: `${endpoint.serverInfo.name} ${endpoint.serverInfo.version}`,
          tools: listed.length,
          entry,
        });
      } catch (error) {
        statuses.push({
          name,
          state: 'error',
          detail: (error as Error).message,
          tools: 0,
          entry,
        });
      }
    }),
  );

  statuses.sort((left, right) => left.name.localeCompare(right.name));

  return {
    tools,
    definitions: tools.map((tool) => tool.definition),
    statuses,
    config,
    async close() {
      await Promise.all(endpoints.map((endpoint) => endpoint.close().catch(() => undefined)));
    },
  };
}

/** Human-readable status lines for `/mcp` and the startup notice. */
export function formatMcpStatus(setup: McpSetup | null, extraDir?: string): string {
  if (!setup) return 'MCP is off for this run.';
  if (setup.statuses.length === 0) {
    return [
      'No MCP servers configured.',
      `Add "mcpServers" to ${path.join(extraDir ?? '.', '.kiro', 'mcp.json')} or ~/.kiro/mcp.json.`,
    ].join('\n');
  }
  const lines = setup.statuses.map((status) => {
    const mark = status.state === 'ready' ? 'ok  ' : status.state === 'error' ? 'fail' : 'skip';
    const command = status.entry?.command
      ? `${status.entry.command} ${(status.entry.args ?? []).join(' ')}`.trim()
      : status.entry?.url ?? '';
    const limit = status.entry?.timeoutMs
      ? `      timeout ${Math.round(status.entry.timeoutMs / 1000)}s`
      : '';
    return [
      `${mark}  ${status.name}${status.tools > 0 ? ` (${status.tools} tool${status.tools === 1 ? '' : 's'})` : ''}`,
      command ? `      ${command}` : '',
      limit,
      status.detail ? `      ${status.detail}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  });
  const sources = setup.config.sources.map((source) => `      ${source.path}`).join('\n');
  return [lines.join('\n'), sources ? `Read from:\n${sources}` : ''].filter(Boolean).join('\n');
}
