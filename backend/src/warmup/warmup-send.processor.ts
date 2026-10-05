import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { randomUUID, createHash } from 'crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { inboxes, poolInboxes, poolMembers, warmupSends } from '../db/schema';
import { ContentService } from './content.service';
import { SmtpClientService } from '../inbox/smtp/smtp-client.service';
import { CredentialRevokedError } from '../inbox/oauth/oauth-errors';
import {
  PreSubmissionError,
  classifySmtpError,
  describeSmtpError,
  isPermanentRejection,
} from './smtp-outcome';
import { PartnerSource, WarmupLedgerService, WarmupSendRow } from './warmup-ledger.service';
import { SafetyStopService } from '../safety/safety-stop.service';
import { BounceMonitorService } from '../safety/bounce-monitor.service';

export type { PartnerSource } from './warmup-ledger.service';

export interface WarmupSendJobData {
  /** Ledger row reserved by the scheduler. Absent only on jobs queued before the ledger existed. */
  sendId?: string;
  senderInboxId: string;
  partnerSource: PartnerSource;
  partnerId: string;
  warmupDay: number;
  scheduledAt: string;
}

/** Retries are only ever taken for definite (pre-acceptance) failures. */
export const SEND_JOB_RETRY = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2 * 60_000 },
};

export const WARMUP_HEADER = 'X-WarmupHub';

type InboxRow = typeof inboxes.$inferSelect;

interface Receiver {
  email: string;
  industry: string | null;
}

/**
 * Submits one warmup email (MR-02).
 *
 * Every send is a row in `warmup_sends` that exists BEFORE the SMTP
 * conversation starts:
 *
 *   planned -> submitting -> accepted            (normal)
 *                        \-> failed              (server said no; retry is safe)
 *                        \-> uncertain           (may have been accepted; never resent)
 *   planned -> canceled                          (sender/receiver no longer eligible)
 *
 * The claim (planned|failed -> submitting) is a conditional UPDATE, so two
 * workers handed the same job cannot both submit.
 */
@Injectable()
@Processor('warmup-send')
export class WarmupSendProcessor extends WorkerHost {
  constructor(
    @InjectPinoLogger(WarmupSendProcessor.name)
    private readonly logger: PinoLogger,
    private readonly contentService: ContentService,
    private readonly smtpClientService: SmtpClientService,
    private readonly ledger: WarmupLedgerService,
    private readonly stops: SafetyStopService,
    private readonly bounces: BounceMonitorService,
  ) {
    super();
  }

