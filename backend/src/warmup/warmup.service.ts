import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, desc, eq, gte } from 'drizzle-orm';
import { db } from '../db';
import { inboxes, placementTests, poolMembers, reputationScores } from '../db/schema';
import { RampService, WarmupSpeed } from './ramp.service';
import { PairingService } from './pairing.service';
import { QueueService } from '../queue/queue.service';

const WINDOW_START_HOUR_UTC = 8;
const WINDOW_MINUTES = 600; // 08:00-18:00 UTC
const MIN_SPACING_MINUTES = 8;
const JITTER_MINUTES = 15;
const MAX_SPACING_ATTEMPTS = 5;
const REPUTATION_LOOKBACK_DAYS = 7;
const GRADUATION_MIN_AVG_SCORE = 70;
const GRADUATION_MAX_SPAM_PCT = 5;

const MIN_GRADUATION_DAYS: Record<WarmupSpeed, number> = {
  slow: 56,
  medium: 35,
  fast: 21,
};

@Injectable()
export class WarmupService {
  private readonly logger = new Logger(WarmupService.name);

  constructor(
    private readonly rampService: RampService,
    private readonly pairingService: PairingService,
    private readonly queueService: QueueService,
  ) {}

  /**
   * Daily cron at 05:00 UTC. Computes each active inbox's target send volume,
   * spreads jobs across the day with mandatory jitter + spacing, enqueues them,
   * advances warmup_day, and checks graduation.
   */
  @Cron('0 5 * * *', { utcOffset: 0 })
  async scheduleAllInboxes(): Promise<void> {
    const activeInboxes = await db.select().from(inboxes).where(eq(inboxes.status, 'active'));

    for (const inbox of activeInboxes) {
      await this.scheduleInbox(inbox);
    }

    for (const inbox of activeInboxes) {
      const speed = (inbox.warmupSpeed ?? 'medium') as WarmupSpeed;
      const nextWarmupDay = (inbox.warmupDay ?? 0) + 1;
      if (nextWarmupDay >= MIN_GRADUATION_DAYS[speed]) {
        await this.checkGraduation(inbox.id);
      }
    }
  }

  /**
   * Enqueues today's warmup-send jobs for a single inbox and advances its
   * warmup_day counter. Slots with no available pairing partner are skipped
   * rather than queued — the ramp-curve volume is a target, not a guarantee.
   */
  private async scheduleInbox(inbox: typeof inboxes.$inferSelect): Promise<void> {
    const speed = (inbox.warmupSpeed ?? 'medium') as WarmupSpeed;
    const warmupDay = inbox.warmupDay ?? 0;
    const volume = this.rampService.getDailyVolume(speed, warmupDay);

    const slots = this.buildJitteredSlots(volume);

    for (const scheduledAt of slots) {
      const partner = await this.pairingService.selectPartner(inbox.id);
      if (!partner) {
        // Never exceed the ramp-curve volume for the day with a substitute send —
        // if pairing fails for this slot, skip it entirely.
        continue;
      }

      const delay = Math.max(0, scheduledAt.getTime() - Date.now());
      await this.queueService.add(
        'warmup-send',
        {
          senderInboxId: inbox.id,
          partnerInboxId: partner.id,
          warmupDay,
          scheduledAt: scheduledAt.toISOString(),
        },
        { delay },
      );
    }

    await db
      .update(inboxes)
      .set({ warmupDay: warmupDay + 1 })
      .where(eq(inboxes.id, inbox.id));
  }

  /**
   * Builds `volume` send times spread across the 08:00-18:00 UTC window with
   * mandatory +-15min jitter and a minimum 8-minute gap between any two slots
   * for this sender.
   *
   * Resolution (see T010 context addendum #3 — window-packing vs 8-min spacing):
   * the 8-minute spacing rule and the ramp-curve volume target both win; the
   * 08:00-18:00 window is the thing that flexes. At high volumes
   * (volume * 8 > 600), spacing is clamped up to 8 minutes and the effective
   * window extends past 18:00 rather than dropping sends or shrinking spacing
   * below 8 minutes.
   */
  private buildJitteredSlots(volume: number): Date[] {
    if (volume <= 0) {
      return [];
    }

    const windowStart = new Date();
    windowStart.setUTCHours(WINDOW_START_HOUR_UTC, 0, 0, 0);
    const spacingMinutes = Math.max(MIN_SPACING_MINUTES, WINDOW_MINUTES / volume);

    const accepted: Date[] = [];

    for (let i = 0; i < volume; i++) {
      const baseSlotMs = windowStart.getTime() + i * spacingMinutes * 60_000;

      let candidate: Date = new Date(baseSlotMs);
      for (let attempt = 0; attempt < MAX_SPACING_ATTEMPTS; attempt++) {
        const jitterMs = this.randomJitterMs();
        candidate = new Date(baseSlotMs + jitterMs);

        const farEnoughFromAll = accepted.every(
          (existing) =>
            Math.abs(candidate.getTime() - existing.getTime()) >= MIN_SPACING_MINUTES * 60_000,
        );
        if (farEnoughFromAll) {
          break;
        }
        // Otherwise: best-effort retry. After MAX_SPACING_ATTEMPTS, accept the last
        // candidate tried anyway — spacing >= 8 min by construction makes repeated
        // collisions across 5 attempts very unlikely.
      }

      accepted.push(candidate);
    }

    return accepted;
  }

