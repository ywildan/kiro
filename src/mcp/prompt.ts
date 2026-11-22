import { extraTools } from '../tools/registry.js';

/**
 * The system prompt lists MCP tools by name only. Their descriptions already
 * travel as tool definitions, and the rules differ enough to be worth stating:
 * Kiro cannot see or limit what a server process does.
 */
export function mcpPromptSection(): string {
  const names = extraTools()
    .map((tool) => tool.definition.function.name)
    .filter((name) => name.startsWith('mcp__'));
  if (names.length === 0) return '';
  return [
    '# MCP tools',
    '',
    'These tools come from MCP servers the user configured. Every name starts with',
    '`mcp__<server>__`. Each call needs approval because the server runs outside',
    "Kiro's file sandbox, so the user decides what it may do. Do not retry a denied",
    'call; explain what the server would have done instead.',
    '',
    `Available: ${names.join(', ')}`,
  ].join('\n');
}
