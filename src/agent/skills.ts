import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const MAX_SKILLS_IN_PROMPT = 30;
export const MAX_SKILL_DESCRIPTION_CHARS = 300;
export const MAX_SKILL_SHORT_DESCRIPTION_CHARS = 60;
export const MAX_SKILL_BODY_CHARS = 50_000;
export const MAX_SKILL_FILE_BYTES = 200_000;
export const MAX_SKILLS_INDEX_CHARS = 8_000;
/** Skills are found at <root>/<name>/SKILL.md and <root>/<group>/<name>/SKILL.md. */
export const MAX_SKILL_DEPTH = 2;
const MAX_SKILL_NAME_CHARS = 64;
const MAX_SKILL_DIRS_PER_ROOT = 500;
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SKIP_DIR_NAMES = new Set(['node_modules', '.git']);

let skillsEnabled = true;

/** Turned off by --no-skills or KIRO_NO_SKILLS; nothing is read from disk then. */
export function setSkillsEnabled(enabled: boolean): void {
  skillsEnabled = enabled;
}

export function skillsAreEnabled(): boolean {
  return skillsEnabled;
}

export type SkillSource = 'project' | 'user';

export interface Skill {
  name: string;
  description: string;
  body: string;
  /** Directory that holds SKILL.md and any supporting files. */
  dir: string;
  file: string;
  source: SkillSource;
}

export interface InvalidSkill {
  name: string;
  file: string;
  source: SkillSource;
  reason: string;
}

export interface SkillInventory {
  skills: Skill[];
  invalid: InvalidSkill[];
  roots: string[];
  disabled: boolean;
}

interface SkillRoot {
  root: string;
  source: SkillSource;
}

/** `.claude/skills` is read too, so skills installed for other CLIs work unchanged. */
export function skillRoots(cwd: string): SkillRoot[] {
  const roots: SkillRoot[] = [
    { root: path.join(cwd, '.kiro', 'skills'), source: 'project' },
    { root: path.join(cwd, '.claude', 'skills'), source: 'project' },
  ];
  const override = process.env.KIRO_SKILLS_DIR?.trim();
  if (override) {
    roots.push({ root: path.resolve(override), source: 'user' });
  } else {
    const home = homedir();
    roots.push({ root: path.join(home, '.kiro', 'skills'), source: 'user' });
    roots.push({ root: path.join(home, '.claude', 'skills'), source: 'user' });
  }
  const seen = new Set<string>();
  return roots.filter(({ root }) => {
    if (seen.has(root)) return false;
    seen.add(root);
    return true;
  });
}

export type ParseSkillResult =
  | { ok: true; value: { name?: string; description: string; body: string } }
  | { ok: false; reason: string };

function cleanValue(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1).trim();
    }
  }
  return value;
}

/** Reads the simple `key: value` frontmatter skills use; nested YAML is ignored. */
function parseMeta(lines: string[]): Map<string, string> {
  const meta = new Map<string, string>();
  let key: string | null = null;
  let continuation: string[] = [];
  const commit = (): void => {
    if (key !== null && continuation.length > 0) meta.set(key, cleanValue(continuation.join(' ')));
    key = null;
    continuation = [];
  };
  for (const line of lines) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (match) {
      commit();
      const name = match[1]!.toLowerCase();
      const value = (match[2] ?? '').trim();
      const quote = value[0];
      const quotedOpen =
        (quote === '"' || quote === "'") &&
        !(value.length > 1 && value.endsWith(quote));
      if (value === '' || /^[>|][+-]?$/.test(value) || quotedOpen) {
        key = name;
        continuation = value === '' || /^[>|][+-]?$/.test(value) ? [] : [value];
      } else {
        meta.set(name, cleanValue(value));
      }
      continue;
    }
    if (key !== null && /^\s+\S/.test(line)) {
      continuation.push(line.trim());
      continue;
    }
    commit();
  }
  commit();
  return meta;
}

