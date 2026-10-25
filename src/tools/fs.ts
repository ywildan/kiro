import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import type { Tool } from './types.js';
import {
  denied,
  ok,
  requestApproval,
  toolError,
  type ApprovalRequest,
  type ToolContext,
} from './types.js';
import { buildDiff } from './diff.js';
import { snapshotBeforeMutation } from './checkpoint.js';
import {
  booleanArg,
  integerArg,
  MAX_FILE_BYTES,
  resolvePath,
  stringArg,
} from './paths.js';

const MAX_READ_BYTES = 30_000;
const MAX_READ_LINES = 2_000;
const DEFAULT_READ_LINES = 400;
const MAX_LIST_ENTRIES = 500;
const MAX_PREVIEW_BYTES = 100_000;
const MAX_EDITS = 50;

function countLines(text: string): number {
  if (!text) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function previewText(text: string): string {
  if (text.length <= MAX_PREVIEW_BYTES) return text;
  return (
    text.slice(0, MAX_PREVIEW_BYTES) +
    `\n… [preview truncated: ${text.length - MAX_PREVIEW_BYTES} more characters]`
  );
}

const readFileTool: Tool = {
  readOnly: true,
  definition: {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a text file from the working directory. Returns numbered lines. Use offset and limit to page through large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the working directory.' },
          offset: { type: 'integer', description: 'First line to read (1-based). Default 1.' },
          limit: { type: 'integer', description: 'Maximum number of lines to return. Default 400.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },

  async run(input, ctx) {
    const rawPath = stringArg(input, 'path')!;
    const offset = integerArg(input, 'offset', 1, 1, 10_000_000);
    const limit = integerArg(input, 'limit', DEFAULT_READ_LINES, 1, MAX_READ_LINES);
    const resolved = await resolvePath(ctx, rawPath);
    if (resolved.outside) {
      return toolError(
        `Path "${rawPath}" is outside the working directory (${resolved.abs}). Reading outside the workspace is not allowed.`,
      );
    }
    const info = await stat(resolved.abs).catch((error: NodeJS.ErrnoException) => {
      throw new Error(
        error.code === 'ENOENT' ? `File not found: ${resolved.display}` : `Cannot read ${resolved.display}: ${error.message}`,
      );
    });
    if (info.isDirectory()) {
      return toolError(`${resolved.display} is a directory. Use list_dir to inspect it.`);
    }
    if (!info.isFile()) {
      return toolError(`${resolved.display} is not a regular file.`);
    }
    if (info.size > MAX_FILE_BYTES) {
      return toolError(
        `${resolved.display} is too large to read (${info.size} bytes). Use run_command with head/tail/sed for a targeted view.`,
      );
    }

    const stream = createReadStream(resolved.abs, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const output: string[] = [];
    let bytes = 0;
    let lineNumber = 0;
    let hasMore = false;
    let byteCapped = false;
    let binary = false;

    const onAbort = () => {
      rl.close();
      stream.destroy();
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    try {
      for await (const line of rl) {
        lineNumber++;
        if (ctx.signal.aborted) throw new Error('Cancelled by user.');
        if (lineNumber < offset) continue;
        if (line.includes('\0')) {
          binary = true;
          break;
        }
        if (output.length >= limit) {
          hasMore = true;
          break;
        }
        const formatted = `${String(lineNumber).padStart(5)}\t${line}`;
        if (bytes + formatted.length + 1 > MAX_READ_BYTES) {
          hasMore = true;
          byteCapped = true;
          break;
        }
        output.push(formatted);
        bytes += formatted.length + 1;
      }
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      rl.close();
      stream.destroy();
    }

    if (binary) {
      return toolError(`${resolved.display} appears to be a binary file; refusing to print it.`);
    }
    if (output.length === 0) {
      return ok(
        lineNumber === 0
          ? `${resolved.display} is empty.`
          : `${resolved.display} has fewer than ${offset} lines.`,
        `read ${resolved.display} (empty)`,
      );
    }

    const notes: string[] = [];
    if (hasMore) {
      const next = offset + output.length;
      notes.push(
        byteCapped
          ? `[Output truncated at ${MAX_READ_BYTES.toLocaleString()} characters. Use offset=${next} to continue.]`
          : `[Truncated at ${limit} lines. Use offset=${next} to continue.]`,
      );
    }
    const header = `${resolved.display} (lines ${offset}-${offset + output.length - 1}${hasMore ? ', more available' : ''}):`;
    const content = [header, ...output, ...notes].join('\n');
    return ok(content, `read ${resolved.display} (${output.length} lines)`);
  },
};

const writeFileTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create a new file or overwrite an existing file with the given content. Parent directories are created as needed. Requires user approval.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the working directory.' },
          content: { type: 'string', description: 'Complete file content to write.' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },

  async run(input, ctx) {
    const rawPath = stringArg(input, 'path')!;
    const rawContent = stringArg(input, 'content', true);
    if (rawContent === undefined) throw new Error('Missing required argument "content".');
    const content = rawContent;
    const resolved = await resolvePath(ctx, rawPath);
    if (resolved.abs === path.resolve(ctx.cwd)) {
      return toolError('Refusing to write to the working directory itself; provide a file path.');
    }

    let existing: string | null = null;
    let exists = false;
    let existingOmitted = false;
    try {
      const info = await stat(resolved.abs);
      if (info.isDirectory()) return toolError(`${resolved.display} is a directory.`);
      exists = true;
      if (info.size <= MAX_PREVIEW_BYTES) {
        existing = await readFile(resolved.abs, 'utf8');
      } else {
        existingOmitted = true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return toolError(`Cannot inspect ${resolved.display}: ${(error as Error).message}`);
      }
    }

    let detail: string;
    let added = 0;
    let removed = 0;
    if (existingOmitted) {
      const newLines = countLines(content);
      detail =
        `Existing file is too large for a diff preview. It will be replaced with ` +
        `${newLines} lines (${content.length.toLocaleString()} bytes).\n\n` +
        previewText(content.split('\n').slice(0, 12).join('\n'));
    } else {
      const preview = buildDiff(resolved.display, previewText(existing ?? ''), previewText(content), !exists);
      detail = preview.text || 'No changes to content.';
      added = preview.added;
      removed = preview.removed;
    }

    const request: ApprovalRequest = {
      tool: 'write_file',
      title: `${exists ? 'Overwrite' : 'Create'} ${resolved.display}`,
      detail,
      warning: resolved.outside
        ? `This path is outside the working directory: ${resolved.abs}`
        : undefined,
    };
    if (!(await requestApproval(ctx, request))) return denied();
    if (ctx.signal.aborted) return denied('Cancelled by user.');
    await snapshotBeforeMutation(ctx.cwd, 'write_file', [resolved.abs]);

    await mkdir(path.dirname(resolved.abs), { recursive: true });
    await writeFile(resolved.abs, content, 'utf8');
    const lines = countLines(content);
    const change = `+${added} -${removed}`;
    return ok(
      `${exists ? 'Overwrote' : 'Created'} ${resolved.display} (${lines} line${lines === 1 ? '' : 's'}, ${change}).`,
      `${exists ? 'overwrote' : 'created'} ${resolved.display} (${change})`,
    );
  },
};

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function diceCoefficient(left: string, right: string): number {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = new Map<string, number>();
  for (let index = 0; index < a.length - 1; index++) {
    const pair = a.slice(index, index + 2);
    bigrams.set(pair, (bigrams.get(pair) ?? 0) + 1);
  }
  let overlap = 0;
  for (let index = 0; index < b.length - 1; index++) {
    const pair = b.slice(index, index + 2);
    const count = bigrams.get(pair) ?? 0;
    if (count > 0) {
      overlap++;
      bigrams.set(pair, count - 1);
    }
  }
  return (2 * overlap) / (a.length + b.length - 2);
}

function closestLine(
  original: string,
  needle: string,
): { lineNumber: number; text: string; score: number } | null {
  const lines = original.split('\n');
  const normalizedNeedle = normalizeWhitespace(needle).slice(0, 200);
  if (!normalizedNeedle) return null;
  let best: { lineNumber: number; text: string; score: number } | null = null;
  for (let index = 0; index < lines.length; index++) {
    const candidate = lines[index]!;
    if (normalizeWhitespace(candidate) === normalizedNeedle) {
      return { lineNumber: index + 1, text: candidate, score: 1 };
    }
    if (Math.abs(candidate.length - normalizedNeedle.length) > normalizedNeedle.length * 2 + 40) {
      continue;
    }
    const score = diceCoefficient(normalizedNeedle, normalizeWhitespace(candidate).slice(0, 200));
    if (score > (best?.score ?? 0.55)) best = { lineNumber: index + 1, text: candidate, score };
  }
  return best;
}

function notFoundHint(original: string, oldString: string): string {
  const crlfMismatch = original.includes('\r\n') && !oldString.includes('\r');
  const whitespaceInsensitive =
    normalizeWhitespace(original).includes(normalizeWhitespace(oldString)) &&
    normalizeWhitespace(oldString).length > 0;
  const compact = (text: string): string => text.replace(/\s+/g, '');
  const spacingInsensitive = compact(original).includes(compact(oldString));
  const nearest = closestLine(original, oldString.split('\n').find((line) => line.trim()) ?? oldString);
  const hints: string[] = [];
  if (crlfMismatch) {
    hints.push('The file uses CRLF line endings; old_string must match them exactly.');
  }
  if (whitespaceInsensitive || spacingInsensitive) {
    hints.push(
      'The text exists, but spacing or indentation differs. Copy the exact whitespace from the file.',
    );
  }
  if (nearest) {
    const preview = nearest.text.length > 160 ? `${nearest.text.slice(0, 160)}…` : nearest.text;
    hints.push(`Closest line ${nearest.lineNumber}: ${JSON.stringify(preview)}`);
  }
  if (hints.length === 0) {
    hints.push('Read the file and copy the exact text, including whitespace and punctuation.');
  }
  return `old_string was not found.\nHint: ${hints.join('\n- ')}`;
}

function replaceOccurrences(original: string, oldString: string, newString: string): string {
  return original.split(oldString).join(newString);
}

interface EditOperation {
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

function parseEditObject(raw: unknown, index: number): EditOperation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`edits[${index}] must be an object with old_string and new_string.`);
  }
  const record = raw as Record<string, unknown>;
  const oldString = record.old_string;
  const newString = record.new_string;
  if (typeof oldString !== 'string' || oldString.length === 0) {
    throw new Error(`edits[${index}].old_string must be a non-empty string.`);
  }
  if (typeof newString !== 'string') {
    throw new Error(`edits[${index}].new_string must be a string.`);
  }
  if (record.replace_all !== undefined && typeof record.replace_all !== 'boolean') {
    throw new Error(`edits[${index}].replace_all must be a boolean.`);
  }
  if (oldString.includes('\0') || newString.includes('\0')) {
    throw new Error(`edits[${index}] contains a NUL byte.`);
  }
  return { oldString, newString, replaceAll: record.replace_all === true };
}

function parseEdits(input: Record<string, unknown>): EditOperation[] {
  const raw = input.edits;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('Argument "edits" must be a non-empty array.');
  }
  if (raw.length > MAX_EDITS) {
    throw new Error(`Argument "edits" may contain at most ${MAX_EDITS} entries.`);
  }
  return raw.map((entry, index) => parseEditObject(entry, index));
}

const editFileTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace exact text in an existing file. old_string must be unique unless replace_all is true. Returns a hint when old_string is not found. Requires user approval.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the working directory.' },
          old_string: { type: 'string', description: 'Exact existing text to replace.' },
          new_string: { type: 'string', description: 'Replacement text (may be empty to delete).' },
          replace_all: {
            type: 'boolean',
            description: 'Replace every occurrence instead of requiring a unique match. Default false.',
          },
        },
        required: ['path', 'old_string', 'new_string'],
        additionalProperties: false,
      },
    },
  },

  async run(input, ctx) {
    const rawPath = stringArg(input, 'path')!;
    const oldString = stringArg(input, 'old_string')!;
    const rawNewString = stringArg(input, 'new_string', true);
    if (rawNewString === undefined) throw new Error('Missing required argument "new_string".');
    const newString = rawNewString;
    const replaceAll = booleanArg(input, 'replace_all', false);
    const resolved = await resolvePath(ctx, rawPath);

    let original: string;
    try {
      const info = await stat(resolved.abs);
      if (info.isDirectory()) return toolError(`${resolved.display} is a directory.`);
      if (info.size > MAX_FILE_BYTES) return toolError(`${resolved.display} is too large to edit safely.`);
      original = await readFile(resolved.abs, 'utf8');
    } catch (error) {
      return toolError(`Cannot read ${resolved.display}: ${(error as Error).message}`);
    }

    const occurrences = original.split(oldString).length - 1;
    if (occurrences === 0) {
      return toolError(`In ${resolved.display}, ${notFoundHint(original, oldString)}`);
    }
    if (occurrences > 1 && !replaceAll) {
      return toolError(
        `old_string appears ${occurrences} times in ${resolved.display}; it must be unique. ` +
          'Include more surrounding context, or set replace_all=true to replace every occurrence.',
      );
    }

    const updated = replaceOccurrences(original, oldString, newString);
    const replacements = replaceAll ? occurrences : 1;
    const preview = buildDiff(resolved.display, previewText(original), previewText(updated));
    const request: ApprovalRequest = {
      tool: 'edit_file',
      title: `Edit ${resolved.display}${replacements > 1 ? ` (${replacements} replacements)` : ''}`,
      detail: preview.text,
      warning: resolved.outside
        ? `This path is outside the working directory: ${resolved.abs}`
        : undefined,
    };
    if (!(await requestApproval(ctx, request))) return denied();
    if (ctx.signal.aborted) return denied('Cancelled by user.');
    await snapshotBeforeMutation(ctx.cwd, 'edit_file', [resolved.abs]);

    await writeFile(resolved.abs, updated, 'utf8');
    const change = `+${preview.added} -${preview.removed}`;
    return ok(
      `Edited ${resolved.display} (${replacements} replacement${replacements === 1 ? '' : 's'}, ${change}).`,
      `edited ${resolved.display} (${change})`,
    );
  },
};

const multiEditTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'multi_edit',
      description:
        'Apply several exact text replacements to one file atomically. Every edit is validated before the file is written, so a single failure leaves the file unchanged. Requires user approval.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the working directory.' },
          edits: {
            type: 'array',
            description: 'Replacements applied in order.',
            items: {
              type: 'object',
              properties: {
                old_string: { type: 'string', description: 'Exact existing text.' },
                new_string: { type: 'string', description: 'Replacement text.' },
                replace_all: {
                  type: 'boolean',
                  description: 'Replace every occurrence. Default false.',
                },
              },
              required: ['old_string', 'new_string'],
              additionalProperties: false,
            },
          },
        },
        required: ['path', 'edits'],
        additionalProperties: false,
      },
    },
  },

  async run(input, ctx) {
    const rawPath = stringArg(input, 'path')!;
    const edits = parseEdits(input);
    const resolved = await resolvePath(ctx, rawPath);

    let original: string;
    try {
      const info = await stat(resolved.abs);
      if (info.isDirectory()) return toolError(`${resolved.display} is a directory.`);
      if (info.size > MAX_FILE_BYTES) return toolError(`${resolved.display} is too large to edit safely.`);
      original = await readFile(resolved.abs, 'utf8');
    } catch (error) {
      return toolError(`Cannot read ${resolved.display}: ${(error as Error).message}`);
    }

    let updated = original;
    for (const [index, edit] of edits.entries()) {
      const occurrences = updated.split(edit.oldString).length - 1;
      if (occurrences === 0) {
        return toolError(
          `Edit ${index + 1} of ${edits.length} failed; no changes were written. ` +
            notFoundHint(updated, edit.oldString),
        );
      }
      if (occurrences > 1 && !edit.replaceAll) {
        return toolError(
          `Edit ${index + 1} of ${edits.length} failed; no changes were written. ` +
            `old_string appears ${occurrences} times in ${resolved.display}; include more context or set replace_all=true.`,
        );
      }
      updated = replaceOccurrences(updated, edit.oldString, edit.newString);
    }

    const preview = buildDiff(resolved.display, previewText(original), previewText(updated));
    const request: ApprovalRequest = {
      tool: 'multi_edit',
      title: `Edit ${edits.length} location${edits.length === 1 ? '' : 's'} in ${resolved.display}`,
      detail: preview.text,
      warning: resolved.outside
        ? `This path is outside the working directory: ${resolved.abs}`
        : undefined,
    };
    if (!(await requestApproval(ctx, request))) return denied();
    if (ctx.signal.aborted) return denied('Cancelled by user.');
    await snapshotBeforeMutation(ctx.cwd, 'multi_edit', [resolved.abs]);

    await writeFile(resolved.abs, updated, 'utf8');
    const change = `+${preview.added} -${preview.removed}`;
    return ok(
      `Edited ${resolved.display} (${edits.length} edit${edits.length === 1 ? '' : 's'}, ${change}).`,
      `edited ${resolved.display} (${change})`,
    );
  },
};


