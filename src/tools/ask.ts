import { booleanArg, stringArg } from './paths.js';
import type { AskUserOption, AskUserRequest, Tool } from './types.js';
import { denied, ok, toolError } from './types.js';

const MAX_OPTIONS = 4;
const MAX_OPTION_LABEL_CHARS = 40;
const MAX_OPTION_DESCRIPTION_CHARS = 120;
const MAX_QUESTION_CHARS = 400;
const MAX_HEADER_CHARS = 12;

function optionList(input: Record<string, unknown>): AskUserOption[] {
  const raw = input.options;
  if (!Array.isArray(raw)) throw new Error('Argument "options" must be an array.');
  if (raw.length < 1 || raw.length > MAX_OPTIONS) {
    throw new Error(`Argument "options" must contain 1 to ${MAX_OPTIONS} entries.`);
  }
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`Option ${index + 1} must be an object with a "label" and optional "description".`);
    }
    const item = entry as Record<string, unknown>;
    const label = typeof item.label === 'string' ? item.label.trim() : '';
    if (!label) throw new Error(`Option ${index + 1} needs a non-empty "label".`);
    if (label.length > MAX_OPTION_LABEL_CHARS) {
      throw new Error(
        `Option ${index + 1} label is longer than ${MAX_OPTION_LABEL_CHARS} characters; shorten it.`,
      );
    }
    if (seen.has(label.toLowerCase())) {
      throw new Error(`Option ${index + 1} repeats the label "${label}". Use distinct labels.`);
    }
    seen.add(label.toLowerCase());
    if (item.description === undefined || item.description === null) return { label };
    if (typeof item.description !== 'string') {
      throw new Error(`Option ${index + 1} "description" must be a string.`);
    }
    const description = item.description.trim();
    if (!description) return { label };
    if (description.length > MAX_OPTION_DESCRIPTION_CHARS) {
      throw new Error(
        `Option ${index + 1} description is longer than ${MAX_OPTION_DESCRIPTION_CHARS} characters; shorten it.`,
      );
    }
    return { label, description };
  });
}

function answerText(request: AskUserRequest, selected: string[], other: string | undefined): string {
  const lines = [`The user answered: ${request.question}`];
  if (selected.length > 0) lines.push(`Selected: ${selected.join('; ')}`);
  if (other) lines.push(`Other: ${other}`);
  return lines.join('\n');
}

const askUserTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'ask_user',
      description:
        'Ask the user a question with a short list of choices when the decision is genuinely theirs and guessing would waste work. ' +
        'This blocks until they answer and returns the selection. Use it instead of printing numbered questions as text. ' +
        'Do not use it to request permission for a tool call; approvals already cover that.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: `What to ask, one or two sentences (max ${MAX_QUESTION_CHARS} characters).`,
          },
          header: {
            type: 'string',
            description: `Short title for the prompt, at most ${MAX_HEADER_CHARS} characters, e.g. "Design".`,
          },
          options: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_OPTIONS,
            description: `One to ${MAX_OPTIONS} distinct choices.`,
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: `Choice text (max ${MAX_OPTION_LABEL_CHARS} characters).` },
                description: {
                  type: 'string',
                  description: `Optional one-line detail (max ${MAX_OPTION_DESCRIPTION_CHARS} characters).`,
                },
              },
              required: ['label'],
              additionalProperties: false,
            },
          },
          multi_select: {
            type: 'boolean',
            description: 'Allow more than one choice. Default false.',
          },
          allow_other: {
            type: 'boolean',
            description: 'Offer a free-form answer next to the listed choices. Default true.',
          },
        },
        required: ['question', 'options'],
        additionalProperties: false,
      },
    },
  },
  async run(input, ctx) {
    const question = stringArg(input, 'question')!.trim();
    if (question.length > MAX_QUESTION_CHARS) {
      return toolError(
        `The question is longer than ${MAX_QUESTION_CHARS} characters. Shorten it and put details in the option descriptions.`,
      );
    }
    const header = (stringArg(input, 'header', true) ?? '').trim().slice(0, MAX_HEADER_CHARS) || undefined;
    const options = optionList(input);
    const multiSelect = booleanArg(input, 'multi_select', false);
    const allowOther = booleanArg(input, 'allow_other', true);
    const request: AskUserRequest = { question, header, options, multiSelect, allowOther };

    if (!ctx.askUser) {
      return toolError(
        'ask_user needs an interactive terminal, and this run has none. ' +
          'Ask the question in plain text and stop, so the user can answer in their next message.',
      );
    }
    if (ctx.signal.aborted) return denied('Cancelled before the user answered.');

    const answer = await ctx.askUser(request);
    if (answer.cancelled) {
      return denied(
        'The user dismissed the question without answering. Do not ask it again; continue with a sensible ' +
          'default, or ask in plain text if the answer is still required.',
      );
    }
    const selected = request.options
      .map((option) => option.label)
      .filter((label) => answer.selected.includes(label));
    const other = answer.other?.trim();
    if (selected.length === 0 && !other) {
      return denied('The user submitted no answer.');
    }
    return ok(
      answerText(request, selected, other),
      `ask_user: ${[...selected, ...(other ? [`Other: ${other}`] : [])].join(', ')}`,
    );
  },
};

export const askTools: Tool[] = [askUserTool];
