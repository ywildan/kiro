import stringWidth from 'string-width';
import { displayWidth, sanitizeText } from './text.js';

export interface MarkdownSegment {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
}

export interface MarkdownLine {
  segments: MarkdownSegment[];
}

type Style = Omit<MarkdownSegment, 'text'>;

interface StyledChar {
  ch: string;
  style: Style;
}

const EMPTY_LINE: MarkdownLine = { segments: [{ text: '' }] };

function styleKey(style: Style): string {
  return [
    style.color ?? '',
    style.bold ? 'b' : '',
    style.dim ? 'd' : '',
    style.italic ? 'i' : '',
    style.underline ? 'u' : '',
    style.strikethrough ? 's' : '',
  ].join('|');
}

function mergeChars(chars: StyledChar[]): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  for (const { ch, style } of chars) {
    const last = segments[segments.length - 1];
    if (last && styleKey(last) === styleKey(style)) {
      last.text += ch;
    } else {
      segments.push({ ...style, text: ch });
    }
  }
  return segments.length > 0 ? segments : [{ text: '' }];
}

function trimEndChars(chars: StyledChar[]): StyledChar[] {
  let end = chars.length;
  while (end > 0 && chars[end - 1]!.ch === ' ') end--;
  return chars.slice(0, end);
}

function dropLeadingSpaces(chars: StyledChar[]): StyledChar[] {
  let start = 0;
  while (start < chars.length && chars[start]!.ch === ' ') start++;
  return chars.slice(start);
}

function totalWidth(chars: StyledChar[]): number {
  return chars.reduce((sum, entry) => sum + Math.max(0, stringWidth(entry.ch)), 0);
}

/** Word-wraps styled text, preserving style boundaries across line breaks. */
function wrapSegments(segments: MarkdownSegment[], width: number): MarkdownSegment[][] {
  const safeWidth = Math.max(1, width);
  const chars: StyledChar[] = [];
  for (const segment of segments) {
    const { text, ...style } = segment;
    for (const ch of Array.from(text)) chars.push({ ch, style });
  }

  const lines: StyledChar[][] = [];
  let line: StyledChar[] = [];
  let used = 0;
  let lastSpace = -1;

  const breakLine = (): void => {
    if (lastSpace > 0 && lastSpace < line.length - 1) {
      const head = trimEndChars(line.slice(0, lastSpace));
      const carry = dropLeadingSpaces(line.slice(lastSpace + 1));
      lines.push(head);
      line = carry;
      used = totalWidth(line);
      lastSpace = line.map((entry) => entry.ch).lastIndexOf(' ');
    } else {
      lines.push(trimEndChars(line));
      line = [];
      used = 0;
      lastSpace = -1;
    }
  };

  for (const entry of chars) {
    const charWidth = Math.max(0, stringWidth(entry.ch));
    if (line.length > 0 && used + charWidth > safeWidth) breakLine();
    line.push(entry);
    used += charWidth;
    if (entry.ch === ' ') lastSpace = line.length - 1;
  }
  lines.push(trimEndChars(line));

  return lines.map((entry) => mergeChars(entry));
}

