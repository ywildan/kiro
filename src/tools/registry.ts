import type { ToolDefinition } from '../providers/types.js';
import type { Tool } from './types.js';

/**
 * The tool list is fixed at build time, but MCP servers are discovered at
 * startup, so their tools are appended here. `executeTool` and the agent loop
 * both read the merged list through this module.
 */

let extras: Tool[] = [];

export function setExtraTools(tools: Tool[]): void {
  extras = tools;
}

export function extraTools(): Tool[] {
  return extras;
}

export function extraToolDefinitions(): ToolDefinition[] {
  return extras.map((tool) => tool.definition);
}
