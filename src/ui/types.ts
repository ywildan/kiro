export type ToolViewStatus = 'running' | 'ok' | 'error' | 'denied';

/** Full tool output retained for the Ctrl+O expansion; capped to keep memory bounded. */
export const MAX_EXPANDED_TOOL_CHARS = 20_000;

export interface BannerItem {
  kind: 'banner';
  id: number;
  cwd: string;
  version: string;
}

export interface UserItem {
  kind: 'user';
  id: number;
  text: string;
}

export interface AssistantItem {
  kind: 'assistant';
  id: number;
  text: string;
  draft?: boolean;
}

export interface ToolItem {
  kind: 'tool';
  id: number;
  callId: string;
  name: string;
  argsSummary: string;
  status: ToolViewStatus;
  resultSummary?: string;
  /** Full result text, shown by Ctrl+O. */
  resultFull?: string;
  durationMs?: number;
}

export interface NoticeItem {
  kind: 'notice';
  id: number;
  level: 'info' | 'error' | 'muted';
  text: string;
}

export type ViewItem = BannerItem | UserItem | AssistantItem | ToolItem | NoticeItem;