  async process(job: Job<WarmupSendJobData>): Promise<void> {
    const { senderInboxId, partnerSource, partnerId, warmupDay } = job.data;
    const jobId = String(job.id);
    const startedAt = Date.now();

    this.logger.info(
      { jobId, senderInboxId, partnerSource, partnerId, warmupDay, sendId: job.data.sendId },
      'warmup-send job started',
    );

    const send = await this.loadOrCreateIntent(job);
    if (!send) {
      throw new UnrecoverableError(`Warmup send ${job.data.sendId} not found`);
    }

    // A previous attempt (or another worker) already took this delivery somewhere.
    if (send.status === 'accepted') {
      if (!send.receiveEnqueuedAt) await this.ledger.enqueueReceive(send);
      return;
    }
    if (send.status === 'submitting') {
      // The worker that claimed it died mid-conversation. The message may be
      // out there: do not resend, let the receive job look for it.
      await this.markUncertain(send.id, 'previous attempt stopped during SMTP submission');
      await this.ledger.enqueueReceive({ ...send, status: 'uncertain' });
      this.logger.warn({ jobId, sendId: send.id }, 'warmup-send: unfinished attempt — uncertain');
      return;
    }
    if (send.status === 'uncertain' || send.status === 'canceled') {
      this.logger.info(
        { jobId, sendId: send.id, status: send.status },
        'warmup-send: nothing to do',
      );
      return;
    }

    // Eligibility is re-checked here, immediately before the side effect: the
    // row was reserved hours ago and anything may have changed since.
    const senderRows = await db
      .select()
      .from(inboxes)
      .where(eq(inboxes.id, senderInboxId))
      .limit(1);
    const sender = senderRows[0];
    if (!sender) {
      await this.cancel(send, 'sender inbox no longer exists');
      throw new UnrecoverableError(`Sender inbox ${senderInboxId} not found`);
    }
    if (sender.status !== 'active') {
      await this.cancel(send, `sender inbox is ${sender.status}`);
      this.logger.warn(
        { jobId, senderInboxId, status: sender.status },
        'warmup-send: sender inbox not active — send canceled',
      );
      return;
    }

    // Operator stop switches apply to queued sends too, not just new plans.
    const stop = await this.stops.activeStopFor({
      userId: sender.userId,
      provider: sender.provider,
    });
    if (stop) {
      await this.cancel(send, `sending stopped by operator (${stop.scope})`);
      this.logger.warn(
        { jobId, sendId: send.id, stopId: stop.id, scope: stop.scope },
        'warmup-send: stop switch active — send canceled',
      );
      return;
    }

    const resolved = await this.resolveReceiver(sender, send);
    if ('ineligible' in resolved) {
      await this.cancel(send, resolved.ineligible);
      this.logger.warn(
        { jobId, sendId: send.id, reason: resolved.ineligible },
        'warmup-send: receiver not eligible — send canceled',
      );
      return;
    }
    const receiver = resolved.receiver;

    const email = await this.contentService.generateEmail({
      warmupDay: send.warmupDay,
      industry: receiver.industry,
    });

    const claimed = await db
      .update(warmupSends)
      .set({
        status: 'submitting',
        claimedAt: new Date(),
        subject: email.subject,
        bodyHash: createHash('sha256').update(email.text).digest('hex'),
        failureReason: null,
      })
      .where(and(eq(warmupSends.id, send.id), inArray(warmupSends.status, ['planned', 'failed'])))
      .returning();
    const claim = claimed[0];
    if (!claim) {
      this.logger.info({ jobId, sendId: send.id }, 'warmup-send: claimed by another worker');
      return;
    }

    let response: string | undefined;
    try {
      // Building the transporter (token refresh, host policy) happens before
      // any SMTP conversation, so a failure here is never "maybe sent".
      const transporter = await this.smtpClientService
        .getTransporter(senderInboxId)
        .catch((err) => {
          throw err instanceof CredentialRevokedError ? err : new PreSubmissionError(err);
        });
      const result = await transporter.sendMail({
        from: sender.email,
        to: receiver.email,
        subject: email.subject,
        text: email.text,
        html: email.html,
        // Fixed at reservation time and reused on every attempt, so a
        // duplicate that does slip through is at least recognisable as one.
        messageId: claim.messageId!,
        headers: { [WARMUP_HEADER]: 'true' },
      });
      response = typeof result?.response === 'string' ? result.response.slice(0, 500) : undefined;
    } catch (err) {
      await this.recordSubmissionFailure(job, claim, err);
      return;
    }

    const [accepted] = await db
      .update(warmupSends)
      .set({ status: 'accepted', sentAt: new Date(), smtpResponse: response ?? null })
      .where(eq(warmupSends.id, claim.id))
      .returning();

    this.logger.info(
      {
        jobId,
        sendId: claim.id,
        senderInboxId,
        to: receiver.email,
        messageId: claim.messageId,
        warmupDay: claim.warmupDay,
        durationMs: Date.now() - startedAt,
      },
      'warmup send succeeded',
    );

    if (claim.receiverPoolInboxId) {
      // Best-effort active_pairs decrement (floor 0) — an approximation used
      // only to spread load across pool inboxes.
      await db
        .update(poolInboxes)
        .set({
          activePairs: sql`GREATEST(${poolInboxes.activePairs} - 1, 0)`,
          lastUsedAt: new Date(),
        })
        .where(eq(poolInboxes.id, claim.receiverPoolInboxId));
    }

    // If this throws (queue down), the row stays accepted with
    // receive_enqueued_at null and the ledger recovery sweep publishes it.
    // The job must not fail here: failing would retry an accepted send.
    try {
      await this.ledger.enqueueReceive(accepted);
    } catch (err) {
      this.logger.error(
        { jobId, sendId: claim.id, err: (err as Error)?.message },
        'warmup-send: receive job publish failed — left for recovery sweep',
      );
    }
  }

