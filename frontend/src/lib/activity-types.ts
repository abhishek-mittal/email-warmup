// Shared types for the inbox activity dashboard (T027). Mirror the
// shapes returned by `GET /inboxes/:id/activity` etc. on the backend
// (`backend/src/activity/activity.controller.ts`). Kept here so the
// components don't re-declare the same interface ten times.

export type ActivityEventType =
  | 'sent'
  | 'opened'
  | 'replied'
  | 'starred'
  | 'rescued'
  | 'spam_landed'
  | 'filed'
  | 'dns_check'
  | 'blacklist_check'
  | 'score_updated';

export interface ActivityEvent {
  type: ActivityEventType;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface ActivityPage {
  events: ActivityEvent[];
  nextCursor: string | null;
}

export interface WarmupSendRow {
  id: string;
  sentAt: string | null;
  scheduledAt: string;
  subject: string | null;
  messageId: string | null;
  warmupDay: number;
  receiverEmail: string | null;
  receiverKind: 'inbox' | 'pool' | null;
  openedAt: string | null;
  repliedAt: string | null;
  starredAt: string | null;
  rescuedAt: string | null;
  filedAt: string | null;
  landedInSpam: boolean | null;
  landedInTab: string | null;
}

export interface SendsPage {
  rows: WarmupSendRow[];
  page: number;
  pageSize: number;
  total: number;
}

export interface DnsCheckHistoryRow {
  id: string;
  checkedAt: string;
  spfValid: boolean | null;
  dkimValid: boolean | null;
  dmarcValid: boolean | null;
  mxValid: boolean | null;
  rdnsValid: boolean | null;
  score: number | null;
}

export interface BlacklistCheckHistoryRow {
  id: string;
  checkedAt: string;
  isClean: boolean | null;
  listedCount: number | null;
  rblResults: Record<string, string> | null;
}

export interface PlacementHistoryRow {
  id: string;
  completedAt: string;
  seedCount: number | null;
  primaryPct: number | null;
  promotionsPct: number | null;
  spamPct: number | null;
  missingPct: number | null;
  placementScore: number | null;
}

export interface ScoreHistoryResponse {
  current: number | null;
  trend: 'up' | 'down' | 'stable';
  history: { recordedAt: string; score: number }[];
}

export interface LogLine {
  level: number;
  levelName: string;
  time: string;
  context: string | null;
  msg: string;
  [key: string]: unknown;
}

export interface LogsResponse {
  lines: LogLine[];
  totalMatched: number;
  fileFound: boolean;
}