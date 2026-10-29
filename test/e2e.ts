import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { renderToString } from 'ink';
import React from 'react';

import { buildSystemPrompt } from '../src/agent/prompt.js';
import {
  formatSkillIndex,
  formatSkillList,
  loadSkills,
  MAX_SKILL_SHORT_DESCRIPTION_CHARS,
  MAX_SKILLS_INDEX_CHARS,
  parseSkillFile,
  setSkillsEnabled,
  skillInvocationMessage,
  type Skill,
} from '../src/agent/skills.js';
import {
  MAX_TOOL_ROUNDS,
  planToolBatches,
  runAgentTurn,
  type AgentEvent,
} from '../src/agent/loop.js';
import {
  COMPACT_KEEP_USER_TURNS,
  COMPACT_THRESHOLD,
  SUMMARY_PREFIX,
  compactMessages,
  findCompactBoundary,
  shouldCompact,
} from '../src/agent/compact.js';
import {
  estimateMessagesTokens,
  estimateTextTokens,
  formatPercent,
  formatTokens,
} from '../src/agent/tokens.js';
import {
  applyOverrides,
  ConfigError,
  contextWindowFor,
  DEFAULT_CONTEXT_WINDOW,
  loadConfig,
  normalizeBaseUrl,
  recoverConfig,
  resolveProfile,
  saveConfig,
  suggestProfileName,
  validateConfig,
  validateProfileName,
  type KiroConfig,
} from '../src/config.js';
import {
  defaultKeyEnv,
  keyStatus,
  loadEnvFile,
  maskKey,
  parseEnv,
  writeEnvValue,
} from '../src/env.js';
import {
  discoverModels,
  modelsEndpoint,
  testConnection,
} from '../src/model/discovery.js';
import { inferContextWindow } from '../src/model/contexts.js';
import { PRESETS } from '../src/model/presets.js';
import { composeFrame, WizardScreen, type ScreenStream } from '../src/model/cli-ui.js';
import {
  runAddFlow,
  runEditFlow,
  runRemoveFlow,
  runSelectFlow,
  type ModelWizardUi,
  type TextPrompt,
} from '../src/model/wizard.js';
import { OpenAIProvider, isOverflowMessage, reasoningModel, rejectsMaxTokens } from '../src/providers/openai.js';
import type {
  ChatMessage,
  Provider,
  ToolCall,
  ToolDefinition,
} from '../src/providers/types.js';
import { ProviderError } from '../src/providers/types.js';
import { childEnv, clearSecrets, redactSecrets, registerSecretEnv } from '../src/secrets.js';
import { VERSION } from '../src/version.js';
import { defaultExportPath, renderTranscriptMarkdown } from '../src/ui/export.js';
import {
  dropIncompleteToolCalls,
  isSessionId,
  latestSession,
  listAllSessions,
  listSessions,
  loadSession,
  projectSessionsDir,
  saveSession,
  titleFromMessages,
  type AllSessionsResult,
  type SessionSummary,
} from '../src/sessions.js';
import { ApprovalPolicy } from '../src/ui/approval-policy.js';
import { applyPalette, buildLines, buildPaletteLines } from '../src/ui/MessageList.js';
import {
  filterModelIds,
  modelIds,
  pickerPopupRect,
  pickerPopupRows,
  pickerRange,
  pickerRangeLabel,
  pickerWindow,
  profileRange,
  profileRows,
  selectableLines,
  selectableNames,
  withProfileModel,
  withProfileModels,
} from '../src/ui/model-picker.js';
import { ModelPicker } from '../src/ui/ModelPicker.js';
import { SessionPicker } from '../src/ui/SessionPicker.js';
import {
  SESSION_INLINE_ROWS,
  buildSessionRows,
  filterSessions,
  sessionCounts,
  sessionEmptyText,
  sessionRange,
  sessionRowItems,
  sessionRowLines,
  sessionRowText,
  sessionTabLabel,
  shortCwd,
} from '../src/ui/session-picker.js';
import { formatProfileList } from '../src/ui/profile-list.js';
import {
  SLASH_COMMANDS,
  buildSkillCommands,
  builtinCommandNames,
  filterSlashCommands,
  slashCommandLabel,
  slashHelpLines,
} from '../src/ui/commands.js';
import { renderMarkdown } from '../src/ui/markdown.js';
import { MOUSE_SCROLL_LINES, isMouseSequence, parseMouseWheel } from '../src/ui/mouse.js';
import { StatusBar } from '../src/ui/StatusBar.js';
import {
  UsageCard,
  USAGE_CARD_WIDTH,
  shouldShowUsageCard,
} from '../src/ui/UsageCard.js';
import { addUsage, EMPTY_USAGE, normalizeUsage } from '../src/usage.js';
import { buildResumedView } from '../src/ui/history.js';
import { loadPromptHistory, recordPrompt, rememberPrompt } from '../src/ui/prompt-history.js';
import { filterFiles, listProjectFiles } from '../src/ui/file-index.js';
import { mentionAt, mentionNearby, mentionOpeningAt, mentionText } from '../src/ui/mention.js';
import { snapshotBeforeMutation, undoLastCheckpoint } from '../src/tools/checkpoint.js';
import {
  applyInputOps,
  cursorLineIndex,
  displayWidth,
  feedPaste,
  layoutInput,
  normalizePastedText,
  parseEditSequence,
  parseInputChunk,
  truncateMiddle,
  type TextInputState,
} from '../src/ui/text.js';
import type { ViewItem } from '../src/ui/types.js';
import { executeTool, isReadOnlyTool, MAX_TOOL_RESULT_CHARS } from '../src/tools/index.js';
import type { ApprovalRequest, ToolContext } from '../src/tools/types.js';
import { createMockServer, type MockServer, type MockTurn } from './mock-server.js';

type ApproveResult = 'allow' | 'allow-session' | 'deny';

interface ApprovalSpy {
  fn: (request: ApprovalRequest) => Promise<ApproveResult>;
  requests: ApprovalRequest[];
}

function approvalSpy(decision: ApproveResult = 'allow'): ApprovalSpy {
  const requests: ApprovalRequest[] = [];
  return {
    requests,
    async fn(request) {
      requests.push(request);
      return decision;
    },
  };
}

function makeProvider(baseUrl: string): OpenAIProvider {
  return new OpenAIProvider(
    {
      type: 'openai',
      baseUrl,
      model: 'mock-model',
      apiKeyEnv: 'MOCK_KEY',
      temperature: 0,
      maxTokens: 1024,
    },
    'test-key',
  );
}

async function tempDir(prefix = 'kiro-test-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

class ScriptedUi implements ModelWizardUi {
  readonly notes: string[] = [];
  private readonly answers: (string | null)[];

  constructor(answers: (string | null)[]) {
    this.answers = [...answers];
  }

  note(tone: 'info' | 'error' | 'muted', text: string): void {
    this.notes.push(`${tone}: ${text}`);
  }

  async text(_options: TextPrompt): Promise<string | null> {
    if (this.answers.length === 0) throw new Error('scripted UI ran out of answers');
    return this.answers.shift()!;
  }

  async confirm(_label: string, defaultValue: boolean): Promise<boolean | null> {
    const answer = await this.text({ label: _label });
    if (answer === null) return null;
    const value = answer.trim().toLowerCase();
    if (!value) return defaultValue;
    return value === 'y' || value === 'yes';
  }
}

function baseTestConfig(): KiroConfig {
  return {
    activeProfile: 'default',
    profiles: {
      default: {
        type: 'openai',
        baseUrl: 'http://127.0.0.1:1/v1',
        model: 'base-model',
        temperature: 0.2,
        maxTokens: 4096,
      },
    },
  };
}

async function fileMode(file: string): Promise<number> {
  return (await stat(file)).mode & 0o777;
}

/** Windows has no POSIX permission bits, so 0600/0700 can only be checked elsewhere. */
const SUPPORTS_POSIX_MODES = process.platform !== 'win32';

async function assertPrivateMode(file: string, expected: number): Promise<void> {
  if (!SUPPORTS_POSIX_MODES) return;
  assert.equal(await fileMode(file), expected);
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function fakeProvider(
  text: string,
  capture?: (messages: ChatMessage[], tools: ToolDefinition[]) => void,
): Provider {
  return {
    type: 'fake',
    model: 'fake',
    async *stream(messages, tools) {
      capture?.(messages, tools);
      if (text) yield { type: 'text', text };
    },
  };
}

/** Five user turns; the first and fourth include a tool call and a large tool result. */
function compactionFixture(): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: 'System instructions' }];
  const addTurn = (label: string, withTool: boolean): void => {
    messages.push({ role: 'user', content: `${label} request` });
    if (withTool) {
      messages.push({
        role: 'assistant',
        content: `${label} answer`,
        tool_calls: [
          {
            id: `${label}-call`,
            type: 'function',
            function: { name: 'grep', arguments: '{"pattern":"needle"}' },
          },
        ],
      });
      messages.push({
        role: 'tool',
        tool_call_id: `${label}-call`,
        name: 'grep',
        content: 'z'.repeat(5_000),
      });
    } else {
      messages.push({ role: 'assistant', content: `${label} answer` });
    }
  };
  addTurn('alpha', true);
  addTurn('beta', false);
  addTurn('gamma', false);
  addTurn('delta', true);
  addTurn('epsilon', false);
  return messages;
}

interface ScenarioResult {
  events: AgentEvent[];
  messages: ChatMessage[];
  mock: MockServer;
  spy: ApprovalSpy;
  done: Extract<AgentEvent, { type: 'done' }>;
}

async function runScenario(options: {
  cwd: string;
  turns: MockTurn[];
  decision?: ApproveResult;
  prompt?: string;
  maxToolRounds?: number;
}): Promise<ScenarioResult> {
  const mock = await createMockServer({ turns: options.turns });
  const spy = approvalSpy(options.decision ?? 'allow');
  const messages: ChatMessage[] = [
    { role: 'system', content: await buildSystemPrompt(options.cwd) },
    { role: 'user', content: options.prompt ?? 'Do the task.' },
  ];
  const controller = new AbortController();
  const ctx: ToolContext = { cwd: options.cwd, signal: controller.signal, approve: spy.fn };
  const events = await collect(
    runAgentTurn({
      provider: makeProvider(mock.url),
      messages,
      ctx,
      maxToolRounds: options.maxToolRounds,
    }),
  );
  const done = events.find((event) => event.type === 'done');
  if (!done || done.type !== 'done') throw new Error('agent should emit a done event');
  return { events, messages, mock, spy, done };
}

function toolEnds(events: AgentEvent[]) {
  return events.filter((event): event is Extract<AgentEvent, { type: 'tool-end' }> => event.type === 'tool-end');
}

function noticeText(events: AgentEvent[]): string {
  return events
    .filter((event): event is Extract<AgentEvent, { type: 'notice' }> => event.type === 'notice')
    .map((event) => event.message)
    .join('\n');
}

let failures = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  const started = Date.now();
  try {
    await fn();
    console.log(`  ok   ${name} (${Date.now() - started}ms)`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(error instanceof Error ? error.stack : error);
  }
}

