import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, useApp, useInput, useStdout } from 'ink';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildSystemPrompt } from '../agent/prompt.js';
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
  listSessions,
  loadSession,
  newSessionId,
  projectSessionsDir,
  saveSession,
  titleFromMessages,
  type SessionRecord,
  type SessionSummary,
} from '../sessions.js';
import type { ApprovalDecision, ApprovalRequest, ToolContext } from '../tools/types.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';
import { ApprovalPolicy } from './approval-policy.js';
import { slashHelpLines } from './commands.js';
import { defaultExportPath, renderTranscriptMarkdown } from './export.js';
import { buildResumedView } from './history.js';
import { Input } from './Input.js';
import { MessageList } from './MessageList.js';
import { MOUSE_OFF, MOUSE_ON } from './mouse.js';
import { ModelPicker, type ModelRefreshResult } from './ModelPicker.js';
import { withProfileModel, withProfileModels } from './model-picker.js';
import { formatProfileList } from './profile-list.js';
import { loadPromptHistory, recordPrompt } from './prompt-history.js';
import { StatusBar, type Activity } from './StatusBar.js';
import { summarizeToolArgs } from './text.js';
import { undoLastCheckpoint } from '../tools/checkpoint.js';
import { MAX_EXPANDED_TOOL_CHARS, MAX_REASONING_CHARS, type ViewItem } from './types.js';

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
  const [wizardPrompt, setWizardPrompt] = useState<WizardPromptState | null>(null);
  const [wizardActive, setWizardActive] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [slashMenuRows, setSlashMenuRows] = useState(0);
  const [mouseOn, setMouseOn] = useState(mouseEnabled);
  const [expandedToolId, setExpandedToolId] = useState<number | null>(null);

  const messagesRef = useRef<ChatMessage[]>(
    (initialSession?.messages ?? []).filter((message) => message.role !== 'system'),
  );
  const usageRef = useRef<{ tokens: number; messageCount: number } | null>(null);
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

  const handleMenuRowsChange = useCallback((rows: number): void => {
    setSlashMenuRows((current) => (current === rows ? current : rows));
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

  const finalizeAssistant = useCallback((content: string): void => {
    setItems((current) => {
      const last = current[current.length - 1];
      if (last?.kind === 'assistant' && last.draft) {
        return [...current.slice(0, -1), { ...last, text: content, draft: false }];
      }
      return [...current, { kind: 'assistant', id: nextItemIdRef.current++, text: content }];
    });
  }, []);

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

  const sendTurn = useCallback(
    async (rawInput: string, alreadyDisplayed = false): Promise<void> => {
      if (busyRef.current || transitioningRef.current) return;
      const text = rawInput.trim();
      if (!text) return;

      busyRef.current = true;
      cancelRequestedRef.current = false;
      setBusy(true);
      setCancelling(false);
      setActiveTool(null);
      if (!alreadyDisplayed) {
        setItems((current) => [
          ...current,
          { kind: 'user', id: nextItemIdRef.current++, text },
        ]);
      }
      messagesRef.current.push({ role: 'user', content: text });
      void recordPrompt(cwd, text).then(setPromptHistory);
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
            case 'assistant':
              flushText();
              finalizeReasoning();
              finalizeAssistant(event.content);
              recomputeContext();
              break;
            case 'tool-start':
              flushText();
              finalizeReasoning();
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
              break;
            case 'usage':
              usageRef.current = {
                tokens: event.usage.totalTokens,
                // The assistant message from this response is appended after the
                // stream ends and is already counted in totalTokens.
                messageCount: messagesRef.current.length + 1,
              };
              recomputeContext();
              break;
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
        setActiveTool(null);
        setCancelling(false);
        if (pendingApprovalRef.current) resolveApproval('deny');
        recomputeContext();
        void persistSession();
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
      persistSession,
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

      switch (command) {
        case '/help': {
          addNotice(
            'info',
            [
              'Commands (type / to open the menu, ↑↓ to choose, Enter to run):',
              ...slashHelpLines(),
              '',
              '  Model subcommands: /model <name> · /model add · /model edit [name] ·',
              '                     /model remove [name] · /model test [name] · /model list --remote',
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
          addNotice(
            'info',
            [
              `Context: ~${formatTokens(used)} / ${formatTokens(window)} tokens (${formatPercent(used, window)} used)` +
                (profile?.contextWindow
                  ? '.'
                  : ' — window inferred from the model id; set "contextWindow" in the profile to override.'),
              `  system ~${formatTokens(count('system'))} · user ~${formatTokens(count('user'))} · ` +
                `assistant ~${formatTokens(count('assistant'))} · tool ~${formatTokens(count('tool'))}`,
              usage
                ? `Last API usage: ${usage.tokens.toLocaleString()} tokens for the last request and response.`
                : 'The endpoint has not reported usage; counts are estimated at roughly 4 characters per token.',
              `Auto-compaction runs at ${Math.round(COMPACT_THRESHOLD * 100)}% and keeps the last ${COMPACT_KEEP_USER_TURNS} user turns verbatim. /compact runs it now.`,
            ].join('\n'),
          );
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
            if (command === '/sessions' || !argument) {
              const { sessions, skipped } = await listSessions(cwd, 10);
              listedSessionsRef.current = sessions;
              if (sessions.length === 0) {
                addNotice(
                  'info',
                  `No saved sessions for this directory yet. Sessions are stored in ${projectSessionsDir(cwd)}.`,
                );
              } else {
                const lines = sessions.map((session, index) => {
                  const marker = session.id === sessionRef.current?.id ? '*' : ' ';
                  const messages = `${session.messageCount} msg${session.messageCount === 1 ? '' : 's'}`;
                  return `${marker} ${index + 1}. ${session.id}  ${formatSessionTime(
                    session.updatedAt,
                  )}  ${messages}  ${session.title}`;
                });
                addNotice(
                  'info',
                  [
                    'Sessions (most recent first):',
                    ...lines,
                    '',
                    'Use /resume <number|id> to load one.',
                  ].join('\n'),
                );
              }
              if (skipped > 0) {
                addNotice(
                  'muted',
                  `Skipped ${skipped} unreadable session file${skipped === 1 ? '' : 's'}.`,
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
        default:
          addNotice('error', `Unknown command "${command}". Type /help for commands.`);
      }
    },
    [
      addNotice,
      autoAllowed,
      cwd,
      listRemoteModels,
      mouseOn,
      persistSession,
      profileName,
      quit,
      recomputeContext,
      resetAutoAllowed,
      runModelFlow,
      runProfileTest,
      updateContextTokens,
      version,
      yolo,
    ],
  );

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
      if (wizardActiveRef.current || transitioningRef.current) {
        // The wizard owns the keyboard; ignore stray input.
        return;
      }
      if (busyRef.current && !fromQueue) {
        // Type-ahead: the message runs as soon as the current turn finishes.
        queuedRef.current.push(trimmed);
        setQueuedCount(queuedRef.current.length);
        if (!trimmed.startsWith('/')) {
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
      if (trimmed.startsWith('/')) {
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
      if (pickerOpen) return;
      expandLastToolOutput();
      return;
    }
    if (!(key.ctrl && input === 'c')) return;
    if (pickerOpen) {
      setPickerOpen(false);
      return;
    }
    if (wizardActiveRef.current) {
      cancelWizard();
      return;
    }
    if (pendingApprovalRef.current) {
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
    quit();
  });

  const activity: Activity = pendingApproval
    ? 'approval'
    : cancelling
      ? 'cancelling'
      : busy
        ? activeTool
          ? 'running'
          : 'thinking'
        : null;
  const activeProfile = runtimeConfig.profiles[profileName];
  const contextWindow = contextWindowFor(activeProfile);
  const menuRows = pendingApproval || pickerOpen ? 0 : slashMenuRows;
  const viewportHeight = Math.max(
    3,
    rows - 5 - (pendingApproval ? 12 : 0) - (pickerOpen ? 13 : 0) - menuRows,
  );

  return (
    <Box flexDirection="column" width={columns} paddingX={1}>
      <MessageList
        items={items}
        width={width}
        height={viewportHeight}
        resetSignal={resetSignal}
        expandedToolId={expandedToolId}
        interactive={!pendingApproval && !pickerOpen && !wizardActive && wizardPrompt === null}
      />
      {pendingApproval ? (
        <ApprovalPrompt
          request={pendingApproval}
          width={width}
          onDecision={resolveApproval}
        />
      ) : pickerOpen ? (
        <ModelPicker
          config={runtimeConfig}
          activeProfile={profileName}
          width={width}
          onSelect={(name, model) => void selectModel(name, model)}
          onRefresh={refreshProfileModels}
          onCancel={() => setPickerOpen(false)}
        />
      ) : (
        <Input
          key={wizardPrompt?.id ?? 0}
          disabled={false}
          width={width}
          mask={wizardPrompt?.mask}
          allowEmpty={wizardPrompt?.allowEmpty}
          history={wizardPrompt || wizardActive ? undefined : promptHistory}
          placeholder={
            wizardPrompt
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
          onMenuRowsChange={handleMenuRowsChange}
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
        queued={queuedCount > 0 ? queuedCount : undefined}
        yolo={yolo}
        autoAllowed={autoAllowed}
        contextTokens={contextTokens}
        contextWindow={contextWindow}
      />
    </Box>
  );
}
