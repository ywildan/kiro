/** Minimal glob matching used by the search tools (no extra dependencies). */

function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{');
  if (open === -1) return [pattern];
  let depth = 0;
  for (let index = open; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) {
        const before = pattern.slice(0, open);
        const after = pattern.slice(index + 1);
        const choices = pattern.slice(open + 1, index).split(',');
        return choices.flatMap((choice) => expandBraces(`${before}${choice}${after}`));
      }
    }
  }
  return [pattern];
}

function escapeRegExp(text: string): string {
  return text.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

export function matchSegment(segment: string, pattern: string): boolean {
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '[') {
      let end = index + 1;
      while (end < pattern.length && pattern[end] !== ']') end++;
      if (end >= pattern.length) {
        source += '\\[';
        continue;
      }
      let body = pattern.slice(index + 1, end);
      if (body.startsWith('!')) body = `^${body.slice(1)}`;
      source += `[${body.replace(/\\/g, '\\\\')}]`;
      index = end;
    } else {
      source += escapeRegExp(char);
    }
  }
  try {
    return new RegExp(`^${source}$`).test(segment);
  } catch {
    return false;
  }
}

function matchParts(pathParts: string[], patternParts: string[]): boolean {
  if (patternParts.length === 0) return pathParts.length === 0;
  const [head, ...rest] = patternParts;
  if (head === '**') {
    if (rest.length === 0) return true;
    for (let index = 0; index <= pathParts.length; index++) {
      if (matchParts(pathParts.slice(index), rest)) return true;
    }
    return false;
  }
  if (pathParts.length === 0) return false;
  if (!matchSegment(pathParts[0]!, head!)) return false;
  return matchParts(pathParts.slice(1), rest);
}

/**
 * Matches a repository-relative path against a glob such as `src/**\/*.ts`.
 * A pattern without a slash is matched against every path segment (`*.ts` = any depth).
 */
export function matchGlob(relativePath: string, pattern: string): boolean {
  const normalizedPath = relativePath.split('\\').join('/').replace(/^\.\//, '');
  const pathParts = normalizedPath.split('/').filter((part) => part !== '');
  for (const expanded of expandBraces(pattern.trim())) {
    let normalized = expanded.split('\\').join('/').replace(/^\.\//, '');
    if (normalized.startsWith('/')) normalized = normalized.slice(1);
    if (!normalized) continue;
    const hasSlash = normalized.includes('/');
    const patternParts = normalized.split('/').filter((part) => part !== '');
    if (!hasSlash) {
      if (pathParts.some((part) => matchSegment(part, normalized))) return true;
      continue;
    }
    if (matchParts(pathParts, patternParts)) return true;
  }
  return false;
}
