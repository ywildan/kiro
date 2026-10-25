import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import type { PaletteState, ViewItem } from './types.js';
import { MAX_EXPANDED_TOOL_CHARS, MAX_REASONING_CHARS } from './types.js';
import { renderMarkdown, type MarkdownSegment } from './markdown.js';
import { parseMouseWheel } from './mouse.js';
import {
  displayWidth,
  formatDuration,
  sanitizeText,
  truncateToWidth,
  wrapPlain,
} from './text.js';

const BANNER = [
  ' ██╗  ██╗ ██╗ ██████╗  ██████╗',
  ' ██║ ██╔╝ ██║ ██╔══██╗ ██╔═══██╗',
  ' █████╔╝  ██║ ██████╔╝ ██║   ██║',
  ' ██╔═██╗  ██║ ██╔══██╗ ██║   ██║',
  ' ██║  ██╗ ██║ ██║  ██║ ╚██████╔╝',
  ' ╚═╝  ╚═╝ ╚═╝ ╚═╝  ╚═╝  ╚═════╝',
];

interface Suffix {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
}

interface RenderLine {
  prefix: string;
  prefixColor?: string;
  prefixDim?: boolean;
  text: string;
  segments?: MarkdownSegment[];
  color?: string;
  dim?: boolean;
  bold?: boolean;
  inverse?: boolean;
  suffix?: Suffix;
}

function blankLine(): RenderLine {
  return { prefix: '', text: '' };
}

/** Keeps head and tail of a long reasoning trace so the newest thinking stays visible. */
function clampReasoning(text: string): string {
  if (text.length <= MAX_REASONING_CHARS) return text;
  const head = Math.floor(MAX_REASONING_CHARS * 0.4);
  const tail = MAX_REASONING_CHARS - head;
  return `${text.slice(0, head)}\n… [earlier reasoning omitted] …\n${text.slice(-tail)}`;
}

function block(
  text: string,
  firstPrefix: string,
  restPrefix: string,
  width: number,
  style: Omit<RenderLine, 'prefix' | 'text'> = {},
): RenderLine[] {
  const prefixWidth = displayWidth(firstPrefix);
  const contentWidth = Math.max(1, width - Math.max(prefixWidth, displayWidth(restPrefix)));
  const wrapped = wrapPlain(text.trimEnd(), contentWidth);
  return wrapped.map((line, index) => ({
    ...style,
    prefix: index === 0 ? firstPrefix : restPrefix,
    text: line,
  }));
}

function toolLines(
  item: Extract<ViewItem, { kind: 'tool' }>,
  width: number,
  expanded: boolean,
): RenderLine[] {
  const statusColor =
    item.status === 'ok'
      ? 'green'
      : item.status === 'error'
        ? 'red'
        : item.status === 'denied'
          ? 'yellow'
          : 'yellow';
  const suffixText =
    item.status === 'running'
      ? 'running…'
      : `${item.status}${item.durationMs !== undefined ? ` · ${formatDuration(item.durationMs)}` : ''}`;
  const suffix: Suffix = { text: `  · ${suffixText}`, color: statusColor, dim: item.status === 'ok' };
  const prefix = '● ';
  const suffixWidth = displayWidth(suffix.text);
  const body = truncateToWidth(
    `${item.name}  ${item.argsSummary}`,
    Math.max(8, width - displayWidth(prefix) - suffixWidth),
  );
  const lines: RenderLine[] = [
    {
      prefix,
      prefixColor: statusColor,
      text: body,
      suffix,
    },
  ];
  if (item.resultSummary && item.status !== 'running') {
    const resultPrefix = '  ⎿  ';
    const resultWidth = Math.max(1, width - displayWidth(resultPrefix));
    lines.push({
      prefix: resultPrefix,
      prefixColor: item.status === 'error' ? 'red' : undefined,
      prefixDim: item.status !== 'error',
      text: truncateToWidth(item.resultSummary.split('\n')[0] ?? '', resultWidth),
      dim: item.status !== 'error',
      color: item.status === 'error' ? 'red' : undefined,
    });
  }
  if (expanded && item.status !== 'running' && item.resultFull) {
    lines.push(...block(item.resultFull, '  │ ', '  │ ', width, { dim: true }));
    lines.push({
      prefix: '  │ ',
      prefixDim: true,
      text: truncateToWidth(
        item.resultFull.length >= MAX_EXPANDED_TOOL_CHARS
          ? `output capped at ${MAX_EXPANDED_TOOL_CHARS.toLocaleString()} characters · Ctrl+O to collapse`
          : 'Ctrl+O to collapse',
        Math.max(1, width - 4),
      ),
      dim: true,
    });
  }
  lines.push(blankLine());
  return lines;
}

