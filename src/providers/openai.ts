import { setTimeout as sleep } from 'node:timers/promises';
import type { ProfileConfig } from '../config.js';
import type {
  ChatMessage,
  Provider,
  ProviderEvent,
  StreamOptions,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from './types.js';
import { ProviderError } from './types.js';

const MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 500;
const MAX_RETRY_DELAY_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function endpointFor(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (isRecord(part) && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  return '';
}

function errorMessageFromBody(body: string, status: number): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed)) {
      if (typeof parsed.error === 'string') return parsed.error;
      if (isRecord(parsed.error) && typeof parsed.error.message === 'string') return parsed.error.message;
      if (typeof parsed.message === 'string') return parsed.message;
    }
  } catch {
    // not JSON
  }
  const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 500);
  return snippet || `empty response body (HTTP ${status})`;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseUsage(raw: unknown): TokenUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const promptTokens = positiveNumber(raw.prompt_tokens) ?? 0;
  const completionTokens = positiveNumber(raw.completion_tokens) ?? 0;
  const totalTokens = positiveNumber(raw.total_tokens) ?? promptTokens + completionTokens;
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) return undefined;
  return { promptTokens, completionTokens, totalTokens };
}

function hintForStatus(status: number): string {
  if (status === 401 || status === 403) {
    return '\nCheck that the API key environment variable is set correctly.';
  }
  if (status === 404) {
    return '\nCheck the profile baseUrl (endpoint is baseUrl + /chat/completions) and model name.';
  }
  if (status === 429) {
    return '\nThe endpoint is rate limiting requests; wait and retry.';
  }
  return '';
}

const OVERFLOW_PATTERN =
  /(maximum context|context (?:window|length)|too many tokens|exceed\w*[^.]{0,40}tokens|reduce the length|input is too long|prompt is too long)/i;

/** True when a 4xx body says the prompt did not fit the model's context window. */
export function isOverflowMessage(message: string): boolean {
  return OVERFLOW_PATTERN.test(message);
}

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
}

function toToolCall(pending: PendingToolCall): ToolCall {
  return {
    id: pending.id,
    type: 'function',
    function: { name: pending.name, arguments: pending.arguments },
  };
}

function accumulateToolCallDelta(calls: Map<number, PendingToolCall>, raw: unknown): void {
  if (!isRecord(raw)) return;
  const index = typeof raw.index === 'number' ? raw.index : calls.size;
  const existing = calls.get(index) ?? { id: '', name: '', arguments: '' };
  if (typeof raw.id === 'string' && raw.id) {
    existing.id = raw.id;
  }
  if (isRecord(raw.function)) {
    if (typeof raw.function.name === 'string' && raw.function.name) {
      existing.name = raw.function.name;
    }
    if (typeof raw.function.arguments === 'string') {
      existing.arguments += raw.function.arguments;
    }
  }
  calls.set(index, existing);
}

function finalizeToolCalls(calls: Map<number, PendingToolCall>): ToolCall[] {
  return [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, call]) => {
      if (!call.id) call.id = `call_${index}`;
      return toToolCall(call);
    })
    .filter((call) => call.function.name.length > 0);
}

export class OpenAIProvider implements Provider {
  readonly type = 'openai';
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly temperature: number | undefined;
  private readonly maxTokens: number | undefined;

  constructor(profile: ProfileConfig, apiKey: string | undefined) {
    this.baseUrl = profile.baseUrl;
    this.model = profile.model;
    this.apiKey = apiKey;
    this.temperature = profile.temperature;
    this.maxTokens = profile.maxTokens;
  }

