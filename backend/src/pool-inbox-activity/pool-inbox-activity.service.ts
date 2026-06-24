import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import * as fs from 'node:fs';
import * as readline from 'node:readline';
import * as path from 'node:path';
import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { db } from '../db';
import { inboxes, poolInboxes, warmupSends } from '../db/schema';
import { QueueService } from '../queue/queue.service';

/**
 * Pool inbox activity dashboard (T028). Mirrors the structure of
 * `ActivityService` (T027) but the perspective is inverted — pool
 * inboxes are the **receivers** in warmup pairs, not the senders, so
 * the activity stream shows events like "received/opened/replied"
 * rather than "sent".
 *
 * Read-only endpoints, no BullMQ producers, no DB writes.
 */

export type PoolActivityEventType =
  | 'received'
  | 'opened'
  | 'starred'
  | 'replied'
  | 'rescued'
  | 'spam_landed'
  | 'filed';

export interface PoolActivityEvent {
  type: PoolActivityEventType;
  timestamp: string; // ISO-8601
  payload: Record<string, unknown>;
}

export interface PoolActivityStats {
  received: number;
  opened: number;
  replied: number;
  rescued: number;
  spamCount: number;
  /** 0-100; rounded. 0 when no receives so the chip shows "—" instead of "0%". */
  openRate: number | null;
  replyRate: number | null;
  spamRate: number | null;
}

export interface PoolPairingRow {
  inboxId: string;
  inboxEmail: string;
  inboxProvider: string;
  warmupDay: number;
  emailsSent: number;
  lastSendAt: string | null;
  status: string;
}

export interface PoolLiveJob {
  jobId: string;
  actions: string[];
  senderEmail: string | null;
  executeAt: string;
  state: 'active' | 'delayed' | 'waiting';
}

export interface PoolLiveStatus {
  active: PoolLiveJob[];
  upcoming: PoolLiveJob[];
}

export interface PoolLogLine {
  level: number;
  levelName: string;
  time: string;
  context: string | null;
  msg: string;
  [key: string]: unknown;
}

export interface PoolConnectionSummary {
  provider: string;
  /** OAuth shape (gmail/outlook) */
  oauthClientIdPrefix?: string;
  clientSecretPresent?: boolean;
  refreshTokenPresent?: boolean;
  /** Custom SMTP shape */
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPasswordPresent?: boolean;
  /** Always present (true when IMAP creds are stored) */
  imapConfigured: boolean;
  imapHost?: string;
  imapPort?: number;
  imapUser?: string;
  imapPasswordPresent?: boolean;
}

const ACTIVITY_PAGE_SIZE_DEFAULT = 50;
const ACTIVITY_PAGE_SIZE_MAX = 200;
const LOGS_LIMIT_DEFAULT = 200;
const LOGS_LIMIT_MAX = 1000;
const PAIRINGS_LIMIT_MAX = 100;

const PINO_LEVEL_NAMES: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

function stripJob<T extends { _job: unknown }>(j: T): Omit<T, '_job'> {
  const { _job, ...rest } = j;
  return rest;
}

function resolveNdjsonPath(): string | null {
  let cwd = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(cwd, '.bin', '.runtime', 'backend.ndjson');
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
    const parent = path.dirname(cwd);
    if (parent === cwd) break;
    cwd = parent;
  }
  return null;
}

@Injectable()
export class PoolInboxActivityService {
  constructor(
    @InjectPinoLogger(PoolInboxActivityService.name)
    private readonly logger: PinoLogger,
    private readonly queueService: QueueService,
  ) {}

  // -------------------------------------------------------------------
  //  Helpers
  // -------------------------------------------------------------------

  /**
   * Ownership-checked pool inbox lookup. Mirrors ActivityService.assertOwnership
   * — never distinguishes "not found" from "not yours".
   */
  async assertPoolOwnership(
    poolInboxId: string,
    userId: string | undefined,
  ): Promise<typeof poolInboxes.$inferSelect> {
    const rows = await db
      .select()
      .from(poolInboxes)
      .where(eq(poolInboxes.id, poolInboxId))
      .limit(1);
    const row = rows[0];
    if (!row || row.userId !== userId) {
      throw new NotFoundException();
    }
    return row;
  }

  // -------------------------------------------------------------------
  //  /connection-summary
  // -------------------------------------------------------------------

