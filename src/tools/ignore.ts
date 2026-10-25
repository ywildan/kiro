import { matchGlob, matchSegment } from './glob.js';

export interface IgnoreRule {
  /** Workspace-relative directory containing the .gitignore file ('' for the root). */
  base: string;
  pattern: string;
  negated: boolean;
  dirOnly: boolean;
  /** A slash (other than a trailing one) anchors the pattern to the .gitignore directory. */
  anchored: boolean;
}

export function parseIgnoreFile(content: string, base: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.replace(/\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    let negated = false;
    if (line.startsWith('\\!')) {
      line = line.slice(1);
    } else if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1);
    }
    if (!line) continue;
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const leadingSlash = line.startsWith('/');
    if (leadingSlash) line = line.slice(1);
    if (!line) continue;
    rules.push({
      base,
      pattern: line,
      negated,
      dirOnly,
      anchored: leadingSlash || line.includes('/'),
    });
  }
  return rules;
}

function ruleMatches(rule: IgnoreRule, relativePath: string, isDir: boolean): boolean {
  if (rule.dirOnly && !isDir) return false;
  const target = rule.base
    ? relativePath.startsWith(`${rule.base}/`)
      ? relativePath.slice(rule.base.length + 1)
      : null
    : relativePath;
  if (target === null || target === '') return false;
  if (rule.anchored) {
    if (!rule.pattern.includes('/')) {
      return target === rule.pattern;
    }
    return matchGlob(target, rule.pattern);
  }
  return target.split('/').some((segment) => matchSegment(segment, rule.pattern));
}

/** Applies rules in order; the last matching rule wins, so `!pattern` can re-include a path. */
export function isIgnored(rules: IgnoreRule[], relativePath: string, isDir: boolean): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (ruleMatches(rule, relativePath, isDir)) ignored = !rule.negated;
  }
  return ignored;
}