function isEscapable(char: string): boolean {
  return /[\\`*_{}[\]()#+\-.!~>|]/.test(char);
}

function inlineSegments(text: string, base: Style = {}): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  let buffer = '';
  const flush = (): void => {
    if (buffer) {
      segments.push({ ...base, text: buffer });
      buffer = '';
    }
  };

  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const char = text[index]!;

    if (char === '\\' && index + 1 < text.length && isEscapable(text[index + 1]!)) {
      buffer += text[index + 1];
      index += 2;
      continue;
    }

    if (char === '`') {
      const ticks = /^`+/.exec(rest)?.[0] ?? '`';
      const close = text.indexOf(ticks, index + ticks.length);
      if (close !== -1) {
        flush();
        segments.push({ ...base, text: text.slice(index + ticks.length, close), color: 'yellow' });
        index = close + ticks.length;
        continue;
      }
    }

    if (char === '[') {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
      if (link) {
        flush();
        segments.push({ ...base, text: link[1]!, color: 'blue', underline: true });
        if (link[2] && link[2] !== link[1]) {
          segments.push({ ...base, text: ` (${link[2]})`, dim: true });
        }
        index += link[0].length;
        continue;
      }
    }

    if (char === '<') {
      const auto = /^<((?:https?|mailto):[^>]+)>/i.exec(rest);
      if (auto) {
        flush();
        segments.push({ ...base, text: auto[1]!, color: 'blue', underline: true });
        index += auto[0].length;
        continue;
      }
    }

    if (rest.startsWith('**') || rest.startsWith('__')) {
      const marker = rest.slice(0, 2);
      const close = text.indexOf(marker, index + 2);
      if (close > index + 2) {
        flush();
        segments.push(...inlineSegments(text.slice(index + 2, close), { ...base, bold: true }));
        index = close + 2;
        continue;
      }
    }

    if (rest.startsWith('~~')) {
      const close = text.indexOf('~~', index + 2);
      if (close > index + 2) {
        flush();
        segments.push(...inlineSegments(text.slice(index + 2, close), { ...base, strikethrough: true }));
        index = close + 2;
        continue;
      }
    }

    if (char === '*' && !rest.startsWith('**')) {
      const close = text.indexOf('*', index + 1);
      if (close > index + 1 && text[close + 1] !== '*') {
        flush();
        segments.push(...inlineSegments(text.slice(index + 1, close), { ...base, italic: true }));
        index = close + 1;
        continue;
      }
    }

    if (char === '_' && !rest.startsWith('__')) {
      const before = index === 0 ? ' ' : text[index - 1]!;
      const close = text.indexOf('_', index + 1);
      const after = close === -1 ? '' : (text[close + 1] ?? '');
      if (close > index + 1 && /\s|[([{'"`]/.test(before) && (after === '' || /\s|[)\]}>.,;:!?'"`]/.test(after))) {
        flush();
        segments.push(...inlineSegments(text.slice(index + 1, close), { ...base, italic: true }));
        index = close + 1;
        continue;
      }
    }

    buffer += char;
    index++;
  }
  flush();
  return segments.length > 0 ? segments : [{ ...base, text: '' }];
}

function inlineLines(text: string, width: number, base: Style = {}): MarkdownLine[] {
  return wrapSegments(inlineSegments(text, base), width).map((segments) => ({ segments }));
}

function hardWrap(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];
  let line = '';
  let used = 0;
  for (const char of Array.from(text)) {
    const charWidth = Math.max(0, stringWidth(char));
    if (used + charWidth > safeWidth && line !== '') {
      lines.push(line);
      line = '';
      used = 0;
    }
    line += char;
    used += charWidth;
  }
  lines.push(line);
  return lines;
}

function codeLines(raw: string, width: number): MarkdownLine[] {
  const body = hardWrap(raw, Math.max(1, width - 2));
  return body.map((line) => ({
    segments: [{ text: `  ${line}`, color: 'yellow', dim: true }],
  }));
}

function listLines(marker: string, content: string, width: number): MarkdownLine[] {
  const markerWidth = displayWidth(marker);
  const available = Math.max(4, width - markerWidth);
  const wrapped = wrapSegments(inlineSegments(content), available);
  return wrapped.map((segments, index) => ({
    segments:
      index === 0
        ? [{ text: marker, color: 'cyan' }, ...segments]
        : [{ text: ' '.repeat(markerWidth) }, ...segments],
  }));
}

function quoteLines(text: string, width: number): MarkdownLine[] {
  const marker = '  │ ';
  const available = Math.max(4, width - displayWidth(marker));
  return wrapSegments(inlineSegments(text, { italic: true }), available).map((segments) => ({
    segments: [{ text: marker, color: 'cyan', dim: true }, ...segments],
  }));
}

type ColumnAlign = 'left' | 'center' | 'right';

const MIN_TABLE_COLUMN = 4;

function segmentWidth(segments: MarkdownSegment[]): number {
  return displayWidth(segments.map((segment) => segment.text).join(''));
}

/** Splits a table row on pipes that are not escaped or inside inline code. */
function splitTableRow(raw: string): string[] {
  let text = raw.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  let inCode = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === '\\' && text[index + 1] === '|') {
      cell += '\\|';
      index++;
      continue;
    }
    if (char === '`') {
      inCode = !inCode;
      cell += char;
      continue;
    }
    if (char === '|' && !inCode) {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

function isDelimiterCell(cell: string): boolean {
  return /^:?-{3,}:?$/.test(cell);
}

function columnAlign(cell: string): ColumnAlign {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  return right ? 'right' : 'left';
}

function tableRowCells(raw: string): string[] | null {
  if (!raw.includes('|')) return null;
  const cells = splitTableRow(raw);
  return cells.length >= 2 ? cells : null;
}

/**
 * Renders a GitHub-style table inside `width`. Cells wrap inside their column;
 * if the columns cannot be made readable, the caller falls back to plain text.
 */
function tableLines(
  header: string[],
  delimiter: string[],
  body: string[][],
  width: number,
): MarkdownLine[] | null {
  const columns = header.length;
  const aligns = delimiter.map(columnAlign);
  const headerCells = header.map((cell) => inlineSegments(cell, { bold: true }));
  const bodyCells: MarkdownSegment[][][] = body.map((row) =>
    Array.from({ length: columns }, (_, column) => inlineSegments(row[column] ?? '')),
  );

  const natural = headerCells.map((segments, column) => {
    let widest = segmentWidth(segments);
    for (const row of bodyCells) {
      widest = Math.max(widest, segmentWidth(row[column]!));
    }
    return Math.max(MIN_TABLE_COLUMN, widest);
  });
  const overhead = columns * 3 + 1;
  const available = width - overhead;
  if (available < columns * MIN_TABLE_COLUMN) return null;

  const widths = [...natural];
  let total = widths.reduce((sum, value) => sum + value, 0);
  while (total > available) {
    let widest = 0;
    for (let column = 1; column < widths.length; column++) {
      if (widths[column]! > widths[widest]!) widest = column;
    }
    if (widths[widest]! <= MIN_TABLE_COLUMN) return null;
    widths[widest] = widths[widest]! - 1;
    total--;
  }

  const border = (left: string, middle: string, right: string): MarkdownLine => ({
    segments: [
      {
        text: `${left}${widths.map((cellWidth) => '─'.repeat(cellWidth + 2)).join(middle)}${right}`,
        dim: true,
      },
    ],
  });

  const renderRow = (cells: MarkdownSegment[][]): MarkdownLine[] => {
    const wrapped = cells.map((segments, column) => wrapSegments(segments, widths[column]!));
    const height = Math.max(...wrapped.map((lines) => lines.length));
    const rendered: MarkdownLine[] = [];
    for (let lineIndex = 0; lineIndex < height; lineIndex++) {
      const segments: MarkdownSegment[] = [{ text: '│', dim: true }];
      for (let column = 0; column < columns; column++) {
        const cellLine = wrapped[column]![lineIndex] ?? [{ text: '' }];
        const padding = Math.max(0, widths[column]! - segmentWidth(cellLine));
        const align = aligns[column]!;
        const leftPad = align === 'right' ? padding : align === 'center' ? Math.floor(padding / 2) : 0;
        const rightPad = padding - leftPad;
        segments.push({ text: ' ' });
        if (leftPad > 0) segments.push({ text: ' '.repeat(leftPad) });
        segments.push(...cellLine);
        if (rightPad > 0) segments.push({ text: ' '.repeat(rightPad) });
        segments.push({ text: ' ' }, { text: '│', dim: true });
      }
      rendered.push({ segments });
    }
    return rendered;
  };

  const lines: MarkdownLine[] = [border('┌', '┬', '┐')];
  lines.push(...renderRow(headerCells));
  lines.push(border('├', '┼', '┤'));
  for (const row of bodyCells) lines.push(...renderRow(row));
  lines.push(border('└', '┴', '┘'));
  return lines;
}

function renderLine(raw: string, width: number): MarkdownLine[] {
  if (!raw.trim()) return [EMPTY_LINE];

  if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(raw)) {
    return [{ segments: [{ text: '─'.repeat(Math.max(1, width)), dim: true }] }];
  }

  const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw);
  if (heading) {
    return inlineLines(heading[2]!, width, { bold: true, color: 'cyan' });
  }

  const quote = /^\s*>\s?(.*)$/.exec(raw);
  if (quote) return quoteLines(quote[1]!, width);

  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(raw);
  if (bullet) {
    const indent = bullet[1]!.replace(/\t/g, '  ');
    let content = bullet[2]!;
    let marker = `${indent}• `;
    const task = /^\[([ xX])\]\s+(.*)$/.exec(content);
    if (task) {
      marker += task[1]!.toLowerCase() === 'x' ? '☑ ' : '☐ ';
      content = task[2]!;
    }
    return listLines(marker, content, width);
  }

  const numbered = /^(\s*)(\d+[.)])\s+(.*)$/.exec(raw);
  if (numbered) {
    return listLines(`${numbered[1]!.replace(/\t/g, '  ')}${numbered[2]!} `, numbered[3]!, width);
  }

  return inlineLines(raw, width);
}

