import { childEnv } from '../secrets.js';

/**
 * Builds the environment for a server process: Kiro's own credentials are
 * stripped by `childEnv`, then the server's configured variables are added.
 * A `${VAR}` value is read from Kiro's environment, so a token can live in
 * ~/.kiro/.env instead of config.json.
 */
export function expandVars(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, variable: string) => {
    return process.env[variable] ?? match;
  });
}

export function childEnvFor(extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const env = childEnv();
  for (const [name, value] of Object.entries(extra ?? {})) env[name] = expandVars(value);
  return env;
}

/** Header values can point at an environment variable, so a token stays out of the config file. */
export function expandHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) out[name] = expandVars(value);
  return out;
}
