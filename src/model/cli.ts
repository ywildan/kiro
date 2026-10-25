import {
  configPath,
  loadConfig,
  normalizeBaseUrl,
  recoverConfig,
  saveConfig,
  validateProfileName,
  ConfigError,
  type KiroConfig,
  type ProfileConfig,
} from '../config.js';
import {
  defaultKeyEnv,
  envPath,
  keyStatus,
  loadEnvFile,
  validateEnvName,
  writeEnvValue,
  EnvError,
} from '../env.js';
import { testConnection } from './discovery.js';
import { CliModelUi, closeModelUi, ModelCliError } from './cli-ui.js';
import { runAddFlow, runModelMenu, type WizardContext } from './wizard.js';

const MODEL_HELP = `Kiro model management

Usage:
  kiro model                         interactive model workflow
  kiro model add [options]           add a profile (opens the wizard without flags)
  kiro model list                    list profiles and the active one
  kiro model use <name>              make a profile active
  kiro model remove <name>           remove a profile
  kiro model test [name]             test a profile's endpoint and key

Add options:
  --name <name>         profile name (required)
  --base-url <url>      OpenAI-compatible base URL (required)
  --model <id>          model id (required)
  --api-key-env <VAR>   environment variable holding the API key
  --api-key <key>       store a new key in ~/.kiro/.env (never in config.json)
  --temperature <n>     sampling temperature (default 0.2)
  --max-tokens <n>      response limit (default 4096)
  --set-active          make the new profile active
  --no-test             skip the connection test
  -h, --help            show this help

Flags accept "--flag value" and "--flag=value".
Keys live in ${envPath()} (mode 0600); config.json only stores the variable name.
`;

interface FlagSpec {
  value: Set<string>;
  boolean: Set<string>;
}

interface ParsedFlags {
  values: Map<string, string>;
  booleans: Set<string>;
  positionals: string[];
  help: boolean;
}

function parseFlags(argv: string[], spec: FlagSpec): ParsedFlags {
  const parsed: ParsedFlags = {
    values: new Map(),
    booleans: new Set(),
    positionals: [],
    help: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '-h' || arg === '--help') {
      parsed.help = true;
      continue;
    }
    if (arg === '--') {
      parsed.positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith('-')) {
      parsed.positionals.push(arg);
      continue;
    }
    const equals = arg.indexOf('=');
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    if (spec.boolean.has(flag)) {
      if (equals !== -1) throw new ModelCliError(`Option ${flag} does not take a value.`, 2);
      parsed.booleans.add(flag);
      continue;
    }
    if (!spec.value.has(flag)) throw new ModelCliError(`Unknown option: ${flag}`, 2);
    let value: string | undefined;
    if (equals !== -1) {
      value = arg.slice(equals + 1);
    } else {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('-')) {
        value = next;
        index++;
      }
    }
    if (!value) throw new ModelCliError(`Option ${flag} requires a value.`, 2);
    parsed.values.set(flag, value);
  }
  return parsed;
}

function usageError(message: string): never {
  throw new ModelCliError(`${message}\nRun "kiro model --help" for usage.`, 2);
}

function requireValue(parsed: ParsedFlags, flag: string): string {
  const value = parsed.values.get(flag);
  if (!value) usageError(`Missing required option ${flag}.`);
  return value;
}

function parseTemperature(value: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 2) {
    throw new ModelCliError('--temperature must be a number between 0 and 2.', 2);
  }
  return number;
}

function parseMaxTokens(value: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new ModelCliError('--max-tokens must be a positive whole number.', 2);
  }
  return number;
}

async function loadConfigForCommand(interactive: boolean): Promise<{
  config: KiroConfig;
  path: string;
}> {
  try {
    const loaded = await loadConfig();
    return { config: loaded.config, path: loaded.path };
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    if (!interactive) {
      throw new ModelCliError(
        `${error.message}\nRun "kiro model" in a terminal to back up and recreate the config.`,
        1,
      );
    }
    const ui = new CliModelUi();
    ui.note('error', `Kiro cannot read its config: ${error.message}`);
    const confirmed = await ui.confirm(
      `Back up ${configPath()} and create a fresh template?`,
      false,
    );
    if (!confirmed) throw new ModelCliError('No changes were made.', 1);
    const backup = await recoverConfig();
    const loaded = await loadConfig();
    ui.note(
      'info',
      backup ? `Backed up the old config to ${backup}.` : 'Created a fresh config template.',
    );
    return { config: loaded.config, path: loaded.path };
  }
}

function printProfile(key: string, profile: ProfileConfig, active: boolean): void {
  const marker = active ? '*' : ' ';
  console.log(
    `${marker} ${key}  ${profile.model}  ${profile.baseUrl}  (${keyStatus(profile)})`,
  );
}

