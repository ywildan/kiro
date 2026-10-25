import type { KiroConfig } from '../config.js';

export interface ProfileEntry {
  name: string;
  model: string;
  active: boolean;
}

export interface EndpointGroup {
  type: string;
  baseUrl: string;
  entries: ProfileEntry[];
}

/**
 * Groups profiles by endpoint. Profiles are independent (one model each), so
 * several models behind one base URL end up as siblings here.
 */
export function groupProfiles(
  config: KiroConfig,
  activeName: string = config.activeProfile,
): EndpointGroup[] {
  const endpoints = new Map<string, EndpointGroup>();
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
      active: name === activeName,
    });
    endpoints.set(key, endpoint);
  }
  return [...endpoints.values()];
}

/** One-line summary used by `/model list` and `kiro model list`. */
export function formatProfileList(config: KiroConfig): string[] {
  const endpoints = groupProfiles(config);
  const total = Object.keys(config.profiles).length;
  const count = endpoints.length;
  const heading =
    count > 1
      ? `Profiles (${total} profile${total === 1 ? '' : 's'} across ${count} endpoints):`
      : `Profiles (${total}):`;

  const lines = [heading];
  for (const endpoint of endpoints) {
    lines.push(`  ${endpoint.baseUrl}  [${endpoint.type}]`);
    for (const entry of endpoint.entries) {
      lines.push(`${entry.active ? '  * ' : '    '}${entry.name}  ${entry.model}`);
    }
  }
  return lines;
}
