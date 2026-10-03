import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { and, eq, isNull } from 'drizzle-orm';
import type { ImapFlow } from 'imapflow';
import { db } from '../db';
import { inboxes, poolInboxes, warmupSends } from '../db/schema';
import { ImapClientService, ImapNotConfiguredError } from '../inbox/imap/imap-client.service';
import { SmtpClientService } from '../inbox/smtp/smtp-client.service';
import { CredentialRevokedError } from '../inbox/oauth/oauth-errors';
import { ContentService, WarmupEmail } from './content.service';
import { PreSubmissionError, classifySmtpError, describeSmtpError } from './smtp-outcome';
import { WarmupLedgerService, WarmupSendRow } from './warmup-ledger.service';
import { WARMUP_HEADER } from './warmup-send.processor';
import { SafetyStopService } from '../safety/safety-stop.service';

export type WarmupReceiveAction = 'open' | 'star' | 'reply' | 'rescue';
export type ReceiverSource = 'private' | 'shared';

export interface WarmupReceiveJobPayload {
  /** 'reply-filing' files a warmup reply out of the original sender's inbox. */
  kind?: 'engage' | 'reply-filing';
  sendId?: string;
  receiverSource: ReceiverSource;
  receiverId: string;
  messageId: string;
  actions: WarmupReceiveAction[];
  executeAt: string;
}

interface ReceiverIdentity {
  id: string;
  email: string;
  provider: string;
  status: string;
  userId: string;
}

export const WARMUP_HUB_FOLDER = 'WarmupHub';

/** How much of the original message is handed to the reply generator. */
const REPLY_CONTEXT_MAX_BYTES = 2000;

// Gmail category labels map to the inbox "tabs" users see (Promotions, Social, etc).
// Anything outside this set (or non-Gmail providers) is left undetected (null) —
// precise tab detection is out of scope here; see T014 (placement testing).
const GMAIL_TAB_LABELS: Record<string, string> = {
  '\\Category\\Personal': 'primary',
  '\\Category\\Social': 'social',
  '\\Category\\Promotions': 'promotions',
  '\\Category\\Updates': 'updates',
  '\\Category\\Forums': 'forums',
};

interface MailboxInfo {
  path: string;
  specialUse?: string;
  flags?: Set<string>;
}

interface LocatedMessage {
  mailboxPath: string;
  /** IMAP UID — stable for the life of the mailbox, unlike a sequence number. */
  uid: number;
  isSpam: boolean;
  isWarmupHub: boolean;
}

/** The message has not arrived yet. Thrown as a plain Error so BullMQ retries with backoff. */
export class MessageNotDeliveredYetError extends Error {
  constructor(messageId: string, receiverId: string) {
    super(`Message ${messageId} not found in any folder for receiver ${receiverId}`);
    this.name = 'MessageNotDeliveredYetError';
  }
}

/**
 * Engages with a delivered warmup email in the receiver's mailbox (MR-02):
 * rescue from spam, open, star, reply, file into WarmupHub.
 *
 * Each action is written to `warmup_sends` the moment it succeeds, and a retry
 * skips whatever is already recorded — so a failure half-way never repeats an
 * action. All IMAP work for one mailbox is serialized and addresses messages
 * by UID under a mailbox lock.
 */
@Processor('warmup-receive')
@Injectable()
export class WarmupReceiveProcessor extends WorkerHost {
  constructor(
    @InjectPinoLogger(WarmupReceiveProcessor.name)
    private readonly logger: PinoLogger,
    private readonly imapClientService: ImapClientService,
    private readonly smtpClientService: SmtpClientService,
    private readonly contentService: ContentService,
    private readonly ledger: WarmupLedgerService,
    private readonly stops: SafetyStopService,
  ) {
    super();
  }

