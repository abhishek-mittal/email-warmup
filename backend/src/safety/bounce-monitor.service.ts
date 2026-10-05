import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Cron } from '@nestjs/schedule';
import { and, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import type { ImapFlow } from 'imapflow';
import { db } from '../db';
import { inboxes, poolInboxes, warmupSends } from '../db/schema';
import { ImapClientService, ImapNotConfiguredError } from '../inbox/imap/imap-client.service';
import { WarmupService } from '../warmup/warmup.service';
import { QueueService } from '../queue/queue.service';
import { parseDsn } from './dsn-parser';

/** PRD hard constraint: pause when more than this share of sends bounce in the window. */
export const BOUNCE_RATE_LIMIT = 0.03;
export const BOUNCE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const BOUNCE_PAUSE_REASON = 'bounce_rate';

/** How far back the mailbox is searched for bounce notices. */
const SCAN_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;
/** Notices read per mailbox per scan; the rest wait for the next run. */
const MAX_NOTICES_PER_SCAN = 50;
/** Bytes of each notice that are read. The parts that matter are at the top. */
const NOTICE_MAX_BYTES = 64 * 1024;
const WARMUP_HUB_FOLDER = 'WarmupHub';

export interface BounceStats {
  /** Sends attempted in the window: every send a worker actually claimed. */
  attempted: number;
  /** Of those, sends with confirmed permanent failure. Each send counts once. */
  bounced: number;
  /** bounced / attempted, 0 when nothing was attempted. */
  rate: number;
  limit: number;
  windowHours: number;
}

/**
 * Bounce protection (MR-12).
 *
 * Evidence comes from two places: a permanent rejection during SMTP
 * submission (recorded by the send worker), and delivery status notifications
 * that arrive later in the sender's own mailbox (read here over IMAP).
 *
 * A notice only counts when it names a Message-ID this system generated AND
 * that message really was sent from the mailbox the notice arrived in — a
 * bounce-shaped email about anything else changes nothing. Each send holds
 * at most one bounce, so duplicate or repeated notices can't inflate the rate.
 *
 * When more than 3% of an inbox's attempted sends in the last 24 hours have
 * bounced it is paused with reason 'bounce_rate', which a user's Resume click
 * does not override.
 */
@Injectable()
export class BounceMonitorService {
  constructor(
    @InjectPinoLogger(BounceMonitorService.name)
    private readonly logger: PinoLogger,
    private readonly imapClientService: ImapClientService,
    private readonly warmupService: WarmupService,
    private readonly queueService: QueueService,
  ) {}

  /** Every 15 minutes: read bounce notices for inboxes that sent recently. */
  @Cron('*/15 * * * *')
  async scanAll(): Promise<void> {
    const since = new Date(Date.now() - SCAN_LOOKBACK_MS);
    const senders = await db
      .selectDistinct({ inboxId: warmupSends.senderInboxId })
      .from(warmupSends)
      .where(
        and(
          gte(warmupSends.sentAt, since),
          isNull(warmupSends.bouncedAt),
          inArray(warmupSends.status, ['accepted', 'uncertain']),
        ),
      );

    for (const { inboxId } of senders) {
      try {
        await this.scanInbox(inboxId);
      } catch (err) {
        this.logger.warn(
          { inboxId, err: (err as Error)?.message },
          'bounce scan failed for inbox — continuing with the rest',
        );
      }
    }
  }

  /** Reads bounce notices in one sender mailbox, records them, then applies the limit. */
  async scanInbox(inboxId: string): Promise<{ recorded: number; stats: BounceStats }> {
    let recorded = 0;
    try {
      recorded = await this.imapClientService.withInbox(inboxId, (client) =>
        this.readNotices(client, inboxId),
      );
    } catch (err) {
      // A send-only inbox has no mailbox to read; submission-time rejections
      // are still counted for it.
      if (!(err instanceof ImapNotConfiguredError)) throw err;
    }
    const stats = await this.enforce(inboxId);
    return { recorded, stats };
  }

  private async readNotices(client: ImapFlow, inboxId: string): Promise<number> {
    const since = new Date(Date.now() - SCAN_LOOKBACK_MS);
    const mailboxes = await client.list();
    const folders = mailboxes.filter(
      (m) =>
        m.specialUse === '\\Inbox' || m.path.toUpperCase() === 'INBOX' || m.specialUse === '\\Junk',
    );
    let recorded = 0;
    let budget = MAX_NOTICES_PER_SCAN;

    for (const folder of folders) {
      if (budget <= 0) break;
      const lock = await client.getMailboxLock(folder.path);
      const handled: number[] = [];
      try {
        // Three narrow searches rather than one OR: not every server supports OR.
        const found = new Set<number>();
        for (const criteria of [
          { since, from: 'mailer-daemon' },
          { since, from: 'postmaster' },
          { since, header: { 'content-type': 'delivery-status' } },
        ]) {
          const uids = await client.search(criteria, { uid: true }).catch(() => []);
          for (const uid of uids || []) found.add(uid);
        }

        for (const uid of [...found].sort((a, b) => a - b)) {
          if (budget-- <= 0) break;
          const message = await client.fetchOne(
            String(uid),
            { source: { start: 0, maxLength: NOTICE_MAX_BYTES } },
            { uid: true },
          );
          if (!message || !message.source) continue;
          const outcome = await this.recordNotice(inboxId, message.source.toString('utf8'));
          recorded += outcome.recorded;
          if (outcome.ours) handled.push(uid);
        }

        // A bounce of warmup mail is warmup traffic: read it and file it. Notices
        // about the owner's own mail are never touched.
        if (handled.length > 0) {
          const range = handled.join(',');
          await client.messageFlagsAdd(range, ['\\Seen'], { uid: true });
          if (!mailboxes.some((m) => m.path === WARMUP_HUB_FOLDER)) {
            await client.mailboxCreate(WARMUP_HUB_FOLDER).catch(() => undefined);
          }
          await client.messageMove(range, WARMUP_HUB_FOLDER, { uid: true });
        }
      } finally {
        lock.release();
      }
    }
    return recorded;
  }

  /**
   * Applies one notice. `ours` is true when it concerns a warmup message this
   * inbox sent (so it may be filed); `recorded` counts sends newly marked.
   */
  async recordNotice(
    inboxId: string,
    source: string,
  ): Promise<{ ours: boolean; recorded: number }> {
    const dsn = parseDsn(source);
    if (dsn.messageIds.length === 0) return { ours: false, recorded: 0 };

    const sends = await db
      .select()
      .from(warmupSends)
      .where(
        and(eq(warmupSends.senderInboxId, inboxId), inArray(warmupSends.messageId, dsn.messageIds)),
      );
    if (sends.length === 0) return { ours: false, recorded: 0 };
    if (!dsn.kind) return { ours: true, recorded: 0 };

    let recorded = 0;
    for (const send of sends) {
      // Nothing left this mailbox for a send that was never attempted.
      if (!['accepted', 'uncertain', 'submitting'].includes(send.status)) continue;
      // When the notice names the failed recipient it must be the one we sent to.
      if (dsn.recipient) {
        const intended = await this.receiverEmail(send);
        if (intended && intended.toLowerCase() !== dsn.recipient) continue;
      }
      // First evidence wins; the only upgrade allowed is soft -> hard.
      const updated = await db
        .update(warmupSends)
        .set({ bouncedAt: new Date(), bounceType: dsn.kind, bounceDetail: dsn.detail })
        .where(
          and(
            eq(warmupSends.id, send.id),
            dsn.kind === 'hard'
              ? or(isNull(warmupSends.bouncedAt), eq(warmupSends.bounceType, 'soft'))
              : isNull(warmupSends.bouncedAt),
          ),
        )
        .returning({ id: warmupSends.id });
      recorded += updated.length;
    }
    if (recorded > 0) {
      this.logger.warn(
        { inboxId, kind: dsn.kind, status: dsn.status, recorded },
        'bounce notice recorded',
      );
    }
    return { ours: true, recorded };
  }

  /** Bounce figures for the last 24 hours, with the sample size they rest on. */
  async stats(inboxId: string, now: Date = new Date()): Promise<BounceStats> {
    const since = new Date(now.getTime() - BOUNCE_WINDOW_MS).toISOString();
    const [row] = await db
      .select({
        attempted: sql<number>`count(*)::int`,
        bounced: sql<number>`count(*) filter (where ${warmupSends.bounceType} = 'hard')::int`,
      })
      .from(warmupSends)
      .where(
        and(
          eq(warmupSends.senderInboxId, inboxId),
          sql`coalesce(${warmupSends.claimedAt}, ${warmupSends.sentAt}) >= ${since}::timestamp`,
          // A row only counts once a worker tried to deliver it.
          inArray(warmupSends.status, ['submitting', 'accepted', 'uncertain', 'failed']),
        ),
      );
    const attempted = Number(row?.attempted ?? 0);
    const bounced = Number(row?.bounced ?? 0);
    return {
      attempted,
      bounced,
      rate: attempted > 0 ? bounced / attempted : 0,
      limit: BOUNCE_RATE_LIMIT,
      windowHours: BOUNCE_WINDOW_MS / 3_600_000,
    };
  }

  /**
   * Pauses the inbox when its bounce rate is over the limit. Strictly "more
   * than": exactly 3% does not pause. Already-paused inboxes are left as they
   * are, so this is safe to call after every new piece of evidence.
   */
  async enforce(inboxId: string, now: Date = new Date()): Promise<BounceStats> {
    const stats = await this.stats(inboxId, now);
    if (stats.attempted === 0 || stats.rate <= BOUNCE_RATE_LIMIT) return stats;

    const rows = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    if (rows[0]?.status !== 'active') return stats;

    await this.warmupService.pauseInbox(inboxId, BOUNCE_PAUSE_REASON);
    // enforce() only gets here for an inbox that was still active, so this is
    // sent once per pause.
    await this.queueService
      .add(
        'notify',
        {
          userId: rows[0].userId,
          inboxId,
          type: 'bounce_paused',
          channel: 'email',
          payload: { attempted: stats.attempted, bounced: stats.bounced },
        },
        { attempts: 5, backoff: { type: 'exponential', delay: 60_000 } },
      )
      .catch((err) =>
        this.logger.error(
          { inboxId, err: (err as Error)?.message },
          'could not queue bounce notice',
        ),
      );
    this.logger.error(
      { inboxId, attempted: stats.attempted, bounced: stats.bounced, rate: stats.rate },
      'inbox paused: bounce rate over the limit',
    );
    return stats;
  }

  private async receiverEmail(send: typeof warmupSends.$inferSelect): Promise<string | null> {
    if (send.receiverPoolInboxId) {
      const rows = await db
        .select({ email: poolInboxes.email })
        .from(poolInboxes)
        .where(eq(poolInboxes.id, send.receiverPoolInboxId))
        .limit(1);
      return rows[0]?.email ?? null;
    }
    if (send.receiverInboxId) {
      const rows = await db
        .select({ email: inboxes.email })
        .from(inboxes)
        .where(eq(inboxes.id, send.receiverInboxId))
        .limit(1);
      return rows[0]?.email ?? null;
    }
    return null;
  }
}