async function runWizard(): Promise<number> {
  const ui = new CliModelUi();
  const loaded = await loadConfigForCommand(true);
  const ctx: WizardContext = {
    ui,
    config: loaded.config,
    async save(next) {
      await saveConfig(next, { path: loaded.path });
    },
  };
  await runModelMenu(ctx);
  return 0;
}

async function runAdd(argv: string[]): Promise<number> {
  const spec: FlagSpec = {
    value: new Set([
      '--name',
      '--base-url',
      '--model',
      '--api-key-env',
      '--api-key',
      '--temperature',
      '--max-tokens',
    ]),
    boolean: new Set(['--set-active', '--no-test']),
  };
  const parsed = parseFlags(argv, spec);
  if (parsed.help) {
    process.stdout.write(MODEL_HELP);
    return 0;
  }
  if (parsed.positionals.length > 0) {
    usageError(`Unexpected argument: ${parsed.positionals[0]}`);
  }
  if (parsed.values.size === 0 && parsed.booleans.size === 0) {
    const loaded = await loadConfigForCommand(true);
    const ui = new CliModelUi();
    const ctx: WizardContext = {
      ui,
      config: loaded.config,
      async save(next) {
        await saveConfig(next, { path: loaded.path });
      },
    };
    await runAddFlow(ctx);
    return 0;
  }

  const name = validateProfileName(requireValue(parsed, '--name'));
  const baseUrl = normalizeBaseUrl(requireValue(parsed, '--base-url'));
  const model = requireValue(parsed, '--model').trim();
  if (!model) usageError('--model cannot be empty.');
  const temperature = parsed.values.has('--temperature')
    ? parseTemperature(parsed.values.get('--temperature')!)
    : 0.2;
  const maxTokens = parsed.values.has('--max-tokens')
    ? parseMaxTokens(parsed.values.get('--max-tokens')!)
    : 4096;

  let envName = parsed.values.get('--api-key-env');
  if (envName) envName = validateEnvName(envName);
  const keyValue = parsed.values.get('--api-key');
  if (keyValue && !keyValue.trim()) usageError('--api-key cannot be empty.');
  if (keyValue && !envName) envName = defaultKeyEnv(name);

  const loaded = await loadConfigForCommand(false);
  if (loaded.config.profiles[name]) {
    throw new ModelCliError(
      `Profile "${name}" already exists. Run "kiro model" and choose "Edit a model", or pick another name.`,
      1,
    );
  }

  const profile: ProfileConfig = {
    type: 'openai',
    baseUrl,
    apiKeyEnv: envName,
    model,
    temperature,
    maxTokens,
  };

  if (envName && !keyValue && !process.env[envName]) {
    console.error(
      `Kiro: warning: $${envName} is not set. The connection test will fail; ` +
        'set it or pass --api-key to store one.',
    );
  }

  if (!parsed.booleans.has('--no-test')) {
    const result = await testConnection(profile, keyValue ?? (envName ? process.env[envName] : undefined));
    if (!result.ok) {
      throw new ModelCliError(
        `Connection test failed:\n  ${result.message}\n` +
          'Nothing was saved. Re-run with --no-test to save this profile anyway.',
        1,
      );
    }
    console.log(result.message);
  }

  let storedKey = false;
  if (keyValue) {
    await writeEnvValue(envName!, keyValue);
    storedKey = true;
  }

  const activeProfile = parsed.booleans.has('--set-active') ? name : loaded.config.activeProfile;
  const next: KiroConfig = {
    activeProfile,
    profiles: { ...loaded.config.profiles, [name]: profile },
  };
  await saveConfig(next, { path: loaded.path });

  console.log(`Saved profile "${name}" (${model} @ ${baseUrl}).`);
  if (envName) {
    const status = process.env[envName] ? 'set' : 'missing';
    console.log(
      storedKey
        ? `API key stored in ${envPath()} as $${envName} (mode 0600).`
        : `API key via $${envName} (${status}); no key was written by Kiro.`,
    );
  } else {
    console.log('No API key configured for this profile.');
  }
  if (activeProfile === name) console.log(`Active profile: ${name}`);
  else console.log(`Active profile remains "${activeProfile}". Use "kiro model use ${name}" to switch.`);
  return 0;
}

async function runList(argv: string[]): Promise<number> {
  const parsed = parseFlags(argv, { value: new Set(), boolean: new Set() });
  if (parsed.help) {
    process.stdout.write(MODEL_HELP);
    return 0;
  }
  if (parsed.positionals.length > 0) usageError(`Unexpected argument: ${parsed.positionals[0]}`);
  await loadEnvFile();
  const loaded = await loadConfigForCommand(false);
  console.log(`Profiles in ${loaded.path}:`);
  for (const [name, profile] of Object.entries(loaded.config.profiles)) {
    printProfile(name, profile, name === loaded.config.activeProfile);
  }
  return 0;
}

