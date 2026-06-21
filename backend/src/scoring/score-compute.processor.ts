import { Injectable } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db';
import {
  dnsChecks,
  blacklistChecks,
  placementTests,
  reputationScores,
  inboxes,
} from '../db/schema';
import { ScoringService } from './scoring.service';
import { TrendService } from './trend.service';
import { QueueService } from '../queue/queue.service';

export interface ScoreComputeJobData {
  inboxId: string;
}

/** Score drop of this many points or more (vs. the previous score) triggers an alert. */
const DROP_ALERT_THRESHOLD = 15;

@Injectable()
@Processor('score-compute')
export class ScoreComputeProcessor extends WorkerHost {
  constructor(
    private readonly scoringService: ScoringService,
    private readonly trendService: TrendService,
    private readonly queueService: QueueService,
  ) {
    super();
  }

  async process(job: Job<ScoreComputeJobData>): Promise<void> {
    const { inboxId } = job.data;

    const inboxRows = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    const inbox = inboxRows[0];
    if (!inbox) {
      throw new UnrecoverableError(`Inbox ${inboxId} not found`);
    }

    const [latestDns, latestBlacklist, latestPlacement] = await Promise.all([
      this.getLatestDnsCheck(inboxId),
      this.getLatestBlacklistCheck(inboxId),
      this.getLatestPlacementTest(inboxId),
    ]);

    const dnsScore = this.scoringService.computeDnsScore(latestDns);
    const blacklistScore = this.scoringService.computeBlacklistScore(latestBlacklist);
    const placementScore = this.scoringService.computePlacementScore(latestPlacement);
    const total = Math.max(0, Math.min(100, dnsScore + blacklistScore + placementScore));

    // Read the previous score and the trend BEFORE inserting the new row, so
    // both comparisons are against prior state rather than the row we're
    // about to write. See T013 context addendum #6 and #8.
    const previous = await this.getPreviousScore(inboxId);
    const trend = await this.trendService.computeTrend(inboxId);

    await db.insert(reputationScores).values({
      inboxId,
      score: total,
      dnsScore,
      blacklistScore,
      placementScore,
      trend,
    });

    await this.maybeAlertOnDrop(inbox, previous, total);
  }

  private async getLatestDnsCheck(inboxId: string): Promise<typeof dnsChecks.$inferSelect | null> {
    const rows = await db
      .select()
      .from(dnsChecks)
      .where(eq(dnsChecks.inboxId, inboxId))
      .orderBy(desc(dnsChecks.checkedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  private async getLatestBlacklistCheck(
    inboxId: string,
  ): Promise<typeof blacklistChecks.$inferSelect | null> {
    const rows = await db
      .select()
      .from(blacklistChecks)
      .where(eq(blacklistChecks.inboxId, inboxId))
      .orderBy(desc(blacklistChecks.checkedAt))
      .limit(1);
    return rows[0] ?? null;
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

  private async getPreviousScore(
    inboxId: string,
  ): Promise<typeof reputationScores.$inferSelect | null> {
    const rows = await db
      .select()
      .from(reputationScores)
      .where(eq(reputationScores.inboxId, inboxId))
      .orderBy(desc(reputationScores.recordedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Drop-alert eligibility requires exactly one prior score to exist — never
   * alert for a newly connected inbox with no history, regardless of how low
   * the very first score is. See T013 context addendum #8.
   */
  private async maybeAlertOnDrop(
    inbox: typeof inboxes.$inferSelect,
    previous: typeof reputationScores.$inferSelect | null,
    total: number,
  ): Promise<void> {
    if (!previous) return;

    const delta = previous.score - total;
    if (delta < DROP_ALERT_THRESHOLD) return;

    await this.queueService.add('notify', {
      userId: inbox.userId,
      inboxId: inbox.id,
      type: 'score_drop',
      channel: 'email',
      payload: { prev: previous.score, current: total, delta },
    });

    await this.queueService.add('diagnostics', {
      inboxId: inbox.id,
      triggerType: 'auto_drop',
    });
  }
}
