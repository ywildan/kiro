/** Tracks which tools skip approval prompts, so the UI can show and revoke it. */
export class ApprovalPolicy {
  private readonly autoAllowed = new Set<string>();

  constructor(readonly yolo: boolean = false) {}

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
}