  async process(job: Job<WarmupReceiveJobPayload>): Promise<void> {
    const { receiverSource, receiverId, messageId, actions } = job.data;
    const jobId = String(job.id);

    this.logger.info(
      { jobId, receiverSource, receiverId, messageId, actions, kind: job.data.kind ?? 'engage' },
      'warmup-receive job started',
    );

    const send = await this.loadSend(job.data);
    if (!send) {
      throw new UnrecoverableError(`No warmup send recorded for message ${messageId}`);
    }

    const receiver = await this.loadReceiver(receiverSource, receiverId);
    if (!receiver) {
      this.logger.warn({ jobId, receiverSource, receiverId }, 'warmup-receive: receiver not found');
      throw new UnrecoverableError(`Receiver not found: ${receiverSource}:${receiverId}`);
    }
    // A paused/removed/errored mailbox must not be touched by a job that was
    // queued while it was still taking part.
    // Filing a reply is cleanup, not engagement, so it still runs for a paused inbox.
    if (receiver.status !== 'active' && job.data.kind !== 'reply-filing') {
      this.logger.warn(
        { jobId, receiverId: receiver.id, status: receiver.status },
        'warmup-receive skipped: receiver is not active',
      );
      return;
    }

    const run = (fn: (client: ImapFlow) => Promise<void>) =>
      receiverSource === 'private'
        ? this.imapClientService.withPoolInbox(receiver.id, fn)
        : this.imapClientService.withInbox(receiver.id, fn);

    try {
      if (job.data.kind === 'reply-filing') {
        await run((client) => this.fileReply(client, jobId, send, receiver, messageId));
      } else {
        await run((client) => this.engage(client, jobId, send, receiver, receiverSource, actions));
      }
    } catch (err) {
      // No-op gracefully when the receiver doesn't have IMAP configured (custom-SMTP
      // inbox where the user opted out). Sending still works via SMTP; only the
      // receive path is skipped.
      if (err instanceof ImapNotConfiguredError) {
        this.logger.warn(
          { jobId, receiverSource, receiverId: receiver.id },
          'warmup-receive skipped: IMAP not configured',
        );
        return;
      }
      if (err instanceof CredentialRevokedError) {
        throw new UnrecoverableError(err.message);
      }
      throw err;
    }
  }

  private async engage(
    client: ImapFlow,
    jobId: string,
    initial: WarmupSendRow,
    receiver: ReceiverIdentity,
    receiverSource: ReceiverSource,
    actions: WarmupReceiveAction[],
  ): Promise<void> {
    let send = initial;
    const messageId = send.messageId!;
    const mailboxes = (await client.list()) as MailboxInfo[];

    let located = await this.locateMessage(client, mailboxes, messageId, receiver.provider);
    if (!located) {
      this.logger.warn(
        { jobId, receiverId: receiver.id, messageId },
        'warmup-receive: message not found in any folder',
      );
      throw new MessageNotDeliveredYetError(messageId, receiver.id);
    }
    this.logger.info(
      { jobId, receiverId: receiver.id, messageId, found: true, isSpam: located.isSpam },
      'warmup-receive: message located',
    );

    // Seeing the message in the partner's mailbox is proof of delivery, which
    // settles a send whose SMTP acknowledgement was lost.
    if (send.status !== 'accepted') {
      send = await this.record(send.id, {
        status: 'accepted',
        sentAt: send.sentAt ?? new Date(),
        failureReason: null,
      });
      this.logger.info(
        { jobId, sendId: send.id },
        'uncertain send reconciled: message was delivered',
      );
    }

    // Placement is recorded from where THIS message was found, before anything moves it.
    if (located.isSpam && !send.landedInSpam) {
      send = await this.record(send.id, { landedInSpam: true });
    }

    // Rescue is driven by this message's own placement, not a previous send's.
    if (located.isSpam) {
      const inboxPath = mailboxes.find((m) => m.specialUse === '\\Inbox')?.path ?? 'INBOX';
      await this.moveMessage(client, located, inboxPath);
      send = await this.record(send.id, { rescuedAt: send.rescuedAt ?? new Date() });
      this.logger.info(
        { jobId, receiverId: receiver.id, rescued: true, messageId },
        'rescued message from spam to INBOX',
      );
      const relocated = await this.locateInMailbox(client, inboxPath, messageId, false, false);
      if (!relocated) {
        throw new Error('Rescued message not found in INBOX after move');
      }
      located = relocated;
    }

    const wantsReply = actions.includes('reply') && !send.repliedAt && !send.replyStatus;
    const fetched = await this.withMailbox(client, located.mailboxPath, () =>
      client.fetchOne(
        String(located!.uid),
        {
          envelope: true,
          labels: receiver.provider === 'gmail',
          ...(wantsReply
            ? { bodyParts: [{ key: '1', start: 0, maxLength: REPLY_CONTEXT_MAX_BYTES }] }
            : {}),
        } as Parameters<ImapFlow['fetchOne']>[1],
        { uid: true },
      ),
    );
    const message = fetched || null;

    if (receiver.provider === 'gmail' && send.landedInTab == null) {
      const tab = this.detectGmailTab(message ? (message.labels as Set<string>) : undefined);
      if (tab) send = await this.record(send.id, { landedInTab: tab });
    }

    if (actions.includes('open') && !send.openedAt) {
      await this.addFlag(client, located, '\\Seen');
      send = await this.record(send.id, { openedAt: new Date() });
      this.logger.debug(
        { jobId, action: 'open', receiverId: receiver.id, messageId },
        'action completed',
      );
    }

    if (actions.includes('star') && !send.starredAt) {
      await this.addFlag(client, located, '\\Flagged');
      send = await this.record(send.id, { starredAt: new Date() });
      this.logger.debug(
        { jobId, action: 'star', receiverId: receiver.id, messageId },
        'action completed',
      );
    }

    if (wantsReply) {
      const bodyPart = message?.bodyParts?.get('1');
      send = await this.sendReply(jobId, send, receiver, receiverSource, {
        subject: message?.envelope?.subject ?? send.subject ?? '',
        text: bodyPart ? bodyPart.toString('utf8') : '',
        html: '',
      });
    }

    // Filing always runs, whatever happened to the reply: a failed reply must
    // not leave warmup mail sitting in a real inbox.
    if (!located.isWarmupHub) {
      await this.ensureMailbox(client, mailboxes, WARMUP_HUB_FOLDER);
      await this.moveMessage(client, located, WARMUP_HUB_FOLDER);
    }
    if (!send.filedAt) {
      send = await this.record(send.id, { filedAt: new Date() });
    }
    this.logger.debug(
      { jobId, action: 'file', receiverId: receiver.id, messageId },
      'action completed',
    );

    this.logger.info(
      {
        jobId,
        receiverSource,
        receiverId: receiver.id,
        messageId,
        actions,
        rescued: Boolean(send.rescuedAt),
        replyStatus: send.replyStatus,
      },
      'warmup-receive job succeeded',
    );
  }

