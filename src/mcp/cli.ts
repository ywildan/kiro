import { homedir } from 'node:os';
import path from 'node:path';

import { loadMcpConfig, mcpEntryProblem, removeMcpServer, saveMcpServer, type McpScope, type McpServerEntry } from './config.js';
import { setupMcp, formatMcpStatus } from './registry.js';

/**
 * `kiro mcp` exists so a server can be added without hand-editing JSON. The
 * flags mirror the config fields one to one, so anything the file can express
 * is still reachable, but the common cases are one line.
 */

export const MCP_HELP = `Kiro MCP servers

Usage:
  kiro mcp                        List configured servers and try to start them
  kiro mcp add <name> <command> [args...]
                                  Add a stdio server, e.g.
                                  kiro mcp add github npx -y @modelcontextprotocol/server-github
  kiro mcp add <name> --url <url> Add a streamable-HTTP server
  kiro mcp remove <name>          Remove a server from the config
  kiro mcp path                   Print the config files Kiro reads

Options for "add":
  --url <url>            Use streamable HTTP instead of a command
  --header "K: V"        Add a header to an HTTP server (repeatable)
  --env "K=V"            Add an environment variable (repeatable)
  --timeout <seconds>    Raise the limit for one tool call (a blocking tool needs this)
  --user                 Write to ~/.kiro/mcp.json instead of ./.kiro/mcp.json
  --force                Overwrite an existing server with the same name
  --print                Print the entry as JSON, write nothing

Examples:
  kiro mcp add agentrelay --url https://mcp.example.com/mcp \\
    --header "Authorization: Bearer \${AGENTRELAY_TOKEN}" --timeout 3600
  kiro mcp add fetch uvx mcp-server-fetch

Run "kiro mcp" with no arguments to see what is configured and whether it starts.`;

class McpUsageError extends Error {}

interface AddOptions {
  name: string;
  command?: string;
  args: string[];
  url?: string;
  headers: Record<string, string>;
  env: Record<string, string>;
  timeoutMs?: number;
  scope: McpScope;
  force: boolean;
  print: boolean;
}

function pair(raw: string, flag: string): [string, string] {
  const index = raw.indexOf('=');
  if (flag === '--header') {
    const colon = raw.indexOf(':');
    if (colon === -1) throw new McpUsageError(`${flag} needs "Name: value", got "${raw}".`);
    const name = raw.slice(0, colon).trim();
    const value = raw.slice(colon + 1).trim();
    if (!name) throw new McpUsageError(`${flag} needs a header name, got "${raw}".`);
    return [name, value];
  }
  if (index === -1) throw new McpUsageError(`${flag} needs "NAME=value", got "${raw}".`);
  const name = raw.slice(0, index).trim();
  if (!name) throw new McpUsageError(`${flag} needs a variable name, got "${raw}".`);
  return [name, raw.slice(index + 1)];
}

function parseTimeout(raw: string): number {
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new McpUsageError(`--timeout needs a positive number of seconds, got "${raw}".`);
  }
  return Math.round(seconds * 1000);
}

function parseAdd(argv: string[]): AddOptions {
  const options: AddOptions = {
    name: '',
    args: [],
    headers: {},
    env: {},
    scope: 'project',
    force: false,
    print: false,
  };
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined) throw new McpUsageError(`${arg} needs a value.`);
      index += 1;
      return next;
    };
    if (arg === '--url') options.url = value();
    else if (arg === '--header') {
      const [name, header] = pair(value(), '--header');
      options.headers[name] = header;
    } else if (arg === '--env') {
      const [name, envValue] = pair(value(), '--env');
      options.env[name] = envValue;
    } else if (arg === '--timeout') options.timeoutMs = parseTimeout(value());
    else if (arg === '--user') options.scope = 'user';
    else if (arg === '--force') options.force = true;
    else if (arg === '--print') options.print = true;
    else if (arg.startsWith('-')) throw new McpUsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  if (positional.length === 0) throw new McpUsageError('add needs a server name.');
  options.name = positional[0]!;
  const rest = positional.slice(1);
  if (options.url) {
    if (rest.length > 0) {
      throw new McpUsageError(`A server is either a command or --url, not both (extra: ${rest.join(' ')}).`);
    }
  } else {
    if (rest.length === 0) throw new McpUsageError('add needs a command, or --url for an HTTP server.');
    options.command = rest[0]!;
    options.args = rest.slice(1);
  }
  return options;
}