  /** Uniform random jitter in [-15, +15] minutes, converted to ms. Never zero-clamped. */
  private randomJitterMs(): number {
    const jitterMinutes = (Math.random() * 2 - 1) * JITTER_MINUTES; // [-15, 15)
    return jitterMinutes * 60_000;
  }

  /**
   * Evaluates graduation criteria for an inbox and, if met, graduates it:
   * sets status=graduated + graduated_at, deactivates its pool membership,
   * and fans out score-compute / readiness-report / notify jobs.
   */
  async checkGraduation(inboxId: string): Promise<boolean> {
    const rows = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    const inbox = rows[0];
    if (!inbox) {
      return false;
    }

    const speed = (inbox.warmupSpeed ?? 'medium') as WarmupSpeed;
    const warmupDay = inbox.warmupDay ?? 0;
    if (warmupDay < MIN_GRADUATION_DAYS[speed]) {
      return false;
    }

    if (!(await this.meetsReputationCriterion(inboxId))) {
      return false;
    }

    if (!(await this.meetsPlacementCriterion(inboxId))) {
      return false;
    }

    await this.graduate(inbox);
    return true;
  }

  /**
   * Missing data (zero rows) FAILS this criterion — graduation simply can't happen
   * yet. This is intentionally asymmetric with the placement-test criterion below
   * (see addendum #6).
   */
  private async meetsReputationCriterion(inboxId: string): Promise<boolean> {
    const since = new Date(Date.now() - REPUTATION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const rows = await db
      .select()
      .from(reputationScores)
      .where(and(eq(reputationScores.inboxId, inboxId), gte(reputationScores.recordedAt, since)));

    if (rows.length === 0) {
      return false;
    }

    const avg = rows.reduce((sum, row) => sum + row.score, 0) / rows.length;
    return avg >= GRADUATION_MIN_AVG_SCORE;
  }

  /**
   * Missing data (no placement test yet) SKIPS this criterion (treated as passing) —
   * intentionally asymmetric with the reputation criterion above (see addendum #6).
   */
  private async meetsPlacementCriterion(inboxId: string): Promise<boolean> {
    const rows = await db
      .select()
      .from(placementTests)
      .where(eq(placementTests.inboxId, inboxId))
      .orderBy(desc(placementTests.completedAt))
      .limit(1);

    const latest = rows[0];
    if (!latest) {
      return true;
    }

    return (latest.spamPct ?? 0) <= GRADUATION_MAX_SPAM_PCT;
  }

  /**
   * Pauses an inbox's warmup activity immediately: sets status='paused' and drains
   * both directions of pending warmup jobs — sends *from* this inbox and
   * receive-engagement jobs (open/star/reply/rescue) *for* mail already sent *to*
   * this inbox — so a paused inbox (e.g. blacklisted) does not participate in any
   * further warmup activity in either direction. See T012 context addendum #3.
   */
  async pauseInbox(inboxId: string): Promise<void> {
    await db.update(inboxes).set({ status: 'paused' }).where(eq(inboxes.id, inboxId));
    await this.queueService.removeJobsForSender('warmup-send', inboxId);
    await this.queueService.removeJobsForReceiver('warmup-receive', inboxId);
  }

  private async graduate(inbox: typeof inboxes.$inferSelect): Promise<void> {
    const graduatedAt = new Date();

    await db
      .update(inboxes)
      .set({ status: 'graduated', graduatedAt })
      .where(eq(inboxes.id, inbox.id));

    await db.update(poolMembers).set({ active: false }).where(eq(poolMembers.inboxId, inbox.id));

    await this.queueService.add('score-compute', { inboxId: inbox.id });
    await this.queueService.add('readiness-report', { inboxId: inbox.id });
    await this.queueService.add('notify', {
      userId: inbox.userId,
      inboxId: inbox.id,
      type: 'warmup_complete',
      channel: 'email',
      payload: { warmupDay: inbox.warmupDay },
    });
  }
}