  /**
   * Sends the reply to the address the original was recorded as coming from —
   * never to a Reply-To/From taken out of the received message.
   *
   * The reply has its own two-step ledger entry: the deterministic Message-ID
   * and 'submitting' are written first, so a retry after a lost
   * acknowledgement sees the attempt and does not send a second reply.
   */
  private async sendReply(
    jobId: string,
    send: WarmupSendRow,
    receiver: ReceiverIdentity,
    receiverSource: ReceiverSource,
    original: WarmupEmail,
  ): Promise<WarmupSendRow> {
    const senderRows = await db
      .select()
      .from(inboxes)
      .where(eq(inboxes.id, send.senderInboxId))
      .limit(1);
    const originalSender = senderRows[0];
    if (!originalSender || originalSender.status !== 'active') {
      this.logger.info(
        { jobId, sendId: send.id },
        'reply skipped: original sender is no longer active',
      );
      return send;
    }

    // A reply is a new submission from the receiver's mailbox, so a stop
    // switch on that account or provider holds it back. Opening and filing go on.
    const stop = await this.stops.activeStopFor({
      userId: receiver.userId,
      provider: receiver.provider,
    });
    if (stop) {
      this.logger.warn(
        { jobId, sendId: send.id, stopId: stop.id },
        'reply skipped: stop switch active',
      );
      return send;
    }

    const replyMessageId = `<reply-${send.id}@emailwarm.io>`;
    const claimed = await db
      .update(warmupSends)
      .set({ replyMessageId, replyStatus: 'submitting' })
      .where(and(eq(warmupSends.id, send.id), isNull(warmupSends.replyStatus)))
      .returning();
    if (!claimed[0]) return send;

    try {
      const reply = await this.contentService.generateReply(original, {
        warmupDay: send.warmupDay,
      });
      const transporter = await (
        receiverSource === 'private'
          ? this.smtpClientService.getPoolInboxTransporter(receiver.id)
          : this.smtpClientService.getTransporter(receiver.id)
      ).catch((err) => {
        throw err instanceof CredentialRevokedError ? err : new PreSubmissionError(err);
      });
      await transporter.sendMail({
        from: receiver.email,
        to: originalSender.email,
        subject: reply.subject,
        text: reply.text,
        html: reply.html,
        messageId: replyMessageId,
        inReplyTo: send.messageId!,
        references: [send.messageId!],
        headers: { [WARMUP_HEADER]: 'true' },
      });
    } catch (err) {
      const kind = err instanceof CredentialRevokedError ? 'failed' : classifySmtpError(err);
      this.logger.error(
        { jobId, sendId: send.id, outcome: kind, err: describeSmtpError(err) },
        'warmup reply failed',
      );
      const updated = await this.record(send.id, { replyStatus: kind });
      if (kind === 'uncertain') {
        // It may have gone out; make sure it gets filed if it did.
        await this.ledger.enqueueReplyFiling(updated).catch(() => undefined);
      }
      return updated;
    }

    const updated = await this.record(send.id, { replyStatus: 'accepted', repliedAt: new Date() });
    this.logger.debug(
      { jobId, action: 'reply', receiverId: receiver.id, messageId: send.messageId },
      'action completed',
    );
    try {
      await this.ledger.enqueueReplyFiling(updated);
    } catch (err) {
      this.logger.error(
        { jobId, sendId: send.id, err: (err as Error)?.message },
        'reply-filing job publish failed',
      );
    }
    return updated;
  }

