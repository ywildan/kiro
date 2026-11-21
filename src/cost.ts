import type { UsageTotals } from './usage.js';

/**
 * Approximate list prices, in US dollars per million tokens, used to show a
 * running cost in the Usage card. The endpoint does not report prices, so these
 * are matched by model id and may be out of date; a profile can override them
 * with `pricing` in config.json.
 */
export interface ModelPrice {
  /** Prone to change; the UI labels the total as approximate. */
  input: number;
  output: number;
}

/** Matched in order; the first pattern found anywhere in the model id wins. */
const PRICES: { pattern: RegExp; price: ModelPrice }[] = [
  // OpenAI
  { pattern: /^gpt-5(\.|-|$)/i, price: { input: 1.25, output: 10 } },
  { pattern: /^o4-mini/i, price: { input: 1.1, output: 4.4 } },
  { pattern: /^o3-mini/i, price: { input: 1.1, output: 4.4 } },
  { pattern: /^o3(\.|-|$)/i, price: { input: 2, output: 8 } },
  { pattern: /^o1-mini/i, price: { input: 1.1, output: 4.4 } },
  { pattern: /^o1(\.|-|$)/i, price: { input: 15, output: 60 } },
  { pattern: /^gpt-4\.1-mini/i, price: { input: 0.4, output: 1.6 } },
  { pattern: /^gpt-4\.1-nano/i, price: { input: 0.1, output: 0.4 } },
  { pattern: /^gpt-4\.1/i, price: { input: 2, output: 8 } },
  { pattern: /^gpt-4o-mini/i, price: { input: 0.15, output: 0.6 } },
  { pattern: /^gpt-4o/i, price: { input: 2.5, output: 10 } },
  { pattern: /^gpt-4-turbo/i, price: { input: 10, output: 30 } },
  // Anthropic, as sold through OpenRouter and gateways
  { pattern: /claude-(3[.-]5|3\.7|4)-?sonnet/i, price: { input: 3, output: 15 } },
  { pattern: /claude-.*haiku/i, price: { input: 0.8, output: 4 } },
  { pattern: /claude-.*opus/i, price: { input: 15, output: 75 } },
  // Google
  { pattern: /gemini-2\.5-pro/i, price: { input: 1.25, output: 10 } },
  { pattern: /gemini-2\.5-flash/i, price: { input: 0.3, output: 2.5 } },
  { pattern: /gemini-2\.0-flash/i, price: { input: 0.1, output: 0.4 } },
  // DeepSeek and Groq
  { pattern: /deepseek-(v3|chat|reasoner)/i, price: { input: 0.27, output: 1.1 } },
  { pattern: /^qwen|^llama|^mixtral|^mistral/i, price: { input: 0.2, output: 0.6 } },
];

/** Local servers are free, so a localhost base URL reports zero instead of a guess. */
function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '0.0.0.0' ||
      host.endsWith('.local') ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    );
  } catch {
    return false;
  }
}

export function priceFor(model: string, baseUrl?: string): ModelPrice | null {
  if (baseUrl && isLocalBaseUrl(baseUrl)) return { input: 0, output: 0 };
  const id = model.split('/').pop() ?? model;
  for (const entry of PRICES) {
    if (entry.pattern.test(id)) return entry.price;
  }
  return null;
}

/** Cost of one request, in dollars. */
export function costOf(
  usage: { promptTokens: number; completionTokens: number },
  price: ModelPrice,
): number {
  return (usage.promptTokens / 1_000_000) * price.input + (usage.completionTokens / 1_000_000) * price.output;
}

export interface SessionCost {
  dollars: number;
  /** False when at least one request ran on a model with no known price. */
  complete: boolean;
}

/**
 * Cost of one usage report, added to the running total. The caller tracks
 * whether any earlier request was unpriced, so the card can show a `~`.
 */
export function addCost(
  current: SessionCost,
  usage: { promptTokens: number; completionTokens: number },
  price: ModelPrice | null,
): SessionCost {
  if (!price) return { dollars: current.dollars, complete: false };
  return { dollars: current.dollars + costOf(usage, price), complete: current.complete };
}

/** Cost of a whole session at one price; used when a session is resumed. */
export function sessionCost(totals: UsageTotals, price: ModelPrice | null): SessionCost {
  if (totals.requests === 0) return { dollars: 0, complete: true };
  if (!price) return { dollars: 0, complete: false };
  return { dollars: costOf(totals, price), complete: true };
}

const SMALL = 0.01;

/** `$0.0042`, `$0.42`, `$1.20`: two decimals once cents matter, three below a cent. */
export function formatCost(dollars: number): string {
  if (!Number.isFinite(dollars) || dollars <= 0) return '$0';
  if (dollars < SMALL) return `$${dollars.toFixed(4)}`;
  if (dollars < 1) return `$${dollars.toFixed(3)}`;
  return `$${dollars.toFixed(2)}`;
}
