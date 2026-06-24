import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { randomUUID, createHash } from 'crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { inboxes, poolInboxes, poolMembers, warmupSends } from '../db/schema';
import { ContentService } from './content.service';
import { SmtpClientService } from '../inbox/smtp/smtp-client.service';
import { QueueService } from '../queue/queue.service';

export type PartnerSource = 'private' | 'shared';

export interface WarmupSendJobData {
  senderInboxId: string;
  partnerSource: PartnerSource;
  partnerId: string;
  warmupDay: number;
  scheduledAt: string;
}

const RECEIVE_DELAY_MIN_MS = 2 * 60_000;
const RECEIVE_DELAY_MAX_MS = 240 * 60_000;
const REPLY_PROBABILITY = 0.6;

interface ReceiverIdentity {
  id: string;
  email: string;
}

@Injectable()
@Processor('warmup-send')
export class WarmupSendProcessor extends WorkerHost {
  constructor(
    @InjectPinoLogger(WarmupSendProcessor.name)
    private readonly logger: PinoLogger,
    private readonly contentService: ContentService,
    private readonly smtpClientService: SmtpClientService,
    private readonly queueService: QueueService,
  ) {
    super();
  }

  async process(job: Job<WarmupSendJobData>): Promise<void> {
    const { senderInboxId, partnerSource, partnerId, warmupDay } = job.data;
    const jobId = String(job.id);
    const startedAt = Date.now();

    this.logger.info(
      { jobId, senderInboxId, partnerSource, partnerId, warmupDay },
      'warmup-send job started',
    );

    const senderRows = await db
      .select()
      .from(inboxes)
      .where(eq(inboxes.id, senderInboxId))
      .limit(1);
    const sender = senderRows[0];
    if (!sender) {
      this.logger.warn(
        { jobId, senderInboxId },
        'warmup-send: sender inbox not found',
      );
      throw new UnrecoverableError(`Sender inbox ${senderInboxId} not found`);
    }
    if (sender.status !== 'active') {
      this.logger.warn(
        { jobId, senderInboxId, status: sender.status },
        'warmup-send: sender inbox not active',
      );
      throw new UnrecoverableError(
        `Sender inbox ${senderInboxId} is not active (status=${sender.status})`,
      );
    }

    try {
      if (partnerSource === 'private') {
        await this.processPrivatePoolSend(job, sender, partnerId, warmupDay);
      } else {
        await this.processSharedPoolSend(job, sender, partnerId, warmupDay);
      }
      this.logger.info(
        {
          jobId,
          senderInboxId,
          partnerSource,
          partnerId,
          warmupDay,
          durationMs: Date.now() - startedAt,
        },
        'warmup-send job succeeded',
      );
    } catch (err: any) {
      this.logger.error(
        {
          jobId,
          senderInboxId,
          partnerSource,
          partnerId,
          err: err?.message,
          errCode: err?.code,
        },
        'warmup-send job failed',
      );
      throw err;
    }
  }

  /** Shared pool_members path — exact existing logic, unchanged behavior. */
  private async processSharedPoolSend(
    job: Job<WarmupSendJobData>,
    sender: typeof inboxes.$inferSelect,
    partnerId: string,
    warmupDay: number,
  ): Promise<void> {
    const senderInboxId = sender.id;

    const poolMemberRows = await db
      .select()
      .from(poolMembers)
      .where(eq(poolMembers.id, partnerId))
      .limit(1);
    const partnerPoolMember = poolMemberRows[0];
    if (!partnerPoolMember) {
      throw new UnrecoverableError(`Partner pool member ${partnerId} not found`);
    }

    const receiverRows = await db
      .select()
      .from(inboxes)
      .where(eq(inboxes.id, partnerPoolMember.inboxId))
      .limit(1);
    const receiver = receiverRows[0];
    if (!receiver) {
      throw new UnrecoverableError(`Receiver inbox ${partnerPoolMember.inboxId} not found`);
    }

    // `industry` lives on pool_members (the schema has no inboxes.industry column),
    // so look up the sender's own pool membership row to find it.
    const senderPoolMemberRows = await db
      .select()
      .from(poolMembers)
      .where(eq(poolMembers.inboxId, senderInboxId))
      .limit(1);
    const senderIndustry = senderPoolMemberRows[0]?.industry ?? null;

    const email = await this.contentService.generateEmail({
      warmupDay,
      industry: senderIndustry,
    });

    const transporter = await this.smtpClientService.getTransporter(senderInboxId);
    const messageId = `<${randomUUID()}@emailwarm.io>`;
    const sendStart = Date.now();

    await transporter.sendMail({
      from: sender.email,
      to: receiver.email,
      subject: email.subject,
      text: email.text,
      html: email.html,
      headers: {
        'Message-ID': messageId,
        'X-WarmupHub': 'true',
      },
    });

    this.logger.info(
      {
        jobId: String(job.id),
        senderInboxId,
        to: receiver.email,
        messageId,
        warmupDay,
        durationMs: Date.now() - sendStart,
      },
      'warmup send succeeded',
    );

    const bodyHash = createHash('sha256').update(email.text).digest('hex');
    const sentAt = new Date();

    const [sendRecord] = await db
      .insert(warmupSends)
      .values({
        senderInboxId,
        receiverInboxId: receiver.id,
        messageId,
        subject: email.subject,
        bodyHash,
        warmupDay,
        scheduledAt: new Date(job.data.scheduledAt),
        sentAt,
      })
      .returning();

    await this.enqueueReceiveJob(
      'shared',
      { id: receiver.id, email: receiver.email },
      messageId,
      warmupDay,
      sendRecord?.id,
    );
  }

