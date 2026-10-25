import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { homedir } from 'node:os';
import { formatTokens } from '../agent/tokens.js';
import { displayWidth, truncateMiddle, truncateToWidth } from './text.js';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export type Activity = 'thinking' | 'replying' | 'running' | 'cancelling' | 'approval' | null;

interface StatusBarProps {
  width: number;
  profile: string;
  model: string;
  cwd: string;
  activity: Activity;
  toolName?: string;
  /** When the current turn started; drives the live elapsed counter. */
  busySince?: number;
  /** Number of messages typed during a turn, waiting to run. */
  queued?: number;
  yolo?: boolean;
  autoAllowed?: string[];
  /** Replaces the idle state with a quit confirmation hint. */
  quitHint?: boolean;
  contextTokens?: number;
  contextWindow?: number;
}

function prettyCwd(cwd: string): string {
  const home = homedir();
  if (cwd === home) return '~';
  if (cwd.startsWith(home + '/') || cwd.startsWith(home + '\\')) {
    return `~${cwd.slice(home.length)}`;
  }
  return cwd;
}

export function StatusBar({
  width,
  profile,
  model,
  cwd,
  activity,
  toolName,
  busySince,
  queued,
  yolo = false,
  autoAllowed = [],
  quitHint = false,
  contextTokens,
  contextWindow,
}: StatusBarProps): React.JSX.Element {
  const busy = activity !== null;
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!busy) return;
    const interval = setInterval(() => setFrame((current) => (current + 1) % SPINNER.length), 100);
    return () => clearInterval(interval);
  }, [busy]);

  const stateText = quitHint
    ? 'Ctrl+C again to quit'
    : activity === 'approval'
      ? 'approval needed'
      : activity === 'cancelling'
        ? 'cancelling…'
        : activity === 'running'
          ? `running ${toolName ?? 'tool'}…`
          : activity === 'replying'
            ? 'replying…'
            : activity === 'thinking'
              ? 'thinking…'
              : 'ready';
  const stateColor = quitHint
    ? 'red'
    : activity === 'cancelling'
      ? 'red'
      : activity === null
        ? 'green'
        : 'yellow';
  const spinner = busy ? `${SPINNER[frame] ?? '⠋'} ` : '';
  const elapsedMs = busy && busySince !== undefined ? Math.max(0, Date.now() - busySince) : 0;
  // Whole seconds keep the re-rendering spinner from making the timer flicker.
  const elapsedNote = elapsedMs >= 1_000 ? ` · ${Math.floor(elapsedMs / 1_000)}s` : '';
  const queueNote = queued ? `${queued} queued · ` : '';
  const badge = yolo
    ? 'YOLO'
    : autoAllowed.length > 0
      ? `auto:${autoAllowed.join(',')}`
      : '';
  const badgeWidth = badge === '' ? 0 : displayWidth(badge) + 2;
  // The bar is indented to line up with the chat text, so budgets use the inner width.
  const innerWidth = Math.max(10, width - 2);
  const state = `${spinner}${queueNote}${stateText}${elapsedNote}`;
  const stateBudget = Math.max(4, Math.max(10, Math.floor(innerWidth / 2)) - badgeWidth);
  const stateShown = truncateToWidth(state, stateBudget);
  const restBudget = Math.max(0, innerWidth - badgeWidth - displayWidth(stateShown) - 2 - 6);
  const context =
    contextTokens !== undefined && contextWindow !== undefined
      ? ` · ctx ${formatTokens(contextTokens)}/${formatTokens(contextWindow)}`
      : '';
  const tail = ` · ${model} · ${prettyCwd(cwd)}${context}`;
  const tailWidth = displayWidth(tail);
  const rest =
    restBudget <= 0
      ? ''
      : displayWidth(profile) + tailWidth <= restBudget
        ? `${profile}${tail}`
        : restBudget >= tailWidth + 4
          ? `${truncateMiddle(profile, restBudget - tailWidth)}${tail}`
          : truncateMiddle(`${profile}${tail}`, restBudget);

  return (
    <Box width={width} flexShrink={0} justifyContent="space-between" paddingLeft={2}>
      <Text wrap="truncate-end">
        <Text color="cyan" bold>
          Kiro
        </Text>
        {rest ? <Text dimColor>{`  ${rest}`}</Text> : null}
      </Text>
      <Text wrap="truncate-end">
        {badge === '' ? null : (
          <Text bold color={yolo ? 'red' : 'magenta'}>
            {badge}
          </Text>
        )}
        <Text color={stateColor}>{badge === '' ? stateShown : `  ${stateShown}`}</Text>
      </Text>
    </Box>
  );
}
