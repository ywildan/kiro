import type { TokenUsage } from './providers/types.js';

/** Token totals accumulated for one saved session. */
export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  requests: number;
}

export const EMPTY_USAGE: UsageTotals = Object.freeze({
  promptTokens: 0,
  completionTokens: 0,
  requests: 0,
});

function countTokens(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** Adds one endpoint report to the running session totals. */
export function addUsage(current: UsageTotals, usage: TokenUsage): UsageTotals {
  return {
    promptTokens: current.promptTokens + countTokens(usage.promptTokens),
    completionTokens: current.completionTokens + countTokens(usage.completionTokens),
    requests: current.requests + 1,
  };
}

/**
 * Reads totals back from a session file. Bad counters reset to zero instead of
 * failing the resume; usage is metadata, not conversation content.
 */
export function normalizeUsage(raw: unknown): UsageTotals {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...EMPTY_USAGE };
  const record = raw as Record<string, unknown>;
  return {
    promptTokens: countTokens(record.promptTokens),
    completionTokens: countTokens(record.completionTokens),
    requests: countTokens(record.requests),
  };
}