  /**
   * Private pool path — receiver identity comes from pool_inboxes (no
   * inboxes row exists for it). Sending still goes through the sender's own
   * SMTP transporter (the SENDER is always an `inboxes` row regardless of
   * who the partner is); only the receiver's identity/table changes.
   */
  private async processPrivatePoolSend(
    job: Job<WarmupSendJobData>,
    sender: typeof inboxes.$inferSelect,
    partnerId: string,
    warmupDay: number,
  ): Promise<void> {
    const senderInboxId = sender.id;

    const poolInboxRows = await db
      .select()
      .from(poolInboxes)
      .where(eq(poolInboxes.id, partnerId))
      .limit(1);
    const poolInbox = poolInboxRows[0];
    if (!poolInbox) {
      throw new UnrecoverableError(`Partner pool inbox ${partnerId} not found`);
    }

    // No pool_members row applies here — private pool inboxes carry no industry.
    const email = await this.contentService.generateEmail({
      warmupDay,
      industry: null,
    });

    const transporter = await this.smtpClientService.getTransporter(senderInboxId);
    const messageId = `<${randomUUID()}@emailwarm.io>`;
    const sendStart = Date.now();

    await transporter.sendMail({
      from: sender.email,
      to: poolInbox.email,
      subject: email.subject,
      text: email.text,
      html: email.html,
      headers: {
        'Message-ID': messageId,
        'X-WarmupHub': 'true',
      },
    });

    this.logger.info(
      {
        jobId: String(job.id),
        senderInboxId,
        to: poolInbox.email,
        messageId,
        warmupDay,
        durationMs: Date.now() - sendStart,
      },
      'warmup send succeeded',
    );

    const bodyHash = createHash('sha256').update(email.text).digest('hex');
    const sentAt = new Date();

    const [sendRecord] = await db
      .insert(warmupSends)
      .values({
        senderInboxId,
        receiverPoolInboxId: poolInbox.id,
        messageId,
        subject: email.subject,
        bodyHash,
        warmupDay,
        scheduledAt: new Date(job.data.scheduledAt),
        sentAt,
      })
      .returning();

    // Best-effort active_pairs decrement (floor 0) now that the send completed —
    // this counter is an approximation per the spec, not transactionally precise.
    await db
      .update(poolInboxes)
      .set({ activePairs: sql`GREATEST(${poolInboxes.activePairs} - 1, 0)` })
      .where(eq(poolInboxes.id, poolInbox.id));

    await this.enqueueReceiveJob(
      'private',
      { id: poolInbox.id, email: poolInbox.email },
      messageId,
      warmupDay,
      sendRecord?.id,
    );
  }

  private async enqueueReceiveJob(
    receiverSource: PartnerSource,
    receiver: ReceiverIdentity,
    messageId: string,
    warmupDay: number,
    currentSendId?: string,
  ): Promise<void> {
    const actions: string[] = ['open', 'star'];

    if (Math.random() < REPLY_PROBABILITY) {
      actions.push('reply');
    }

    const landedInSpam = await this.didPreviousSendLandInSpam(
      receiverSource,
      receiver.id,
      currentSendId,
    );
    if (landedInSpam) {
      actions.push('rescue');
    }

    const delay =
      RECEIVE_DELAY_MIN_MS +
      Math.floor(Math.random() * (RECEIVE_DELAY_MAX_MS - RECEIVE_DELAY_MIN_MS));

    const payload: Record<string, unknown> = {
      receiverSource,
      receiverId: receiver.id,
      messageId,
      warmupDay,
      actions,
      executeAt: new Date(Date.now() + delay).toISOString(),
    };

    // Preserved verbatim for the shared-pool case so QueueService.removeJobsForReceiver
    // (keyed on literal `data.receiverInboxId`, outside this task's file ownership)
    // keeps draining pending warmup-receive jobs when a shared-pool inbox is paused.
    // Private-pool receivers have no equivalent pause path, so this key is simply
    // omitted for them.
    if (receiverSource === 'shared') {
      payload.receiverInboxId = receiver.id;
    }

    await this.queueService.add('warmup-receive', payload, { delay });
    this.logger.debug(
      {
        receiverSource,
        receiverId: receiver.id,
        actions,
        delayMs: delay,
      },
      'warmup-receive job enqueued',
    );
  }

  private async didPreviousSendLandInSpam(
    receiverSource: PartnerSource,
    receiverId: string,
    excludeSendId?: string,
  ): Promise<boolean> {
    const receiverColumn =
      receiverSource === 'private' ? warmupSends.receiverPoolInboxId : warmupSends.receiverInboxId;

    const rows = await db
      .select()
      .from(warmupSends)
      .where(and(eq(receiverColumn, receiverId)))
      .orderBy(desc(warmupSends.sentAt))
      .limit(excludeSendId ? 2 : 1);

    const previous = excludeSendId ? rows.find((row) => row.id !== excludeSendId) : rows[0];
    return Boolean(previous?.landedInSpam);
  }
}
