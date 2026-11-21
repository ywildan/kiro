import React from 'react';
import { Box, Text, useInput } from 'ink';
import type { ApprovalRequest, ApprovalDecision } from '../tools/types.js';
import { MAX_PREVIEW_LINES, windowPreview } from './approval-preview.js';
import { sanitizeText, truncateToWidth, wrapPlain } from './text.js';

interface ApprovalPromptProps {
  request: ApprovalRequest;
  width: number;
  /** Pattern a `[s]` press would save; omitted when the request has no subject. */
  rulePattern?: string;
  /** Why an earlier rule refused this request, shown as a banner. */
  ruleNote?: string;
  /** Preview rows to show; shorter terminals pass a smaller number. */
  maxPreviewLines?: number;
  onDecision(decision: ApprovalDecision): void;
}

function lineColor(line: string): string | undefined {
  if (line.startsWith('+')) return 'green';
  if (line.startsWith('-')) return 'red';
  if (line.startsWith('@@')) return 'cyan';
  return undefined;
}

export function ApprovalPrompt({
  request,
  width,
  rulePattern,
  ruleNote,
  maxPreviewLines = MAX_PREVIEW_LINES,
  onDecision,
}: ApprovalPromptProps): React.JSX.Element {
  useInput((input, key) => {
    if (input === 'y' || input === 'Y') onDecision('allow');
    else if (input === 'a' || input === 'A') onDecision('allow-session');
    else if (input === 's' || input === 'S') {
      if (rulePattern) onDecision('allow-rule');
    } else if (input === 'd' || input === 'D') {
      if (request.subject !== undefined) onDecision('deny-rule');
    } else if (input === 'n' || input === 'N' || key.escape) onDecision('deny');
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
    fitted.length === 0 ? ['(no preview yet)'] : windowPreview(fitted, request.tool, maxPreviewLines);

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
      {ruleNote ? (
        <Text color="magenta" wrap="truncate-end">
          {`! ${ruleNote}`}
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
        allow {request.tool} for this session
        {rulePattern ? (
          <>
            <Text>    </Text>
            <Text color="green" bold>
              [s]
            </Text>
            <Text>{` always allow ${rulePattern}`}</Text>
          </>
        ) : null}
      </Text>
      {request.subject !== undefined ? (
        <Text dimColor wrap="truncate-end">
          <Text color="magenta" bold>
            [d]
          </Text>
          <Text>{` always deny this ${request.tool === 'run_command' ? 'command' : 'path'}`}</Text>
        </Text>
      ) : null}
    </Box>
  );
}
