import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Tool } from './types.js';
import { denied, ok, toolError } from './types.js';
import { matchGlob } from './glob.js';
import { booleanArg, displayPath, integerArg, resolvePath, stringArg } from './paths.js';
import { ALWAYS_SKIP, walkTree } from './walk.js';

const GLOB_LIMIT = 200;
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;
const MAX_GREP_LINE_CHARS = 500;
const MAX_CAPTURE_CHARS = 4_000_000;

const globTool: Tool = {
  readOnly: true,
  definition: {
    type: 'function',
    function: {
      name: 'glob',
      description:
        'Find files and directories by glob pattern, for example "src/**/*.ts". Respects .gitignore and always skips node_modules, .git, dist, and build. Results are capped.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Glob pattern. "*.ts" matches at any depth; "src/**/*.ts" is path-scoped.',
          },
          path: {
            type: 'string',
            description: 'Directory to search, relative to the working directory. Default ".".',
          },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
  },

  async run(input, ctx) {
    const pattern = stringArg(input, 'pattern')!;
    const rawPath = stringArg(input, 'path', true) ?? '.';
    const resolved = await resolvePath(ctx, rawPath);
    if (resolved.outside) {
      return toolError(
        `Path "${rawPath}" is outside the working directory (${resolved.abs}). Searching outside the workspace is not allowed.`,
      );
    }
    let info;
    try {
      info = await stat(resolved.abs);
    } catch (error) {
      return toolError(`Cannot search ${resolved.display}: ${(error as Error).message}`);
    }
    if (!info.isDirectory()) {
      return toolError(`${resolved.display} is not a directory. Use grep to search a single file.`);
    }

    const matches: { rel: string; isDir: boolean }[] = [];
    let truncated = false;
    await walkTree({
      cwd: ctx.cwd,
      rootAbs: resolved.abs,
      signal: ctx.signal,
      visit(entry) {
        if (!matchGlob(entry.rel, pattern)) return true;
        if (matches.length >= GLOB_LIMIT) {
          truncated = true;
          return false;
        }
        matches.push({ rel: entry.rel, isDir: entry.isDir });
        return true;
      },
    });

    if (ctx.signal.aborted) return denied('Cancelled by user.');
    if (matches.length === 0) {
      return ok(
        `No matches for "${pattern}"${rawPath === '.' ? '' : ` under ${resolved.display}`}.`,
        `glob "${pattern}" (0 results)`,
      );
    }

    matches.sort((left, right) => left.rel.localeCompare(right.rel));
    const lines = matches.map((entry) => (entry.isDir ? `${entry.rel}/` : entry.rel));
    const notes = truncated
      ? [
          `[Showing the first ${GLOB_LIMIT} matches; more may exist. Narrow the pattern or path.]`,
        ]
      : [];
    const content = [
      `${matches.length} match${matches.length === 1 ? '' : 'es'} for "${pattern}"${
        rawPath === '.' ? '' : ` under ${resolved.display}`
      }:`,
      ...lines,
      ...notes,
    ].join('\n');
    return ok(content, `glob "${pattern}" (${matches.length} results)`);
  },
};

interface GrepHit {
  rel: string;
  line: number;
  text: string;
}

function cleanLine(text: string): string {
  const withoutNewline = text.replace(/[\r\n]+$/, '');
  return withoutNewline.length > MAX_GREP_LINE_CHARS
    ? `${withoutNewline.slice(0, MAX_GREP_LINE_CHARS)}…`
    : withoutNewline;
}

