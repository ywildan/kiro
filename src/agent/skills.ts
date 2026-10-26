import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const MAX_SKILLS_IN_PROMPT = 30;
export const MAX_SKILL_DESCRIPTION_CHARS = 300;
export const MAX_SKILL_BODY_CHARS = 50_000;
export const MAX_SKILL_FILE_BYTES = 200_000;
export const MAX_SKILLS_INDEX_CHARS = 8_000;
const MAX_SKILL_NAME_CHARS = 64;
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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

async function readSkillDir(
  root: string,
  source: SkillSource,
  entry: string,
): Promise<{ skill?: Omit<Skill, 'source'>; invalid?: { name: string; file: string; reason: string } }> {
  const file = path.join(root, entry, 'SKILL.md');
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return {};
    return { invalid: { name: entry, file, reason: (error as Error).message } };
  }
  if (!info.isFile()) return {};
  if (info.size > MAX_SKILL_FILE_BYTES) {
    return {
      invalid: {
        name: entry,
        file,
        reason: `SKILL.md is larger than ${MAX_SKILL_FILE_BYTES.toLocaleString()} bytes`,
      },
    };
  }
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    return { invalid: { name: entry, file, reason: (error as Error).message } };
  }
  const parsed = parseSkillFile(raw);
  if (!parsed.ok) return { invalid: { name: entry, file, reason: parsed.reason } };

  const name = parsed.value.name ?? entry;
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
      dir: path.join(root, entry),
      file,
    },
  };
}

/** Project roots win over user roots; the first definition of a name is kept. */
export async function loadSkills(cwd: string): Promise<SkillInventory> {
  const roots = skillRoots(cwd);
  const skills: Skill[] = [];
  const invalid: InvalidSkill[] = [];
  const byName = new Map<string, Skill>();

  for (const { root, source } of roots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        invalid.push({
          name: path.basename(root),
          file: root,
          source,
          reason: `cannot read the directory: ${(error as Error).message}`,
        });
      }
      continue;
    }
    const names = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, 'en'));

    for (const entryName of names) {
      const result = await readSkillDir(root, source, entryName);
      if (result.invalid) {
        invalid.push({ ...result.invalid, source });
        continue;
      }
      const skill = result.skill;
      if (!skill) continue;
      const existing = byName.get(skill.name.toLowerCase());
      if (existing) {
        invalid.push({
          name: skill.name,
          file: skill.file,
          source,
          reason: `duplicate name; ${existing.file} already defines it`,
        });
        continue;
      }
      const complete: Skill = { ...skill, source };
      skills.push(complete);
      byName.set(skill.name.toLowerCase(), complete);
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return { skills, invalid, roots: roots.map(({ root }) => root) };
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
  const lines = [
    '# Skills',
    'Installed skills extend how you work. When a request matches one, call the read_skill tool with the exact name first and follow the instructions it returns. Do not guess what a skill contains.',
  ];
  let used = lines.join('\n').length;
  let shown = 0;
  for (const skill of skills.slice(0, MAX_SKILLS_IN_PROMPT)) {
    const line = `- ${skill.name}: ${clipDescription(skill.description, MAX_SKILL_DESCRIPTION_CHARS)}`;
    if (shown > 0 && used + line.length + 1 > MAX_SKILLS_INDEX_CHARS) break;
    lines.push(line);
    used += line.length + 1;
    shown++;
  }
  const hidden = skills.length - shown;
  if (hidden > 0) lines.push(`(${hidden} more installed; run /skills to list all.)`);
  return lines.join('\n');
}

export function formatSkillList(inventory: SkillInventory, cwd: string): string {
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
