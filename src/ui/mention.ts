export interface MentionToken {
  /** Character index of the leading @. */
  start: number;
  /** Character index just past the token, including a closing quote when present. */
  end: number;
  query: string;
  quoted: boolean;
}

const BOUNDARY = /[\s([{'"]/;

/** Index of a freshly typed @ that can start a mention, or null. */
export function mentionOpeningAt(chars: string[], cursor: number): number | null {
  if (cursor < 1 || chars[cursor - 1] !== '@') return null;
  if (cursor === 1) return 0;
  return BOUNDARY.test(chars[cursor - 2] ?? '') ? cursor - 1 : null;
}

/** Nearest valid mention ending at the caret, used after a typed chunk. */
export function mentionNearby(chars: string[], cursor: number): number | null {
  for (let start = cursor - 1; start >= 0 && cursor - start <= 200; start--) {
    const char = chars[start];
    if (char === '\n') return null;
    if (char !== '@') continue;
    if (start > 0 && !BOUNDARY.test(chars[start - 1] ?? '')) continue;
    if (mentionAt(chars, cursor, start)) return start;
  }
  return null;
}

/** Reads the mention that starts at `start`, or null when the caret left it or it has whitespace. */
export function mentionAt(chars: string[], cursor: number, start: number): MentionToken | null {
  if (start < 0 || start >= chars.length || chars[start] !== '@') return null;
  if (start > 0 && !BOUNDARY.test(chars[start - 1] ?? '')) return null;
  if (cursor <= start) return null;

  const quote = chars[start + 1];
  if (quote === '"') {
    let close = -1;
    for (let index = start + 2; index < chars.length; index++) {
      if (chars[index] === '"') {
        close = index;
        break;
      }
      if (chars[index] === '\n') return null;
    }
    if (close !== -1 && close < cursor) return null;
    const end = close === -1 ? cursor : close + 1;
    return {
      start,
      end,
      query: chars.slice(start + 2, Math.min(cursor, end)).join(''),
      quoted: true,
    };
  }

  const query = chars.slice(start + 1, cursor).join('');
  if (/[\s\n]/.test(query)) return null;
  return { start, end: cursor, query, quoted: false };
}

/** Text to insert for a file path, quoting names that contain spaces. */
export function mentionText(file: string): string {
  return /[\s"]/.test(file) ? `@"${file.replace(/"/g, '\\"')}"` : `@${file}`;
}