function formatHits(options: {
  pattern: string;
  pathLabel: string;
  globFilter?: string;
  hits: GrepHit[];
  truncated: boolean;
  maxResults: number;
  engine: string;
}): ReturnType<typeof ok> {
  const files = new Set(options.hits.map((hit) => hit.rel));
  const scope = options.pathLabel === '.' ? '' : ` in ${options.pathLabel}`;
  const glob = options.globFilter ? ` [glob: ${options.globFilter}]` : '';
  if (options.hits.length === 0) {
    return ok(
      `No matches for /${options.pattern}/${scope}${glob}.`,
      `grep "${options.pattern}" (no matches)`,
    );
  }
  const lines = [
    `Matches for /${options.pattern}/${scope}${glob} (${options.hits.length} in ${
      files.size
    } file${files.size === 1 ? '' : 's'}, via ${options.engine}):`,
    ...options.hits.map((hit) => `${hit.rel}:${hit.line}: ${hit.text}`),
  ];
  if (options.truncated) {
    lines.push(
      `[Output capped at ${options.maxResults} results; increase max_results or narrow the path/glob to see more.]`,
    );
  }
  return ok(
    lines.join('\n'),
    `grep "${options.pattern}" (${options.hits.length} in ${files.size} file${
      files.size === 1 ? '' : 's'
    })`,
  );
}

let ripgrepProbe: Promise<boolean> | undefined;