function buildEntry(options: AddOptions): McpServerEntry {
  return options.url
    ? {
        type: 'http',
        url: options.url,
        headers: Object.keys(options.headers).length > 0 ? options.headers : undefined,
        timeoutMs: options.timeoutMs,
      }
    : {
        type: 'stdio',
        command: options.command,
        args: options.args.length > 0 ? options.args : undefined,
        env: Object.keys(options.env).length > 0 ? options.env : undefined,
        timeoutMs: options.timeoutMs,
      };
}

async function addServer(options: AddOptions, cwd: string, home: string): Promise<number> {
  const entry = buildEntry(options);
  const problem = mcpEntryProblem(entry);
  if (problem) throw new McpUsageError(`That server is not usable: ${problem}.`);

  const config = await loadMcpConfig(cwd, home);
  const existing = config.servers[options.name];
  if (existing && !options.force && !options.print) {
    throw new McpUsageError(
      `"${options.name}" already exists. Pass --force to replace it, or pick another name.`,
    );
  }

  if (options.print) {
    process.stdout.write(`${JSON.stringify({ mcpServers: { [options.name]: entry } }, null, 2)}\n`);
    return 0;
  }

  const saved = await saveMcpServer({ cwd, home, scope: options.scope, name: options.name, entry });
  process.stdout.write(`${existing ? 'Replaced' : 'Added'} "${options.name}" in ${saved.path}\n`);
  if (saved.replacedBrokenFile) {
    process.stdout.write('The file was not valid JSON, so it was rewritten with only this server.\n');
  }

  // Try it right away: a config that cannot start is worth knowing now.
  const setup = await setupMcp(cwd, { home });
  try {
    const status = setup.statuses.find((entryStatus) => entryStatus.name === options.name);
    if (status?.state === 'ready') {
      process.stdout.write(`Started: ${status.tools} tool${status.tools === 1 ? '' : 's'} from ${status.detail ?? options.name}.\n`);
    } else {
      process.stderr.write(`Not started yet: ${status?.detail ?? 'unknown error'}\n`);
      process.stderr.write('The entry is saved. Fix the command or URL, then run "kiro mcp".\n');
      return 1;
    }
  } finally {
    await setup.close();
  }
  return 0;
}

async function removeServer(argv: string[], cwd: string, home: string): Promise<number> {
  const name = argv.find((arg) => !arg.startsWith('-'));
  if (!name) throw new McpUsageError('remove needs a server name.');
  const user = argv.includes('--user');
  const scopes: McpScope[] = user ? ['user'] : ['project', 'user'];
  for (const scope of scopes) {
    if (await removeMcpServer({ cwd, home, scope, name })) {
      process.stdout.write(`Removed "${name}" from ${scope === 'user' ? '~/.kiro/mcp.json' : '.kiro/mcp.json'}.\n`);
      return 0;
    }
  }
  process.stderr.write(`No server named "${name}" in ${user ? '~/.kiro/mcp.json' : 'the MCP config'}.\n`);
  return 1;
}

export async function runMcpCli(
  argv: string[],
  options: { cwd?: string; home?: string } = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  const [command, ...rest] = argv;

  try {
    if (command === '--help' || command === '-h' || command === 'help') {
      process.stdout.write(`${MCP_HELP}\n`);
      return 0;
    }
    if (command === 'add') return await addServer(parseAdd(rest), cwd, home);
    if (command === 'remove' || command === 'rm') return await removeServer(rest, cwd, home);
    if (command === 'path') {
      process.stdout.write(`${path.join(cwd, '.kiro', 'mcp.json')} (project)\n${path.join(home, '.kiro', 'mcp.json')} (user)\n`);
      return 0;
    }
    if (command !== undefined && command.startsWith('-')) {
      throw new McpUsageError(`Unknown option ${command}.`);
    }
    if (command !== undefined) throw new McpUsageError(`Unknown command "${command}".`);

    // No command: show the same view as /mcp inside the TUI.
    const setup = await setupMcp(cwd, { home, onNotice: (message) => process.stderr.write(`note: ${message}\n`) });
    try {
      for (const problem of setup.config.problems) process.stderr.write(`problem: ${problem}\n`);
      process.stdout.write(`${formatMcpStatus(setup, cwd)}\n`);
      return setup.statuses.some((status) => status.state === 'error') ? 1 : 0;
    } finally {
      await setup.close();
    }
  } catch (error) {
    if (error instanceof McpUsageError) {
      process.stderr.write(`Kiro mcp: ${error.message}\n\n${MCP_HELP}\n`);
      return 2;
    }
    process.stderr.write(`Kiro mcp: ${(error as Error).message}\n`);
    return 1;
  }
}
