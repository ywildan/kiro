#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import {
  applyOverrides,
  configPath,
  ConfigError,
  loadConfig,
  recoverConfig,
  type CliOverrides,
  type LoadedConfig,
} from './config.js';
import { loadEnvFile } from './env.js';
import { runModelCli } from './model/cli.js';
import { readLine } from './model/cli-ui.js';
import { runHeadless } from './headless.js';
import { registerSecretEnv } from './secrets.js';
import { latestSession, loadSession, type SessionRecord } from './sessions.js';
import { MOUSE_OFF } from './ui/mouse.js';
import { App, type StartupNotice } from './ui/App.js';
import { runCheck, runUpdate } from './update.js';
import { VERSION } from './version.js';

interface CliOptions {
  profile?: string;
  baseUrl?: string;
  model?: string;
  continueSession: boolean;
  resume?: string;
  prompt?: string;
  yolo: boolean;
  mouse: boolean;
  altScreen: boolean;
  help: boolean;
  version: boolean;
}

const HELP = `Kiro — a small terminal coding agent

Usage: kiro [options]
       kiro model [command]

Options:
  --profile <name>   Use a profile from ~/.kiro/config.json
  --base-url <url>   Override the active profile's OpenAI-compatible base URL
  --model <name>     Override the active profile's model name
  -c, --continue     Resume the most recent session for this directory
  --resume <id>      Resume a specific saved session
  -p, --prompt <text>
                     Run one turn without a TUI ("-" or no text reads the
                     prompt from stdin); replies stream to stdout, notices
                     and reasoning to stderr
  --yolo             Skip all approval prompts (use with care)
  --mouse            Mouse reporting is on by default: the wheel scrolls the
                     transcript, Shift+drag selects text for copying.
  --no-mouse         Disable mouse reporting so plain click-drag selection works.
  --no-alt-screen    Do not switch to the terminal's alternate screen
  -h, --help         Show this help
  -v, --version      Show the version

Model commands:
  kiro model         Interactive wizard: select, add, edit, or remove models
  kiro model list    List configured profiles
  kiro model add ... Add a profile without prompts (see "kiro model --help")
  kiro model use <n> Make a profile active
  kiro model remove <n>
  kiro model test [n]

Update commands:
  kiro check         Compare the installed version with the latest on npm
  kiro update        Install the latest version from npm globally

Config: ~/.kiro/config.json (created with a template on first run)
Keys: ~/.kiro/.env (mode 0600), or the environment variable named by "apiKeyEnv".
Sessions: ~/.kiro/sessions (one directory per working directory)
`;

const ENTER_ALT_SCREEN = '\x1b[?1049h\x1b[H\x1b[2J';
const LEAVE_ALT_SCREEN = '\x1b[?1049l';

/**
 * Opens a clean alternate screen and returns an idempotent restore function.
 * The terminal brings the previous shell contents back when we leave it.
 * Mouse reporting belongs to the App so /mouse can toggle it at runtime.
 */
function enterAlternateScreen(enabled: boolean): () => void {
  if (!enabled || !process.stdout.isTTY) return () => {};
  let active = true;
  const leave = (): void => {
    if (!active) return;
    active = false;
    process.stdout.write(`${MOUSE_OFF}${LEAVE_ALT_SCREEN}`);
  };
  process.once('exit', leave);
  for (const signal of ['SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => {
      leave();
      process.kill(process.pid, signal);
    });
  }
  process.stdout.write(ENTER_ALT_SCREEN);
  return leave;
}

class UsageError extends Error {}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    continueSession: false,
    yolo: false,
    mouse: true,
    altScreen: true,
    help: false,
    version: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }
    if (arg === '-v' || arg === '--version') {
      options.version = true;
      continue;
    }
    if (arg === '-c' || arg === '--continue') {
      options.continueSession = true;
      continue;
    }
    if (arg === '--yolo') {
      options.yolo = true;
      continue;
    }
    if (arg === '--mouse') {
      options.mouse = true;
      continue;
    }
    if (arg === '--no-mouse') {
      options.mouse = false;
      continue;
    }
    if (arg === '--no-alt-screen') {
      options.altScreen = false;
      continue;
    }
    const equals = arg.indexOf('=');
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    if (
      flag === '--profile' ||
      flag === '--base-url' ||
      flag === '--model' ||
      flag === '--resume' ||
      flag === '--prompt' ||
      flag === '-p'
    ) {
      const isPrompt = flag === '--prompt' || flag === '-p';
      let value: string | undefined;
      if (equals !== -1) {
        value = arg.slice(equals + 1);
      } else {
        const next = argv[index + 1];
        if (next !== undefined && (!next.startsWith('-') || (isPrompt && next === '-'))) {
          value = next;
          index++;
        }
      }
      if (isPrompt) {
        // Bare -p, -p with an empty value, and -p - all read the prompt from stdin.
        options.prompt = value === undefined || value === '' || value === '-' ? '' : value;
        continue;
      }
      if (value === undefined || value === '') {
        throw new UsageError(`Option ${flag} requires a value.`);
      }
      if (flag === '--profile') options.profile = value;
      else if (flag === '--base-url') options.baseUrl = value;
      else if (flag === '--model') options.model = value;
      else options.resume = value;
      continue;
    }
    throw new UsageError(`Unknown argument: ${arg}`);
  }
  return options;
}

