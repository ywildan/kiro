import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

/**
 * Persistent approval rules, stored per project in `.kiro/permissions.json`.
 *
 * A rule allows or denies one tool for a matching subject: the command text for
 * `run_command`, the relative path for the file tools. A shell command is split
 * on `;`, `&&`, `||`, `|`, and newlines first, and every segment must be allowed,
 * so `npm test*` never approves `npm test; rm -rf ~`.
 */

export type RuleAction = 'allow' | 'deny';

export interface PermissionRule {
  /** Tool name, or `*` for every tool. */
  tool: string;
  /** Glob over the subject: `*` and `?` match any characters, including `/`. */
  match: string;
  action: RuleAction;
}

export type RuleDecision = 'allow' | 'deny' | 'ask';

export const MAX_RULES = 200;
const MAX_PATTERN_CHARS = 300;
const TOOL_PATTERN = /^(\*|[a-z][a-z0-9_]*)$/;

export function permissionsPath(cwd: string): string {
  return process.env.KIRO_PERMISSIONS_PATH || path.join(cwd, '.kiro', 'permissions.json');
}

/** Compiles a glob where `*` is any run of characters and `?` is one. */
export function matchesPattern(pattern: string, text: string): boolean {
  let source = '^';
  for (const char of pattern) {
    if (char === '*') source += '[\\s\\S]*';
    else if (char === '?') source += '[\\s\\S]';
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  try {
    return new RegExp(`${source}$`).test(text);
  } catch {
    return false;
  }
}

/**
 * Splits a shell command into the parts a shell would run, so a rule must cover
 * every one of them. Returns null when quoting is unterminated, because there
 * is no reliable way to tell where one command ends.
 */
export function splitCommand(command: string): string[] | null {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (quote !== null) {
      if (char === '\\' && quote === '"' && index + 1 < command.length) {
        current += char + command[index + 1]!;
        index++;
        continue;
      }
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '\\' && index + 1 < command.length) {
      current += char + command[index + 1]!;
      index++;
      continue;
    }
    if (char === ';' || char === '\n' || char === '\r' || char === '|' || char === '&') {
      const pair = command[index + 1] === char && (char === '|' || char === '&');
      parts.push(current);
      current = '';
      if (pair) index++;
      continue;
    }
    current += char;
  }
  if (quote !== null) return null;
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function tokens(segment: string): string[] {
  return segment.trim().split(/\s+/).filter(Boolean);
}

/**
 * The narrowest useful pattern for a request, shown before the rule is saved.
 * For a command that is the program plus its subcommand (`git status*`); for a
 * file that is the exact path.
 */
export function suggestRulePattern(tool: string, subject: string): string {
  if (tool !== 'run_command') return subject;
  const segments = splitCommand(subject);
  // Chained commands need one rule per segment, so offer none rather than a
  // pattern that would cover only the first.
  if (!segments || segments.length !== 1) return '';
  const parts = tokens(segments[0]!);
  const program = parts[0];
  if (!program || /[*?]/.test(subject)) return '';
  const sub = parts[1];
  // A bare program plus a flag would approve too much (`rm*` covers `rm -rf /`),
  // so a flag keeps its target in the pattern.
  const next = parts[2];
  const head =
    sub === undefined
      ? program
      : sub.startsWith('-')
        ? next && !next.startsWith('-')
          ? `${program} ${sub} ${next}`
          : `${program} ${sub}`
        : `${program} ${sub}`;
  return `${head}*`;
}

function ruleApplies(rule: PermissionRule, tool: string, subject: string): boolean {
  if (rule.tool !== '*' && rule.tool !== tool) return false;
  return matchesPattern(rule.match, subject);
}

/**
 * Decides whether a request may run without asking. A deny rule always wins; a
 * command is allowed only when every one of its segments is allowed.
 */
export function evaluateRules(
  rules: PermissionRule[],
  request: { tool: string; subject?: string },
): RuleDecision {
  if (rules.length === 0 || request.subject === undefined) return 'ask';
  const subject = request.subject;
  const segments = request.tool === 'run_command' ? splitCommand(subject) : [subject];
  if (segments === null) return 'ask';

  let allowed = segments.length > 0;
  for (const segment of segments) {
    if (rules.some((rule) => rule.action === 'deny' && ruleApplies(rule, request.tool, segment))) {
      return 'deny';
    }
    if (!rules.some((rule) => rule.action === 'allow' && ruleApplies(rule, request.tool, segment))) {
      allowed = false;
    }
  }
  return allowed ? 'allow' : 'ask';
}

export function normalizeRules(raw: unknown): PermissionRule[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' && raw !== null && Array.isArray((raw as { rules?: unknown }).rules)
      ? ((raw as { rules: unknown[] }).rules)
      : [];
  const rules: PermissionRule[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const rule = entry as Record<string, unknown>;
    const tool = typeof rule.tool === 'string' ? rule.tool.trim() : '';
    const match = typeof rule.match === 'string' ? rule.match.trim() : '';
    const action = rule.action === 'deny' ? 'deny' : rule.action === 'allow' ? 'allow' : undefined;
    if (!action || !TOOL_PATTERN.test(tool) || !match) continue;
    if (match.length > MAX_PATTERN_CHARS || /[\r\n]/.test(match)) continue;
    const key = `${tool}\u0000${match}\u0000${action}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push({ tool, match, action });
    if (rules.length >= MAX_RULES) break;
  }
  return rules;
}

export interface PermissionSet {
  path: string;
  rules: PermissionRule[];
  /** Set when the file exists but could not be used; the rules are then empty. */
  problem?: string;
}

/** Reads the project's rules. A broken file never blocks startup. */
export async function loadRules(cwd: string): Promise<PermissionSet> {
  const file = permissionsPath(cwd);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: file, rules: [] };
    return { path: file, rules: [], problem: `Could not read ${file}: ${(error as Error).message}` };
  }
  try {
    return { path: file, rules: normalizeRules(JSON.parse(text)) };
  } catch {
    return {
      path: file,
      rules: [],
      problem: `${file} is not valid JSON; no approval rules are in effect.`,
    };
  }
}

export async function saveRules(cwd: string, rules: PermissionRule[]): Promise<string> {
  const file = permissionsPath(cwd);
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await chmod(dir, 0o700);
  } catch {
    // not meaningful on every platform
  }
  const body = `${JSON.stringify({ version: 1, rules: normalizeRules(rules) }, null, 2)}\n`;
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temp, body, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw new Error(`Could not save ${file}: ${(error as Error).message}`);
  }
  try {
    await chmod(file, 0o600);
  } catch {
    // best effort
  }
  return file;
}

/** Adds a rule, replacing one with the same tool and pattern. */
export async function addRule(cwd: string, rule: PermissionRule): Promise<PermissionSet> {
  const current = await loadRules(cwd);
  const rules = [
    ...current.rules.filter((entry) => !(entry.tool === rule.tool && entry.match === rule.match)),
    rule,
  ];
  const file = await saveRules(cwd, rules);
  return { path: file, rules: normalizeRules(rules) };
}

export async function removeRule(
  cwd: string,
  rule: PermissionRule,
): Promise<PermissionSet> {
  const current = await loadRules(cwd);
  const rules = current.rules.filter(
    (entry) => !(entry.tool === rule.tool && entry.match === rule.match),
  );
  const file = await saveRules(cwd, rules);
  return { path: file, rules: normalizeRules(rules) };
}

/** Deletes the rule file; the directory stays. */
export async function clearRules(cwd: string): Promise<string> {
  const file = permissionsPath(cwd);
  await unlink(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  return file;
}