async function runUse(argv: string[]): Promise<number> {
  const parsed = parseFlags(argv, { value: new Set(), boolean: new Set() });
  if (parsed.help) {
    process.stdout.write(MODEL_HELP);
    return 0;
  }
  const name = parsed.positionals[0];
  if (!name) usageError('Usage: kiro model use <name>');
  if (parsed.positionals.length > 1) usageError(`Unexpected argument: ${parsed.positionals[1]}`);
  const loaded = await loadConfigForCommand(false);
  const profile = loaded.config.profiles[name];
  if (!profile) {
    throw new ModelCliError(
      `Unknown profile "${name}". Available profiles: ${Object.keys(loaded.config.profiles).join(', ')}.`,
      1,
    );
  }
  await saveConfig({ ...loaded.config, activeProfile: name }, { path: loaded.path });
  console.log(`Active profile is now "${name}" (${profile.model} @ ${profile.baseUrl}).`);
  return 0;
}

async function runRemove(argv: string[]): Promise<number> {
  const parsed = parseFlags(argv, { value: new Set(), boolean: new Set() });
  if (parsed.help) {
    process.stdout.write(MODEL_HELP);
    return 0;
  }
  const name = parsed.positionals[0];
  if (!name) usageError('Usage: kiro model remove <name>');
  if (parsed.positionals.length > 1) usageError(`Unexpected argument: ${parsed.positionals[1]}`);
  const loaded = await loadConfigForCommand(false);
  const profile = loaded.config.profiles[name];
  if (!profile) {
    throw new ModelCliError(
      `Unknown profile "${name}". Available profiles: ${Object.keys(loaded.config.profiles).join(', ')}.`,
      1,
    );
  }
  if (Object.keys(loaded.config.profiles).length <= 1) {
    throw new ModelCliError(
      `Cannot remove "${name}": it is the only profile. Add another model first.`,
      1,
    );
  }
  const profiles = { ...loaded.config.profiles };
  delete profiles[name];
  let activeProfile = loaded.config.activeProfile;
  if (activeProfile === name) {
    activeProfile = Object.keys(profiles)[0]!;
    console.log(`Profile "${name}" was active; switched to "${activeProfile}".`);
  }
  await saveConfig({ activeProfile, profiles }, { path: loaded.path });
  console.log(
    `Removed profile "${name}". Its key (if any) remains in ${envPath()} so another profile can reuse it.`,
  );
  return 0;
}

async function runTest(argv: string[]): Promise<number> {
  const parsed = parseFlags(argv, { value: new Set(), boolean: new Set() });
  if (parsed.help) {
    process.stdout.write(MODEL_HELP);
    return 0;
  }
  if (parsed.positionals.length > 1) usageError(`Unexpected argument: ${parsed.positionals[1]}`);
  const loaded = await loadConfigForCommand(false);
  const name = parsed.positionals[0] ?? loaded.config.activeProfile;
  const profile = loaded.config.profiles[name];
  if (!profile) {
    throw new ModelCliError(
      `Unknown profile "${name}". Available profiles: ${Object.keys(loaded.config.profiles).join(', ')}.`,
      1,
    );
  }
  const key = profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined;
  if (profile.apiKeyEnv && !key) {
    console.error(
      `API key is missing: $${profile.apiKeyEnv} is not set for profile "${name}".\n` +
        `Store it with "kiro model" (choose "Edit a model") or export it for this shell.`,
    );
    return 1;
  }
  console.log(`Testing ${profile.baseUrl} with model "${profile.model}"…`);
  const result = await testConnection(profile, key);
  if (result.ok) {
    console.log(result.message);
    return 0;
  }
  console.error(`Connection test failed: ${result.message}`);
  return 1;
}

export async function runModelCli(argv: string[]): Promise<number> {
  try {
    await loadEnvFile();
    const command = argv[0];
    if (!command) return await runWizard();
    if (command === '-h' || command === '--help' || command === 'help') {
      process.stdout.write(MODEL_HELP);
      return 0;
    }
    switch (command) {
      case 'add':
        return await runAdd(argv.slice(1));
      case 'list':
        return await runList(argv.slice(1));
      case 'use':
        return await runUse(argv.slice(1));
      case 'remove':
        return await runRemove(argv.slice(1));
      case 'test':
        return await runTest(argv.slice(1));
      default:
        throw new ModelCliError(`Unknown model command "${command}".\n${MODEL_HELP}`, 2);
    }
  } catch (error) {
    if (error instanceof ModelCliError) {
      console.error(`Kiro: ${error.message}`);
      return error.exitCode;
    }
    if (error instanceof ConfigError || error instanceof EnvError) {
      console.error(`Kiro: ${error.message}`);
      return 1;
    }
    console.error(`Kiro: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    // Always give the terminal back, even when the wizard throws or is cancelled.
    closeModelUi();
  }
}
