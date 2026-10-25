import { mkdir, readFile, rename, rm, stat, writeFile, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * File snapshots taken just before Kiro mutates workspace files, so a mistaken
 * edit can be taken back with /undo. Snapshots live under
 * ~/.kiro/checkpoints/<cwd-hash>/ and cost either a copy of the old bytes or a
 * marker recording that the tool call created the file.
 *
 * run_command is not checkpointed: a shell command can touch anything, and
 * snapshotting the whole workspace on every call would be too expensive.
 */

const MAX_CHECKPOINTS = 30;

export interface CheckpointFile {
  /** Absolute path in the workspace. */
  abs: string;
  /** Backup holding the previous bytes, or null when the file did not exist yet. */
  backup: string | null;
}

export interface CheckpointEntry {
  id: string;
  tool: string;
  files: CheckpointFile[];
  createdAt: string;
}

interface Manifest {
  entries: CheckpointEntry[];
}

function checkpointsRoot(): string {
  return process.env.KIRO_CHECKPOINTS_DIR || path.join(homedir(), '.kiro', 'checkpoints');
}

function projectCheckpointsDir(cwd: string): string {
  const key = createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16);
  return path.join(checkpointsRoot(), key);
}

function manifestPath(cwd: string): string {
  return path.join(projectCheckpointsDir(cwd), 'manifest.json');
}

function entryDir(cwd: string, entryId: string): string {
  return path.join(projectCheckpointsDir(cwd), entryId);
}

function emptyManifest(): Manifest {
  return { entries: [] };
}

async function readManifest(cwd: string): Promise<Manifest> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath(cwd), 'utf8'));
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.entries)) {
      const entries = parsed.entries.filter(
        (entry: unknown) =>
          entry !== null &&
          typeof entry === 'object' &&
          Array.isArray((entry as CheckpointEntry).files),
      ) as CheckpointEntry[];
      return { entries };
    }
  } catch {
    // No manifest yet: a fresh store.
  }
  return emptyManifest();
}

async function writeManifest(cwd: string, manifest: Manifest): Promise<void> {
  const dir = projectCheckpointsDir(cwd);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = `${manifestPath(cwd)}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, manifestPath(cwd));
}

function prune(cwd: string, entries: CheckpointEntry[]): CheckpointEntry[] {
  const dropped = entries.slice(0, Math.max(0, entries.length - MAX_CHECKPOINTS));
  for (const entry of dropped) {
    void rm(entryDir(cwd, entry.id), { recursive: true, force: true }).catch(() => undefined);
  }
  return entries.slice(-MAX_CHECKPOINTS);
}

/**
 * Reads every file that is about to be changed. Call this before the first
 * write of a tool call; paths are absolute and each entry is stored once.
 */
export async function snapshotBeforeMutation(
  cwd: string,
  tool: string,
  absPaths: string[],
): Promise<void> {
  if (absPaths.length === 0) return;
  try {
    const unique = [...new Set(absPaths.filter((abs) => path.isAbsolute(abs)))];
    if (unique.length === 0) return;
    const snapshot: { abs: string; data: Buffer | null }[] = [];
    for (const abs of unique) {
      try {
        const info = await stat(abs);
        if (info.isDirectory()) continue;
        snapshot.push({ abs, data: await readFile(abs) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          snapshot.push({ abs, data: null });
        }
        // Other read errors: skip this path; /undo will simply not restore it.
      }
    }
    if (snapshot.length === 0) return;

    const entries = prune(cwd, (await readManifest(cwd)).entries);
    const entry: CheckpointEntry = {
      id: `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
      tool,
      files: [],
      createdAt: new Date().toISOString(),
    };
    if (snapshot.some((file) => file.data !== null)) {
      await mkdir(entryDir(cwd, entry.id), { recursive: true, mode: 0o700 });
    }
    for (const [index, file] of snapshot.entries()) {
      let backup: string | null = null;
      if (file.data !== null) {
        backup = path.join(entryDir(cwd, entry.id), `${index}.bin`);
        await writeFile(backup, file.data, { mode: 0o600 });
      }
      entry.files.push({ abs: file.abs, backup });
    }
    entries.push(entry);
    await writeManifest(cwd, { entries });
  } catch {
    // Snapshots are best effort; a failed snapshot never blocks the tool.
  }
}

export interface UndoResult {
  tool: string;
  restored: string[];
  deleted: string[];
}

/**
 * Reverts the most recent recorded tool call. Repeated calls step back through
 * history. Returns null when there is nothing recorded.
 */
export async function undoLastCheckpoint(cwd: string): Promise<UndoResult | null> {
  const manifest = await readManifest(cwd);
  if (manifest.entries.length === 0) return null;
  const entry = manifest.entries[manifest.entries.length - 1]!;
  const restored: string[] = [];
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const file of entry.files) {
    if (file.backup) {
      try {
        await writeFile(file.abs, await readFile(file.backup));
        restored.push(file.abs);
      } catch {
        failed.push(file.abs);
      }
      continue;
    }
    // The tool created this file; undo removes it again.
    try {
      await unlink(file.abs);
      deleted.push(file.abs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') deleted.push(file.abs);
      else failed.push(file.abs);
    }
  }
  if (failed.length > 0) {
    // Keep the entry so a later /undo can retry instead of skipping the call.
    throw new Error(
      `could not undo ${entry.tool}: ${failed.join(', ')} could not be written or removed. ` +
        'Fix the permissions and run /undo again.',
    );
  }
  manifest.entries.pop();
  await writeManifest(cwd, manifest);
  void rm(entryDir(cwd, entry.id), { recursive: true, force: true }).catch(() => undefined);
  return { tool: entry.tool, restored, deleted };
}
