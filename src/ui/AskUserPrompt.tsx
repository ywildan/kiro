import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AskUserAnswer, AskUserRequest } from '../tools/types.js';
import { sanitizeText, truncateToWidth, wrapPlain } from './text.js';

interface AskUserPromptProps {
  request: AskUserRequest;
  width: number;
  /** Fixed frame height for the centered overlay; the footer is pushed down. */
  height?: number;
  onAnswer(answer: AskUserAnswer): void;
  onCancel(): void;
}

/** Keys are highlighted so the hint reads at a glance; the rest stays dim. */
const KEY_COLOR = '#ff9e64';
const MAX_QUESTION_LINES = 3;

function Key({ children }: { children: string }): React.JSX.Element {
  return <Text color={KEY_COLOR}>{children}</Text>;
}

function Said({ children }: { children: string }): React.JSX.Element {
  return <Text dimColor>{children}</Text>;
}

/**
 * Blocking question with a short choice list. Enter picks (or submits the
 * checked set), Space toggles in multi-select mode, and typing jumps to the
 * free-form "Other" row when the request allows it.
 */
export function AskUserPrompt({
  request,
  width,
  height,
  onAnswer,
  onCancel,
}: AskUserPromptProps): React.JSX.Element {
  const [index, setIndex] = useState(0);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const rows = request.options.length + (request.allowOther ? 1 : 0);
  const selected = Math.min(index, Math.max(0, rows - 1));
  const otherIndex = request.allowOther ? request.options.length : -1;
  const popup = height !== undefined;
  const base = popup ? 'white' : undefined;

  const submit = (labels: string[], other?: string): void => {
    if (labels.length === 0 && !other?.trim()) return;
    onAnswer({ selected: labels, other: other?.trim() || undefined, cancelled: false });
  };

  useInput((input, key) => {
    if (editing) {
      if (key.escape) {
        setEditing(false);
        setDraft('');
        return;
      }
      if (key.return) {
        submit([...checked], draft);
        return;
      }
      if (key.backspace || key.delete) {
        setDraft(draft.slice(0, -1));
        return;
      }
      if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.pageUp || key.pageDown) {
        return;
      }
      const typed = input.replace(/[\u0000-\u001f\u007f]/g, '');
      if (typed) setDraft(draft + typed);
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow || key.downArrow) {
      if (rows === 0) return;
      const delta = key.upArrow ? -1 : 1;
      setIndex(Math.min(rows - 1, Math.max(0, selected + delta)));
      return;
    }
    if (key.home) {
      setIndex(0);
      return;
    }
    if (key.end) {
      setIndex(Math.max(0, rows - 1));
      return;
    }
    if (input === ' ' && request.multiSelect && selected !== otherIndex) {
      const label = request.options[selected]?.label;
      if (!label) return;
      const next = new Set(checked);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      setChecked(next);
      return;
    }
    if (!key.return) {
      if (!request.allowOther || key.ctrl || key.meta || key.tab) return;
      const typed = input.replace(/[\u0000-\u001f\u007f]/g, '');
      if (!typed) return;
      setIndex(otherIndex);
      setEditing(true);
      setDraft(typed);
      return;
    }
    if (selected === otherIndex) {
      setEditing(true);
      return;
    }
    const option = request.options[selected];
    if (!option) return;
    if (!request.multiSelect) {
      submit([option.label]);
      return;
    }
    const labels = new Set(checked);
    if (labels.size === 0) labels.add(option.label);
    submit([...labels]);
  });

  const innerWidth = Math.max(10, width - 4);
  const questionLines = wrapPlain(sanitizeText(request.question), innerWidth);
  const clipped = questionLines.slice(0, MAX_QUESTION_LINES);
  if (questionLines.length > MAX_QUESTION_LINES) {
    const last = clipped.length - 1;
    clipped[last] = `${truncateToWidth(clipped[last] ?? '', innerWidth - 2)} …`;
  }
  const title = `? ${request.header ?? 'Question'}`;

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="round"
      borderColor="magenta"
      paddingX={1}
      flexShrink={0}
      backgroundColor={popup ? 'black' : undefined}
      overflow={height === undefined ? undefined : 'hidden'}
    >
      <Text bold color="magenta" wrap="truncate-end">
        {title}
      </Text>
      {clipped.map((line, lineIndex) => (
        <Text key={`q${lineIndex}`} color={base} wrap="truncate-end">
          {line || ' '}
        </Text>
      ))}
      {request.options.map((option, optionIndex) => {
        const focused = optionIndex === selected;
        const mark = request.multiSelect ? (checked.has(option.label) ? '[x]' : '[ ]') : ' ';
        return (
          <Text
            key={`o${optionIndex}`}
            color={focused ? 'magenta' : base}
            bold={focused}
            wrap="truncate-end"
          >
            {`${focused ? '>' : ' '} ${mark} ${optionIndex + 1}. ${option.label}`}
            {option.description ? <Said>{`  ${option.description}`}</Said> : null}
          </Text>
        );
      })}
      {request.allowOther ? (
        <Text color={selected === otherIndex ? 'magenta' : base} bold={selected === otherIndex}>
          {`${selected === otherIndex ? '>' : ' '}${request.multiSelect ? '     ' : '   '}` +
            `${request.options.length + 1}. Other: `}
          {editing ? (
            <Text color={base}>{`${draft || ''}▌`}</Text>
          ) : (
            <Said>type an answer</Said>
          )}
        </Text>
      ) : null}
      {height === undefined ? null : <Box flexGrow={1} />}
      {editing ? (
        <Text color={base} wrap="truncate-end">
          <Key>Enter</Key>
          <Said> submit · type your answer · </Said>
          <Key>Esc</Key>
          <Said> back</Said>
        </Text>
      ) : (
        <Text color={base} wrap="truncate-end">
          <Key>↑/↓</Key>
          <Said> move · </Said>
          {request.multiSelect ? (
            <>
              <Key>Space</Key>
              <Said> toggle · </Said>
              <Key>Enter</Key>
              <Said> submit · </Said>
            </>
          ) : (
            <>
              <Key>Enter</Key>
              <Said> choose · </Said>
            </>
          )}
          <Key>Esc</Key>
          <Said> cancel</Said>
        </Text>
      )}
    </Box>
  );
}