export function parseSkillFile(raw: string): ParseSkillResult {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') {
    return { ok: false, reason: 'missing frontmatter: the file must start with ---' };
  }
  let close = -1;
  for (let index = 1; index < lines.length; index++) {
    if (lines[index]?.trim() === '---') {
      close = index;
      break;
    }
  }
  if (close === -1) return { ok: false, reason: 'unterminated frontmatter block' };

  const meta = parseMeta(lines.slice(1, close));
  const description = (meta.get('description') ?? '').replace(/\s+/g, ' ').trim();
  if (!description) return { ok: false, reason: 'frontmatter is missing a description' };
  const body = lines.slice(close + 1).join('\n').trim();
  if (!body) return { ok: false, reason: 'the skill has no instructions after the frontmatter' };
  return {
    ok: true,
    value: { name: meta.get('name')?.trim() || undefined, description, body },
  };
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function readSkillAt(
  dir: string,
  folder: string,
): Promise<{ skill?: Omit<Skill, 'source'>; invalid?: { name: string; file: string; reason: string } }> {
  const file = path.join(dir, 'SKILL.md');
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return {};
    return { invalid: { name: folder, file, reason: (error as Error).message } };
  }
  if (!info.isFile()) return {};
  if (info.size > MAX_SKILL_FILE_BYTES) {
    return {
      invalid: {
        name: folder,
        file,
        reason: `SKILL.md is larger than ${MAX_SKILL_FILE_BYTES.toLocaleString()} bytes`,
      },
    };
  }
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    return { invalid: { name: folder, file, reason: (error as Error).message } };
  }
  const parsed = parseSkillFile(raw);
  if (!parsed.ok) return { invalid: { name: folder, file, reason: parsed.reason } };

  const name = parsed.value.name ?? folder;
  if (name.length > MAX_SKILL_NAME_CHARS || !SKILL_NAME_PATTERN.test(name)) {
    return {
      invalid: {
        name,
        file,
        reason: 'the name may only contain letters, digits, dots, dashes, and underscores',
      },
    };
  }
  return {
    skill: {
      name,
      description: parsed.value.description,
      body: parsed.value.body,
      dir,
      file,
    },
  };
}

interface ScanContext {
  skills: Skill[];
  invalid: InvalidSkill[];
  byName: Map<string, Skill>;
  /** Realpaths already walked, so symlink loops cannot recurse forever. */
  visited: Set<string>;
  dirs: number;
}

function addSkill(ctx: ScanContext, skill: Omit<Skill, 'source'>, source: SkillSource): void {
  const existing = ctx.byName.get(skill.name.toLowerCase());
  if (existing) {
    ctx.invalid.push({
      name: skill.name,
      file: skill.file,
      source,
      reason: `duplicate name; ${existing.file} already defines it`,
    });
    return;
  }
  const complete: Skill = { ...skill, source };
  ctx.skills.push(complete);
  ctx.byName.set(skill.name.toLowerCase(), complete);
}

/** Returns true when a skill was found at or below dir. */
async function walk(ctx: ScanContext, dir: string, depth: number, source: SkillSource): Promise<boolean> {
  let resolved: string;
  try {
    resolved = await realpath(dir);
  } catch {
    return false;
  }
  if (ctx.visited.has(resolved)) return false;
  ctx.visited.add(resolved);

  if (depth >= 1 && (await isFile(path.join(dir, 'SKILL.md')))) {
    const result = await readSkillAt(dir, path.basename(dir));
    if (result.invalid) ctx.invalid.push({ ...result.invalid, source });
    else if (result.skill) addSkill(ctx, result.skill, source);
    return true;
  }
  if (depth === 0 && (await isFile(path.join(dir, 'SKILL.md')))) {
    ctx.invalid.push({
      name: path.basename(dir),
      file: path.join(dir, 'SKILL.md'),
      source,
      reason: 'SKILL.md must sit in its own folder (<skills>/<name>/SKILL.md)',
    });
  }
  if (depth >= MAX_SKILL_DEPTH) return false;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (depth === 0 && code !== 'ENOENT' && code !== 'ENOTDIR') {
      ctx.invalid.push({
        name: path.basename(dir),
        file: dir,
        source,
        reason: `cannot read the directory: ${(error as Error).message}`,
      });
    }
    return false;
  }

  const names = entries
    .filter(
      (entry) =>
        !entry.name.startsWith('.') &&
        !SKIP_DIR_NAMES.has(entry.name) &&
        (entry.isDirectory() || entry.isSymbolicLink()),
    )
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'));

  let found = false;
  for (const name of names) {
    if (ctx.dirs++ >= MAX_SKILL_DIRS_PER_ROOT) {
      ctx.invalid.push({
        name: path.basename(dir),
        file: dir,
        source,
        reason: `stopped after ${MAX_SKILL_DIRS_PER_ROOT} folders in this skills root`,
      });
      break;
    }
    const child = path.join(dir, name);
    if (!(await isDirectory(child))) continue;
    if (await walk(ctx, child, depth + 1, source)) found = true;
  }
  if (!found && depth >= 1) {
    ctx.invalid.push({
      name: path.basename(dir),
      file: dir,
      source,
      reason: 'no SKILL.md in this folder (or one level deeper)',
    });
  }
  return found;
}

