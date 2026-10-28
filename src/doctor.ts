import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';

import {
  configPath,
  ConfigError,
  loadConfig,
  type KiroConfig,
  type ProfileConfig,
} from './config.js';
import { envPath, keyStatus, loadEnvFile } from './env.js';
import { discoverModels, testConnection } from './model/discovery.js';
import { redactSecrets, registerSecretEnv } from './secrets.js';
import { formatDuration } from './ui/text.js';
import { VERSION } from './version.js';

const DOCTOR_HELP = `Kiro doctor

Usage:
  kiro doctor [options]

Checks the Node version, config file, where the key is stored, and the active
endpoint. Prints one line per check and exits 1 when a check fails.

Options:
  --profile <name>   inspect a profile other than the active one
  --offline          skip the network checks
  --test             send a small chat completion to verify the key and model
  -h, --help         show this help
`;

type Level = 'ok' | 'warn' | 'fail' | 'skip';

interface Check {
  level: Level;
  text: string;
  hint?: string;
}

interface DoctorOptions {
  profile?: string;
  offline: boolean;
  test: boolean;
  help: boolean;
}

class DoctorUsageError extends Error {}

function parseOptions(argv: string[]): DoctorOptions {
  const options: DoctorOptions = { offline: false, test: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }
    if (arg === '--offline') {
      options.offline = true;
      continue;
    }
    if (arg === '--test') {
      options.test = true;
      continue;
    }
    if (arg === '--profile' || arg.startsWith('--profile=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++index];
      if (!value) throw new DoctorUsageError('Option --profile requires a value.');
      options.profile = value;
      continue;
    }
    throw new DoctorUsageError(`Unknown option: ${arg}`);
  }
  return options;
}

function nodeCheck(): Check {
  const major = Number(process.versions.node.split('.')[0]);
  const text = `Node v${process.versions.node} (requires >= 20)`;
  return major >= 20
    ? { level: 'ok', text }
    : {
        level: 'fail',
        text,
        hint: 'Upgrade Node to 20 or newer, then run kiro again.',
      };
}

async function configChecks(profileName: string | undefined): Promise<{
  checks: Check[];
  profile?: ProfileConfig;
  apiKey?: string;
}> {
  const file = configPath();
  if (!existsSync(file)) {
    return {
      checks: [
        {
          level: 'fail',
          text: `Config ${file} does not exist`,
          hint: 'Run "kiro model" to create a profile.',
        },
      ],
    };
  }

  let config: KiroConfig;
  try {
    ({ config } = await loadConfig());
  } catch (error) {
    return {
      checks: [
        {
          level: 'fail',
          text: `Config ${file} is invalid`,
          hint: error instanceof ConfigError ? error.message : String(error),
        },
      ],
    };
  }

  const checks: Check[] = [{ level: 'ok', text: `Config ${file}` }];
  const name = profileName ?? config.activeProfile;
  const profile = config.profiles[name];
  if (!profile) {
    checks.push({
      level: 'fail',
      text: `Profile "${name}" is not configured`,
      hint: `Available profiles: ${Object.keys(config.profiles).join(', ')}.`,
    });
    return { checks };
  }

  checks.push({
    level: 'ok',
    text: `Profile ${name}: ${profile.model} @ ${profile.baseUrl}`,
  });

  const status = keyStatus(profile);
  if (profile.apiKeyEnv && !process.env[profile.apiKeyEnv]) {
    checks.push({
      level: 'fail',
      text: `Key ${status}`,
      hint: `Store it with "kiro model" (Edit a model) or export ${profile.apiKeyEnv}=...`,
    });
  } else {
    checks.push({ level: 'ok', text: `Key ${status}` });
  }

  const apiKey = profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined;
  if (profile.apiKeyEnv) registerSecretEnv(profile.apiKeyEnv, apiKey, true);
  return { checks, profile, apiKey };
}

