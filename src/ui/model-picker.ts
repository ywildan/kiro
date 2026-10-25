import type { KiroConfig, ProfileConfig } from '../config.js';
import { groupProfiles } from './profile-list.js';

export type PickerRow =
  | { kind: 'header'; text: string }
  | { kind: 'profile'; name: string; model: string; active: boolean };

/** Display rows for the first picker step: endpoint headers plus one row per profile. */
export function profileRows(
  config: KiroConfig,
  activeName: string = config.activeProfile,
): PickerRow[] {
  return groupProfiles(config, activeName).flatMap((endpoint) => [
    { kind: 'header' as const, text: `${endpoint.baseUrl}  [${endpoint.type}]` },
    ...endpoint.entries.map((entry) => ({
      kind: 'profile' as const,
      name: entry.name,
      model: entry.model,
      active: entry.active,
    })),
  ]);
}

/** Profile names in display order, so an index maps to a selectable row. */
export function selectableNames(rows: PickerRow[]): string[] {
  return rows.flatMap((row) => (row.kind === 'profile' ? [row.name] : []));
}

/** Display index of the nth profile row, skipping headers. */
export function selectableLines(rows: PickerRow[]): number[] {
  return rows.flatMap((row, index) => (row.kind === 'profile' ? [index] : []));
}

/** The models a profile can switch between; a profile without a stored list has one. */
export function modelIds(profile: ProfileConfig | undefined): string[] {
  if (!profile) return [];
  const stored = profile.models ?? [];
  return stored.includes(profile.model) ? stored : [profile.model, ...stored];
}

/** Case-insensitive multi-term search: every whitespace-separated term must match. */
export function filterModelIds(ids: string[], query: string): string[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return ids;
  return ids.filter((id) => {
    const haystack = id.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/** Keeps the highlighted line inside a window of `maxRows` entries. */
export function pickerWindow(
  index: number,
  count: number,
  maxRows: number,
): { start: number; end: number } {
  if (count <= 0) return { start: 0, end: 0 };
  const size = Math.max(1, Math.min(maxRows, count));
  const start = Math.max(0, Math.min(index - Math.floor(size / 2), count - size));
  return { start, end: start + size };
}

/** Selects a stored model; the previous one stays in the list for switching back. */
export function withProfileModel(
  config: KiroConfig,
  name: string,
  model: string,
): KiroConfig {
  const profile = config.profiles[name];
  if (!profile) return config;
  const models = [...new Set([model, ...modelIds(profile)])];
  return {
    ...config,
    profiles: { ...config.profiles, [name]: { ...profile, model, models } },
  };
}

/** Replaces the stored list with what the endpoint just reported. */
export function withProfileModels(
  config: KiroConfig,
  name: string,
  models: string[],
): KiroConfig {
  const profile = config.profiles[name];
  if (!profile) return config;
  const unique = [...new Set([profile.model, ...models.map((id) => id.trim()).filter(Boolean)])];
  return {
    ...config,
    profiles: { ...config.profiles, [name]: { ...profile, models: unique } },
  };
}