async function main(): Promise<void> {
  console.log('Kiro backend tests\n');

  await test('happy path: streaming text, multiple tool calls, approval, final answer', async () => {
    const cwd = await tempDir();
    const command = `node -e "console.log(require('fs').readFileSync('hello.txt','utf8').trim())"`;
    const result = await runScenario({
      cwd,
      turns: [
        {
          type: 'tool-calls',
          text: 'Creating the file and listing the directory.',
          calls: [
            { name: 'write_file', arguments: { path: 'hello.txt', content: 'hello from test\n' } },
            { name: 'list_dir', arguments: { path: '.' } },
          ],
        },
        {
          type: 'tool-calls',
          text: 'Now running it.',
          calls: [{ name: 'run_command', arguments: { command } }],
        },
        { type: 'text', text: 'All done: hello from test' },
      ],
    });
    try {
      assert.equal(result.done.reason, 'complete');
      assert.equal(await readFile(path.join(cwd, 'hello.txt'), 'utf8'), 'hello from test\n');
      assert.equal(toolEnds(result.events).length, 3);
      assert.ok(toolEnds(result.events).every((event) => event.result.status === 'ok'));
      const commandEnd = toolEnds(result.events).find((event) => event.toolCall.function.name === 'run_command');
      assert.match(commandEnd?.result.content ?? '', /hello from test/);
      assert.deepEqual(
        result.spy.requests.map((request) => request.tool),
        ['write_file', 'run_command'],
      );
      assert.match(result.spy.requests[0]?.detail ?? '', /\+\+\+ b\/hello\.txt/);
      assert.equal(result.spy.requests[1]?.detail, `$ ${command}`);
      const finalText = result.events.filter((event) => event.type === 'text').map((event) => event.text).join('');
      assert.match(finalText, /All done: hello from test/);
      assert.equal(result.messages[0]?.role, 'system');
      assert.equal(result.messages[1]?.role, 'user');
      assert.deepEqual(
        result.messages.slice(2).map((message) => message.role),
        ['assistant', 'tool', 'tool', 'assistant', 'tool', 'assistant'],
      );
      assert.equal(result.mock.requests.length, 3);
      assert.equal(result.mock.requests[0]?.headers.authorization, 'Bearer test-key');
      const secondRequestMessages = result.mock.requests[1]?.body.messages as ChatMessage[];
      assert.ok(secondRequestMessages.some((message) => message.role === 'tool' && /hello/.test(message.content ?? '')));
      assert.ok(Array.isArray(result.mock.requests[0]?.body.tools));
    } finally {
      await result.mock.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  await test('denied write is reported to the model and the loop continues', async () => {
    const cwd = await tempDir();
    const result = await runScenario({
      cwd,
      decision: 'deny',
      turns: [
        { type: 'tool-calls', calls: [{ name: 'write_file', arguments: { path: 'nope.txt', content: 'x' } }] },
        { type: 'text', text: 'Okay, I will not write the file.' },
      ],
    });
    try {
      assert.equal(await fileExists(path.join(cwd, 'nope.txt')), false);
      const ends = toolEnds(result.events);
      assert.equal(ends.length, 1);
      assert.equal(ends[0]?.result.status, 'denied');
      assert.match(ends[0]?.result.content ?? '', /denied/i);
      assert.equal(result.done.reason, 'complete');
      assert.equal(result.mock.requests.length, 2);
      const secondRequestMessages = result.mock.requests[1]?.body.messages as ChatMessage[];
      assert.ok(secondRequestMessages.some((message) => message.role === 'tool' && /denied/i.test(message.content ?? '')));
    } finally {
      await result.mock.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  await test('malformed tool-call JSON becomes a tool error instead of crashing', async () => {
    const cwd = await tempDir();
    const result = await runScenario({
      cwd,
      turns: [
        {
          type: 'tool-calls',
          calls: [{ name: 'write_file', arguments: '{"path": "broken.txt", "content": ' }],
        },
        { type: 'text', text: 'I fixed my mistake.' },
      ],
    });
    try {
      const ends = toolEnds(result.events);
      assert.equal(ends.length, 1);
      assert.equal(ends[0]?.result.status, 'error');
      assert.match(ends[0]?.result.content ?? '', /Invalid JSON arguments/);
      assert.equal(await fileExists(path.join(cwd, 'broken.txt')), false);
      assert.equal(result.spy.requests.length, 0);
      assert.equal(result.mock.requests.length, 2);
      const secondRequestMessages = result.mock.requests[1]?.body.messages as ChatMessage[];
      assert.ok(secondRequestMessages.some((message) => message.role === 'tool' && /Invalid JSON/.test(message.content ?? '')));
      assert.equal(result.done.reason, 'complete');
    } finally {
      await result.mock.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  await test('tool round cap stops the turn', async () => {
    assert.equal(MAX_TOOL_ROUNDS, 25);
    const cwd = await tempDir();
    const turns: MockTurn[] = Array.from({ length: 5 }, () => ({
      type: 'tool-calls' as const,
      calls: [{ name: 'list_dir', arguments: { path: '.' } }],
    }));
    const result = await runScenario({ cwd, turns, maxToolRounds: 3 });
    try {
      assert.equal(toolEnds(result.events).length, 3);
      assert.equal(result.mock.requests.length, 3);
      assert.equal(result.done.reason, 'max-iterations');
      assert.ok(result.events.some((event) => event.type === 'notice' && /Stopped after 3 tool rounds/.test(event.message)));
    } finally {
      await result.mock.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  await test('HTTP errors surface as a clear notice, not a crash', async () => {
    const cwd = await tempDir();
    const result = await runScenario({
      cwd,
      turns: [{ type: 'http-error', status: 401, body: '{"error":{"message":"invalid api key"}}' }],
    });
    try {
      assert.equal(result.done.reason, 'error');
      const notice = result.events.find((event) => event.type === 'notice' && event.level === 'error');
      assert.ok(notice && notice.type === 'notice');
      assert.match(notice.message, /HTTP 401/);
      assert.match(notice.message, /invalid api key/);
      assert.match(notice.message, /API key environment variable/);
      assert.equal(result.mock.requests.length, 1, '401 must not be retried');
    } finally {
      await result.mock.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  await test('malformed SSE frame surfaces as a clear notice', async () => {
    const cwd = await tempDir();
    const result = await runScenario({ cwd, turns: [{ type: 'malformed-sse' }] });
    try {
      assert.equal(result.done.reason, 'error');
      const notice = result.events.find((event) => event.type === 'notice' && event.level === 'error');
      assert.ok(notice && notice.type === 'notice');
      assert.match(notice.message, /Malformed streaming response/);
    } finally {
      await result.mock.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  await test('unreachable endpoint surfaces a clear notice', async () => {
    const cwd = await tempDir();
    const provider = makeProvider('http://127.0.0.1:1/v1');
    const messages: ChatMessage[] = [
      { role: 'system', content: 'test' },
      { role: 'user', content: 'hi' },
    ];
    const controller = new AbortController();
    const events = await collect(
      runAgentTurn({
        provider,
        messages,
        ctx: { cwd, signal: controller.signal, approve: approvalSpy().fn },
      }),
    );
    try {
      assert.equal(events.at(-1)?.type, 'done');
      const notice = events.find((event) => event.type === 'notice' && event.level === 'error');
      assert.ok(notice && notice.type === 'notice');
      assert.match(notice.message, /Could not reach the model endpoint/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  await test('retries transient HTTP errors with backoff, then succeeds', async () => {
    const cwd = await tempDir();
    process.env.KIRO_RETRY_BASE_MS = '5';
    const result = await runScenario({
      cwd,
      turns: [
        {
          type: 'http-error',
          status: 429,
          body: '{"error":{"message":"slow down"}}',
          headers: { 'Retry-After': '0.01' },
        },
        { type: 'http-error', status: 503, body: '{"error":{"message":"upstream busy"}}' },
        { type: 'text', text: 'Recovered after retries.' },
      ],
    });
    try {
      assert.equal(result.done.reason, 'complete');
      assert.equal(result.mock.requests.length, 3);
      const notices = result.events.filter(
        (event): event is Extract<AgentEvent, { type: 'notice' }> => event.type === 'notice',
      );
      assert.ok(notices.some((event) => event.level === 'info' && /retrying \(1\/3\)/.test(event.message)));
      assert.ok(notices.some((event) => event.level === 'info' && /retrying \(2\/3\)/.test(event.message)));
      const streamed = result.events
        .filter((event): event is Extract<AgentEvent, { type: 'text' }> => event.type === 'text')
        .map((event) => event.text)
        .join('');
      assert.match(streamed, /Recovered after retries/);
    } finally {
      delete process.env.KIRO_RETRY_BASE_MS;
      await result.mock.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  await test('gives up after three retries on persistent 5xx errors', async () => {
    const cwd = await tempDir();
    process.env.KIRO_RETRY_BASE_MS = '5';
    const failure: MockTurn = { type: 'http-error', status: 500, body: '{"error":{"message":"down"}}' };
    const result = await runScenario({ cwd, turns: [failure] });
    try {
      assert.equal(result.done.reason, 'error');
      assert.equal(result.mock.requests.length, 4, 'one attempt plus three retries');
      const retries = result.events.filter(
        (event): event is Extract<AgentEvent, { type: 'notice' }> =>
          event.type === 'notice' && /retrying/.test(event.message),
      );
      assert.equal(retries.length, 3);
      const error = result.events.find(
        (event): event is Extract<AgentEvent, { type: 'notice' }> =>
          event.type === 'notice' && event.level === 'error',
      );
      assert.match(error?.message ?? '', /HTTP 500/);
    } finally {
      delete process.env.KIRO_RETRY_BASE_MS;
      await result.mock.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  await test('does not retry once partial output has been streamed', async () => {
    const cwd = await tempDir();
    process.env.KIRO_RETRY_BASE_MS = '5';
    const result = await runScenario({
      cwd,
      turns: [
        { type: 'drop', text: 'Partial answer', chunkSize: 4, delayMs: 1 },
        { type: 'text', text: 'This retry should never be requested.' },
      ],
    });
    try {
      assert.equal(result.done.reason, 'error');
      assert.equal(result.mock.requests.length, 1);
      const streamed = result.events
        .filter((event): event is Extract<AgentEvent, { type: 'text' }> => event.type === 'text')
        .map((event) => event.text)
        .join('');
      assert.match(streamed, /Partial answer/);
      assert.equal(
        result.events.some((event) => event.type === 'notice' && /retrying/.test(event.message)),
        false,
      );
      const error = result.events.find(
        (event): event is Extract<AgentEvent, { type: 'notice' }> =>
          event.type === 'notice' && event.level === 'error',
      );
      assert.match(error?.message ?? '', /Lost connection/);
    } finally {
      delete process.env.KIRO_RETRY_BASE_MS;
      await result.mock.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  await test('read-only tool calls batch in parallel; mutations stay sequential', async () => {
    const call = (id: string, name: string): ToolCall => ({
      id,
      type: 'function',
      function: { name, arguments: '{}' },
    });
    const batches = planToolBatches([
      call('a', 'read_file'),
      call('b', 'glob'),
      call('c', 'grep'),
      call('d', 'write_file'),
      call('e', 'list_dir'),
      call('f', 'read_file'),
    ]);
    assert.deepEqual(
      batches.map((batch) => [batch.readOnly, batch.calls.length]),
      [
        [true, 3],
        [false, 1],
        [true, 2],
      ],
    );

    const cwd = await tempDir();
    await writeFile(path.join(cwd, 'alpha.txt'), 'alpha\n');
    await writeFile(path.join(cwd, 'beta.txt'), 'beta token\n');
    const result = await runScenario({
      cwd,
      turns: [
        {
          type: 'tool-calls',
          calls: [
            { name: 'read_file', arguments: { path: 'alpha.txt' } },
            { name: 'list_dir', arguments: { path: '.' } },
            { name: 'glob', arguments: { pattern: '*.txt' } },
            { name: 'grep', arguments: { pattern: 'beta' } },
          ],
        },
        { type: 'text', text: 'Searched.' },
      ],
    });
    try {
      const ends = toolEnds(result.events);
      assert.deepEqual(
        ends.map((event) => event.toolCall.function.name),
        ['read_file', 'list_dir', 'glob', 'grep'],
      );
      assert.ok(ends.every((event) => event.result.status === 'ok'));
      assert.match(ends[3]?.result.content ?? '', /beta\.txt:1/);
      const toolMessages = result.messages.filter((message) => message.role === 'tool');
      assert.deepEqual(
        toolMessages.map((message) => message.name),
        ['read_file', 'list_dir', 'glob', 'grep'],
      );
      assert.match(toolMessages[0]?.content ?? '', /alpha/);
    } finally {
      await result.mock.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  await test('global tool result cap truncates with guidance', async () => {
    const cwd = await tempDir();
    const controller = new AbortController();
    try {
      const lines = Array.from(
        { length: 400 },
        (_, index) => `needle-${index} ${'x'.repeat(420)}`,
      ).join('\n');
      await writeFile(path.join(cwd, 'big.txt'), `${lines}\n`);
      const result = await executeTool(
        'grep',
        JSON.stringify({ pattern: 'needle-', max_results: 400 }),
        { cwd, signal: controller.signal, approve: approvalSpy().fn },
      );
      assert.equal(result.status, 'ok');
      assert.ok(result.content.length <= MAX_TOOL_RESULT_CHARS + 2_000, 'cap should bound output size');
      assert.match(result.content, /output truncated/);
      assert.match(result.content, /Narrow the request/);
      assert.match(result.summary, /truncated/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  await test('provider reports usage, asks for it, and token helpers format counts', async () => {
    const mock = await createMockServer({
      turns: [
        {
          type: 'text',
          text: 'Hi there',
          usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
        },
      ],
    });
    try {
      const events = await collect(makeProvider(mock.url).stream([{ role: 'user', content: 'hi' }], []));
      const usage = events.find((event) => event.type === 'usage');
      assert.ok(usage && usage.type === 'usage');
      assert.deepEqual(usage.usage, { promptTokens: 11, completionTokens: 3, totalTokens: 14 });
      assert.deepEqual(mock.requests[0]?.body.stream_options, { include_usage: true });

      assert.equal(estimateTextTokens('abcdefgh'), 2);
      assert.equal(estimateTextTokens(''), 0);
      assert.equal(estimateMessagesTokens([{ role: 'user', content: 'abcd' }]), 5);
      assert.equal(formatTokens(999), '999');
      assert.equal(formatTokens(9_400), '9.4k');
      assert.equal(formatTokens(42_300), '42k');
      assert.equal(formatTokens(DEFAULT_CONTEXT_WINDOW), '128k');
      assert.equal(formatPercent(64_000, DEFAULT_CONTEXT_WINDOW), '50%');
      assert.equal(shouldCompact(102_399, DEFAULT_CONTEXT_WINDOW), false);
      assert.equal(shouldCompact(102_400, DEFAULT_CONTEXT_WINDOW), true);
      assert.equal(COMPACT_THRESHOLD, 0.8);
      assert.equal(COMPACT_KEEP_USER_TURNS, 4);
    } finally {
      await mock.close();
    }
  });

  await test('compaction summarizes old turns, keeps recent tool rounds, and persists', async () => {
    const requests: { messages: ChatMessage[]; tools: ToolDefinition[] }[] = [];
    const summaryText = [
      'Goal: finish the task',
      'Files touched: a.ts',
      'Decisions: keep it simple',
      'Current state: testing',
      'Open TODOs: none',
    ].join('\n');
    const provider = fakeProvider(summaryText, (messages, tools) => requests.push({ messages, tools }));
    const messages = compactionFixture();
    const boundary = findCompactBoundary(messages, 2);
    assert.ok(boundary > 0);

    const result = await compactMessages({ messages, provider, keepUserTurns: 2 });
    assert.ok(result);
    assert.equal(result.messages[0]?.content, 'System instructions');
    assert.equal(result.messages[1]?.role, 'user');
    assert.ok((result.messages[1]?.content ?? '').startsWith(SUMMARY_PREFIX));
    assert.match(result.messages[1]?.content ?? '', /Goal: finish the task/);
    assert.deepEqual(result.messages.slice(2), messages.slice(boundary));
    assert.deepEqual(
      result.messages.slice(2, 5).map((message) => message.role),
      ['user', 'assistant', 'tool'],
    );
    assert.equal(result.summarizedMessages, boundary - 1);
    assert.ok(result.afterTokens < result.beforeTokens);

    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0]?.tools, []);
    const transcript = requests[0]?.messages[1]?.content ?? '';
    assert.match(transcript, /grep result omitted during compaction: 5,000 characters/);
    assert.doesNotMatch(transcript, /z{4000}/);

    const root = await tempDir('kiro-compact-');
    const workspace = await tempDir('kiro-compact-ws-');
    const previousRoot = process.env.KIRO_SESSIONS_DIR;
    process.env.KIRO_SESSIONS_DIR = root;
    try {
      const record = await saveSession({
        cwd: workspace,
        profile: 'test',
        model: 'test',
        messages: result.messages,
      });
      const loaded = await loadSession(workspace, record.id);
      assert.ok(loaded.messages.some((message) => (message.content ?? '').startsWith(SUMMARY_PREFIX)));
      assert.equal(loaded.messages.some((message) => message.content === 'alpha request'), false);
      assert.ok(loaded.messages.some((message) => message.content === 'epsilon answer'));
    } finally {
      if (previousRoot === undefined) delete process.env.KIRO_SESSIONS_DIR;
      else process.env.KIRO_SESSIONS_DIR = previousRoot;
      await rm(root, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  await test('compaction needs enough turns and rejects an empty summary', async () => {
    const few: ChatMessage[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a' },
    ];
    assert.equal(findCompactBoundary(few, 4), -1);
    assert.equal(await compactMessages({ messages: few, provider: fakeProvider('x') }), null);
    await assert.rejects(
      compactMessages({ messages: compactionFixture(), provider: fakeProvider(''), keepUserTurns: 2 }),
      /empty compaction summary/,
    );
  });

  await test('agent loop compacts once per turn and forwards usage', async () => {
    const cwd = await tempDir();
    const mock = await createMockServer({
      turns: [
        {
          type: 'tool-calls',
          calls: [{ name: 'list_dir', arguments: { path: '.' } }],
          usage: { prompt_tokens: 900, completion_tokens: 10 },
        },
        {
          type: 'text',
          text: 'Finished.',
          usage: { prompt_tokens: 40, completion_tokens: 5 },
        },
      ],
    });
    const messages: ChatMessage[] = [
      ...compactionFixture(),
      { role: 'user', content: 'latest request' },
    ];
    const controller = new AbortController();
    let compactions = 0;
    try {
      const events = await collect(
        runAgentTurn({
          provider: makeProvider(mock.url),
          messages,
          ctx: { cwd, signal: controller.signal, approve: approvalSpy().fn },
          compactContext: async (current) => {
            compactions++;
            if (compactions > 1) throw new Error('compacted twice');
            return {
              messages: [
                current[0]!,
                { role: 'user', content: `${SUMMARY_PREFIX}\n\nGoal: test` },
                current[current.length - 1]!,
              ],
              summary: 'Goal: test',
              beforeTokens: 5_000,
              afterTokens: 50,
              summarizedMessages: current.length - 2,
            };
          },
        }),
      );
      assert.equal(compactions, 1);
      const done = events.find((event) => event.type === 'done');
      assert.ok(done && done.type === 'done');
      assert.equal(done.reason, 'complete');
      assert.ok(
        events.some(
          (event) => event.type === 'notice' && /Context was compacted/.test(event.message),
        ),
      );
      const usage = events.filter(
        (event): event is Extract<AgentEvent, { type: 'usage' }> => event.type === 'usage',
      );
      assert.deepEqual(
        usage.map((event) => event.usage.totalTokens),
        [910, 45],
      );
      const firstRequest = mock.requests[0]?.body.messages as ChatMessage[];
      assert.equal(firstRequest.length, 3);
      assert.ok((firstRequest[1]?.content ?? '').startsWith(SUMMARY_PREFIX));
      assert.equal(firstRequest.some((message) => message.content === 'alpha request'), false);
      assert.equal(messages[0]?.role, 'system');
      assert.ok((messages[1]?.content ?? '').startsWith(SUMMARY_PREFIX));
      assert.ok(messages.some((message) => message.role === 'tool'));
      assert.ok(messages.some((message) => message.content === 'Finished.'));
    } finally {
      await mock.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  await test('a compaction failure is surfaced without aborting the turn', async () => {
    const cwd = await tempDir();
    const mock = await createMockServer({ turns: [{ type: 'text', text: 'Still working.' }] });
    const controller = new AbortController();
    try {
      const events = await collect(
        runAgentTurn({
          provider: makeProvider(mock.url),
          messages: [
            { role: 'system', content: 's' },
            { role: 'user', content: 'u' },
          ],
          ctx: { cwd, signal: controller.signal, approve: approvalSpy().fn },
          compactContext: async () => {
            throw new Error('summary endpoint down');
          },
        }),
      );
      const done = events.find((event) => event.type === 'done');
      assert.ok(done && done.type === 'done');
      assert.equal(done.reason, 'complete');
      assert.ok(
        events.some(
          (event) =>
            event.type === 'notice' &&
            event.level === 'error' &&
            /Could not compact context: summary endpoint down/.test(event.message),
        ),
      );
      assert.equal(mock.requests.length, 1);
    } finally {
      await mock.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  await test('abort stops a streaming turn promptly', async () => {
    const cwd = await tempDir();
    const mock = await createMockServer({
      turns: [{ type: 'text', text: 'chatter '.repeat(100), chunkSize: 3, delayMs: 25 }],
    });
    const controller = new AbortController();
    const messages: ChatMessage[] = [
      { role: 'system', content: 'test' },
      { role: 'user', content: 'talk' },
    ];
    const events: AgentEvent[] = [];
    const timer = setTimeout(() => controller.abort(), 120);
    const started = Date.now();
    try {
      for await (const event of runAgentTurn({
        provider: makeProvider(mock.url),
        messages,
        ctx: { cwd, signal: controller.signal, approve: approvalSpy().fn },
      })) {
        events.push(event);
        if (event.type === 'done') break;
      }
      clearTimeout(timer);
      assert.ok(Date.now() - started < 3_000, 'abort should not wait for the whole stream');
      assert.equal(events.at(-1)?.type, 'done');
      const done = events.at(-1);
      assert.ok(done && done.type === 'done');
      assert.equal(done.reason, 'aborted');
      assert.equal(events.some((event) => event.type === 'notice' && event.level === 'error'), false);
    } finally {
      clearTimeout(timer);
      await mock.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  await test('path escape is rejected for read_file and requires approval for writes', async () => {
    const cwd = await tempDir();
    const outsideDir = await tempDir('kiro-outside-');
    const controller = new AbortController();
    const baseCtx = { cwd, signal: controller.signal };
    try {
      const read = await executeTool('read_file', JSON.stringify({ path: outsideDir }), {
        ...baseCtx,
        approve: approvalSpy().fn,
      });
      assert.equal(read.status, 'error');
      assert.match(read.content, /outside the working directory/);

      const denySpy = approvalSpy('deny');
      const deniedWrite = await executeTool(
        'write_file',
        JSON.stringify({ path: '../' + path.basename(outsideDir) + '/escape.txt', content: 'no' }),
        { ...baseCtx, approve: denySpy.fn },
      );
      assert.equal(deniedWrite.status, 'denied');
      assert.match(denySpy.requests[0]?.warning ?? '', /outside the working directory/);
      assert.equal(await fileExists(path.join(outsideDir, 'escape.txt')), false);

      const allowSpy = approvalSpy('allow');
      const allowedWrite = await executeTool(
        'write_file',
        JSON.stringify({ path: '../' + path.basename(outsideDir) + '/escape.txt', content: 'yes' }),
        { ...baseCtx, approve: allowSpy.fn },
      );
      assert.equal(allowedWrite.status, 'ok');
      assert.equal(await readFile(path.join(outsideDir, 'escape.txt'), 'utf8'), 'yes');
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  await test('read_file pages lines and explains truncation', async () => {
    const cwd = await tempDir();
    const content = Array.from({ length: 10 }, (_, index) => `line${index + 1}`).join('\n') + '\n';
    await writeFile(path.join(cwd, 'lines.txt'), content);
    const controller = new AbortController();
    try {
      const result = await executeTool(
        'read_file',
        JSON.stringify({ path: 'lines.txt', offset: 2, limit: 3 }),
        { cwd, signal: controller.signal, approve: approvalSpy().fn },
      );
      assert.equal(result.status, 'ok');
      assert.match(result.content, /lines 2-4, more available/);
      assert.match(result.content, /2\tline2/);
      assert.match(result.content, /4\tline4/);
      assert.doesNotMatch(result.content, /5\tline5/);
      assert.match(result.content, /offset=5 to continue/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  await test('edit_file enforces exact, unique matches', async () => {
    const cwd = await tempDir();
    const controller = new AbortController();
    const ctx: ToolContext = { cwd, signal: controller.signal, approve: approvalSpy().fn };
    try {
      await writeFile(path.join(cwd, 'edit.txt'), 'alpha\nbeta\nbeta\n');
      const missing = await executeTool(
        'edit_file',
        JSON.stringify({ path: 'edit.txt', old_string: 'gamma', new_string: 'delta' }),
        ctx,
      );
      assert.equal(missing.status, 'error');
      assert.match(missing.content, /not found/);
      const ambiguous = await executeTool(
        'edit_file',
        JSON.stringify({ path: 'edit.txt', old_string: 'beta', new_string: 'gamma' }),
        ctx,
      );
      assert.equal(ambiguous.status, 'error');
      assert.match(ambiguous.content, /appears 2 times/);
      const edited = await executeTool(
        'edit_file',
        JSON.stringify({ path: 'edit.txt', old_string: 'alpha', new_string: 'omega' }),
        ctx,
      );
      assert.equal(edited.status, 'ok');
      assert.equal(await readFile(path.join(cwd, 'edit.txt'), 'utf8'), 'omega\nbeta\nbeta\n');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  await test('glob finds files, honours .gitignore, skips heavy directories, and caps results', async () => {
    const cwd = await tempDir('kiro-glob-');
    const controller = new AbortController();
    const ctx: ToolContext = { cwd, signal: controller.signal, approve: approvalSpy().fn };
    try {
      await mkdir(path.join(cwd, 'src/nested'), { recursive: true });
      await mkdir(path.join(cwd, 'node_modules/pkg'), { recursive: true });
      await mkdir(path.join(cwd, 'dist'), { recursive: true });
      await mkdir(path.join(cwd, 'build'), { recursive: true });
      await mkdir(path.join(cwd, 'ignored-dir'), { recursive: true });
      await writeFile(path.join(cwd, '.gitignore'), '*.log\nignored-dir/\n');
      await writeFile(path.join(cwd, 'src/a.ts'), 'export const a = 1;\n');
      await writeFile(path.join(cwd, 'src/nested/b.ts'), 'export const b = 2;\n');
      await writeFile(path.join(cwd, 'node_modules/pkg/c.ts'), 'no\n');
      await writeFile(path.join(cwd, 'dist/d.ts'), 'no\n');
      await writeFile(path.join(cwd, 'build/e.ts'), 'no\n');
      await writeFile(path.join(cwd, 'ignored-dir/f.ts'), 'no\n');
      await writeFile(path.join(cwd, 'debug.log'), 'no\n');

      const result = await executeTool('glob', JSON.stringify({ pattern: '**/*.ts' }), ctx);
      assert.equal(result.status, 'ok');
      assert.match(result.content, /src\/a\.ts/);
      assert.match(result.content, /src\/nested\/b\.ts/);
      assert.doesNotMatch(result.content, /node_modules/);
      assert.doesNotMatch(result.content, /dist\//);
      assert.doesNotMatch(result.content, /build\//);
      assert.doesNotMatch(result.content, /ignored-dir/);
      assert.doesNotMatch(result.content, /debug\.log/);

      const shallow = await executeTool('glob', JSON.stringify({ pattern: '*.ts' }), ctx);
      assert.match(shallow.content, /src\/a\.ts/);

      const dirs = await executeTool('glob', JSON.stringify({ pattern: 'src/**' }), ctx);
      assert.match(dirs.content, /src\/nested\//);

      const outside = await executeTool('glob', JSON.stringify({ pattern: '*', path: '../' }), ctx);
      assert.equal(outside.status, 'error');
      assert.match(outside.content, /outside the working directory/);

      for (let index = 0; index < 205; index++) {
        await writeFile(path.join(cwd, `bulk-${index}.txt`), 'x');
      }
      const capped = await executeTool('glob', JSON.stringify({ pattern: 'bulk-*' }), ctx);
      assert.equal(capped.status, 'ok');
      assert.equal(capped.content.split('\n').filter((line) => /^bulk-/.test(line)).length, 200);
      assert.match(capped.content, /Showing the first 200 matches/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  await test('grep searches with globs/context case-insensitively and survives a forced fallback', async () => {
    const cwd = await tempDir('kiro-grep-');
    const controller = new AbortController();
    const ctx: ToolContext = { cwd, signal: controller.signal, approve: approvalSpy().fn };
    const previous = process.env.KIRO_GREP_NO_RG;
    try {
      await mkdir(path.join(cwd, 'src'), { recursive: true });
      await mkdir(path.join(cwd, 'ignored-dir'), { recursive: true });
      await writeFile(path.join(cwd, '.gitignore'), 'ignored-dir/\n*.log\n');
      await writeFile(
        path.join(cwd, 'src/a.ts'),
        'export const foo = 1;\nexport const FOO = 2;\n// foo comment\n',
      );
      await writeFile(path.join(cwd, 'src/b.md'), 'foo in markdown\n');
      await writeFile(path.join(cwd, 'ignored-dir/c.ts'), 'foo ignored\n');
      await writeFile(path.join(cwd, 'debug.log'), 'foo log\n');
      await writeFile(path.join(cwd, 'binary.bin'), Buffer.from([0, 102, 111, 111]));
      await writeFile(path.join(cwd, 'huge.txt'), Buffer.alloc(2 * 1024 * 1024 + 32, 'a'));

      const rgResult = await executeTool(
        'grep',
        JSON.stringify({ pattern: 'foo', glob: '*.ts' }),
        ctx,
      );
      assert.equal(rgResult.status, 'ok');
      assert.match(rgResult.content, /src\/a\.ts:1: export const foo = 1;/);
      assert.doesNotMatch(rgResult.content, /ignored-dir|debug\.log|binary\.bin|huge\.txt/);

      process.env.KIRO_GREP_NO_RG = '1';
      const fallback = await executeTool(
        'grep',
        JSON.stringify({ pattern: 'FOO', ignore_case: true, glob: '*.ts', context_lines: 1 }),
        ctx,
      );
      assert.equal(fallback.status, 'ok');
      assert.match(fallback.content, /via built-in scanner/);
      assert.match(fallback.content, /src\/a\.ts:1:/);
      assert.match(fallback.content, /src\/a\.ts:2:/);
      assert.doesNotMatch(fallback.content, /ignored-dir|debug\.log|huge\.txt/);

      const fileOnly = await executeTool(
        'grep',
        JSON.stringify({ pattern: 'foo', path: 'src/a.ts' }),
        ctx,
      );
      assert.match(fileOnly.content, /src\/a\.ts:1:/);

      const one = await executeTool(
        'grep',
        JSON.stringify({ pattern: 'foo', glob: '*.ts', max_results: 1 }),
        ctx,
      );
      assert.match(one.content, /capped at 1 results/);

      const invalid = await executeTool('grep', JSON.stringify({ pattern: '(' }), ctx);
      assert.equal(invalid.status, 'error');
      assert.match(invalid.content, /Invalid regular expression/);

      const binary = await executeTool(
        'grep',
        JSON.stringify({ pattern: 'foo', path: 'binary.bin' }),
        ctx,
      );
      assert.equal(binary.status, 'error');
      assert.match(binary.content, /binary file/);
    } finally {
      if (previous === undefined) delete process.env.KIRO_GREP_NO_RG;
      else process.env.KIRO_GREP_NO_RG = previous;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  await test('edit_file supports replace_all and hints at near misses', async () => {
    const cwd = await tempDir('kiro-edit-hint-');
    const controller = new AbortController();
    const spy = approvalSpy('allow');
    const ctx: ToolContext = { cwd, signal: controller.signal, approve: spy.fn };
    try {
      const file = path.join(cwd, 'edit.txt');
      await writeFile(file, 'alpha\nbeta\nbeta\nconst x=1;\n');

      const nearMiss = await executeTool(
        'edit_file',
        JSON.stringify({ path: 'edit.txt', old_string: 'const x = 1;', new_string: 'const x = 2;' }),
        ctx,
      );
      assert.equal(nearMiss.status, 'error');
      assert.match(nearMiss.content, /Hint:/);
      assert.match(nearMiss.content, /spacing or indentation differs/);
      assert.match(nearMiss.content, /Closest line 4/);
      assert.equal(spy.requests.length, 0);

      const ambiguous = await executeTool(
        'edit_file',
        JSON.stringify({ path: 'edit.txt', old_string: 'beta', new_string: 'gamma' }),
        ctx,
      );
      assert.equal(ambiguous.status, 'error');
      assert.match(ambiguous.content, /replace_all=true/);

      const replaced = await executeTool(
        'edit_file',
        JSON.stringify({
          path: 'edit.txt',
          old_string: 'beta',
          new_string: 'gamma',
          replace_all: true,
        }),
        ctx,
      );
      assert.equal(replaced.status, 'ok');
      assert.match(replaced.content, /2 replacements/);
      assert.match(spy.requests[0]?.title ?? '', /2 replacements/);
      assert.equal(await readFile(file, 'utf8'), 'alpha\ngamma\ngamma\nconst x=1;\n');

      const denySpy = approvalSpy('deny');
      const deniedResult = await executeTool(
        'edit_file',
        JSON.stringify({ path: 'edit.txt', old_string: 'alpha', new_string: 'omega' }),
        { cwd, signal: controller.signal, approve: denySpy.fn },
      );
      assert.equal(deniedResult.status, 'denied');
      assert.match(await readFile(file, 'utf8'), /^alpha\n/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  await test('multi_edit validates every edit before writing anything', async () => {
    const cwd = await tempDir('kiro-multi-edit-');
    const controller = new AbortController();
    const file = path.join(cwd, 'multi.txt');
    try {
      await writeFile(file, 'one\ntwo\nthree\n');

      const failingSpy = approvalSpy('allow');
      const failing = await executeTool(
        'multi_edit',
        JSON.stringify({
          path: 'multi.txt',
          edits: [
            { old_string: 'one', new_string: '1' },
            { old_string: 'missing', new_string: 'x' },
          ],
        }),
        { cwd, signal: controller.signal, approve: failingSpy.fn },
      );
      assert.equal(failing.status, 'error');
      assert.match(failing.content, /Edit 2 of 2 failed/);
      assert.match(failing.content, /no changes were written/);
      assert.equal(failingSpy.requests.length, 0);
      assert.equal(await readFile(file, 'utf8'), 'one\ntwo\nthree\n');

      const spy = approvalSpy('allow');
      const applied = await executeTool(
        'multi_edit',
        JSON.stringify({
          path: 'multi.txt',
          edits: [
            { old_string: 'one', new_string: '1' },
            { old_string: 'two', new_string: '2' },
          ],
        }),
        { cwd, signal: controller.signal, approve: spy.fn },
      );
      assert.equal(applied.status, 'ok');
      assert.equal(spy.requests.length, 1);
      assert.match(spy.requests[0]?.title ?? '', /2 locations/);
      assert.match(spy.requests[0]?.detail ?? '', /-one/);
      assert.match(spy.requests[0]?.detail ?? '', /\+1/);
      assert.equal(await readFile(file, 'utf8'), '1\n2\nthree\n');

      const denySpy = approvalSpy('deny');
      const deniedResult = await executeTool(
        'multi_edit',
        JSON.stringify({
          path: 'multi.txt',
          edits: [{ old_string: 'three', new_string: '3' }],
        }),
        { cwd, signal: controller.signal, approve: denySpy.fn },
      );
      assert.equal(deniedResult.status, 'denied');
      assert.equal(await readFile(file, 'utf8'), '1\n2\nthree\n');

      const empty = await executeTool(
        'multi_edit',
        JSON.stringify({ path: 'multi.txt', edits: [] }),
        { cwd, signal: controller.signal, approve: spy.fn },
      );
      assert.equal(empty.status, 'error');
      assert.match(empty.content, /non-empty array/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  await test('apply_patch validates hunks, then updates and creates files together', async () => {
    const cwd = await tempDir('kiro-patch-');
    const controller = new AbortController();
    const spy = approvalSpy('allow');
    const ctx: ToolContext = { cwd, signal: controller.signal, approve: spy.fn };
    try {
      await writeFile(path.join(cwd, 'a.txt'), 'alpha\nbeta\n');
      await writeFile(path.join(cwd, 'b.txt'), 'one\ntwo\n');
      const patch = [
        'diff --git a/a.txt b/a.txt',
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1,2 +1,2 @@',
        ' alpha',
        '-beta',
        '+gamma',
        'diff --git a/b.txt b/b.txt',
        '--- a/b.txt',
        '+++ b/b.txt',
        '@@ -1,2 +1,2 @@',
        ' one',
        '-two',
        '+2',
        'diff --git a/c.txt b/c.txt',
        '--- /dev/null',
        '+++ b/c.txt',
        '@@ -0,0 +1,1 @@',
        '+created',
        '',
      ].join('\n');

      const applied = await executeTool('apply_patch', JSON.stringify({ patch }), ctx);
      assert.equal(applied.status, 'ok');
      assert.equal(spy.requests.length, 1);
      assert.match(spy.requests[0]?.title ?? '', /3 files/);
      assert.match(spy.requests[0]?.detail ?? '', /a\.txt/);
      assert.match(spy.requests[0]?.detail ?? '', /b\.txt/);
      assert.match(spy.requests[0]?.detail ?? '', /c\.txt/);
      assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), 'alpha\ngamma\n');
      assert.equal(await readFile(path.join(cwd, 'b.txt'), 'utf8'), 'one\n2\n');
      assert.equal(await readFile(path.join(cwd, 'c.txt'), 'utf8'), 'created\n');

      const badPatch = [
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1,1 +1,1 @@',
        '-not present',
        '+oops',
        '',
      ].join('\n');
      const invalid = await executeTool('apply_patch', JSON.stringify({ patch: badPatch }), ctx);
      assert.equal(invalid.status, 'error');
      assert.match(invalid.content, /does not apply cleanly/);
      assert.equal(spy.requests.length, 1);
      assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), 'alpha\ngamma\n');

      const deletion = [
        '--- a/a.txt',
        '+++ /dev/null',
        '@@ -1,2 +0,0 @@',
        '-alpha',
        '-gamma',
        '',
      ].join('\n');
      const removed = await executeTool('apply_patch', JSON.stringify({ patch: deletion }), ctx);
      assert.equal(removed.status, 'error');
      assert.match(removed.content, /Deleting .* is not supported/);
      assert.equal(await fileExists(path.join(cwd, 'a.txt')), true);

      const conflict = [
        '--- /dev/null',
        '+++ b/a.txt',
        '@@ -0,0 +1,1 @@',
        '+replaced',
        '',
      ].join('\n');
      const existing = await executeTool('apply_patch', JSON.stringify({ patch: conflict }), ctx);
      assert.equal(existing.status, 'error');
      assert.match(existing.content, /already exists/);
      assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), 'alpha\ngamma\n');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  await test('list_dir marks directories; run_command reports exit codes and timeouts', async () => {
    const cwd = await tempDir();
    await mkdir(path.join(cwd, 'src'));
    await writeFile(path.join(cwd, 'a.txt'), 'a');
    const controller = new AbortController();
    const ctx: ToolContext = { cwd, signal: controller.signal, approve: approvalSpy().fn };
    try {
      const listing = await executeTool('list_dir', JSON.stringify({ path: '.' }), ctx);
      assert.equal(listing.status, 'ok');
      assert.match(listing.content, /src\//);
      assert.match(listing.content, /a\.txt/);

      const failure = await executeTool(
        'run_command',
        JSON.stringify({ command: 'node -e "console.error(\'boom\'); process.exit(7)"' }),
        ctx,
      );
      assert.equal(failure.status, 'error');
      assert.match(failure.content, /exit code: 7/);
      assert.match(failure.content, /boom/);

      const timeout = await executeTool(
        'run_command',
        JSON.stringify({ command: 'node -e "setTimeout(() => {}, 5000)"', timeout_seconds: 1 }),
        ctx,
      );
      assert.equal(timeout.status, 'error');
      assert.match(timeout.summary, /timed out/);
      assert.match(timeout.content, /timed out after 1s/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  await test('run_command truncates very large output keeping head and tail', async () => {
    const cwd = await tempDir();
    const controller = new AbortController();
    try {
      const script =
        `node -e "process.stdout.write('H'.repeat(25000)); process.stdout.write('TAIL_MARKER');"`;
      const result = await executeTool(
        'run_command',
        JSON.stringify({ command: script }),
        { cwd, signal: controller.signal, approve: approvalSpy().fn },
      );
      assert.equal(result.status, 'ok');
      assert.match(result.content, /characters omitted/);
      assert.match(result.content, /TAIL_MARKER/);
      assert.ok(result.content.length <= 20_100, `content length ${result.content.length}`);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  await test('config template, overrides, malformed config, and missing key errors', async () => {
    const dir = await tempDir('kiro-config-');
    const configFile = path.join(dir, 'config.json');
    const previousPath = process.env.KIRO_CONFIG_PATH;
    const previousKey = process.env.KIRO_TEST_KEY;
    process.env.KIRO_CONFIG_PATH = configFile;
    delete process.env.KIRO_TEST_KEY;
    try {
      const loaded = await loadConfig();
      assert.equal(loaded.created, true);
      assert.equal(loaded.config.activeProfile, 'default');
      assert.equal(loaded.config.profiles.default?.type, 'openai');
      assert.equal(await fileExists(configFile), true);

      const overridden = applyOverrides(loaded.config, {
        baseUrl: 'http://localhost:11434/v1/',
        model: 'llama3',
      });
      assert.equal(overridden.profiles.default?.baseUrl, 'http://localhost:11434/v1');
      assert.equal(overridden.profiles.default?.model, 'llama3');
      assert.throws(() => applyOverrides(loaded.config, { profile: 'missing' }), ConfigError);

      const custom: KiroConfig = {
        activeProfile: 'local',
        profiles: {
          local: {
            type: 'openai',
            baseUrl: 'http://localhost:11434/v1',
            apiKeyEnv: 'KIRO_TEST_KEY',
            model: 'llama3',
          },
        },
      };
      assert.throws(() => resolveProfile(custom), /API key is missing/);
      process.env.KIRO_TEST_KEY = 'secret';
      assert.equal(resolveProfile(custom).apiKey, 'secret');
      assert.throws(
        () => resolveProfile({ ...custom, profiles: { local: { ...custom.profiles.local!, type: 'anthropic' } } }),
        /unsupported provider type/,
      );

      await writeFile(configFile, '{not json');
      await assert.rejects(loadConfig(), /Invalid JSON/);
    } finally {
      if (previousPath === undefined) delete process.env.KIRO_CONFIG_PATH;
      else process.env.KIRO_CONFIG_PATH = previousPath;
      if (previousKey === undefined) delete process.env.KIRO_TEST_KEY;
      else process.env.KIRO_TEST_KEY = previousKey;
      await rm(dir, { recursive: true, force: true });
    }
  });

  await test('system prompt includes cwd, OS, and AGENTS.md', async () => {
    const cwd = await tempDir();
    try {
      await writeFile(path.join(cwd, 'AGENTS.md'), 'Always use tabs.\n');
      const prompt = await buildSystemPrompt(cwd);
      assert.match(prompt, /You are Kiro/);
      assert.ok(prompt.includes(cwd));
      assert.match(prompt, /Operating system:/);
      assert.match(prompt, /Always use tabs/);
      assert.match(prompt, /grep/);
      assert.match(prompt, /glob/);
      assert.match(prompt, /multi_edit/);
      assert.match(prompt, /apply_patch/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  await test('session store saves, lists, loads, and rejects bad records', async () => {
    const root = await tempDir('kiro-session-store-');
    const workspace = await tempDir('kiro-session-cwd-');
    const other = await tempDir('kiro-session-other-');
    const previous = process.env.KIRO_SESSIONS_DIR;
    process.env.KIRO_SESSIONS_DIR = root;
    try {
      const firstMessages: ChatMessage[] = [
        { role: 'system', content: 'old prompt' },
        { role: 'user', content: 'Create hello.txt' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'write_file', arguments: '{"path":"hello.txt","content":"hi"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', name: 'write_file', content: 'Created hello.txt.' },
        { role: 'assistant', content: 'Done.' },
      ];
      const firstUsage = { promptTokens: 1_200, completionTokens: 340, requests: 3 };
      const first = await saveSession({
        cwd: workspace,
        profile: 'default',
        model: 'mock-model',
        messages: firstMessages,
        usage: firstUsage,
      });
      assert.ok(isSessionId(first.id));
      assert.equal(first.title, 'Create hello.txt');
      assert.equal(first.messages.length, 4);
      assert.deepEqual(first.usage, firstUsage);
      assert.ok(first.messages.every((message) => message.role !== 'system'));

      const dir = projectSessionsDir(workspace);
      await assertPrivateMode(dir, 0o700);
      await assertPrivateMode(path.join(dir, `${first.id}.json`), 0o600);

      const loaded = await loadSession(workspace, first.id);
      assert.deepEqual(loaded.messages, firstMessages.slice(1));
      assert.equal(loaded.cwd, path.resolve(workspace));
      assert.equal(loaded.profile, 'default');
      assert.equal(loaded.model, 'mock-model');
      assert.deepEqual(loaded.usage, firstUsage);

      await sleep(20);
      const second = await saveSession({
        cwd: workspace,
        profile: 'default',
        model: 'mock-model',
        title: 'Second session',
        messages: [{ role: 'user', content: 'Second prompt' }],
      });
      const listed = await listSessions(workspace);
      assert.deepEqual(
        listed.sessions.map((session) => session.id),
        [second.id, first.id],
      );
      assert.equal(listed.sessions[0]?.title, 'Second session');
      assert.equal(listed.sessions[0]?.messageCount, 1);
      assert.equal((await latestSession(workspace))?.id, second.id);
      assert.equal((await listSessions(other)).sessions.length, 0);

      await writeFile(path.join(dir, 'broken.json'), '{not json');
      const withBroken = await listSessions(workspace);
      assert.equal(withBroken.sessions.length, 2);
      assert.equal(withBroken.skipped, 1);

      await assert.rejects(loadSession(workspace, '../escape'), /Invalid session id/);
      await assert.rejects(loadSession(workspace, 'missing'), /not found/);
      assert.equal(titleFromMessages([{ role: 'user', content: '  hello\nworld  ' }]), 'hello world');
      assert.equal(titleFromMessages([]), 'Untitled session');

      const partial: ChatMessage[] = [
        { role: 'user', content: 'Read two files' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_x', type: 'function', function: { name: 'read_file', arguments: '{}' } },
            { id: 'call_y', type: 'function', function: { name: 'read_file', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_x', name: 'read_file', content: 'one' },
      ];
      assert.deepEqual(dropIncompleteToolCalls(partial), [partial[0]]);
      const complete = [
        ...partial,
        { role: 'tool' as const, tool_call_id: 'call_y', name: 'read_file', content: 'two' },
      ];
      assert.deepEqual(dropIncompleteToolCalls(complete), complete);
    } finally {
      if (previous === undefined) delete process.env.KIRO_SESSIONS_DIR;
      else process.env.KIRO_SESSIONS_DIR = previous;
      await rm(root, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
      await rm(other, { recursive: true, force: true });
    }
  });

  await test('sessions list across project directories with grouping', async () => {
    const root = await tempDir('kiro-session-all-');
    const workspace = await tempDir('kiro-session-all-cwd-');
    const other = await tempDir('kiro-session-all-other-');
    const emptyRoot = await tempDir('kiro-session-all-empty-');
    const previous = process.env.KIRO_SESSIONS_DIR;
    process.env.KIRO_SESSIONS_DIR = root;
    try {
      const mine = await saveSession({
        cwd: workspace,
        profile: 'default',
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Mine' }],
      });
      await sleep(20);
      const theirs = await saveSession({
        cwd: other,
        profile: 'default',
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Theirs' }],
      });

      const all = await listAllSessions(workspace);
      assert.deepEqual(all.current.map((session) => session.id), [mine.id]);
      assert.equal(all.current[0]?.cwd, path.resolve(workspace));
      assert.equal(all.others.length, 1);
      assert.equal(all.others[0]?.cwd, path.resolve(other));
      assert.deepEqual(all.others[0]?.sessions.map((session) => session.id), [theirs.id]);
      assert.equal(all.skipped, 0);

      const foreignRecord = await loadSession(other, theirs.id);
      assert.equal(foreignRecord.cwd, path.resolve(other));
      assert.equal(foreignRecord.messages[0]?.content, 'Theirs');

      await writeFile(path.join(projectSessionsDir(other), 'broken.json'), '{nope');
      const withBroken = await listAllSessions(workspace);
      assert.equal(withBroken.skipped, 1);
      assert.deepEqual(withBroken.others[0]?.sessions.map((session) => session.id), [theirs.id]);
      assert.deepEqual(
        (await listSessions(workspace)).sessions.map((session) => session.id),
        [mine.id],
      );

      process.env.KIRO_SESSIONS_DIR = emptyRoot;
      assert.deepEqual(await listAllSessions(workspace), {
        current: [],
        others: [],
        skipped: 0,
      });
    } finally {
      if (previous === undefined) delete process.env.KIRO_SESSIONS_DIR;
      else process.env.KIRO_SESSIONS_DIR = previous;
      await rm(root, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
      await rm(other, { recursive: true, force: true });
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });

  await test('session picker groups tabs and formats rows', async () => {
    const currentCwd = path.join(await tempDir('kiro-picker-cwd-'), 'shop');
    const otherCwd = path.join(await tempDir('kiro-picker-other-'), 'site');
    const summary = (
      id: string,
      cwd: string,
      title: string,
      updatedAt: string,
      messageCount = 2,
    ): SessionSummary => ({
      id,
      cwd,
      profile: 'default',
      model: 'mock-model',
      title,
      createdAt: updatedAt,
      updatedAt,
      messageCount,
    });
    const data: AllSessionsResult = {
      current: [
        summary('20261030-101200-aaaa', currentCwd, 'Dashboard toko', '2026-10-30T10:12:00.000Z', 18),
        summary('20261029-221000-bbbb', currentCwd, 'Fix tests', '2026-10-29T22:10:00.000Z', 7),
      ],
      others: [
        {
          cwd: otherCwd,
          sessions: [
            summary('20261028-090100-cccc', otherCwd, 'Checkout flow', '2026-10-28T09:01:00.000Z', 12),
          ],
        },
      ],
      skipped: 0,
    };

    assert.deepEqual(sessionCounts(data), { current: 2, others: 1 });
    assert.equal(sessionTabLabel('current', sessionCounts(data)), 'This directory (2)');
    assert.equal(sessionTabLabel('others', sessionCounts(data)), 'Other directories (1)');
    assert.equal(shortCwd(currentCwd, currentCwd), '.');

    const currentRows = buildSessionRows(data, 'current', currentCwd);
    assert.equal(currentRows.length, 2);
    assert.deepEqual(sessionRowLines(currentRows), [0, 1]);
    assert.match(sessionRowText(data.current[0]!, true), /^\* 20261030/);
    assert.match(sessionRowText(data.current[0]!, false), /^  20261030/);

    const otherRows = buildSessionRows(data, 'others', currentCwd);
    assert.equal(otherRows[0]?.kind, 'header');
    assert.match(otherRows[0]?.kind === 'header' ? otherRows[0].text : '', /site \(1\)/);
    assert.equal(sessionRowItems(otherRows).length, 1);
    assert.deepEqual(sessionRange(otherRows, 0, otherRows.length), {
      above: 0,
      below: 0,
      first: 1,
      last: 1,
      total: 1,
    });

    assert.equal(filterSessions(data.current, 'dashboard').length, 1);
    assert.equal(filterSessions(data.current, 'zzz').length, 0);
    assert.equal(filterSessions(data.others[0]!.sessions, 'checkout').length, 1);
    assert.match(sessionEmptyText('current', '', false), /No saved sessions/);
    assert.match(sessionEmptyText('others', 'zzz', true), /No sessions match/);

    const rendered = renderToString(
      React.createElement(SessionPicker, {
        cwd: currentCwd,
        data,
        width: 76,
        height: 16,
        onSelect: () => {},
        onCancel: () => {},
      }),
      { columns: 120 },
    ).trimEnd();
    const lines = rendered.split('\n');
    assert.equal(lines.length, 16, 'the session dialog keeps a fixed frame');
    for (const line of lines) {
      assert.ok(displayWidth(line) <= 76, `popup line fits: ${line}`);
    }
    assert.match(rendered, /Sessions/);
    assert.match(rendered, /This directory \(2\)/);
    assert.match(rendered, /Other directories \(1\)/);
    assert.match(rendered, /1-2 of 2/);
    assert.match(rendered, /Esc close/);

    const empty = renderToString(
      React.createElement(SessionPicker, {
        cwd: currentCwd,
        data: { current: [], others: [], skipped: 0 },
        width: 60,
        onSelect: () => {},
        onCancel: () => {},
      }),
      { columns: 100 },
    ).trimEnd();
    assert.match(empty, /No saved sessions for this directory/);
    assert.ok(displayWidth(empty.split('\n')[0] ?? '') <= 60);
    assert.ok(SESSION_INLINE_ROWS >= 12);
  });

  await test('resumed history rebuilds tool blocks and statuses', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Ping' },
      {
        role: 'assistant',
        content: 'Working.',
        tool_calls: [
          {
            id: 'call_a',
            type: 'function',
            function: { name: 'run_command', arguments: '{"command":"ls"}' },
          },
          {
            id: 'call_b',
            type: 'function',
            function: { name: 'write_file', arguments: '{"path":"x","content":"y"}' },
          },
          {
            id: 'call_c',
            type: 'function',
            function: { name: 'edit_file', arguments: '{"path":"x","old_string":"a","new_string":"b"}' },
          },
          {
            id: 'call_d',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"missing"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_a', name: 'run_command', content: 'exit code: 0\nok' },
      {
        role: 'tool',
        tool_call_id: 'call_b',
        name: 'write_file',
        content: 'User denied this tool call.',
      },
      {
        role: 'tool',
        tool_call_id: 'call_c',
        name: 'edit_file',
        content: 'Error: old_string was not found.',
      },
    ];
    const view = buildResumedView(messages, {
      cwd: '/tmp/project',
      version: '0.1.0',
      sessionId: '20260101-000000-abcd',
    });
    assert.equal(view.items[0]?.kind, 'banner');
    assert.ok(
      view.items.some((item) => item.kind === 'notice' && item.text.includes('Resumed session')),
    );

    const user = view.items.find((item): item is Extract<ViewItem, { kind: 'user' }> => item.kind === 'user');
    assert.equal(user?.text, 'Ping');
    const assistant = view.items.find(
      (item): item is Extract<ViewItem, { kind: 'assistant' }> => item.kind === 'assistant',
    );
    assert.equal(assistant?.text, 'Working.');
    const tools = view.items.filter(
      (item): item is Extract<ViewItem, { kind: 'tool' }> => item.kind === 'tool',
    );
    assert.equal(tools.length, 4);
    assert.deepEqual(
      tools.map((tool) => tool.status),
      ['ok', 'denied', 'error', 'error'],
    );
    assert.equal(tools[0]?.argsSummary, '$ ls');
    assert.match(tools[3]?.resultSummary ?? '', /not recorded/);
    assert.ok(view.nextId > 1);
  });

  await test('input edit sequences distinguish backspace from delete', async () => {
    assert.deepEqual(parseEditSequence('\x7f'), { type: 'backspace', count: 1 });
    assert.deepEqual(parseEditSequence('\x7f\x7f'), { type: 'backspace', count: 2 });
    assert.deepEqual(parseEditSequence('\x7f\x7f\x7f'), { type: 'backspace', count: 3 });
    assert.deepEqual(parseEditSequence('\x08'), { type: 'backspace', count: 1 });
    assert.deepEqual(parseEditSequence('\x08\x08'), { type: 'backspace', count: 2 });
    assert.deepEqual(parseEditSequence('\x1b\b'), { type: 'backspace', count: 1 });
    assert.deepEqual(parseEditSequence('\x1b\x7f'), { type: 'backspace', count: 1 });
    assert.deepEqual(parseEditSequence('\x1b[3~'), { type: 'delete', count: 1 });
    assert.deepEqual(parseEditSequence('\x1b[3~\x1b[3~'), { type: 'delete', count: 2 });
    assert.equal(parseEditSequence('abc'), null);
    assert.equal(parseEditSequence('abc\x7f'), null);
    assert.equal(parseEditSequence('\x1b[D'), null);
  });

  await test('glued input chunks keep Enter, Backspace and ctrl edits', async () => {
    const typed = applyInputOps({ chars: [], cursor: 0 }, parseInputChunk('abc\r'));
    assert.deepEqual(typed.state.chars, ['a', 'b', 'c']);
    assert.equal(typed.submitted, true);

    const corrected = applyInputOps({ chars: [], cursor: 0 }, parseInputChunk('ab\x7fc\r'));
    assert.deepEqual(corrected.state.chars, ['a', 'c']);
    assert.equal(corrected.submitted, true);

    const deleted = applyInputOps(
      { chars: ['a', 'b', 'c'], cursor: 1 },
      parseInputChunk('\x1b[3~x'),
    );
    assert.deepEqual(deleted.state.chars, ['a', 'x', 'c']);
    assert.equal(deleted.state.cursor, 2);

    const cleared = applyInputOps(
      { chars: ['x', 'y'], cursor: 1 },
      parseInputChunk('ab\x15'),
    );
    assert.deepEqual(cleared.state.chars, ['y']);
    assert.equal(cleared.state.cursor, 0);

    const word = applyInputOps(
      { chars: ['o', 'n', 'e', ' ', 't', 'w', 'o'], cursor: 7 },
      parseInputChunk('\x17'),
    );
    assert.deepEqual(word.state.chars, ['o', 'n', 'e', ' ']);
    assert.equal(word.state.cursor, 4);
  });

  await test('pasted input never submits and stays inside the buffer limit', async () => {
    assert.deepEqual(parseInputChunk('\x7f\x7f'), []);
    assert.deepEqual(parseInputChunk('\x1b[3~\x1b[3~'), []);

    const pasted = applyInputOps({ chars: [], cursor: 0 }, parseInputChunk('one\ntwo\n'));
    assert.equal(pasted.submitted, false);
    assert.equal(pasted.state.chars.join(''), 'one\ntwo\n');

    const long = `${'x'.repeat(300)}\r`;
    const longApplied = applyInputOps({ chars: [], cursor: 0 }, parseInputChunk(long));
    assert.equal(longApplied.submitted, false);
    assert.equal(longApplied.state.chars.length, long.length);

    const capped = applyInputOps({ chars: [], cursor: 0 }, parseInputChunk('abcdef\r'), 3);
    assert.deepEqual(capped.state.chars, ['a', 'b', 'c']);
    assert.equal(capped.state.cursor, 3);
    assert.equal(capped.submitted, true);
  });

  await test('multi-line input keeps newlines and wraps around the caret', async () => {
    const newline = applyInputOps({ chars: [], cursor: 0 }, parseInputChunk('\n'));
    assert.deepEqual(newline.state.chars, ['\n']);
    assert.equal(newline.submitted, false);

    const typed = applyInputOps({ chars: [], cursor: 0 }, parseInputChunk('one\ntwo'));
    assert.equal(typed.state.chars.join(''), 'one\ntwo');

    const backslash = applyInputOps({ chars: [], cursor: 0 }, parseInputChunk('path\\\r'));
    assert.equal(backslash.submitted, false, 'backslash+Enter adds a line instead of submitting');
    assert.equal(backslash.state.chars.join(''), 'path\n');

    const crlf = applyInputOps({ chars: [], cursor: 0 }, parseInputChunk('one\r\ntwo'));
    assert.equal(crlf.state.chars.join(''), 'one\ntwo');

    let paste = { open: false, buffer: '', pending: '' };
    let fed = feedPaste(paste, '\x1b[200~hello\nworld\x1b[201~');
    paste = fed.state;
    assert.equal(fed.text, 'hello\nworld');
    assert.equal(paste.open, false);

    let split = { open: false, buffer: '', pending: '' };
    fed = feedPaste(split, '[200~first\nsecond');
    split = fed.state;
    assert.equal(fed.text, null);
    assert.equal(split.open, true);
    fed = feedPaste(split, 'third\x1b[201~');
    assert.equal(fed.text, 'first\nsecondthird');

    let torn = { open: false, buffer: '', pending: '' };
    fed = feedPaste(torn, '[20');
    torn = fed.state;
    assert.equal(fed.text, null, 'a torn start marker inserts nothing');
    assert.equal(fed.consumed, true);
    assert.equal(torn.pending, '[20');
    fed = feedPaste(torn, '0~pasted text\x1b[201~');
    assert.equal(fed.text, 'pasted text');

    const untouched = feedPaste({ open: false, buffer: '', pending: '' }, 'plain');
    assert.equal(untouched.consumed, false, 'normal typing still reaches the key parser');

    assert.equal(normalizePastedText('a\r\nb\tc'), 'a\nb    c');

    const lines = layoutInput(Array.from('abcdef'), 3);
    assert.deepEqual(lines.map((line) => line.text), ['abc', 'def']);
    assert.equal(cursorLineIndex(lines, 3), 1, 'caret wraps to the next row');

    const explicit = layoutInput(Array.from('ab\ncd'), 10);
    assert.deepEqual(explicit.map((line) => line.text), ['ab', 'cd']);
    assert.equal(cursorLineIndex(explicit, 2), 0, 'caret stays before the newline');
    assert.deepEqual(
      layoutInput(Array.from('a\n'), 10).map((line) => line.text),
      ['a', ''],
    );
  });

  await test('file mentions parse tokens, quote names, and rank matches', async () => {
    const chars = Array.from('look at @src/ui/App');
    const token = mentionAt(chars, chars.length, chars.indexOf('@'));
    assert.equal(token?.query, 'src/ui/App');
    assert.equal(token?.end, chars.length);
    assert.equal(mentionAt(Array.from('mail@example.com'), 16, 4), null);
    assert.equal(mentionOpeningAt(Array.from('hi @'), 4), 3);
    assert.equal(mentionOpeningAt(Array.from('mail@'), 5), null);
    assert.equal(mentionNearby(chars, chars.length), chars.indexOf('@'));
    assert.equal(mentionNearby(Array.from('mail@example.com'), 16), null);

    const quoted = Array.from('@"my file.ts"');
    const quotedToken = mentionAt(quoted, quoted.length - 1, 0);
    assert.equal(quotedToken?.query, 'my file.ts');
    assert.equal(quotedToken?.end, quoted.length);
    assert.equal(mentionAt(quoted, quoted.length, 0), null, 'a closed mention ends the menu');
    assert.equal(mentionText('my file.ts'), '@"my file.ts"');
    assert.equal(mentionText('src/ui/App.tsx'), '@src/ui/App.tsx');

    const files = [
      'src/agent/prompt.ts',
      'src/ui/App.tsx',
      'src/ui/apply.ts',
      'README.md',
      'docs/application.md',
    ];
    assert.deepEqual(filterFiles(files, 'App').slice(0, 2), ['src/ui/App.tsx', 'src/ui/apply.ts']);
    assert.equal(filterFiles(files, 'read')[0], 'README.md');
    assert.deepEqual(filterFiles(files, 'agent/prompt'), ['src/agent/prompt.ts']);
    assert.deepEqual(filterFiles(files, 'zzz'), []);
  });

  await test('the file index honours .gitignore and skips heavy directories', async () => {
    const dir = await tempDir('kiro-index-');
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(dir, 'src', 'app.ts'), 'x');
    await writeFile(path.join(dir, 'notes.log'), 'x');
    await writeFile(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'x');
    await writeFile(path.join(dir, '.gitignore'), '*.log\n');
    try {
      const files = await listProjectFiles(dir);
      assert.ok(files.includes('src/app.ts'));
      assert.ok(!files.includes('notes.log'), 'ignored files stay out of the index');
      assert.ok(!files.includes('node_modules/pkg/index.js'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await test('approval policy tracks session allowances and yolo', async () => {
    const policy = new ApprovalPolicy(false);
    assert.equal(policy.isAuto('run_command'), false);
    policy.markSession('write_file');
    policy.markSession('run_command');
    policy.markSession('run_command');
    assert.deepEqual(policy.list(), ['run_command', 'write_file']);
    assert.equal(policy.isAuto('run_command'), true);
    assert.equal(policy.isAuto('read_file'), false);
    policy.clear();
    assert.deepEqual(policy.list(), []);
    assert.equal(policy.isAuto('run_command'), false);

    const yoloPolicy = new ApprovalPolicy(true);
    assert.equal(yoloPolicy.isAuto('anything'), true);
    assert.deepEqual(yoloPolicy.list(), []);
  });

  await test('assistant Markdown renders styles without raw markers', async () => {
    const plain = (source: string, width = 60): string =>
      renderMarkdown(source, width)
        .map((line) => line.segments.map((segment) => segment.text).join(''))
        .join('\n');
    const segmentsFor = (source: string, needle: string) =>
      renderMarkdown(source, 60)
        .flatMap((line) => line.segments)
        .filter((segment) => segment.text.includes(needle));

    const source = [
      '**Prinsip kerja saya**',
      '- Satu',
      '- [x] Dua',
      '',
      '## Langkah',
      '1. Jalankan `npm test`',
      '> catatan',
      '',
      '```js',
      'const ok = true;',
      '```',
      '',
      '[docs](https://example.com)',
      'a ~~b~~ c',
    ].join('\n');
    const out = plain(source);
    assert.doesNotMatch(out, /\*\*|`|^##|^>|^```/m);
    assert.match(out, /• Satu/);
    assert.match(out, /• ☑ Dua/);
    assert.match(out, /1\. Jalankan npm test/);
    assert.match(out, /│ catatan/);
    assert.match(out, /const ok = true;/);
    assert.match(out, /docs \(https:\/\/example\.com\)/);
    assert.equal(segmentsFor(source, 'Prinsip kerja saya')[0]?.bold, true);
    assert.equal(segmentsFor(source, 'npm test')[0]?.color, 'yellow');
    assert.equal(segmentsFor(source, 'Langkah')[0]?.bold, true);
    assert.equal(segmentsFor(source, 'catatan')[0]?.italic, true);
    assert.equal(segmentsFor(source, 'b')[0]?.strikethrough, true);

    for (const line of renderMarkdown(`**${'x'.repeat(100)}**`, 20)) {
      assert.ok(displayWidth(line.segments.map((segment) => segment.text).join('')) <= 20);
    }
    assert.match(plain('a * b and **c'), /\* b/);
    assert.equal(plain('**unclosed'), '**unclosed');

    const lines = buildLines(
      [{ kind: 'assistant', id: 1, text: source }],
      60,
    );
    const flat = lines
      .map((line) =>
        line.segments ? line.segments.map((segment) => segment.text).join('') : line.text,
      )
      .join('\n');
    assert.match(flat, /Prinsip kerja saya/);
    assert.doesNotMatch(flat, /\*\*Prinsip/);
    assert.match(flat, /• Satu/);
  });

  await test('Markdown tables align columns and wrap inside the available width', async () => {
    const plain = (source: string, width: number): string =>
      renderMarkdown(source, width)
        .map((line) => line.segments.map((segment) => segment.text).join(''))
        .join('\n');

    const source = [
      '| Kategori | Kemampuan |',
      '| :--- | ---: |',
      '| Cari & Baca | glob, grep, `read_file` |',
      '| Edit | edit_file, multi_edit |',
    ].join('\n');
    const rendered = renderMarkdown(source, 60);
    const text = rendered
      .map((line) => line.segments.map((segment) => segment.text).join(''))
      .join('\n');
    assert.match(text, /┌─+┬─+┐/);
    assert.match(text, /├─+┼─+┤/);
    assert.match(text, /└─+┴─+┘/);
    assert.match(text, /Kategori/);
    assert.match(text, /Cari & Baca/);
    assert.match(text, /read_file/);
    assert.equal(
      rendered
        .flatMap((line) => line.segments)
        .find((segment) => segment.text.includes('Kategori'))?.bold,
      true,
      'header cells stay bold',
    );
    for (const line of rendered) {
      assert.ok(displayWidth(line.segments.map((segment) => segment.text).join('')) <= 60);
    }

    const aligned = plain(
      ['| Name | Count |', '| --- | ---: |', '| a | 42 |'].join('\n'),
      40,
    );
    assert.match(aligned, /│ a +│ +42 │/);

    const wideCell = 'word '.repeat(12).trim();
    const narrow = plain(
      ['| A | B |', '| --- | --- |', `| ${wideCell} | x |`].join('\n'),
      34,
    );
    assert.match(narrow, /┌/);
    for (const line of renderMarkdown(
      ['| A | B |', '| --- | --- |', `| ${wideCell} | x |`].join('\n'),
      34,
    )) {
      assert.ok(displayWidth(line.segments.map((segment) => segment.text).join('')) <= 34);
    }

    const escaped = plain(
      ['| A | B |', '| --- | --- |', '| a \\| b | `x|y` |'].join('\n'),
      50,
    );
    assert.match(escaped, /a \| b/);
    assert.match(escaped, /x\|y/);

    const fenced = plain(['```', '| A | B |', '| --- | --- |', '```'].join('\n'), 50);
    assert.doesNotMatch(fenced, /┌/);
    assert.match(fenced, /\| A \| B \|/);

    const tiny = plain(['| A | B |', '| --- | --- |', '| one | two |'].join('\n'), 10);
    assert.doesNotMatch(tiny, /┌/);
    assert.match(tiny, /\| A \| B \|/);

    const built = buildLines([{ kind: 'assistant', id: 1, text: source }], 60);
    const flat = built
      .map((line) =>
        line.segments ? line.segments.map((segment) => segment.text).join('') : line.text,
      )
      .join('\n');
    assert.match(flat, /┌/);
    for (const line of built) {
      const content = line.segments
        ? line.segments.map((segment) => segment.text).join('')
        : line.text;
      const suffix = line.suffix?.text ?? '';
      assert.ok(displayWidth(`${line.prefix}${content}${suffix}`) <= 60);
    }
  });

  await test('slash command filtering and help share one list', async () => {
    assert.deepEqual(
      filterSlashCommands('/').map((command) => command.name),
      SLASH_COMMANDS.map((command) => command.name),
    );
    assert.deepEqual(filterSlashCommands('/m').map((command) => command.name), [
      '/model',
      '/mouse',
    ]);
    assert.deepEqual(filterSlashCommands('/ex').map((command) => command.name), [
      '/export',
      '/exit',
    ]);
    assert.deepEqual(filterSlashCommands('/co').map((command) => command.name), [
      '/context',
      '/compact',
    ]);
    assert.deepEqual(filterSlashCommands('/us').map((command) => command.name), ['/usage']);
    assert.deepEqual(filterSlashCommands('/HE').map((command) => command.name), ['/help']);
    assert.deepEqual(filterSlashCommands('/model add'), []);
    assert.deepEqual(filterSlashCommands('/nope'), []);
    assert.deepEqual(filterSlashCommands('hello'), []);
    assert.equal(
      slashCommandLabel(SLASH_COMMANDS[1]!),
      '/model [name | add | edit | remove | test | list]',
    );
    const help = slashHelpLines().join('\n');
    assert.match(help, /\/exit\s+quit Kiro/);
    assert.match(help, /\/context\s+show approximate context usage/);
    assert.match(help, /\/usage\s+show or hide the usage card/);
  });

  await test('mouse wheel parsing scrolls and ignores clicks', async () => {
    assert.equal(parseMouseWheel('\x1b[<64;10;5M'), -MOUSE_SCROLL_LINES);
    assert.equal(parseMouseWheel('\x1b[<65;10;5M'), MOUSE_SCROLL_LINES);
    assert.equal(parseMouseWheel('\x1b[<64;10;5M\x1b[<65;1;1M'), 0);
    assert.equal(parseMouseWheel('\x1b[<0;10;5M'), 0);
    assert.equal(parseMouseWheel('\x1b[<68;10;5M'), -MOUSE_SCROLL_LINES);
    assert.equal(isMouseSequence('\x1b[<64;10;5M'), true);
    assert.equal(isMouseSequence('[<65;10;5M'), true);
    assert.equal(isMouseSequence('[Mabc'), true);
    assert.equal(isMouseSequence('/help'), false);
    assert.equal(isMouseSequence('\x1b[5~'), false);
  });

  await test('status bar shows the yolo, auto-allow, and quit-confirmation states', async () => {
    const line = (props: Record<string, unknown>): string =>
      renderToString(
        React.createElement(StatusBar, {
          width: 80,
          profile: 'default',
          model: 'gpt-test',
          cwd: '/home/user/project',
          activity: null,
          ...props,
        }),
      ).trimEnd();

    assert.match(line({}), /ready/);
    assert.doesNotMatch(line({}), /YOLO|auto:/);

    const quitting = line({ quitHint: true });
    assert.match(quitting, /Ctrl\+C again to quit/);
    assert.doesNotMatch(quitting, /ready/);
    assert.ok(displayWidth(quitting) <= 80);
    assert.ok(displayWidth(line({ width: 44, quitHint: true })) <= 44);

    const yolo = line({ yolo: true });
    assert.match(yolo, /YOLO/);
    assert.ok(displayWidth(yolo) <= 80);

    const auto = line({ autoAllowed: ['run_command', 'write_file'] });
    assert.match(auto, /auto:run_command,write_file/);
    assert.doesNotMatch(auto, /YOLO/);
    assert.ok(displayWidth(auto) <= 80);

    const withContext = line({ contextTokens: 42_300, contextWindow: 128_000 });
    assert.match(withContext, /ctx 42k\/128k/);
    assert.ok(displayWidth(withContext) <= 80);
    const narrowContext = line({ width: 44, contextTokens: 42_300, contextWindow: 128_000 });
    assert.ok(displayWidth(narrowContext) <= 44);

    const replying = line({ activity: 'replying', busySince: Date.now() - 6_400 });
    assert.match(replying, /replying… · 6s/);
    assert.ok(displayWidth(replying) <= 80);

    const running = line({
      activity: 'running',
      toolName: 'grep',
      busySince: Date.now() - 12_400,
    });
    assert.match(running, /running grep… · 12s/);

    const justStarted = line({ activity: 'thinking', busySince: Date.now() - 200 });
    assert.match(justStarted, /thinking…/);
    assert.doesNotMatch(justStarted, /· \d+s/, 'no counter during the first second');

    const narrow = line({ width: 44, yolo: true });
    assert.match(narrow, /YOLO/);
    assert.ok(displayWidth(narrow) <= 44);
  });

  await test('the usage card shows session totals, context, and reply speed', async () => {
    const render = (props: Record<string, unknown>): string =>
      renderToString(
        React.createElement(UsageCard, {
          width: USAGE_CARD_WIDTH,
          usage: EMPTY_USAGE,
          contextTokens: 0,
          contextWindow: 64_000,
          contextEstimated: true,
          lastReply: null,
          busy: false,
          ...props,
        }),
      ).trimEnd();

    const card = render({
      usage: { promptTokens: 9_400, completionTokens: 3_100, requests: 8 },
      contextTokens: 40_000,
      contextEstimated: false,
      lastReply: { durationMs: 4_400, tokensPerSecond: 12 },
    });
    assert.match(card, /Usage · 8 req/);
    assert.match(card, /↑ 9\.4k/);
    assert.match(card, /↓ 3\.1k/);
    assert.match(card, /63%/);
    assert.match(card, /40k \/ 64k window/);
    assert.match(card, /last 4\.4s · 12 tok\/s/);
    assert.match(card, /[█]+[░]+/, 'the context gauge shows filled and empty cells');
    for (const line of card.split('\n')) {
      assert.ok(displayWidth(line) <= USAGE_CARD_WIDTH, `card line fits: ${line}`);
    }

    const empty = render({});
    assert.match(empty, /↑ -/);
    assert.match(empty, /↓ -/);
    assert.match(empty, /no timed reply yet/);
    assert.match(empty, /~0 \/ 64k window/);
    assert.match(empty, /0%/);

    const estimated = render({ contextTokens: 40_000 });
    assert.match(estimated, /~40k \/ 64k window/);

    const fast = render({
      usage: { promptTokens: 9_000, completionTokens: 3_100, requests: 1 },
      lastReply: { durationMs: 134, tokensPerSecond: 23_134 },
    });
    assert.match(fast, /last 134ms · 23k tok\/s/);
    assert.doesNotMatch(fast, /23134/);

    assert.equal(shouldShowUsageCard(109, 24), false);
    assert.equal(shouldShowUsageCard(110, 24), true);
    assert.equal(shouldShowUsageCard(140, 8), false);
    assert.equal(shouldShowUsageCard(140, 9), true);

    const accumulated = addUsage(EMPTY_USAGE, {
      promptTokens: 11,
      completionTokens: 3,
      totalTokens: 14,
    });
    assert.deepEqual(accumulated, { promptTokens: 11, completionTokens: 3, requests: 1 });
    assert.deepEqual(
      addUsage(accumulated, { promptTokens: 5, completionTokens: 7, totalTokens: 12 }),
      { promptTokens: 16, completionTokens: 10, requests: 2 },
    );
    assert.deepEqual(normalizeUsage(undefined), {
      promptTokens: 0,
      completionTokens: 0,
      requests: 0,
    });
    assert.deepEqual(normalizeUsage({ promptTokens: 5.4, completionTokens: -2, requests: 'many' }), {
      promptTokens: 5,
      completionTokens: 0,
      requests: 0,
    });
    assert.deepEqual(normalizeUsage([1, 2]), {
      promptTokens: 0,
      completionTokens: 0,
      requests: 0,
    });
  });

  await test('the model picker popup is centered and never shrinks the transcript', () => {
    assert.equal(pickerPopupRect(59, 30), null, 'narrow terminals fall back inline');
    assert.equal(pickerPopupRect(120, 17), null, 'short terminals fall back inline');

    const wide = pickerPopupRect(120, 30);
    assert.ok(wide);
    assert.deepEqual(wide, { top: 5, left: 21, width: 76, height: 16 });
    assert.equal(wide.left + 1, 120 - (wide.left + 1 + wide.width), 'centered in the padded root');
    assert.ok(wide.top + wide.height <= 30 - 5, 'stays above the input row');
    assert.deepEqual(pickerPopupRect(80, 24), { top: 2, left: 3, width: 72, height: 16 });
    assert.deepEqual(pickerPopupRect(60, 18), { top: 1, left: 3, width: 52, height: 12 });
    assert.equal(pickerPopupRows(16), 10, 'the list fills the fixed frame');
    assert.equal(pickerPopupRows(12), 6);
    assert.equal(pickerPopupRows(8), 2);
    assert.equal(pickerPopupRows(16, 2), 8, 'hints and errors take list rows');
    assert.equal(pickerPopupRows(12, 3), 3);

    assert.deepEqual(pickerRange(0, 10, 30), {
      above: 0,
      below: 20,
      first: 1,
      last: 10,
      total: 30,
    });
    assert.equal(pickerRangeLabel(pickerRange(0, 10, 30)), '1-10 of 30 · ↓ 20 more');
    assert.equal(
      pickerRangeLabel(pickerRange(5, 15, 30)),
      '↑ 5 more · 6-15 of 30 · ↓ 15 more',
    );
    assert.equal(pickerRangeLabel(pickerRange(20, 30, 30)), '↑ 20 more · 21-30 of 30');
    assert.equal(pickerRangeLabel(pickerRange(0, 0, 0)), '0 of 0');

    const config: KiroConfig = {
      activeProfile: 'mock',
      profiles: {
        mock: {
          type: 'openai',
          baseUrl: 'http://127.0.0.1:9/v1',
          model: 'mock-model',
        },
      },
    };
    const rendered = renderToString(
      React.createElement(ModelPicker, {
        config,
        activeProfile: 'mock',
        width: 76,
        height: 16,
        onSelect: () => {},
        onRefresh: async () => ({ ok: true }),
        onCancel: () => {},
      }),
      { columns: 120 },
    ).trimEnd();
    const lines = rendered.split('\n');
    assert.equal(lines.length, 16, 'the dialog keeps a fixed frame');
    for (const line of lines) {
      assert.ok(displayWidth(line) <= 76, `popup line fits: ${line}`);
    }
    assert.match(rendered, /Model · 1 profile/);
    assert.match(rendered, /1-1 of 1/);
    assert.match(rendered, /Esc close/);

    const profiles: KiroConfig['profiles'] = {};
    for (let i = 1; i <= 15; i++) {
      profiles[`p${i}`] = {
        type: 'openai',
        baseUrl: 'http://localhost/v1',
        model: `model-${i}`,
      };
    }
    const many: KiroConfig = { activeProfile: 'p1', profiles };
    const rowsPage = profileRows(many);
    const window = pickerWindow(selectableLines(rowsPage)[0] ?? 0, rowsPage.length, 10);
    assert.equal(
      pickerRangeLabel(profileRange(rowsPage, window.start, window.end)),
      '1-9 of 15 · ↓ 6 more',
    );

    const crowded = renderToString(
      React.createElement(ModelPicker, {
        config: many,
        activeProfile: 'p1',
        width: 76,
        height: 16,
        onSelect: () => {},
        onRefresh: async () => ({ ok: true }),
        onCancel: () => {},
      }),
      { columns: 120 },
    ).trimEnd();
    assert.equal(crowded.split('\n').length, 16);
    assert.match(crowded, /1-9 of 15/);
    assert.match(crowded, /↓ 6 more/);
  });

  await test('the reported version matches package.json', async () => {
    const pkg = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    assert.equal(VERSION, pkg.version);
  });

  await test('middle truncation fits the budget and keeps both ends', async () => {
    const name = 'tokenharbor-ai-deepseek-v4-1-flash-free';
    assert.equal(truncateMiddle(name, 12), 'tokenh…-free');
    assert.equal(truncateMiddle(name, 34), 'tokenharbor-ai-de…-v4-1-flash-free');
    for (const width of [1, 2, 3, 5, 12, 34]) {
      assert.ok(displayWidth(truncateMiddle(name, width)) <= width);
    }
    assert.equal(truncateMiddle('short', 10), 'short');
  });

  await test('config saves are atomic, preserve unknown fields, and validate names and URLs', async () => {
    const dir = await tempDir('kiro-config-save-');
    const configFile = path.join(dir, 'config.json');
    const previousPath = process.env.KIRO_CONFIG_PATH;
    process.env.KIRO_CONFIG_PATH = configFile;
    try {
      await writeFile(
        configFile,
        JSON.stringify(
          {
            activeProfile: 'alpha',
            customTop: { nested: true },
            profiles: {
              alpha: {
                type: 'openai',
                baseUrl: 'https://api.example.com/v1/',
                model: 'model-one',
                temperature: 0.1,
                customProfileField: 'keep-me',
              },
            },
          },
          null,
          2,
        ),
      );
      const loaded = await loadConfig();
      assert.equal(loaded.config.profiles.alpha?.baseUrl, 'https://api.example.com/v1');
      assert.deepEqual(loaded.raw.customTop, { nested: true });

      const next: KiroConfig = {
        activeProfile: 'alpha',
        profiles: {
          ...loaded.config.profiles,
          beta: {
            type: 'openai',
            baseUrl: 'https://beta.example.com/v1/',
            apiKeyEnv: 'BETA_KEY',
            model: 'model-two',
            models: ['model-three', 'model-two', 'model-three'],
            temperature: 0.3,
            maxTokens: 2048,
            contextWindow: 64_000,
          },
        },
      };
      await saveConfig(next);
      const raw = JSON.parse(await readFile(configFile, 'utf8')) as {
        customTop?: unknown;
        profiles: Record<string, Record<string, unknown>>;
        activeProfile: string;
      };
      assert.deepEqual(raw.customTop, { nested: true });
      assert.equal(raw.profiles.alpha?.customProfileField, 'keep-me');
      assert.equal(raw.profiles.alpha?.baseUrl, 'https://api.example.com/v1');
      assert.equal(raw.profiles.alpha?.temperature, 0.1);
      assert.equal(raw.profiles.beta?.baseUrl, 'https://beta.example.com/v1');
      assert.equal(raw.profiles.beta?.contextWindow, 64_000);
      assert.deepEqual(raw.profiles.beta?.models, ['model-two', 'model-three']);
      assert.equal(raw.profiles.alpha?.models, undefined);
      assert.equal(raw.activeProfile, 'alpha');
      assert.equal(DEFAULT_CONTEXT_WINDOW, 128_000);
      assert.throws(
        () =>
          validateConfig({
            activeProfile: 'x',
            profiles: {
              x: { type: 'openai', baseUrl: 'http://x', model: 'm', contextWindow: 500 },
            },
          }),
        /contextWindow/,
      );
      await assertPrivateMode(configFile, 0o600);
      assert.ok(!(await readdir(dir)).some((entry) => entry.endsWith('.tmp')));

      assert.equal(validateProfileName('my-profile_2'), 'my-profile_2');
      assert.throws(() => validateProfileName('bad name'), /letters, digits/);
      assert.throws(() => validateProfileName(''), /empty/);
      assert.equal(suggestProfileName('OpenRouter', 'my/model', []), 'openrouter-my-model');
      assert.equal(
        suggestProfileName('OpenRouter', 'my/model', ['openrouter-my-model']),
        'openrouter-my-model-2',
      );
      assert.throws(() => normalizeBaseUrl('ftp://example.com'), /http/);

      const bad: KiroConfig = {
        activeProfile: 'bad name',
        profiles: { 'bad name': { type: 'openai', baseUrl: 'http://x', model: 'm' } },
      };
      await assert.rejects(saveConfig(bad), /Profile name/);

      await writeFile(configFile, '{oops');
      await assert.rejects(loadConfig(), /Invalid JSON/);
      const backup = await recoverConfig(configFile);
      assert.ok(backup && (await fileExists(backup)));
      assert.equal(await readFile(backup!, 'utf8'), '{oops');
      const recovered = await loadConfig();
      assert.equal(recovered.config.activeProfile, 'default');
    } finally {
      if (previousPath === undefined) delete process.env.KIRO_CONFIG_PATH;
      else process.env.KIRO_CONFIG_PATH = previousPath;
      await rm(dir, { recursive: true, force: true });
    }
  });

  await test('the profile list groups models by endpoint', () => {
    const config: KiroConfig = {
      activeProfile: 'kiosapi-deepseek',
      profiles: {
        'kiosapi-deepseek': {
          type: 'openai',
          baseUrl: 'https://kiosapi.com/v1',
          model: 'deepseek-v4.1-flash-free',
        },
        'kiosapi-qwen': {
          type: 'openai',
          baseUrl: 'https://kiosapi.com/v1',
          model: 'qwen3.8-flash-free',
        },
        harbor: {
          type: 'openai',
          baseUrl: 'https://tokenharbor.ai/v1',
          model: 'deepseek-v4.1-flash:free',
        },
      },
    };
    assert.deepEqual(formatProfileList(config), [
      'Profiles (3 profiles across 2 endpoints):',
      '  https://kiosapi.com/v1  [openai]',
      '  * kiosapi-deepseek  deepseek-v4.1-flash-free',
      '    kiosapi-qwen  qwen3.8-flash-free',
      '  https://tokenharbor.ai/v1  [openai]',
      '    harbor  deepseek-v4.1-flash:free',
    ]);
    assert.deepEqual(
      formatProfileList({
        activeProfile: 'solo',
        profiles: { solo: { type: 'openai', baseUrl: 'https://x/v1', model: 'm' } },
      }),
      ['Profiles (1):', '  https://x/v1  [openai]', '  * solo  m'],
    );
  });

  await test('the model picker groups profiles and switches stored models', () => {
    const config: KiroConfig = {
      activeProfile: 'kiosapi-deepseek',
      profiles: {
        'kiosapi-deepseek': {
          type: 'openai',
          baseUrl: 'https://kiosapi.com/v1',
          model: 'deepseek-v4.1-flash-free',
        },
        'kiosapi-qwen': {
          type: 'openai',
          baseUrl: 'https://kiosapi.com/v1',
          model: 'qwen3.8-flash-free',
        },
        harbor: {
          type: 'openai',
          baseUrl: 'https://tokenharbor.ai/v1',
          model: 'deepseek-v4.1-flash:free',
        },
      },
    };

    const rows = profileRows(config);
    assert.deepEqual(
      rows.map((row) => row.kind),
      ['header', 'profile', 'profile', 'header', 'profile'],
    );
    assert.deepEqual(selectableNames(rows), ['kiosapi-deepseek', 'kiosapi-qwen', 'harbor']);
    assert.deepEqual(selectableLines(rows), [1, 2, 4], 'headers are skipped when the cursor moves');

    const models = [
      'deepseek-v4.1-flash',
      'deepseek-r1',
      'qwen3.8-flash-free',
      'kimi-k2',
    ];
    assert.deepEqual(filterModelIds(models, 'deepseek'), ['deepseek-v4.1-flash', 'deepseek-r1']);
    assert.deepEqual(filterModelIds(models, 'DEEPSEEK flash'), ['deepseek-v4.1-flash']);
    assert.deepEqual(filterModelIds(models, 'deepseek  free'), []);
    assert.deepEqual(filterModelIds(models, '  '), models, 'blank search keeps everything');
    assert.deepEqual(filterModelIds(models, 'zzz'), []);
    assert.deepEqual(filterModelIds(models, 'kimi k2'), ['kimi-k2'], 'terms match in any order');
    assert.ok(
      profileRows(config, 'harbor').some(
        (row) => row.kind === 'profile' && row.name === 'harbor' && row.active,
      ),
      'the session profile is marked active, not necessarily the saved one',
    );

    assert.deepEqual(pickerWindow(0, 20, 8), { start: 0, end: 8 });
    assert.deepEqual(pickerWindow(10, 20, 8), { start: 6, end: 14 });
    assert.deepEqual(pickerWindow(19, 20, 8), { start: 12, end: 20 });
    assert.deepEqual(pickerWindow(1, 3, 8), { start: 0, end: 3 });
    assert.deepEqual(pickerWindow(0, 0, 8), { start: 0, end: 0 });

    assert.deepEqual(modelIds(config.profiles['kiosapi-deepseek']), ['deepseek-v4.1-flash-free']);
    const switched = withProfileModel(config, 'kiosapi-deepseek', 'qwen3.8-flash-free');
    assert.equal(switched.profiles['kiosapi-deepseek']?.model, 'qwen3.8-flash-free');
    assert.deepEqual(switched.profiles['kiosapi-deepseek']?.models, [
      'qwen3.8-flash-free',
      'deepseek-v4.1-flash-free',
    ]);
    assert.equal(
      config.profiles['kiosapi-deepseek']?.model,
      'deepseek-v4.1-flash-free',
      'the input config is not mutated',
    );

    const stored = withProfileModels(config, 'kiosapi-deepseek', [
      'qwen3.8-flash-free',
      'deepseek-v4.1-flash-free',
      'qwen3.8-flash-free',
    ]);
    assert.deepEqual(stored.profiles['kiosapi-deepseek']?.models, [
      'deepseek-v4.1-flash-free',
      'qwen3.8-flash-free',
    ]);
    assert.deepEqual(modelIds(stored.profiles['kiosapi-deepseek']), [
      'deepseek-v4.1-flash-free',
      'qwen3.8-flash-free',
    ]);
    assert.deepEqual(
      modelIds(withProfileModel(config, 'kiosapi-deepseek', 'x').profiles['kiosapi-deepseek']),
      ['x', 'deepseek-v4.1-flash-free'],
    );
    assert.equal(withProfileModel(config, 'missing', 'x'), config);
  });

  await test('profile model lists reject bad entries and keep the used model first', () => {
    const ok = validateConfig({
      activeProfile: 'a',
      profiles: {
        a: { type: 'openai', baseUrl: 'https://x/v1', model: 'm2', models: ['m1', 'm2', 'm2', 'm3'] },
      },
    });
    assert.deepEqual(ok.profiles.a?.models, ['m2', 'm1', 'm3']);
    const plain = validateConfig({
      activeProfile: 'b',
      profiles: { b: { type: 'openai', baseUrl: 'https://x/v1', model: 'm' } },
    });
    assert.equal(plain.profiles.b?.models, undefined, 'older configs stay valid');

    const bad = (models: unknown): unknown => ({
      activeProfile: 'a',
      profiles: { a: { type: 'openai', baseUrl: 'https://x/v1', model: 'm', models } },
    });
    assert.throws(() => validateConfig(bad('m')), /models/);
    assert.throws(() => validateConfig(bad(['m', 7])), /models/);
    assert.throws(() => validateConfig(bad([''])), /models/);
  });

  await test('.env parsing, real-environment precedence, and 0600 key writes', async () => {
    const dir = await tempDir('kiro-env-');
    const envFile = path.join(dir, '.env');
    const previousPath = process.env.KIRO_ENV_PATH;
    const names = ['KIRO_TEST_ENV_A', 'KIRO_TEST_ENV_B', 'KIRO_TEST_ENV_C'] as const;
    for (const name of names) delete process.env[name];
    process.env.KIRO_ENV_PATH = envFile;
    process.env.KIRO_TEST_ENV_B = 'real-value';
    try {
      const text = [
        '# comment stays',
        'export KIRO_TEST_ENV_A=one',
        'KIRO_TEST_ENV_B="two words"',
        'KIRO_TEST_ENV_C=three # trailing comment',
        'INVALID LINE',
      ].join('\n');
      await writeFile(envFile, `${text}\n`, { mode: 0o600 });
      assert.deepEqual(parseEnv(text), [
        { key: 'KIRO_TEST_ENV_A', value: 'one' },
        { key: 'KIRO_TEST_ENV_B', value: 'two words' },
        { key: 'KIRO_TEST_ENV_C', value: 'three' },
      ]);

      await loadEnvFile();
      assert.equal(process.env.KIRO_TEST_ENV_A, 'one');
      assert.equal(process.env.KIRO_TEST_ENV_B, 'real-value');
      assert.equal(process.env.KIRO_TEST_ENV_C, 'three');

      assert.equal(maskKey('sk-1234567890abcd'), 'sk-…abcd');
      assert.equal(maskKey('abc'), '••••');
      assert.equal(keyStatus({ type: 'openai', baseUrl: 'http://x', model: 'm', apiKeyEnv: names[0] }), 'set via $KIRO_TEST_ENV_A');
      assert.equal(keyStatus({ type: 'openai', baseUrl: 'http://x', model: 'm' }), 'no key');
      assert.equal(keyStatus({ type: 'openai', baseUrl: 'http://x', model: 'm', apiKeyEnv: 'KIRO_TEST_ENV_MISSING' }), 'missing ($KIRO_TEST_ENV_MISSING)');
      assert.equal(defaultKeyEnv('my-profile'), 'KIRO_MY_PROFILE_API_KEY');

      await writeEnvValue(names[0], 'updated-value');
      const saved = await readFile(envFile, 'utf8');
      assert.match(saved, /^# comment stays$/m);
      assert.match(saved, /KIRO_TEST_ENV_A=updated-value/);
      assert.match(saved, /KIRO_TEST_ENV_B="two words"/);
      assert.equal(process.env.KIRO_TEST_ENV_A, 'updated-value');
      await assertPrivateMode(envFile, 0o600);
    } finally {
      for (const name of names) delete process.env[name];
      if (previousPath === undefined) delete process.env.KIRO_ENV_PATH;
      else process.env.KIRO_ENV_PATH = previousPath;
      await rm(dir, { recursive: true, force: true });
    }
  });

  await test('model discovery and connection tests report success and precise failures', async () => {
    const mock = await createMockServer({
      models: ['mock-beta', 'mock-alpha'],
      turns: [{ type: 'text', text: 'OK' }],
    });
    const unauthorized = await createMockServer({ models: null, modelsStatus: 401 });
    const noModels = await createMockServer();
    const badChat = await createMockServer({
      turns: [{ type: 'http-error', status: 401, body: '{"error":{"message":"Incorrect API key"}}' }],
    });
    const hang = await createMockServer({ turns: [{ type: 'hang' }] });
    try {
      assert.equal(modelsEndpoint(`${mock.url}/chat/completions`), `${mock.url}/models`);
      const found = await discoverModels({ baseUrl: mock.url, apiKey: 'test-key' });
      assert.equal(found.ok, true);
      if (!found.ok) throw new Error(found.message);
      assert.deepEqual(found.models, ['mock-alpha', 'mock-beta']);
      assert.equal(mock.modelRequests[0]?.headers.authorization, 'Bearer test-key');

      const profile = {
        type: 'openai',
        baseUrl: mock.url,
        model: 'mock-alpha',
        temperature: 0,
        maxTokens: 32,
      };
      const ok = await testConnection(profile, 'test-key');
      assert.equal(ok.ok, true);
      assert.ok(ok.latencyMs >= 0);
      assert.match(ok.message, /Connection OK/);
      assert.equal(mock.requests[0]?.body.model, 'mock-alpha');
      assert.equal(mock.requests[0]?.headers.authorization, 'Bearer test-key');

      const denied = await discoverModels({ baseUrl: unauthorized.url });
      assert.equal(denied.ok, false);
      assert.equal(denied.status, 401);
      assert.match(denied.message, /API key|401/);

      const missing = await discoverModels({ baseUrl: noModels.url });
      assert.equal(missing.ok, false);
      assert.match(missing.message, /404/);
      assert.match(missing.message, /manually/);

      const bad = await testConnection({ ...profile, baseUrl: badChat.url }, 'wrong');
      assert.equal(bad.ok, false);
      assert.match(bad.message, /Authentication failed/);
      assert.match(bad.message, /401/);

      const slow = await testConnection({ ...profile, baseUrl: hang.url }, 'key', { timeoutMs: 150 });
      assert.equal(slow.ok, false);
      assert.match(slow.message, /timed out/);
    } finally {
      await Promise.all([
        mock.close(),
        unauthorized.close(),
        noModels.close(),
        badChat.close(),
        hang.close(),
      ]);
    }
  });

  await test('provider presets match the documented endpoints', async () => {
    assert.deepEqual(
      PRESETS.map((preset) => preset.baseUrl),
      [
        'https://openrouter.ai/api/v1',
        'https://api.openai.com/v1',
        'https://api.groq.com/openai/v1',
        'https://api.deepseek.com/v1',
        'https://api.together.xyz/v1',
        'http://localhost:11434/v1',
        'http://localhost:1234/v1',
      ],
    );
    assert.deepEqual(
      PRESETS.filter((preset) => preset.local).map((preset) => preset.id),
      ['ollama', 'lmstudio'],
    );
    assert.equal(PRESETS.find((preset) => preset.id === 'openrouter')?.apiKeyEnv, 'OPENROUTER_API_KEY');
  });

  await test('wizard adds, edits, activates, and removes profiles with masked keys', async () => {
    const dir = await tempDir('kiro-wizard-');
    const configFile = path.join(dir, 'config.json');
    const envFile = path.join(dir, '.env');
    const previousConfig = process.env.KIRO_CONFIG_PATH;
    const previousEnv = process.env.KIRO_ENV_PATH;
    process.env.KIRO_CONFIG_PATH = configFile;
    process.env.KIRO_ENV_PATH = envFile;
    delete process.env.KIRO_WIZARD_MODEL_API_KEY;
    try {
      let config = baseTestConfig();
      await saveConfig(config);
      const saves: KiroConfig[] = [];
      const save = async (next: KiroConfig): Promise<void> => {
        await saveConfig(next);
        config = next;
        saves.push(structuredClone(next));
      };
      const deps = {
        discoverModels: async () => ({
          ok: true as const,
          models: ['wizard-alpha', 'wizard-beta'],
          url: `${modelsEndpoint('http://mock/v1')}`,
        }),
        testConnection: async (profile: { model: string }) => ({
          ok: true,
          latencyMs: 3,
          message: `Connection OK in 3ms (model "${profile.model}").`,
        }),
      };
      const addUi = new ScriptedUi([
        '8',
        'http://127.0.0.1:9/v1',
        '',
        'sk-wizard-secret-1234',
        '1',
        'wizard-model',
        'n',
        'y',
      ]);
      const addCtx = { ui: addUi, config, save, deps };
      const added = await runAddFlow(addCtx);
      assert.equal(added, 'wizard-model');
      assert.equal(addCtx.config.profiles['wizard-model']?.model, 'wizard-alpha');
      assert.deepEqual(addCtx.config.profiles['wizard-model']?.models, ['wizard-alpha', 'wizard-beta']);
      assert.equal(addCtx.config.profiles['wizard-model']?.apiKeyEnv, 'KIRO_WIZARD_MODEL_API_KEY');
      assert.equal(addCtx.config.profiles['wizard-model']?.temperature, 0.2);
      assert.equal(addCtx.config.profiles['wizard-model']?.maxTokens, 4096);
      assert.equal(addCtx.config.activeProfile, 'wizard-model');
      assert.equal(process.env.KIRO_WIZARD_MODEL_API_KEY, 'sk-wizard-secret-1234');
      assert.match(await readFile(envFile, 'utf8'), /KIRO_WIZARD_MODEL_API_KEY=sk-wizard-secret-1234/);
      await assertPrivateMode(envFile, 0o600);
      assert.ok(!(await readFile(configFile, 'utf8')).includes('sk-wizard-secret'));

      const editUi = new ScriptedUi(['3', 'wizard-changed', '8', '64000', '9']);
      const editCtx = {
        ui: editUi,
        config: addCtx.config,
        save,
        deps: {
          testConnection: async (profile: { model: string }) => ({
            ok: true,
            latencyMs: 2,
            message: `Connection OK (${profile.model}).`,
          }),
        },
      };
      const edited = await runEditFlow(editCtx, 'wizard-model');
      assert.equal(edited, 'wizard-model');
      assert.equal(editCtx.config.profiles['wizard-model']?.model, 'wizard-changed');
      assert.equal(editCtx.config.profiles['wizard-model']?.apiKeyEnv, 'KIRO_WIZARD_MODEL_API_KEY');
      assert.equal(editCtx.config.profiles['wizard-model']?.contextWindow, 64_000);

      const selectCtx = { ui: new ScriptedUi([]), config: editCtx.config, save };
      await runSelectFlow(selectCtx, 'default');
      assert.equal(selectCtx.config.activeProfile, 'default');

      const removeUi = new ScriptedUi(['y']);
      const removeCtx = { ui: removeUi, config: selectCtx.config, save };
      const removed = await runRemoveFlow(removeCtx, 'wizard-model');
      assert.equal(removed, 'wizard-model');
      assert.equal(removeCtx.config.profiles['wizard-model'], undefined);
      assert.equal(removeCtx.config.activeProfile, 'default');

      const lastUi = new ScriptedUi([]);
      const lastCtx = { ui: lastUi, config: removeCtx.config, save };
      assert.equal(await runRemoveFlow(lastCtx, 'default'), null);
      assert.ok(lastUi.notes.some((note) => note.includes('only profile')));

      const beforeCancel = saves.length;
      const cancelUi = new ScriptedUi(['8', null]);
      const cancelCtx = { ui: cancelUi, config: lastCtx.config, save, deps };
      assert.equal(await runAddFlow(cancelCtx), null);
      assert.equal(saves.length, beforeCancel);

      const manualUi = new ScriptedUi([
        '8',
        'http://127.0.0.1:10/v1',
        '',
        '',
        'manual-model',
        'manual-profile',
        'n',
        'n',
      ]);
      const manualCtx = {
        ui: manualUi,
        config: lastCtx.config,
        save,
        deps: {
          discoverModels: async () => ({
            ok: false as const,
            models: [] as [],
            url: 'http://127.0.0.1:10/v1/models',
            message: 'Could not reach the endpoint.',
          }),
          testConnection: async () => ({ ok: true, latencyMs: 1, message: 'Connection OK' }),
        },
      };
      assert.equal(await runAddFlow(manualCtx), 'manual-profile');
      assert.equal(manualCtx.config.profiles['manual-profile']?.model, 'manual-model');
      assert.ok(manualUi.notes.some((note) => note.includes('Could not reach the endpoint')));
    } finally {
      delete process.env.KIRO_WIZARD_MODEL_API_KEY;
      if (previousConfig === undefined) delete process.env.KIRO_CONFIG_PATH;
      else process.env.KIRO_CONFIG_PATH = previousConfig;
      if (previousEnv === undefined) delete process.env.KIRO_ENV_PATH;
      else process.env.KIRO_ENV_PATH = previousEnv;
      await rm(dir, { recursive: true, force: true });
    }
  });

  await test('scripted kiro model commands save keys safely and fail cleanly', async () => {
    const mock = await createMockServer({
      models: ['model-a'],
      turns: [{ type: 'text', text: 'OK' }],
    });
    const badChat = await createMockServer({
      turns: [{ type: 'http-error', status: 401, body: '{"error":{"message":"Incorrect API key"}}' }],
    });
    const noModels = await createMockServer({ models: null });
    const dir = await tempDir('kiro-cli-');
    const configFile = path.join(dir, 'config.json');
    const envFile = path.join(dir, '.env');
    const env = {
      ...process.env,
      KIRO_CONFIG_PATH: configFile,
      KIRO_ENV_PATH: envFile,
      HOME: dir,
      EXISTING_KEY: 'existing-secret',
    };
    const run = (...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> =>
      new Promise((resolve, reject) => {
        // node --import tsx works on every platform; the .bin shim does not (Windows needs .cmd).
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', path.join('src', 'index.tsx'), ...args],
          { cwd: process.cwd(), env },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (status) => resolve({ status, stdout, stderr }));
      });
    try {
      const add = await run(
        'model',
        'add',
        '--name=mockcli',
        `--base-url=${mock.url}`,
        '--model=model-a',
        '--api-key=sk-cli-secret-1234',
        '--set-active',
      );
      assert.equal(add.status, 0, add.stderr);
      assert.match(add.stdout, /Saved profile "mockcli"/);
      assert.ok(!add.stdout.includes('sk-cli-secret-1234'));
      assert.ok(!add.stderr.includes('sk-cli-secret-1234'));
      const configText = await readFile(configFile, 'utf8');
      assert.ok(!configText.includes('sk-cli-secret'));
      const saved = JSON.parse(configText) as KiroConfig;
      assert.equal(saved.activeProfile, 'mockcli');
      assert.equal(saved.profiles.mockcli?.apiKeyEnv, 'KIRO_MOCKCLI_API_KEY');
      assert.match(await readFile(envFile, 'utf8'), /KIRO_MOCKCLI_API_KEY=sk-cli-secret-1234/);
      await assertPrivateMode(envFile, 0o600);

      const list = await run('model', 'list');
      assert.equal(list.status, 0, list.stderr);
      assert.match(list.stdout, /\* mockcli/);
      assert.match(list.stdout, /set via \$KIRO_MOCKCLI_API_KEY/);

      const use = await run('model', 'use', 'default');
      assert.equal(use.status, 0, use.stderr);
      assert.equal(
        (JSON.parse(await readFile(configFile, 'utf8')) as KiroConfig).activeProfile,
        'default',
      );

      const manual = await run(
        'model',
        'add',
        '--name=manual',
        `--base-url=${noModels.url}`,
        '--model=manual-model',
        '--api-key=k',
        '--no-test',
      );
      assert.equal(manual.status, 0, manual.stderr);

      const envRef = await run(
        'model',
        'add',
        '--name=envref',
        `--base-url=${mock.url}`,
        '--model=model-a',
        '--api-key-env=EXISTING_KEY',
        '--no-test',
      );
      assert.equal(envRef.status, 0, envRef.stderr);
      const envRefConfig = JSON.parse(await readFile(configFile, 'utf8')) as KiroConfig;
      assert.equal(envRefConfig.profiles.envref?.apiKeyEnv, 'EXISTING_KEY');
      assert.ok(!(await readFile(envFile, 'utf8')).includes('EXISTING_KEY='));

      const failed = await run(
        'model',
        'add',
        '--name=badkey',
        `--base-url=${badChat.url}`,
        '--model=model-a',
        '--api-key=wrong-key',
      );
      assert.notEqual(failed.status, 0);
      assert.match(failed.stderr, /Connection test failed/);
      assert.equal(
        (JSON.parse(await readFile(configFile, 'utf8')) as KiroConfig).profiles.badkey,
        undefined,
      );

      const badUrl = await run('model', 'add', '--name=bad', '--base-url=ftp://nope', '--model=x', '--no-test');
      assert.notEqual(badUrl.status, 0);
      assert.match(badUrl.stderr, /baseUrl/);

      const unknown = await run('model', 'add', '--nope');
      assert.equal(unknown.status, 2);
      assert.match(unknown.stderr, /Unknown option/);

      assert.equal((await run('model', 'remove', 'default')).status, 0);
      assert.equal((await run('model', 'remove', 'manual')).status, 0);
      assert.equal((await run('model', 'remove', 'mockcli')).status, 0);
      const last = await run('model', 'remove', 'envref');
      assert.notEqual(last.status, 0);
      assert.match(last.stderr, /only profile/);
    } finally {
      await Promise.all([mock.close(), badChat.close(), noModels.close()]);
      await rm(dir, { recursive: true, force: true });
    }
  });

  await test('registered API keys never reach run_command or tool output', async () => {
    const cwd = await tempDir();
    const controller = new AbortController();
    const ctx: ToolContext = { cwd, signal: controller.signal, approve: approvalSpy().fn };
    const secretName = 'KIRO_TEST_SECRET_KEY';
    const secretValue = 'sk-super-secret-value-1234';
    const plainName = 'KIRO_TEST_PLAIN_VAR';
    process.env[secretName] = secretValue;
    process.env[plainName] = 'an-ordinary-value';
    registerSecretEnv(secretName, secretValue, true);
    registerSecretEnv(plainName, process.env[plainName]);
    try {
      assert.equal(redactSecrets(`the key is ${secretValue} ok`), 'the key is [REDACTED] ok');
      assert.equal(redactSecrets('an-ordinary-value'), 'an-ordinary-value');
      assert.equal(childEnv()[secretName], undefined);
      assert.equal(childEnv()[plainName], 'an-ordinary-value');

      const result = await executeTool(
        'run_command',
        JSON.stringify({ command: 'node -e "console.log(JSON.stringify(process.env))"' }),
        ctx,
      );
      assert.equal(result.status, 'ok', result.content);
      assert.ok(!result.content.includes(secretValue), 'key value leaked into run_command output');
      assert.ok(!result.content.includes(secretName), 'key name leaked into run_command output');
      assert.match(result.content, /PATH|Path/, 'ordinary environment must survive');

      await writeFile(path.join(cwd, 'leak.txt'), `token=${secretValue}\n`);
      const read = await executeTool('read_file', JSON.stringify({ path: 'leak.txt' }), ctx);
      assert.equal(read.status, 'ok');
      assert.match(read.content, /\[REDACTED\]/);
      assert.ok(!read.content.includes(secretValue), 'key value leaked into read_file output');
      assert.ok(!read.summary.includes(secretValue));
    } finally {
      delete process.env[secretName];
      delete process.env[plainName];
      clearSecrets();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  await test('finish_reason=length warns that the response was truncated', async () => {
    const cwd = await tempDir();
    const text = await runScenario({
      cwd,
      turns: [{ type: 'text', text: 'This answer stops mid-sent', finishReason: 'length' }],
    });
    const tool = await runScenario({
      cwd,
      turns: [
        {
          type: 'tool-calls',
          calls: [{ name: 'write_file', arguments: '{"path":"a.txt","content":"unfinish' }],
          finishReason: 'length',
        },
        { type: 'text', text: 'Recovered.' },
      ],
    });
    try {
      assert.match(noticeText(text.events), /max_tokens/);
      assert.equal(text.done.reason, 'complete');

      const failed = toolEnds(tool.events)[0];
      assert.match(failed?.result.content ?? '', /Invalid JSON arguments/);
      assert.match(failed?.result.content ?? '', /max_tokens/);
      assert.match(noticeText(tool.events), /max_tokens/);
    } finally {
      await text.mock.close();
      await tool.mock.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  await test('a context overflow forces one compaction and retries the round', async () => {
    assert.equal(isOverflowMessage("This model's maximum context length is 8192 tokens"), true);
    assert.equal(isOverflowMessage('Input is too long for requested model.'), true);
    assert.equal(isOverflowMessage('Incorrect API key provided'), false);

    const controller = new AbortController();
    const ctx: ToolContext = {
      cwd: process.cwd(),
      signal: controller.signal,
      approve: approvalSpy().fn,
    };
    const overflowError = (): ProviderError =>
      new ProviderError(
        "Model endpoint returned HTTP 400: This model's maximum context length is 8192 tokens.",
        400,
        { overflow: true },
      );
    const buildMessages = (): ChatMessage[] => [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'an older question' },
      { role: 'assistant', content: 'an older answer' },
      { role: 'user', content: 'carry on' },
    ];

    let calls = 0;
    let forced = false;
    const recovering: Provider = {
      type: 'fake',
      model: 'fake',
      async *stream() {
        calls++;
        if (calls === 1) throw overflowError();
        yield { type: 'text', text: 'recovered' };
        yield { type: 'finish', reason: 'stop' };
      },
    };
    const messages = buildMessages();
    const events = await collect(
      runAgentTurn({
        provider: recovering,
        messages,
        ctx,
        compactContext: async (_messages, _signal, options) => {
          forced = options?.force === true;
          return {
            messages: [
              { role: 'system', content: 'sys' },
              { role: 'user', content: 'Earlier work summarized.\ncarry on' },
            ],
            summary: 'Earlier work summarized.',
            beforeTokens: 100,
            afterTokens: 20,
            summarizedMessages: 2,
          };
        },
      }),
    );
    assert.equal(forced, true, 'compaction must be forced past the threshold');
    assert.equal(calls, 2, 'the round must be retried once');
    assert.deepEqual(
      messages.slice(0, 2).map((message) => message.content),
      ['sys', 'Earlier work summarized.\ncarry on'],
      'the compacted history must replace the old messages',
    );
    assert.match(noticeText(events), /too long/);
    const done = events.find((event) => event.type === 'done');
    assert.equal(done?.type === 'done' ? done.reason : undefined, 'complete');

    const stuck: Provider = {
      type: 'fake',
      model: 'fake',
      async *stream() {
        throw overflowError();
      },
    };
    const stuckEvents = await collect(
      runAgentTurn({
        provider: stuck,
        messages: buildMessages(),
        ctx,
        compactContext: async () => null,
      }),
    );
    assert.match(noticeText(stuckEvents), /nothing left to summarize/);
    const stuckDone = stuckEvents.find((event) => event.type === 'done');
    assert.equal(stuckDone?.type === 'done' ? stuckDone.reason : undefined, 'error');
  });

  await test('context window comes from the profile, else the model id', async () => {
    assert.equal(inferContextWindow('gpt-4o-mini'), 128_000);
    assert.equal(inferContextWindow('gpt-4-turbo'), 128_000);
    assert.equal(inferContextWindow('gpt-4'), 8_000);
    assert.equal(inferContextWindow('gpt-3.5-turbo'), 16_000);
    assert.equal(inferContextWindow('claude-3-5-sonnet-20241022'), 200_000);
    assert.equal(inferContextWindow('gemini-1.5-pro'), 1_000_000);
    assert.equal(inferContextWindow('llama3:8b'), 8_000);
    assert.equal(inferContextWindow('llama-3.1-70b-instruct'), 128_000);
    assert.equal(inferContextWindow('qwen2.5-coder-32k-instruct'), 32_000);
    assert.equal(inferContextWindow('openai/o1-mini'), 200_000);
    assert.equal(inferContextWindow('totally-unknown-model'), undefined);

    const profile = { type: 'openai', baseUrl: 'http://x', model: 'gpt-4' };
    assert.equal(contextWindowFor({ ...profile, contextWindow: 40_000 }), 40_000);
    assert.equal(contextWindowFor(profile), 8_000);
    assert.equal(
      contextWindowFor({ type: 'openai', baseUrl: 'http://x', model: 'mystery' }),
      DEFAULT_CONTEXT_WINDOW,
    );
    assert.equal(contextWindowFor(undefined), DEFAULT_CONTEXT_WINDOW);
  });

  await test('transcript export keeps full tool output and arguments', async () => {
    const toolBody = 'line1\nline2\n'.repeat(50);
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: toolBody },
      { role: 'assistant', content: 'done' },
    ];
    const markdown = renderTranscriptMarkdown(messages.slice(1), {
      cwd: '/tmp/project',
      sessionId: 'abcdef1234567890',
      profile: 'default',
      model: 'mock-model',
      version: '0.1.0',
    });
    assert.match(markdown, /^# Kiro transcript/);
    assert.match(markdown, /- Session: abcdef1234567890/);
    assert.match(markdown, /## User\n\nhello/);
    assert.match(markdown, /### Tool call: read_file/);
    assert.match(markdown, /"path": "a\.txt"/);
    assert.match(markdown, /### Tool result: read_file/);
    assert.ok(markdown.includes(toolBody), 'full tool output must survive the export');
    assert.match(markdown, /## Kiro\n\ndone/);
    assert.ok(!markdown.includes('system prompt'));
    assert.match(defaultExportPath('abcdef1234567890'), /kiro-.*-abcdef12\.md$/);
    assert.doesNotMatch(defaultExportPath(undefined), /kiro-.*-[0-9a-f]{8}\.md$/);
  });

  await test('expanded tool output renders inline for copying', async () => {
    const items: ViewItem[] = [
      {
        kind: 'tool',
        id: 7,
        callId: 'c1',
        name: 'read_file',
        argsSummary: 'a.txt',
        status: 'ok',
        resultSummary: 'first line',
        resultFull: 'first line\nsecond line\nthird line',
      },
    ];
    const collapsed = buildLines(items, 80).map((line) => `${line.prefix}${line.text}`);
    assert.ok(!collapsed.some((line) => line.includes('second line')));
    assert.ok(collapsed.some((line) => line.includes('first line')));

    const expanded = buildLines(items, 80, 7).map((line) => `${line.prefix}${line.text}`);
    assert.ok(expanded.some((line) => line.includes('second line')));
    assert.ok(expanded.some((line) => line.includes('third line')));
    assert.ok(expanded.some((line) => line.includes('Ctrl+O to collapse')));
    assert.deepEqual(buildLines(items, 80, 8), buildLines(items, 80));
  });

  await test('reasoning models get max_completion_tokens and rejected max_tokens recovers', async () => {
    assert.equal(reasoningModel('o1'), true);
    assert.equal(reasoningModel('o3-mini'), true);
    assert.equal(reasoningModel('gpt-5.2'), true);
    assert.equal(reasoningModel('gpt-4o'), false);
    assert.equal(
      rejectsMaxTokens("Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead."),
      true,
    );
    assert.equal(rejectsMaxTokens('Incorrect API key provided'), false);

    const direct = await createMockServer({ turns: [{ type: 'text', text: 'ok' }] });
    const reasoningProvider = new OpenAIProvider(
      {
        type: 'openai',
        baseUrl: direct.url,
        model: 'o3-mini',
        apiKeyEnv: 'MOCK_KEY',
        temperature: 0.2,
        maxTokens: 512,
      },
      'test-key',
    );
    await collect(reasoningProvider.stream([{ role: 'user', content: 'hi' }], []));
    const directBody = direct.requests[0]?.body ?? {};
    assert.equal(directBody.max_completion_tokens, 512);
    assert.equal(directBody.max_tokens, undefined);
    assert.equal(directBody.temperature, undefined, 'o-series must keep the default temperature');
    await direct.close();

    const fallback = await createMockServer({
      turns: [
        {
          type: 'http-error',
          status: 400,
          body: JSON.stringify({
            error: {
              message:
                "Unsupported parameter: 'max_tokens' is not supported with this model. " +
                "Use 'max_completion_tokens' instead.",
            },
          }),
        },
        { type: 'text', text: 'recovered' },
      ],
    });
    try {
      const events = await collect(makeProvider(fallback.url).stream([{ role: 'user', content: 'hi' }], []));
      assert.equal(fallback.requests.length, 2);
      assert.equal(fallback.requests[0]?.body.max_tokens, 1024);
      assert.equal(fallback.requests[1]?.body.max_tokens, undefined);
      assert.equal(fallback.requests[1]?.body.max_completion_tokens, 1024);
      assert.equal(fallback.requests[1]?.body.temperature, undefined);
      assert.ok(
        events.some((event) => event.type === 'notice' && /max_completion_tokens/.test(event.message)),
      );
      assert.ok(
        events
          .filter((event) => event.type === 'text')
          .map((event) => event.text)
          .join('')
          .includes('recovered'),
      );
    } finally {
      await fallback.close();
    }
  });

  await test('reasoning traces stream through the agent and collapse once finished', async () => {
    const cwd = await tempDir();
    const scenario = await runScenario({
      cwd,
      turns: [{ type: 'text', reasoning: 'Weigh the options. ', text: 'Here is the answer.' }],
    });
    try {
      const reasoning = scenario.events
        .filter((event): event is Extract<AgentEvent, { type: 'reasoning' }> => event.type === 'reasoning')
        .map((event) => event.text)
        .join('');
      assert.equal(reasoning, 'Weigh the options. ');
      assert.ok(
        scenario.events
          .filter((event) => event.type === 'text')
          .map((event) => event.text)
          .join('')
          .includes('Here is the answer.'),
      );
      assert.equal(scenario.messages.at(-1)?.content, 'Here is the answer.');
    } finally {
      await scenario.mock.close();
      await rm(cwd, { recursive: true, force: true });
    }

    const live = buildLines(
      [{ kind: 'reasoning', id: 1, text: 'Weigh the options.', draft: true }],
      80,
    )
      .map((line) => `${line.prefix}${line.text}`)
      .join('\n');
    assert.match(live, /thinking…/);
    assert.match(live, /Weigh the options\./);

    const finished = buildLines(
      [{ kind: 'reasoning', id: 2, text: 'Weigh the options.', draft: false }],
      80,
    )
      .map((line) => `${line.prefix}${line.text}`)
      .join('\n');
    assert.match(finished, /reasoning \(done, not saved\)/);
    assert.ok(!finished.includes('Weigh the options.'), 'finished traces collapse out of the way');
  });

  await test('a stream that stalls without bytes times out', async () => {
    const mock = await createMockServer({ turns: [{ type: 'hang' }] });
    const previousIdle = process.env.KIRO_STREAM_IDLE_MS;
    const previousRetry = process.env.KIRO_RETRY_BASE_MS;
    process.env.KIRO_STREAM_IDLE_MS = '40';
    process.env.KIRO_RETRY_BASE_MS = '1';
    try {
      await assert.rejects(
        collect(makeProvider(mock.url).stream([{ role: 'user', content: 'hi' }], [])),
        /idle for more than|stalled without sending data/,
      );
    } finally {
      if (previousIdle === undefined) delete process.env.KIRO_STREAM_IDLE_MS;
      else process.env.KIRO_STREAM_IDLE_MS = previousIdle;
      if (previousRetry === undefined) delete process.env.KIRO_RETRY_BASE_MS;
      else process.env.KIRO_RETRY_BASE_MS = previousRetry;
      await mock.close();
    }
  });

  await test('checkpoints undo edits and creations without inlining file content', async () => {
    const cwd = await tempDir();
    const store = await tempDir('kiro-checkpoints-');
    const previous = process.env.KIRO_CHECKPOINTS_DIR;
    process.env.KIRO_CHECKPOINTS_DIR = store;
    try {
      const file = path.join(cwd, 'notes.txt');
      await writeFile(file, 'old content\n');
      await snapshotBeforeMutation(cwd, 'write_file', [file]);
      await writeFile(file, 'new content\n');

      const created = path.join(cwd, 'created.txt');
      await snapshotBeforeMutation(cwd, 'write_file', [created]);
      await writeFile(created, 'fresh\n');

      const projectKey = (await readdir(store))[0]!;
      const manifestPath = path.join(store, projectKey, 'manifest.json');
      const manifestText = await readFile(manifestPath, 'utf8');
      assert.ok(
        !manifestText.includes('old content'),
        'the manifest should reference backups instead of inlining file content',
      );
      const manifest = JSON.parse(manifestText) as {
        entries: { files: { backup: string | null }[] }[];
      };
      assert.equal(manifest.entries.length, 2);
      assert.ok(manifest.entries[0]!.files[0]!.backup, 'an existing file gets a backup');
      assert.equal(manifest.entries[1]!.files[0]!.backup, null, 'a created file has no backup');

      const undoCreated = await undoLastCheckpoint(cwd);
      assert.equal(undoCreated?.tool, 'write_file');
      assert.deepEqual(undoCreated?.deleted, [created]);
      assert.equal(await fileExists(created), false);

      const undoEdit = await undoLastCheckpoint(cwd);
      assert.deepEqual(undoEdit?.restored, [file]);
      assert.equal(await readFile(file, 'utf8'), 'old content\n');

      assert.equal(await undoLastCheckpoint(cwd), null, 'undo steps back until it runs out');
    } finally {
      if (previous === undefined) delete process.env.KIRO_CHECKPOINTS_DIR;
      else process.env.KIRO_CHECKPOINTS_DIR = previous;
      await rm(cwd, { recursive: true, force: true });
      await rm(store, { recursive: true, force: true });
    }
  });

  await test('prompt history dedupes, stays bounded, and redacts registered keys', async () => {
    const cwd = await tempDir();
    const store = await tempDir('kiro-history-');
    const previous = process.env.KIRO_HISTORY_DIR;
    process.env.KIRO_HISTORY_DIR = store;
    const secretName = 'KIRO_HISTORY_TEST_KEY';
    const secretValue = 'sk-history-secret-9876';
    process.env[secretName] = secretValue;
    registerSecretEnv(secretName, secretValue, true);
    try {
      assert.deepEqual(rememberPrompt([], 'first'), ['first']);
      assert.deepEqual(rememberPrompt(['first'], 'first'), ['first']);
      assert.deepEqual(rememberPrompt(['first', 'second'], 'first'), ['second', 'first']);
      assert.deepEqual(rememberPrompt(['keep'], '  spaced  '), ['keep', 'spaced']);

      const many = Array.from({ length: 210 }, (_, index) => `prompt ${index}`);
      const capped = rememberPrompt(many, 'latest');
      assert.equal(capped.length, 200);
      assert.equal(capped[0], 'prompt 11');
      assert.equal(capped.at(-1), 'latest');

      await recordPrompt(cwd, `use ${secretValue} carefully`);
      await recordPrompt(cwd, 'second prompt');
      await recordPrompt(cwd, 'use [REDACTED] carefully');
      const history = await loadPromptHistory(cwd);
      assert.deepEqual(history, ['second prompt', 'use [REDACTED] carefully']);

      const files = await readdir(store);
      assert.equal(files.length, 1);
      const stored = await readFile(path.join(store, files[0]!), 'utf8');
      assert.ok(!stored.includes(secretValue), 'key material must never reach prompt history');
      await assertPrivateMode(path.join(store, files[0]!), 0o600);
    } finally {
      delete process.env[secretName];
      clearSecrets();
      if (previous === undefined) delete process.env.KIRO_HISTORY_DIR;
      else process.env.KIRO_HISTORY_DIR = previous;
      await rm(cwd, { recursive: true, force: true });
      await rm(store, { recursive: true, force: true });
    }
  });

  await test('headless -p runs tools, streams text, and accepts piped prompts', async () => {
    const mock = await createMockServer({
      turns: [
        {
          type: 'tool-calls',
          calls: [
            {
              name: 'write_file',
              arguments: { path: 'headless.txt', content: 'from headless\n' },
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 5 },
        },
        {
          type: 'text',
          text: 'All done.',
          usage: { prompt_tokens: 60, completion_tokens: 7 },
        },
      ],
    });
    const dir = await tempDir('kiro-headless-');
    const project = path.join(dir, 'project');
    await mkdir(project);
    const configFile = path.join(dir, 'config.json');
    const envFile = path.join(dir, '.env');
    await writeFile(
      configFile,
      JSON.stringify({
        activeProfile: 'mock',
        profiles: {
          mock: {
            type: 'openai',
            baseUrl: mock.url,
            model: 'mock-model',
            apiKeyEnv: 'KIRO_HEADLESS_KEY',
            temperature: 0,
            maxTokens: 1024,
          },
        },
      }),
    );
    await writeFile(envFile, 'KIRO_HEADLESS_KEY=test-key\n');
    const env = {
      ...process.env,
      KIRO_CONFIG_PATH: configFile,
      KIRO_ENV_PATH: envFile,
      KIRO_SESSIONS_DIR: path.join(dir, 'sessions'),
      KIRO_CHECKPOINTS_DIR: path.join(dir, 'checkpoints'),
      KIRO_HISTORY_DIR: path.join(dir, 'history'),
      KIRO_STREAM_IDLE_MS: '5000',
      HOME: dir,
    };
    const cliPath = path.join(process.cwd(), 'src', 'index.tsx');
    const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const runCli = (
      args: string[],
      input?: string,
    ): Promise<{ status: number | null; stdout: string; stderr: string }> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [tsxCli, cliPath, ...args], {
          cwd: project,
          env,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (status) => resolve({ status, stdout, stderr }));
        if (input !== undefined) child.stdin.end(input);
      });
    try {
      const first = await runCli(['-p', 'Create the file.', '--yolo']);
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stdout, /All done\./);
      assert.ok(first.stdout.endsWith('\n'), 'headless output ends with a newline');
      assert.match(first.stderr, /write_file/);
      assert.equal(await readFile(path.join(project, 'headless.txt'), 'utf8'), 'from headless\n');
      const saved = await readdir(env.KIRO_SESSIONS_DIR, { recursive: true });
      const sessionFile = saved.find((entry) => entry.endsWith('.json'));
      assert.ok(sessionFile, 'headless runs persist a session like the TUI');
      const savedRecord = JSON.parse(
        await readFile(path.join(env.KIRO_SESSIONS_DIR, sessionFile), 'utf8'),
      );
      assert.equal(savedRecord.title, 'Create the file.');
      assert.deepEqual(savedRecord.usage, {
        promptTokens: 110,
        completionTokens: 12,
        requests: 2,
      });

      const piped = await runCli(['-p', '-', '--yolo'], 'Say hello.');
      assert.equal(piped.status, 0, piped.stderr);
      assert.match(piped.stdout, /All done\./);

      const noTty = await runCli([]);
      assert.equal(noTty.status, 2);
      assert.match(noTty.stderr, /interactive terminal/);
      assert.match(noTty.stderr, /-p/);
    } finally {
      await mock.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  await test('assistant replies show elapsed time and throughput once finalized', async () => {
    const render = (item: ViewItem): string =>
      buildLines([item], 80)
        .map(
          (line) =>
            `${line.prefix}${
              line.segments ? line.segments.map((segment) => segment.text).join('') : line.text
            }`,
        )
        .join('\n');

    const timed = render({
      kind: 'assistant',
      id: 1,
      text: 'Done.',
      durationMs: 8_420,
      tokensPerSecond: 23,
    });
    assert.match(timed, /Done\./);
    assert.match(timed, /· 8\.4s · 23 tok\/s/);

    const short = render({ kind: 'assistant', id: 2, text: 'Quick.', durationMs: 420 });
    assert.match(short, /· 420ms/);
    assert.doesNotMatch(short, /tok\/s/);

    const draft = render({
      kind: 'assistant',
      id: 3,
      text: 'Still streaming',
      draft: true,
      durationMs: 5_000,
    });
    assert.doesNotMatch(draft, /5\.0s|tok\/s/, 'timing waits until the reply is final');

    const resumed = render({ kind: 'assistant', id: 4, text: 'From a saved session' });
    assert.doesNotMatch(resumed, /tok\/s|· \d/);
  });

  await test('the slash palette overlays the transcript without changing its height', async () => {
    const base = Array.from({ length: 10 }, (_, index) => ({
      prefix: '',
      text: `line ${index}`,
    }));
    const palette = {
      kind: 'commands' as const,
      commands: [
        { name: '/help', description: 'show commands and keys' },
        { name: '/model', usage: '<name>', description: 'switch profile' },
      ],
      activeIndex: 1,
    };
    const flatten = (line: { text: string; segments?: { text: string }[] }): string =>
      line.segments ? line.segments.map((segment) => segment.text).join('') : line.text;

    const overlayed = applyPalette(base, palette, 80, 10);
    assert.equal(overlayed.length, 10, 'the viewport height is unchanged');
    assert.equal(overlayed[0]?.text, 'line 0');
    assert.equal(overlayed[2]?.text, 'line 2');
    assert.match(overlayed[3]?.text ?? '', /commands ·/);
    assert.match(flatten(overlayed[4]!), /\/help/);
    const active = overlayed[5]!;
    assert.match(flatten(active), /\/model <name>/);
    assert.equal(active.prefix, '› ');
    assert.equal(active.inverse, true, 'the highlighted command is inverted');

    assert.deepEqual(applyPalette(base, null, 80, 10), base, 'no palette means no overlay');
    assert.equal(applyPalette(base, palette, 80, 3).length, 3, 'tiny terminals clamp the overlay');

    const files = {
      kind: 'files' as const,
      files: ['src/ui/App.tsx', 'src/ui/mention.ts'],
      activeIndex: 0,
      header: 'files 1-2 of 2 · ↑/↓ move · Tab/Enter insert · Esc close',
    };
    const fileOverlay = applyPalette(base, files, 80, 10);
    assert.match(fileOverlay[3]?.text ?? '', /files 1-2 of 2/);
    assert.equal(flatten(fileOverlay[4]!), 'src/ui/App.tsx');
    assert.equal(fileOverlay[4]?.inverse, true, 'the highlighted file is inverted');
    assert.equal(
      buildPaletteLines({ commands: [], activeIndex: 0 }, 80).length,
      7,
      'header plus six fixed rows keep the covered area stable while filtering',
    );
  });

  await test('the model wizard redraws one screen instead of piling up history', async () => {
    const frames: string[] = [];
    const out: ScreenStream = {
      columns: 60,
      rows: 12,
      write(text: string) {
        frames.push(text);
        return true;
      },
    };
    const screen = new WizardScreen(out);
    assert.match(frames[0] ?? '', /\x1b\[\?1049h/, 'the wizard should take the alternate screen');

    screen.note(
      'info',
      [
        'Choose a provider',
        '  1. OpenRouter · https://openrouter.ai/api/v1',
        '  2. Custom endpoint · enter a base URL',
        '',
        'Enter a number.',
      ].join('\n'),
    );
    screen.setPrompt('Choose: ', '');
    screen.finishPrompt('Choose: ', '2', false);
    screen.note('muted', 'Fetching models…');
    screen.note('info', ['Available models:', '  1. deepseek-v4', '', 'Enter a number.'].join('\n'));

    const last = frames[frames.length - 1] ?? '';
    assert.ok(last.includes('Available models:'), 'the current step must stay visible');
    assert.ok(!last.includes('1. OpenRouter'), 'the answered menu must be cleared');
    assert.ok(last.includes('Custom endpoint'), 'the breadcrumb must name the chosen item');

    screen.note('info', 'Saved profile "kiosapi".');
    screen.note(
      'info',
      ['Model workflow', '  1. Select the active model', '  5. Quit', '', 'Enter a number.'].join(
        '\n',
      ),
    );
    const afterMenu = frames[frames.length - 1] ?? '';
    assert.ok(afterMenu.includes('Model workflow'), 'the new menu replaces the old one');
    assert.ok(afterMenu.includes('Saved profile'), 'a one-line confirmation survives the redraw');

    const tall = composeFrame(
      {
        trail: ['Choose: Custom endpoint'],
        log: Array.from({ length: 40 }, (_, index) => ({
          tone: 'muted' as const,
          text: `line ${index}`,
        })),
        prompt: 'Model: ',
      },
      60,
      12,
    );
    assert.equal(tall.length, 12, 'the frame must fit the terminal');
    assert.equal(tall[tall.length - 1], 'Model: ', 'the prompt must never scroll off');
    assert.ok(tall.some((line) => line.includes('line 39')));
    assert.ok(!tall.some((line) => line.includes('line 0')), 'the oldest log lines are dropped');

    screen.note('info', 'Saved profile "kiosapi".');
    frames.length = 0;
    screen.close();
    const closed = frames.join('');
    assert.match(closed, /\x1b\[\?1049l/, 'the alternate screen must be left');
    assert.match(closed, /Saved profile "kiosapi"\./, 'results are replayed on the normal screen');
    assert.ok(!closed.includes('Fetching models'), 'transient progress stays off the normal screen');
  });

  await test('a long model list scrolls instead of hiding its first entries', async () => {
    const frames: string[] = [];
    const out: ScreenStream = {
      columns: 60,
      rows: 10,
      write(text: string) {
        frames.push(text);
        return true;
      },
    };
    const screen = new WizardScreen(out);
    screen.note(
      'info',
      [
        'Available models:',
        ...Array.from({ length: 40 }, (_, index) => `  ${index + 1}. model-${index}`),
        '',
        'Enter a number.',
      ].join('\n'),
    );
    screen.setPrompt('Model: ', '');

    const atBottom = frames[frames.length - 1] ?? '';
    assert.ok(atBottom.includes('. model-39'), 'the newest entries are visible first');
    assert.ok(!atBottom.includes('. model-0'), 'the oldest entries are trimmed');
    assert.match(atBottom, /more above/, 'the user must be told the list continues upward');
    assert.ok(!atBottom.includes('more below'));

    screen.scrollBy(screen.pageSize());
    const middle = frames[frames.length - 1] ?? '';
    assert.ok(!middle.includes('. model-39'), 'scrolling up hides the newest lines');
    assert.match(middle, /more above/);
    assert.match(middle, /more below/);

    screen.scrollTo('top');
    const atTop = frames[frames.length - 1] ?? '';
    assert.ok(atTop.includes('. model-0'), 'Home reaches the first entry');
    assert.ok(!atTop.includes('more above'), 'nothing is above the first line');
    assert.match(atTop, /more below/);

    screen.scrollTo('bottom');
    assert.ok((frames[frames.length - 1] ?? '').includes('. model-39'));

    screen.scrollTo('top');
    screen.note('muted', 'Fetching models…');
    assert.ok(
      (frames[frames.length - 1] ?? '').includes('Fetching models'),
      'a new message jumps back to the newest line',
    );

    const clamped = composeFrame(
      {
        trail: [],
        log: [{ tone: 'info' as const, text: Array.from({ length: 30 }, (_, i) => `row ${i}`).join('\n') }],
        prompt: 'Model: ',
        scroll: 9999,
      },
      60,
      10,
    );
    assert.ok(clamped.some((line) => line.includes('row 0')), 'an oversized scroll clamps to the top');
    assert.equal(clamped[clamped.length - 1], 'Model: ');
    screen.close();
  });

  await test('the wizard breadcrumb names the menu and the kept default', async () => {
    const frames: string[] = [];
    const out: ScreenStream = {
      columns: 200,
      rows: 24,
      write(text: string) {
        frames.push(text);
        return true;
      },
    };
    const screen = new WizardScreen(out);
    const last = (): string => frames[frames.length - 1] ?? '';

    screen.note(
      'info',
      ['Edit fields', '  1. Model (gpt-4)', '  9. Done editing', '', 'Enter a number.'].join('\n'),
    );
    screen.finishPrompt('Choose: ', '1', false);
    assert.match(last(), /Edit fields: Model \(gpt-4\)/, 'the menu title labels the answer');
    assert.ok(!last().includes('Choose:'), 'the generic label never reaches the breadcrumb');

    screen.finishPrompt('Model id [gpt-4]: ', '', false);
    assert.match(last(), /Model id: gpt-4/, 'Enter shows the value that was kept');
    assert.ok(!last().includes('(default)'), 'an empty answer is not reported as "(default)"');

    screen.finishPrompt('Test the connection now? [Y/n]: ', '', false);
    assert.match(last(), /Test the connection now\?: yes/, 'a confirm default reads as yes/no');

    screen.finishPrompt('Base URL [https://x/v1]: ', null, false);
    assert.ok(!last().includes('Model id: gpt-4'), 'cancelling clears the breadcrumb');

    screen.note('error', 'A value is required.');
    screen.note('muted', 'Cancelled; nothing was saved.');
    screen.note('info', 'Saved profile "x".');
    screen.note(
      'info',
      ['Choose a provider', '  1. Custom endpoint', '', 'Enter a number.'].join('\n'),
    );
    assert.ok(!last().includes('A value is required'), 'stale errors do not follow the user');
    assert.ok(!last().includes('Cancelled'), 'stale cancellations are cleared');
    assert.ok(last().includes('Saved profile'), 'the confirmation survives the step change');

    screen.finishPrompt('Choose: ', '1', false);
    assert.match(last(), /Choose a provider: Custom endpoint/, 'the menu title labels the answer');

    screen.note(
      'info',
      ['Model workflow', '  1. Select the active model', '  5. Quit', '', 'Enter a number.'].join(
        '\n',
      ),
    );
    assert.ok(!last().includes('Choose a provider'), 'the root menu starts a fresh breadcrumb');
    screen.close();
  });

  await test('skill files parse simple and quoted frontmatter', () => {
    const parsed = parseSkillFile(
      [
        '---',
        'name: anti-slop',
        'description: "Remove AI-slop patterns',
        '  from prose."',
        '---',
        '',
        'Follow these rules.',
        '',
      ].join('\n'),
    );
    assert.ok(parsed.ok);
    if (parsed.ok) {
      assert.equal(parsed.value.name, 'anti-slop');
      assert.equal(parsed.value.description, 'Remove AI-slop patterns from prose.');
      assert.equal(parsed.value.body, 'Follow these rules.');
    }

    const crlf = parseSkillFile('---\r\nname: crlf\r\ndescription: works\r\n---\r\ntext\r\n');
    assert.ok(crlf.ok);
    assert.equal(crlf.ok ? crlf.value.body : '', 'text');

    const noFrontmatter = parseSkillFile('# Just markdown\n');
    assert.equal(noFrontmatter.ok, false);
    assert.match(noFrontmatter.ok ? '' : noFrontmatter.reason, /missing frontmatter/);

    const noDescription = parseSkillFile('---\nname: quiet\n---\ntext\n');
    assert.equal(noDescription.ok, false);
    assert.match(noDescription.ok ? '' : noDescription.reason, /missing a description/);

    const emptyBody = parseSkillFile('---\nname: hollow\ndescription: nothing\n---\n\n');
    assert.equal(emptyBody.ok, false);
    assert.match(emptyBody.ok ? '' : emptyBody.reason, /no instructions/);
  });

  await test('skills load from .kiro and .claude roots with project precedence', async () => {
    const cwd = await tempDir('kiro-skills-cwd-');
    const userRoot = await tempDir('kiro-skills-user-');
    const previous = process.env.KIRO_SKILLS_DIR;
    process.env.KIRO_SKILLS_DIR = userRoot;
    const skill = (name: string, description: string, body: string): string =>
      `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
    try {
      await mkdir(path.join(cwd, '.kiro', 'skills', 'anti-slop'), { recursive: true });
      await mkdir(path.join(cwd, '.claude', 'skills', 'compat'), { recursive: true });
      await mkdir(path.join(cwd, '.kiro', 'skills', 'broken'), { recursive: true });
      await mkdir(path.join(userRoot, 'global'), { recursive: true });
      await writeFile(
        path.join(cwd, '.kiro', 'skills', 'anti-slop', 'SKILL.md'),
        skill('anti-slop', 'Remove AI slop from prose.', 'Project body.'),
      );
      await writeFile(
        path.join(cwd, '.claude', 'skills', 'compat', 'SKILL.md'),
        skill('compat', 'Loaded from the Claude folder.', 'Claude body.'),
      );
      await writeFile(
        path.join(userRoot, 'global', 'SKILL.md'),
        skill('global', 'A user-level skill.', 'User body.'),
      );
      await writeFile(
        path.join(cwd, '.kiro', 'skills', 'broken', 'SKILL.md'),
        '---\nname: broken\n---\nno description\n',
      );

      const inventory = await loadSkills(cwd);
      assert.deepEqual(
        inventory.skills.map((entry) => entry.name),
        ['anti-slop', 'compat', 'global'],
      );
      assert.deepEqual(
        inventory.skills.map((entry) => entry.source),
        ['project', 'project', 'user'],
      );
      assert.equal(inventory.skills[0]?.description, 'Remove AI slop from prose.');
      assert.equal(inventory.invalid.length, 1);
      assert.match(inventory.invalid[0]?.reason ?? '', /missing a description/);
      assert.equal(inventory.roots.length, 3);

      await mkdir(path.join(cwd, '.claude', 'skills', 'anti-slop'), { recursive: true });
      await writeFile(
        path.join(cwd, '.claude', 'skills', 'anti-slop', 'SKILL.md'),
        skill('anti-slop', 'Shadowed copy.', 'Claude copy.'),
      );
      const shadowed = await loadSkills(cwd);
      assert.equal(
        shadowed.skills.find((entry) => entry.name === 'anti-slop')?.description,
        'Remove AI slop from prose.',
        'the .kiro copy wins',
      );
      assert.ok(shadowed.invalid.some((entry) => /duplicate name/.test(entry.reason)));
    } finally {
      if (previous === undefined) delete process.env.KIRO_SKILLS_DIR;
      else process.env.KIRO_SKILLS_DIR = previous;
      await rm(cwd, { recursive: true, force: true });
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  await test('the system prompt lists skill metadata but not the instructions', async () => {
    const cwd = await tempDir('kiro-skills-prompt-');
    const userRoot = await tempDir('kiro-skills-prompt-user-');
    const previous = process.env.KIRO_SKILLS_DIR;
    process.env.KIRO_SKILLS_DIR = userRoot;
    try {
      await mkdir(path.join(cwd, '.kiro', 'skills', 'anti-slop'), { recursive: true });
      await writeFile(
        path.join(cwd, '.kiro', 'skills', 'anti-slop', 'SKILL.md'),
        '---\nname: anti-slop\ndescription: Remove AI-slop patterns from prose.\n---\n\nBODY_MARKER_ONLY.\n',
      );
      const prompt = await buildSystemPrompt(cwd);
      assert.match(prompt, /# Skills/);
      assert.match(prompt, /- anti-slop: Remove AI-slop patterns from prose\./);
      assert.match(prompt, /read_skill/);
      assert.doesNotMatch(prompt, /BODY_MARKER_ONLY/, 'the body loads on demand');

      await rm(path.join(cwd, '.kiro', 'skills'), { recursive: true, force: true });
      const bare = await buildSystemPrompt(cwd);
      assert.doesNotMatch(bare, /# Skills/);
    } finally {
      if (previous === undefined) delete process.env.KIRO_SKILLS_DIR;
      else process.env.KIRO_SKILLS_DIR = previous;
      await rm(cwd, { recursive: true, force: true });
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  await test('read_skill is read-only and loads instructions by name', async () => {
    const cwd = await tempDir('kiro-skills-tool-');
    const userRoot = await tempDir('kiro-skills-tool-user-');
    const previous = process.env.KIRO_SKILLS_DIR;
    process.env.KIRO_SKILLS_DIR = userRoot;
    try {
      await mkdir(path.join(cwd, '.kiro', 'skills', 'anti-slop'), { recursive: true });
      await writeFile(
        path.join(cwd, '.kiro', 'skills', 'anti-slop', 'SKILL.md'),
        '---\nname: anti-slop\ndescription: Remove AI slop.\n---\n\nDelete every "delve".\n',
      );
      const ctx: ToolContext = { cwd, signal: new AbortController().signal, approve: async () => 'deny' };
      assert.equal(isReadOnlyTool('read_skill'), true);
      const loaded = await executeTool('read_skill', JSON.stringify({ name: 'Anti-Slop' }), ctx);
      assert.equal(loaded.status, 'ok');
      assert.match(loaded.content, /# Skill: anti-slop/);
      assert.match(loaded.content, /Delete every "delve"\./);
      assert.match(loaded.content, /\[project skill · directory: .*anti-slop\./);

      const unknown = await executeTool('read_skill', JSON.stringify({ name: 'nope' }), ctx);
      assert.equal(unknown.status, 'error');
      assert.match(unknown.content, /Unknown skill "nope"/);
      assert.match(unknown.content, /Available skills: anti-slop/);

      await rm(path.join(cwd, '.kiro', 'skills'), { recursive: true, force: true });
      const empty = await executeTool('read_skill', JSON.stringify({ name: 'anti-slop' }), ctx);
      assert.equal(empty.status, 'error');
      assert.match(empty.content, /No skills are installed/);
    } finally {
      if (previous === undefined) delete process.env.KIRO_SKILLS_DIR;
      else process.env.KIRO_SKILLS_DIR = previous;
      await rm(cwd, { recursive: true, force: true });
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  await test('the skill list groups sources and explains skipped entries', async () => {
    const cwd = await tempDir('kiro-skills-list-');
    const userRoot = await tempDir('kiro-skills-list-user-');
    const previous = process.env.KIRO_SKILLS_DIR;
    process.env.KIRO_SKILLS_DIR = userRoot;
    try {
      await mkdir(path.join(cwd, '.kiro', 'skills', 'anti-slop'), { recursive: true });
      await mkdir(path.join(userRoot, 'global'), { recursive: true });
      await mkdir(path.join(cwd, '.kiro', 'skills', 'broken'), { recursive: true });
      await writeFile(
        path.join(cwd, '.kiro', 'skills', 'anti-slop', 'SKILL.md'),
        '---\nname: anti-slop\ndescription: Remove AI slop.\n---\n\ntext\n',
      );
      await writeFile(
        path.join(userRoot, 'global', 'SKILL.md'),
        '---\nname: global\ndescription: A user skill.\n---\n\ntext\n',
      );
      await writeFile(path.join(cwd, '.kiro', 'skills', 'broken', 'SKILL.md'), '---\nname: broken\n---\n');

      const inventory = await loadSkills(cwd);
      const text = formatSkillList(inventory, cwd);
      assert.match(text, /Installed skills \(1 project, 1 user\):/);
      assert.match(text, /\[project\].*\.kiro\/skills\/anti-slop/);
      assert.match(text, /\[user\]/);
      assert.match(text, /Skipped 1 entry:/);
      assert.match(text, /broken: frontmatter is missing a description/);

      const emptyText = formatSkillList(
        { skills: [], invalid: [], roots: [userRoot], disabled: false },
        cwd,
      );
      assert.match(emptyText, /No skills installed\./);
      assert.match(emptyText, /Add one at \.kiro\/skills\/<name>\/SKILL\.md/);
    } finally {
      if (previous === undefined) delete process.env.KIRO_SKILLS_DIR;
      else process.env.KIRO_SKILLS_DIR = previous;
      await rm(cwd, { recursive: true, force: true });
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  await test('skills are found through symlinks and one nested level', async () => {
    const cwd = await tempDir('kiro-skills-walk-');
    const external = await tempDir('kiro-skills-external-');
    const userRoot = await tempDir('kiro-skills-walk-user-');
    const previous = process.env.KIRO_SKILLS_DIR;
    process.env.KIRO_SKILLS_DIR = userRoot;
    try {
      await mkdir(path.join(external, 'deep-rule'), { recursive: true });
      await writeFile(
        path.join(external, 'deep-rule', 'SKILL.md'),
        '---\nname: deep-rule\ndescription: Reached through a symlink.\n---\n\nSymlink body.\n',
      );
      await mkdir(path.join(cwd, '.kiro', 'skills', 'group', 'nested'), { recursive: true });
      await writeFile(
        path.join(cwd, '.kiro', 'skills', 'group', 'nested', 'SKILL.md'),
        '---\ndescription: Two levels deep.\n---\n\nNested body.\n',
      );
      await mkdir(path.join(cwd, '.kiro', 'skills', 'empty'), { recursive: true });
      await writeFile(path.join(cwd, '.kiro', 'skills', 'SKILL.md'), '---\nname: loose\ndescription: wrong place\n---\nbody\n');
      await symlink(path.join(external, 'deep-rule'), path.join(cwd, '.kiro', 'skills', 'linked'));
      await symlink(path.join(cwd, '.kiro', 'skills'), path.join(cwd, '.kiro', 'skills', 'loop'));

      const inventory = await loadSkills(cwd);
      const names = inventory.skills.map((skill) => skill.name);
      assert.ok(names.includes('deep-rule'), 'symlinked skill folder is loaded');
      assert.ok(names.includes('nested'), 'a skill one level deeper is found');
      assert.equal(
        inventory.skills.find((skill) => skill.name === 'nested')?.dir,
        path.join(cwd, '.kiro', 'skills', 'group', 'nested'),
      );
      const skipped = inventory.invalid.map((entry) => entry.reason).join(' | ');
      assert.match(skipped, /no SKILL.md in this folder/, 'empty folders are reported');
      assert.match(skipped, /must sit in its own folder/, 'a stray SKILL.md is reported');
      assert.ok(!names.includes('loose'), 'the stray SKILL.md is not treated as a skill');
    } finally {
      if (previous === undefined) delete process.env.KIRO_SKILLS_DIR;
      else process.env.KIRO_SKILLS_DIR = previous;
      await rm(cwd, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  await test('the skill index lists every name and shrinks before overflowing', () => {
    const make = (count: number, description: string): Skill[] =>
      Array.from({ length: count }, (_, index) => ({
        name: `skill-${index}`,
        description,
        body: 'body',
        dir: `/tmp/skill-${index}`,
        file: `/tmp/skill-${index}/SKILL.md`,
        source: 'project' as const,
      }));

    const few = formatSkillIndex(make(4, 'A short description.'));
    assert.match(few, /- skill-0: A short description\./);

    const many = formatSkillIndex(make(40, 'A description that is definitely longer than the short form limit.'));
    for (let index = 0; index < 40; index++) assert.ok(many.includes(`- skill-${index}:`), `skill-${index} listed`);
    const longest = Math.max(...many.split('\n').filter((line) => line.startsWith('- ')).map((line) => line.length));
    assert.ok(longest <= 14 + MAX_SKILL_SHORT_DESCRIPTION_CHARS + 1, `descriptions were clipped (${longest})`);

    const enormous = formatSkillIndex(make(2000, 'x'.repeat(400)));
    const lines = enormous.split('\n').filter((line) => line.startsWith('- '));
    assert.ok(enormous.length <= MAX_SKILLS_INDEX_CHARS + 60, `index stayed bounded (${enormous.length})`);
    assert.ok(lines.length < 2000, 'names were truncated as the last resort');
    assert.match(enormous, /\(\+\d+ more skills; run \/skills to list all\.\)/);
  });

  await test('the skill invocation message carries the user request', () => {
    const skill: Skill = {
      name: 'anti-slop',
      description: 'Remove AI slop.',
      body: 'Delete "delve".',
      dir: '/tmp/anti-slop',
      file: '/tmp/anti-slop/SKILL.md',
      source: 'project',
    };
    const bare = skillInvocationMessage(skill);
    assert.match(bare, /apply them to what I ask next/);
    assert.match(bare, /Delete "delve"\./);

    const asked = skillInvocationMessage(skill, 'rewrite this   paragraph');
    assert.match(asked, /Use the "anti-slop" skill for this request\./);
    assert.match(asked, /Request: rewrite this   paragraph/);

    const huge = skillInvocationMessage({ ...skill, body: 'y'.repeat(60_000) });
    assert.match(huge, /\[Skill truncated; the rest is in \/tmp\/anti-slop\/SKILL\.md\]/);
  });

  await test('--no-skills keeps Kiro from reading skill folders', async () => {
    const cwd = await tempDir('kiro-skills-off-');
    const userRoot = await tempDir('kiro-skills-off-user-');
    const previous = process.env.KIRO_SKILLS_DIR;
    process.env.KIRO_SKILLS_DIR = userRoot;
    try {
      await mkdir(path.join(cwd, '.kiro', 'skills', 'anti-slop'), { recursive: true });
      await writeFile(
        path.join(cwd, '.kiro', 'skills', 'anti-slop', 'SKILL.md'),
        '---\nname: anti-slop\ndescription: Remove AI slop.\n---\n\nOFF_BODY_MARK.\n',
      );
      const on = await loadSkills(cwd);
      assert.equal(on.skills.length, 1);

      setSkillsEnabled(false);
      const off = await loadSkills(cwd);
      assert.equal(off.disabled, true);
      assert.equal(off.skills.length, 0);
      assert.match(formatSkillList(off, cwd), /Skills are disabled for this run/);
      assert.doesNotMatch(await buildSystemPrompt(cwd), /# Skills/);

      const ctx: ToolContext = { cwd, signal: new AbortController().signal, approve: async () => 'deny' };
      const blocked = await executeTool('read_skill', JSON.stringify({ name: 'anti-slop' }), ctx);
      assert.equal(blocked.status, 'error');
      assert.match(blocked.content, /Skills are disabled for this run/);
      assert.doesNotMatch(blocked.content, /OFF_BODY_MARK/);
    } finally {
      setSkillsEnabled(true);
      if (previous === undefined) delete process.env.KIRO_SKILLS_DIR;
      else process.env.KIRO_SKILLS_DIR = previous;
      await rm(cwd, { recursive: true, force: true });
      await rm(userRoot, { recursive: true, force: true });
    }
  });

  await test('skills become slash commands and built-in names win', () => {
    const skill = (name: string, description = 'Remove AI slop from prose.'): Skill => ({
      name,
      description,
      body: 'body',
      dir: `/tmp/${name}`,
      file: `/tmp/${name}/SKILL.md`,
      source: 'project',
    });
    const commands = buildSkillCommands([
      skill('anti-slop'),
      skill('Model'),
      skill('long-one', 'A description that is definitely longer than sixty characters so it must be clipped here.'),
      skill('anti-slop', 'duplicate folder'),
    ]);
    assert.deepEqual(
      commands.map((command) => command.name),
      ['/anti-slop', '/long-one'],
      'built-in clashes and duplicates are dropped',
    );
    assert.equal(commands[0]?.description, 'skill · Remove AI slop from prose.');
    assert.ok((commands[1]?.description ?? '').length <= 'skill · '.length + 60, 'description clipped');
    assert.ok(builtinCommandNames().includes('model'));

    const menu = [...SLASH_COMMANDS, ...commands];
    assert.deepEqual(filterSlashCommands('/an', menu).map((command) => command.name), ['/anti-slop']);
    assert.deepEqual(filterSlashCommands('/AN', menu).map((command) => command.name), ['/anti-slop']);
    assert.deepEqual(filterSlashCommands('/mo', menu).map((command) => command.name), ['/model', '/mouse']);
    assert.deepEqual(filterSlashCommands('/model add', menu), [], 'arguments still close the menu');
    assert.deepEqual(filterSlashCommands('/'), SLASH_COMMANDS, 'default menu is unchanged');

    assert.doesNotMatch(slashHelpLines().join('\n'), /<skill>/);
    const help = slashHelpLines(2).join('\n');
    assert.match(help, /\/<skill> \[request\].*2 installed skills/);

    const text = formatSkillList(
      {
        skills: [skill('anti-slop'), skill('model')],
        invalid: [],
        roots: ['/tmp'],
        disabled: false,
      },
      '/tmp',
      builtinCommandNames(),
    );
    assert.match(text, /\/model is a built-in, use \/skill model/);
    assert.ok(!text.includes('/anti-slop is a built-in'));
  });

  await test('doctor reports config, key, and endpoint problems', async () => {
    const dir = await tempDir('kiro-doctor-');
    const mock = await createMockServer({
      models: ['test-model'],
      turns: [{ type: 'text', text: 'OK' }],
    });
    const project = path.join(dir, 'project');
    await mkdir(project, { recursive: true });
    const configFile = path.join(dir, 'config.json');
    const envFile = path.join(dir, '.env');
    const writeConfig = (model = 'test-model'): Promise<void> =>
      writeFile(
        configFile,
        JSON.stringify({
          activeProfile: 'test',
          profiles: {
            test: {
              type: 'openai',
              baseUrl: `${mock.url}/v1`,
              apiKeyEnv: 'DOCTOR_KEY',
              model,
            },
          },
        }),
      );
    await writeConfig();
    await writeFile(envFile, 'DOCTOR_KEY=sk-doctor-secret-1234\n', { mode: 0o600 });

    const env = { ...process.env, KIRO_CONFIG_PATH: configFile, KIRO_ENV_PATH: envFile, HOME: dir };
    delete env.DOCTOR_KEY;
    const cliPath = path.join(process.cwd(), 'src', 'index.tsx');
    const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const run = (args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [tsxCli, cliPath, ...args], { cwd: project, env });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (status) => resolve({ status, stdout, stderr }));
      });

    try {
      const healthy = await run(['doctor']);
      assert.equal(healthy.status, 0, healthy.stderr);
      assert.match(healthy.stdout, /ok\s+Config/);
      assert.match(healthy.stdout, /GET .*\/models returned 1 model/);
      assert.ok(!healthy.stdout.includes('sk-doctor-secret-1234'), 'doctor never prints the key');

      const tested = await run(['doctor', '--test']);
      assert.equal(tested.status, 0, tested.stderr);
      assert.match(tested.stdout, /Connection OK/);

      await writeConfig('other-model');
      const mismatch = await run(['doctor']);
      assert.equal(mismatch.status, 0, mismatch.stderr);
      assert.match(mismatch.stdout, /not in the endpoint's list/);

      await writeFile(envFile, 'OTHER=1\n', { mode: 0o600 });
      const missing = await run(['doctor', '--offline']);
      assert.equal(missing.status, 1);
      assert.match(missing.stdout, /missing \(\$DOCTOR_KEY\)/);

      await writeFile(configFile, '{ not json');
      const broken = await run(['doctor', '--offline']);
      assert.equal(broken.status, 1);
      assert.match(broken.stdout, /invalid/);

      const usage = await run(['doctor', '--nope']);
      assert.equal(usage.status, 2);
    } finally {
      await mock.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  console.log('');
  if (failures > 0) {
    console.error(`${failures} test(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('All tests passed');
  }
}

await main();
// Let any lingering sockets settle before exit.
await sleep(10);