async function envCheck(): Promise<Check> {
  const file = envPath();
  let missing = false;
  try {
    const result = await loadEnvFile();
    missing = result.missing;
  } catch (error) {
    return {
      level: 'fail',
      text: `Key file ${file} could not be read`,
      hint: (error as Error).message,
    };
  }

  if (missing) {
    return {
      level: 'warn',
      text: `Key file ${file} does not exist`,
      hint: 'Keys can still come from the environment. Run "kiro model" to store one.',
    };
  }

  if (process.platform !== 'win32') {
    try {
      const mode = (await stat(file)).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        return {
          level: 'warn',
          text: `Key file ${file} is readable by other users (mode ${mode.toString(8)})`,
          hint: `Run: chmod 600 ${file}`,
        };
      }
    } catch (error) {
      return {
        level: 'fail',
        text: `Key file ${file} could not be inspected`,
        hint: (error as Error).message,
      };
    }
  }

  return { level: 'ok', text: `Key file ${file}` };
}

async function networkChecks(
  profile: ProfileConfig,
  apiKey: string | undefined,
  test: boolean,
): Promise<Check[]> {
  const checks: Check[] = [];
  const started = performance.now();
  const result = await discoverModels({
    baseUrl: profile.baseUrl,
    apiKey,
    timeoutMs: 5000,
  });
  const latency = formatDuration(Math.max(0, Math.round(performance.now() - started)));

  if (!result.ok) {
    const transient = result.status === 404 || result.status === 429;
    checks.push({
      level: transient ? 'warn' : 'fail',
      text: redactSecrets(result.message),
      hint:
        result.status === 404
          ? 'Some servers do not implement GET /models. The profile can still work.'
          : undefined,
    });
    return checks;
  }

  checks.push({
    level: 'ok',
    text: `GET ${result.url} returned ${result.models.length} model${result.models.length === 1 ? '' : 's'} in ${latency}`,
  });
  if (!result.models.includes(profile.model)) {
    checks.push({
      level: 'warn',
      text: `Model "${profile.model}" is not in the endpoint's list`,
      hint: 'Check the model id; some servers hide models from /models.',
    });
  }

  if (test) {
    const tested = await testConnection(profile, apiKey);
    checks.push({
      level: tested.ok ? 'ok' : 'fail',
      text: redactSecrets(tested.message),
    });
  }
  return checks;
}

function printChecks(checks: Check[]): void {
  for (const check of checks) {
    process.stdout.write(`${check.level.padEnd(4)}  ${redactSecrets(check.text)}\n`);
    if (check.hint) {
      process.stdout.write(`      ${redactSecrets(check.hint)}\n`);
    }
  }
}

export async function runDoctor(argv: string[]): Promise<number> {
  let options: DoctorOptions;
  try {
    options = parseOptions(argv);
  } catch (error) {
    if (error instanceof DoctorUsageError) {
      console.error(`Kiro doctor: ${error.message}`);
      console.error('Run "kiro doctor --help" for usage.');
      return 2;
    }
    throw error;
  }

  if (options.help) {
    process.stdout.write(DOCTOR_HELP);
    return 0;
  }
  if (options.offline && options.test) {
    console.error('Kiro doctor: --test needs the network; drop --offline or --test.');
    return 2;
  }

  const checks: Check[] = [nodeCheck()];
  const keyFile = await envCheck();
  const configResult = await configChecks(options.profile);
  checks.push(...configResult.checks);
  if (configResult.profile) checks.push(keyFile);

  if (configResult.profile) {
    if (options.offline) {
      checks.push({ level: 'skip', text: 'Network checks skipped (--offline)' });
    } else {
      checks.push(...(await networkChecks(configResult.profile, configResult.apiKey, options.test)));
    }
  }

  process.stdout.write(`Kiro ${VERSION} doctor\n\n`);
  printChecks(checks);

  return checks.some((check) => check.level === 'fail') ? 1 : 0;
}