  /** Marks a warmup reply read and files it out of the original sender's inbox. */
  private async fileReply(
    client: ImapFlow,
    jobId: string,
    send: WarmupSendRow,
    mailboxOwner: ReceiverIdentity,
    replyMessageId: string,
  ): Promise<void> {
    if (send.replyFiledAt) return;
    const mailboxes = (await client.list()) as MailboxInfo[];
    const located = await this.locateMessage(
      client,
      mailboxes,
      replyMessageId,
      mailboxOwner.provider,
    );
    if (!located) {
      throw new MessageNotDeliveredYetError(replyMessageId, mailboxOwner.id);
    }

    if (send.replyStatus === 'uncertain') {
      await this.record(send.id, {
        replyStatus: 'accepted',
        repliedAt: send.repliedAt ?? new Date(),
      });
    }

    await this.addFlag(client, located, '\\Seen');
    if (!located.isWarmupHub) {
      await this.ensureMailbox(client, mailboxes, WARMUP_HUB_FOLDER);
      await this.moveMessage(client, located, WARMUP_HUB_FOLDER);
    }
    await this.record(send.id, { replyFiledAt: new Date() });
    this.logger.info(
      { jobId, sendId: send.id, mailboxOwnerId: mailboxOwner.id },
      'warmup reply filed to WarmupHub',
    );
  }

  private async loadSend(data: WarmupReceiveJobPayload): Promise<WarmupSendRow | null> {
    const rows = data.sendId
      ? await db.select().from(warmupSends).where(eq(warmupSends.id, data.sendId)).limit(1)
      : await db
          .select()
          .from(warmupSends)
          .where(eq(warmupSends.messageId, data.messageId))
          .limit(1);
    return rows[0] ?? null;
  }

  private async record(
    sendId: string,
    updates: Partial<typeof warmupSends.$inferInsert>,
  ): Promise<WarmupSendRow> {
    const [row] = await db
      .update(warmupSends)
      .set(updates)
      .where(eq(warmupSends.id, sendId))
      .returning();
    return row;
  }

  /** shared: inboxes-table lookup. private: pool_inboxes lookup. */
  private async loadReceiver(
    receiverSource: ReceiverSource,
    receiverId: string,
  ): Promise<ReceiverIdentity | null> {
    if (receiverSource === 'private') {
      const rows = await db
        .select()
        .from(poolInboxes)
        .where(eq(poolInboxes.id, receiverId))
        .limit(1);
      const poolInbox = rows[0];
      if (!poolInbox) return null;
      return {
        id: poolInbox.id,
        email: poolInbox.email,
        provider: poolInbox.provider,
        status: poolInbox.status,
        userId: poolInbox.userId,
      };
    }

    const rows = await db.select().from(inboxes).where(eq(inboxes.id, receiverId)).limit(1);
    const inbox = rows[0];
    if (!inbox) return null;
    return {
      id: inbox.id,
      email: inbox.email,
      provider: inbox.provider,
      status: inbox.status,
      userId: inbox.userId,
    };
  }

  /** Runs `fn` with `path` selected and locked, so nothing else can reselect mid-operation. */
  private async withMailbox<T>(client: ImapFlow, path: string, fn: () => Promise<T>): Promise<T> {
    const lock = await client.getMailboxLock(path);
    try {
      return await fn();
    } finally {
      lock.release();
    }
  }

