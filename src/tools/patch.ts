import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyPatch as applyUnified, parsePatch, type StructuredPatch } from 'diff';
import type { ApprovalRequest, Tool } from './types.js';
import { denied, ok, requestApproval, toolError } from './types.js';
import { buildDiff } from './diff.js';
import { MAX_FILE_BYTES, resolvePath, stringArg } from './paths.js';

const MAX_PATCH_CHARS = 1_000_000;
const MAX_PATCH_FILES = 20;
const MAX_PREVIEW_BYTES = 100_000;

interface PlannedFile {
  display: string;
  abs: string;
  outside: boolean;
  isNew: boolean;
  mode: number;
  original: string;
  updated: string;
  added: number;
  removed: number;
}

function headerPath(value: string): string {
  return value.split('\t')[0]!.trim();
}

function stripPrefix(value: string): string {
  const normalized = headerPath(value).split('\\').join('/');
  if (normalized === '/dev/null') return '';
  if (normalized.startsWith('a/') || normalized.startsWith('b/')) return normalized.slice(2);
  return normalized;
}

function planSingleFile(raw: StructuredPatch): { oldPath: string; newPath: string; patch: StructuredPatch } {
  const oldPathRaw = raw.oldFileName ? headerPath(raw.oldFileName) : '';
  const newPathRaw = raw.newFileName ? headerPath(raw.newFileName) : '';
  const oldPath = oldPathRaw === '/dev/null' ? '' : stripPrefix(oldPathRaw);
  const newPath = newPathRaw === '/dev/null' ? '' : stripPrefix(newPathRaw);
  if (!oldPath && !newPath) {
    throw new Error('Patch hunk has no file headers (--- and +++ lines).');
  }
  if (!newPath) {
    throw new Error(
      `Deleting "${oldPath}" is not supported by apply_patch; use run_command only if the user explicitly asked for a deletion.`,
    );
  }
  if (oldPath && oldPath !== newPath) {
    throw new Error(`Renaming "${oldPath}" to "${newPath}" is not supported; apply_patch only edits existing paths.`);
  }
  return { oldPath, newPath, patch: raw };
}

const applyPatchTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'apply_patch',
      description:
        'Apply a unified diff (git style, ---/+++ headers) to one or more files atomically after validating every hunk. Creating files is supported; deleting or renaming is not. Requires user approval.',
      parameters: {
        type: 'object',
        properties: {
          patch: {
            type: 'string',
            description: 'Unified diff text. Use a/ and b/ prefixes or plain paths.',
          },
        },
        required: ['patch'],
        additionalProperties: false,
      },
    },
  },

  async run(input, ctx) {
    const patchText = stringArg(input, 'patch')!;
    if (patchText.length > MAX_PATCH_CHARS) {
      return toolError(`Patch is too large (${patchText.length} chars; limit ${MAX_PATCH_CHARS}).`);
    }

    let patches: StructuredPatch[];
    try {
      patches = parsePatch(patchText);
    } catch (error) {
      return toolError(`Could not parse the patch: ${(error as Error).message}`);
    }
    if (patches.length === 0) return toolError('The patch contains no file changes.');
    if (patches.length > MAX_PATCH_FILES) {
      return toolError(`The patch touches ${patches.length} files; the limit is ${MAX_PATCH_FILES}.`);
    }

    const planned: PlannedFile[] = [];
    const seen = new Set<string>();
    for (const raw of patches) {
      if (raw.isBinary) return toolError(`Binary patches are not supported (${raw.newFileName ?? 'unknown file'}).`);
      let paths;
      try {
        paths = planSingleFile(raw);
      } catch (error) {
        return toolError((error as Error).message);
      }
      if (paths.patch.hunks.length === 0) {
        return toolError(`Patch for ${paths.newPath} contains no hunks.`);
      }

      const resolved = await resolvePath(ctx, paths.newPath);
      if (resolved.abs === path.resolve(ctx.cwd)) {
        return toolError('Refusing to patch the working directory itself.');
      }
      if (seen.has(resolved.abs)) {
        return toolError(`The patch contains more than one change for ${resolved.display}.`);
      }
      seen.add(resolved.abs);

      let original = '';
      let isNew = false;
      let mode = 0o644;
      try {
        const info = await stat(resolved.abs);
        if (info.isDirectory()) return toolError(`${resolved.display} is a directory.`);
        if (!info.isFile()) return toolError(`${resolved.display} is not a regular file.`);
        if (info.size > MAX_FILE_BYTES) return toolError(`${resolved.display} is too large to patch.`);
        if (!paths.oldPath) {
          return toolError(`Cannot create ${resolved.display}: the file already exists.`);
        }
        original = await readFile(resolved.abs, 'utf8');
        mode = info.mode & 0o777;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          return toolError(`Cannot inspect ${resolved.display}: ${(error as Error).message}`);
        }
        if (paths.oldPath) {
          return toolError(`File not found: ${resolved.display}.`);
        }
        isNew = true;
      }

      const updated = applyUnified(original, paths.patch);
      if (updated === false) {
        return toolError(
          `Patch does not apply cleanly to ${resolved.display}; no files were written. ` +
            'Read the file and regenerate the diff with exact context lines.',
        );
      }
      const preview = buildDiff(resolved.display, original, updated, isNew);
      planned.push({
        display: resolved.display,
        abs: resolved.abs,
        outside: resolved.outside,
        isNew,
        mode,
        original,
        updated,
        added: preview.added,
        removed: preview.removed,
      });
    }

    const added = planned.reduce((total, file) => total + file.added, 0);
    const removed = planned.reduce((total, file) => total + file.removed, 0);
    const detail = planned
      .map((file) => `${file.isNew ? '# New file: ' : '### '}${file.display}\n${buildDiff(
        file.display,
        file.original,
        file.updated,
        file.isNew,
      ).text}`)
      .join('\n\n');
    const request: ApprovalRequest = {
      tool: 'apply_patch',
      title: `Apply patch to ${planned.length} file${planned.length === 1 ? '' : 's'} (+${added} -${removed})`,
      detail:
        detail.length > MAX_PREVIEW_BYTES
          ? `${detail.slice(0, MAX_PREVIEW_BYTES)}\n… [preview truncated]`
          : detail,
      warning: planned.some((file) => file.outside)
        ? `Some paths are outside the working directory: ${planned
            .filter((file) => file.outside)
            .map((file) => file.abs)
            .join(', ')}`
        : undefined,
    };
    if (!(await requestApproval(ctx, request))) return denied();
    if (ctx.signal.aborted) return denied('Cancelled by user.');

    const staged: { temp: string; target: string }[] = [];
    try {
      for (const file of planned) {
        await mkdir(path.dirname(file.abs), { recursive: true });
        const temp = `${file.abs}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
        await writeFile(temp, file.updated, { encoding: 'utf8', mode: file.mode });
        staged.push({ temp, target: file.abs });
      }
    } catch (error) {
      await Promise.all(staged.map((entry) => unlink(entry.temp).catch(() => undefined)));
      return toolError(`Could not stage the patch; no files were written: ${(error as Error).message}`);
    }
    try {
      for (const entry of staged) await rename(entry.temp, entry.target);
    } catch (error) {
      await Promise.all(staged.map((entry) => unlink(entry.temp).catch(() => undefined)));
      return toolError(`Could not finish applying the patch: ${(error as Error).message}`);
    }

    const fileList = planned
      .map((file) => `  ${file.isNew ? 'created ' : 'updated '}${file.display} (+${file.added} -${file.removed})`)
      .join('\n');
    return ok(
      `Applied patch to ${planned.length} file${planned.length === 1 ? '' : 's'} (+${added} -${removed}):\n${fileList}`,
      `patched ${planned.length} file${planned.length === 1 ? '' : 's'} (+${added} -${removed})`,
    );
  },
};

export const patchTools: Tool[] = [applyPatchTool];