/** Project roots win over user roots; the first definition of a name is kept. */
export async function loadSkills(cwd: string): Promise<SkillInventory> {
  const roots = skillRoots(cwd);
  const ctx: ScanContext = {
    skills: [],
    invalid: [],
    byName: new Map(),
    visited: new Set(),
    dirs: 0,
  };
  if (skillsEnabled) {
    for (const { root, source } of roots) await walk(ctx, root, 0, source);
  }
  ctx.skills.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return {
    skills: ctx.skills,
    invalid: ctx.invalid,
    roots: roots.map(({ root }) => root),
    disabled: !skillsEnabled,
  };
}

export function findSkill(skills: Skill[], name: string): Skill | undefined {
  const needle = name.trim().toLowerCase();
  return skills.find((skill) => skill.name.toLowerCase() === needle);
}

export function shortPath(target: string, cwd: string): string {
  const relative = path.relative(cwd, target);
  if (relative === '') return '.';
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
  const home = homedir();
  if (target === home) return '~';
  if (target.startsWith(`${home}${path.sep}`)) return `~${target.slice(home.length)}`;
  return target;
}

function clipDescription(description: string, max: number): string {
  return description.length > max ? `${description.slice(0, max - 1)}…` : description;
}

/** Name and description only; the body stays on disk until read_skill loads it. */
export function formatSkillIndex(skills: Skill[]): string {
  if (skills.length === 0) return '';
  const header = [
    '# Skills',
    'Installed skills extend how you work. When a request matches one, call the read_skill tool with the exact name first and follow the instructions it returns. Do not guess what a skill contains.',
  ];
  const budget = MAX_SKILLS_INDEX_CHARS - header.join('\n').length - 1;
  const descriptionLimit =
    skills.length > MAX_SKILLS_IN_PROMPT
      ? MAX_SKILL_SHORT_DESCRIPTION_CHARS
      : MAX_SKILL_DESCRIPTION_CHARS;
  let lines = skills.map((skill) => `- ${skill.name}: ${clipDescription(skill.description, descriptionLimit)}`);
  if (lines.join('\n').length > budget) lines = skills.map((skill) => `- ${skill.name}`);

  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (kept.length > 0 && used + line.length + 1 > budget) break;
    used += line.length + 1;
    kept.push(line);
  }
  const omitted = skills.length - kept.length;
  if (omitted > 0) kept.push(`(+${omitted} more skills; run /skills to list all.)`);
  return [...header, ...kept].join('\n');
}

/** The user message /skill produces: full instructions plus, when given, the request. */
export function skillInvocationMessage(skill: Skill, request = ''): string {
  const body =
    skill.body.length > MAX_SKILL_BODY_CHARS
      ? `${skill.body.slice(0, MAX_SKILL_BODY_CHARS)}\n\n[Skill truncated; the rest is in ${skill.file}]`
      : skill.body;
  const ask = request.trim();
  if (ask) {
    return `Use the "${skill.name}" skill for this request.\n\n${body}\n\nRequest: ${ask}`;
  }
  return `Use the "${skill.name}" skill. Its instructions follow; apply them to what I ask next.\n\n${body}`;
}

export function formatSkillList(inventory: SkillInventory, cwd: string): string {
  if (inventory.disabled) {
    return 'Skills are disabled for this run (--no-skills or KIRO_NO_SKILLS).';
  }
  const lines: string[] = [];
  if (inventory.skills.length === 0) {
    lines.push('No skills installed.');
  } else {
    const project = inventory.skills.filter((skill) => skill.source === 'project').length;
    const user = inventory.skills.length - project;
    const counts = [project > 0 ? `${project} project` : '', user > 0 ? `${user} user` : '']
      .filter(Boolean)
      .join(', ');
    lines.push(`Installed skills (${counts}):`);
    const width = Math.min(28, Math.max(...inventory.skills.map((skill) => skill.name.length)));
    for (const skill of inventory.skills) {
      lines.push(
        `  ${skill.name.padEnd(width)}  ${clipDescription(skill.description, 80)} ` +
          `[${skill.source}] (${shortPath(skill.dir, cwd)})`,
      );
    }
  }
  lines.push('', `Looked in: ${inventory.roots.map((root) => shortPath(root, cwd)).join(', ')}`);
  if (inventory.invalid.length > 0) {
    const label = inventory.invalid.length === 1 ? '1 entry' : `${inventory.invalid.length} entries`;
    lines.push(`Skipped ${label}:`);
    for (const bad of inventory.invalid.slice(0, 10)) {
      lines.push(`  ${bad.name}: ${bad.reason} (${shortPath(bad.file, cwd)})`);
    }
    if (inventory.invalid.length > 10) {
      lines.push(`  … and ${inventory.invalid.length - 10} more`);
    }
  }
  if (inventory.skills.length === 0) {
    lines.push('Add one at .kiro/skills/<name>/SKILL.md with name and description frontmatter.');
  }
  return lines.join('\n');
}
