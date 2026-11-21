import type { ToolDefinition } from '../providers/types.js';

export type ApprovalDecision =
  | 'allow'
  | 'allow-session'
  | 'deny'
  /** Allow and remember a pattern in .kiro/permissions.json. */
  | 'allow-rule'
  /** Deny and remember the exact subject as a rule, so it is refused again. */
  | 'deny-rule';

export interface ApprovalRequest {
  tool: string;
  /** One-line description, e.g. "write_file hello.py". */
  title: string;
  /** Full detail for the preview: a diff for file writes, the command for shell. */
  detail?: string;
  warning?: string;
  /**
   * What a saved rule matches: the command text, or the workspace-relative path.
   * Absent means the request can never be auto-approved by a rule.
   */
  subject?: string;
  /** False when the change escapes the workspace; rules must not pre-approve it. */
  insideWorkspace?: boolean;
}

export type ApproveFn = (request: ApprovalRequest) => Promise<ApprovalDecision>;

export interface AskUserOption {
  label: string;
  description?: string;
}

export interface AskUserRequest {
  /** The question, one or two sentences. */
  question: string;
  /** Short title for the prompt, e.g. "Design". */
  header?: string;
  options: AskUserOption[];
  multiSelect: boolean;
  /** Offer a free-form answer in addition to the listed options. */
  allowOther: boolean;
}

export interface AskUserAnswer {
  /** Labels the user picked, in option order. */
  selected: string[];
  /** Text typed under "Other"; empty when only listed options were picked. */
  other?: string;
  cancelled: boolean;
}

export type AskUserFn = (request: AskUserRequest) => Promise<AskUserAnswer>;

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  approve: ApproveFn;
  /** Undefined outside the TUI: headless runs cannot answer questions. */
  askUser?: AskUserFn;
  /**
   * Live output for a running tool (only `run_command` uses it). The UI draws
   * the last line; headless mode ignores it.
   */
  onOutput?: (update: { tool: string; chunk: string; tail: string }) => void;
}

export type ToolStatus = 'ok' | 'error' | 'denied';

export interface ToolResult {
  /** Text returned to the model. */
  content: string;
  /** Short summary for the TUI. */
  summary: string;
  status: ToolStatus;
}

export interface Tool {
  definition: ToolDefinition;
  /** Read-only tools never mutate state and may run in parallel. */
  readOnly?: boolean;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
  /** True for tools added by an MCP server; they are never auto-approved. */
  mcp?: boolean;
}

export async function requestApproval(
  ctx: ToolContext,
  request: ApprovalRequest,
): Promise<boolean> {
  if (ctx.signal.aborted) return false;
  const decision = await ctx.approve(request);
  return decision !== 'deny';
}

export function ok(content: string, summary: string): ToolResult {
  return { content, summary, status: 'ok' };
}

export function toolError(message: string): ToolResult {
  return { content: `Error: ${message}`, summary: message.split('\n')[0] ?? 'error', status: 'error' };
}

export function denied(reason = 'User denied this tool call.'): ToolResult {
  return { content: reason, summary: 'denied by user', status: 'denied' };
}
