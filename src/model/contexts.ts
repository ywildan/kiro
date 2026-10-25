/**
 * Best-effort context window sizes keyed by model id. Endpoints that implement
 * GET /models rarely report a window, and an over-large guess lets the request
 * grow past the real limit until the provider answers with a non-retryable 400.
 */

const K = 1_000;

/** Delimited size suffix, e.g. the "1m" in qwen2.5-7b-instruct-1m or "128k". */
const SIZE_SUFFIX = /[-_.](\d+(?:\.\d+)?)([km])(?=$|[-_.])/i;

interface FamilyPattern {
  test: RegExp;
  tokens: number;
}

/** Ordered most-specific first; the first match wins. */
const FAMILIES: FamilyPattern[] = [
  { test: /^o[134](?:\b|-|\.)/, tokens: 200 * K },
  { test: /gpt-4\.1/, tokens: 1_000 * K },
  { test: /chatgpt-4o|gpt-4o/, tokens: 128 * K },
  { test: /gpt-4-turbo|gpt-4-(?:1106|0125)/, tokens: 128 * K },
  { test: /gpt-4-32k/, tokens: 32 * K },
  { test: /gpt-4/, tokens: 8 * K },
  { test: /gpt-3\.5-turbo-16k|gpt-3\.5/, tokens: 16 * K },
  { test: /claude-(?:3|4)/, tokens: 200 * K },
  { test: /claude-2|claude-instant/, tokens: 100 * K },
  { test: /claude/, tokens: 200 * K },
  { test: /gemini/, tokens: 1_000 * K },
  { test: /llama[-.]?(?:3[.1-9]|4)/, tokens: 128 * K },
  { test: /llama[-.]?3/, tokens: 8 * K },
  { test: /qwen[-.]?(?:2\.5|3)/, tokens: 128 * K },
  { test: /qwen/, tokens: 32 * K },
  { test: /mistral-large|ministral/, tokens: 128 * K },
  { test: /mixtral|mistral/, tokens: 32 * K },
  { test: /deepseek/, tokens: 64 * K },
  { test: /grok/, tokens: 128 * K },
  { test: /command-r/, tokens: 128 * K },
  { test: /phi[-.]?(?:3|4)/, tokens: 128 * K },
  { test: /gemma/, tokens: 8 * K },
  { test: /nemotron/, tokens: 128 * K },
  { test: /yi[-.]?(?:lightning|large)/, tokens: 16 * K },
];

/**
 * Returns an approximate context window in tokens for a model id, or undefined
 * when the id is not recognised. An explicit `contextWindow` in the profile
 * always takes precedence.
 */
export function inferContextWindow(model: string): number | undefined {
  const id = model.trim().toLowerCase();
  if (!id) return undefined;
  // Drop a leading provider namespace such as "openai/gpt-4o" or "ollama/llama3".
  const name = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;

  const size = SIZE_SUFFIX.exec(name);
  if (size) {
    const value = Number(size[1]);
    const unit = size[2]?.toLowerCase();
    if (Number.isFinite(value) && value > 0) {
      return Math.round(unit === 'm' ? value * 1_000 * K : value * K);
    }
  }

  for (const family of FAMILIES) {
    if (family.test.test(name)) return family.tokens;
  }
  return undefined;
}