  /**
   * Scheduler-created jobs carry the id of their reserved row. Jobs queued by
   * the pre-ledger scheduler carry only the pairing; for those a row is
   * created on first attempt, keyed on the job id so a retry finds it again.
   */
  private async loadOrCreateIntent(job: Job<WarmupSendJobData>): Promise<WarmupSendRow | null> {
    const data = job.data;
    if (data.sendId) {
      const rows = await db
        .select()
        .from(warmupSends)
        .where(eq(warmupSends.id, data.sendId))
        .limit(1);
      return rows[0] ?? null;
    }

    const deliveryKey = `job-${String(job.id)}`;
    let receiverInboxId: string | null = null;
    let receiverPoolInboxId: string | null = null;
    if (data.partnerSource === 'private') {
      receiverPoolInboxId = data.partnerId;
    } else {
      const members = await db
        .select()
        .from(poolMembers)
        .where(eq(poolMembers.id, data.partnerId))
        .limit(1);
      if (!members[0]) {
        throw new UnrecoverableError(`Partner pool member ${data.partnerId} not found`);
      }
      receiverInboxId = members[0].inboxId;
    }

    await db
      .insert(warmupSends)
      .values({
        senderInboxId: data.senderInboxId,
        receiverInboxId,
        receiverPoolInboxId,
        messageId: `<${randomUUID()}@emailwarm.io>`,
        warmupDay: data.warmupDay,
        scheduledAt: new Date(data.scheduledAt),
        status: 'planned',
        deliveryKey,
      })
      .onConflictDoNothing({ target: warmupSends.deliveryKey });

    const rows = await db
      .select()
      .from(warmupSends)
      .where(eq(warmupSends.deliveryKey, deliveryKey))
      .limit(1);
    return rows[0] ?? null;
  }

  private async resolveReceiver(
    sender: InboxRow,
    send: WarmupSendRow,
  ): Promise<{ receiver: Receiver } | { ineligible: string }> {
    const senderDomain = domainOf(sender.email);

    if (send.receiverPoolInboxId) {
      const rows = await db
        .select()
        .from(poolInboxes)
        .where(eq(poolInboxes.id, send.receiverPoolInboxId))
        .limit(1);
      const poolInbox = rows[0];
      if (!poolInbox) return { ineligible: 'private pool inbox no longer exists' };
      if (poolInbox.userId !== sender.userId) {
        return { ineligible: 'private pool inbox belongs to a different account' };
      }
      if (poolInbox.status !== 'active') {
        return { ineligible: `private pool inbox is ${poolInbox.status}` };
      }
      if (domainOf(poolInbox.email) === senderDomain) {
        return { ineligible: 'receiver is on the sender domain' };
      }
      return { receiver: { email: poolInbox.email, industry: null } };
    }

    if (!send.receiverInboxId) return { ineligible: 'send has no receiver' };

    // Shared pool: both sides must have consented and be taking part right now.
    if (!sender.poolConsentAt) return { ineligible: 'sender has not consented to the shared pool' };

    const receiverRows = await db
      .select()
      .from(inboxes)
      .where(eq(inboxes.id, send.receiverInboxId))
      .limit(1);
    const receiver = receiverRows[0];
    if (!receiver) return { ineligible: 'receiver inbox no longer exists' };
    if (receiver.status !== 'active') return { ineligible: `receiver inbox is ${receiver.status}` };
    if (!receiver.poolConsentAt) {
      return { ineligible: 'receiver has not consented to the shared pool' };
    }
    if (domainOf(receiver.email) === senderDomain) {
      return { ineligible: 'receiver is on the sender domain' };
    }

    const memberRows = await db
      .select()
      .from(poolMembers)
      .where(
        and(
          eq(poolMembers.inboxId, receiver.id),
          eq(poolMembers.active, true),
          eq(poolMembers.quarantined, false),
        ),
      )
      .limit(1);
    if (!memberRows[0]) return { ineligible: 'receiver is not an active pool member' };

    // `industry` lives on pool_members (there is no inboxes.industry column).
    const senderMemberRows = await db
      .select()
      .from(poolMembers)
      .where(eq(poolMembers.inboxId, sender.id))
      .limit(1);

    return {
      receiver: { email: receiver.email, industry: senderMemberRows[0]?.industry ?? null },
    };
  }

