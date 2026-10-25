import { createTwoFilesPatch, diffLines } from 'diff';

export interface DiffPreview {
  text: string;
  added: number;
  removed: number;
}

const MAX_PATCH_LINES = 160;

export function buildDiff(displayPath: string, oldText: string, newText: string, isNew = false): DiffPreview {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(oldText, newText)) {
    if (part.added) added += part.count ?? 0;
    if (part.removed) removed += part.count ?? 0;
  }

  const patch = createTwoFilesPatch(
    isNew ? '/dev/null' : `a/${displayPath}`,
    `b/${displayPath}`,
    oldText,
    newText,
    '',
    '',
    { context: 3 },
  );
  const lines = patch
    .replace(/\n$/, '')
    .split('\n')
    .filter((line) => !/^=+$/.test(line));
  const text =
    lines.length > MAX_PATCH_LINES
      ? [...lines.slice(0, MAX_PATCH_LINES), `… (${lines.length - MAX_PATCH_LINES} more diff lines)`].join('\n')
      : lines.join('\n');
  return { text, added, removed };
}

export function truncateMiddle(text: string, max = 20_000): string {
  if (text.length <= max) return text;
  const headLength = Math.floor(max * 0.5);
  const tailLength = max - headLength;
  const omitted = text.length - max;
  return (
    `${text.slice(0, headLength)}\n` +
    `… [${omitted.toLocaleString()} characters omitted] …\n` +
    text.slice(text.length - tailLength)
  );
}