  /**
   * Returns the non-secret subset of `encrypted_credentials` so the
   * panel header can show "SMTP smtp.gmail.com:587 / IMAP imap.gmail.com:993"
   * without ever shipping ciphertext or plaintext secrets to the browser.
   *
   * Presence flags (`*Present`) tell the UI whether a token is set —
   * enough for the user to know their config is intact, never enough to
   * leak the secret itself.
   */
  async getConnectionSummary(
    poolInboxId: string,
    userId: string | undefined,
  ): Promise<PoolConnectionSummary> {
    const row = await this.assertPoolOwnership(poolInboxId, userId);
    const creds = (row.encryptedCredentials ?? {}) as Record<string, unknown>;
    const summary: PoolConnectionSummary = { provider: row.provider, imapConfigured: false };

    if (row.provider === 'gmail' || row.provider === 'outlook') {
      const clientId = (creds.clientId as string | undefined) ?? '';
      summary.oauthClientIdPrefix = clientId.length > 12 ? `${clientId.slice(0, 12)}…` : clientId;
      summary.clientSecretPresent = Boolean(creds.clientSecret);
      summary.refreshTokenPresent = Boolean(creds.refreshToken);
      // OAuth pool inboxes are always IMAP-capable (they were created via
      // OAuth, so the user authorized IMAP at the same consent screen).
      summary.imapConfigured = Boolean(creds.refreshToken);
    } else if (row.provider === 'custom') {
      summary.smtpHost = (creds.smtpHost as string | undefined) ?? undefined;
      summary.smtpPort = typeof creds.smtpPort === 'number' ? creds.smtpPort : undefined;
      summary.smtpUser = (creds.smtpUser as string | undefined) ?? undefined;
      summary.smtpPasswordPresent = Boolean(creds.smtpPassword);
      summary.imapConfigured = Boolean(creds.imapHost && creds.imapPort && creds.imapPassword);
      if (summary.imapConfigured) {
        summary.imapHost = creds.imapHost as string;
        summary.imapPort = creds.imapPort as number;
        summary.imapUser = (creds.imapUser as string | undefined) ?? undefined;
        summary.imapPasswordPresent = Boolean(creds.imapPassword);
      }
    }
    return summary;
  }

  // -------------------------------------------------------------------
  //  /activity — receiver-side event timeline
  // -------------------------------------------------------------------

