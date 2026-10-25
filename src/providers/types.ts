export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface JSONSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JSONSchema;
  };
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type ProviderEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'usage'; usage: TokenUsage }
  /** The provider's finish_reason for the choice, e.g. "stop", "tool_calls", "length". */
  | { type: 'finish'; reason: string }
  | { type: 'notice'; message: string };

export interface StreamOptions {
  signal?: AbortSignal;
}

export interface Provider {
  readonly type: string;
  readonly model: string;
  stream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: StreamOptions,
  ): AsyncIterable<ProviderEvent>;
}

export class ProviderError extends Error {
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  /** True when the endpoint rejected the request because the prompt exceeded its context window. */
  readonly overflow: boolean;

  constructor(
    message: string,
    status?: number,
    options?: {
      cause?: unknown;
      retryable?: boolean;
      retryAfterMs?: number;
      overflow?: boolean;
    },
  ) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryable = options?.retryable ?? false;
    this.retryAfterMs = options?.retryAfterMs;
    this.overflow = options?.overflow ?? false;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}
