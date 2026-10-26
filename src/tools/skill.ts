import { findSkill, loadSkills, MAX_SKILL_BODY_CHARS } from '../agent/skills.js';
import { stringArg } from './paths.js';
import type { Tool } from './types.js';
import { ok, toolError } from './types.js';

const readSkillTool: Tool = {
  readOnly: true,
  definition: {
    type: 'function',
    function: {
      name: 'read_skill',
      description:
        'Load the full instructions of an installed skill by name. Use it when a request matches a skill listed in the system prompt, then follow the returned instructions.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Exact skill name, e.g. "anti-slop".' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
  },
  async run(input, ctx) {
    const name = stringArg(input, 'name')!;
    const inventory = await loadSkills(ctx.cwd);
    if (inventory.skills.length === 0) {
      return toolError(
        'No skills are installed. Add one at .kiro/skills/<name>/SKILL.md or ~/.kiro/skills/<name>/SKILL.md.',
      );
    }
    const skill = findSkill(inventory.skills, name);
    if (!skill) {
      return toolError(
        `Unknown skill "${name}". Available skills: ${inventory.skills.map((entry) => entry.name).join(', ')}.`,
      );
    }
    const clipped =
      skill.body.length > MAX_SKILL_BODY_CHARS
        ? `${skill.body.slice(0, MAX_SKILL_BODY_CHARS)}\n\n… [skill truncated after ` +
          `${MAX_SKILL_BODY_CHARS.toLocaleString()} characters; read the rest with read_file on ${skill.file}]`
        : skill.body;
    return ok(
      `# Skill: ${skill.name}\n\n${clipped}\n\n` +
        `[Skill directory: ${skill.dir}. Read supporting files with read_file or run bundled scripts with run_command.]`,
      `read_skill ${skill.name}`,
    );
  },
};

export const skillTools: Tool[] = [readSkillTool];
