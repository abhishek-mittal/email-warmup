import { Injectable } from '@nestjs/common';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { db } from '../db';
import { inboxes, placementTests, reputationScores, warmupSends, diagnostics } from '../db/schema';

const REPUTATION_LOOKBACK_DAYS = 7;
const MAX_DAILY_SEND_VOLUME = 200;

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

/**
 * Pure deterministic logic — no Claude call here (see T015 context addendum
 * #7; only AiAnalyzerService talks to Claude). Generates a report even for a
 * graduated inbox with no placement test history (addendum #8): missing
 * placement data is treated as an unknown/neutral input, not a reason to skip
 * generation.
 */
@Injectable()
export class ReadinessReportService {
  async generateReadinessReport(inboxId: string): Promise<ReadinessReport> {
    const inboxRows = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    const inbox = inboxRows[0];

    const [scores, latestPlacement, warmupPoolContribution] = await Promise.all([
      this.getReputationHistory(inboxId),
      this.getLatestPlacementTest(inboxId),
      this.getWarmupPoolContribution(inboxId),
    ]);

    const avgScore =
      scores.length > 0 ? scores.reduce((s, r) => s + r.score, 0) / scores.length : 0;
    const primaryPlacementPct = latestPlacement?.primaryPct ?? null;
    const recommended = this.computeRecommendedVolume(avgScore, primaryPlacementPct);

    return {
      inboxId,
      generatedAt: new Date().toISOString(),
      warmupDaysCompleted: inbox?.warmupDay ?? 0,
      reputationScore: avgScore,
      primaryPlacementPct,
      recommendedDailySendVolume: recommended,
      warmupPoolContribution,
      nextSteps: this.buildNextSteps(avgScore, latestPlacement),
      riskFactors: this.buildRiskFactors(avgScore, latestPlacement),
    };
  }

  /**
   * Saves the generated report as a `diagnostics` row with
   * `triggerType: 'graduation'` (a 5th trigger-type value alongside the
   * skill file's documented 4 — the column is plain text, no DB-level enum
   * constraint, so this needs no schema change). `issueCodes: []` since a
   * readiness report isn't about issues; `aiAnalysis: null` since no AI call
   * is made for readiness reports. See T015 context addendum #10.
   */
  async saveReadinessReport(inboxId: string, report: ReadinessReport): Promise<string> {
    const [row] = await db
      .insert(diagnostics)
      .values({
        inboxId,
        triggerType: 'graduation',
        issueCodes: [],
        aiAnalysis: null,
        readinessReport: report,
      })
      .returning({ id: diagnostics.id });

    return row.id;
  }

  /**
   * Conservative cap-respecting recommendation. Falls through to the 20/day
   * default ("still building reputation") when placement data is missing,
   * treating it as an unknown/neutral input rather than skipping generation —
   * see T015 context addendum #8. Capped at 200 defensively even though no
   * branch currently exceeds it.
   */
  computeRecommendedVolume(score: number, primaryPlacementPct: number | null): number {
    let volume = 20;
    if (primaryPlacementPct !== null && score >= 80 && primaryPlacementPct >= 85) {
      volume = 150;
    } else if (primaryPlacementPct !== null && score >= 70 && primaryPlacementPct >= 75) {
      volume = 80;
    } else if (primaryPlacementPct !== null && score >= 60 && primaryPlacementPct >= 60) {
      volume = 40;
    }
    return Math.min(MAX_DAILY_SEND_VOLUME, volume);
  }

  private buildNextSteps(
    avgScore: number,
    placement: typeof placementTests.$inferSelect | null,
  ): string[] {
    const steps: string[] = [];
    if (!placement) {
      steps.push('Run a placement test to confirm where your mail is landing.');
    }
    if (avgScore < 80) {
      steps.push('Continue monitoring your reputation score before increasing send volume.');
    }
    steps.push(
      'Ramp up daily send volume gradually rather than jumping straight to your full list.',
    );
    return steps;
  }

  private buildRiskFactors(
    avgScore: number,
    placement: typeof placementTests.$inferSelect | null,
  ): string[] {
    const risks: string[] = [];
    if (avgScore < 70) {
      risks.push('Reputation score is below the recommended threshold for high-volume sending.');
    }
    if (placement && (placement.spamPct ?? 0) > 0) {
      risks.push(`${placement.spamPct}% of placement test seeds landed in spam.`);
    }
    if (!placement) {
      risks.push('No placement test has been run yet, so inbox placement is unverified.');
    }
    return risks;
  }

  private async getReputationHistory(
    inboxId: string,
  ): Promise<(typeof reputationScores.$inferSelect)[]> {
    const since = new Date(Date.now() - REPUTATION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    return db
      .select()
      .from(reputationScores)
      .where(and(eq(reputationScores.inboxId, inboxId), gte(reputationScores.recordedAt, since)));
  }

  private async getLatestPlacementTest(
    inboxId: string,
  ): Promise<typeof placementTests.$inferSelect | null> {
    const rows = await db
      .select()
      .from(placementTests)
      .where(eq(placementTests.inboxId, inboxId))
      .orderBy(desc(placementTests.completedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Count of distinct receiverInboxId values in warmup_sends where this
   * inbox was the sender — i.e. how many distinct other inboxes this one has
   * sent warmup mail to. See T015 context addendum #9.
   */
  private async getWarmupPoolContribution(inboxId: string): Promise<string> {
    const [result] = await db
      .select({ count: sql<number>`count(distinct ${warmupSends.receiverInboxId})` })
      .from(warmupSends)
      .where(eq(warmupSends.senderInboxId, inboxId));

    const n = Number(result?.count ?? 0);
    return `Your inbox helped warm ${n} other inboxes`;
  }
}
