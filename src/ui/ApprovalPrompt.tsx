import React from 'react';
import { Box, Text, useInput } from 'ink';
import type { ApprovalRequest, ApprovalDecision } from '../tools/types.js';
import { sanitizeText, truncateToWidth, wrapPlain } from './text.js';

interface ApprovalPromptProps {
  request: ApprovalRequest;
  width: number;
  onDecision(decision: ApprovalDecision): void;
}

const MAX_PREVIEW_LINES = 5;

export function ApprovalPrompt({ request, width, onDecision }: ApprovalPromptProps): React.JSX.Element {
  useInput((input, key) => {
    if (input === 'y' || input === 'Y') onDecision('allow');
    else if (input === 'a' || input === 'A') onDecision('allow-session');
    else if (input === 'n' || input === 'N' || key.escape) onDecision('deny');
  });

  const innerWidth = Math.max(10, width - 4);
  const rawDetail = sanitizeText(request.detail ?? '').split('\n');
  let previewLines: string[];
  let truncated: boolean;
  if (request.tool === 'run_command') {
    const wrapped = rawDetail.flatMap((line) => wrapPlain(line, innerWidth));
    previewLines = wrapped.slice(0, MAX_PREVIEW_LINES);
    truncated = wrapped.length > MAX_PREVIEW_LINES;
  } else {
    previewLines = rawDetail
      .slice(0, MAX_PREVIEW_LINES)
      .map((line) => truncateToWidth(line, innerWidth));
    truncated = rawDetail.length > MAX_PREVIEW_LINES;
  }
  if (truncated && previewLines.length > 0) {
    const last = previewLines.length - 1;
    previewLines[last] = `${truncateToWidth(previewLines[last] ?? '', innerWidth - 2)} …`;
  }
  if (previewLines.length === 0) previewLines = ['(no preview)'];

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      flexShrink={0}
    >
      <Text bold color="yellow" wrap="truncate-end">
        {`⚠ Approval needed · ${request.title}`}
      </Text>
      {request.warning ? (
        <Text color="red" wrap="truncate-end">
          {`! ${request.warning}`}
        </Text>
      ) : null}
      {previewLines.map((line, index) => {
        const color =
          request.tool !== 'run_command'
            ? line.startsWith('+') && !line.startsWith('+++')
              ? 'green'
              : line.startsWith('-') && !line.startsWith('---')
                ? 'red'
                : line.startsWith('@@')
                  ? 'cyan'
                  : undefined
            : undefined;
        return (
          <Text
            key={index}
            color={color}
            dimColor={color === undefined}
            wrap="truncate-end"
          >
            {line || ' '}
          </Text>
        );
      })}
      <Text wrap="truncate-end">
        <Text color="green" bold>
          [y]
        </Text>
        <Text> allow once    </Text>
        <Text color="red" bold>
          [n]
        </Text>
        <Text> deny</Text>
      </Text>
      <Text dimColor wrap="truncate-end">
        <Text color="cyan" bold>
          [a]
        </Text>{' '}
        always allow {request.tool} for this session
      </Text>
    </Box>
  );
}
