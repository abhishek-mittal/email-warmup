import { Injectable, Logger } from '@nestjs/common';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../db';
import { warmupSends } from '../db/schema';
import { QueueService } from '../queue/queue.service';

export type WarmupSendRow = typeof warmupSends.$inferSelect;
export type PartnerSource = 'private' | 'shared';

const RECEIVE_DELAY_MIN_MS = 2 * 60_000;
const RECEIVE_DELAY_MAX_MS = 240 * 60_000;
const REPLY_PROBABILITY = 0.6;
const REPLY_FILE_DELAY_MIN_MS = 3 * 60_000;
const REPLY_FILE_DELAY_MAX_MS = 45 * 60_000;

/**
 * "Not delivered yet" is the normal reason a receive job fails, so it retries
 * with exponential backoff: 5, 10, 20, 40, 80, 160, 320 minutes (~10.5h).
 */
export const RECEIVE_JOB_RETRY = {
  attempts: 8,
  backoff: { type: 'exponential' as const, delay: 5 * 60_000 },
};

/** Sends whose receive job was never published are re-published after this. */
const UNPUBLISHED_GRACE_MS = 2 * 60_000;
/** A worker that claimed a send and never finished is presumed dead after this. */
const STUCK_SUBMITTING_MS = 15 * 60_000;
/** Planned slots this far past their time are released, never replayed late. */
const PLANNED_EXPIRY_MS = 60 * 60_000;

/**
 * Queue-side half of the delivery ledger (MR-02): publishes the follow-up
 * jobs for an accepted send and repairs the DB-to-queue boundary when a
 * worker died between "SMTP accepted" and "receive job enqueued".
 */
@Injectable()
export class WarmupLedgerService {
  private readonly logger = new Logger(WarmupLedgerService.name);

  constructor(private readonly queueService: QueueService) {}

  /**
   * Publishes the engagement job for a send and records that it was published.
   * Safe to call repeatedly: the BullMQ job id is derived from the send id, so
   * a second publish is dropped by the queue rather than duplicating actions.
   */
  async enqueueReceive(send: WarmupSendRow, opts: { delayMs?: number } = {}): Promise<void> {
    const receiverSource: PartnerSource = send.receiverPoolInboxId ? 'private' : 'shared';
    const receiverId = send.receiverPoolInboxId ?? send.receiverInboxId;
    if (!receiverId || !send.messageId) {
      this.logger.warn({ sendId: send.id }, 'cannot enqueue receive: send has no receiver');
      return;
    }

    const actions: string[] = ['open', 'star'];
    if (Math.random() < REPLY_PROBABILITY) actions.push('reply');

    const delay = opts.delayMs ?? randomBetween(RECEIVE_DELAY_MIN_MS, RECEIVE_DELAY_MAX_MS);
    const payload: Record<string, unknown> = {
      sendId: send.id,
      receiverSource,
      receiverId,
      messageId: send.messageId,
      warmupDay: send.warmupDay,
      actions,
      executeAt: new Date(Date.now() + delay).toISOString(),
    };
    // QueueService.removeJobsForReceiver drains on this literal key when a
    // shared-pool inbox is paused.
    if (receiverSource === 'shared') payload.receiverInboxId = receiverId;

    await this.queueService.add('warmup-receive', payload, {
      delay,
      jobId: `recv-${send.id}`,
      ...RECEIVE_JOB_RETRY,
    });
    await db
      .update(warmupSends)
      .set({ receiveEnqueuedAt: new Date() })
      .where(eq(warmupSends.id, send.id));
  }

  /**
   * Publishes the job that files a warmup reply out of the original sender's
   * inbox. Replies are warmup traffic too and must not sit in a real inbox.
   */
  async enqueueReplyFiling(send: WarmupSendRow, opts: { delayMs?: number } = {}): Promise<void> {
    if (!send.replyMessageId) return;
    const delay = opts.delayMs ?? randomBetween(REPLY_FILE_DELAY_MIN_MS, REPLY_FILE_DELAY_MAX_MS);
    await this.queueService.add(
      'warmup-receive',
      {
        kind: 'reply-filing',
        sendId: send.id,
        receiverSource: 'shared',
        receiverId: send.senderInboxId,
        receiverInboxId: send.senderInboxId,
        messageId: send.replyMessageId,
        actions: ['open'],
        executeAt: new Date(Date.now() + delay).toISOString(),
      },
      { delay, jobId: `replyfile-${send.id}`, ...RECEIVE_JOB_RETRY },
    );
  }

  /**
   * Repairs ledger rows left behind by a crash or a queue outage. Idempotent;
   * intended to run every few minutes on any replica.
   */
  async recover(now: Date = new Date()): Promise<{
    republished: number;
    markedUncertain: number;
    expired: number;
  }> {
    // 1. Accepted, but the receive job never reached the queue.
    const unpublished = await db
      .select()
      .from(warmupSends)
      .where(
        and(
          eq(warmupSends.status, 'accepted'),
          isNull(warmupSends.receiveEnqueuedAt),
          isNull(warmupSends.filedAt),
          lt(warmupSends.sentAt, new Date(now.getTime() - UNPUBLISHED_GRACE_MS)),
          // Rows that predate the ledger have no delivery key and were
          // enqueued by the old code path.
          sql`${warmupSends.deliveryKey} is not null`,
        ),
      )
      .limit(500);
    for (const send of unpublished) {
      await this.enqueueReceive(send);
    }

    // 2. Claimed by a worker that never reported back: the message may have
    //    gone out. Mark uncertain and let the receive job look for it — finding
    //    it in the partner's mailbox is the reconciliation.
    const stuck = await db
      .update(warmupSends)
      .set({
        status: 'uncertain',
        failureReason: 'worker stopped during SMTP submission',
      })
      .where(
        and(
          eq(warmupSends.status, 'submitting'),
          lt(warmupSends.claimedAt, new Date(now.getTime() - STUCK_SUBMITTING_MS)),
        ),
      )
      .returning();
    for (const send of stuck) {
      await this.enqueueReceive(send);
    }

    // 3. Reservations whose slot is long gone (queue outage, lost job). They
    //    are released rather than sent late as a burst.
    const expired = await db
      .update(warmupSends)
      .set({ status: 'canceled', failureReason: 'slot expired before a worker picked it up' })
      .where(
        and(
          eq(warmupSends.status, 'planned'),
          lt(warmupSends.scheduledAt, new Date(now.getTime() - PLANNED_EXPIRY_MS)),
        ),
      )
      .returning({ id: warmupSends.id });

    if (unpublished.length || stuck.length || expired.length) {
      this.logger.warn(
        {
          republished: unpublished.length,
          markedUncertain: stuck.length,
          expired: expired.length,
        },
        'warmup ledger recovery applied',
      );
    }
    return {
      republished: unpublished.length,
      markedUncertain: stuck.length,
      expired: expired.length,
    };
  }
}

function randomBetween(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min));
}
