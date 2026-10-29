import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AllSessionsResult, SessionSummary } from '../sessions.js';
import { pickerPopupRows, pickerRangeLabel, pickerWindow } from './model-picker.js';
import {
  buildSessionRows,
  sessionCounts,
  sessionEmptyText,
  sessionRange,
  sessionRowItems,
  sessionRowLines,
  sessionRowText,
  sessionTabLabel,
  type SessionScope,
} from './session-picker.js';

interface SessionPickerProps {
  cwd: string;
  data: AllSessionsResult;
  activeSessionId?: string | null;
  width: number;
  maxRows?: number;
  /** Fixed frame height for the centered overlay; the footer is pushed down. */
  height?: number;
  onSelect(session: SessionSummary): void;
  onCancel(): void;
}

/** Keys are highlighted so the hint reads at a glance; the rest stays dim. */
const KEY_COLOR = '#ff9e64';

function Key({ children }: { children: string }): React.JSX.Element {
  return <Text color={KEY_COLOR}>{children}</Text>;
}

function Said({ children }: { children: string }): React.JSX.Element {
  return <Text dimColor>{children}</Text>;
}

/**
 * Session picker with two tabs: the current directory and every other
 * directory that has saved sessions. Left/right switch tabs.
 */
export function SessionPicker({
  cwd,
  data,
  activeSessionId = null,
  width,
  maxRows = 8,
  height,
  onSelect,
  onCancel,
}: SessionPickerProps): React.JSX.Element {
  const [scope, setScope] = useState<SessionScope>('current');
  const [index, setIndex] = useState(0);
  const [query, setQuery] = useState('');

  const counts = sessionCounts(data);
  const rows = buildSessionRows(data, scope, cwd, query);
  const lines = sessionRowLines(rows);
  const sessions = sessionRowItems(rows);
  const count = sessions.length;
  const selected = Math.min(index, Math.max(0, count - 1));
  const selectedLine = lines[selected] ?? 0;
  const popup = height !== undefined;
  const hintRows = scope === 'others' ? 1 : 0;
  // The tab bar takes one row the model picker does not have.
  const listRows = popup ? pickerPopupRows(height, hintRows + 1) : maxRows;
  const { start, end } = pickerWindow(selectedLine, rows.length, listRows);
  const range = popup ? sessionRange(rows, start, end) : null;
  const empty = sessionEmptyText(scope, query, count > 0);
  // The opaque frame needs an explicit foreground even on light terminal themes.
  const base = popup ? 'white' : undefined;

  const switchScope = (next: SessionScope): void => {
    if (next === scope) return;
    setScope(next);
    setIndex(0);
    setQuery('');
  };

  useInput((input, key) => {
    if (key.leftArrow) {
      switchScope('current');
      return;
    }
    if (key.rightArrow) {
      switchScope('others');
      return;
    }
    if (key.tab) {
      switchScope(scope === 'current' ? 'others' : 'current');
      return;
    }
    if (key.escape) {
      if (query) {
        setQuery('');
        setIndex(0);
        return;
      }
      onCancel();
      return;
    }
    if (key.upArrow || key.downArrow) {
      if (count === 0) return;
      const delta = key.upArrow ? -1 : 1;
      setIndex(Math.min(count - 1, Math.max(0, selected + delta)));
      return;
    }
    if (key.home) {
      setIndex(0);
      return;
    }
    if (key.end) {
      setIndex(Math.max(0, count - 1));
      return;
    }
    if (!key.return) {
      if (key.backspace || key.delete) {
        if (query) {
          setQuery(query.slice(0, -1));
          setIndex(0);
        }
        return;
      }
      if (key.ctrl || key.meta || key.pageUp || key.pageDown) return;
      const typed = input.replace(/[\u0000-\u001f\u007f]/g, '');
      if (typed) {
        setQuery(query + typed);
        setIndex(0);
      }
      return;
    }
    const session = sessions[selected];
    if (session) onSelect(session);
  });

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      flexShrink={0}
      backgroundColor={popup ? 'black' : undefined}
      overflow={height === undefined ? undefined : 'hidden'}
    >
      <Text bold color="cyan" wrap="truncate-end">
        Sessions
      </Text>
      <Text color={base} wrap="truncate-end">
        <Text
          inverse={scope === 'current'}
          color={scope === 'current' ? 'cyan' : base}
        >{` ${sessionTabLabel('current', counts)} `}</Text>
        <Said>  </Said>
        <Text
          inverse={scope === 'others'}
          color={scope === 'others' ? 'cyan' : base}
        >{` ${sessionTabLabel('others', counts)} `}</Text>
      </Text>
      <Text color={base} wrap="truncate-end">
        <Said>Search: </Said>
        {query || <Said>type to filter</Said>}
      </Text>
      {rows.slice(start, end).map((row, offset) => {
        const line = start + offset;
        if (row.kind === 'header') {
          return (
            <Text key={`h${line}`} dimColor color={base} wrap="truncate-end">
              {row.text}
            </Text>
          );
        }
        const focused = line === selectedLine;
        return (
          <Text
            key={`s${line}`}
            color={focused ? 'cyan' : base}
            bold={focused}
            wrap="truncate-end"
          >
            {sessionRowText(row.session, row.session.id === activeSessionId)}
          </Text>
        );
      })}
      {empty ? (
        <Text dimColor color={base} wrap="truncate-end">
          {empty}
        </Text>
      ) : null}
      {scope === 'others' ? (
        <Text dimColor color={base} wrap="truncate-end">
          Enter resumes and switches to that directory.
        </Text>
      ) : null}
      {range ? (
        <Text dimColor color={base} wrap="truncate-end">
          {pickerRangeLabel(range)}
        </Text>
      ) : null}
      {height === undefined ? null : <Box flexGrow={1} />}
      <Text color={base} wrap="truncate-end">
        <Key>←/→</Key>
        <Said> tab · </Said>
        <Key>↑/↓</Key>
        <Said> move · </Said>
        <Key>Enter</Key>
        <Said> resume · </Said>
        <Key>Esc</Key>
        <Said>{` ${query ? 'clear search' : 'close'}`}</Said>
      </Text>
    </Box>
  );
}
