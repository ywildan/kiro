import type { KiroConfig } from '../config.js';

interface Entry {
  name: string;
  model: string;
  active: boolean;
}

interface Endpoint {
  type: string;
  baseUrl: string;
  entries: Entry[];
}

/**
 * Lists profiles grouped by endpoint, so several models behind one base URL read
 * as siblings instead of looking like separate providers.
 */
export function formatProfileList(config: KiroConfig): string[] {
  const endpoints = new Map<string, Endpoint>();
  for (const [name, profile] of Object.entries(config.profiles)) {
    const key = `${profile.type}\u0000${profile.baseUrl}`;
    const endpoint = endpoints.get(key) ?? {
      type: profile.type,
      baseUrl: profile.baseUrl,
      entries: [],
    };
    endpoint.entries.push({
      name,
      model: profile.model,
      active: name === config.activeProfile,
    });
    endpoints.set(key, endpoint);
  }

  const total = Object.keys(config.profiles).length;
  const count = endpoints.size;
  const heading =
    count > 1
      ? `Profiles (${total} profile${total === 1 ? '' : 's'} across ${count} endpoints):`
      : `Profiles (${total}):`;

  const lines = [heading];
  for (const endpoint of endpoints.values()) {
    lines.push(`  ${endpoint.baseUrl}  [${endpoint.type}]`);
    for (const entry of endpoint.entries) {
      lines.push(`${entry.active ? '  * ' : '    '}${entry.name}  ${entry.model}`);
    }
  }
  return lines;
}
