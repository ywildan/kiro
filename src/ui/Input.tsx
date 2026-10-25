import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import stringWidth from 'string-width';
import { filterSlashCommands } from './commands.js';
import { isMouseSequence } from './mouse.js';
import {
  applyInputOps,
  parseEditSequence,
  parseInputChunk,
  type TextInputState,
} from './text.js';

const MAX_INPUT_CHARS = 20_000;
const MAX_MENU_ROWS = 6;

interface InputProps {
  disabled: boolean;
  placeholder: string;
  width: number;
  mask?: boolean;
  allowEmpty?: boolean;
  slashMenu?: boolean;
  onSubmit(value: string): void;
  onCancel?(): void;
  onMenuRowsChange?(rows: number): void;
}

export function Input({
  disabled,
  placeholder,
  width,
  mask = false,
  allowEmpty = false,
  slashMenu = true,
  onSubmit,
  onCancel,
  onMenuRowsChange,
}: InputProps): React.JSX.Element {
  const { stdin } = useStdin();
  const [state, setState] = useState<TextInputState>({ chars: [], cursor: 0 });
  const [selected, setSelected] = useState(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const text = state.chars.join('');
  const matches =
    slashMenu && !mask && !disabled ? filterSlashCommands(text) : [];
  const menuOpen = matches.length > 0;
  const activeIndex = Math.min(selected, Math.max(0, matches.length - 1));
  const menuStart = Math.max(
    0,
    Math.min(activeIndex - Math.floor(MAX_MENU_ROWS / 2), matches.length - MAX_MENU_ROWS),
  );
  const visibleCommands = matches.slice(menuStart, menuStart + MAX_MENU_ROWS);

  useEffect(() => {
    setSelected(0);
  }, [text]);

  useEffect(() => {
    onMenuRowsChange?.(menuOpen ? Math.min(matches.length, MAX_MENU_ROWS) : 0);
  }, [menuOpen, matches.length, onMenuRowsChange]);

  useEffect(
    () => () => {
      onMenuRowsChange?.(0);
    },
    [onMenuRowsChange],
  );

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

  useInput(
    (input, key) => {
      const { chars, cursor } = stateRef.current;

      if (key.backspace || key.delete) return; // handled from raw stdin above
      if (isMouseSequence(input)) return;
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
      if (key.return) {
        if (menuOpen) {
          const command = matches[activeIndex]!.name;
          update([], 0);
          setSelected(0);
          onSubmit(command);
          return;
        }
        const value = chars.join('');
        if (value.trim() || allowEmpty) {
          update([], 0);
          onSubmit(value);
        }
        return;
      }
      if (key.escape) {
        update([], 0);
        if (onCancel) onCancel();
        return;
      }
      if (key.ctrl && input === 'a') {
        update(chars, 0);
        return;
      }
      if (key.ctrl && input === 'e') {
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
        update(chars, cursor - 1);
        return;
      }
      if (key.rightArrow) {
        update(chars, cursor + 1);
        return;
      }
      if (key.home) {
        update(chars, 0);
        return;
      }
      if (key.end) {
        update(chars, chars.length);
        return;
      }
      if (key.ctrl || key.meta || key.tab || key.pageUp || key.pageDown) return;

      // Chunks that mix text with control bytes (\r, \x7f, ctrl keys) are not
      // decoded by Ink, so replay their control bytes as edits in chunk order.
      const ops = parseInputChunk(input);
      if (ops.length === 0) return;
      const applied = applyInputOps({ chars, cursor }, ops, MAX_INPUT_CHARS);
      const value = applied.state.chars.join('');
      if (applied.submitted && (value.trim() || allowEmpty)) {
        update([], 0);
        onSubmit(value);
        return;
      }
      update(applied.state.chars, applied.state.cursor);
    },
    { isActive: !disabled },
  );

  const maxWidth = Math.max(4, width - 2);
  const { chars, cursor } = state;
  const displayChars = mask ? chars.map(() => '•') : chars;
  const charWidths = displayChars.map((char) => Math.max(1, stringWidth(char)));

  let start = 0;
  let widthToCursor = charWidths.slice(0, cursor).reduce((total, value) => total + value, 0);
  const cursorWidth = cursor < displayChars.length ? (charWidths[cursor] ?? 1) : 1;
  while (start < cursor && widthToCursor + cursorWidth > maxWidth) {
    widthToCursor -= charWidths[start] ?? 1;
    start++;
  }

  let end = start;
  let used = 0;
  while (end < displayChars.length) {
    const charWidth = charWidths[end] ?? 1;
    if (used + charWidth > maxWidth) break;
    used += charWidth;
    end++;
  }

  const before = displayChars.slice(start, cursor).join('');
  const at = displayChars[cursor] ?? ' ';
  const after = displayChars.slice(cursor + 1, end).join('');

  const showPlaceholder = chars.length === 0;

  return (
    <Box flexDirection="column">
      {menuOpen ? (
        <Box flexDirection="column" paddingLeft={2}>
          {visibleCommands.map((command, offset) => {
            const active = menuStart + offset === activeIndex;
            return (
              <Text
                key={command.name}
                inverse={active}
                bold={active}
                wrap="truncate-end"
              >
                {active ? '› ' : '  '}
                {command.name}
                {command.usage ? <Text dimColor={!active}>{` ${command.usage}`}</Text> : null}
                <Text dimColor={!active}>{`  ${command.description}`}</Text>
              </Text>
            );
          })}
        </Box>
      ) : null}
      <Box flexShrink={0}>
        <Text color={disabled ? 'gray' : 'cyan'} bold>
          {'› '}
        </Text>
        {disabled ? (
          <Text dimColor wrap="truncate-end">
            {placeholder}
          </Text>
        ) : showPlaceholder ? (
          <Text wrap="truncate-end">
            <Text inverse> </Text>
            <Text dimColor> {placeholder}</Text>
          </Text>
        ) : (
          <Text wrap="truncate-end">
            {before}
            <Text inverse>{at}</Text>
            {after}
          </Text>
        )}
      </Box>
    </Box>
  );
}
