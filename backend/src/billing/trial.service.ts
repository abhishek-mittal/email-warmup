import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { and, eq, lt } from 'drizzle-orm';
import { db } from '../db';
import { users, inboxes } from '../db/schema';
import { QueueService } from '../queue/queue.service';

/**
 * Hourly cron that expires trial users whose trialEndsAt has passed.
 *
 * For each expired user:
 *   1. Set plan='free'
 *   2. Pause every inbox the user owns (mirror BillingService.pauseAllInboxes'
 *      DB-then-queue order to keep the same invariants).
 *   3. Enqueue a 'trial_expired' email notification.
 *
 * Sequential for...of loop on purpose: avoids races on the same user's
 * inboxes (mirrors BillingService.downgradePlan, see T016 context addendum
 * #5 / #7). Trial-expiry volume is small (once an hour), so parallelism is
 * not a perf concern.
 */
@Injectable()
export class TrialService {
  private readonly logger = new Logger(TrialService.name);

  constructor(private readonly queueService: QueueService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async expireTrials(): Promise<void> {
    const now = new Date();
    const expiredRows = await db
      .select()
      .from(users)
      .where(and(eq(users.plan, 'trial'), lt(users.trialEndsAt, now)));

    if (expiredRows.length === 0) {
      return;
    }

    for (const user of expiredRows) {
      try {
        await this.expireOne(user.id);
      } catch (err) {
        this.logger.error(
          `Failed to expire trial for user ${user.id}: ${(err as Error)?.message ?? err}`,
        );
      }
    }
  }

  private async expireOne(userId: string): Promise<void> {
    await this.pauseAllInboxes(userId);
    await db.update(users).set({ plan: 'free' }).where(eq(users.id, userId));
    await this.queueService.add('notify', {
      userId,
      type: 'trial_expired',
      channel: 'email',
      payload: {},
    });
  }

  /**
   * Mirrors BillingService.pauseAllInboxes. Reimplemented here rather than
   * calling BillingService.pauseAllInboxes directly because that helper is
   * private — and exposing it just for this cron would weaken the
   * encapsulation. Same shape (DB-then-queue, sequential awaits).
   */
  private async pauseAllInboxes(userId: string): Promise<void> {
    const userInboxes = await db.select().from(inboxes).where(eq(inboxes.userId, userId));
    for (const inbox of userInboxes) {
      await db.update(inboxes).set({ status: 'paused' }).where(eq(inboxes.id, inbox.id));
      await this.queueService.removeJobsForSender('warmup-send', inbox.id);
      await this.queueService.removeJobsForReceiver('warmup-receive', inbox.id);
    }
  }
}
