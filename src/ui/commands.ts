export interface SlashCommand {
  name: string;
  usage?: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/help', description: 'show this help' },
  { name: '/model', usage: '[name | add | edit | remove | test | list]', description: 'list or switch models' },
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

/** Matches only while the user is still typing the command name, before any space. */
export function filterSlashCommands(query: string): SlashCommand[] {
  const text = query.trimStart();
  if (!text.startsWith('/') || /\s/.test(text)) return [];
  const needle = text.toLowerCase();
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(needle));
}

export function slashCommandLabel(command: SlashCommand): string {
  return command.usage ? `${command.name} ${command.usage}` : command.name;
}

export function slashHelpLines(): string[] {
  const labels = SLASH_COMMANDS.map((command) => `  ${slashCommandLabel(command)}`);
  const width = Math.max(...labels.map((label) => label.length)) + 2;
  return SLASH_COMMANDS.map(
    (command, index) => `${labels[index]!.padEnd(width)}${command.description}`,
  );
}