/**
 * Dependency-free Markdown for assistant replies. It deliberately covers the
 * constructs models use most; unknown syntax falls through as plain text.
 */
export function renderMarkdown(text: string, width: number): MarkdownLine[] {
  const safeWidth = Math.max(4, width);
  const source = sanitizeText(text).replace(/^\n+/, '').replace(/\s+$/, '');
  if (!source) return [EMPTY_LINE];

  const lines: MarkdownLine[] = [];
  const sourceLines = source.split('\n');
  let fence: string | null = null;
  for (let index = 0; index < sourceLines.length; index++) {
    const raw = sourceLines[index]!;
    const match = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (fence) {
      if (match && raw.trim().replace(/[`~]/g, '') === '') {
        fence = null;
      } else {
        lines.push(...codeLines(raw, safeWidth));
      }
      continue;
    }
    if (match) {
      fence = match[1]!;
      continue;
    }

    const next = sourceLines[index + 1];
    if (next !== undefined) {
      const header = splitTableRow(raw);
      const delimiter = splitTableRow(next);
      if (
        header.length >= 2 &&
        delimiter.length === header.length &&
        delimiter.every(isDelimiterCell)
      ) {
        const rows: string[][] = [];
        let end = index + 2;
        while (end < sourceLines.length) {
          const cells = tableRowCells(sourceLines[end]!);
          if (!cells) break;
          rows.push(cells);
          end++;
        }
        const rendered = tableLines(header, delimiter, rows, safeWidth);
        if (rendered) {
          lines.push(...rendered);
          index = end - 1;
          continue;
        }
      }
    }

    lines.push(...renderLine(raw, safeWidth));
  }
  return lines;
}
