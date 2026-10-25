import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { KiroConfig } from '../config.js';
import {
  filterModelIds,
  modelIds,
  pickerWindow,
  profileRows,
  selectableLines,
  selectableNames,
} from './model-picker.js';

export interface ModelRefreshResult {
  ok: boolean;
  message?: string;
}

interface ModelPickerProps {
  config: KiroConfig;
  /** The profile the session is using, not necessarily `config.activeProfile`. */
  activeProfile: string;
  width: number;
  maxRows?: number;
  onSelect(profile: string, model: string): void;
  onRefresh(profile: string): Promise<ModelRefreshResult>;
  onCancel(): void;
}

type Step = { kind: 'profile' } | { kind: 'model'; profile: string };

/** Keys are highlighted so the hint reads at a glance; the rest stays dim. */
const KEY_COLOR = '#ff9e64';

function Key({ children }: { children: string }): React.JSX.Element {
  return <Text color={KEY_COLOR}>{children}</Text>;
}

function Said({ children }: { children: string }): React.JSX.Element {
  return <Text dimColor>{children}</Text>;
}

/**
 * Two-step picker: profiles (grouped by endpoint) first, then the models stored
 * for that profile. It only reads config; the owner persists the choice.
 */
export function ModelPicker({
  config,
  activeProfile,
  width,
  maxRows = 8,
  onSelect,
  onRefresh,
  onCancel,
}: ModelPickerProps): React.JSX.Element {
  const [step, setStep] = useState<Step>({ kind: 'profile' });
  const [index, setIndex] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const rows = profileRows(config, activeProfile);
  const names = selectableNames(rows);
  const lines = selectableLines(rows);
  const profile = step.kind === 'model' ? config.profiles[step.profile] : undefined;
  const allModels = modelIds(profile);
  const models = step.kind === 'model' ? filterModelIds(allModels, query) : allModels;
  const count = step.kind === 'profile' ? names.length : models.length;
  const selected = Math.min(index, Math.max(0, count - 1));
  const selectedLine = step.kind === 'profile' ? (lines[selected] ?? 0) : selected;
  const total = step.kind === 'profile' ? rows.length : models.length;
  const { start, end } = pickerWindow(selectedLine, total, maxRows);

  const refresh = async (name: string): Promise<void> => {
    setRefreshing(true);
    setError(null);
    const result = await onRefresh(name);
    setRefreshing(false);
    if (result.ok) setIndex(0);
    else setError(result.message ?? 'Could not fetch the model list.');
  };

  useInput((input, key) => {
    if (refreshing) return;
    if (step.kind === 'model' && key.ctrl && input === 'r') {
      void refresh(step.profile);
      return;
    }
    if (key.escape) {
      if (step.kind === 'model' && query) {
        setQuery('');
        setIndex(0);
        setError(null);
        return;
      }
      if (step.kind === 'model') {
        setStep({ kind: 'profile' });
        setIndex(0);
        setQuery('');
        setError(null);
      } else {
        onCancel();
      }
      return;
    }
    if (key.upArrow || key.downArrow) {
      if (count === 0) return;
      const delta = key.upArrow ? -1 : 1;
      setIndex(Math.min(count - 1, Math.max(0, selected + delta)));
      return;
    }
    if (step.kind === 'model' && !key.return) {
      if (key.backspace || key.delete) {
        if (query) {
          setQuery(query.slice(0, -1));
          setIndex(0);
        }
        return;
      }
      if (key.ctrl || key.meta || key.tab || key.pageUp || key.pageDown) return;
      const typed = input.replace(/[\u0000-\u001f\u007f]/g, '');
      if (typed) {
        setQuery(query + typed);
        setIndex(0);
      }
      return;
    }
    if (!key.return) return;
    if (step.kind === 'profile') {
      const name = names[selected];
      if (!name) return;
      setStep({ kind: 'model', profile: name });
      setIndex(0);
      setQuery('');
      setError(null);
      return;
    }
    const model = models[selected];
    if (model) onSelect(step.profile, model);
  });

  const title =
    step.kind === 'profile'
      ? `Model · ${names.length} profile${names.length === 1 ? '' : 's'}`
      : query.trim()
        ? `Models · ${step.profile} (${models.length}/${allModels.length} match)`
        : `Models · ${step.profile} (${models.length})`;

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      flexShrink={0}
    >
      <Text bold color="cyan" wrap="truncate-end">
        {title}
      </Text>
      {step.kind === 'model' ? (
        <Text wrap="truncate-end">
          <Said>Search: </Said>
          {query || <Said>type to filter</Said>}
        </Text>
      ) : null}
      {step.kind === 'profile'
        ? rows.slice(start, end).map((row, offset) => {
            const line = start + offset;
            if (row.kind === 'header') {
              return (
                <Text key={`h${line}`} dimColor wrap="truncate-end">
                  {row.text}
                </Text>
              );
            }
            const focused = line === selectedLine;
            return (
              <Text
                key={`p${line}`}
                color={focused ? 'cyan' : undefined}
                bold={focused}
                wrap="truncate-end"
              >
                {`   ${row.active ? '*' : ' '} ${row.name}  ${row.model}`}
              </Text>
            );
          })
        : models.slice(start, end).map((id, offset) => {
            const line = start + offset;
            const focused = line === selectedLine;
            return (
              <Text
                key={`m${line}`}
                color={focused ? 'cyan' : undefined}
                bold={focused}
                wrap="truncate-end"
              >
                {`   ${id === profile?.model ? '*' : ' '} ${id}`}
              </Text>
            );
          })}
      {step.kind === 'model' && models.length === 0 ? (
        <Text dimColor wrap="truncate-end">
          No models match &quot;{query}&quot;. Backspace to edit, Esc to clear.
        </Text>
      ) : null}
      {step.kind === 'model' && profile && !profile.models?.length ? (
        <Text wrap="truncate-end">
          <Said>Only the active model is stored; press </Said>
          <Key>Ctrl+R</Key>
          <Said> to fetch this endpoint.</Said>
        </Text>
      ) : null}
      {error ? (
        <Text color="red" wrap="truncate-end">
          {error}
        </Text>
      ) : null}
      {step.kind === 'profile' ? (
        <Text wrap="truncate-end">
          <Key>↑/↓</Key>
          <Said> move · </Said>
          <Key>Enter</Key>
          <Said> choose profile · </Said>
          <Key>Esc</Key>
          <Said> close</Said>
        </Text>
      ) : refreshing ? (
        <Text dimColor wrap="truncate-end">
          Fetching models…
        </Text>
      ) : (
        <Text wrap="truncate-end">
          <Key>↑/↓</Key>
          <Said> move · </Said>
          <Key>Enter</Key>
          <Said> use · type to filter · </Said>
          <Key>Ctrl+R</Key>
          <Said> refetch · </Said>
          <Key>Esc</Key>
          <Said>{query ? ' clear search' : ' back'}</Said>
        </Text>
      )}
    </Box>
  );
}
