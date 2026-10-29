import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, useApp, useInput, useStdout } from 'ink';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildSystemPrompt } from '../agent/prompt.js';
import {
  findSkill,
  formatSkillList,
  loadSkills,
  shortPath,
  skillInvocationMessage,
} from '../agent/skills.js';
import { runAgentTurn } from '../agent/loop.js';
import {
  COMPACT_KEEP_USER_TURNS,
  COMPACT_THRESHOLD,
  compactMessages,
  shouldCompact,
  type CompactResult,
} from '../agent/compact.js';
import { estimateMessagesTokens, formatPercent, formatTokens } from '../agent/tokens.js';
import {
  applyOverrides,
  contextWindowFor,
  resolveProfile,
  saveConfig,
  type CliOverrides,
  type KiroConfig,
} from '../config.js';
import { discoverModels, testConnection } from '../model/discovery.js';
import {
  runAddFlow,
  runEditFlow,
  runRemoveFlow,
  type ModelWizardUi,
  type TextPrompt,
  type WizardContext,
} from '../model/wizard.js';
import { createProvider } from '../providers/index.js';
import type { ChatMessage } from '../providers/types.js';
import {
  dropIncompleteToolCalls,
  formatSessionTime,
  isSessionId,
  listAllSessions,
  listSessions,
  loadSession,
  newSessionId,
  projectSessionsDir,
  saveSession,
  titleFromMessages,
  type AllSessionsResult,
  type SessionRecord,
  type SessionSummary,
} from '../sessions.js';
import type { ApprovalDecision, ApprovalRequest, ToolContext } from '../tools/types.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';
import { ApprovalPolicy } from './approval-policy.js';
import {
  builtinCommandNames,
  buildSkillCommands,
  SLASH_COMMANDS,
  slashHelpLines,
  type SlashCommand,
} from './commands.js';
import { defaultExportPath, renderTranscriptMarkdown } from './export.js';
import { listProjectFiles } from './file-index.js';
import { buildResumedView } from './history.js';
import { Input } from './Input.js';
import { MessageList } from './MessageList.js';
import { MOUSE_OFF, MOUSE_ON } from './mouse.js';
import { ModelPicker, type ModelRefreshResult } from './ModelPicker.js';
import { SessionPicker } from './SessionPicker.js';
import { SESSION_INLINE_ROWS, shortCwd } from './session-picker.js';
import {
  PICKER_INLINE_ROWS,
  pickerPopupRect,
  withProfileModel,
  withProfileModels,
} from './model-picker.js';
import { formatProfileList } from './profile-list.js';
import { loadPromptHistory, recordPrompt } from './prompt-history.js';
import { StatusBar, type Activity } from './StatusBar.js';
import { summarizeToolArgs } from './text.js';
import {
  UsageCard,
  USAGE_CARD_GAP,
  USAGE_CARD_WIDTH,
  shouldShowUsageCard,
  type LastReplyStats,
} from './UsageCard.js';
import { addUsage, EMPTY_USAGE, type UsageTotals } from '../usage.js';
import { undoLastCheckpoint } from '../tools/checkpoint.js';
import {
  MAX_EXPANDED_TOOL_CHARS,
  MAX_REASONING_CHARS,
  type PaletteState,
  type ViewItem,
} from './types.js';

/** Idle Ctrl+C must be pressed again within this window to exit. */
const QUIT_CONFIRM_MS = 2_000;

export interface StartupNotice {
  level: 'info' | 'error' | 'muted';
  text: string;
}

interface AppProps {
  config: KiroConfig;
  /** The config as stored on disk, before any one-off CLI overrides. */
  baseConfig: KiroConfig;
  overrides: CliOverrides;
  configPath: string;
  configCreated: boolean;
  cwd: string;
  version: string;
  yolo: boolean;
  /** On by default for wheel scrolling; --no-mouse or /mouse restores click-drag selection. */
  mouseEnabled: boolean;
  initialSession?: SessionRecord | null;
  startupNotices?: StartupNotice[];
}

interface WizardPromptState extends TextPrompt {
  id: number;
}

interface SessionState {
  id: string;
  createdAt: string;
  title: string;
}

function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const read = useCallback(
    () => ({
      columns: stdout.columns || 80,
      rows: stdout.rows || 24,
    }),
    [stdout],
  );
  const [size, setSize] = useState(read);

  useEffect(() => {
    const onResize = () => setSize(read());
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout, read]);

  return size;
}

