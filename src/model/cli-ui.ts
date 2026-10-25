import wrapAnsi from 'wrap-ansi';
import type { ModelWizardUi, TextPrompt, WizardTone } from './wizard.js';

export class ModelCliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'ModelCliError';
    this.exitCode = exitCode;
  }
}

const ENTER_ALT_SCREEN = '\x1b[?1049h';
const LEAVE_ALT_SCREEN = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_SCREEN = '\x1b[H\x1b[2J';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

const TITLE = 'Kiro · model setup';
const MAX_TRAIL_ITEMS = 4;
const MAX_TRAIL_VALUE = 48;
const MAX_RESULTS = 8;
const FALLBACK_WIDTH = 80;
const FALLBACK_ROWS = 24;

export interface ScreenStream {
  write(text: string): unknown;
  columns?: number;
  rows?: number;
}

interface LogEntry {
  tone: WizardTone;
  text: string;
}

export interface FrameState {
  /** Answered prompts, shown as a breadcrumb so the user knows where they are. */
  trail: string[];
  log: LogEntry[];
  prompt: string | null;
  /** Lines hidden below the visible window; 0 shows the newest lines. */
  scroll?: number;
}

function promptText(options: TextPrompt): string {
  const fallback = options.defaultValue
    ? ` [${options.mask ? 'set' : options.defaultValue}]`
    : '';
  return `${options.label}${fallback}: `;
}

function promptLabel(prompt: string): string {
  return prompt.replace(/\s*\[[^\]]*\]:\s*$/, '').replace(/:\s*$/, '').trim();
}

/** The value shown in brackets, e.g. "gpt-4" from "Model id [gpt-4]: ". */
function promptDefault(prompt: string): string | null {
  const match = /\s*\[([^\]]*)\]:\s*$/.exec(prompt);
  const value = match?.[1]?.trim();
  return value ? value : null;
}

/** "Y/n" and "y/N" are the only bracketed confirm defaults the CLI emits. */
function confirmDefault(prompt: string): string | null {
  const fallback = promptDefault(prompt);
  if (!fallback || !/^[YN]\/[YN]$/i.test(fallback)) return null;
  return /^Y/i.test(fallback) ? 'yes' : 'no';
}

function wrap(text: string, width: number): string[] {
  if (text === '') return [''];
  return wrapAnsi(text, Math.max(10, width), { hard: true, trim: false }).split('\n');
}

function style(tone: WizardTone, line: string): string {
  if (tone === 'error') return `${RED}${line}${RESET}`;
  if (tone === 'muted') return `${DIM}${line}${RESET}`;
  return line;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_TRAIL_VALUE ? `${flat.slice(0, MAX_TRAIL_VALUE - 1)}…` : flat;
}

const MENU_ITEM = /^\s*(\d+)\.\s+(.+?)\s*$/gm;

/** Prompts that only say "Choose" or "Model"; the menu title is more useful. */
const GENERIC_LABELS = new Set(['Choose', 'Model']);

/** Back at the root menu the previous run's answers no longer describe anything. */
const ROOT_MENU_TITLE = 'Model workflow';

