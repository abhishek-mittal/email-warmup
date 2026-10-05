// Domain types mirroring the NestJS backend response shapes.

export type Plan = 'free' | 'demo' | 'trial' | 'starter' | 'growth' | 'agency' | 'enterprise';

// 'ready' = connected + verified but warmup NOT started (user must press Start).
export type InboxStatus = 'pending' | 'ready' | 'active' | 'paused' | 'error' | 'disconnected';
export type Provider = 'gmail' | 'outlook' | 'custom';

export interface Inbox {
  id: string;
  userId: string;
  email: string;
  provider: Provider;
  status: InboxStatus;
  warmupDay: number;
  warmupSpeed: 'slow' | 'medium' | 'fast' | null;
  sendingIp: string | null;
  /** Why the inbox is not warming, when it isn't (e.g. 'credentials_revoked'). */
  statusReason?: string | null;
  /** Set when the owner opted this inbox into the shared warmup pool. */
  poolConsentAt?: string | null;
  /** Present on GET /inboxes/:id: whether Start can proceed (has a partner). */
  warmupEligibility?: { canStart: boolean };
  createdAt: string;
}

export interface InboxAnalysis {
  id: string;
  inboxId: string | null;
  poolInboxId: string | null;
  spfValid: boolean | null;
  dkimValid: boolean | null;
  dmarcValid: boolean | null;
  mxValid: boolean | null;
  rdnsValid: boolean | null;
  placementEstimate: 'inbox' | 'promotions' | 'spam' | 'unknown';
  healthScore: number;
  issues: string[];
  analysedAt: string;
}

export type PoolInboxStatus = 'pending' | 'active' | 'removed' | 'error';

/**
 * Where a Warming Pool row comes from:
 *   - 'dedicated' — a `pool_inboxes` row (added via CSV / wizard upload)
 *   - 'owned'     — one of the user's own connected inboxes that consented
 *                   to the shared pool. Managed from the inbox detail page.
 */
export type PoolInboxSource = 'dedicated' | 'owned';

export interface PoolInbox {
  id: string;
  userId: string;
  email: string;
  provider: Provider;
  // Owned rows carry raw inbox statuses (e.g. 'paused', 'graduated') too.
  status: PoolInboxStatus | 'paused' | 'graduated' | 'disconnected';
  displayName: string | null;
  lastUsedAt: string | null;
  activePairs: number;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  source: PoolInboxSource;
  analysis: InboxAnalysis | null;
}

export interface DnsCheckLatest {
  spfValid: boolean | null;
  dkimValid: boolean | null;
  dmarcValid: boolean | null;
  mxValid: boolean | null;
  rdnsValid: boolean | null;
  sendingIp: string | null;
  checkedAt: string | null;
}

export interface BlacklistCheckLatest {
  listed: boolean;
  rblResults: { zone: string; status: string }[];
  checkedAt: string | null;
}

export interface PlacementLatest {
  status: 'pending' | 'complete';
  primary: number;
  promotions: number;
  spam: number;
  missing?: number;
  seedCount: number;
  completedAt: string | null;
  placementScore: number | null;
}

export interface PlacementQuota {
  used: number;
  limit: number;
  plan: Plan;
}

export interface ScoreResponse {
  current: number | null;
  trend: 'up' | 'down' | 'stable';
  breakdown: { dns: number; blacklist: number; placement: number } | null;
  history: { date: string; score: number }[];
}

export interface DiagnosticAnalysis {
  primaryCause: string;
  causes: { code: string; explanation: string; priority: 'critical' | 'warning' | 'info' }[];
  fixes: { step: number; action: string; expectedImpact: string }[];
  estimatedRecoveryDays: number;
}

export interface ReadinessReport {
  inboxId: string;
  generatedAt: string;
  warmupDaysCompleted: number;
  reputationScore: number;
  primaryPlacementPct: number | null;
  recommendedDailySendVolume: number;
  warmupPoolContribution: string;
  nextSteps: string[];
  riskFactors: string[];
}

export interface DiagnosticsResponse {
  issueCodes: string[];
  aiAnalysis: DiagnosticAnalysis | null;
  readinessReport: ReadinessReport | null;
  createdAt: string | null;
}

export interface BillingStatus {
  plan: Plan;
  trialEndsAt: string | null;
  inboxesUsed: number;
  inboxLimit: number | 'unlimited';
  billingPortalUrl: string | null;
}

export interface CheckoutResponse {
  url: string;
}

export interface IssueCatalogEntry {
  code: string;
  title: string;
  severity: 'critical' | 'warning' | 'info';
  icon: string;
  explanation: string;
  fixSteps: string[];
}
