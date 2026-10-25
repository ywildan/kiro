import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';

const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

/** Remove ANSI escapes and control characters that would corrupt the Ink layout. */
export function sanitizeText(text: string): string {
  const withoutAnsi = text.replace(ANSI_OSC, '').replace(ANSI_CSI, '');
  let output = '';
  for (const char of withoutAnsi) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '\n') {
      output += '\n';
    } else if (char === '\t') {
      output += '    ';
    } else if (char === '\r') {
      continue;
    } else if (code < 32 || code === 127) {
      continue;
    } else {
      output += char;
    }
  }
  return output;
}

export function sanitizeInput(text: string): string {
  return sanitizeText(text).replace(/\n+/g, ' ');
}

export function wrapPlain(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];
  for (const line of sanitizeText(text).split('\n')) {
    if (line === '') {
      lines.push('');
      continue;
    }
    const wrapped = wrapAnsi(line, safeWidth, {
      hard: true,
      trim: false,
      wordWrap: true,
    });
    lines.push(...wrapped.split('\n'));
  }
  return lines.length > 0 ? lines : [''];
}

export function truncateToWidth(text: string, width: number): string {
  if (width <= 0) return '';
  if (stringWidth(text) <= width) return text;
  if (width === 1) return '…';
  let output = '';
  let used = 0;
  for (const char of Array.from(text)) {
    const charWidth = stringWidth(char);
    if (used + charWidth > width - 1) break;
    output += char;
    used += charWidth;
  }
  return output + '…';
}

export function truncateMiddle(text: string, width: number): string {
  if (width <= 0) return '';
  if (stringWidth(text) <= width) return text;
  if (width === 1) return '…';
  const budget = width - 1;
  const leftBudget = Math.ceil(budget / 2);
  const rightBudget = budget - leftBudget;
  const chars = Array.from(text);
  let left = '';
  let usedLeft = 0;
  for (const char of chars) {
    const charWidth = stringWidth(char);
    if (usedLeft + charWidth > leftBudget) break;
    left += char;
    usedLeft += charWidth;
  }
  const rightChars: string[] = [];
  let usedRight = 0;
  for (let index = chars.length - 1; index >= 0; index--) {
    const char = chars[index]!;
    const charWidth = stringWidth(char);
    if (usedRight + charWidth > rightBudget) break;
    rightChars.unshift(char);
    usedRight += charWidth;
  }
  return `${left}…${rightChars.join('')}`;
}

export function displayWidth(text: string): number {
  return stringWidth(text);
}

export interface EditSequence {
  type: 'backspace' | 'delete';
  count: number;
}

/**
 * Ink reports both a terminal Backspace (\x7f / ctrl+h) and the Delete key
 * (Escape[3~) as key.delete, so distinguish them from the raw sequence.
 */
