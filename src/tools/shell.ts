import { spawn, type ChildProcess } from 'node:child_process';
import { childEnv } from '../secrets.js';
import type { ApprovalRequest, Tool } from './types.js';
import { denied, ok, toolError } from './types.js';
import { truncateMiddle } from './diff.js';

const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 600;
const MAX_OUTPUT_CHARS = 20_000;
const CAPTURE_LIMIT = 80_000;

class OutputCapture {
  private head = '';
  private tail = '';
  total = 0;

  add(chunk: string): void {
    this.total += chunk.length;
    if (this.head.length < CAPTURE_LIMIT) {
      this.head += chunk;
      return;
    }
    this.tail = (this.tail + chunk).slice(-CAPTURE_LIMIT);
  }

  render(): string {
    if (this.total <= this.head.length + this.tail.length) return this.head + this.tail;
    return `${this.head}\n… [streaming output omitted] …\n${this.tail}`;
  }
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.killed) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    }).on('error', () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // process already gone
    }
  }
}

function timeoutArg(input: Record<string, unknown>): number {
  const value = input.timeout_seconds;
  if (value === undefined || value === null) return DEFAULT_TIMEOUT_SECONDS;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error('Argument "timeout_seconds" must be an integer.');
  }
  if (value < 1 || value > MAX_TIMEOUT_SECONDS) {
    throw new Error(`Argument "timeout_seconds" must be between 1 and ${MAX_TIMEOUT_SECONDS}.`);
  }
  return value;
}

export const runCommandTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a shell command in the working directory. Returns exit code and combined stdout/stderr. Long output is truncated. Requires user approval.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute.' },
          timeout_seconds: {
            type: 'integer',
            description: `Timeout in seconds (1-${MAX_TIMEOUT_SECONDS}). Default ${DEFAULT_TIMEOUT_SECONDS}.`,
          },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },

  async run(input, ctx) {
    const command = input.command;
    if (typeof command !== 'string' || !command.trim()) {
      throw new Error('Argument "command" must be a non-empty string.');
    }
    const timeoutSeconds = timeoutArg(input);

    const request: ApprovalRequest = {
      tool: 'run_command',
      title: 'Run command',
      detail: `$ ${command}`,
    };
    if (ctx.signal.aborted) return denied('Cancelled by user.');
    const decision = await ctx.approve(request);
    if (decision === 'deny') return denied();
    if (ctx.signal.aborted) return denied('Cancelled by user.');

    return new Promise((resolve) => {
      const stdout = new OutputCapture();
      const stderr = new OutputCapture();
      let settled = false;
      let timedOut = false;
      let cancelled = false;
      let child: ChildProcess | undefined;
      let timer: NodeJS.Timeout | undefined;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
      };

      const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (spawnError) {
          resolve(toolError(`Failed to run command: ${spawnError.message}`));
          return;
        }
        const exit = code ?? (signal ? 1 : 0);
        const out = stdout.render().trimEnd();
        const err = stderr.render().trimEnd();
        const sections: string[] = [];
        if (out) sections.push(out);
        if (err) sections.push(`[stderr]\n${err}`);
        if (sections.length === 0) sections.push('(no output)');

        const flags: string[] = [];
        if (timedOut) flags.push(`timed out after ${timeoutSeconds}s`);
        if (cancelled) flags.push('cancelled by user');
        const statusLine =
          `exit code: ${exit}` +
          (signal ? ` (signal ${signal})` : '') +
          (flags.length ? ` (${flags.join(', ')})` : '');
        const content = truncateMiddle(`${statusLine}\n${sections.join('\n')}`, MAX_OUTPUT_CHARS);
        const summary =
          timedOut
            ? `timed out after ${timeoutSeconds}s`
            : cancelled
              ? 'cancelled'
              : `exit ${exit}`;
        resolve({
          content,
          summary,
          status: timedOut || cancelled || exit !== 0 ? 'error' : 'ok',
        });
      };

      const onAbort = () => {
        cancelled = true;
        if (child) killTree(child);
      };

      try {
        child = spawn(command, {
          cwd: ctx.cwd,
          shell: true,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          // Kiro's own API keys stay out of the child process: the model could
          // otherwise print them into the transcript with a bare `env`.
          env: childEnv(),
        });
      } catch (error) {
        finish(null, null, error as Error);
        return;
      }

      timer = setTimeout(() => {
        timedOut = true;
        if (child) killTree(child);
      }, timeoutSeconds * 1000);
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      if (ctx.signal.aborted) onAbort();

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => stdout.add(chunk));
      child.stderr?.on('data', (chunk: string) => stderr.add(chunk));
      child.on('error', (error) => finish(null, null, error));
      child.on('close', (code, signal) => finish(code, signal));
    });
  },
};
