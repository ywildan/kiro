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

export const PICKER_POPUP_MIN_COLUMNS = 60;
export const PICKER_POPUP_MIN_ROWS = 18;
export const PICKER_POPUP_MAX_WIDTH = 76;
export const PICKER_POPUP_MAX_HEIGHT = 16;
/** Rows the inline picker reserves below the transcript. */
export const PICKER_INLINE_ROWS = 13;

export interface PickerPopupRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Centers a fixed picker frame over the app's content area, keeping the input
 * and status rows clear. Returns null when the terminal is too small to overlay.
 */
export function pickerPopupRect(columns: number, rows: number): PickerPopupRect | null {
  if (columns < PICKER_POPUP_MIN_COLUMNS || rows < PICKER_POPUP_MIN_ROWS) return null;
  const width = Math.min(PICKER_POPUP_MAX_WIDTH, columns - 8);
  const height = Math.min(PICKER_POPUP_MAX_HEIGHT, rows - 6);
  // The transcript takes rows - 5, then the input and status rows.
  const contentRows = rows - 3;
  return {
    top: Math.max(0, Math.floor((contentRows - height) / 2)),
    // The app root adds one column of horizontal padding.
    left: Math.max(0, Math.floor((columns - width) / 2) - 1),
    width,
    height,
  };
}

/** Room for the list once the frame chrome and any hint/error rows are drawn. */
export function pickerPopupRows(height: number, extraRows = 0): number {
  return Math.max(2, height - 6 - Math.max(0, extraRows));
}

export interface PickerRange {
  above: number;
  below: number;
  first: number;
  last: number;
  total: number;
}

/** Visible selectable window plus how many entries are hidden on each side. */
export function pickerRange(start: number, end: number, total: number): PickerRange {
  const from = Math.max(0, Math.min(start, total));
  const to = Math.max(from, Math.min(end, total));
  return {
    above: from,
    below: total - to,
    first: total === 0 ? 0 : from + 1,
    last: to,
    total,
  };
}

/** Same range, counting profiles while skipping endpoint headers. */
export function profileRange(rows: PickerRow[], start: number, end: number): PickerRange {
  const lines = selectableLines(rows);
  const above = lines.filter((line) => line < start).length;
  const visible = lines.filter((line) => line >= start && line < end).length;
  return {
    above,
    below: lines.length - above - visible,
    first: visible === 0 ? 0 : above + 1,
    last: above + visible,
    total: lines.length,
  };
}

export function pickerRangeLabel(range: PickerRange): string {
  const window =
    range.first === 0 || range.total === 0
      ? `0 of ${range.total}`
      : `${range.first}-${range.last} of ${range.total}`;
  const parts: string[] = [];
  if (range.above > 0) parts.push(`↑ ${range.above} more`);
  parts.push(window);
  if (range.below > 0) parts.push(`↓ ${range.below} more`);
  return parts.join(' · ');
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
