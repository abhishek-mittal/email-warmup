import { serverApi } from '@/lib/api-server';
import type { ScoreResponse, DiagnosticsResponse } from '@/lib/types';

export async function getInboxScores(inboxId: string): Promise<ScoreResponse | null> {
  try {
    return await serverApi<ScoreResponse>(`/inboxes/${inboxId}/score`);
  } catch {
    return null;
  }
}

export async function getInboxIssues(inboxId: string): Promise<string[]> {
  try {
    const d = await serverApi<DiagnosticsResponse>(`/inboxes/${inboxId}/diagnostics`);
    return d.issueCodes ?? [];
  } catch {
    return [];
  }
}

export async function getLatestPlacementTest(
  inboxId: string,
): Promise<{
  status: 'pending' | 'complete';
  primary: number;
  promotions: number;
  spam: number;
  seedCount: number;
  completedAt: string | null;
  placementScore: number | null;
} | null> {
  try {
    const list = await serverApi<
      Array<{
        status: 'pending' | 'complete';
        primaryPct: number | null;
        promotionsPct: number | null;
        spamPct: number | null;
        missingPct: number | null;
        placementScore: number | null;
        completedAt: string | null;
      }>
    >(`/inboxes/${inboxId}/placement-tests`);
    const latest = list?.[0];
    if (!latest) return null;
    return {
      status: latest.status,
      primary: latest.primaryPct ?? 0,
      promotions: latest.promotionsPct ?? 0,
      spam: latest.spamPct ?? 0,
      seedCount:
        (latest.primaryPct ?? 0) +
        (latest.promotionsPct ?? 0) +
        (latest.spamPct ?? 0) +
        (latest.missingPct ?? 0),
      completedAt: latest.completedAt,
      placementScore: latest.placementScore,
    };
  } catch {
    return null;
  }
}

export async function getLatestDnsCheck(inboxId: string): Promise<{
  spfValid: boolean | null;
  dkimValid: boolean | null;
  dmarcValid: boolean | null;
  mxValid: boolean | null;
  rdnsValid: boolean | null;
  sendingIp: string | null;
  checkedAt: string | null;
} | null> {
  try {
    // The backend does not yet expose a `/dns/latest` controller — derive from
    // the latest diagnostics row instead, which embeds the DNS check result.
    const diag = await serverApi<{ issueCodes: string[]; createdAt: string | null }>(
      `/inboxes/${inboxId}/diagnostics`,
    );
    return {
      spfValid: !diag.issueCodes.includes('SPF_MISSING'),
      dkimValid: !diag.issueCodes.includes('DKIM_MISSING'),
      dmarcValid: !diag.issueCodes.includes('DMARC_MISSING'),
      mxValid: !diag.issueCodes.includes('MX_MISSING'),
      rdnsValid: !diag.issueCodes.includes('RDNS_MISSING'),
      sendingIp: null,
      checkedAt: diag.createdAt,
    };
  } catch {
    return null;
  }
}

export async function getLatestBlacklistCheck(inboxId: string): Promise<{
  listed: boolean;
  rblResults: { zone: string; status: string }[];
  checkedAt: string | null;
} | null> {
  try {
    const diag = await serverApi<{ issueCodes: string[]; createdAt: string | null }>(
      `/inboxes/${inboxId}/diagnostics`,
    );
    return {
      listed: diag.issueCodes.includes('BLACKLIST_HIT'),
      rblResults: diag.issueCodes.includes('BLACKLIST_HIT')
        ? [{ zone: 'Detected via diagnostics', status: 'listed' }]
        : [],
      checkedAt: diag.createdAt,
    };
  } catch {
    return null;
  }
}

export function summarizeIssues(codes: string[]): { critical: number; warning: number } {
  const critical = codes.filter((c) =>
    ['SPF_MISSING', 'DKIM_MISSING', 'MX_MISSING', 'BLACKLIST_HIT', 'SPAM_RATE_HIGH'].includes(c),
  ).length;
  const warning = codes.filter((c) =>
    ['DMARC_MISSING', 'RDNS_MISSING', 'PROMOTIONS_RATE_HIGH'].includes(c),
  ).length;
  return { critical, warning };
}
