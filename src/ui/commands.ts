import type { Skill } from '../agent/skills.js';

export interface SlashCommand {
  name: string;
  usage?: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/help', description: 'show this help' },
  { name: '/model', usage: '[name | add | edit | remove | test | list]', description: 'list or switch models' },
  { name: '/skills', description: 'list installed skills and where they were found' },
  { name: '/skill', usage: '<name> [request]', description: 'load a skill and apply it to your next request' },
  { name: '/context', description: 'show approximate context usage' },
  { name: '/usage', description: 'show or hide the usage card' },
  { name: '/compact', description: 'summarize older turns to free context' },
  { name: '/sessions', description: 'list saved sessions for this directory' },
  { name: '/resume', usage: '<n | id>', description: 'resume a saved session' },
  { name: '/undo', description: 'revert the last file change Kiro made (write/edit/patch)' },
  { name: '/clear', description: 'start a new session' },
  { name: '/export', usage: '[file]', description: 'write the transcript to a Markdown file' },
  { name: '/mouse', description: 'toggle mouse reporting (wheel scroll vs text selection)' },
  { name: '/allow', usage: '[clear]', description: 'manage tools that skip approval' },
  { name: '/exit', description: 'quit Kiro' },
];

/** A skill called `/model` would be unreachable, so built-in names are claimed. */
export function builtinCommandNames(): string[] {
  return SLASH_COMMANDS.map((command) => command.name.slice(1).toLowerCase());
}

function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Skills become slash commands: `/anti-slop rewrite this`. Built-ins win a clash. */
export function buildSkillCommands(
  skills: Skill[],
  reserved: string[] = builtinCommandNames(),
): SlashCommand[] {
  const taken = new Set(reserved);
  const seen = new Set<string>();
  const commands: SlashCommand[] = [];
  for (const skill of skills) {
    const key = skill.name.toLowerCase();
    if (taken.has(key) || seen.has(key)) continue;
    seen.add(key);
    commands.push({ name: `/${skill.name}`, description: `skill · ${shorten(skill.description, 60)}` });
  }
  return commands;
}

/** Matches only while the user is still typing the command name, before any space. */
export function filterSlashCommands(
  query: string,
  commands: SlashCommand[] = SLASH_COMMANDS,
): SlashCommand[] {
  const text = query.trimStart();
  if (!text.startsWith('/') || /\s/.test(text)) return [];
  const needle = text.toLowerCase();
  return commands.filter((command) => command.name.toLowerCase().startsWith(needle));
}

export function slashCommandLabel(command: SlashCommand): string {
  return command.usage ? `${command.name} ${command.usage}` : command.name;
}

export function slashHelpLines(skillCount = 0): string[] {
  const labels = SLASH_COMMANDS.map((command) => `  ${slashCommandLabel(command)}`);
  if (skillCount > 0) {
    labels.push(`  /<skill> [request]`);
  }
  const width = Math.max(...labels.map((label) => label.length)) + 2;
  const lines = SLASH_COMMANDS.map(
    (command, index) => `${labels[index]!.padEnd(width)}${command.description}`,
  );
  if (skillCount > 0) {
    lines.push(
      `${labels[labels.length - 1]!.padEnd(width)}run one of your ${skillCount} installed skill${skillCount === 1 ? '' : 's'}`,
    );
  }
  return lines;
}