  private async addFlag(client: ImapFlow, located: LocatedMessage, flag: string): Promise<void> {
    await this.withMailbox(client, located.mailboxPath, () =>
      client.messageFlagsAdd(String(located.uid), [flag], { uid: true }),
    );
  }

  private async moveMessage(
    client: ImapFlow,
    located: LocatedMessage,
    destination: string,
  ): Promise<void> {
    if (located.mailboxPath === destination) return;
    await this.withMailbox(client, located.mailboxPath, () =>
      client.messageMove(String(located.uid), destination, { uid: true }),
    );
  }

  /**
   * Creates the mailbox if the server doesn't already list it. Checking the
   * listing first avoids depending on how a given server words (or codes) its
   * "already exists" failure.
   */
  private async ensureMailbox(
    client: ImapFlow,
    mailboxes: MailboxInfo[],
    path: string,
  ): Promise<void> {
    if (mailboxes.some((m) => m.path === path)) return;
    try {
      await client.mailboxCreate(path);
    } catch (err) {
      // Lost a race with another connection creating it — fine if it's there now.
      const refreshed = (await client.list()) as MailboxInfo[];
      if (!refreshed.some((m) => m.path === path)) throw err;
    }
  }

  /**
   * Searches selectable folders for the message by Message-ID header: Inbox
   * first, then Junk, then WarmupHub (already filed by an earlier attempt),
   * then everything else, with "All Mail"-style aggregates last.
   */
  private async locateMessage(
    client: ImapFlow,
    mailboxes: MailboxInfo[],
    messageId: string,
    provider: string,
  ): Promise<LocatedMessage | null> {
    const spamPath = this.spamFolderPath(provider, mailboxes);

    for (const mailbox of this.searchOrder(mailboxes, spamPath)) {
      const found = await this.locateInMailbox(
        client,
        mailbox.path,
        messageId,
        mailbox.path === spamPath || mailbox.specialUse === '\\Junk',
        mailbox.path === WARMUP_HUB_FOLDER,
      );
      if (found) return found;
    }
    return null;
  }

  private searchOrder(mailboxes: MailboxInfo[], spamPath: string): MailboxInfo[] {
    const rank = (m: MailboxInfo): number => {
      if (m.specialUse === '\\Inbox' || m.path.toUpperCase() === 'INBOX') return 0;
      if (m.path === spamPath || m.specialUse === '\\Junk') return 1;
      if (m.path === WARMUP_HUB_FOLDER) return 2;
      if (m.specialUse === '\\All') return 4;
      return 3;
    };
    return mailboxes
      .filter((m) => {
        // Container folders such as Gmail's "[Gmail]" cannot be selected.
        if (m.flags?.has('\\Noselect') || m.flags?.has('\\NonExistent')) return false;
        // The receiver never has a copy of an inbound message here.
        return m.specialUse !== '\\Sent' && m.specialUse !== '\\Drafts';
      })
      .sort((a, b) => rank(a) - rank(b));
  }

  private async locateInMailbox(
    client: ImapFlow,
    mailboxPath: string,
    messageId: string,
    isSpam: boolean,
    isWarmupHub: boolean,
  ): Promise<LocatedMessage | null> {
    return this.withMailbox(client, mailboxPath, async () => {
      const results = await client.search({ header: { 'message-id': messageId } }, { uid: true });
      if (!results || results.length === 0) return null;
      return { mailboxPath, uid: results[results.length - 1], isSpam, isWarmupHub };
    });
  }

  private spamFolderPath(provider: string, mailboxes: MailboxInfo[]): string {
    const byHardcodedName =
      provider === 'gmail'
        ? mailboxes.find((m) => m.path === '[Gmail]/Spam')
        : mailboxes.find((m) => m.path === 'Junk Email');
    if (byHardcodedName) return byHardcodedName.path;

    const bySpecialUse = mailboxes.find((m) => m.specialUse === '\\Junk');
    if (bySpecialUse) return bySpecialUse.path;

    return provider === 'gmail' ? '[Gmail]/Spam' : 'Junk Email';
  }

  private detectGmailTab(labels: Set<string> | undefined): string | null {
    if (!labels) return null;
    for (const label of labels) {
      const tab = GMAIL_TAB_LABELS[label];
      if (tab) return tab;
    }
    return null;
  }
}
