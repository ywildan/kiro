import {
  DEFAULT_CONTEXT_WINDOW,
  normalizeBaseUrl,
  suggestProfileName,
  validateProfileName,
  type KiroConfig,
  type ProfileConfig,
} from '../config.js';
import {
  defaultKeyEnv,
  isValidEnvName,
  keyPreview,
  writeEnvValue,
} from '../env.js';
import {
  discoverModels,
  modelsEndpoint,
  testConnection,
  type DiscoveredModels,
  type TestResult,
} from './discovery.js';
import { allPresets, type ProviderPreset } from './presets.js';

export type WizardTone = 'info' | 'error' | 'muted';

export interface TextPrompt {
  label: string;
  hint?: string;
  defaultValue?: string;
  mask?: boolean;
  allowEmpty?: boolean;
}

/** The small surface the wizard needs; the CLI and TUI each implement it. */
export interface ModelWizardUi {
  note(tone: WizardTone, text: string): void;
  text(options: TextPrompt): Promise<string | null>;
  confirm(label: string, defaultValue: boolean): Promise<boolean | null>;
}

export interface WizardDependencies {
  discoverModels?: (options: {
    baseUrl: string;
    apiKey?: string;
    signal?: AbortSignal;
  }) => Promise<DiscoveredModels>;
  testConnection?: (
    profile: ProfileConfig,
    apiKey?: string,
    options?: { signal?: AbortSignal },
  ) => Promise<TestResult>;
}

export interface WizardContext {
  ui: ModelWizardUi;
  config: KiroConfig;
  save(next: KiroConfig): Promise<void>;
  signal?: AbortSignal;
  cancelled?: () => boolean;
  deps?: WizardDependencies;
}

const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 4096;

function cancel(ctx: WizardContext): null {
  ctx.ui.note('muted', 'Cancelled; nothing was saved.');
  return null;
}

async function askText(
  ctx: WizardContext,
  options: TextPrompt & { validate?: (value: string) => string | null },
): Promise<string | null> {
  for (;;) {
    const answer = await ctx.ui.text(options);
    if (answer === null) return null;
    const value = answer.trim() ? answer.trim() : (options.defaultValue ?? '').trim();
    if (!value && !options.allowEmpty) {
      ctx.ui.note('error', 'A value is required.');
      continue;
    }
    if (options.validate) {
      const message = options.validate(value);
      if (message) {
        ctx.ui.note('error', message);
        continue;
      }
    }
    return value;
  }
}

async function chooseMenu(
  ctx: WizardContext,
  title: string,
  items: { key: string; label: string }[],
): Promise<string | null> {
  const ui = ctx.ui;
  ui.note(
    'info',
    [title, ...items.map((item, index) => `  ${index + 1}. ${item.label}`), '', 'Enter a number.'].join('\n'),
  );
  for (;;) {
    const answer = await ui.text({ label: 'Choose', allowEmpty: false });
    if (answer === null) return null;
    const value = answer.trim();
    const numeric = /^\d+$/.test(value) ? items[Number(value) - 1] : undefined;
    if (numeric) return numeric.key;
    const named = items.find((item) => item.key === value);
    if (named) return named.key;
    ui.note('error', `Choose a number from 1 to ${items.length}.`);
  }
}

async function chooseFromList(
  ctx: WizardContext,
  title: string,
  items: string[],
): Promise<{ kind: 'item'; value: string } | { kind: 'manual' } | null> {
  const ui = ctx.ui;
  ui.note(
    'info',
    [
      title,
      ...items.map((item, index) => `  ${index + 1}. ${item}`),
      '',
      'Enter a number, part of an id to filter, or 0 to type it manually.',
    ].join('\n'),
  );
  for (;;) {
    const answer = await ui.text({ label: 'Model', allowEmpty: false });
    if (answer === null) return null;
    const value = answer.trim();
    if (value === '0') return { kind: 'manual' };
    if (/^\d+$/.test(value)) {
      const item = items[Number(value) - 1];
      if (item) return { kind: 'item', value: item };
      ui.note('error', `There is no model number ${value}.`);
      continue;
    }
    const exact = items.find((item) => item === value);
    if (exact) return { kind: 'item', value: exact };
    const matches = items.filter((item) => item.toLowerCase().includes(value.toLowerCase()));
    if (matches.length === 1) return { kind: 'item', value: matches[0]! };
    if (matches.length === 0) {
      ui.note('error', `No model id contains "${value}".`);
      continue;
    }
    ui.note('muted', `Matches: ${matches.join(', ')}`);
  }
}

