import type { ToolDefinition } from '../providers/types.js';
import { redactSecrets } from '../secrets.js';
import { askTools } from './ask.js';
import { fsTools } from './fs.js';
import { patchTools } from './patch.js';
import { searchTools } from './search.js';
import { runCommandTool } from './shell.js';
import { skillTools } from './skill.js';
import { extraTools } from './registry.js';
import type { Tool, ToolContext, ToolResult } from './types.js';
import { toolError } from './types.js';

export const MAX_TOOL_RESULT_CHARS = 60_000;

export const tools: Tool[] = [
  ...fsTools,
  ...searchTools,
  ...patchTools,
  runCommandTool,
  ...askTools,
  ...skillTools,
];

export const toolDefinitions: ToolDefinition[] = tools.map((tool) => tool.definition);

/** Built-in tools plus any MCP tools registered after startup. */
export function allTools(): Tool[] {
  return [...tools, ...extraTools()];
}

export function allToolDefinitions(): ToolDefinition[] {
  return [...toolDefinitions, ...extraTools().map((tool) => tool.definition)];
}

function findTool(name: string): Tool | undefined {
  return (
    tools.find((tool) => tool.definition.function.name === name) ??
    extraTools().find((tool) => tool.definition.function.name === name)
  );
}

export function isReadOnlyTool(name: string): boolean {
  return findTool(name)?.readOnly === true;
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
  const tool = findTool(name);
  if (!tool) {
    return toolError(
      `Unknown tool "${name}". Available tools: ${allTools()
        .map((entry) => entry.definition.function.name)
        .join(', ')}.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = rawArguments.trim() === '' ? {} : JSON.parse(rawArguments);
  } catch (error) {
    // The size is the useful clue: a reply cut at max_tokens always ends mid-value.
    const size = rawArguments.length.toLocaleString();
    const advice =
      name === 'write_file' || name === 'apply_patch' || name === 'multi_edit'
        ? 'For a large file, write the first part with write_file and add the rest with ' +
          'edit_file or apply_patch, or reduce the content.'
        : 'Split the work into several calls.';
    return toolError(
      `Invalid JSON arguments for ${name}: ${(error as Error).message}. ` +
        `Kiro received ${size} characters. ` +
        'The arguments were truncated or malformed, often because the response hit its ' +
        `max_tokens limit. ${advice} Ask for a higher maxTokens if the reply keeps getting cut.`,
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

export { setExtraTools, extraTools } from './registry.js';
export type { Tool, ToolContext, ToolResult } from './types.js';