async function loadConfigWithRecovery(): Promise<{ loaded: LoadedConfig; backup: string | null }> {
  try {
    return { loaded: await loadConfig(), backup: null };
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw error;
    console.error(`Kiro config error: ${error.message}`);
    const answer = await readLine(
      `Back up ${configPath()} and create a fresh template? [y/N]: `,
    );
    if (!answer || !/^y(es)?$/i.test(answer.trim())) {
      throw new ConfigError('No changes were made. Fix the config file and try again.');
    }
    const backup = await recoverConfig();
    return { loaded: await loadConfig(), backup };
  }
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] === 'model') {
    process.exitCode = await runModelCli(rawArgs.slice(1));
    return;
  }
  if (rawArgs[0] === 'check') {
    process.exitCode = await runCheck();
    return;
  }
  if (rawArgs[0] === 'update') {
    process.exitCode = await runUpdate();
    return;
  }

  let options: CliOptions;
  try {
    options = parseArgs(rawArgs);
  } catch (error) {
    console.error(`Kiro: ${(error as Error).message}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  if (options.version) {
    process.stdout.write(`Kiro ${VERSION}\n`);
    return;
  }
  const headless = options.prompt !== undefined;
  if (!headless && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    console.error('Kiro needs an interactive terminal (stdin and stdout must be TTYs).');
    console.error('For scripts and CI, run one turn with: kiro -p "your prompt"');
    process.exitCode = 2;
    return;
  }
  if (options.baseUrl) {
    let parsed: URL;
    try {
      parsed = new URL(options.baseUrl);
    } catch {
      console.error(`Kiro: invalid --base-url "${options.baseUrl}".`);
      process.exitCode = 2;
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      console.error('Kiro: --base-url must start with http:// or https://.');
      process.exitCode = 2;
      return;
    }
  }

  await loadEnvFile();
  const { loaded, backup } = await loadConfigWithRecovery();
  const overrides: CliOverrides = {
    profile: options.profile,
    baseUrl: options.baseUrl,
    model: options.model,
  };
  const baseConfig = loaded.config;
  const config = applyOverrides(baseConfig, overrides);
  for (const profile of Object.values(config.profiles)) {
    if (profile.apiKeyEnv) {
      registerSecretEnv(profile.apiKeyEnv, process.env[profile.apiKeyEnv], true);
    }
  }

  if (headless) {
    if (options.resume && options.continueSession) {
      console.error('Kiro: both --resume and --continue were given with -p; --resume wins.');
    }
    const controller = new AbortController();
    const onInterrupt = (): void => controller.abort();
    process.once('SIGINT', onInterrupt);
    try {
      process.exitCode = await runHeadless({
        config,
        cwd: process.cwd(),
        // An empty -p value means "read the prompt from stdin".
        prompt: options.prompt || undefined,
        yolo: options.yolo,
        resumeId: options.resume,
        continueLatest: !options.resume && options.continueSession,
        signal: controller.signal,
      });
    } finally {
      process.off('SIGINT', onInterrupt);
    }
    return;
  }

  let initialSession: SessionRecord | null = null;
  const startupNotices: StartupNotice[] = [];
  if (options.resume && options.continueSession) {
    startupNotices.push({
      level: 'info',
      text: 'Both --resume and --continue were given; resuming the requested session.',
    });
  }
  if (backup) {
    startupNotices.push({
      level: 'info',
      text: `The previous config was unreadable and was backed up to ${backup}; a fresh template is now in use.`,
    });
  }
  if (options.resume) {
    try {
      initialSession = await loadSession(process.cwd(), options.resume);
    } catch (error) {
      console.error(`Kiro: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      return;
    }
  } else if (options.continueSession) {
    try {
      initialSession = await latestSession(process.cwd());
      if (!initialSession) {
        startupNotices.push({
          level: 'info',
          text: 'No saved session found for this directory; started a new one.',
        });
      }
    } catch (error) {
      startupNotices.push({
        level: 'error',
        text: `Could not read saved sessions: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const leaveScreen = enterAlternateScreen(options.altScreen);
  try {
    const instance = render(
      <App
        config={config}
        baseConfig={baseConfig}
        overrides={overrides}
        configPath={loaded.path}
        configCreated={loaded.created}
        cwd={process.cwd()}
        version={VERSION}
        yolo={options.yolo}
        mouseEnabled={options.mouse}
        initialSession={initialSession}
        startupNotices={startupNotices}
      />,
      { exitOnCtrlC: false, maxFps: 30 },
    );
    await instance.waitUntilExit();
  } finally {
    leaveScreen();
  }
  process.exit(0);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`Kiro config error: ${error.message}`);
  } else {
    console.error(`Kiro: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
});