export function parseEditSequence(text: string): EditSequence | null {
  if (/^(?:\x1b[\x08\x7f]|[\x7f\x08]+)$/.test(text)) {
    return { type: 'backspace', count: text.startsWith('\x1b') ? 1 : text.length };
  }
  if (/^(?:\x1b\[3~)+$/.test(text)) {
    return { type: 'delete', count: text.length / 4 };
  }
  return null;
}

export type InputOp =
  | { type: 'insert'; text: string }
  | { type: 'backspace'; count: number }
  | { type: 'delete'; count: number }
  | { type: 'cursor'; position: 'start' | 'end' }
  | { type: 'deleteBefore' }
  | { type: 'deleteAfter' }
  | { type: 'deleteWordBefore' }
  | { type: 'submit' };

export interface TextInputState {
  chars: string[];
  cursor: number;
}

const clamp = (value: number, max: number): number => Math.max(0, Math.min(value, max));

const ANSI_TOKEN = new RegExp(`(${ANSI_CSI.source}|${ANSI_OSC.source})`, 'g');

/** Above this chunk size a trailing newline is treated as pasted text, not Enter. */
const MAX_SUBMIT_CHUNK = 200;

/**
 * Ink hands a whole stdin chunk to a single `useInput` call and only decodes
 * control keys when the chunk is exactly one keypress. Pasting or typing fast
 * produces glued chunks such as `abc\r` or `ab\x7f`, whose control bytes were
 * previously stripped, silently swallowing Enter and Backspace. This splits a
 * chunk into ordered operations instead. Pure edit sequences are left to the
 * raw stdin listener, which is the only place that can tell \x7f from \x1b[3~.
 */
export function parseInputChunk(text: string): InputOp[] {
  if (text === '' || parseEditSequence(text) !== null) return [];

  const lineBreaks = (text.match(/[\r\n]/g) ?? []).length;
  const trailingEnter =
    lineBreaks === 1 && text.length <= MAX_SUBMIT_CHUNK && /[\r\n]$/.test(text);

  const ops: InputOp[] = [];
  let buffer = '';
  const flush = (): void => {
    if (buffer !== '') {
      ops.push({ type: 'insert', text: buffer });
      buffer = '';
    }
  };

  for (const token of text.split(ANSI_TOKEN)) {
    if (token === undefined || token === '') continue;
    if (token.startsWith('\x1b')) {
      const deletes = token.match(/\x1b\[3~/g);
      if (deletes) {
        flush();
        ops.push({ type: 'delete', count: deletes.length });
      }
      continue;
    }
    for (const char of token) {
      const code = char.codePointAt(0) ?? 0;
      if (char === '\x7f' || char === '\x08') {
        flush();
        ops.push({ type: 'backspace', count: 1 });
      } else if (char === '\r' || char === '\n') {
        if (trailingEnter) {
          flush();
          ops.push({ type: 'submit' });
        } else {
          buffer += ' ';
        }
      } else if (char === '\t') {
        buffer += '    ';
      } else if (code < 32 || code === 127) {
        flush();
        if (code === 1) ops.push({ type: 'cursor', position: 'start' });
        else if (code === 5) ops.push({ type: 'cursor', position: 'end' });
        else if (code === 11) ops.push({ type: 'deleteAfter' });
        else if (code === 21) ops.push({ type: 'deleteBefore' });
        else if (code === 23) ops.push({ type: 'deleteWordBefore' });
      } else {
        buffer += char;
      }
    }
  }
  flush();
  return ops;
}

/** Apply one operation to the caret state; every operation is total. */
export function applyInputOp(state: TextInputState, op: InputOp): TextInputState {
  const { chars, cursor } = state;
  switch (op.type) {
    case 'insert': {
      const inserted = Array.from(op.text);
      return {
        chars: [...chars.slice(0, cursor), ...inserted, ...chars.slice(cursor)],
        cursor: cursor + inserted.length,
      };
    }
    case 'backspace': {
      if (cursor === 0) return state;
      const nextCursor = clamp(cursor - op.count, chars.length);
      return {
        chars: [...chars.slice(0, nextCursor), ...chars.slice(cursor)],
        cursor: nextCursor,
      };
    }
    case 'delete': {
      if (cursor >= chars.length) return state;
      const end = clamp(cursor + op.count, chars.length);
      return {
        chars: [...chars.slice(0, cursor), ...chars.slice(end)],
        cursor,
      };
    }
    case 'cursor':
      return { chars, cursor: op.position === 'start' ? 0 : chars.length };
    case 'deleteBefore':
      return { chars: chars.slice(cursor), cursor: 0 };
    case 'deleteAfter':
      return { chars: chars.slice(0, cursor), cursor };
    case 'deleteWordBefore': {
      let start = cursor;
      while (start > 0 && /\s/.test(chars[start - 1] ?? '')) start--;
      while (start > 0 && !/\s/.test(chars[start - 1] ?? '')) start--;
      return { chars: [...chars.slice(0, start), ...chars.slice(cursor)], cursor: start };
    }
    case 'submit':
      return state;
  }
}

/**
 * Runs the operations from one chunk in order so `abc\r` inserts "abc" and then
 * submits it. `maxChars` caps the buffer, mirroring the previous whole-chunk limit.
 */
export function applyInputOps(
  state: TextInputState,
  ops: InputOp[],
  maxChars: number = Number.POSITIVE_INFINITY,
): { state: TextInputState; submitted: boolean } {
  let current = state;
  for (const op of ops) {
    if (op.type === 'submit') return { state: current, submitted: true };
    if (op.type === 'insert') {
      const room = Math.max(0, maxChars - current.chars.length);
      if (room === 0) continue;
      const limited = Array.from(op.text)
        .slice(0, room)
        .join('');
      current = applyInputOp(current, { type: 'insert', text: limited });
      continue;
    }
    current = applyInputOp(current, op);
  }
  return { state: current, submitted: false };
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function summarizeToolArgs(name: string, rawArguments: string): string {
  let args: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(rawArguments || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>;
    }
  } catch {
    return truncateToWidth(sanitizeInput(rawArguments), 80);
  }
  if (!args) return '';

  switch (name) {
    case 'read_file': {
      const path = typeof args.path === 'string' ? args.path : '?';
      const offset = typeof args.offset === 'number' ? args.offset : undefined;
      const limit = typeof args.limit === 'number' ? args.limit : undefined;
      return offset || limit ? `${path} (offset ${offset ?? 1}, limit ${limit ?? 400})` : path;
    }
    case 'write_file': {
      const path = typeof args.path === 'string' ? args.path : '?';
      const content = typeof args.content === 'string' ? args.content : '';
      const lines = content ? content.split('\n').length - (content.endsWith('\n') ? 1 : 0) : 0;
      return `${path} (${lines} line${lines === 1 ? '' : 's'})`;
    }
    case 'edit_file':
      return typeof args.path === 'string' ? args.path : '?';
    case 'multi_edit': {
      const target = typeof args.path === 'string' ? args.path : '?';
      const edits = Array.isArray(args.edits) ? args.edits.length : 0;
      return `${target} (${edits} edit${edits === 1 ? '' : 's'})`;
    }
    case 'apply_patch': {
      const patch = typeof args.patch === 'string' ? args.patch : '';
      const files = new Set<string>();
      for (const line of patch.split('\n')) {
        if (line.startsWith('+++ ')) {
          const name = line.slice(4).split('\t')[0]!.trim().replace(/^b\//, '');
          if (name !== '/dev/null') files.add(name);
        }
      }
      return files.size > 0 ? [...files].join(', ') : 'patch';
    }
    case 'glob':
      return typeof args.pattern === 'string'
        ? `${args.pattern}${typeof args.path === 'string' ? ` in ${args.path}` : ''}`
        : '?';
    case 'grep':
      return typeof args.pattern === 'string'
        ? `/${args.pattern}/ ${typeof args.path === 'string' ? args.path : '.'}`
        : '?';
    case 'list_dir':
      return typeof args.path === 'string' && args.path ? args.path : '.';
    case 'run_command': {
      const command = typeof args.command === 'string' ? args.command : '';
      return `$ ${sanitizeInput(command)}`;
    }
    default:
      return truncateToWidth(sanitizeInput(rawArguments), 80);
  }
}
