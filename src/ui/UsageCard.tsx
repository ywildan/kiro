import React from 'react';
import { Box, Text } from 'ink';
import { formatPercent, formatTokens } from '../agent/tokens.js';
import type { UsageTotals } from '../usage.js';
import { formatDuration, truncateToWidth } from './text.js';

export const USAGE_CARD_WIDTH = 27;
/** Space between the transcript column and the card. */
export const USAGE_CARD_GAP = 2;
/** Below this the card would squeeze the transcript too much, so it hides. */
export const USAGE_CARD_MIN_COLUMNS = 110;
export const USAGE_CARD_MIN_ROWS = 9;

export interface LastReplyStats {
  durationMs: number;
  tokensPerSecond?: number;
}

/** The card needs its own column (Ink cannot overlay reliably), so space is a hard requirement. */
export function shouldShowUsageCard(columns: number, viewportHeight: number): boolean {
  return columns >= USAGE_CARD_MIN_COLUMNS && viewportHeight >= USAGE_CARD_MIN_ROWS;
}

export function contextBar(used: number, window: number, width: number): string {
  const size = Math.max(1, Math.floor(width));
  const ratio = window > 0 ? Math.min(1, Math.max(0, used / window)) : 0;
  const filled = Math.min(size, Math.round(ratio * size));
  return `${'█'.repeat(filled)}${'░'.repeat(size - filled)}`;
}

interface UsageCardProps {
  usage: UsageTotals;
  contextTokens: number;
  contextWindow: number;
  /** True while the context count comes from the character estimate, not the endpoint. */
  contextEstimated: boolean;
  lastReply?: LastReplyStats | null;
  busy: boolean;
  width?: number;
}

export function UsageCard({
  usage,
  contextTokens,
  contextWindow,
  contextEstimated,
  lastReply,
  busy,
  width = USAGE_CARD_WIDTH,
}: UsageCardProps): React.JSX.Element {
  const accent = busy ? 'cyan' : 'gray';
  const innerWidth = Math.max(8, width - 4);
  const title = truncateToWidth(`Usage · ${usage.requests} req`, innerWidth);
  const prompt = usage.requests > 0 ? formatTokens(usage.promptTokens) : '—';
  const completion = usage.requests > 0 ? formatTokens(usage.completionTokens) : '—';
  const bar = contextBar(contextTokens, contextWindow, Math.max(4, innerWidth - 9));
  const contextLine = truncateToWidth(
    `ctx ${bar} ${formatPercent(contextTokens, contextWindow).padStart(4)}`,
    innerWidth,
  );
  const windowLine = truncateToWidth(
    `${contextEstimated ? '~' : ''}${formatTokens(contextTokens)} / ${formatTokens(contextWindow)} window`,
    innerWidth,
  );
  const speed =
    lastReply?.tokensPerSecond !== undefined
      ? lastReply.tokensPerSecond >= 1_000
        ? `${formatTokens(lastReply.tokensPerSecond)} tok/s`
        : `${lastReply.tokensPerSecond} tok/s`
      : '';
  const lastLine = truncateToWidth(
    lastReply
      ? `last ${formatDuration(lastReply.durationMs)}${speed ? ` · ${speed}` : ''}`
      : 'no timed reply yet',
    innerWidth,
  );

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="round"
      borderColor={accent}
      paddingX={1}
      flexShrink={0}
    >
      <Text bold color={accent} wrap="truncate-end">
        {title}
      </Text>
      <Text wrap="truncate-end">
        <Text color="green">↑ {prompt}</Text>
        <Text>  </Text>
        <Text color="blue">↓ {completion}</Text>
      </Text>
      <Text dimColor wrap="truncate-end">
        {contextLine}
      </Text>
      <Text dimColor wrap="truncate-end">
        {windowLine}
      </Text>
      <Text dimColor wrap="truncate-end">
        {lastLine}
      </Text>
    </Box>
  );
}