function ripgrepAvailable(): Promise<boolean> {
  if (process.env.KIRO_GREP_NO_RG === '1') return Promise.resolve(false);
  ripgrepProbe ??= new Promise<boolean>((resolve) => {
    let child;
    try {
      child = spawn('rg', ['--version'], { stdio: 'ignore', windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
  return ripgrepProbe;
}

interface RipgrepResult {
  missing?: boolean;
  aborted?: boolean;
  error?: string;
  hits: GrepHit[];
  truncated: boolean;
}

function runRipgrep(options: {
  cwd: string;
  pattern: string;
  searchPath: string;
  globFilter?: string;
  ignoreCase: boolean;
  contextLines: number;
  maxResults: number;
  signal: AbortSignal;
}): Promise<RipgrepResult> {
  return new Promise<RipgrepResult>((resolve) => {
    const args = [
      '--json',
      '--line-number',
      '--color',
      'never',
      '--hidden',
      '--no-require-git',
      '--max-filesize',
      '2M',
    ];
    if (options.ignoreCase) args.push('-i');
    if (options.contextLines > 0) args.push('-C', String(options.contextLines));
    if (options.globFilter) args.push('-g', options.globFilter);
    for (const name of ALWAYS_SKIP) args.push('-g', `!${name}/**`);
    args.push('--', options.pattern, options.searchPath);

    let child;
    try {
      child = spawn('rg', args, { cwd: options.cwd, windowsHide: true });
    } catch {
      resolve({ hits: [], truncated: false, missing: true });
      return;
    }

    const hits: GrepHit[] = [];
    const seen = new Set<string>();
    let stdoutBuffer = '';
    let stderr = '';
    let settled = false;
    let capped = false;
    let aborted = false;
    let missing = false;
    let killed = false;

    const kill = () => {
      if (killed) return;
      killed = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // already exited
      }
    };

    const onAbort = () => {
      aborted = true;
      kill();
    };
    options.signal.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => {
      options.signal.removeEventListener('abort', onAbort);
    };

    const finish = (result: RipgrepResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const addHit = (rel: string, line: number, text: string) => {
      const key = `${rel}:${line}`;
      if (seen.has(key)) return;
      seen.add(key);
      hits.push({ rel, line, text: cleanLine(text) });
      if (hits.length >= options.maxResults) {
        capped = true;
        kill();
      }
    };

    const handleLine = (raw: string) => {
      if (!raw.trim() || capped) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      if (typeof parsed !== 'object' || parsed === null) return;
      const record = parsed as Record<string, unknown>;
      if (record.type !== 'match' && record.type !== 'context') return;
      const data = record.data;
      if (typeof data !== 'object' || data === null) return;
      const payload = data as Record<string, unknown>;
      const lineNumber = payload.line_number;
      const pathInfo = payload.path;
      const linesInfo = payload.lines;
      if (typeof lineNumber !== 'number') return;
      if (typeof pathInfo !== 'object' || pathInfo === null) return;
      if (typeof linesInfo !== 'object' || linesInfo === null) return;
      const rawPathValue = (pathInfo as Record<string, unknown>).text;
      const lineText = (linesInfo as Record<string, unknown>).text;
      if (typeof rawPathValue !== 'string' || typeof lineText !== 'string') return;
      const rel = displayPath(options.cwd, path.resolve(options.cwd, rawPathValue));
      addHit(rel, lineNumber, lineText);
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (capped) return;
      stdoutBuffer += chunk;
      if (stdoutBuffer.length > MAX_CAPTURE_CHARS) {
        capped = true;
        kill();
        return;
      }
      let newline = stdoutBuffer.indexOf('\n');
      while (newline !== -1) {
        const raw = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        handleLine(raw);
        if (capped) return;
        newline = stdoutBuffer.indexOf('\n');
      }
    });
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < 20_000) stderr += chunk;
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') missing = true;
      finish({ hits: [], truncated: false, missing });
    });
    child.on('close', (code) => {
      if (stdoutBuffer && !capped) handleLine(stdoutBuffer);
      if (aborted) {
        finish({ hits, truncated: false, aborted: true });
        return;
      }
      if (capped) {
        finish({ hits, truncated: true });
        return;
      }
      if (code !== 0 && code !== 1) {
        finish({
          hits,
          truncated: false,
          error: stderr.trim() || `ripgrep exited with code ${String(code)}`,
        });
        return;
      }
      finish({ hits, truncated: false });
    });
  });
}

async function grepFallback(options: {
  cwd: string;
  rootAbs: string;
  rootIsFile: boolean;
  pathLabel: string;
  regex: RegExp;
  globFilter?: string;
  contextLines: number;
  maxResults: number;
  signal: AbortSignal;
}): Promise<{ hits: GrepHit[]; truncated: boolean }> {
  const hits: GrepHit[] = [];
  const seen = new Set<string>();
  let truncated = false;

  const searchFile = async (abs: string, rel: string): Promise<boolean> => {
    if (options.signal.aborted || truncated) return false;
    let content: Buffer;
    try {
      const info = await stat(abs);
      if (!info.isFile() || info.size > MAX_GREP_FILE_BYTES) return true;
      content = await readFile(abs);
    } catch {
      return true;
    }
    if (content.subarray(0, 8192).includes(0)) return true;
    const lines = content.toString('utf8').split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const matchedLines: number[] = [];
    for (let index = 0; index < lines.length; index++) {
      if (options.regex.test(lines[index]!)) matchedLines.push(index);
    }
    if (matchedLines.length === 0) return true;

    const wanted = new Set<number>();
    for (const index of matchedLines) {
      const start = Math.max(0, index - options.contextLines);
      const end = Math.min(lines.length - 1, index + options.contextLines);
      for (let cursor = start; cursor <= end; cursor++) wanted.add(cursor);
    }
    for (const index of [...wanted].sort((left, right) => left - right)) {
      if (options.signal.aborted) return false;
      const key = `${rel}:${index + 1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ rel, line: index + 1, text: cleanLine(lines[index]!) });
      if (hits.length >= options.maxResults) {
        truncated = true;
        return false;
      }
    }
    return true;
  };

  if (options.rootIsFile) {
    await searchFile(options.rootAbs, options.pathLabel);
    return { hits, truncated };
  }

  await walkTree({
    cwd: options.cwd,
    rootAbs: options.rootAbs,
    signal: options.signal,
    async visit(entry) {
      if (entry.isDir) return true;
      if (options.globFilter && !matchGlob(entry.rel, options.globFilter)) return true;
      return searchFile(entry.abs, entry.rel);
    },
  });
  return { hits, truncated };
}

const grepTool: Tool = {
  readOnly: true,
  definition: {
    type: 'function',
    function: {
      name: 'grep',
      description:
        'Search file contents with a regular expression. Returns "file:line: text" with optional context. Uses ripgrep when available and falls back to a built-in scanner. Respects .gitignore and skips node_modules, .git, dist, build, binary files, and files over 2 MB.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'JavaScript regular expression to search for.' },
          path: {
            type: 'string',
            description: 'File or directory to search, relative to the working directory. Default ".".',
          },
          glob: {
            type: 'string',
            description: 'Only search files matching this glob, e.g. "*.ts" or "src/**/*.ts".',
          },
          ignore_case: { type: 'boolean', description: 'Case-insensitive search. Default false.' },
          context_lines: {
            type: 'integer',
            description: 'Lines of context before and after each match (0-5). Default 0.',
          },
          max_results: {
            type: 'integer',
            description: 'Maximum number of output lines (1-500). Default 100.',
          },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
  },

  async run(input, ctx) {
    const pattern = stringArg(input, 'pattern')!;
    const rawPath = stringArg(input, 'path', true) ?? '.';
    const globFilter = stringArg(input, 'glob', true);
    const ignoreCase = booleanArg(input, 'ignore_case', false);
    const contextLines = integerArg(input, 'context_lines', 0, 0, 5);
    const maxResults = integerArg(input, 'max_results', 100, 1, 500);

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, ignoreCase ? 'i' : '');
    } catch (error) {
      return toolError(`Invalid regular expression /${pattern}/: ${(error as Error).message}`);
    }

    const resolved = await resolvePath(ctx, rawPath);
    if (resolved.outside) {
      return toolError(
        `Path "${rawPath}" is outside the working directory (${resolved.abs}). Searching outside the workspace is not allowed.`,
      );
    }

    let rootIsFile = false;
    try {
      const info = await stat(resolved.abs);
      rootIsFile = info.isFile();
      if (!rootIsFile && !info.isDirectory()) {
        return toolError(`${resolved.display} is neither a file nor a directory.`);
      }
      if (rootIsFile && info.size > MAX_GREP_FILE_BYTES) {
        return toolError(`${resolved.display} is too large to search (limit ${MAX_GREP_FILE_BYTES} bytes).`);
      }
    } catch (error) {
      return toolError(`Cannot search ${resolved.display}: ${(error as Error).message}`);
    }

    if (await ripgrepAvailable()) {
      const result = await runRipgrep({
        cwd: ctx.cwd,
        pattern,
        searchPath: rootIsFile ? resolved.display : rawPath,
        globFilter,
        ignoreCase,
        contextLines,
        maxResults,
        signal: ctx.signal,
      });
      if (!result.missing) {
        if (result.aborted || ctx.signal.aborted) return denied('Cancelled by user.');
        if (result.error) return toolError(`Search failed: ${result.error}`);
        return formatHits({
          pattern,
          pathLabel: resolved.display,
          globFilter,
          hits: result.hits,
          truncated: result.truncated,
          maxResults,
          engine: 'ripgrep',
        });
      }
    }

    const fallback = await grepFallback({
      cwd: ctx.cwd,
      rootAbs: resolved.abs,
      rootIsFile,
      pathLabel: resolved.display,
      regex,
      globFilter,
      contextLines,
      maxResults,
      signal: ctx.signal,
    });
    if (ctx.signal.aborted) return denied('Cancelled by user.');

    if (rootIsFile && fallback.hits.length === 0) {
      let info;
      try {
        info = await stat(resolved.abs);
      } catch {
        info = undefined;
      }
      if (info && info.size > 0) {
        const buffer = await readFile(resolved.abs).catch(() => null);
        if (buffer && buffer.subarray(0, 8192).includes(0)) {
          return toolError(`${resolved.display} appears to be a binary file; refusing to search it.`);
        }
      }
    }

    return formatHits({
      pattern,
      pathLabel: resolved.display,
      globFilter,
      hits: fallback.hits,
      truncated: fallback.truncated,
      maxResults,
      engine: 'built-in scanner',
    });
  },
};

export const searchTools: Tool[] = [globTool, grepTool];