  private async recordSubmissionFailure(
    job: Job<WarmupSendJobData>,
    send: WarmupSendRow,
    err: unknown,
  ): Promise<void> {
    const reason = describeSmtpError(err);

    if (err instanceof CredentialRevokedError) {
      // The credential service already stopped the inbox; nothing was sent.
      await db
        .update(warmupSends)
        .set({ status: 'canceled', failureReason: 'sender mailbox access revoked' })
        .where(eq(warmupSends.id, send.id));
      throw new UnrecoverableError(err.message);
    }

    const kind = classifySmtpError(err);
    this.logger.error(
      {
        jobId: String(job.id),
        sendId: send.id,
        senderInboxId: send.senderInboxId,
        outcome: kind,
        err: (err as Error)?.message,
        errCode: (err as { code?: string })?.code,
        errResponseCode: (err as { responseCode?: number })?.responseCode,
      },
      'warmup-send job failed',
    );

    if (kind === 'uncertain') {
      await this.markUncertain(send.id, reason);
      // Look for it in the partner's mailbox; finding it settles the question.
      await this.ledger.enqueueReceive({ ...send, status: 'uncertain' }).catch(() => undefined);
      throw new UnrecoverableError(`SMTP outcome uncertain for send ${send.id}: ${reason}`);
    }

    // A 5xx answer to the envelope or the message is the receiving side
    // permanently refusing this mail: a bounce, known immediately. It counts
    // toward the sender's bounce rate and is not worth retrying.
    if (isPermanentRejection(err)) {
      await db
        .update(warmupSends)
        .set({
          status: 'failed',
          failureReason: reason,
          bouncedAt: new Date(),
          bounceType: 'hard',
          bounceDetail: reason,
        })
        .where(eq(warmupSends.id, send.id));
      await this.bounces.enforce(send.senderInboxId).catch((enforceErr) => {
        this.logger.error(
          { sendId: send.id, err: (enforceErr as Error)?.message },
          'bounce-rate check failed after a rejected send',
        );
      });
      throw new UnrecoverableError(`Permanently rejected: ${reason}`);
    }

    await db
      .update(warmupSends)
      .set({ status: 'failed', failureReason: reason })
      .where(eq(warmupSends.id, send.id));
    // Plain Error: BullMQ may retry, and the claim accepts 'failed' rows.
    throw err instanceof Error ? err : new Error(reason);
  }

  private async markUncertain(sendId: string, reason: string): Promise<void> {
    await db
      .update(warmupSends)
      .set({ status: 'uncertain', failureReason: reason })
      .where(eq(warmupSends.id, sendId));
  }

  private async cancel(send: WarmupSendRow, reason: string): Promise<void> {
    await db
      .update(warmupSends)
      .set({ status: 'canceled', failureReason: reason })
      .where(and(eq(warmupSends.id, send.id), inArray(warmupSends.status, ['planned', 'failed'])));
    if (send.receiverPoolInboxId) {
      await db
        .update(poolInboxes)
        .set({ activePairs: sql`GREATEST(${poolInboxes.activePairs} - 1, 0)` })
        .where(eq(poolInboxes.id, send.receiverPoolInboxId));
    }
  }
}

function domainOf(email: string): string {
  return email.split('@')[1]?.toLowerCase() ?? '';
}
