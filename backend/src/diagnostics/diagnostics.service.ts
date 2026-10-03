import { Injectable } from '@nestjs/common';
import { desc, eq, inArray, and } from 'drizzle-orm';
import { db } from '../db';
import {
  dnsChecks,
  blacklistChecks,
  placementTests,
  diagnostics,
  users,
  inboxes,
} from '../db/schema';
import { AiAnalyzerService, DiagnosticAnalysis } from './ai-analyzer.service';

export type DiagnosticTriggerType = 'auto_blacklist' | 'auto_drop' | 'auto_spam' | 'manual';

type DnsCheckRow = typeof dnsChecks.$inferSelect;
type BlacklistCheckRow = typeof blacklistChecks.$inferSelect;
type PlacementTestRow = typeof placementTests.$inferSelect;

/** Plans entitled to AI cause analysis (Growth+ only — see addendum #2). */
const AI_ANALYSIS_PLANS = new Set(['growth', 'agency', 'enterprise']);

/**
 * No exact threshold is given anywhere in the spec/skill file for
 * PROMOTIONS_RATE_HIGH — 30% is this controller's judgment call (see T015
 * context addendum #1).
 */
const PROMOTIONS_RATE_HIGH_THRESHOLD = 30;
const SPAM_RATE_HIGH_THRESHOLD = 20;

@Injectable()
export class DiagnosticsService {
  constructor(private readonly aiAnalyzerService: AiAnalyzerService) {}

  /**
   * Runs for every plan — issue codes are always computed and stored. Only the
   * AI explanation is plan-gated (Growth+); lower plans get `aiAnalysis: null`
   * in the stored row, never a thrown error. See T015 context addendum #2.
   */
  async triggerDiagnostics(inboxId: string, triggerType: DiagnosticTriggerType): Promise<string> {
    const [dns, blacklist, placement] = await Promise.all([
      this.getLatestDnsCheck(inboxId),
      this.getLatestBlacklistCheck(inboxId),
      this.getLatestPlacementTest(inboxId),
    ]);

    const issueCodes = this.deriveIssueCodes(dns, blacklist, placement);

    let aiAnalysis: DiagnosticAnalysis | null = null;
    const inboxRows = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    const inbox = inboxRows[0];
    if (inbox && (await this.isAiEligible(inbox.userId))) {
      aiAnalysis = await this.aiAnalyzerService.analyzeSpamIssues(inbox, dns, blacklist, placement);
    }

    const [row] = await db
      .insert(diagnostics)
      .values({
        inboxId,
        triggerType,
        issueCodes,
        aiAnalysis,
      })
      .returning({ id: diagnostics.id });

    return row.id;
  }

  /**
   * Derives only the 10 issue codes backed by real detection logic in this
   * codebase (LOW_ENGAGEMENT/TOKEN_EXPIRED/WARMUP_TOO_FAST/VOLUME_TOO_HIGH are
   * deliberately out of scope — see T015 context addendum #1). Absence of a
   * check category (null row) never itself produces an issue code.
   */
  deriveIssueCodes(
    dns: DnsCheckRow | null,
    blacklist: BlacklistCheckRow | null,
    placement: PlacementTestRow | null,
  ): string[] {
    const codes: string[] = [];

    if (dns) {
      if (!dns.spfValid) codes.push('SPF_MISSING');
      if (!dns.dkimValid) codes.push('DKIM_MISSING');
      if (!dns.dmarcValid) codes.push('DMARC_MISSING');
      if (!dns.mxValid) codes.push('MX_MISSING');
      // Same rule T013 used for rDNS: null means "unknown" (no sendingIp), only
      // an explicit false is penalized/flagged.
      if (dns.rdnsValid === false) codes.push('RDNS_MISSING');
    }

    if (blacklist && !blacklist.isClean) {
      codes.push('BLACKLIST_HIT');
    }

    if (placement) {
      if ((placement.spamPct ?? 0) > SPAM_RATE_HIGH_THRESHOLD) codes.push('SPAM_RATE_HIGH');
      if ((placement.promotionsPct ?? 0) > PROMOTIONS_RATE_HIGH_THRESHOLD) {
        codes.push('PROMOTIONS_RATE_HIGH');
      }
    }

    return codes;
  }

  private async isAiEligible(userId: string): Promise<boolean> {
    const userRows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const plan = userRows[0]?.plan ?? 'trial';
    return AI_ANALYSIS_PLANS.has(plan);
  }

  private async getLatestDnsCheck(inboxId: string): Promise<DnsCheckRow | null> {
    const rows = await db
      .select()
      .from(dnsChecks)
      .where(eq(dnsChecks.inboxId, inboxId))
      .orderBy(desc(dnsChecks.checkedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  private async getLatestBlacklistCheck(inboxId: string): Promise<BlacklistCheckRow | null> {
    const rows = await db
      .select()
      .from(blacklistChecks)
      .where(eq(blacklistChecks.inboxId, inboxId))
      .orderBy(desc(blacklistChecks.checkedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  private async getLatestPlacementTest(inboxId: string): Promise<PlacementTestRow | null> {
    const rows = await db
      .select()
      .from(placementTests)
      .where(
        and(
          eq(placementTests.inboxId, inboxId),
          inArray(placementTests.status, ['complete', 'partial']),
        ),
      )
      .orderBy(desc(placementTests.completedAt))
      .limit(1);
    return rows[0] ?? null;
  }
}