  async *stream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: StreamOptions = {},
  ): AsyncIterable<ProviderEvent> {
    const endpoint = endpointFor(this.baseUrl);
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new ProviderError(`Invalid endpoint URL: ${endpoint}`);
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream, application/json',
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((message) => {
        const wire: Record<string, unknown> = { role: message.role, content: message.content };
        if (message.tool_calls?.length) wire.tool_calls = message.tool_calls;
        if (message.tool_call_id) wire.tool_call_id = message.tool_call_id;
        if (message.name) wire.name = message.name;
        return wire;
      }),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    if (this.temperature !== undefined) body.temperature = this.temperature;
    if (this.maxTokens !== undefined) body.max_tokens = this.maxTokens;

    for (let attempt = 0; ; attempt++) {
      let emitted = 0;
      try {
        for await (const event of this.streamOnce(url, headers, body, options)) {
          if (event.type === 'text' || event.type === 'tool_call') emitted++;
          yield event;
        }
        return;
      } catch (error) {
        if (isAbortError(error) || options.signal?.aborted) throw error;
        if (
          !(error instanceof ProviderError) ||
          !error.retryable ||
          emitted > 0 ||
          attempt >= MAX_RETRIES
        ) {
          throw error;
        }
        const attemptNumber = attempt + 1;
        const delayMs = retryDelayMs(attempt, error.retryAfterMs);
        yield {
          type: 'notice',
          message: `retrying (${attemptNumber}/${MAX_RETRIES})…`,
        };
        await sleep(delayMs, undefined, { signal: options.signal });
      }
    }
  }

  private async *streamOnce(
    url: URL,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    options: StreamOptions,
  ): AsyncGenerator<ProviderEvent> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new ProviderError(
        `Could not reach the model endpoint at ${url.origin}${url.pathname}: ${(error as Error).message}\n` +
          'Check the baseUrl in your profile, your network, and that the server is running.',
        undefined,
        { cause: error, retryable: true },
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const status = response.status;
      const detail = errorMessageFromBody(text, status);
      throw new ProviderError(
        `Model endpoint returned HTTP ${status}: ${detail}` + hintForStatus(status),
        status,
        {
          retryable: status === 429 || status >= 500,
          retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
          overflow: (status === 400 || status === 413) && isOverflowMessage(detail),
        },
      );
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.includes('application/json')) {
      const text = await response.text();
      yield* this.parseFullResponse(text, options);
      return;
    }

    if (!response.body) {
      throw new ProviderError('Model endpoint returned an empty streaming response.', undefined, {
        retryable: true,
      });
    }

    yield* this.parseStream(response.body, options);
  }

  private *parseFullResponse(text: string, options: StreamOptions): Generator<ProviderEvent> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new ProviderError(
        `Model endpoint returned malformed JSON: ${(error as Error).message}`,
        undefined,
        { cause: error },
      );
    }
    if (!isRecord(parsed)) {
      throw new ProviderError('Model endpoint returned an unexpected response shape.');
    }
    if (parsed.error) {
      throw new ProviderError(`Model endpoint error: ${errorMessageFromBody(text, 200)}`);
    }
    const usage = parseUsage(parsed.usage);
    if (usage && !options.signal?.aborted) yield { type: 'usage', usage };
    const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
    if (!isRecord(choice) || !isRecord(choice.message)) {
      throw new ProviderError('Model response contained no message choices.');
    }
    const message = choice.message;
    if (options.signal?.aborted) return;
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
      yield { type: 'finish', reason: choice.finish_reason };
    }
    const content = extractText(message.content);
    if (content) yield { type: 'text', text: content };
    if (Array.isArray(message.tool_calls)) {
      const calls = new Map<number, PendingToolCall>();
      message.tool_calls.forEach((raw, index) => {
        if (!isRecord(raw)) return;
        const fn = isRecord(raw.function) ? raw.function : {};
        calls.set(index, {
          id: typeof raw.id === 'string' ? raw.id : `call_${index}`,
          name: typeof fn.name === 'string' ? fn.name : '',
          arguments: typeof fn.arguments === 'string' ? fn.arguments : '',
        });
      });
      for (const call of finalizeToolCalls(calls)) {
        yield { type: 'tool_call', toolCall: call };
      }
    }
  }

  private async *parseStream(body: ReadableStream<Uint8Array>, options: StreamOptions): AsyncGenerator<ProviderEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const calls = new Map<number, PendingToolCall>();
    let buffer = '';
    let finished = false;

    const handleData = (data: string): ProviderEvent[] => {
      if (!data) return [];
      if (data === '[DONE]') {
        finished = true;
        return [];
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch (error) {
        throw new ProviderError(
          `Malformed streaming response from endpoint: ${(error as Error).message}. ` +
            `Received: ${data.slice(0, 200)}`,
          undefined,
          { cause: error },
        );
      }
      if (!isRecord(parsed)) return [];
      if (parsed.error) {
        throw new ProviderError(`Model endpoint error: ${errorMessageFromBody(data, 200)}`);
      }
      const events: ProviderEvent[] = [];
      const usage = parseUsage(parsed.usage);
      if (usage) events.push({ type: 'usage', usage });
      if (!Array.isArray(parsed.choices) || parsed.choices.length === 0) return events;
      const choice = parsed.choices[0];
      if (!isRecord(choice)) return events;
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
        events.push({ type: 'finish', reason: choice.finish_reason });
      }
      if (!isRecord(choice.delta)) return events;
      const text = extractText(choice.delta.content);
      if (text) events.push({ type: 'text', text });
      if (Array.isArray(choice.delta.tool_calls)) {
        for (const raw of choice.delta.tool_calls) {
          accumulateToolCallDelta(calls, raw);
        }
      }
      return events;
    };

    const handleSseEvent = (rawEvent: string): ProviderEvent[] => {
      const dataLines: string[] = [];
      for (const line of rawEvent.split(/\r?\n/)) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        }
      }
      return dataLines.length > 0 ? handleData(dataLines.join('\n')) : [];
    };

    try {
      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary = findEventBoundary(buffer);
        while (boundary) {
          const rawEvent = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary.length);
          for (const event of handleSseEvent(rawEvent)) {
            yield event;
          }
          if (finished) break;
          boundary = findEventBoundary(buffer);
        }
      }
      if (!finished) {
        buffer += decoder.decode();
        if (buffer.trim()) {
          for (const event of handleSseEvent(buffer)) {
            yield event;
          }
        }
      }
      for (const call of finalizeToolCalls(calls)) {
        yield { type: 'tool_call', toolCall: call };
      }
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted) throw error;
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        `Lost connection while reading the model stream: ${(error as Error).message}`,
        undefined,
        { cause: error, retryable: true },
      );
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // stream already released
      }
    }
  }
}

function findEventBoundary(buffer: string): { index: number; length: number } | undefined {
  const match = /\r?\n\r?\n/.exec(buffer);
  if (!match || match.index === undefined) return undefined;
  return { index: match.index, length: match[0].length };
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function retryBaseMs(): number {
  const raw = Number(process.env.KIRO_RETRY_BASE_MS ?? '');
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_RETRY_BASE_MS;
}

/** Honors Retry-After (seconds or HTTP date), capped so a bad header cannot stall the TUI. */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
  }
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_DELAY_MS);
  }
  return undefined;
}

function retryDelayMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return retryAfterMs;
  const exponential = retryBaseMs() * 2 ** attempt;
  const jittered = exponential * (0.5 + Math.random() * 0.5);
  return Math.min(Math.round(jittered), MAX_RETRY_DELAY_MS);
}
