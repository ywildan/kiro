import type { ProfileConfig } from '../config.js';

/**
 * URL and header construction shared by the provider and model discovery, so a
 * profile with custom headers behaves the same in `/models`, the connection
 * test, and real turns.
 */

/** Strips trailing slashes and an optional query string from a base URL. */
function splitBase(baseUrl: string): { path: string; query: string } {
  const trimmed = baseUrl.trim();
  const hash = trimmed.indexOf('#');
  const withoutHash = hash === -1 ? trimmed : trimmed.slice(0, hash);
  const mark = withoutHash.indexOf('?');
  return {
    path: (mark === -1 ? withoutHash : withoutHash.slice(0, mark)).replace(/\/+$/, ''),
    query: mark === -1 ? '' : withoutHash.slice(mark),
  };
}

/**
 * Builds an endpoint under the base URL, keeping the base's own query string.
 * A base that already names the endpoint is returned unchanged.
 */
export function endpointUrl(baseUrl: string, suffix: string): string {
  const { path, query } = splitBase(baseUrl);
  const already = path.toLowerCase().endsWith(suffix.toLowerCase());
  return `${already ? path : `${path}/${suffix.replace(/^\/+/, '')}`}${query}`;
}

/** The chat completions endpoint for a profile's base URL. */
export function chatEndpoint(baseUrl: string): string {
  return endpointUrl(baseUrl, 'chat/completions');
}

/** Substitutes ${VAR} in a header value from the environment; leaves unknown names literal. */
export function expandHeaderValue(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
    const fromEnv = process.env[name];
    return fromEnv === undefined ? match : fromEnv;
  });
}

const RESERVED_HEADERS = new Set([
  'content-type',
  'content-length',
  'accept',
  'authorization',
  'host',
  'connection',
  'transfer-encoding',
]);

/**
 * Headers a profile adds to every request. Reserved headers are skipped: the
 * key belongs in `apiKeyEnv`, and the rest would break the request itself.
 * Values may reference `${VAR}` so a token can stay in the environment.
 */
export function profileHeaders(profile: ProfileConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(profile.headers ?? {})) {
    const name = rawName.trim();
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) continue;
    if (RESERVED_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = expandHeaderValue(rawValue);
  }
  return headers;
}

/** Authorization plus the profile's own headers, ready for fetch. */
export function requestHeaders(profile: ProfileConfig, apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { ...profileHeaders(profile) };
  if (apiKey && !Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}
