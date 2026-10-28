# AGENTS.md

Writing rules for this repository. They apply to the README, help text, UI notices, commit messages, and code comments.

## Prose

- Write plainly and briefly. Prefer short sentences and concrete nouns.
- Do not use em dashes. Use commas, colons, parentheses, or a new sentence.
- Do not pad documentation with exhaustive feature inventories, testing checklists, or design rationale. Document what someone needs to use or maintain the tool.
- Skip framing like "Phase 1 (MVP)" and marketing words such as seamless, robust, or comprehensive.
- Keep commands, paths, defaults, and behavior exact. A rewrite must not drop or invent facts.

## UI text

- Keep notices and labels short. State what happened and what the user can do next.
- Follow the same punctuation rules as prose.

## Code comments

- Comment only when the reason is not obvious from the code: a constraint, a workaround, or a subtle invariant.
- Do not narrate what the next line does.