const listDirTool: Tool = {
  readOnly: true,
  definition: {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List the immediate contents of a directory (non-recursive). Directories end with "/".',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to the working directory. Default ".".' },
        },
        additionalProperties: false,
      },
    },
  },

  async run(input, ctx) {
    const rawPath = stringArg(input, 'path', true) ?? '.';
    const resolved = await resolvePath(ctx, rawPath);
    if (resolved.outside) {
      return toolError(
        `Path "${rawPath}" is outside the working directory (${resolved.abs}). Listing outside the workspace is not allowed.`,
      );
    }
    let info;
    try {
      info = await stat(resolved.abs);
    } catch (error) {
      return toolError(`Cannot list ${resolved.display}: ${(error as Error).message}`);
    }
    if (!info.isDirectory()) {
      return toolError(`${resolved.display} is not a directory. Use read_file for files.`);
    }
    const entries = await readdir(resolved.abs, { withFileTypes: true });
    entries.sort((a, b) => {
      const aDir = a.isDirectory() ? 0 : 1;
      const bDir = b.isDirectory() ? 0 : 1;
      return aDir - bDir || a.name.localeCompare(b.name);
    });
    const limited = entries.slice(0, MAX_LIST_ENTRIES);
    const lines = limited.map((entry) => {
      if (entry.isDirectory()) return `${entry.name}/`;
      if (entry.isSymbolicLink()) return `${entry.name} @`;
      return entry.name;
    });
    const notes = entries.length > limited.length ? [`… ${entries.length - limited.length} more entries omitted`] : [];
    const content =
      lines.length === 0
        ? `${resolved.display}/ is empty.`
        : [`${resolved.display}/`, ...lines, ...notes].join('\n');
    const count = Math.min(entries.length, MAX_LIST_ENTRIES);
    return ok(content, `listed ${resolved.display} (${count} entr${count === 1 ? 'y' : 'ies'})`);
  },
};

export const fsTools: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  multiEditTool,
  listDirTool,
];
