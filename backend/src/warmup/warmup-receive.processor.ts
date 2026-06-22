import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { ImapFlow } from 'imapflow';
import { db } from '../db';
import { inboxes, poolInboxes, warmupSends } from '../db/schema';
import { ImapClientService, ImapNotConfiguredError } from '../inbox/imap/imap-client.service';
import { SmtpClientService } from '../inbox/smtp/smtp-client.service';
import { ContentService, WarmupEmail } from './content.service';

export type WarmupReceiveAction = 'open' | 'star' | 'reply' | 'rescue';
export type ReceiverSource = 'private' | 'shared';

export interface WarmupReceiveJobPayload {
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
}

const WARMUP_HUB_FOLDER = 'WarmupHub';

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

interface LocatedMessage {
  mailboxPath: string;
  seq: number;
  isSpam: boolean;
}

@Processor('warmup-receive')
@Injectable()
export class WarmupReceiveProcessor extends WorkerHost {
  private readonly logger = new Logger(WarmupReceiveProcessor.name);

  constructor(
    private readonly imapClientService: ImapClientService,
    private readonly smtpClientService: SmtpClientService,
    private readonly contentService: ContentService,
  ) {
    super();
  }

  async process(job: Job<WarmupReceiveJobPayload>): Promise<void> {
    const { receiverSource, receiverId, messageId, actions } = job.data;

    const receiver = await this.loadReceiver(receiverSource, receiverId);
    if (!receiver) {
      throw new Error(`Receiver not found: ${receiverSource}:${receiverId}`);
    }

    // No-op gracefully when the receiver doesn't have IMAP configured (custom-SMTP
    // inbox where the user opted out). Sending still works via SMTP; only the
    // receive path is skipped.
    let client: ImapFlow;
    try {
      client =
        receiverSource === 'private'
          ? await this.imapClientService.getPoolInboxConnection(receiver.id)
          : await this.imapClientService.getConnection(receiver.id);
    } catch (err: any) {
      if (err instanceof ImapNotConfiguredError) {
        this.logger.warn(
          `warmup-receive skipped for ${receiverSource}:${receiver.id}: IMAP not configured`,
        );
        return;
      }
      throw err;
    }
    const isGmail = receiver.provider === 'gmail';

    const located = await this.locateMessage(client, messageId, receiver.provider);
    if (!located) {
      throw new Error(`Message ${messageId} not found in any folder for receiver ${receiver.id}`);
    }

    const updates: Partial<typeof warmupSends.$inferInsert> = {};
    let current = located;

    if (located.isSpam) {
      updates.landedInSpam = true;
    }

    if (located.isSpam && actions.includes('rescue')) {
      await client.messageMove(current.seq, 'INBOX');
      updates.rescuedAt = new Date();
      const relocated = await this.locateInMailbox(client, 'INBOX', messageId, false);
      if (!relocated) {
        throw new Error('Rescued message not found in INBOX after move');
      }
      current = relocated;
    }

    const needsFetch =
      actions.includes('open') || actions.includes('star') || actions.includes('reply');
    const fetchResult = needsFetch
      ? await client.fetchOne(current.seq, { labels: true, envelope: true, bodyParts: ['text'] })
      : null;
    const fetched = fetchResult || null;

    if (isGmail) {
      updates.landedInTab = this.detectGmailTab(fetched?.labels);
    } else {
      updates.landedInTab = null;
    }

    if (actions.includes('open')) {
      await client.messageFlagsAdd(current.seq, ['\\Seen']);
      updates.openedAt = new Date();
    }

    if (actions.includes('star')) {
      await client.messageFlagsAdd(current.seq, ['\\Flagged']);
      updates.starredAt = new Date();
    }

    if (actions.includes('reply')) {
      await this.sendReply(receiverSource, receiver, messageId, fetched);
      updates.repliedAt = new Date();
    }

    await this.fileToWarmupHub(client, current.seq);
    updates.filedAt = new Date();

    await db.update(warmupSends).set(updates).where(eq(warmupSends.messageId, messageId));

    this.logger.log(
      `Processed warmup-receive for ${messageId} (${receiverSource}:${receiver.id}): actions=[${actions.join(',')}]${located.isSpam ? ' rescued-from-spam' : ''}`,
    );
  }

  /** shared: existing inboxes-table lookup, unchanged. private: pool_inboxes lookup. */
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
      return { id: poolInbox.id, email: poolInbox.email, provider: poolInbox.provider };
    }

    const rows = await db.select().from(inboxes).where(eq(inboxes.id, receiverId)).limit(1);
    const inbox = rows[0];
    if (!inbox) return null;
    return { id: inbox.id, email: inbox.email, provider: inbox.provider };
  }

  private async sendReply(
    receiverSource: ReceiverSource,
    receiver: ReceiverIdentity,
    originalMessageId: string,
    fetched: { envelope?: { subject?: string } } | null,
  ): Promise<void> {
    const original: WarmupEmail = {
      subject: fetched?.envelope?.subject ?? '',
      text: '',
      html: '',
    };
    const reply = await this.contentService.generateReply(original, { warmupDay: 0 });
    const transporter =
      receiverSource === 'private'
        ? await this.smtpClientService.getPoolInboxTransporter(receiver.id)
        : await this.smtpClientService.getTransporter(receiver.id);
    await transporter.sendMail({
      from: receiver.email,
      subject: reply.subject,
      text: reply.text,
      html: reply.html,
      headers: {
        'In-Reply-To': originalMessageId,
        References: originalMessageId,
      },
    });
  }

  /** Move the message to the WarmupHub folder/label, creating it first if missing. */
  private async fileToWarmupHub(client: ImapFlow, seq: number): Promise<void> {
    await this.ensureMailbox(client, WARMUP_HUB_FOLDER);
    await client.messageMove(seq, WARMUP_HUB_FOLDER);
  }

  /**
   * Ensures the mailbox exists without ever selecting it. Must never call
   * mailboxOpen on `path` here: doing so would change the currently selected
   * mailbox out from under the caller, which would break a subsequent
   * messageMove (its range is resolved against whatever mailbox is open).
   */
  private async ensureMailbox(client: ImapFlow, path: string): Promise<void> {
    try {
      await client.mailboxCreate(path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/already\s*exists/i.test(message)) {
        throw err;
      }
    }
  }

  /** Searches every folder for the message by Message-ID header, in list() order. */
  private async locateMessage(
    client: ImapFlow,
    messageId: string,
    provider: string,
  ): Promise<LocatedMessage | null> {
    const mailboxes = await client.list();
    const spamPath = this.spamFolderPath(provider, mailboxes);

    for (const mailbox of mailboxes) {
      const found = await this.locateInMailbox(
        client,
        mailbox.path,
        messageId,
        mailbox.path === spamPath || mailbox.specialUse === '\\Junk',
      );
      if (found) return found;
    }
    return null;
  }

  private async locateInMailbox(
    client: ImapFlow,
    mailboxPath: string,
    messageId: string,
    isSpam: boolean,
  ): Promise<LocatedMessage | null> {
    await client.mailboxOpen(mailboxPath);
    const results = await client.search({ header: { 'message-id': messageId } });
    if (!results || results.length === 0) return null;
    return { mailboxPath, seq: results[0], isSpam };
  }

  private spamFolderPath(
    provider: string,
    mailboxes: Array<{ path: string; specialUse?: string }>,
  ): string {
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
