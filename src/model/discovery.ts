import type { ProfileConfig } from '../config.js';
import { createProvider } from '../providers/index.js';
import { ProviderError } from '../providers/types.js';
import { formatDuration } from '../ui/text.js';

export const DEFAULT_TIMEOUT_MS = 10_000;

export type DiscoveredModels =
  | { ok: true; models: string[]; url: string }
  | { ok: false; models: []; url: string; message: string; status?: number };

export interface TestResult {
  ok: boolean;
  latencyMs: number;
  message: string;
}

export interface TimeoutOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function modelsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  const withoutChat = trimmed.endsWith('/chat/completions')
    ? trimmed.slice(0, -'/chat/completions'.length).replace(/\/+$/, '')
    : trimmed;
  return `${withoutChat}/models`;
}

function snippet(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      if (typeof parsed.error === 'string') return parsed.error;
      if (isRecord(parsed.error) && typeof parsed.error.message === 'string') return parsed.error.message;
      if (typeof parsed.message === 'string') return parsed.message;
    }
  } catch {
    // not JSON
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

function statusHint(status: number): string {
  if (status === 401 || status === 403) {
    return 'The API key is missing or invalid for this endpoint.';
  }
  if (status === 404) {
    return 'Check the base URL. This endpoint may not support GET /models; enter the model name manually.';
  }
  if (status === 429) {
    return 'The endpoint is rate limiting requests; wait a moment and try again.';
  }
  return '';
}

function readModelIds(parsed: unknown): string[] {
  const ids = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.trim()) ids.add(value.trim());
      return;
    }
    if (!isRecord(value)) return;
    if (typeof value.id === 'string' && value.id.trim()) ids.add(value.id.trim());
    if (typeof value.name === 'string' && value.name.trim()) ids.add(value.name.trim());
  };

  if (Array.isArray(parsed)) {
    for (const entry of parsed) collect(entry);
  } else if (isRecord(parsed)) {
    const data = parsed.data;
    if (Array.isArray(data)) {
      for (const entry of data) collect(entry);
    } else if (Array.isArray(parsed.models)) {
      for (const entry of parsed.models) collect(entry);
    }
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

export async function discoverModels(
  options: { baseUrl: string; apiKey?: string } & TimeoutOptions,
): Promise<DiscoveredModels> {
  const url = modelsEndpoint(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onOuterAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;

  try {
    const response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const detail = snippet(body) || `empty response body`;
      return {
        ok: false,
        models: [],
        url,
        status: response.status,
        message:
          `Model discovery failed: HTTP ${response.status} from ${url}: ${detail}. ` +
          statusHint(response.status),
      };
    }
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return {
        ok: false,
        models: [],
        url,
        message: `Model discovery failed: ${url} returned malformed JSON (${(error as Error).message}).`,
      };
    }
    return { ok: true, models: readModelIds(parsed), url };
  } catch (error) {
    if (timedOut) {
      return {
        ok: false,
        models: [],
        url,
        message: `Model discovery timed out after ${timeoutMs / 1000}s contacting ${url}.`,
      };
    }
    if (options.signal?.aborted) {
      return { ok: false, models: [], url, message: 'Model discovery cancelled.' };
    }
    return {
      ok: false,
      models: [],
      url,
      message:
        `Could not reach ${url}: ${(error as Error).message}. ` +
        'Check the base URL, your network, and that the server is running.',
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
}

function describeTestError(error: unknown, timedOut: boolean, timeoutMs: number): string {
  if (timedOut) return `Connection test timed out after ${timeoutMs / 1000}s.`;
  if (error instanceof ProviderError) {
    const status = error.status;
    const firstLine = error.message.split('\n')[0] ?? error.message;
    if (status === 401 || status === 403) {
      return `Authentication failed (HTTP ${status}): ${firstLine} Check the API key.`;
    }
    if (status === 404) {
      return `Endpoint or model not found (HTTP 404): ${firstLine} Check the base URL and model name.`;
    }
    if (status === 429) {
      return `Rate limited (HTTP 429): ${firstLine} Wait a moment and retry.`;
    }
    return error.message;
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'Connection test was cancelled.';
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return 'Connection test was cancelled.';
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Sends a tiny non-tool chat completion and reports latency or a precise error.
 * Streaming is used so the provider path matches real turns.
 */
export async function testConnection(
  profile: ProfileConfig,
  apiKey: string | undefined,
  options: TimeoutOptions = {},
): Promise<TestResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onOuterAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });

  const started = performance.now();
  try {
    const provider = createProvider(
      {
        ...profile,
        temperature: 0,
        maxTokens: Math.min(profile.maxTokens ?? 16, 16),
      },
      apiKey,
    );
    let sawText = false;
    for await (const event of provider.stream(
      [{ role: 'user', content: 'Reply with OK' }],
      [],
      { signal: controller.signal },
    )) {
      if (event.type === 'text' && event.text.trim()) {
        sawText = true;
        break;
      }
    }
    const latencyMs = Math.max(0, Math.round(performance.now() - started));
    if (!sawText) {
      return {
        ok: false,
        latencyMs,
        message: 'The endpoint responded but returned no text. Check that the model name is a chat model.',
      };
    }
    return {
      ok: true,
      latencyMs,
      message: `Connection OK in ${formatDuration(latencyMs)} (model "${profile.model}").`,
    };
  } catch (error) {
    const latencyMs = Math.max(0, Math.round(performance.now() - started));
    return {
      ok: false,
      latencyMs,
      message: describeTestError(error, timedOut, timeoutMs),
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
}
