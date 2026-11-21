import React from 'react';
import { Box, Text, useInput } from 'ink';
import type { ApprovalRequest, ApprovalDecision } from '../tools/types.js';
import { MAX_PREVIEW_LINES, windowPreview } from './approval-preview.js';
import { sanitizeText, truncateToWidth, wrapPlain } from './text.js';

interface ApprovalPromptProps {
  request: ApprovalRequest;
  width: number;
  onDecision(decision: ApprovalDecision): void;
}

function lineColor(line: string): string | undefined {
  if (line.startsWith('+')) return 'green';
  if (line.startsWith('-')) return 'red';
  if (line.startsWith('@@')) return 'cyan';
  return undefined;
}

export function ApprovalPrompt({ request, width, onDecision }: ApprovalPromptProps): React.JSX.Element {
  useInput((input, key) => {
    if (input === 'y' || input === 'Y') onDecision('allow');
    else if (input === 'a' || input === 'A') onDecision('allow-session');
    else if (input === 'n' || input === 'N' || key.escape) onDecision('deny');
  });

  const innerWidth = Math.max(10, width - 4);
  const detail = sanitizeText(request.detail ?? '').trimEnd();
  const rawDetail = detail ? detail.split('\n') : [];
  // Commands are wrapped so a long line does not hide the rest of the script;
  // diffs are clipped, since a wrapped diff row reads as a different change.
  const fitted =
    request.tool === 'run_command'
      ? rawDetail.flatMap((line) => wrapPlain(line, innerWidth))
      : rawDetail.map((line) => truncateToWidth(line, innerWidth));
  const previewLines =
    fitted.length === 0 ? ['(no preview yet)'] : windowPreview(fitted, request.tool, MAX_PREVIEW_LINES);

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
        const color = request.tool === 'run_command' ? undefined : lineColor(line);
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
