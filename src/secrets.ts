/**
 * Registry of credential material that must never reach the model, the TUI
 * transcript, or a saved session. Kiro loads API keys into `process.env`, so
 * without this a single `run_command env` would print them into the context.
 */

const SECRET_NAME_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;
const MIN_VALUE_LENGTH = 8;

const secretValues = new Set<string>();
const hiddenEnvNames = new Set<string>();

function isSecretishName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name);
}

/** Registers a literal value for redaction. Short values are skipped to avoid mangling ordinary output. */
export function registerSecretValue(value: string): void {
  const trimmed = value.trim();
  if (trimmed.length < MIN_VALUE_LENGTH) return;
  secretValues.add(trimmed);
}

/**
 * Registers an environment variable that holds a credential. The name is hidden
 * from spawned commands and the value is redacted from tool output.
 */
export function registerSecretEnv(name: string, value: string | undefined, force = false): void {
  if (!name) return;
  const credential = force || isSecretishName(name);
  if (!credential) return;
  hiddenEnvNames.add(name.toUpperCase());
  if (value) registerSecretValue(value);
}

export function redactSecrets(text: string): string {
  if (secretValues.size === 0 || !text) return text;
  let output = text;
  for (const value of secretValues) {
    if (output.includes(value)) output = output.split(value).join('[REDACTED]');
  }
  return output;
}

/** A copy of the environment without registered credential variables. */
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (hiddenEnvNames.size === 0) return base;
  const copy: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (hiddenEnvNames.has(name.toUpperCase())) continue;
    copy[name] = value;
  }
  return copy;
}

export function registeredSecretCount(): number {
  return secretValues.size;
}

export function clearSecrets(): void {
  secretValues.clear();
  hiddenEnvNames.clear();
}
