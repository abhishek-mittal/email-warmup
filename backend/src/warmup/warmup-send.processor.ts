import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { randomUUID, createHash } from 'crypto';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { inboxes, poolMembers, warmupSends } from '../db/schema';
import { ContentService } from './content.service';
import { SmtpClientService } from '../inbox/smtp/smtp-client.service';
import { QueueService } from '../queue/queue.service';

export interface WarmupSendJobData {
  senderInboxId: string;
  partnerInboxId: string;
  warmupDay: number;
  scheduledAt: string;
}

const RECEIVE_DELAY_MIN_MS = 2 * 60_000;
const RECEIVE_DELAY_MAX_MS = 240 * 60_000;
const REPLY_PROBABILITY = 0.6;

@Injectable()
@Processor('warmup-send')
export class WarmupSendProcessor extends WorkerHost {
  private readonly logger = new Logger(WarmupSendProcessor.name);

  constructor(
    private readonly contentService: ContentService,
    private readonly smtpClientService: SmtpClientService,
    private readonly queueService: QueueService,
  ) {
    super();
  }

  async process(job: Job<WarmupSendJobData>): Promise<void> {
    const { senderInboxId, partnerInboxId, warmupDay } = job.data;

    const senderRows = await db
      .select()
      .from(inboxes)
      .where(eq(inboxes.id, senderInboxId))
      .limit(1);
    const sender = senderRows[0];
    if (!sender) {
      throw new UnrecoverableError(`Sender inbox ${senderInboxId} not found`);
    }
    if (sender.status !== 'active') {
      throw new UnrecoverableError(
        `Sender inbox ${senderInboxId} is not active (status=${sender.status})`,
      );
    }

    const poolMemberRows = await db
      .select()
      .from(poolMembers)
      .where(eq(poolMembers.id, partnerInboxId))
      .limit(1);
    const partnerPoolMember = poolMemberRows[0];
    if (!partnerPoolMember) {
      throw new UnrecoverableError(`Partner pool member ${partnerInboxId} not found`);
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

    await this.enqueueReceiveJob(receiver.id, messageId, warmupDay, sendRecord?.id);
  }

  private async enqueueReceiveJob(
    receiverInboxId: string,
    messageId: string,
    warmupDay: number,
    currentSendId?: string,
  ): Promise<void> {
    const actions: string[] = ['open', 'star'];

    if (Math.random() < REPLY_PROBABILITY) {
      actions.push('reply');
    }

    const landedInSpam = await this.didPreviousSendLandInSpam(receiverInboxId, currentSendId);
    if (landedInSpam) {
      actions.push('rescue');
    }

    const delay =
      RECEIVE_DELAY_MIN_MS +
      Math.floor(Math.random() * (RECEIVE_DELAY_MAX_MS - RECEIVE_DELAY_MIN_MS));

    await this.queueService.add(
      'warmup-receive',
      {
        receiverInboxId,
        messageId,
        warmupDay,
        actions,
        executeAt: new Date(Date.now() + delay).toISOString(),
      },
      { delay },
    );
  }

  private async didPreviousSendLandInSpam(
    receiverInboxId: string,
    excludeSendId?: string,
  ): Promise<boolean> {
    const rows = await db
      .select()
      .from(warmupSends)
      .where(eq(warmupSends.receiverInboxId, receiverInboxId))
      .orderBy(desc(warmupSends.sentAt))
      .limit(excludeSendId ? 2 : 1);

    const previous = excludeSendId ? rows.find((row) => row.id !== excludeSendId) : rows[0];
    return Boolean(previous?.landedInSpam);
  }
}
