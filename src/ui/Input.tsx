import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import { filterSlashCommands, type SlashCommand } from './commands.js';
import { filterFiles } from './file-index.js';
import { mentionAt, mentionNearby, mentionText } from './mention.js';
import { isMouseSequence } from './mouse.js';
import {
  applyInputOps,
  cursorLineIndex,
  feedPaste,
  layoutInput,
  parseEditSequence,
  parseInputChunk,
  type PasteState,
  type TextInputState,
} from './text.js';
import type { PaletteState } from './types.js';

const MAX_INPUT_CHARS = 20_000;
const MAX_MENU_ROWS = 6;
const MAX_VISIBLE_LINES = 6;
const PASTE_ON = '\x1b[?2004h';
const PASTE_OFF = '\x1b[?2004l';

interface InputProps {
  disabled: boolean;
  placeholder: string;
  width: number;
  mask?: boolean;
  allowEmpty?: boolean;
  slashMenu?: boolean;
  /** Offer @file mentions; off for wizard prompts and masked input. */
  fileMenu?: boolean;
  /** Loads project-relative file paths for the @ menu. */
  loadFiles?: () => Promise<string[]>;
  /** Maximum input rows to draw; the window scrolls instead of growing further. */
  maxRows?: number;
  /** Command menu contents: built-ins plus skill commands. */
  slashCommands?: SlashCommand[];
  /** Submitted prompts, oldest first; ↑/↓ recall them when the input is empty. */
  history?: string[];
  onSubmit(value: string): void;
  onCancel?(): void;
  onHeightChange?(rows: number): void;
  /** Reports the filtered slash menu so MessageList can overlay it on the transcript. */
  onPaletteChange?(palette: PaletteState | null): void;
}

