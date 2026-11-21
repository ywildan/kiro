/**
 * Windows the rows shown in an approval prompt.
 *
 * The prompt asks the user to approve a change, so the preview must show what
 * actually changes. A unified diff starts with header lines that would
 * otherwise eat most of the budget, so headers are dropped and the first hunk
 * is windowed around its first change. Long commands keep both ends, because
 * the destructive half (`rm -rf`, `curl | sh`) is often the last line.
 *
 * Rows are already fitted to the prompt width before they get here.
 */

export const MAX_PREVIEW_LINES = 6;

const DIFF_HEADER =
  /^(---|\+\+\+|diff --git|index |new file |deleted file |similarity index|rename |Binary files)/;

function isHunk(line: string): boolean {
  return line.startsWith('@@');
}

function isChange(line: string): boolean {
  return (
    (line.startsWith('+') || line.startsWith('-')) &&
    !line.startsWith('+++') &&
    !line.startsWith('---')
  );
}

/** Hides the middle of a list, keeping `head` leading and the rest trailing. */
function windowed(lines: string[], budget: number, head: number): string[] {
  if (lines.length <= budget) return lines;
  const showHead = Math.max(1, Math.min(head, budget - 1));
  const showTail = Math.max(0, budget - showHead - 1);
  const hidden = lines.length - showHead - showTail;
  return [
    ...lines.slice(0, showHead),
    `… ${hidden} line${hidden === 1 ? '' : 's'} hidden …`,
    ...(showTail > 0 ? lines.slice(lines.length - showTail) : []),
  ];
}

function diffBody(lines: string[], budget: number): string[] {
  const hunks = lines.filter(isHunk);
  const body = lines.filter((line) => !isHunk(line) && !DIFF_HEADER.test(line));
  const hunkBudget = hunks.length > 0 ? 1 : 0;
  const moreBudget = hunks.length > 1 ? 1 : 0;
  const bodyBudget = Math.max(1, budget - hunkBudget - moreBudget);

  let shown: string[];
  if (body.length <= bodyBudget) {
    shown = body;
  } else {
    // Slide the window so the first change is visible, not just the context.
    const visible = Math.max(1, bodyBudget - 1);
    const firstChange = body.findIndex(isChange);
    const start = Math.min(
      Math.max(0, body.length - visible),
      Math.max(0, firstChange === -1 ? 0 : Math.max(0, firstChange - 1)),
    );
    const slice = body.slice(start, start + visible);
    const hiddenBefore = start;
    const hiddenAfter = body.length - start - slice.length;
    const parts = [
      hiddenBefore > 0 ? `${hiddenBefore} before` : '',
      hiddenAfter > 0 ? `${hiddenAfter} after` : '',
    ].filter(Boolean);
    shown = [...slice, `… ${parts.join(', ')} hidden …`];
  }

  const out: string[] = [];
  if (hunks.length > 0) out.push(hunks[0]!);
  out.push(...shown);
  if (hunks.length > 1) out.push(`… ${hunks.length - 1} more hunk${hunks.length === 2 ? '' : 's'} …`);
  return out.slice(0, budget);
}

/**
 * Returns at most `budget` rows for the prompt. Diffs drop their file headers
 * and hunk markers; anything else keeps both ends when it does not fit.
 */
export function windowPreview(
  rows: string[],
  tool: string,
  budget: number = MAX_PREVIEW_LINES,
): string[] {
  const limit = Math.max(1, budget);
  if (rows.length === 0) return [];
  if (tool !== 'run_command' && rows.some(isHunk)) {
    return diffBody(rows, limit);
  }
  const head = Math.max(1, Math.ceil((limit - 1) / 2));
  return windowed(rows, limit, head);
}