  /**
   * Builds a chronologically-ordered list of events for this pool
   * inbox from `warmup_sends` rows where `receiver_pool_inbox_id = :id`.
   * Each row produces up to 7 events (one per non-null timestamp + one
   * `received` event we synthesize from `createdAt` + one `spam_landed`
   * if the row landed in spam).
   *
   * `received` is the "you got an email" event — different from the
   * T027 `sent` event because here the pool inbox didn't send, it
   * received. We synthesize it from `warmup_sends.createdAt` (the row
   * was created at the moment we enqueued the send job).
   */
  async getActivity(
    poolInboxId: string,
    userId: string | undefined,
    cursor: string | null,
    limit: number,
  ): Promise<{ events: PoolActivityEvent[]; nextCursor: string | null }> {
    await this.assertPoolOwnership(poolInboxId, userId);
    const safeLimit = Math.min(
      Math.max(1, limit || ACTIVITY_PAGE_SIZE_DEFAULT),
      ACTIVITY_PAGE_SIZE_MAX,
    );
    const rowFetchLimit = safeLimit * 4;
    const sinceTs = cursor ? new Date(cursor) : null;

    const warmupRows = await db
      .select({
        id: warmupSends.id,
        senderInboxId: warmupSends.senderInboxId,
        createdAt: warmupSends.createdAt,
        sentAt: warmupSends.sentAt,
        openedAt: warmupSends.openedAt,
        repliedAt: warmupSends.repliedAt,
        starredAt: warmupSends.starredAt,
        rescuedAt: warmupSends.rescuedAt,
        filedAt: warmupSends.filedAt,
        landedInSpam: warmupSends.landedInSpam,
        landedInTab: warmupSends.landedInTab,
        subject: warmupSends.subject,
        messageId: warmupSends.messageId,
      })
      .from(warmupSends)
      .where(
        sinceTs
          ? and(
              eq(warmupSends.receiverPoolInboxId, poolInboxId),
              lte(warmupSends.createdAt, sinceTs),
            )
          : eq(warmupSends.receiverPoolInboxId, poolInboxId),
      )
      .orderBy(desc(warmupSends.createdAt))
      .limit(rowFetchLimit);

    // Resolve sender emails in one query.
    const senderIds = Array.from(
      new Set(warmupRows.map((r) => r.senderInboxId).filter((v): v is string => Boolean(v))),
    );
    const emailById = new Map<string, string>();
    if (senderIds.length > 0) {
      const rows = await db
        .select({ id: inboxes.id, email: inboxes.email })
        .from(inboxes)
        .where(inArray(inboxes.id, senderIds));
      for (const r of rows) emailById.set(r.id, r.email);
    }

    const events: PoolActivityEvent[] = [];

    const pushIfAfter = (
      ts: Date | null,
      type: PoolActivityEventType,
      payload: Record<string, unknown>,
    ): boolean => {
      if (!ts) return false;
      if (sinceTs && ts.getTime() > sinceTs.getTime()) return false;
      events.push({ type, timestamp: ts.toISOString(), payload });
      return true;
    };

    for (const row of warmupRows) {
      const senderEmail = emailById.get(row.senderInboxId) ?? null;
      const basePayload: Record<string, unknown> = {
        warmupSendId: row.id,
        senderEmail,
        subject: row.subject,
        messageId: row.messageId,
      };

      // `received` event — synthesized from `createdAt`. We always emit
      // this since `createdAt` is NOT NULL in the schema.
      pushIfAfter(row.createdAt, 'received', { ...basePayload });
      pushIfAfter(row.openedAt, 'opened', { ...basePayload });
      pushIfAfter(row.repliedAt, 'replied', { ...basePayload });
      pushIfAfter(row.starredAt, 'starred', { ...basePayload });
      if (row.rescuedAt) {
        pushIfAfter(row.rescuedAt, 'rescued', { ...basePayload, landedInTab: row.landedInTab });
      }
      pushIfAfter(row.filedAt, 'filed', { ...basePayload });

      if (row.landedInSpam) {
        // Anchor spam_landed at sentAt (the moment the warmup email was
        // actually delivered); if sentAt is null we use createdAt instead.
        const ts = row.sentAt ?? row.createdAt;
        if (!sinceTs || ts.getTime() <= sinceTs.getTime()) {
          events.push({
            type: 'spam_landed',
            timestamp: ts.toISOString(),
            payload: { ...basePayload, landedInTab: row.landedInTab },
          });
        }
      }
    }

    // Merge-sort by timestamp desc.
    events.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));

    const trimmed = events.slice(0, safeLimit);
    const nextCursor = trimmed.length === safeLimit ? trimmed[trimmed.length - 1].timestamp : null;

    this.logger.debug(
      { poolInboxId, returned: trimmed.length, hasMore: nextCursor !== null },
      'pool activity feed page served',
    );

    return { events: trimmed, nextCursor };
  }

  // -------------------------------------------------------------------
  //  /activity-stats — aggregate counts + rates
  // -------------------------------------------------------------------

  async getActivityStats(
    poolInboxId: string,
    userId: string | undefined,
  ): Promise<PoolActivityStats> {
    await this.assertPoolOwnership(poolInboxId, userId);
    const rows = await db
      .select({
        openedAt: warmupSends.openedAt,
        repliedAt: warmupSends.repliedAt,
        rescuedAt: warmupSends.rescuedAt,
        landedInSpam: warmupSends.landedInSpam,
      })
      .from(warmupSends)
      .where(eq(warmupSends.receiverPoolInboxId, poolInboxId));

    const received = rows.length;
    const opened = rows.filter((r) => r.openedAt !== null).length;
    const replied = rows.filter((r) => r.repliedAt !== null).length;
    const rescued = rows.filter((r) => r.rescuedAt !== null).length;
    const spamCount = rows.filter((r) => r.landedInSpam === true).length;

    return {
      received,
      opened,
      replied,
      rescued,
      spamCount,
      openRate: received === 0 ? null : Math.round((opened / received) * 100),
      replyRate: received === 0 ? null : Math.round((replied / received) * 100),
      spamRate: received === 0 ? null : Math.round((spamCount / received) * 100),
    };
  }

  // -------------------------------------------------------------------
  //  /pairings — distinct sender inboxes currently paired with this pool
  // -------------------------------------------------------------------

  async getPairings(
    poolInboxId: string,
    userId: string | undefined,
  ): Promise<{ activePairs: number; pairings: PoolPairingRow[] }> {
    const poolRow = await this.assertPoolOwnership(poolInboxId, userId);

    // Aggregate send counts per sender, plus the latest sentAt. Drizzle's
    // groupBy + max gives us both in a single query.
    const grouped = await db
      .select({
        senderInboxId: warmupSends.senderInboxId,
        emailsSent: sql<number>`cast(count(*) as integer)`,
        lastSendAt: sql<Date | null>`max(${warmupSends.sentAt})`,
      })
      .from(warmupSends)
      .where(eq(warmupSends.receiverPoolInboxId, poolInboxId))
      .groupBy(warmupSends.senderInboxId)
      .orderBy(sql`count(*) desc`)
      .limit(PAIRINGS_LIMIT_MAX);

    if (grouped.length === 0) {
      return { activePairs: poolRow.activePairs, pairings: [] };
    }

    const senderIds = grouped.map((g) => g.senderInboxId);
    const inboxRows = await db
      .select({
        id: inboxes.id,
        email: inboxes.email,
        provider: inboxes.provider,
        warmupDay: inboxes.warmupDay,
        status: inboxes.status,
      })
      .from(inboxes)
      .where(inArray(inboxes.id, senderIds));

    const byId = new Map(inboxRows.map((r) => [r.id, r]));
    const pairings: PoolPairingRow[] = grouped
      .filter((g) => byId.has(g.senderInboxId))
      .map((g) => {
        const inbox = byId.get(g.senderInboxId)!;
        // Drizzle/pg returns `max(timestamp)` as a string, not a Date —
        // wrap in a Date constructor so the ISO serializer behaves.
        const lastSend = g.lastSendAt ? new Date(g.lastSendAt) : null;
        return {
          inboxId: inbox.id,
          inboxEmail: inbox.email,
          inboxProvider: inbox.provider,
          warmupDay: inbox.warmupDay ?? 0,
          emailsSent: g.emailsSent,
          lastSendAt: lastSend ? lastSend.toISOString() : null,
          status: inbox.status,
        };
      });

    return { activePairs: poolRow.activePairs, pairings };
  }

  // -------------------------------------------------------------------
  //  /logs — NDJSON tail filtered by poolInboxId OR receiverId
  // -------------------------------------------------------------------

  /**
   * Mirrors `ActivityService.getLogs` (T027) but filters by
   * `poolInboxId` OR `receiverId` — pool inboxes show up in the log
   * stream under both field names depending on the log line source:
   *  - `poolInboxId` (kebab-case): warmup-receive logger, pairing
   *    engine, analysis workers
   *  - `receiverId`: warmup-receive job lifecycle (`receiverId: id`)
   *    — T009's logger uses this generic name.
   */
  async getLogs(
    poolInboxId: string,
    userId: string | undefined,
    levelMin: number | null,
    search: string | null,
    sinceIso: string | null,
    limit: number,
  ): Promise<{ lines: PoolLogLine[]; totalMatched: number; fileFound: boolean }> {
    await this.assertPoolOwnership(poolInboxId, userId);
    const safeLimit = Math.min(Math.max(1, limit || LOGS_LIMIT_DEFAULT), LOGS_LIMIT_MAX);
    const sinceTs = sinceIso ? new Date(sinceIso) : null;
    const searchLower = search?.toLowerCase() ?? null;

    const ndjsonPath = resolveNdjsonPath();
    if (!ndjsonPath) {
      return { lines: [], totalMatched: 0, fileFound: false };
    }

    const ringBuffer: PoolLogLine[] = [];
    let totalMatched = 0;

    try {
      const stream = fs.createReadStream(ndjsonPath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      for await (const rawLine of rl) {
        const line = rawLine.trim();
        if (!line) continue;
        let parsed: PoolLogLine | null = null;
        try {
          parsed = JSON.parse(line) as PoolLogLine;
        } catch {
          continue;
        }
        if (!parsed || typeof parsed !== 'object') continue;

        const levelNum = typeof parsed.level === 'number' ? parsed.level : 30;
        parsed.levelName = PINO_LEVEL_NAMES[levelNum] ?? 'info';
        parsed.time =
          typeof parsed.time === 'number'
            ? new Date(parsed.time).toISOString()
            : typeof parsed.time === 'string'
              ? parsed.time
              : new Date().toISOString();

        // Match either field name — pool-inbox logs use both depending on
        // which service wrote the line. See method docblock above.
        if (parsed.poolInboxId !== poolInboxId && parsed.receiverId !== poolInboxId) {
          continue;
        }
        if (levelMin !== null && levelNum < levelMin) continue;
        if (sinceTs && new Date(parsed.time).getTime() < sinceTs.getTime()) continue;
        if (searchLower) {
          const haystack = JSON.stringify(parsed).toLowerCase();
          if (!haystack.includes(searchLower)) continue;
        }

        totalMatched += 1;
        ringBuffer.push(parsed);
        if (ringBuffer.length > safeLimit) ringBuffer.shift();
      }
    } catch (err: any) {
      this.logger.warn(
        { poolInboxId, err: err?.message, errCode: err?.code },
        'failed to read backend.ndjson for pool inbox log feed',
      );
      return { lines: [], totalMatched: 0, fileFound: false };
    }

    ringBuffer.reverse();
    return { lines: ringBuffer, totalMatched, fileFound: true };
  }

  // -------------------------------------------------------------------
  //  /live-status — in-flight + upcoming warmup-receive jobs (BullMQ)
  // -------------------------------------------------------------------

  /**
   * Reads real BullMQ job state for the `warmup-receive` queue, filtered
   * to this pool inbox as the receiver. No DB writes, no IMAP calls —
   * this only reports what the queue already knows. `active` is jobs
   * currently being processed by a worker; `upcoming` is queued/delayed
   * jobs, soonest-first, capped at 5 (this is a glance-level indicator,
   * not a full job browser).
   */
  async getLiveStatus(
    poolInboxId: string,
    userId: string | undefined,
  ): Promise<PoolLiveStatus> {
    await this.assertPoolOwnership(poolInboxId, userId);

    const jobs = await this.queueService.getJobsForReceiver('warmup-receive', poolInboxId, [
      'active',
      'delayed',
      'waiting',
    ]);

    if (jobs.length === 0) {
      return { active: [], upcoming: [] };
    }

    const messageIds = jobs
      .map((j: any) => j.data?.messageId as string | undefined)
      .filter((v: unknown): v is string => Boolean(v));
    const senderEmailByMessageId = await this.resolveSenderEmailsByMessageId(messageIds);

    const withState: Array<PoolLiveJob & { _job: any }> = [];
    for (const job of jobs as any[]) {
      const rawState = await job.getState();
      // `getJobsForReceiver` fetched these jobs by state in a prior
      // round-trip; by the time we call `getState()` here a job can have
      // legitimately moved on (e.g. delayed -> active -> completed, or a
      // fast job finishing in between). `getState()` is typed to return
      // the full BullMQ `JobState` union (or 'unknown'), not just our
      // three expected buckets, so we validate rather than cast. A job
      // whose state has drifted outside the three buckets we asked for is
      // no longer "in flight" or "upcoming" in any meaningful sense for
      // this panel — skip it rather than miscategorize it under a `state`
      // value the `PoolLiveJob` contract doesn't allow.
      if (rawState !== 'active' && rawState !== 'delayed' && rawState !== 'waiting') {
        continue;
      }
      withState.push({
        jobId: String(job.id),
        actions: Array.isArray(job.data?.actions) ? job.data.actions : [],
        senderEmail: senderEmailByMessageId.get(job.data?.messageId) ?? null,
        executeAt: job.data?.executeAt ?? new Date().toISOString(),
        state: rawState,
        _job: job,
      });
    }

    const active = withState.filter((j) => j.state === 'active').map(stripJob);
    const upcoming = withState
      .filter((j) => j.state !== 'active')
      .sort((a, b) => (a.executeAt < b.executeAt ? -1 : a.executeAt > b.executeAt ? 1 : 0))
      .slice(0, 5)
      .map(stripJob);

    return { active, upcoming };
  }

  /** Batched messageId -> senderEmail resolve, used by getLiveStatus. */
  private async resolveSenderEmailsByMessageId(
    messageIds: string[],
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (messageIds.length === 0) return result;

    const sendRows = await db
      .select({ messageId: warmupSends.messageId, senderInboxId: warmupSends.senderInboxId })
      .from(warmupSends)
      .where(inArray(warmupSends.messageId, messageIds));

    const senderIds = Array.from(
      new Set(sendRows.map((r) => r.senderInboxId).filter((v): v is string => Boolean(v))),
    );
    if (senderIds.length === 0) return result;

    const inboxRows = await db
      .select({ id: inboxes.id, email: inboxes.email })
      .from(inboxes)
      .where(inArray(inboxes.id, senderIds));
    const emailById = new Map(inboxRows.map((r) => [r.id, r.email]));

    for (const row of sendRows) {
      if (!row.messageId || !row.senderInboxId) continue;
      const email = emailById.get(row.senderInboxId);
      if (email) result.set(row.messageId, email);
    }
    return result;
  }
}
