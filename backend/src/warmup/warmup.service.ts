import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  inboxes,
  placementTests,
  poolInboxes,
  poolMembers,
  reputationScores,
  warmupSchedules,
  warmupSends,
} from '../db/schema';
import { RampService, WarmupSpeed } from './ramp.service';
import { LIVE_SEND_STATUSES, PairingService } from './pairing.service';
import { QueueService } from '../queue/queue.service';
import { planSlots } from './slot-planner';
import { SEND_JOB_RETRY } from './warmup-send.processor';
import { WarmupLedgerService, WarmupSendRow } from './warmup-ledger.service';
import { SafetyStopService, SYSTEM_HOLD_REASONS } from '../safety/safety-stop.service';
import { PlacementService } from '../placement/placement.service';

const WINDOW_START_HOUR_UTC = 8;
const WINDOW_MINUTES = 600; // 08:00-18:00 UTC
const MIN_SPACING_MINUTES = 8;
const MIN_SPACING_MS = MIN_SPACING_MINUTES * 60_000;
/** Bumped when the scheduling rules change in a way that must not reuse an old day's row. */
export const SCHEDULE_POLICY_VERSION = 1;
/**
 * Graduation rule, version 3 (MR-16). An inbox graduates only on evidence:
 *  - scores on at least MIN_MEASURED_DAYS different days in the lookback,
 *    each resting on enough real measurement (MIN_COMPLETENESS);
 *  - their average at or above MIN_AVG_SCORE;
 *  - a placement test that produced a result within PLACEMENT_MAX_AGE_DAYS,
 *    with spam at or below MAX_SPAM_PCT.
 * Missing, pending, failed or stale data never counts as passing.
 *
 * Decided 2026-10-03: the threshold is 80, matching the PRD. Under score
 * rule v2 a fully measured healthy inbox scores 90+, so 70 would graduate an
 * inbox with a real defect.
 */
export const GRADUATION_RULE = {
  version: 3,
  lookbackDays: 10,
  minMeasuredDays: 7,
  minCompleteness: 60,
  minAvgScore: 80,
  maxSpamPct: 5,
  placementMaxAgeDays: 14,
} as const;

const MIN_GRADUATION_DAYS: Record<WarmupSpeed, number> = {
  slow: 56,
  medium: 35,
  fast: 21,
};

@Injectable()
export class WarmupService {
  private readonly logger = new Logger(WarmupService.name);

  /** Random source for slot placement; replaced in tests for determinism. */
  rng: () => number = Math.random;

  constructor(
    private readonly rampService: RampService,
    private readonly pairingService: PairingService,
    private readonly queueService: QueueService,
    private readonly ledger: WarmupLedgerService,
    private readonly stops: SafetyStopService,
    @Optional() private readonly placementService?: PlacementService,
  ) {}

  /**
   * Daily cron at 05:00 UTC. Reserves each active inbox's sends for the day
   * and checks graduation.
   *
   * Safe to run on every replica: the per-day schedule row and the row lock
   * in scheduleInbox make a second run a no-op. One inbox failing never stops
   * the others.
   */
  @Cron('0 5 * * *', { utcOffset: 0 })
  async scheduleAllInboxes(now: Date = new Date()): Promise<void> {
    const activeInboxes = await db.select().from(inboxes).where(eq(inboxes.status, 'active'));

    for (const inbox of activeInboxes) {
      try {
        await this.scheduleInbox(inbox.id, now);
      } catch (err) {
        this.logger.error(
          { inboxId: inbox.id, err: (err as Error)?.message },
          'warmup scheduling failed for inbox — continuing with the rest',
        );
      }
    }

    for (const inbox of activeInboxes) {
      const speed = (inbox.warmupSpeed ?? 'medium') as WarmupSpeed;
      const nextWarmupDay = (inbox.warmupDay ?? 0) + 1;
      if (nextWarmupDay >= MIN_GRADUATION_DAYS[speed]) {
        try {
          await this.checkGraduation(inbox.id);
        } catch (err) {
          this.logger.error(
            { inboxId: inbox.id, err: (err as Error)?.message },
            'graduation check failed for inbox',
          );
        }
      }
    }
  }

  /** Repairs the DB-to-queue boundary; see WarmupLedgerService.recover. */
  @Cron('*/5 * * * *')
  async recoverLedger(): Promise<void> {
    try {
      await this.ledger.recover();
    } catch (err) {
      this.logger.error({ err: (err as Error)?.message }, 'warmup ledger recovery failed');
    }
  }