function itemLines(item: ViewItem, width: number, expandedToolId: number | null): RenderLine[] {
  switch (item.kind) {
    case 'banner': {
      const lines: RenderLine[] = [];
      const banner = width >= 40 ? BANNER : ['  K I R O'];
      for (const line of banner) {
        lines.push({
          prefix: '',
          text: truncateToWidth(line, width),
          color: 'cyan',
          bold: true,
        });
      }
      lines.push(blankLine());
      lines.push({
        prefix: '',
        text: truncateToWidth(`  terminal coding agent · v${item.version}`, width),
        dim: true,
      });
      lines.push({
        prefix: '',
        text: truncateToWidth(`  working in ${item.cwd}`, width),
        dim: true,
      });
      lines.push(blankLine());
      lines.push({
        prefix: '',
        text: truncateToWidth(
          '  Type a request. / for commands. PgUp/PgDn scrolls · Ctrl+O expands tool output.',
          width,
        ),
        dim: true,
      });
      lines.push(blankLine());
      return lines;
    }
    case 'user': {
      const lines = block(sanitizeText(item.text), '› ', '  ', width, {
        prefixColor: 'cyan',
        bold: true,
      });
      lines.push(blankLine());
      return lines;
    }
    case 'assistant': {
      const markdown = renderMarkdown(item.text + (item.draft ? '▌' : ''), Math.max(1, width - 2));
      const lines: RenderLine[] = markdown.map((line, index) => ({
        prefix: index === 0 ? '● ' : '  ',
        prefixColor: index === 0 ? 'green' : undefined,
        text: '',
        segments: line.segments,
      }));
      if (!item.draft && item.durationMs !== undefined) {
        const speed =
          item.tokensPerSecond !== undefined ? ` · ${item.tokensPerSecond} tok/s` : '';
        lines.push({
          prefix: '  ',
          text: `· ${formatDuration(item.durationMs)}${speed}`,
          dim: true,
        });
      }
      lines.push(blankLine());
      return lines;
    }
    case 'reasoning': {
      const header: RenderLine[] = [
        {
          prefix: '◔ ',
          prefixColor: 'magenta',
          text: item.draft ? 'thinking…' : 'reasoning (done, not saved)',
          dim: true,
        },
      ];
      // Collapse finished traces: they are display-only, and leaving every
      // reasoning block expanded floods the transcript in long tool loops.
      if (item.draft) {
        header.push(...block(clampReasoning(item.text), '  · ', '  · ', width - 2, { dim: true }));
      }
      header.push(blankLine());
      return header;
    }
    case 'tool':
      return toolLines(item, width, item.id === expandedToolId);
    case 'notice': {
      const color = item.level === 'error' ? 'red' : item.level === 'info' ? 'cyan' : undefined;
      const lines = block(sanitizeText(item.text), '! ', '  ', width, {
        prefixColor: color,
        color: item.level === 'error' ? 'red' : undefined,
        dim: item.level !== 'error',
      });
      lines.push(blankLine());
      return lines;
    }
    default:
      return [];
  }
}

export function buildLines(
  items: ViewItem[],
  width: number,
  expandedToolId: number | null = null,
): RenderLine[] {
  const lines: RenderLine[] = [];
  for (const item of items) {
    lines.push(...itemLines(item, Math.max(10, width), expandedToolId));
  }
  return lines;
}

interface MessageListProps {
  items: ViewItem[];
  width: number;
  height: number;
  resetSignal: number;
  /** Id of the tool item whose full output should be shown inline. */
  expandedToolId?: number | null;
  /** Slash-menu palette drawn over the transcript's bottom rows. */
  palette?: PaletteState | null;
  /** False while an approval prompt or wizard owns the keyboard. */
  interactive?: boolean;
}

const PALETTE_ROWS = 6;

