import { spawn } from 'node:child_process';
import { VERSION } from './version.js';

const PACKAGE_NAME = '@ywldan/kiro';

/** npm on Windows is npm.cmd; only .cmd/.bat need a shell when spawning. */
function npmCommand(): { command: string; shell: boolean } {
  if (process.platform === 'win32') return { command: 'npm.cmd', shell: true };
  return { command: 'npm', shell: false };
}

function runNpm(args: string[], capture: boolean): Promise<{ code: number; stdout: string }> {
  const { command, shell } = npmCommand();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell,
      windowsHide: true,
    });
    let stdout = '';
    if (capture && child.stdout) child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }));
  });
}

/** Compares dotted numeric versions; returns -1, 0 or 1. Non-numeric parts fall back to string compare. */
function compareVersions(a: string, b: string): number {
  if (a === b) return 0;
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  if (left.some(Number.isNaN) || right.some(Number.isNaN)) return a < b ? -1 : 1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const x = left[index] ?? 0;
    const y = right[index] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

async function latestVersion(): Promise<string> {
  const { code, stdout } = await runNpm(['view', PACKAGE_NAME, 'version'], true);
  const latest = stdout.trim().split(/\r?\n/).pop() ?? '';
  if (code !== 0 || !/^\d+\.\d+\.\d+/.test(latest)) {
    throw new Error('Could not read the latest version from the npm registry.');
  }
  return latest;
}

/** `kiro check` — compare the installed version with the registry. Exit 0 current, 1 update available, 2 check failed. */
export async function runCheck(): Promise<number> {
  let latest: string;
  try {
    latest = await latestVersion();
  } catch (error) {
    console.error(`Kiro ${VERSION} — version check failed: ${(error as Error).message}`);
    console.error('Check manually with: npm view @ywldan/kiro version');
    return 2;
  }
  if (compareVersions(VERSION, latest) >= 0) {
    process.stdout.write(`Kiro ${VERSION} — up to date\n`);
    return 0;
  }
  process.stdout.write(`Kiro ${VERSION} → ${latest} available. Run "kiro update" to upgrade.\n`);
  return 1;
}

/** `kiro update` — install the latest published version globally through npm. */
export async function runUpdate(): Promise<number> {
  let latest: string;
  try {
    latest = await latestVersion();
  } catch {
    latest = 'latest';
  }
  if (latest !== 'latest' && compareVersions(VERSION, latest) >= 0) {
    process.stdout.write(`Kiro ${VERSION} — already up to date, nothing to do\n`);
    return 0;
  }
  process.stdout.write(`Updating Kiro ${VERSION} → ${latest} via npm…\n`);
  const { command, shell } = npmCommand();
  const result = await runNpm(['install', '-g', `${PACKAGE_NAME}@latest`], false).catch((error) => {
    console.error(`Kiro: could not start "${command}": ${(error as Error).message}`);
    return { code: 2, stdout: '' };
  });
  if (result.code !== 0) {
    console.error(`Kiro: npm exited with code ${result.code}. Update manually with:`);
    console.error(`  ${command} install -g ${PACKAGE_NAME}@latest`);
    return result.code;
  }
  process.stdout.write(`Kiro updated to ${latest}. Restart kiro to use the new version.\n`);
  return 0;
}