  /**
   * Reserves today's remaining sends for one inbox and queues them. Returns
   * the number of sends reserved by this call.
   *
   * There is exactly one schedule row per inbox per UTC day. Creating it is
   * what advances warmup_day, so calling this again the same day — a second
   * replica's cron, a resume click, a retry — can only top up to the day's
   * planned volume, never add a second day's worth or skip a ramp day:
   *
   *   allowance = planned volume - sends that are reserved, in flight,
   *               accepted or uncertain
   *
   * New slots are always in the future and at least MIN_SPACING apart; a
   * late start gets the few slots that still fit, not a burst.
   */
  async scheduleInbox(inboxId: string, now: Date = new Date()): Promise<number> {
    const scheduleDate = now.toISOString().slice(0, 10);
    const dayStart = new Date(`${scheduleDate}T00:00:00.000Z`);
    const windowStartMs = dayStart.getTime() + WINDOW_START_HOUR_UTC * 3_600_000;
    const windowEndMs = windowStartMs + WINDOW_MINUTES * 60_000;

    const reserved = await db.transaction(async (tx): Promise<WarmupSendRow[]> => {
      // Row lock: concurrent schedulers for the same inbox run one at a time.
      const inboxRows = await tx
        .select()
        .from(inboxes)
        .where(eq(inboxes.id, inboxId))
        .limit(1)
        .for('update');
      const inbox = inboxRows[0];
      // Never schedule (or advance the day) for an inbox that isn't warming.
      if (!inbox || inbox.status !== 'active') return [];
      // Nor while an operator stop covers it: no reservations, no day advance.
      if (await this.stops.activeStopFor({ userId: inbox.userId, provider: inbox.provider })) {
        return [];
      }

      const scheduleKey = and(
        eq(warmupSchedules.inboxId, inboxId),
        eq(warmupSchedules.scheduleDate, scheduleDate),
        eq(warmupSchedules.policyVersion, SCHEDULE_POLICY_VERSION),
      );
      let schedule = (await tx.select().from(warmupSchedules).where(scheduleKey).limit(1))[0];

      if (!schedule) {
        const speed = (inbox.warmupSpeed ?? 'medium') as WarmupSpeed;
        const warmupDay = inbox.warmupDay ?? 0;
        const created = await tx
          .insert(warmupSchedules)
          .values({
            inboxId,
            scheduleDate,
            policyVersion: SCHEDULE_POLICY_VERSION,
            warmupDay,
            plannedVolume: this.rampService.getDailyVolume(speed, warmupDay),
          })
          .onConflictDoNothing()
          .returning();
        schedule =
          created[0] ?? (await tx.select().from(warmupSchedules).where(scheduleKey).limit(1))[0];
        if (created[0]) {
          await tx
            .update(inboxes)
            .set({ warmupDay: warmupDay + 1 })
            .where(eq(inboxes.id, inboxId));
        }
      }

      const [usage] = await tx
        .select({
          live: sql<number>`count(*) filter (where ${inArray(warmupSends.status, LIVE_SEND_STATUSES)})::int`,
          nextSlot: sql<number>`coalesce(max(${warmupSends.slotIndex}), -1)::int + 1`,
          lastLiveAt: sql<
            string | null
          >`max(${warmupSends.scheduledAt}) filter (where ${inArray(warmupSends.status, LIVE_SEND_STATUSES)})`,
        })
        .from(warmupSends)
        .where(eq(warmupSends.scheduleId, schedule.id));

      const allowance = schedule.plannedVolume - Number(usage?.live ?? 0);
      if (allowance <= 0) return [];

      // Earliest permissible slot: inside the window, not in the past, and a
      // full spacing after anything already reserved or sent today.
      const lastLiveMs = usage?.lastLiveAt
        ? new Date(`${usage.lastLiveAt}Z`.replace(' ', 'T')).getTime()
        : 0;
      const earliestMs = Math.max(
        windowStartMs,
        now.getTime() + MIN_SPACING_MS,
        Number.isFinite(lastLiveMs) && lastLiveMs > 0 ? lastLiveMs + MIN_SPACING_MS : 0,
      );
      const slots = planSlots(allowance, earliestMs, windowEndMs, MIN_SPACING_MS, this.rng);
      if (slots.length < allowance) {
        this.logger.warn(
          { inboxId, allowance, fits: slots.length },
          'warmup volume capped to what still fits in today’s send window',
        );
      }
      if (slots.length === 0) return [];

      const partners = await this.pairingService.selectPartners(inbox, slots.length, dayStart, tx);
      if (partners.length === 0) return [];

      // With fewer partners than slots, keep a spread across the window
      // rather than the earliest N slots.
      const usedSlots = pickEvenly(slots, partners.length);
      let slotIndex = Number(usage?.nextSlot ?? 0);
      const values = partners.map((partner, i) => {
        const index = slotIndex++;
        return {
          senderInboxId: inboxId,
          receiverInboxId: partner.source === 'shared' ? partner.poolMember.inboxId : null,
          receiverPoolInboxId: partner.source === 'private' ? partner.poolInbox.id : null,
          messageId: `<${randomUUID()}@emailwarm.io>`,
          warmupDay: schedule.warmupDay,
          scheduledAt: new Date(usedSlots[i]),
          status: 'planned',
          scheduleId: schedule.id,
          slotIndex: index,
          deliveryKey: `${schedule.id}:${index}`,
        };
      });
      const rows = await tx.insert(warmupSends).values(values).returning();

      const privateCounts = new Map<string, number>();
      for (const row of rows) {
        if (row.receiverPoolInboxId) {
          privateCounts.set(
            row.receiverPoolInboxId,
            (privateCounts.get(row.receiverPoolInboxId) ?? 0) + 1,
          );
        }
      }
      for (const [poolInboxId, count] of privateCounts) {
        await tx
          .update(poolInboxes)
          .set({ activePairs: sql`${poolInboxes.activePairs} + ${count}` })
          .where(eq(poolInboxes.id, poolInboxId));
      }

      return rows;
    });

    // Queue only after the reservations are committed. If the queue is down
    // the rows stay 'planned' and the ledger sweep releases them once their
    // slot has passed — they are never replayed late.
    for (const row of reserved) {
      await this.queueService.add(
        'warmup-send',
        {
          sendId: row.id,
          senderInboxId: row.senderInboxId,
          partnerSource: row.receiverPoolInboxId ? 'private' : 'shared',
          partnerId: row.receiverPoolInboxId ?? row.receiverInboxId,
          warmupDay: row.warmupDay,
          scheduledAt: row.scheduledAt.toISOString(),
        },
        {
          delay: Math.max(0, row.scheduledAt.getTime() - Date.now()),
          jobId: `send-${row.id}`,
          ...SEND_JOB_RETRY,
        },
      );
    }

    return reserved.length;
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
      // Everything else is in place: run the inbox's one free placement test
      // so the next daily check has a fresh result to judge.
      await this.requestGraduationTest(inbox);
      return false;
    }

