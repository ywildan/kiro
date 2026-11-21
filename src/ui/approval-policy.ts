import type { ApprovalRequest } from '../tools/types.js';
import { evaluateRules, suggestRulePattern, type PermissionRule } from '../permissions.js';

/**
 * Tracks which requests skip approval prompts, so the UI can show and revoke it.
 * YOLO wins over everything; a saved deny rule still stops a request that YOLO
 * would otherwise run, because denying is the more specific instruction.
 */
export class ApprovalPolicy {
  private readonly autoAllowed = new Set<string>();

  constructor(
    readonly yolo: boolean = false,
    private rules: PermissionRule[] = [],
  ) {}

  markSession(tool: string): void {
    this.autoAllowed.add(tool);
  }

  isAuto(tool: string): boolean {
    return this.yolo || this.autoAllowed.has(tool);
  }

  /** Tools allowed for the rest of the session; empty under `--yolo`. */
  list(): string[] {
    return [...this.autoAllowed].sort();
  }

  clear(): void {
    this.autoAllowed.clear();
  }

  setRules(rules: PermissionRule[]): void {
    this.rules = rules;
  }

  savedRules(): PermissionRule[] {
    return this.rules;
  }

  /**
   * Saved rules first: a deny always applies, and an allow only pre-approves a
   * request that stays inside the workspace.
   */
  decide(request: ApprovalRequest): 'allow' | 'deny' | 'ask' {
    // Undefined means the tool did not say; only an explicit false blocks a rule.
    if (request.insideWorkspace === false) {
      const denied = evaluateRules(this.rules, { tool: request.tool, subject: request.subject });
      return denied === 'deny' ? 'deny' : 'ask';
    }
    return evaluateRules(this.rules, { tool: request.tool, subject: request.subject });
  }

  /** The rule a `[s]` press would save, or null when the request has no subject. */
  ruleFor(request: ApprovalRequest): PermissionRule | null {
    if (request.subject === undefined) return null;
    const match = suggestRulePattern(request.tool, request.subject);
    return match ? { tool: request.tool, match, action: 'allow' } : null;
  }

  /** The rule a `[d]` press would save: the exact subject, denied. */
  denyRuleFor(request: ApprovalRequest): PermissionRule | null {
    if (request.subject === undefined) return null;
    return { tool: request.tool, match: request.subject, action: 'deny' };
  }
}
