// Pool inbox activity dashboard types (T028). Mirror the shapes
// returned by `GET /pool-inboxes/:id/{activity,activity-stats,pairings,
// logs,connection-summary}` on the backend
// (`backend/src/pool-inbox-activity/pool-inbox-activity.controller.ts`).

export type PoolActivityEventType =
  | 'received'
  | 'opened'
  | 'starred'
  | 'replied'
  | 'rescued'
  | 'spam_landed'
  | 'filed';

export interface PoolActivityEvent {
  type: PoolActivityEventType;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface PoolActivityPage {
  events: PoolActivityEvent[];
  nextCursor: string | null;
}

export interface PoolActivityStats {
  received: number;
  opened: number;
  replied: number;
  rescued: number;
  spamCount: number;
  /** 0-100 or null when no receives yet. */
  openRate: number | null;
  replyRate: number | null;
  spamRate: number | null;
}

export interface PoolPairingRow {
  inboxId: string;
  inboxEmail: string;
  inboxProvider: string;
  warmupDay: number;
  emailsSent: number;
  lastSendAt: string | null;
  status: string;
}

export interface PoolPairingsResponse {
  activePairs: number;
  pairings: PoolPairingRow[];
}

export interface PoolLogLine {
  level: number;
  levelName: string;
  time: string;
  context: string | null;
  msg: string;
  [key: string]: unknown;
}

export interface PoolLogsResponse {
  lines: PoolLogLine[];
  totalMatched: number;
  fileFound: boolean;
}

export interface PoolConnectionSummary {
  provider: string;
  /** OAuth (gmail/outlook) only */
  oauthClientIdPrefix?: string;
  clientSecretPresent?: boolean;
  refreshTokenPresent?: boolean;
  /** Custom SMTP only */
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPasswordPresent?: boolean;
  /** Always present */
  imapConfigured: boolean;
  imapHost?: string;
  imapPort?: number;
  imapUser?: string;
  imapPasswordPresent?: boolean;
}

export interface PoolLiveJob {
  jobId: string;
  actions: string[];
  senderEmail: string | null;
  executeAt: string;
  state: 'active' | 'delayed' | 'waiting';
}

export interface PoolLiveStatus {
  active: PoolLiveJob[];
  upcoming: PoolLiveJob[];
}