/** CSI and application-cursor sequences: arrows, PgUp/PgDn, Home, End. */
const CURSOR_SEQUENCE = /\x1b(?:\[(\d*~|[A-Za-z])|O([AB]))/g;

const SCROLL_KEYS: Record<string, (screen: WizardScreen) => void> = {
  A: (screen) => screen.scrollBy(1),
  B: (screen) => screen.scrollBy(-1),
  '5~': (screen) => screen.scrollBy(screen.pageSize()),
  '6~': (screen) => screen.scrollBy(-screen.pageSize()),
  H: (screen) => screen.scrollTo('top'),
  '1~': (screen) => screen.scrollTo('top'),
  F: (screen) => screen.scrollTo('bottom'),
  '4~': (screen) => screen.scrollTo('bottom'),
};

interface FrameLayout {
  head: string[];
  log: string[];
  promptLines: string[];
  budget: number;
  trimmed: boolean;
}

function layout(state: FrameState, width: number, rows: number): FrameLayout {
  const trail = state.trail.slice(-MAX_TRAIL_ITEMS).join('  ·  ');
  const head = [
    `${DIM}${TITLE}${RESET}`,
    ...(trail ? wrap(`${DIM}${trail}${RESET}`, width) : []),
    '',
  ];
  const promptLines = state.prompt === null ? [] : wrap(state.prompt, width);
  const log = state.log.flatMap((entry) =>
    wrap(entry.text, width).map((line) => style(entry.tone, line)),
  );
  const fullBudget = Math.max(1, rows - head.length - promptLines.length);
  const trimmed = log.length > fullBudget;
  return {
    head,
    log,
    promptLines,
    trimmed,
    budget: trimmed ? Math.max(1, fullBudget - 1) : fullBudget,
  };
}

/** How far the log window can move up from the newest line. */
export function scrollLimit(state: FrameState, width: number, rows: number): number {
  const { log, budget } = layout(state, width, rows);
  return Math.max(0, log.length - budget);
}

/**
 * Builds one screenful: title, breadcrumb, a window over the current step's log,
 * and the prompt. The window is `state.scroll` lines above the newest line, so a
 * long model list stays reachable without the prompt ever scrolling off.
 */
export function composeFrame(state: FrameState, width: number, rows: number): string[] {
  const { head, log, promptLines, budget, trimmed } = layout(state, width, rows);
  const scroll = Math.min(Math.max(0, state.scroll ?? 0), Math.max(0, log.length - budget));
  const end = log.length - scroll;
  const start = Math.max(0, end - budget);
  const indicator = trimmed
    ? [`${DIM}${scrollIndicator(start, log.length - end)}${RESET}`]
    : [];
  const frame = [...head, ...log.slice(start, end), ...indicator, ...promptLines];
  return frame.length > rows ? frame.slice(frame.length - rows) : frame;
}

/** Tells the user the list continues in both directions and how to move through it. */
function scrollIndicator(above: number, below: number): string {
  const parts: string[] = [];
  if (above > 0) parts.push(`${above} more above`);
  if (below > 0) parts.push(`${below} more below`);
  return `${parts.join(' · ')}  (↑/↓, PgUp/PgDn, Home/End)`;
}

/**
 * Draws the wizard on the alternate screen and redraws it in place, so answered
 * steps never pile up into a long scrollback.
 */
export class WizardScreen {
  private trail: string[] = [];
  private log: LogEntry[] = [];
  private prompt: string | null = null;
  private results: string[] = [];
  private menuItems = new Map<string, string>();
  private menuTitle: string | null = null;
  private closed = false;
  private scroll = 0;

  constructor(private readonly out: ScreenStream) {
    out.write(ENTER_ALT_SCREEN);
    this.render();
  }

  note(tone: WizardTone, text: string): void {
    if (this.closed) return;
    if (text.includes('\n')) {
      // A multi-line block is a whole step (menu, model list): replace the previous
      // block, drop stale errors and progress lines, and keep the last few
      // confirmations so the user still sees what was saved.
      this.log = this.log
        .filter((entry) => !entry.text.includes('\n') && entry.tone === 'info')
        .slice(-2);
      this.menuItems = parseMenuItems(text);
      this.menuTitle = text.split('\n')[0]?.trim() || null;
      if (this.menuTitle === ROOT_MENU_TITLE) this.trail = [];
    }
    this.log.push({ tone, text });
    if (tone === 'info' && !text.includes('\n')) {
      this.results.push(text);
      if (this.results.length > MAX_RESULTS) this.results.shift();
    }
    this.scroll = 0;
    this.render();
  }

  setPrompt(prompt: string, shown: string): void {
    if (this.closed) return;
    this.prompt = `${prompt}${shown}`;
    this.render();
  }

  /** Commits an answered prompt to the breadcrumb; `null` means it was cancelled. */
  finishPrompt(prompt: string, value: string | null, masked: boolean): void {
    if (this.closed) return;
    const menuTitle = this.menuTitle;
    this.prompt = null;
    this.menuTitle = null;
    if (value === null) {
      // Esc/Ctrl+C abandons the flow, so the old breadcrumb no longer applies.
      this.trail = [];
    } else {
      const entry = this.trailEntry(prompt, value, masked, menuTitle);
      if (entry) this.trail.push(entry);
    }
    this.scroll = 0;
    this.render();
  }

  /** The menu title is friendlier than the generic "Choose" label. */
  private trailEntry(
    prompt: string,
    value: string,
    masked: boolean,
    menuTitle: string | null,
  ): string | null {
    const label = promptLabel(prompt);
    const generic = GENERIC_LABELS.has(label);
    const shown = this.describeAnswer(prompt, value, masked, generic);
    if (!label || !shown) return null;
    return `${clip(generic && menuTitle ? menuTitle : label).slice(0, 32)}: ${clip(shown)}`;
  }

  private describeAnswer(
    prompt: string,
    value: string,
    masked: boolean,
    generic: boolean,
  ): string {
    const typed = value.trim();
    if (masked) {
      if (!typed) return promptDefault(prompt) ? 'kept' : 'unchanged';
      return typed === '-' ? 'removed' : 'set';
    }
    if (typed) return generic ? this.describeChoice(typed) : typed;
    // An empty answer takes the bracketed default, so show that instead of "(default)".
    return confirmDefault(prompt) ?? promptDefault(prompt) ?? '';
  }

  /** Moves the log window; positive shows older lines, negative newer ones. */
  scrollBy(lines: number): void {
    if (this.closed) return;
    const limit = scrollLimit(this.state(), this.width(), this.rows());
    this.scroll = Math.min(limit, Math.max(0, this.scroll + lines));
    this.render();
  }

  scrollTo(edge: 'top' | 'bottom'): void {
    if (this.closed) return;
    this.scroll =
      edge === 'bottom' ? 0 : scrollLimit(this.state(), this.width(), this.rows());
    this.render();
  }

  /** Lines moved by PgUp/PgDn: the window height minus head, indicator, prompt. */
  pageSize(): number {
    return Math.max(1, this.rows() - 6);
  }

  private state(): FrameState {
    return { trail: this.trail, log: this.log, prompt: this.prompt, scroll: this.scroll };
  }

  private width(): number {
    return this.out.columns ?? FALLBACK_WIDTH;
  }

  private rows(): number {
    return this.out.rows ?? FALLBACK_ROWS;
  }

  render(): void {
    if (this.closed) return;
    const frame = composeFrame(this.state(), this.width(), this.rows());
    this.out.write(`${HIDE_CURSOR}${CLEAR_SCREEN}${frame.join('\n')}${SHOW_CURSOR}`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.prompt = null;
    const summary = this.results;
    this.results = [];
    this.out.write(`${SHOW_CURSOR}${LEAVE_ALT_SCREEN}`);
    if (summary.length > 0) this.out.write(`${summary.join('\n')}\n`);
  }

  /** Turns "2" into the menu item it pointed at, so the breadcrumb stays readable. */
  private describeChoice(value: string): string {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return this.menuItems.get(trimmed) ?? trimmed;
    return trimmed;
  }
}

function parseMenuItems(text: string): Map<string, string> {
  const items = new Map<string, string>();
  for (const match of text.matchAll(MENU_ITEM)) {
    const [, index, label] = match;
    if (index && label) items.set(index, label);
  }
  return items;
}

let sharedScreen: WizardScreen | null = null;

function renderShared(): void {
  sharedScreen?.render();
}

/** Restores the normal screen if the process is killed between prompts. */
function onSignal(signal: NodeJS.Signals): void {
  closeModelUi();
  process.kill(process.pid, signal);
}

/** The wizard owns the whole screen, so every CLI UI shares one instance. */
function wizardScreen(): WizardScreen | null {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  if (!sharedScreen) {
    sharedScreen = new WizardScreen(process.stdout);
    process.stdout.on('resize', renderShared);
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }
  return sharedScreen;
}

/** Leaves the alternate screen and prints the result lines on the normal screen. */
export function closeModelUi(): void {
  process.stdout.off('resize', renderShared);
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  sharedScreen?.close();
  sharedScreen = null;
}

/**
 * A minimal raw-mode line reader. It supports Backspace, Ctrl+U/W, Enter,
 * Ctrl+C, and a single Esc to cancel, and masks input when requested.
 */
export async function readLine(
  prompt: string,
  options: { mask?: boolean; screen?: WizardScreen | null } = {},
): Promise<string | null> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new ModelCliError(
      'The interactive model setup needs a terminal. Use scripted flags instead, for example:\n' +
        '  kiro model add --name <name> --base-url <url> --model <id> --api-key-env <VAR>',
      2,
    );
  }

  const screen = options.screen ?? null;
  let value = '';
  const mask = options.mask ?? false;
  const render = (): void => {
    const shown = mask ? '*'.repeat(Array.from(value).length) : value;
    if (screen) screen.setPrompt(prompt, shown);
    else stdout.write(`\r\x1b[2K${prompt}${shown}`);
  };

  if (screen) render();
  else stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (result: string | null): void => {
      if (settled) return;
      settled = true;
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      if (screen) screen.finishPrompt(prompt, result, mask);
      else stdout.write('\n');
      resolve(result);
    };

    const eraseLast = (): void => {
      const chars = Array.from(value);
      if (chars.length === 0) return;
      chars.pop();
      value = chars.join('');
      render();
    };

    const eraseWord = (): void => {
      let chars = Array.from(value);
      while (chars.length && /\s/.test(chars[chars.length - 1]!)) chars.pop();
      while (chars.length && !/\s/.test(chars[chars.length - 1]!)) chars.pop();
      value = chars.join('');
      render();
    };

    const onData = (chunk: string | Buffer): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (text === '\x1b') {
        finish(null);
        return;
      }
      if (text === '\x03') {
        if (!screen) stdout.write('^C');
        finish(null);
        return;
      }
      if (text === '\x04') {
        finish(null);
        return;
      }
      if (text === '\r' || text === '\n') {
        finish(value);
        return;
      }
      if (text === '\x7f' || text === '\x08') {
        eraseLast();
        return;
      }
      if (text === '\x15') {
        value = '';
        render();
        return;
      }
      if (text === '\x17') {
        eraseWord();
        return;
      }
      if (text.startsWith('\x1b')) {
        // Cursor/PgUp/PgDn/Home/End scroll the log window; everything else is ignored.
        if (screen) {
          for (const match of text.matchAll(CURSOR_SEQUENCE)) {
            SCROLL_KEYS[match[1] ?? match[2] ?? '']?.(screen);
          }
        }
        return;
      }
      let inserted = '';
      for (const char of text) {
        const code = char.codePointAt(0) ?? 0;
        if (code < 32 || code === 127) continue;
        inserted += char;
      }
      if (!inserted) return;
      value += inserted;
      render();
    };

    stdin.on('data', onData);
  });
}

export class CliModelUi implements ModelWizardUi {
  private readonly screen = wizardScreen();

  note(tone: WizardTone, text: string): void {
    if (this.screen) {
      this.screen.note(tone, text);
      return;
    }
    const stream = tone === 'error' ? process.stderr : process.stdout;
    stream.write(`${text}\n`);
  }

  async text(options: TextPrompt): Promise<string | null> {
    if (options.hint) this.note('muted', options.hint);
    return readLine(promptText(options), { mask: options.mask, screen: this.screen });
  }

  async confirm(label: string, defaultValue: boolean): Promise<boolean | null> {
    for (;;) {
      const answer = await readLine(`${label} [${defaultValue ? 'Y/n' : 'y/N'}]: `, {
        screen: this.screen,
      });
      if (answer === null) return null;
      const value = answer.trim().toLowerCase();
      if (!value) return defaultValue;
      if (value === 'y' || value === 'yes') return true;
      if (value === 'n' || value === 'no') return false;
      this.note('error', 'Please answer y or n.');
    }
  }
}
