import type { ToolDefinition } from '../providers/types.js';
import { redactSecrets } from '../secrets.js';
import { fsTools } from './fs.js';
import { patchTools } from './patch.js';
import { searchTools } from './search.js';
import { runCommandTool } from './shell.js';
import { skillTools } from './skill.js';
import type { Tool, ToolContext, ToolResult } from './types.js';
import { toolError } from './types.js';

export const MAX_TOOL_RESULT_CHARS = 60_000;

export const tools: Tool[] = [...fsTools, ...searchTools, ...patchTools, runCommandTool, ...skillTools];

export const toolDefinitions: ToolDefinition[] = tools.map((tool) => tool.definition);

const byName = new Map(tools.map((tool) => [tool.definition.function.name, tool]));

export function isReadOnlyTool(name: string): boolean {
  return byName.get(name)?.readOnly === true;
}

/** Strips registered credentials so they cannot reach the model or a saved session. */
function redactResult(result: ToolResult): ToolResult {
  return {
    ...result,
    content: redactSecrets(result.content),
    summary: redactSecrets(result.summary),
  };
}

/** Last-resort cap so one tool call cannot flood the context window. */
function capResult(name: string, result: ToolResult): ToolResult {
  if (result.content.length <= MAX_TOOL_RESULT_CHARS) return result;
  const headLength = Math.floor(MAX_TOOL_RESULT_CHARS * 0.7);
  const tailLength = MAX_TOOL_RESULT_CHARS - headLength;
  const omitted = result.content.length - MAX_TOOL_RESULT_CHARS;
  const note =
    `… [${name} output truncated: ${omitted.toLocaleString()} characters omitted ` +
    `(limit ${MAX_TOOL_RESULT_CHARS.toLocaleString()}). Narrow the request to see more: ` +
    'use a smaller read_file limit/offset, a tighter grep pattern or glob, fewer results, ' +
    'or head/tail in run_command.] …';
  return {
    ...result,
    content: `${result.content.slice(0, headLength)}\n${note}\n${result.content.slice(-tailLength)}`,
    summary: `${result.summary} (truncated)`,
  };
}

export async function executeTool(
  name: string,
  rawArguments: string,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = byName.get(name);
  if (!tool) {
    return toolError(
      `Unknown tool "${name}". Available tools: ${[...byName.keys()].join(', ')}.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = rawArguments.trim() === '' ? {} : JSON.parse(rawArguments);
  } catch (error) {
    return toolError(
      `Invalid JSON arguments for ${name}: ${(error as Error).message}. ` +
        'The arguments were truncated or malformed — often because the response hit its ' +
        'max_tokens limit. Resend this call with smaller arguments (split the work into ' +
        'several calls) or ask for a higher maxTokens.',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return toolError(`Arguments for ${name} must be a JSON object.`);
  }

  try {
    return capResult(name, redactResult(await tool.run(parsed as Record<string, unknown>, ctx)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return redactResult(toolError(`${name} failed: ${message}`));
  }
}

export type { Tool, ToolContext, ToolResult } from './types.js';