export function Input({
  disabled,
  placeholder,
  width,
  mask = false,
  allowEmpty = false,
  slashMenu = true,
  fileMenu = true,
  loadFiles,
  maxRows = MAX_VISIBLE_LINES,
  slashCommands,
  history,
  onSubmit,
  onCancel,
  onHeightChange,
  onPaletteChange,
}: InputProps): React.JSX.Element {
  const { stdin } = useStdin();
  const [state, setState] = useState<TextInputState>({ chars: [], cursor: 0 });
  const [selected, setSelected] = useState(0);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [mentionStart, setMentionStart] = useState<number | null>(null);
  const [files, setFiles] = useState<string[] | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const pasteRef = useRef<PasteState>({ open: false, buffer: '', pending: '' });

  const text = state.chars.join('');
  const recalled = historyIndex !== null ? (history?.[historyIndex] ?? null) : null;
  useEffect(() => {
    // Editing the recalled entry (or pressing a letter) ends history browsing.
    if (historyIndex !== null && text !== recalled) {
      setHistoryIndex(null);
    }
  }, [historyIndex, recalled, text]);
  const matches =
    slashMenu && !mask && !disabled && !text.includes('\n')
      ? filterSlashCommands(text, slashCommands)
      : [];
  const menuOpen = matches.length > 0;
  const activeIndex = Math.min(selected, Math.max(0, matches.length - 1));
  const menuStart = Math.max(
    0,
    Math.min(activeIndex - Math.floor(MAX_MENU_ROWS / 2), matches.length - MAX_MENU_ROWS),
  );
  const visibleCommands = matches.slice(menuStart, menuStart + MAX_MENU_ROWS);

  const mention =
    fileMenu && !mask && !disabled && mentionStart !== null && !text.startsWith('/')
      ? mentionAt(state.chars, state.cursor, mentionStart)
      : null;
  const mentionOpen = mention !== null;
  const mentionQuery = mention?.query ?? '';
  const fileMatches = mention && files ? filterFiles(files, mentionQuery) : [];
  const fileActive = Math.min(selected, Math.max(0, fileMatches.length - 1));
  const fileStart = Math.max(
    0,
    Math.min(fileActive - Math.floor(MAX_MENU_ROWS / 2), fileMatches.length - MAX_MENU_ROWS),
  );
  const visibleFiles = fileMatches.slice(fileStart, fileStart + MAX_MENU_ROWS);
  const filesHeader =
    filesLoading && files === null
      ? 'files · indexing…'
      : fileMatches.length === 0
        ? `files · no matches for "${mentionQuery}" · Esc to close`
        : `files ${fileStart + 1}-${fileStart + visibleFiles.length} of ${fileMatches.length} · ↑/↓ move · Tab/Enter insert · Esc close`;
  const fileSignature = `${mentionOpen}|${mentionQuery}|${filesLoading}|${fileStart}|${fileActive}|${visibleFiles.join('\u0000')}`;

  useEffect(() => {
    setSelected(0);
  }, [text]);

  useEffect(() => {
    if (!mentionOpen || !loadFiles) return;
    let cancelled = false;
    setFilesLoading(true);
    loadFiles()
      .then((list) => {
        if (!cancelled) setFiles(list);
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      })
      .finally(() => {
        if (!cancelled) setFilesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mentionOpen, loadFiles]);

  useEffect(() => {
    if (mentionStart !== null && !mentionAt(state.chars, state.cursor, mentionStart)) {
      setMentionStart(null);
    }
  }, [state, mentionStart]);

  useEffect(() => {
    if (menuOpen) {
      onPaletteChange?.({
        kind: 'commands',
        commands: visibleCommands,
        activeIndex: Math.max(0, activeIndex - menuStart),
      });
      return;
    }
    if (mentionOpen) {
      onPaletteChange?.({
        kind: 'files',
        files: visibleFiles,
        activeIndex: Math.max(0, fileActive - fileStart),
        header: filesHeader,
      });
      return;
    }
    onPaletteChange?.(null);
    // visible rows are derived from text, fileSignature, and the window offsets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    menuOpen,
    text,
    activeIndex,
    menuStart,
    mentionOpen,
    fileSignature,
    filesHeader,
    onPaletteChange,
  ]);

  useEffect(() => () => onPaletteChange?.(null), [onPaletteChange]);

  const update = (chars: string[], cursor: number): void => {
    const next = { chars, cursor: Math.max(0, Math.min(cursor, chars.length)) };
    stateRef.current = next;
    setState(next);
  };

  const deleteBackward = (count: number): void => {
    setState((current) => {
      if (current.cursor === 0) return current;
      const cursor = Math.max(0, current.cursor - count);
      const next = {
        chars: [...current.chars.slice(0, cursor), ...current.chars.slice(current.cursor)],
        cursor,
      };
      stateRef.current = next;
      return next;
    });
  };

  const deleteForward = (count: number): void => {
    setState((current) => {
      if (current.cursor >= current.chars.length) return current;
      const end = Math.min(current.chars.length, current.cursor + count);
      const next = {
        chars: [...current.chars.slice(0, current.cursor), ...current.chars.slice(end)],
        cursor: current.cursor,
      };
      stateRef.current = next;
      return next;
    });
  };

  useEffect(() => {
    if (disabled) return;
    // Ink reports both \x7f (Backspace) and Escape[3~ (Delete) as key.delete,
    // so read the raw sequence to know which one was pressed.
    const onData = (chunk: string | Buffer): void => {
      const data = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const sequence = parseEditSequence(data);
      if (sequence?.type === 'backspace') deleteBackward(sequence.count);
      else if (sequence?.type === 'delete') deleteForward(sequence.count);
    };
    stdin.on('data', onData);
    return () => {
      stdin.off('data', onData);
    };
    // deleteBackward/deleteForward only use stable setters and refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, stdin]);

  useEffect(() => {
    if (disabled || !process.stdout.isTTY) return;
    process.stdout.write(PASTE_ON);
    return () => {
      process.stdout.write(PASTE_OFF);
    };
  }, [disabled]);

  useInput(
    (input, key) => {
      const { chars, cursor } = stateRef.current;

      if (key.backspace || key.delete) return; // handled from raw stdin above
      if (isMouseSequence(input)) return;

      const pasted = feedPaste(pasteRef.current, input);
      pasteRef.current = pasted.state;
      if (pasted.consumed) {
        if (pasted.text !== null) {
          const inserted = mask ? pasted.text.replace(/\n/g, ' ') : pasted.text;
          const applied = applyInputOps(
            { chars, cursor },
            [{ type: 'insert', text: inserted }],
            MAX_INPUT_CHARS,
          );
          setMentionStart(null);
          update(applied.state.chars, applied.state.cursor);
        }
        return;
      }
      if (mention) {
        if (key.upArrow) {
          if (fileMatches.length > 0) {
            setSelected((fileActive - 1 + fileMatches.length) % fileMatches.length);
          }
          return;
        }
        if (key.downArrow) {
          if (fileMatches.length > 0) {
            setSelected((fileActive + 1) % fileMatches.length);
          }
          return;
        }
        if ((key.tab || key.return) && fileMatches.length > 0) {
          const file = fileMatches[fileActive]!;
          const inserted = Array.from(`${mentionText(file)} `);
          const next = [
            ...chars.slice(0, mention.start),
            ...inserted,
            ...chars.slice(mention.end),
          ];
          update(next, mention.start + inserted.length);
          setMentionStart(null);
          setSelected(0);
          return;
        }
      }
      if (menuOpen) {
        if (key.upArrow) {
          setSelected((activeIndex - 1 + matches.length) % matches.length);
          return;
        }
        if (key.downArrow) {
          setSelected((activeIndex + 1) % matches.length);
          return;
        }
        if (key.tab) {
          const command = matches[activeIndex]!.name;
          const filled = Array.from(`${command} `);
          update(filled, filled.length);
          return;
        }
      }
      if (!mask && history && history.length > 0) {
        if (key.upArrow) {
          // History recall starts from an empty prompt: ↑ steps backwards
          // through submitted prompts, ↓ leaves history again.
          if (historyIndex === null) {
            if (chars.length > 0) return;
            setHistoryIndex(history.length - 1);
            const value = history[history.length - 1] ?? '';
            update(Array.from(value), value.length);
            return;
          }
          if (historyIndex > 0) {
            setHistoryIndex(historyIndex - 1);
            const value = history[historyIndex - 1] ?? '';
            update(Array.from(value), value.length);
          }
          return;
        }
        if (key.downArrow && historyIndex !== null) {
          const next = historyIndex + 1;
          if (next >= history.length) {
            setHistoryIndex(null);
            update([], 0);
          } else {
            setHistoryIndex(next);
            const value = history[next] ?? '';
            update(Array.from(value), value.length);
          }
          return;
        }
      }
      if (key.return) {
        if (menuOpen) {
          const command = matches[activeIndex]!.name;
          setMentionStart(null);
          update([], 0);
          setSelected(0);
          onSubmit(command);
          return;
        }
        if (!mask && key.meta) {
          update([...chars.slice(0, cursor), '\n', ...chars.slice(cursor)], cursor + 1);
          return;
        }
        if (!mask && cursor > 0 && chars[cursor - 1] === '\\') {
          update([...chars.slice(0, cursor - 1), '\n', ...chars.slice(cursor)], cursor);
          return;
        }
        const value = chars.join('');
        if (value.trim() || allowEmpty) {
          setMentionStart(null);
          update([], 0);
          onSubmit(value);
        }
        return;
      }
      if (key.escape) {
        if (mentionOpen) {
          setMentionStart(null);
          setSelected(0);
          return;
        }
        update([], 0);
        if (onCancel) onCancel();
        return;
      }
      if (key.ctrl && input === 'a') {
        setMentionStart(null);
        update(chars, 0);
        return;
      }
      if (key.ctrl && input === 'e') {
        setMentionStart(null);
        update(chars, chars.length);
        return;
      }
      if (key.ctrl && input === 'u') {
        update(chars.slice(cursor), 0);
        return;
      }
      if (key.ctrl && input === 'k') {
        update(chars.slice(0, cursor), cursor);
        return;
      }
      if (key.ctrl && input === 'w') {
        let start = cursor;
        while (start > 0 && /\s/.test(chars[start - 1] ?? '')) start--;
        while (start > 0 && !/\s/.test(chars[start - 1] ?? '')) start--;
        update([...chars.slice(0, start), ...chars.slice(cursor)], start);
        return;
      }
      if (key.leftArrow) {
        setMentionStart(null);
        update(chars, cursor - 1);
        return;
      }
      if (key.rightArrow) {
        setMentionStart(null);
        update(chars, cursor + 1);
        return;
      }
      if (key.home) {
        setMentionStart(null);
        update(chars, 0);
        return;
      }
      if (key.end) {
        setMentionStart(null);
        update(chars, chars.length);
        return;
      }
      if (key.ctrl || key.meta || key.tab || key.pageUp || key.pageDown) return;

      // Chunks that mix text with control bytes (\r, \x7f, ctrl keys) are not
      // decoded by Ink, so replay their control bytes as edits in chunk order.
      const ops = parseInputChunk(mask ? input.replace(/\n/g, ' ') : input);
      if (ops.length === 0) return;
      const applied = applyInputOps({ chars, cursor }, ops, MAX_INPUT_CHARS);
      const value = applied.state.chars.join('');
      if (applied.submitted && (value.trim() || allowEmpty)) {
        setMentionStart(null);
        update([], 0);
        onSubmit(value);
        return;
      }
      if (!mask && fileMenu && !value.startsWith('/')) {
        const opened = mentionNearby(applied.state.chars, applied.state.cursor);
        if (opened !== null) setMentionStart(opened);
      }
      update(applied.state.chars, applied.state.cursor);
    },
    { isActive: !disabled },
  );

  const maxWidth = Math.max(4, width - 2);
  const { chars, cursor } = state;
  const lines = layoutInput(chars, maxWidth, mask);
  const cursorIndex = cursorLineIndex(lines, cursor);
  const windowSize = Math.max(1, Math.min(maxRows, MAX_VISIBLE_LINES, lines.length));
  const windowStart = Math.max(
    0,
    Math.min(cursorIndex - windowSize + 1, lines.length - windowSize),
  );
  const visible = lines.slice(windowStart, windowStart + windowSize);
  const hiddenAbove = windowStart > 0;
  const hiddenBelow = windowStart + visible.length < lines.length;
  const rows = disabled || chars.length === 0 ? 1 : visible.length;

  useEffect(() => {
    onHeightChange?.(rows);
  }, [rows, onHeightChange]);

  if (disabled) {
    return (
      <Box flexShrink={0}>
        <Text color="gray" bold>
          {'› '}
        </Text>
        <Text dimColor wrap="truncate-end">
          {placeholder}
        </Text>
      </Box>
    );
  }

  if (chars.length === 0) {
    return (
      <Box flexShrink={0}>
        <Text color="cyan" bold>
          {'› '}
        </Text>
        <Text wrap="truncate-end">
          <Text inverse> </Text>
          <Text dimColor> {placeholder}</Text>
        </Text>
      </Box>
    );
  }

  const shown = (values: string[]): string => (mask ? '•'.repeat(values.length) : values.join(''));

  return (
    <Box flexDirection="column" flexShrink={0}>
      {visible.map((line, offset) => {
        const absolute = windowStart + offset;
        const isCursor = absolute === cursorIndex;
        const isFirst = absolute === 0;
        const isLast = offset === visible.length - 1;
        const prefix =
          isLast && hiddenBelow
            ? '↓ '
            : offset === 0 && hiddenAbove
              ? '↑ '
              : isFirst
                ? '› '
                : '  ';
        const prefixColor = isFirst && !hiddenAbove ? 'cyan' : 'gray';
        const before = shown(chars.slice(line.start, Math.min(cursor, line.end)));
        const at = isCursor
          ? cursor < line.end
            ? shown([chars[cursor]!])
            : ' '
          : '';
        const after = isCursor
          ? shown(chars.slice(Math.min(cursor + 1, line.end), line.end))
          : '';
        return (
          <Box key={absolute} flexDirection="row">
            <Text color={prefixColor} dimColor={prefixColor === 'gray'} bold={prefixColor === 'cyan'}>
              {prefix}
            </Text>
            {isCursor ? (
              <Text wrap="truncate-end">
                {before}
                <Text inverse>{at}</Text>
                {after}
              </Text>
            ) : (
              <Text wrap="truncate-end">{line.text}</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