async function pickProfile(
  ctx: WizardContext,
  title: string,
): Promise<string | null> {
  const names = Object.keys(ctx.config.profiles);
  if (names.length === 0) {
    ctx.ui.note('error', 'There are no profiles configured.');
    return null;
  }
  return chooseMenu(
    ctx,
    title,
    names.map((name) => {
      const profile = ctx.config.profiles[name]!;
      const active = name === ctx.config.activeProfile ? ' [active]' : '';
      return { key: name, label: `${name}${active} — ${profile.model} @ ${profile.baseUrl}` };
    }),
  );
}

function hostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.replace(/^www\./, '');
  } catch {
    return 'custom';
  }
}

function parseTemperature(value: string): string | null {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 2) {
    return 'Temperature must be a number between 0 and 2.';
  }
  return null;
}

function parseMaxTokens(value: string): string | null {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    return 'Max tokens must be a positive whole number.';
  }
  return null;
}

function parseContextWindow(value: string): string | null {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1_000) {
    return 'Context window must be a whole number of at least 1000 tokens.';
  }
  return null;
}

function profileNameValidator(
  ctx: WizardContext,
  originalName?: string,
): (value: string) => string | null {
  return (value) => {
    try {
      const name = validateProfileName(value);
      if (name !== originalName && ctx.config.profiles[name]) {
        return `A profile named "${name}" already exists.`;
      }
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  };
}

function keyFor(profile: ProfileConfig, pendingKey: string | undefined): string | undefined {
  if (pendingKey) return pendingKey;
  return profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined;
}

async function runTest(
  ctx: WizardContext,
  profile: ProfileConfig,
  pendingKey: string | undefined,
): Promise<TestResult> {
  const key = keyFor(profile, pendingKey);
  if (profile.apiKeyEnv && !key) {
    ctx.ui.note('error', `API key is not set: $${profile.apiKeyEnv} is empty.`);
  }
  ctx.ui.note('muted', `Testing ${profile.baseUrl} with model "${profile.model}"…`);
  const test = ctx.deps?.testConnection ?? testConnection;
  const result = await test(profile, key, { signal: ctx.signal });
  ctx.ui.note(result.ok ? 'info' : 'error', result.message);
  return result;
}

/**
 * Returns 'pass' when the test succeeded, 'save' when the user wants to save
 * despite a failure, 'edit' when fields should be edited, or 'cancel'.
 */
async function confirmConnection(
  ctx: WizardContext,
  profile: ProfileConfig,
  pendingKey: string | undefined,
): Promise<'pass' | 'save' | 'edit' | 'cancel'> {
  for (;;) {
    const result = await runTest(ctx, profile, pendingKey);
    if (ctx.cancelled?.()) return 'cancel';
    if (result.ok) return 'pass';
    const action = await chooseMenu(ctx, 'Connection test failed', [
      { key: 'retry', label: 'Retry the test' },
      { key: 'edit', label: 'Edit connection fields' },
      { key: 'save', label: 'Save anyway' },
      { key: 'cancel', label: 'Cancel without saving' },
    ]);
    if (action === null || action === 'cancel') return 'cancel';
    if (action === 'retry') continue;
    if (action === 'save') return 'save';
    return 'edit';
  }
}

interface Draft {
  name: string;
  profile: ProfileConfig;
  pendingKey: string | undefined;
}

async function editFields(
  ctx: WizardContext,
  draft: Draft,
  originalName?: string,
): Promise<Draft | null> {
  const ui = ctx.ui;
  for (;;) {
    const current = draft.profile;
    ui.note(
      'muted',
      `Profile "${draft.name}": ${current.model} @ ${current.baseUrl}; key ${keyPreview(current)}`,
    );
    const field = await chooseMenu(ctx, 'Edit fields', [
      { key: 'name', label: `Profile name (${draft.name})` },
      { key: 'baseUrl', label: `Base URL (${current.baseUrl})` },
      { key: 'model', label: `Model (${current.model})` },
      { key: 'env', label: `API key environment variable (${current.apiKeyEnv ?? 'none'})` },
      { key: 'key', label: 'API key (masked)' },
      { key: 'temperature', label: `Temperature (${current.temperature ?? DEFAULT_TEMPERATURE})` },
      { key: 'maxTokens', label: `Max tokens (${current.maxTokens ?? DEFAULT_MAX_TOKENS})` },
      {
        key: 'contextWindow',
        label: `Context window (${current.contextWindow ?? DEFAULT_CONTEXT_WINDOW})`,
      },
      { key: 'done', label: 'Done editing; test and save' },
    ]);
    if (field === null) return null;
    if (field === 'done') return draft;

    if (field === 'name') {
      const answer = await askText(ctx, {
        label: 'Profile name',
        defaultValue: draft.name,
        allowEmpty: false,
        validate: profileNameValidator(ctx, originalName ?? draft.name),
      });
      if (answer === null) return null;
      draft.name = answer;
      continue;
    }
    if (field === 'baseUrl') {
      const answer = await askText(ctx, {
        label: 'Base URL',
        defaultValue: current.baseUrl,
        allowEmpty: false,
        validate: (value) => {
          try {
            normalizeBaseUrl(value);
            return null;
          } catch (error) {
            return (error as Error).message;
          }
        },
      });
      if (answer === null) return null;
      draft.profile = { ...draft.profile, baseUrl: normalizeBaseUrl(answer) };
      continue;
    }
    if (field === 'model') {
      const answer = await askText(ctx, {
        label: 'Model id',
        defaultValue: current.model,
        allowEmpty: false,
      });
      if (answer === null) return null;
      draft.profile = { ...draft.profile, model: answer };
      continue;
    }
    if (field === 'env') {
      const answer = await askText(ctx, {
        label: 'Environment variable name (type "-" for none)',
        defaultValue: current.apiKeyEnv ?? '',
        allowEmpty: true,
        validate: (value) =>
          value && value !== '-' && !isValidEnvName(value)
            ? 'Use letters, digits, and underscores; start with a letter or underscore.'
            : null,
      });
      if (answer === null) return null;
      const envName = answer === '-' ? undefined : answer || undefined;
      draft.profile = { ...draft.profile, apiKeyEnv: envName };
      if (envName && process.env[envName]) {
        ui.note('muted', `$${envName} is set in the environment.`);
      }
      continue;
    }
    if (field === 'key') {
      const answer = await ui.text({
        label: 'New API key (masked; Enter keeps the current key, "-" removes it)',
        mask: true,
        allowEmpty: true,
      });
      if (answer === null) return null;
      const value = answer.trim();
      if (value === '-') {
        draft.pendingKey = undefined;
        draft.profile = { ...draft.profile, apiKeyEnv: undefined };
        ui.note('muted', 'The profile will no longer reference an API key. The value stays in ~/.kiro/.env.');
      } else if (value) {
        draft.pendingKey = value;
        ui.note('muted', 'The new key will be stored in ~/.kiro/.env when you save.');
      }
      continue;
    }
    if (field === 'temperature') {
      const answer = await askText(ctx, {
        label: 'Temperature',
        defaultValue: String(current.temperature ?? DEFAULT_TEMPERATURE),
        allowEmpty: false,
        validate: parseTemperature,
      });
      if (answer === null) return null;
      draft.profile = { ...draft.profile, temperature: Number(answer) };
      continue;
    }
    if (field === 'maxTokens') {
      const answer = await askText(ctx, {
        label: 'Max tokens',
        defaultValue: String(current.maxTokens ?? DEFAULT_MAX_TOKENS),
        allowEmpty: false,
        validate: parseMaxTokens,
      });
      if (answer === null) return null;
      draft.profile = { ...draft.profile, maxTokens: Number(answer) };
      continue;
    }
    if (field === 'contextWindow') {
      const answer = await askText(ctx, {
        label: `Context window in tokens (Enter keeps ${DEFAULT_CONTEXT_WINDOW})`,
        defaultValue: String(current.contextWindow ?? DEFAULT_CONTEXT_WINDOW),
        allowEmpty: false,
        validate: parseContextWindow,
      });
      if (answer === null) return null;
      draft.profile = { ...draft.profile, contextWindow: Number(answer) };
    }
  }
}

async function storePendingKey(
  draft: Draft,
): Promise<{ profile: ProfileConfig; storedAs?: string }> {
  if (!draft.pendingKey) return { profile: draft.profile };
  const envName = draft.profile.apiKeyEnv ?? defaultKeyEnv(draft.name);
  await writeEnvValue(envName, draft.pendingKey);
  return {
    profile: { ...draft.profile, apiKeyEnv: envName },
    storedAs: envName,
  };
}

function summarizeSaved(ctx: WizardContext, name: string, storedAs?: string): void {
  const profile = ctx.config.profiles[name];
  const key = profile?.apiKeyEnv
    ? process.env[profile.apiKeyEnv]
      ? `key via $${profile.apiKeyEnv}`
      : `$${profile.apiKeyEnv} is not set yet`
    : 'no API key';
  ctx.ui.note('info', `Saved profile "${name}" (${profile?.model ?? '?'} @ ${profile?.baseUrl ?? '?'}; ${key}).`);
  if (storedAs) {
    ctx.ui.note('muted', `API key stored in ~/.kiro/.env as $${storedAs} (file mode 0600).`);
  }
}

export async function runSelectFlow(
  ctx: WizardContext,
  requestedName?: string,
): Promise<string | null> {
  const name = requestedName ?? (await pickProfile(ctx, 'Select active profile'));
  if (name === null) return cancel(ctx);
  const profile = ctx.config.profiles[name];
  if (!profile) {
    ctx.ui.note('error', `Unknown profile "${name}".`);
    return null;
  }
  if (ctx.config.activeProfile === name) {
    ctx.ui.note('info', `Profile "${name}" is already active.`);
    return name;
  }
  const next = { ...ctx.config, activeProfile: name };
  await ctx.save(next);
  ctx.config = next;
  ctx.ui.note('info', `Active profile is now "${name}" (${profile.model}).`);
  return name;
}

export async function runAddFlow(ctx: WizardContext): Promise<string | null> {
  const ui = ctx.ui;
  const presets = allPresets();
  const presetId = await chooseMenu(
    ctx,
    'Choose a provider',
    presets.map((preset: ProviderPreset) => ({
      key: preset.id,
      label: preset.local
        ? `${preset.label} — ${preset.baseUrl} (no key)`
        : preset.apiKeyEnv
          ? `${preset.label} — ${preset.baseUrl} ($${preset.apiKeyEnv})`
          : `${preset.label} — enter a base URL`,
    })),
  );
  if (presetId === null) return cancel(ctx);
  const preset = presets.find((entry) => entry.id === presetId);
  if (!preset) return cancel(ctx);

  const baseAnswer = await askText(ctx, {
    label: preset.baseUrl ? 'Base URL (Enter keeps the default)' : 'Base URL (for example https://api.example.com/v1)',
    defaultValue: preset.baseUrl || undefined,
    allowEmpty: Boolean(preset.baseUrl),
    validate: (value) => {
      try {
        normalizeBaseUrl(value);
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    },
  });
  if (baseAnswer === null) return cancel(ctx);
  const baseUrl = normalizeBaseUrl(baseAnswer);

  let envName: string | undefined;
  let pendingKey: string | undefined;
  if (!preset.local) {
    const envAnswer = await askText(ctx, {
      label: 'Environment variable for the API key (Enter to generate one from the profile name)',
      defaultValue: preset.apiKeyEnv,
      allowEmpty: true,
      validate: (value) => (value && !isValidEnvName(value) ? 'Use letters, digits, and underscores.' : null),
    });
    if (envAnswer === null) return cancel(ctx);
    envName = envAnswer || undefined;

    const existing = envName ? process.env[envName] : undefined;
    const keyAnswer = await ui.text({
      label: existing
        ? `API key (masked; $${envName} is already set, Enter keeps it)`
        : 'API key (masked; Enter to skip)',
      mask: true,
      allowEmpty: true,
    });
    if (keyAnswer === null) return cancel(ctx);
    pendingKey = keyAnswer.trim() || undefined;
    if (envName && !process.env[envName] && !pendingKey) {
      ui.note('muted', `$${envName} is not set yet; you can add it later or save a key when editing.`);
    }
  }

  ui.note('info', `Fetching models from ${modelsEndpoint(baseUrl)}…`);
  const discover = ctx.deps?.discoverModels ?? discoverModels;
  const discovery = await discover({
    baseUrl,
    apiKey: pendingKey ?? (envName ? process.env[envName] : undefined),
    signal: ctx.signal,
  });
  if (ctx.cancelled?.()) return cancel(ctx);

  let model: string;
  if (discovery.ok && discovery.models.length > 0) {
    const choice = await chooseFromList(ctx, 'Available models:', discovery.models);
    if (choice === null) return cancel(ctx);
    if (choice.kind === 'item') {
      model = choice.value;
    } else {
      const manual = await askText(ctx, { label: 'Model id', allowEmpty: false });
      if (manual === null) return cancel(ctx);
      model = manual;
    }
  } else {
    ui.note(
      discovery.ok ? 'muted' : 'error',
      discovery.ok ? 'The endpoint returned an empty model list.' : (discovery as { message: string }).message,
    );
    ui.note('info', 'Enter the model id manually.');
    const manual = await askText(ctx, { label: 'Model id', allowEmpty: false });
    if (manual === null) return cancel(ctx);
    model = manual;
  }

  const name = await askText(ctx, {
    label: 'Profile name',
    defaultValue: suggestProfileName(
      preset.id === 'custom' ? hostLabel(baseUrl) : preset.id,
      model,
      Object.keys(ctx.config.profiles),
    ),
    allowEmpty: false,
    validate: profileNameValidator(ctx),
  });
  if (name === null) return cancel(ctx);

  const advanced = await ui.confirm(
    'Configure advanced settings (temperature, maxTokens, context window)?',
    false,
  );
  if (advanced === null) return cancel(ctx);
  let temperature = DEFAULT_TEMPERATURE;
  let maxTokens = DEFAULT_MAX_TOKENS;
  let contextWindow: number | undefined;
  if (advanced) {
    const tempAnswer = await askText(ctx, {
      label: 'Temperature',
      defaultValue: String(DEFAULT_TEMPERATURE),
      allowEmpty: false,
      validate: parseTemperature,
    });
    if (tempAnswer === null) return cancel(ctx);
    const tokensAnswer = await askText(ctx, {
      label: 'Max tokens',
      defaultValue: String(DEFAULT_MAX_TOKENS),
      allowEmpty: false,
      validate: parseMaxTokens,
    });
    if (tokensAnswer === null) return cancel(ctx);
    const windowAnswer = await askText(ctx, {
      label: `Context window in tokens (Enter keeps ${DEFAULT_CONTEXT_WINDOW})`,
      defaultValue: String(DEFAULT_CONTEXT_WINDOW),
      allowEmpty: false,
      validate: parseContextWindow,
    });
    if (windowAnswer === null) return cancel(ctx);
    temperature = Number(tempAnswer);
    maxTokens = Number(tokensAnswer);
    contextWindow = Number(windowAnswer);
  }

  const draft: Draft = {
    name,
    profile: {
      type: 'openai',
      baseUrl,
      apiKeyEnv: preset.local ? undefined : envName,
      model,
      temperature,
      maxTokens,
      contextWindow,
    },
    pendingKey,
  };

  let verdict = await confirmConnection(ctx, draft.profile, draft.pendingKey);
  while (verdict === 'edit') {
    const edited = await editFields(ctx, draft);
    if (!edited) return cancel(ctx);
    draft.profile = edited.profile;
    draft.name = edited.name;
    draft.pendingKey = edited.pendingKey;
    verdict = await confirmConnection(ctx, draft.profile, draft.pendingKey);
  }
  if (verdict === 'cancel') return cancel(ctx);

  let stored;
  try {
    stored = await storePendingKey(draft);
  } catch (error) {
    ui.note('error', (error as Error).message);
    return null;
  }
  const profiles = { ...ctx.config.profiles, [draft.name]: stored.profile };
  let next: KiroConfig = { ...ctx.config, profiles };
  await ctx.save(next);
  ctx.config = next;
  summarizeSaved(ctx, draft.name, stored.storedAs);

  const activate = await ui.confirm(`Set "${draft.name}" as the active profile?`, true);
  if (activate === null) return draft.name;
  if (activate) {
    next = { ...ctx.config, activeProfile: draft.name };
    await ctx.save(next);
    ctx.config = next;
    ui.note('info', `Active profile is now "${draft.name}".`);
  }
  return draft.name;
}

export async function runEditFlow(
  ctx: WizardContext,
  requestedName?: string,
): Promise<string | null> {
  const name = requestedName ?? (await pickProfile(ctx, 'Choose a profile to edit'));
  if (name === null) return cancel(ctx);
  const existing = ctx.config.profiles[name];
  if (!existing) {
    ctx.ui.note('error', `Unknown profile "${name}".`);
    return null;
  }

  const draft: Draft = {
    name,
    profile: { ...existing },
    pendingKey: undefined,
  };
  const edited = await editFields(ctx, draft, name);
  if (!edited) return cancel(ctx);
  draft.profile = edited.profile;
  draft.name = edited.name;
  draft.pendingKey = edited.pendingKey;

  let verdict = await confirmConnection(ctx, draft.profile, draft.pendingKey);
  while (verdict === 'edit') {
    const again = await editFields(ctx, draft, name);
    if (!again) return cancel(ctx);
    draft.profile = again.profile;
    draft.name = again.name;
    draft.pendingKey = again.pendingKey;
    verdict = await confirmConnection(ctx, draft.profile, draft.pendingKey);
  }
  if (verdict === 'cancel') return cancel(ctx);

  let stored;
  try {
    stored = await storePendingKey(draft);
  } catch (error) {
    ctx.ui.note('error', (error as Error).message);
    return null;
  }

  const profiles = { ...ctx.config.profiles };
  if (draft.name !== name) delete profiles[name];
  profiles[draft.name] = stored.profile;
  let activeProfile = ctx.config.activeProfile;
  if (activeProfile === name) activeProfile = draft.name;
  const next: KiroConfig = { activeProfile, profiles };
  await ctx.save(next);
  ctx.config = next;
  summarizeSaved(ctx, draft.name, stored.storedAs);
  return draft.name;
}

export async function runRemoveFlow(
  ctx: WizardContext,
  requestedName?: string,
): Promise<string | null> {
  const ui = ctx.ui;
  const name = requestedName ?? (await pickProfile(ctx, 'Choose a profile to remove'));
  if (name === null) return cancel(ctx);
  const profile = ctx.config.profiles[name];
  if (!profile) {
    ui.note('error', `Unknown profile "${name}".`);
    return null;
  }
  if (Object.keys(ctx.config.profiles).length <= 1) {
    ui.note('error', `Cannot remove "${name}": it is the only profile. Add another model first.`);
    return null;
  }
  const confirmed = await ui.confirm(
    `Remove profile "${name}" (${profile.model} @ ${profile.baseUrl})?`,
    false,
  );
  if (confirmed === null) return cancel(ctx);
  if (!confirmed) {
    ui.note('muted', 'Nothing was removed.');
    return null;
  }

  const profiles = { ...ctx.config.profiles };
  delete profiles[name];
  let activeProfile = ctx.config.activeProfile;
  if (activeProfile === name) {
    const remaining = Object.keys(profiles);
    activeProfile = remaining[0]!;
    ui.note('info', `Profile "${name}" was active; switched to "${activeProfile}".`);
  }
  const next: KiroConfig = { activeProfile, profiles };
  await ctx.save(next);
  ctx.config = next;
  ui.note(
    'info',
    `Removed profile "${name}". Its key (if any) stays in ~/.kiro/.env so another profile can reuse it.`,
  );
  return name;
}

export async function runModelMenu(ctx: WizardContext): Promise<void> {
  for (;;) {
    const action = await chooseMenu(ctx, 'Model workflow', [
      { key: 'select', label: 'Select the active model' },
      { key: 'add', label: 'Add a new model' },
      { key: 'edit', label: 'Edit a model' },
      { key: 'remove', label: 'Remove a model' },
      { key: 'quit', label: 'Quit' },
    ]);
    if (action === null || action === 'quit') return;
    try {
      if (action === 'select') await runSelectFlow(ctx);
      else if (action === 'add') await runAddFlow(ctx);
      else if (action === 'edit') await runEditFlow(ctx);
      else if (action === 'remove') await runRemoveFlow(ctx);
    } catch (error) {
      ctx.ui.note('error', error instanceof Error ? error.message : String(error));
    }
  }
}