/** Header plus the visible command rows; padded so filtering never changes its height. */
export function buildPaletteLines(palette: PaletteState, width: number): RenderLine[] {
  const header: RenderLine = {
    prefix: '  ',
    text: truncateToWidth('commands · ↑/↓ move · Tab complete · Enter run', width),
    dim: true,
  };
  const rows: RenderLine[] = palette.commands.slice(0, PALETTE_ROWS).map((command, index) => {
    const active = index === palette.activeIndex;
    const label = command.usage ? `${command.name} ${command.usage}` : command.name;
    return {
      prefix: active ? '› ' : '  ',
      prefixColor: active ? 'cyan' : undefined,
      text: '',
      segments: [
        { text: label, bold: active },
        { text: `  ${command.description}`, dim: !active },
      ],
      inverse: active,
    };
  });
  while (rows.length < PALETTE_ROWS) rows.push({ prefix: '', text: '' });
  return [header, ...rows];
}

/**
 * Replaces the last rows of the visible transcript with the palette, so opening
 * the menu never resizes the transcript or moves the conversation.
 */
export function applyPalette(
  lines: RenderLine[],
  palette: PaletteState | null,
  width: number,
  maxRows: number,
): RenderLine[] {
  if (!palette) return lines;
  const height = Math.max(1, maxRows);
  const overlay = buildPaletteLines(palette, width).slice(0, height);
  const keep = Math.max(0, Math.min(lines.length, height) - overlay.length);
  return [...lines.slice(0, keep), ...overlay];
}

export function MessageList({
  items,
  width,
  height,
  resetSignal,
  expandedToolId = null,
  palette = null,
  interactive = true,
}: MessageListProps): React.JSX.Element {
  const { stdin } = useStdin();
  const lines = buildLines(items, width, expandedToolId);
  const maxScroll = Math.max(0, lines.length - height);
  const [scrollTop, setScrollTop] = useState(maxScroll);
  const stickToBottom = useRef(true);

  useEffect(() => {
    if (stickToBottom.current) {
      setScrollTop(maxScroll);
    } else {
      setScrollTop((current) => Math.min(current, maxScroll));
    }
  }, [maxScroll, height]);

  useEffect(() => {
    stickToBottom.current = true;
    setScrollTop(maxScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal]);

  useEffect(() => {
    const onData = (chunk: string | Buffer): void => {
      if (!interactive) return;
      const delta = parseMouseWheel(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      if (delta === 0) return;
      stickToBottom.current = false;
      setScrollTop((current) => {
        const next = Math.max(0, Math.min(maxScroll, current + delta));
        if (next >= maxScroll) stickToBottom.current = true;
        return next;
      });
    };
    stdin.on('data', onData);
    return () => {
      stdin.off('data', onData);
    };
  }, [stdin, maxScroll, interactive]);

  useInput(
    (_input, key) => {
      if (key.pageUp) {
        stickToBottom.current = false;
        setScrollTop((current) => Math.max(0, current - Math.max(1, height - 1)));
      } else if (key.pageDown) {
        setScrollTop((current) => {
          const next = Math.min(maxScroll, current + Math.max(1, height - 1));
          if (next >= maxScroll) stickToBottom.current = true;
          return next;
        });
      }
    },
    { isActive: interactive },
  );

  const visible = lines.slice(scrollTop, scrollTop + height);
  const shown = applyPalette(visible, palette, width, height);

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      overflowY="hidden"
      flexShrink={0}
      justifyContent="flex-end"
    >
      {shown.map((line, index) => {
        const hasSuffix = line.suffix !== undefined;
        return (
          <Text
            key={`${scrollTop}-${index}`}
            wrap="truncate-end"
            color={line.color}
            dimColor={line.dim}
            bold={line.bold}
            inverse={line.inverse}
          >
            {line.prefix ? (
              <Text color={line.prefixColor} dimColor={line.prefixDim} bold={line.prefixColor === 'cyan'}>
                {line.prefix}
              </Text>
            ) : null}
            {line.segments
              ? line.segments.map((segment, segmentIndex) => (
                  <Text
                    key={segmentIndex}
                    color={segment.color}
                    dimColor={segment.dim}
                    bold={segment.bold}
                    italic={segment.italic}
                    underline={segment.underline}
                    strikethrough={segment.strikethrough}
                  >
                    {segment.text}
                  </Text>
                ))
              : line.text || (hasSuffix ? '' : ' ')}
            {line.suffix ? (
              <Text color={line.suffix.color} dimColor={line.suffix.dim} bold={line.suffix.bold}>
                {line.suffix.text}
              </Text>
            ) : null}
          </Text>
        );
      })}
    </Box>
  );
}
