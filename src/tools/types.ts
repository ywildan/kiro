import type { ToolDefinition } from '../providers/types.js';

export type ApprovalDecision = 'allow' | 'allow-session' | 'deny';

export interface ApprovalRequest {
  tool: string;
  /** One-line description, e.g. "write_file hello.py". */
  title: string;
  /** Full detail for the preview: a diff for file writes, the command for shell. */
  detail?: string;
  warning?: string;
}

export type ApproveFn = (request: ApprovalRequest) => Promise<ApprovalDecision>;

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  approve: ApproveFn;
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