    await this.graduate(inbox);
    return true;
  }

  private async requestGraduationTest(inbox: typeof inboxes.$inferSelect): Promise<void> {
    if (!this.placementService) return;
    try {
      const started = await this.placementService.runGraduationTest(inbox.id, inbox.userId);
      if (started) {
        this.logger.log(
          { inboxId: inbox.id, testId: started.testId },
          'graduation placement test started',
        );
      }
    } catch (err) {
      // No healthy seeds, or the inbox could not send: try again tomorrow.
      this.logger.warn(
        { inboxId: inbox.id, err: (err as Error)?.message },
        'graduation placement test could not be started',
      );
    }
  }

  /**
   * Enough measured days, each with enough real data behind it, averaging at
   * or above the threshold. One good row — or many rows on one day — is not
   * an observation window.
   */
  private async meetsReputationCriterion(inboxId: string): Promise<boolean> {
    const since = new Date(Date.now() - GRADUATION_RULE.lookbackDays * 24 * 60 * 60 * 1000);
    const rows = await db
      .select()
      .from(reputationScores)
      .where(and(eq(reputationScores.inboxId, inboxId), gte(reputationScores.recordedAt, since)));

    // Latest qualifying score per UTC day.
    const byDay = new Map<string, { score: number; at: number }>();
    for (const row of rows) {
      // Scores from before completeness was tracked cannot show what they rest on.
      if ((row.completeness ?? 0) < GRADUATION_RULE.minCompleteness) continue;
      const day = row.recordedAt.toISOString().slice(0, 10);
      const at = row.recordedAt.getTime();
      const existing = byDay.get(day);
      if (!existing || at > existing.at) byDay.set(day, { score: row.score, at });
    }
    if (byDay.size < GRADUATION_RULE.minMeasuredDays) return false;

    const scores = [...byDay.values()].map((entry) => entry.score);
    const avg = scores.reduce((sum, score) => sum + score, 0) / scores.length;
    return avg >= GRADUATION_RULE.minAvgScore;
  }

  /**
   * Requires a recent placement test that produced a result. No test, a
   * pending or failed test, or one that is too old does not pass.
   */
  private async meetsPlacementCriterion(inboxId: string): Promise<boolean> {
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

    const latest = rows[0];
    if (!latest || !latest.completedAt || latest.spamPct === null) return false;

    const ageMs = Date.now() - latest.completedAt.getTime();
    if (ageMs > GRADUATION_RULE.placementMaxAgeDays * 24 * 60 * 60 * 1000) return false;

    return latest.spamPct <= GRADUATION_RULE.maxSpamPct;
  }

  /**
   * Pauses an inbox's warmup activity immediately: sets status='paused',
   * releases its reserved sends, and drains both directions of pending warmup
   * jobs — sends *from* this inbox and receive-engagement jobs
   * (open/star/reply/rescue) *for* mail already sent *to* this inbox — so a
   * paused inbox (e.g. blacklisted) does not participate in any further
   * warmup activity in either direction. See T012 context addendum #3.
   *
   * `reason` records who paused it ('user', 'blacklist', ...). Idempotent.
   * A message a server has already accepted cannot be unsent.
   */
  async pauseInbox(inboxId: string, reason: string = 'user'): Promise<void> {
    await db
      .update(inboxes)
      .set({ status: 'paused', statusReason: reason })
      .where(eq(inboxes.id, inboxId));

    const released = await db
      .update(warmupSends)
      .set({ status: 'canceled', failureReason: 'sender inbox paused' })
      .where(and(eq(warmupSends.senderInboxId, inboxId), eq(warmupSends.status, 'planned')))
      .returning({ receiverPoolInboxId: warmupSends.receiverPoolInboxId });
    for (const row of released) {
      if (!row.receiverPoolInboxId) continue;
      await db
        .update(poolInboxes)
        .set({ activePairs: sql`GREATEST(${poolInboxes.activePairs} - 1, 0)` })
        .where(eq(poolInboxes.id, row.receiverPoolInboxId));
    }

    await this.queueService.removeJobsForSender('warmup-send', inboxId);
    await this.queueService.removeJobsForReceiver('warmup-receive', inboxId);
  }

  /**
   * Resumes a paused inbox and tops up what is left of today's volume so it
   * starts warming again without waiting for the 05:00 UTC cron.
   *
   * Only a 'paused' inbox can be resumed. Resuming an active inbox is a
   * no-op — it does NOT queue more mail — and an inbox stopped for a reason
   * a click can't fix (revoked credentials, pending, graduated) stays as it
   * is. Returns the inbox's status after the call.
   */
  /** True if this inbox has at least one eligible warm-with partner right now. */
  async inboxCanWarm(inboxId: string): Promise<boolean> {
    const rows = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    const inbox = rows[0];
    if (!inbox) return false;
    return this.pairingService.hasEligiblePartners(inbox);
  }

  /**
   * Explicit user "Start warmup": ready -> active, then schedule. Mirrors
   * resumeInbox but transitions from 'ready' (not 'paused') and does not fire
   * when a system hold is in place. Returns the resulting status.
   */
  async startInbox(inboxId: string): Promise<string> {
    const started = await db
      .update(inboxes)
      .set({ status: 'active', statusReason: null })
      .where(and(eq(inboxes.id, inboxId), eq(inboxes.status, 'ready')))
      .returning({ id: inboxes.id });

    if (started.length === 0) {
      const rows = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
      return rows[0]?.status ?? 'ready';
    }

    await this.scheduleInbox(inboxId);
    return 'active';
  }

  async resumeInbox(inboxId: string): Promise<string | null> {
    // A system hold (e.g. bounce rate over the limit) is not the user's to lift:
    // an operator has to release it first.
    const current = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    if (current[0]?.statusReason && SYSTEM_HOLD_REASONS.includes(current[0].statusReason)) {
      return current[0].status;
    }

    const resumed = await db
      .update(inboxes)
      .set({ status: 'active', statusReason: null })
      .where(and(eq(inboxes.id, inboxId), eq(inboxes.status, 'paused')))
      .returning({ id: inboxes.id });

    if (resumed.length === 0) {
      const rows = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
      return rows[0]?.status ?? null;
    }

    await this.scheduleInbox(inboxId);
    return 'active';
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

/** Picks `count` items spread evenly across `items` (which is already sorted). */
function pickEvenly<T>(items: T[], count: number): T[] {
  if (count >= items.length) return items;
  const step = items.length / count;
  return Array.from({ length: count }, (_, i) => items[Math.floor(i * step)]);
}