export function App({
  config,
  baseConfig,
  overrides,
  configPath,
  configCreated,
  cwd,
  version,
  yolo,
  mouseEnabled,
  initialSession,
  startupNotices,
}: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { columns, rows } = useTerminalSize();
  const width = Math.max(20, columns - 2);

  const initialViewRef = useRef<ReturnType<typeof buildResumedView> | null>(null);
  if (initialViewRef.current === null) {
    const view: { items: ViewItem[]; nextId: number } = initialSession
      ? buildResumedView(initialSession.messages, { cwd, version, sessionId: initialSession.id })
      : { items: [{ kind: 'banner', id: 0, cwd, version }], nextId: 1 };
    if (yolo) {
      view.items.push({
        kind: 'notice',
        id: view.nextId++,
        level: 'error',
        text: 'YOLO mode: Kiro writes files and runs commands without asking. Restart without --yolo to get approvals back.',
      });
    }
    initialViewRef.current = view;
  }
  const nextItemIdRef = useRef(initialViewRef.current.nextId);
  const [items, setItems] = useState<ViewItem[]>(initialViewRef.current.items);
  const [resetSignal, setResetSignal] = useState(0);
  const [runtimeConfig, setRuntimeConfig] = useState(config);
  const [profileName, setProfileName] = useState(config.activeProfile);
  const [busy, setBusy] = useState(false);
  const [replying, setReplying] = useState(false);
  const [busySince, setBusySince] = useState<number | null>(null);
  const [wizardPrompt, setWizardPrompt] = useState<WizardPromptState | null>(null);
  const [wizardActive, setWizardActive] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sessionPicker, setSessionPicker] = useState<AllSessionsResult | null>(null);
  const [quitArmed, setQuitArmed] = useState(false);
  const [palette, setPalette] = useState<PaletteState | null>(null);
  const [usageCardEnabled, setUsageCardEnabled] = useState(true);
  const [mouseOn, setMouseOn] = useState(mouseEnabled);
  const [expandedToolId, setExpandedToolId] = useState<number | null>(null);
  const [inputRows, setInputRows] = useState(1);
  const fileIndexRef = useRef<{ cwd: string; files: string[]; builtAt: number } | null>(null);

  const loadFileIndex = useCallback(async (): Promise<string[]> => {
    const cached = fileIndexRef.current;
    if (cached && cached.cwd === cwd && Date.now() - cached.builtAt < 5000) {
      return cached.files;
    }
    const files = await listProjectFiles(cwd);
    fileIndexRef.current = { cwd, files, builtAt: Date.now() };
    return files;
  }, [cwd]);

  const messagesRef = useRef<ChatMessage[]>(
    (initialSession?.messages ?? []).filter((message) => message.role !== 'system'),
  );
  const usageRef = useRef<{ tokens: number; messageCount: number } | null>(null);
  const roundStartedAtRef = useRef(0);
  const roundCompletionTokensRef = useRef<number | null>(null);
  const [sessionUsage, setSessionUsage] = useState<UsageTotals>(
    () => initialSession?.usage ?? EMPTY_USAGE,
  );
  const sessionUsageRef = useRef(sessionUsage);
  const [lastReply, setLastReply] = useState<LastReplyStats | null>(null);
  const [contextTokens, setContextTokens] = useState(() => estimateMessagesTokens(messagesRef.current));
  const contextTokensRef = useRef(contextTokens);
  const sessionRef = useRef<SessionState | null>(
    initialSession
      ? {
          id: initialSession.id,
          createdAt: initialSession.createdAt,
          title: initialSession.title,
        }
      : null,
  );
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const saveErrorShownRef = useRef(false);
  const listedSessionsRef = useRef<SessionSummary[] | null>(null);
  const transitioningRef = useRef(false);
  const quittingRef = useRef(false);

  const configRef = useRef(runtimeConfig);
  configRef.current = runtimeConfig;
  const baseConfigRef = useRef(baseConfig);
  const wizardResolveRef = useRef<((value: string | null) => void) | null>(null);
  const wizardPromptRef = useRef<WizardPromptState | null>(wizardPrompt);
  wizardPromptRef.current = wizardPrompt;
  const wizardActiveRef = useRef(false);
  const wizardCancelRequestedRef = useRef(false);
  const wizardAbortRef = useRef<AbortController | null>(null);
  const wizardPromptIdRef = useRef(0);

  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const cancelRequestedRef = useRef(false);
  const projectSkillNotedRef = useRef(false);
  const quitArmedRef = useRef(false);
  const quitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [approvalPolicy] = useState(() => new ApprovalPolicy(yolo));
  const [autoAllowed, setAutoAllowed] = useState<string[]>([]);
  const pendingApprovalRef = useRef<ApprovalRequest | null>(null);
  const pendingResolverRef = useRef<((decision: ApprovalDecision) => void) | null>(null);

  const textBufferRef = useRef('');
  const queuedRef = useRef<string[]>([]);
  const [queuedCount, setQueuedCount] = useState(0);
  const [promptHistory, setPromptHistory] = useState<string[]>([]);
  const handleSubmitRef = useRef<((value: string, fromQueue?: boolean) => void) | null>(null);
  const drainQueueRef = useRef<(() => void) | null>(null);
  const flushTimerRef = useRef<NodeJS.Timeout | null>(null);

  const addNotice = useCallback((level: 'info' | 'error' | 'muted', text: string): void => {
    setItems((current) => [
      ...current,
      { kind: 'notice', id: nextItemIdRef.current++, level, text },
    ]);
  }, []);

  const updateContextTokens = useCallback((tokens: number): void => {
    const rounded = Math.max(0, Math.round(tokens));
    contextTokensRef.current = rounded;
    setContextTokens(rounded);
  }, []);

  const recomputeContext = useCallback((): void => {
    const messages = messagesRef.current;
    const usage = usageRef.current;
    updateContextTokens(
      usage && usage.messageCount <= messages.length
        ? usage.tokens + estimateMessagesTokens(messages.slice(usage.messageCount))
        : estimateMessagesTokens(messages),
    );
  }, [updateContextTokens]);

  const autoCompact = useCallback(
    async (
      messages: ChatMessage[],
      signal: AbortSignal,
      options?: { force?: boolean },
    ): Promise<CompactResult | null> => {
      const profile = configRef.current.profiles[profileName];
      const window = contextWindowFor(profile);
      const used = Math.max(estimateMessagesTokens(messages), contextTokensRef.current);
      if (!options?.force && !shouldCompact(used, window, COMPACT_THRESHOLD)) return null;
      const resolved = resolveProfile(configRef.current, profileName);
      const provider = createProvider(resolved.profile, resolved.apiKey);
      const result = await compactMessages({
        messages,
        provider,
        signal,
        keepUserTurns: COMPACT_KEEP_USER_TURNS,
      });
      if (result) {
        usageRef.current = null;
        updateContextTokens(result.afterTokens);
      }
      return result;
    },
    [profileName, updateContextTokens],
  );

  const persistConfig = useCallback(
    async (next: KiroConfig): Promise<void> => {
      await saveConfig(next);
      baseConfigRef.current = next;
      let effective = next;
      try {
        effective = applyOverrides(next, overrides);
      } catch {
        if (overrides.profile) {
          addNotice(
            'muted',
            `CLI profile override "${overrides.profile}" is no longer configured; using the saved active profile.`,
          );
        }
      }
      configRef.current = effective;
      setRuntimeConfig(effective);
      setProfileName(effective.activeProfile);
    },
    [addNotice, overrides],
  );

  /** Saves a profile edit without resetting the session's active profile. */
  const persistProfileChange = useCallback(
    async (next: KiroConfig): Promise<void> => {
      await saveConfig(next);
      baseConfigRef.current = next;
      let effective = next;
      try {
        effective = applyOverrides(next, overrides);
      } catch {
        // A CLI override that no longer resolves falls back to the saved config.
      }
      configRef.current = effective;
      setRuntimeConfig(effective);
    },
    [overrides],
  );

  const selectModel = useCallback(
    async (name: string, model: string): Promise<void> => {
      setPickerOpen(false);
      const switching = name !== profileName;
      if (switching) setProfileName(name);
      try {
        await persistProfileChange(withProfileModel(baseConfigRef.current, name, model));
        addNotice(
          'info',
          switching
            ? `Switched to profile "${name}" (${model}).`
            : `Model "${model}" is now active for profile "${name}".`,
        );
      } catch (error) {
        addNotice('error', `Could not save the model choice: ${(error as Error).message}`);
      }
    },
    [addNotice, persistProfileChange, profileName],
  );

  const refreshProfileModels = useCallback(
    async (name: string): Promise<ModelRefreshResult> => {
      const profile = baseConfigRef.current.profiles[name] ?? configRef.current.profiles[name];
      if (!profile) return { ok: false, message: `Unknown profile "${name}".` };
      const key = profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined;
      if (profile.apiKeyEnv && !key) {
        return { ok: false, message: `API key is missing: $${profile.apiKeyEnv} is not set.` };
      }
      const result = await discoverModels({ baseUrl: profile.baseUrl, apiKey: key });
      if (!result.ok) return { ok: false, message: result.message };
      if (result.models.length === 0) {
        return { ok: false, message: 'The endpoint returned an empty model list.' };
      }
      try {
        await persistProfileChange(withProfileModels(baseConfigRef.current, name, result.models));
      } catch (error) {
        return { ok: false, message: `Could not save the model list: ${(error as Error).message}` };
      }
      return { ok: true };
    },
    [persistProfileChange],
  );

  const finishWizardPrompt = useCallback((value: string | null): void => {
    const resolve = wizardResolveRef.current;
    wizardResolveRef.current = null;
    setWizardPrompt(null);
    if (resolve) resolve(value);
  }, []);

  const wizardText = useCallback((options: TextPrompt): Promise<string | null> => {
    return new Promise<string | null>((resolve) => {
      const id = ++wizardPromptIdRef.current;
      wizardResolveRef.current = resolve;
      setWizardPrompt({ id, ...options });
    });
  }, []);

  const wizardUi = React.useMemo<ModelWizardUi>(
    () => ({
      note: (tone, text) => addNotice(tone, text),
      text: wizardText,
      confirm: async (label, defaultValue) => {
        for (;;) {
          const answer = await wizardText({
            label: `${label} [${defaultValue ? 'Y/n' : 'y/N'}]`,
            allowEmpty: true,
          });
          if (answer === null) return null;
          const value = answer.trim().toLowerCase();
          if (!value) return defaultValue;
          if (value === 'y' || value === 'yes') return true;
          if (value === 'n' || value === 'no') return false;
          addNotice('error', 'Please answer y or n.');
        }
      },
    }),
    [addNotice, wizardText],
  );

  const cancelWizard = useCallback((): void => {
    if (!wizardActiveRef.current) return;
    wizardCancelRequestedRef.current = true;
    wizardAbortRef.current?.abort();
    finishWizardPrompt(null);
  }, [finishWizardPrompt]);

  const runModelFlow = useCallback(
    async (flow: (ctx: WizardContext) => Promise<unknown>): Promise<void> => {
      if (wizardActiveRef.current || busyRef.current || transitioningRef.current) {
        addNotice('muted', 'Finish the current activity before changing models.');
        return;
      }
      wizardActiveRef.current = true;
      wizardCancelRequestedRef.current = false;
      const controller = new AbortController();
      wizardAbortRef.current = controller;
      setWizardActive(true);
      transitioningRef.current = true;

      const ctx: WizardContext = {
        ui: wizardUi,
        config: baseConfigRef.current,
        signal: controller.signal,
        cancelled: () => wizardCancelRequestedRef.current,
        save: persistConfig,
      };
      try {
        await flow(ctx);
      } catch (error) {
        addNotice('error', error instanceof Error ? error.message : String(error));
      } finally {
        finishWizardPrompt(null);
        wizardAbortRef.current = null;
        wizardActiveRef.current = false;
        wizardCancelRequestedRef.current = false;
        transitioningRef.current = false;
        setWizardActive(false);
        drainQueueRef.current?.();
      }
    },
    [addNotice, finishWizardPrompt, persistConfig, wizardUi],
  );

  const persistSession = useCallback((): Promise<void> => {
    const messages = dropIncompleteToolCalls(
      messagesRef.current.filter((message) => message.role !== 'system'),
    );
    if (messages.length === 0) return Promise.resolve();

    const now = new Date().toISOString();
    if (!sessionRef.current) {
      sessionRef.current = {
        id: newSessionId(),
        createdAt: now,
        title: titleFromMessages(messages),
      };
    }
    const session = sessionRef.current;
    const snapshot = structuredClone(messages);
    const usage = { ...sessionUsageRef.current };
    const write = saveChainRef.current
      .then(() =>
        saveSession({
          id: session.id,
          cwd,
          profile: profileName,
          model: configRef.current.profiles[profileName]?.model ?? 'unknown',
          title: session.title,
          createdAt: session.createdAt,
          messages: snapshot,
          usage,
        }),
      )
      .then(() => undefined)
      .catch((error: unknown) => {
        if (saveErrorShownRef.current) return;
        saveErrorShownRef.current = true;
        addNotice(
          'error',
          `Could not save session: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    saveChainRef.current = write;
    return write;
  }, [addNotice, cwd, profileName]);

  const quit = useCallback((): void => {
    if (quittingRef.current) return;
    quittingRef.current = true;
    void (async () => {
      await persistSession();
      await saveChainRef.current;
      exit();
    })();
  }, [exit, persistSession]);

  const disarmQuit = useCallback((): void => {
    if (quitTimerRef.current !== null) {
      clearTimeout(quitTimerRef.current);
      quitTimerRef.current = null;
    }
    quitArmedRef.current = false;
    setQuitArmed(false);
  }, []);

  const armQuit = useCallback((): void => {
    if (quitTimerRef.current !== null) clearTimeout(quitTimerRef.current);
    quitArmedRef.current = true;
    setQuitArmed(true);
    quitTimerRef.current = setTimeout(() => {
      quitTimerRef.current = null;
      quitArmedRef.current = false;
      setQuitArmed(false);
    }, QUIT_CONFIRM_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (quitTimerRef.current !== null) clearTimeout(quitTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (busy) disarmQuit();
  }, [busy, disarmQuit]);

  const flushText = useCallback((): void => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const chunk = textBufferRef.current;
    textBufferRef.current = '';
    if (!chunk) return;
    setItems((current) => {
      const last = current[current.length - 1];
      if (last?.kind === 'assistant' && last.draft) {
        return [...current.slice(0, -1), { ...last, text: last.text + chunk }];
      }
      return [...current, { kind: 'assistant', id: nextItemIdRef.current++, text: chunk, draft: true }];
    });
  }, []);

  const queueText = useCallback(
    (text: string): void => {
      textBufferRef.current += text;
      if (!flushTimerRef.current) {
        flushTimerRef.current = setTimeout(() => {
          flushTimerRef.current = null;
          flushText();
        }, 30);
      }
    },
    [flushText],
  );

  const finalizeAssistant = useCallback(
    (content: string, durationMs?: number, tokensPerSecond?: number): void => {
      setItems((current) => {
        const last = current[current.length - 1];
        if (last?.kind === 'assistant' && last.draft) {
          return [
            ...current.slice(0, -1),
            { ...last, text: content, draft: false, durationMs, tokensPerSecond },
          ];
        }
        return [
          ...current,
          { kind: 'assistant', id: nextItemIdRef.current++, text: content, durationMs, tokensPerSecond },
        ];
      });
    },
    [],
  );

  /** Marks live "thinking…" items finished; reasoning is display-only and not saved. */
  const finalizeReasoning = useCallback((): void => {
    setItems((current) => {
      if (!current.some((item) => item.kind === 'reasoning' && item.draft)) return current;
      return current.map((item) =>
        item.kind === 'reasoning' && item.draft ? { ...item, draft: false } : item,
      );
    });
  }, []);

  const resolveApproval = useCallback((decision: ApprovalDecision): void => {
    const request = pendingApprovalRef.current;
    const resolver = pendingResolverRef.current;
    pendingApprovalRef.current = null;
    pendingResolverRef.current = null;
    setPendingApproval(null);
    if (!request || !resolver) return;
    if (decision === 'allow-session') {
      approvalPolicy.markSession(request.tool);
      setAutoAllowed(approvalPolicy.list());
      addNotice(
        'info',
        `${request.tool} will run without asking. Use /allow to list, /allow clear to revoke.`,
      );
    }
    resolver(decision);
  }, [addNotice, approvalPolicy]);

  const approve = useCallback(
    (request: ApprovalRequest): Promise<ApprovalDecision> => {
      if (approvalPolicy.isAuto(request.tool)) return Promise.resolve('allow');
      if (abortRef.current?.signal.aborted) return Promise.resolve('deny');
      return new Promise<ApprovalDecision>((resolve) => {
        pendingApprovalRef.current = request;
        pendingResolverRef.current = resolve;
        setPendingApproval(request);
      });
    },
    [approvalPolicy],
  );

  const resetAutoAllowed = useCallback((): void => {
    approvalPolicy.clear();
    setAutoAllowed([]);
  }, [approvalPolicy]);

  const [skillCommands, setSkillCommands] = useState<SlashCommand[]>([]);
  const refreshSkillCommands = useCallback(async (): Promise<void> => {
    const inventory = await loadSkills(cwd);
    setSkillCommands(buildSkillCommands(inventory.skills));
  }, [cwd]);

  useEffect(() => {
    void refreshSkillCommands();
  }, [refreshSkillCommands]);

  /** Loads the session list for the picker; other directories are grouped by cwd. */
  const openSessionPicker = useCallback(async (): Promise<void> => {
    try {
      setSessionPicker(await listAllSessions(cwd, 20));
    } catch (error) {
      addNotice('error', error instanceof Error ? error.message : String(error));
    }
  }, [cwd, addNotice]);

  /** Mentions once per run when the model pulls instructions that came from the repo. */
  const noteProjectSkill = useCallback(
    async (rawArguments: string): Promise<void> => {
      let name: unknown;
      try {
        name = (JSON.parse(rawArguments || '{}') as { name?: unknown }).name;
      } catch {
        return;
      }
      if (typeof name !== 'string') return;
      const inventory = await loadSkills(cwd);
      const skill = findSkill(inventory.skills, name);
      if (skill?.source !== 'project') return;
      addNotice(
        'muted',
        `"${skill.name}" was loaded from this repository (${shortPath(skill.dir, cwd)}), not your ` +
          '~/.kiro settings. Its text steers the model; tool approvals still apply.',
      );
    },
    [addNotice, cwd],
  );

  const sendTurn = useCallback(
    async (rawInput: string, alreadyDisplayed = false, displayText?: string): Promise<void> => {
      if (busyRef.current || transitioningRef.current) return;
      const text = rawInput.trim();
      if (!text) return;
      const shown = displayText ?? text;

      busyRef.current = true;
      cancelRequestedRef.current = false;
      setBusy(true);
      setReplying(false);
      const startedAt = Date.now();
      setBusySince(startedAt);
      roundStartedAtRef.current = startedAt;
      roundCompletionTokensRef.current = null;
      setCancelling(false);
      setActiveTool(null);
      if (!alreadyDisplayed) {
        setItems((current) => [
          ...current,
          { kind: 'user', id: nextItemIdRef.current++, text: shown },
        ]);
      }
      messagesRef.current.push({ role: 'user', content: text });
      void recordPrompt(cwd, shown).then(setPromptHistory);
      recomputeContext();
      void persistSession();

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const systemPrompt = await buildSystemPrompt(cwd);
        messagesRef.current = [
          { role: 'system', content: systemPrompt },
          ...messagesRef.current.filter((message) => message.role !== 'system'),
        ];
        recomputeContext();
        const resolved = resolveProfile(configRef.current, profileName);
        const provider = createProvider(resolved.profile, resolved.apiKey);
        const ctx: ToolContext = {
          cwd,
          signal: controller.signal,
          approve,
        };

        for await (const event of runAgentTurn({
          provider,
          messages: messagesRef.current,
          ctx,
          compactContext: autoCompact,
        })) {
          switch (event.type) {
            case 'text':
              flushText();
              finalizeReasoning();
              setReplying(true);
              queueText(event.text);
              break;
            case 'reasoning': {
              flushText();
              setItems((current) => {
                const last = current[current.length - 1];
                if (last?.kind === 'reasoning' && last.draft) {
                  // Append live; MessageList clamps the rendered size.
                  return [...current.slice(0, -1), { ...last, text: (last.text + event.text).slice(-MAX_REASONING_CHARS) }];
                }
                return [
                  ...current,
                  {
                    kind: 'reasoning',
                    id: nextItemIdRef.current++,
                    text: event.text,
                    draft: true,
                  },
                ];
              });
              break;
            }
            case 'assistant': {
              flushText();
              finalizeReasoning();
              const durationMs = Math.max(0, Date.now() - roundStartedAtRef.current);
              const completionTokens = roundCompletionTokensRef.current;
              const tokensPerSecond =
                completionTokens !== null && completionTokens > 0 && durationMs > 0
                  ? Math.round(completionTokens / (durationMs / 1_000))
                  : undefined;
              finalizeAssistant(event.content, durationMs, tokensPerSecond);
              setLastReply({ durationMs, tokensPerSecond });
              roundCompletionTokensRef.current = null;
              setReplying(false);
              recomputeContext();
              break;
            }
            case 'tool-start':
              flushText();
              finalizeReasoning();
              setReplying(false);
              setActiveTool(event.toolCall.function.name);
              setItems((current) => [
                ...current,
                {
                  kind: 'tool',
                  id: nextItemIdRef.current++,
                  callId: event.toolCall.id,
                  name: event.toolCall.function.name,
                  argsSummary: summarizeToolArgs(
                    event.toolCall.function.name,
                    event.toolCall.function.arguments,
                  ),
                  status: 'running',
                },
              ]);
              break;
            case 'tool-end':
              setActiveTool(null);
              setItems((current) => {
                const index = current.findIndex(
                  (item) => item.kind === 'tool' && item.callId === event.toolCall.id && item.status === 'running',
                );
                if (index === -1) return current;
                const next = [...current];
                const item = next[index];
                if (item?.kind !== 'tool') return current;
                next[index] = {
                  ...item,
                  status: event.result.status,
                  resultSummary: event.result.summary,
                  resultFull: event.result.content.slice(0, MAX_EXPANDED_TOOL_CHARS),
                  durationMs: event.durationMs,
                };
                return next;
              });
              recomputeContext();
              if (
                event.toolCall.function.name === 'read_skill' &&
                event.result.status === 'ok' &&
                !projectSkillNotedRef.current
              ) {
                projectSkillNotedRef.current = true;
                void noteProjectSkill(event.toolCall.function.arguments);
              }
              // The next model round starts once the tools for this one finish.
              roundStartedAtRef.current = Date.now();
              roundCompletionTokensRef.current = null;
              break;
            case 'usage': {
              usageRef.current = {
                tokens: event.usage.totalTokens,
                // The assistant message from this response is appended after the
                // stream ends and is already counted in totalTokens.
                messageCount: messagesRef.current.length + 1,
              };
              const totals = addUsage(sessionUsageRef.current, event.usage);
              sessionUsageRef.current = totals;
              setSessionUsage(totals);
              roundCompletionTokensRef.current = event.usage.completionTokens;
              recomputeContext();
              break;
            }
            case 'notice':
              flushText();
              addNotice(event.level, event.message);
              break;
            case 'done':
              flushText();
              finalizeReasoning();
              recomputeContext();
              if (event.reason === 'aborted') {
                addNotice('info', 'Turn cancelled.');
              }
              break;
          }
        }
      } catch (error) {
        flushText();
        finalizeReasoning();
        addNotice('error', error instanceof Error ? error.message : String(error));
      } finally {
        flushText();
        finalizeReasoning();
        abortRef.current = null;
        busyRef.current = false;
        setBusy(false);
        setReplying(false);
        setBusySince(null);
        setActiveTool(null);
        setCancelling(false);
        if (pendingApprovalRef.current) resolveApproval('deny');
        recomputeContext();
        void persistSession();
        void refreshSkillCommands();
        if (!quittingRef.current) {
          if (cancelRequestedRef.current && queuedRef.current.length > 0) {
            queuedRef.current = [];
            setQueuedCount(0);
            addNotice('muted', 'Queued messages were discarded after the cancel.');
          }
          // Messages typed while the agent was working run next, like a chat queue.
          drainQueueRef.current?.();
        }
      }
    },
    [
      addNotice,
      approve,
      autoCompact,
      cwd,
      finalizeAssistant,
      flushText,
      noteProjectSkill,
      persistSession,
      refreshSkillCommands,
      profileName,
      queueText,
      recomputeContext,
      resolveApproval,
    ],
  );

  const runProfileTest = useCallback(
    async (requested?: string): Promise<void> => {
      if (busyRef.current || transitioningRef.current || wizardActiveRef.current) {
        addNotice('muted', 'Finish the current activity first.');
        return;
      }
      transitioningRef.current = true;
      try {
        const name = requested ?? profileName;
        const profile = configRef.current.profiles[name];
        if (!profile) {
          addNotice(
            'error',
            `Unknown profile "${name}". Available profiles: ${Object.keys(configRef.current.profiles).join(', ')}.`,
          );
          return;
        }
        const key = profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined;
        if (profile.apiKeyEnv && !key) {
          addNotice(
            'error',
            `API key is missing: $${profile.apiKeyEnv} is not set (profile "${name}"). ` +
              `Store it with /model edit ${name}.`,
          );
          return;
        }
        addNotice('muted', `Testing ${profile.baseUrl} with model "${profile.model}"…`);
        const result = await testConnection(profile, key);
        addNotice(result.ok ? 'info' : 'error', result.message);
      } finally {
        transitioningRef.current = false;
      }
    },
    [addNotice, profileName],
  );

  const listRemoteModels = useCallback(async (): Promise<void> => {
    if (busyRef.current || transitioningRef.current || wizardActiveRef.current) {
      addNotice('muted', 'Finish the current activity first.');
      return;
    }
    transitioningRef.current = true;
    try {
      const profile = configRef.current.profiles[profileName];
      if (!profile) {
        addNotice('error', `Unknown active profile "${profileName}".`);
        return;
      }
      const key = profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined;
      if (profile.apiKeyEnv && !key) {
        addNotice(
          'error',
          `API key is missing: $${profile.apiKeyEnv} is not set (profile "${profileName}").`,
        );
        return;
      }
      addNotice('muted', `Fetching models from ${profile.baseUrl}…`);
      const result = await discoverModels({ baseUrl: profile.baseUrl, apiKey: key });
      if (!result.ok) {
        addNotice('error', result.message);
        return;
      }
      if (result.models.length === 0) {
        addNotice('muted', 'The endpoint returned an empty model list. Use /model add to enter a model id manually.');
        return;
      }
      const shown = result.models.slice(0, 100);
      const lines = [
        `Models offered by ${profile.baseUrl} (${result.models.length}):`,
        ...shown.map((id) => `  ${id}`),
      ];
      if (result.models.length > shown.length) {
        lines.push(`  … and ${result.models.length - shown.length} more`);
      }
      addNotice('info', lines.join('\n'));
    } finally {
      transitioningRef.current = false;
    }
  }, [addNotice, profileName]);

  const expandLastToolOutput = useCallback((): void => {
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index];
      if (item?.kind !== 'tool' || !item.resultFull) continue;
      const expanding = expandedToolId !== item.id;
      setExpandedToolId(expanding ? item.id : null);
      if (expanding) {
        addNotice('muted', `Showing the full ${item.name} output above; Ctrl+O collapses it.`);
      }
      return;
    }
    addNotice('muted', 'No finished tool output to expand yet.');
  }, [addNotice, expandedToolId, items]);

  const handleCommand = useCallback(
    async (input: string): Promise<void> => {
      if (busyRef.current || transitioningRef.current) return;
      const [command, ...rest] = input.trim().split(/\s+/);
      const argument = rest[0];
      if (!command) return;

      switch (command) {
        case '/help': {
          addNotice(
            'info',
            [
              'Commands (type / to open the menu, ↑↓ to choose, Enter to run):',
              ...slashHelpLines(skillCommands.length),
              '',
              '  Model subcommands: /model <name> · /model add · /model edit [name] ·',
              '                     /model remove [name] · /model test [name] · /model list --remote',
              '  Sessions: /resume opens a picker; ←/→ switches between this directory and others.',
              '',
              'Keys: Enter sends · / opens commands · PgUp/PgDn scrolls · Ctrl+O expands tool output ·',
              '      Tab completes a command · Esc cancels a wizard step · /mouse toggles wheel scroll',
              '      Ctrl+C cancels a turn, again exits',
              yolo
                ? '      YOLO mode is on: every write and command runs without approval.'
                : '      [a] on an approval prompt allows that tool for the rest of the session.',
            ].join('\n'),
          );
          return;
        }
        case '/model': {
          const listProfiles = (): void => {
            addNotice(
              'info',
              [
                ...formatProfileList(configRef.current),
                '',
                'Use /model <name> to switch, /model add to create one, or /model list --remote to see endpoint models.',
              ].join('\n'),
            );
          };

          if (!argument) {
            setPickerOpen(true);
            return;
          }
          if (argument === 'list') {
            if (rest[1] === '--remote') {
              void listRemoteModels();
              return;
            }
            if (rest[1]) {
              addNotice('error', 'Usage: /model list [--remote]');
              return;
            }
            listProfiles();
            return;
          }
          if (argument === 'add') {
            void runModelFlow((ctx) => runAddFlow(ctx));
            return;
          }
          if (argument === 'edit') {
            void runModelFlow((ctx) => runEditFlow(ctx, rest[1]));
            return;
          }
          if (argument === 'remove') {
            void runModelFlow((ctx) => runRemoveFlow(ctx, rest[1]));
            return;
          }
          if (argument === 'test') {
            void runProfileTest(rest[1]);
            return;
          }

          const profile = configRef.current.profiles[argument];
          if (!profile) {
            addNotice(
              'error',
              `Unknown profile "${argument}". Available profiles: ${Object.keys(configRef.current.profiles).join(', ')}.`,
            );
            return;
          }
          if (profile.type !== 'openai') {
            addNotice(
              'error',
              `Profile "${argument}" uses unsupported provider type "${profile.type}". Phase 1 supports "openai".`,
            );
            return;
          }
          setProfileName(argument);
          addNotice('info', `Switched to profile "${argument}" (${profile.model}).`);
          return;
        }
        case '/context': {
          recomputeContext();
          const profile = configRef.current.profiles[profileName];
          const window = contextWindowFor(profile);
          const used = contextTokensRef.current;
          const count = (role: ChatMessage['role']): number =>
            estimateMessagesTokens(messagesRef.current.filter((message) => message.role === role));
          const usage = usageRef.current;
          const totals = sessionUsageRef.current;
          addNotice(
            'info',
            [
              `Context: ~${formatTokens(used)} / ${formatTokens(window)} tokens (${formatPercent(used, window)} used)` +
                (profile?.contextWindow
                  ? '.'
                  : '. Window inferred from the model id; set "contextWindow" in the profile to override.'),
              `  system ~${formatTokens(count('system'))} · user ~${formatTokens(count('user'))} · ` +
                `assistant ~${formatTokens(count('assistant'))} · tool ~${formatTokens(count('tool'))}`,
              usage
                ? `Last API usage: ${usage.tokens.toLocaleString()} tokens for the last request and response.`
                : 'The endpoint has not reported usage; counts are estimated at roughly 4 characters per token.',
              totals.requests > 0
                ? `Session usage: ↑ ${formatTokens(totals.promptTokens)} sent, ↓ ${formatTokens(totals.completionTokens)} received ` +
                  `across ${totals.requests} API request${totals.requests === 1 ? '' : 's'} (saved with this session).`
                : 'Session usage: the endpoint has not reported token counts for this session yet.',
              `Auto-compaction runs at ${Math.round(COMPACT_THRESHOLD * 100)}% and keeps the last ${COMPACT_KEEP_USER_TURNS} user turns verbatim. /compact runs it now.`,
            ].join('\n'),
          );
          return;
        }
        case '/usage': {
          if (argument) {
            addNotice('error', 'Usage: /usage (toggles the usage card)');
            return;
          }
          const next = !usageCardEnabled;
          setUsageCardEnabled(next);
          addNotice(
            'info',
            next
              ? 'Usage card on; it appears when the terminal is at least 110 columns wide.'
              : 'Usage card hidden; the transcript gets the full width. Use /usage to show it again.',
          );
          return;
        }
        case '/skills': {
          if (argument) {
            addNotice('error', 'Usage: /skills');
            return;
          }
          const inventory = await loadSkills(cwd);
          addNotice(
            inventory.skills.length === 0 && inventory.invalid.length === 0 ? 'muted' : 'info',
            formatSkillList(inventory, cwd, builtinCommandNames()),
          );
          return;
        }
        case '/skill': {
          if (!argument) {
            addNotice('error', 'Usage: /skill <name> [request]. Run /skills to list installed skills.');
            return;
          }
          const line = input.trim();
          const request = line
            .slice(command.length)
            .trim()
            .slice(argument.length)
            .trim();
          const inventory = await loadSkills(cwd);
          const skill = findSkill(inventory.skills, argument);
          if (!skill) {
            addNotice(
              'error',
              inventory.disabled
                ? 'Skills are disabled for this run (--no-skills).'
                : inventory.skills.length === 0
                  ? 'No skills installed. Add one at .kiro/skills/<name>/SKILL.md.'
                  : `Unknown skill "${argument}". Installed: ${inventory.skills.map((entry) => entry.name).join(', ')}.`,
            );
            return;
          }
          void sendTurn(skillInvocationMessage(skill, request), false, line);
          return;
        }
        case '/compact': {
          if (messagesRef.current.length === 0) {
            addNotice('muted', 'There is no conversation to compact yet.');
            return;
          }
          const controller = new AbortController();
          busyRef.current = true;
          abortRef.current = controller;
          setBusy(true);
          addNotice('muted', 'Compacting earlier conversation…');
          try {
            const resolved = resolveProfile(configRef.current, profileName);
            const provider = createProvider(resolved.profile, resolved.apiKey);
            const result = await compactMessages({
              messages: messagesRef.current,
              provider,
              signal: controller.signal,
              keepUserTurns: COMPACT_KEEP_USER_TURNS,
            });
            if (!result) {
              addNotice(
                'muted',
                `Nothing to compact yet; Kiro keeps the last ${COMPACT_KEEP_USER_TURNS} user turns verbatim and needs older turns first.`,
              );
              return;
            }
            messagesRef.current.splice(0, messagesRef.current.length, ...result.messages);
            usageRef.current = null;
            updateContextTokens(result.afterTokens);
            await persistSession();
            addNotice(
              'info',
              `Compacted ${result.summarizedMessages} earlier messages ` +
                `(~${formatTokens(result.beforeTokens)} → ~${formatTokens(result.afterTokens)} tokens).`,
            );
          } catch (error) {
            if (controller.signal.aborted) {
              addNotice('info', 'Compaction cancelled.');
            } else {
              addNotice(
                'error',
                `Could not compact context: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          } finally {
            abortRef.current = null;
            busyRef.current = false;
            setBusy(false);
          }
          return;
        }
        case '/sessions':
        case '/resume': {
          transitioningRef.current = true;
          try {
            if (command === '/resume' && !argument) {
              await openSessionPicker();
              return;
            }
            if (command === '/sessions' || !argument) {
              const data = await listAllSessions(cwd, 10);
              listedSessionsRef.current = data.current;
              const otherCount = data.others.reduce((total, group) => total + group.sessions.length, 0);
              if (data.current.length === 0 && otherCount === 0) {
                addNotice(
                  'info',
                  `No saved sessions for this directory yet. Sessions are stored in ${projectSessionsDir(cwd)}.`,
                );
              } else {
                const lines: string[] = ['Sessions (most recent first):'];
                lines.push(`This directory (${data.current.length}):`);
                if (data.current.length === 0) lines.push('  (none)');
                data.current.forEach((session, index) => {
                  const marker = session.id === sessionRef.current?.id ? '*' : ' ';
                  const messages = `${session.messageCount} msg${session.messageCount === 1 ? '' : 's'}`;
                  lines.push(
                    `${marker} ${index + 1}. ${session.id}  ${formatSessionTime(
                      session.updatedAt,
                    )}  ${messages}  ${session.title}`,
                  );
                });
                if (otherCount > 0) {
                  lines.push('Other directories:');
                  for (const group of data.others) {
                    lines.push(`  ${shortCwd(group.cwd, cwd)}`);
                    for (const session of group.sessions) {
                      const messages = `${session.messageCount} msg${session.messageCount === 1 ? '' : 's'}`;
                      lines.push(
                        `    ${session.id}  ${formatSessionTime(session.updatedAt)}  ${messages}  ${session.title}`,
                      );
                    }
                  }
                }
                lines.push(
                  '',
                  'Use /resume to pick a session, or /resume <number|id> for this directory.',
                );
                addNotice('info', lines.join('\n'));
              }
              if (data.skipped > 0) {
                addNotice(
                  'muted',
                  `Skipped ${data.skipped} unreadable session file${data.skipped === 1 ? '' : 's'}.`,
                );
              }
              return;
            }

            let sessions = listedSessionsRef.current;
            if (!sessions) {
              sessions = (await listSessions(cwd, 10)).sessions;
              listedSessionsRef.current = sessions;
            }

            let target: SessionSummary | undefined;
            const numeric = /^\d+$/.test(argument);
            if (numeric) {
              target = sessions[Number(argument) - 1];
            } else {
              target = sessions.find((session) => session.id === argument);
              if (!target) {
                const matches = sessions.filter((session) => session.id.startsWith(argument));
                if (matches.length > 1) {
                  addNotice('error', `Session id "${argument}" is ambiguous; use more characters.`);
                  return;
                }
                target = matches[0];
              }
            }
            if (!target && (numeric || !isSessionId(argument))) {
              addNotice('error', `No saved session matches "${argument}". Use /sessions to list them.`);
              return;
            }
            const targetId = target?.id ?? argument;
            if (targetId === sessionRef.current?.id) {
              addNotice('info', `Session ${targetId} is already active.`);
              return;
            }

            await persistSession();
            await saveChainRef.current;
            const record = await loadSession(cwd, targetId);
            messagesRef.current = record.messages.filter((message) => message.role !== 'system');
            usageRef.current = null;
            const restoredUsage = record.usage ?? EMPTY_USAGE;
            sessionUsageRef.current = restoredUsage;
            setSessionUsage(restoredUsage);
            setLastReply(null);
            recomputeContext();
            sessionRef.current = {
              id: record.id,
              createdAt: record.createdAt,
              title: record.title,
            };
            const view = buildResumedView(messagesRef.current, {
              cwd,
              version,
              sessionId: record.id,
            });
            setItems(view.items);
            nextItemIdRef.current = view.nextId;
            setResetSignal((current) => current + 1);
            setExpandedToolId(null);
            resetAutoAllowed();
            if (record.profile && record.profile !== profileName) {
              addNotice(
                'muted',
                `Session was saved with profile "${record.profile}"; staying on "${profileName}". Use /model ${record.profile} to switch.`,
              );
            }
          } catch (error) {
            addNotice('error', error instanceof Error ? error.message : String(error));
          } finally {
            transitioningRef.current = false;
          }
          return;
        }
        case '/clear': {
          transitioningRef.current = true;
          try {
            await persistSession();
            await saveChainRef.current;
            messagesRef.current = [];
            usageRef.current = null;
            sessionUsageRef.current = EMPTY_USAGE;
            setSessionUsage(EMPTY_USAGE);
            setLastReply(null);
            updateContextTokens(0);
            sessionRef.current = null;
            listedSessionsRef.current = null;
            resetAutoAllowed();
            setItems([
              { kind: 'banner', id: nextItemIdRef.current++, cwd, version },
              {
                kind: 'notice',
                id: nextItemIdRef.current++,
                level: 'info',
                text: 'Conversation cleared. Your next message starts a new session.',
              },
            ]);
            setResetSignal((current) => current + 1);
            setExpandedToolId(null);
          } finally {
            transitioningRef.current = false;
          }
          return;
        }
        case '/export': {
          const transcript = messagesRef.current.filter((message) => message.role !== 'system');
          if (transcript.length === 0) {
            addNotice('muted', 'There is no conversation to export yet.');
            return;
          }
          const target = argument
            ? path.resolve(cwd, argument)
            : defaultExportPath(sessionRef.current?.id);
          try {
            await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
            await writeFile(
              target,
              renderTranscriptMarkdown(transcript, {
                cwd,
                sessionId: sessionRef.current?.id,
                profile: profileName,
                model: configRef.current.profiles[profileName]?.model,
                version,
              }),
              { encoding: 'utf8', mode: 0o600 },
            );
            addNotice(
              'info',
              `Transcript written to ${target} (${transcript.length} messages, full tool output included).`,
            );
          } catch (error) {
            addNotice(
              'error',
              `Could not export the transcript: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          return;
        }
        case '/mouse': {
          if (argument) {
            addNotice('error', 'Usage: /mouse (toggles mouse reporting)');
            return;
          }
          const next = !mouseOn;
          setMouseOn(next);
          addNotice(
            'info',
            next
              ? 'Mouse reporting on: the wheel scrolls the transcript, but text selection needs Shift+drag.'
              : 'Mouse reporting off: click-drag selects text normally; use PgUp/PgDn to scroll.',
          );
          return;
        }
        case '/allow': {
          if (argument === 'clear') {
            resetAutoAllowed();
            addNotice(
              'info',
              yolo
                ? 'Session allowances cleared. YOLO mode still runs everything without asking; restart without --yolo to get prompts back.'
                : 'Session allowances cleared. Every tool will ask for approval again.',
            );
            return;
          }
          if (argument) {
            addNotice('error', 'Usage: /allow or /allow clear');
            return;
          }
          addNotice(
            'info',
            yolo
              ? `YOLO mode is on: nothing asks for approval.${autoAllowed.length > 0 ? ` Also allowed for this session: ${autoAllowed.join(', ')}.` : ''}\nUse /allow clear to drop the session allowances.`
              : autoAllowed.length === 0
                ? 'No tools are auto-allowed. Choose [a] on an approval prompt to allow a tool for the rest of the session.'
                : `Auto-allowed this session: ${autoAllowed.join(', ')}\nUse /allow clear to ask again.`,
          );
          return;
        }
        case '/undo': {
          if (argument) {
            addNotice('error', 'Usage: /undo (reverts the last file change; run again to step back)');
            return;
          }
          try {
            const result = await undoLastCheckpoint(cwd);
            if (!result) {
              addNotice('muted', 'Nothing to undo yet: records start with the first write, edit, or patch Kiro performs.');
              return;
            }
            const reverted = [...result.restored, ...result.deleted];
            addNotice(
              'info',
              `Reverted ${reverted.length} file${reverted.length === 1 ? '' : 's'} from ${result.tool}: ` +
                [
                  ...result.restored.map((p) => `restored ${p}`),
                  ...result.deleted.map((p) => `deleted ${p}`),
                ].join(', '),
            );
          } catch (error) {
            addNotice(
              'error',
              `/undo failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          return;
        }
        case '/exit':
          quit();
          return;
        default: {
          const skillName = command.startsWith('/') ? command.slice(1) : '';
          if (skillName) {
            const inventory = await loadSkills(cwd);
            const skill = findSkill(inventory.skills, skillName);
            if (skill) {
              const line = input.trim();
              void sendTurn(
                skillInvocationMessage(skill, line.slice(command.length).trim()),
                false,
                line,
              );
              return;
            }
          }
          addNotice('error', `Unknown command "${command}". Type /help for commands.`);
        }
      }
    },
    [
      addNotice,
      autoAllowed,
      cwd,
      listRemoteModels,
      mouseOn,
      openSessionPicker,
      persistSession,
      profileName,
      quit,
      recomputeContext,
      resetAutoAllowed,
      runModelFlow,
      runProfileTest,
      sendTurn,
      updateContextTokens,
      usageCardEnabled,
      version,
      yolo,
    ],
  );

  /** Resumes a picker selection only when it belongs to the current directory. */
  const handleSessionPick = (session: SessionSummary): void => {
    setSessionPicker(null);
    if (path.resolve(session.cwd) !== path.resolve(cwd)) {
      addNotice(
        'info',
        `Session ${session.id} belongs to ${shortCwd(session.cwd, cwd)}. Start kiro in that directory to resume it.`,
      );
      return;
    }
    void handleCommand(`/resume ${session.id}`);
  };

  /** Runs the next queued item once the app is idle, including queued slash commands. */
  const drainQueue = useCallback((): void => {
    if (
      busyRef.current ||
      transitioningRef.current ||
      wizardActiveRef.current ||
      quittingRef.current
    ) {
      return;
    }
    const next = queuedRef.current.shift();
    setQueuedCount(queuedRef.current.length);
    if (!next) return;
    if (next.startsWith('/')) {
      void handleCommand(next).finally(() => drainQueueRef.current?.());
      return;
    }
    handleSubmitRef.current?.(next, true);
  }, [handleCommand]);
  drainQueueRef.current = drainQueue;

  const handleSubmit = useCallback(
    (value: string, fromQueue = false): void => {
      if (wizardResolveRef.current || wizardPromptRef.current) {
        finishWizardPrompt(value);
        return;
      }
      const trimmed = value.trim();
      if (!trimmed) return;
      const isCommand = trimmed.startsWith('/') && !trimmed.includes('\n');
      if (wizardActiveRef.current || transitioningRef.current) {
        // The wizard owns the keyboard; ignore stray input.
        return;
      }
      if (busyRef.current && !fromQueue) {
        // Type-ahead: the message runs as soon as the current turn finishes.
        queuedRef.current.push(trimmed);
        setQueuedCount(queuedRef.current.length);
        if (!isCommand) {
          setItems((current) => [
            ...current,
            { kind: 'user', id: nextItemIdRef.current++, text: trimmed },
          ]);
        }
        addNotice(
          'muted',
          'Queued. It runs after the current turn; PgUp/PgDn still scrolls the transcript meanwhile.',
        );
        return;
      }
      if (isCommand) {
        void handleCommand(trimmed).finally(() => drainQueueRef.current?.());
        return;
      }
      void sendTurn(trimmed);
    },
    [addNotice, finishWizardPrompt, handleCommand, sendTurn],
  );
  handleSubmitRef.current = handleSubmit;

  useEffect(() => {
    if (configCreated) {
      addNotice(
        'info',
        `Created config template at ${configPath}. Set your endpoint, model, and API key.`,
      );
    }
    void loadPromptHistory(cwd).then(setPromptHistory);
    const active = config.profiles[config.activeProfile];
    if (active) {
      if (active.type !== 'openai') {
        addNotice('error', `Profile "${config.activeProfile}" uses unsupported provider type "${active.type}".`);
      } else if (active.apiKeyEnv && !process.env[active.apiKeyEnv]) {
        addNotice(
          'error',
          `API key is not set: export ${active.apiKeyEnv}=... (profile "${config.activeProfile}").`,
        );
      }
    }
    if (initialSession?.profile && initialSession.profile !== config.activeProfile) {
      addNotice(
        'muted',
        `Session ${initialSession.id} was saved with profile "${initialSession.profile}"; using "${config.activeProfile}". Use /model ${initialSession.profile} to switch.`,
      );
    }
    for (const notice of startupNotices ?? []) addNotice(notice.level, notice.text);
    // Startup notices only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!stdout.isTTY) return;
    stdout.write(mouseOn ? MOUSE_ON : MOUSE_OFF);
    return () => {
      if (stdout.isTTY) stdout.write(MOUSE_OFF);
    };
  }, [stdout, mouseOn]);

  useInput((input, key) => {
    if (key.ctrl && input === 'o') {
      if (wizardActiveRef.current || wizardPromptRef.current || pendingApprovalRef.current) return;
      if (pickerOpen || sessionPicker !== null) return;
      expandLastToolOutput();
      return;
    }
    if (!(key.ctrl && input === 'c')) return;
    if (pickerOpen) {
      disarmQuit();
      setPickerOpen(false);
      return;
    }
    if (sessionPicker !== null) {
      disarmQuit();
      setSessionPicker(null);
      return;
    }
    if (wizardActiveRef.current) {
      disarmQuit();
      cancelWizard();
      return;
    }
    if (pendingApprovalRef.current) {
      disarmQuit();
      cancelRequestedRef.current = true;
      setCancelling(true);
      resolveApproval('deny');
      abortRef.current?.abort();
      return;
    }
    if (busyRef.current) {
      if (cancelRequestedRef.current) {
        quit();
        return;
      }
      cancelRequestedRef.current = true;
      setCancelling(true);
      abortRef.current?.abort();
      return;
    }
    if (quitArmedRef.current) {
      disarmQuit();
      quit();
      return;
    }
    armQuit();
  });

  const activity: Activity = pendingApproval
    ? 'approval'
    : cancelling
      ? 'cancelling'
      : busy
        ? activeTool
          ? 'running'
          : replying
            ? 'replying'
            : 'thinking'
        : null;
  const activeProfile = runtimeConfig.profiles[profileName];
  const contextWindow = contextWindowFor(activeProfile);
  const pickerPopup =
    (pickerOpen || sessionPicker !== null) && !pendingApproval
      ? pickerPopupRect(columns, rows)
      : null;
  const pickerInline = pickerOpen && !pendingApproval && pickerPopup === null;
  const sessionInline =
    sessionPicker !== null && !pendingApproval && pickerPopup === null && !pickerOpen;
  const extraInputRows =
    pendingApproval || pickerInline || sessionInline ? 0 : Math.max(0, inputRows - 1);
  const viewportHeight = Math.max(
    3,
    rows -
      5 -
      extraInputRows -
      (pendingApproval ? 12 : 0) -
      (pickerInline ? PICKER_INLINE_ROWS : 0) -
      (sessionInline ? SESSION_INLINE_ROWS : 0),
  );
  const showUsageCard = usageCardEnabled && shouldShowUsageCard(columns, viewportHeight);
  const chatWidth = showUsageCard ? Math.max(40, width - USAGE_CARD_WIDTH - USAGE_CARD_GAP) : width;

  return (
    <Box flexDirection="column" width={columns} paddingX={1}>
      <Box flexDirection="row" alignItems="flex-end" width={width}>
        <MessageList
          items={items}
          width={chatWidth}
          height={viewportHeight}
          resetSignal={resetSignal}
          expandedToolId={expandedToolId}
          palette={palette}
          interactive={
            !pendingApproval && !pickerOpen && sessionPicker === null && !wizardActive && wizardPrompt === null
          }
        />
        {showUsageCard ? (
          <Box marginLeft={USAGE_CARD_GAP} flexShrink={0}>
            <UsageCard
              usage={sessionUsage}
              contextTokens={contextTokens}
              contextWindow={contextWindow}
              contextEstimated={usageRef.current === null}
              lastReply={lastReply}
              busy={busy}
            />
          </Box>
        ) : null}
      </Box>
      {pendingApproval ? (
        <ApprovalPrompt
          request={pendingApproval}
          width={width}
          onDecision={resolveApproval}
        />
      ) : pickerInline ? (
        <ModelPicker
          config={runtimeConfig}
          activeProfile={profileName}
          width={width}
          onSelect={(name, model) => void selectModel(name, model)}
          onRefresh={refreshProfileModels}
          onCancel={() => setPickerOpen(false)}
        />
      ) : sessionInline && sessionPicker ? (
        <SessionPicker
          cwd={cwd}
          data={sessionPicker}
          activeSessionId={sessionRef.current?.id ?? null}
          width={width}
          onSelect={handleSessionPick}
          onCancel={() => setSessionPicker(null)}
        />
      ) : (
        <Input
          key={wizardPrompt?.id ?? 0}
          disabled={pickerOpen || sessionPicker !== null}
          width={width}
          mask={wizardPrompt?.mask}
          allowEmpty={wizardPrompt?.allowEmpty}
          fileMenu={!wizardActive && !wizardPrompt}
          loadFiles={loadFileIndex}
          maxRows={Math.max(1, Math.min(6, rows - 9))}
          history={wizardPrompt || wizardActive ? undefined : promptHistory}
          slashCommands={[...SLASH_COMMANDS, ...skillCommands]}
          onPaletteChange={setPalette}
          onHeightChange={setInputRows}
          placeholder={
            pickerOpen
              ? 'Model picker open · Esc to close'
              : sessionPicker
                ? 'Session picker open · Esc to close'
                : wizardPrompt
                ? wizardPrompt.defaultValue && !wizardPrompt.mask
                  ? `${wizardPrompt.label} [${wizardPrompt.defaultValue}]`
                  : wizardPrompt.label
                : busy
                  ? 'Kiro is working… type ahead, or Ctrl+C to cancel'
                  : wizardActive
                    ? 'Working… Esc to cancel'
                    : 'Ask Kiro to build or change something…'
          }
          slashMenu={!wizardActive && !wizardPrompt}
          onSubmit={handleSubmit}
          onCancel={wizardActive ? cancelWizard : undefined}
        />
      )}
      <StatusBar
        width={width}
        profile={profileName}
        model={activeProfile?.model ?? 'unknown'}
        cwd={cwd}
        activity={activity}
        toolName={activeTool ?? undefined}
        busySince={busySince ?? undefined}
        queued={queuedCount > 0 ? queuedCount : undefined}
        yolo={yolo}
        autoAllowed={autoAllowed}
        quitHint={quitArmed}
        contextTokens={showUsageCard ? undefined : contextTokens}
        contextWindow={showUsageCard ? undefined : contextWindow}
      />
      {pickerOpen && pickerPopup ? (
        <Box position="absolute" marginTop={pickerPopup.top} marginLeft={pickerPopup.left}>
          <ModelPicker
            config={runtimeConfig}
            activeProfile={profileName}
            width={pickerPopup.width}
            height={pickerPopup.height}
            onSelect={(name, model) => void selectModel(name, model)}
            onRefresh={refreshProfileModels}
            onCancel={() => setPickerOpen(false)}
          />
        </Box>
      ) : sessionPicker && pickerPopup ? (
        <Box position="absolute" marginTop={pickerPopup.top} marginLeft={pickerPopup.left}>
          <SessionPicker
            cwd={cwd}
            data={sessionPicker}
            activeSessionId={sessionRef.current?.id ?? null}
            width={pickerPopup.width}
            height={pickerPopup.height}
            onSelect={handleSessionPick}
            onCancel={() => setSessionPicker(null)}
          />
        </Box>
      ) : null}
    </Box>
  );
}
