import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import * as fs from 'node:fs';
import * as readline from 'node:readline';
import * as path from 'node:path';
import { and, asc, desc, eq, gte, isNotNull, lte, sql, inArray } from 'drizzle-orm';
import { db } from '../db';
import {
  inboxes,
  warmupSends,
  dnsChecks,
  blacklistChecks,
  reputationScores,
  placementTests,
  poolInboxes,
} from '../db/schema';
import { QueueService } from '../queue/queue.service';

/**
 * Event shape returned by /inboxes/:id/activity. Each event is a
 * self-contained record of something that happened to this inbox.
 * `type` is the discriminator; `timestamp` is ISO-8601 (for ordering
 * and pagination); `payload` is type-specific data the frontend uses
 * to render the timeline row (icons, labels, chips).
 *
 * One warmup_sends row produces up to 6 events (`sent`, `opened`,
 * `replied`, `starred`, `rescued`, `filed`) plus one for `spam_landed`
 * — see expandWarmupEvents below.
 */
export type ActivityEventType =
  | 'sent'
  | 'opened'
  | 'replied'
  | 'starred'
  | 'rescued'
  | 'spam_landed'
  | 'filed'
  | 'dns_check'
  | 'blacklist_check'
  | 'score_updated';

export interface ActivityEvent {
  type: ActivityEventType;
  timestamp: string; // ISO-8601
  payload: Record<string, unknown>;
}

export interface WarmupSendListRow {
  id: string;
  sentAt: string | null;
  scheduledAt: string;
  subject: string | null;
  messageId: string | null;
  warmupDay: number;
  receiverEmail: string | null;
  receiverKind: 'inbox' | 'pool' | null;
  openedAt: string | null;
  repliedAt: string | null;
  starredAt: string | null;
  rescuedAt: string | null;
  filedAt: string | null;
  landedInSpam: boolean | null;
  landedInTab: string | null;
}

export interface DnsCheckHistoryRow {
  id: string;
  checkedAt: string;
  spfValid: boolean | null;
  dkimValid: boolean | null;
  dmarcValid: boolean | null;
  mxValid: boolean | null;
  rdnsValid: boolean | null;
  score: number | null;
}

export interface BlacklistCheckHistoryRow {
  id: string;
  checkedAt: string;
  isClean: boolean | null;
  listedCount: number | null;
  rblResults: Record<string, string> | null;
}

export interface PlacementHistoryRow {
  id: string;
  completedAt: string;
  seedCount: number | null;
  primaryPct: number | null;
  promotionsPct: number | null;
  spamPct: number | null;
  missingPct: number | null;
  placementScore: number | null;
}

export interface ScoreHistoryRow {
  recordedAt: string;
  score: number;
}

export interface LogLine {
  level: number;
  levelName: string;
  time: string; // ISO-8601
  context: string | null;
  msg: string;
  [key: string]: unknown;
}

const ACTIVITY_PAGE_SIZE_DEFAULT = 50;
const ACTIVITY_PAGE_SIZE_MAX = 200;
const SCORE_HISTORY_DEFAULT_DAYS = 30;
const SCORE_HISTORY_MAX_DAYS = 365;
const LOGS_LIMIT_DEFAULT = 200;
const LOGS_LIMIT_MAX = 1000;

/**
 * Mappings from pino level number to its textual name. Mirrors
 * docs/05-agent-skills/11-skill-logging.md#pino-level-numbers-for-raw-json-grep.
 */
const PINO_LEVEL_NAMES: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

/**
 * Walk up to `n` parents from process.cwd() looking for the first
 * directory that contains a `.bin/.runtime/` subdirectory. Returns the
 * absolute path to the NDJSON log file (or null if not found — e.g.
 * in production where the file isn't written, or in CI).
 *
 * Mirrors the resolution logic in app.module.ts:dev-pino-transport
 * (same constants, same fall-back) so the controller sees the same
 * file the pino transport writes to.
 */
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
export class ActivityService {
  constructor(
    @InjectPinoLogger(ActivityService.name)
    private readonly logger: PinoLogger,
    private readonly queue: QueueService,
  ) {}

  // -------------------------------------------------------------------
  //  Helpers
  // -------------------------------------------------------------------

  /**
   * Ownership-checked inbox lookup. Mirrors ScoringController / PlacementController
   * (T013 / T014): never distinguishes "not found" from "not yours" to avoid
   * leaking the existence of other users' inboxes. Returns the full row (not
   * just id) so callers can use email/provider in the activity payload.
   */
  async assertOwnership(
    inboxId: string,
    userId: string | undefined,
  ): Promise<typeof inboxes.$inferSelect> {
    const rows = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    const inbox = rows[0];
    if (!inbox || inbox.userId !== userId) {
      throw new NotFoundException();
    }
    return inbox;
  }

  // -------------------------------------------------------------------
  //  /activity — merged event stream
  // -------------------------------------------------------------------

  /**
   * Builds a chronologically-ordered list of activity events for one inbox
   * across `warmup_sends`, `dns_checks`, `blacklist_checks`, and
   * `reputation_scores`. Each warmup_sends row produces up to 7 events
   * (one per non-null timestamp + one for `landed_in_spam=true`).
   *
   * Pagination is cursor-based on ISO timestamp (descending). The cursor
   * passed in is the inclusive lower bound — events strictly older than
   * the cursor are returned. Pass the cursor returned in the previous
   * page's response to fetch the next page; when no cursor is returned,
   * there are no more events.
   *
   * Cap at `ACTIVITY_PAGE_SIZE_MAX` rows of expanded events per page to
   * keep response times bounded — the frontend page-size is then bounded
   * accordingly.
   */
  async getActivity(
    inboxId: string,
    userId: string | undefined,
    cursor: string | null,
    limit: number,
  ): Promise<{ events: ActivityEvent[]; nextCursor: string | null }> {
    await this.assertOwnership(inboxId, userId);

    const safeLimit = Math.min(
      Math.max(1, limit || ACTIVITY_PAGE_SIZE_DEFAULT),
      ACTIVITY_PAGE_SIZE_MAX,
    );

    // We over-fetch the underlying rows by 4x to account for fan-out
    // (warmup_sends → up to 7 events each), then trim to `safeLimit`.
    const rowFetchLimit = safeLimit * 4;

    const sinceTs = cursor ? new Date(cursor) : null;

    // Build per-source queries with the cursor applied.
    const warmupRows = await db
      .select({
        id: warmupSends.id,
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
        receiverInboxId: warmupSends.receiverInboxId,
        receiverPoolInboxId: warmupSends.receiverPoolInboxId,
      })
      .from(warmupSends)
      .where(
        sinceTs
          ? and(
              eq(warmupSends.senderInboxId, inboxId),
              isNotNull(warmupSends.sentAt),
              lte(warmupSends.createdAt, sinceTs),
            )
          : and(eq(warmupSends.senderInboxId, inboxId), isNotNull(warmupSends.sentAt)),
      )
      .orderBy(desc(warmupSends.createdAt))
      .limit(rowFetchLimit);

    const dnsRows = await db
      .select({
        id: dnsChecks.id,
        checkedAt: dnsChecks.checkedAt,
        score: dnsChecks.score,
      })
      .from(dnsChecks)
      .where(
        sinceTs
          ? and(eq(dnsChecks.inboxId, inboxId), lte(dnsChecks.checkedAt, sinceTs))
          : eq(dnsChecks.inboxId, inboxId),
      )
      .orderBy(desc(dnsChecks.checkedAt))
      .limit(safeLimit);

    const blacklistRows = await db
      .select({
        id: blacklistChecks.id,
        checkedAt: blacklistChecks.checkedAt,
        isClean: blacklistChecks.isClean,
        listedCount: blacklistChecks.listedCount,
      })
      .from(blacklistChecks)
      .where(
        sinceTs
          ? and(eq(blacklistChecks.inboxId, inboxId), lte(blacklistChecks.checkedAt, sinceTs))
          : eq(blacklistChecks.inboxId, inboxId),
      )
      .orderBy(desc(blacklistChecks.checkedAt))
      .limit(safeLimit);

    // Resolve receiver emails in one go. We need both the inboxes.email
    // for any receiverInboxId and the pool_inboxes.email for any
    // receiverPoolInboxId — single UNION query to avoid two round-trips.
    const receiverInboxIds = Array.from(
      new Set(warmupRows.map((r) => r.receiverInboxId).filter((v): v is string => Boolean(v))),
    );
    const receiverPoolIds = Array.from(
      new Set(warmupRows.map((r) => r.receiverPoolInboxId).filter((v): v is string => Boolean(v))),
    );

    const emailByInboxId = new Map<string, string>();
    const emailByPoolId = new Map<string, string>();

    if (receiverInboxIds.length > 0) {
      const rows = await db
        .select({ id: inboxes.id, email: inboxes.email })
        .from(inboxes)
        .where(inArray(inboxes.id, receiverInboxIds));
      for (const r of rows) emailByInboxId.set(r.id, r.email);
    }
    if (receiverPoolIds.length > 0) {
      const rows = await db
        .select({ id: poolInboxes.id, email: poolInboxes.email })
        .from(poolInboxes)
        .where(inArray(poolInboxes.id, receiverPoolIds));
      for (const r of rows) emailByPoolId.set(r.id, r.email);
    }

    // Fan out warmup_sends into per-timestamp events.
    const events: ActivityEvent[] = [];

    const pushIfAfter = (
      ts: Date | null,
      type: ActivityEventType,
      payload: Record<string, unknown>,
    ) => {
      if (!ts) return;
      if (sinceTs && ts.getTime() > sinceTs.getTime()) return; // boundary check
      events.push({ type, timestamp: ts.toISOString(), payload });
    };

    for (const row of warmupRows) {
      const receiverEmail = row.receiverInboxId
        ? emailByInboxId.get(row.receiverInboxId)
        : row.receiverPoolInboxId
          ? emailByPoolId.get(row.receiverPoolInboxId)
          : null;

      const basePayload: Record<string, unknown> = {
        warmupSendId: row.id,
        receiverEmail,
        subject: row.subject,
        messageId: row.messageId,
      };

      pushIfAfter(row.sentAt, 'sent', { ...basePayload });
      pushIfAfter(row.openedAt, 'opened', { ...basePayload });
      pushIfAfter(row.repliedAt, 'replied', { ...basePayload });
      pushIfAfter(row.starredAt, 'starred', { ...basePayload });
      pushIfAfter(row.rescuedAt, 'rescued', { ...basePayload, landedInTab: row.landedInTab });
      pushIfAfter(row.filedAt, 'filed', { ...basePayload });

      // spam_landed — derived event. We attach it to the sentAt timestamp
      // (the "landing" event for that warmup email) unless sentAt is null
      // (shouldn't happen since spam_landed implies sent, but defensive).
      if (row.landedInSpam) {
        const ts = row.sentAt ?? new Date(0);
        if (!sinceTs || ts.getTime() <= sinceTs.getTime()) {
          events.push({
            type: 'spam_landed',
            timestamp: ts.toISOString(),
            payload: { ...basePayload, landedInTab: row.landedInTab },
          });
        }
      }
    }

    for (const row of dnsRows) {
      if (sinceTs && row.checkedAt.getTime() > sinceTs.getTime()) continue;
      events.push({
        type: 'dns_check',
        timestamp: row.checkedAt.toISOString(),
        payload: { dnsCheckId: row.id, score: row.score },
      });
    }

    for (const row of blacklistRows) {
      if (sinceTs && row.checkedAt.getTime() > sinceTs.getTime()) continue;
      events.push({
        type: 'blacklist_check',
        timestamp: row.checkedAt.toISOString(),
        payload: {
          blacklistCheckId: row.id,
          isClean: row.isClean,
          listedCount: row.listedCount,
        },
      });
    }

    // score_updated: only emit events when there's a previous score
    // (so we have prev → new) AND a current one. Sorted desc by recordedAt.
    const scoreHistory = await db
      .select({
        score: reputationScores.score,
        recordedAt: reputationScores.recordedAt,
      })
      .from(reputationScores)
      .where(eq(reputationScores.inboxId, inboxId))
      .orderBy(desc(reputationScores.recordedAt))
      .limit(safeLimit + 1);

    for (let i = 0; i < scoreHistory.length; i++) {
      const row = scoreHistory[i];
      const prev = scoreHistory[i + 1]; // older score (since list is desc)
      if (!prev) continue;
      if (sinceTs && row.recordedAt.getTime() > sinceTs.getTime()) continue;
      const trend = row.score > prev.score ? 'up' : row.score < prev.score ? 'down' : 'stable';
      events.push({
        type: 'score_updated',
        timestamp: row.recordedAt.toISOString(),
        payload: { prev: prev.score, current: row.score, trend },
      });
    }

    // Merge-sort all events by timestamp desc. JS sort is fine at this scale
    // (< few thousand events per page).
    events.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));

    // Trim to safeLimit, then compute nextCursor from the oldest event in the page.
    const trimmed = events.slice(0, safeLimit);
    const nextCursor = trimmed.length === safeLimit ? trimmed[trimmed.length - 1].timestamp : null;

    this.logger.debug(
      { inboxId, returned: trimmed.length, hasMore: nextCursor !== null },
      'activity feed page served',
    );

    return { events: trimmed, nextCursor };
  }

  // -------------------------------------------------------------------
  //  /sends — paginated sent-emails table
  // -------------------------------------------------------------------

  /**
   * Lists warmup_sends rows for this inbox, joined with the receiver's
   * email address (from either `inboxes` or `pool_inboxes` depending on
   * which FK is set). Filters: status (opened/replied/rescued/spam),
   * date range. Pagination: 1-indexed page of `limit` rows.
   */
  async getSends(
    inboxId: string,
    userId: string | undefined,
    page: number,
    limit: number,
    status: string | null,
    fromIso: string | null,
    toIso: string | null,
  ): Promise<{ rows: WarmupSendListRow[]; page: number; pageSize: number; total: number }> {
    await this.assertOwnership(inboxId, userId);

    const safePage = Math.max(1, page || 1);
    const safeLimit = Math.min(Math.max(1, limit || 25), 100);
    const offset = (safePage - 1) * safeLimit;

    const filters = [eq(warmupSends.senderInboxId, inboxId)];
    if (fromIso) {
      const d = new Date(fromIso);
      if (!Number.isNaN(d.getTime())) filters.push(gte(warmupSends.sentAt, d));
    }
    if (toIso) {
      const d = new Date(toIso);
      if (!Number.isNaN(d.getTime())) filters.push(lte(warmupSends.sentAt, d));
    }
    if (status) {
      switch (status) {
        case 'opened':
          filters.push(isNotNull(warmupSends.openedAt));
          break;
        case 'replied':
          filters.push(isNotNull(warmupSends.repliedAt));
          break;
        case 'rescued':
          filters.push(isNotNull(warmupSends.rescuedAt));
          break;
        case 'spam':
          filters.push(eq(warmupSends.landedInSpam, true));
          break;
        // 'all' and unknown values pass through unfiltered.
      }
    }

    // Only sends a server accepted count as activity; reserved, canceled and failed ledger rows do not.
    filters.push(isNotNull(warmupSends.sentAt));
    const whereClause = filters.length === 1 ? filters[0] : and(...filters);

    const [{ total }] = await db
      .select({ total: sql<number>`cast(count(*) as integer)` })
      .from(warmupSends)
      .where(whereClause);

    const rows = await db
      .select({
        id: warmupSends.id,
        sentAt: warmupSends.sentAt,
        scheduledAt: warmupSends.scheduledAt,
        subject: warmupSends.subject,
        messageId: warmupSends.messageId,
        warmupDay: warmupSends.warmupDay,
        receiverInboxId: warmupSends.receiverInboxId,
        receiverPoolInboxId: warmupSends.receiverPoolInboxId,
        openedAt: warmupSends.openedAt,
        repliedAt: warmupSends.repliedAt,
        starredAt: warmupSends.starredAt,
        rescuedAt: warmupSends.rescuedAt,
        filedAt: warmupSends.filedAt,
        landedInSpam: warmupSends.landedInSpam,
        landedInTab: warmupSends.landedInTab,
      })
      .from(warmupSends)
      .where(whereClause)
      .orderBy(desc(warmupSends.sentAt), desc(warmupSends.createdAt))
      .limit(safeLimit)
      .offset(offset);

    // Resolve receiver emails in a single query batch.
    const inboxIds = Array.from(
      new Set(rows.map((r) => r.receiverInboxId).filter((v): v is string => Boolean(v))),
    );
    const poolIds = Array.from(
      new Set(rows.map((r) => r.receiverPoolInboxId).filter((v): v is string => Boolean(v))),
    );

    const emailByInboxId = new Map<string, string>();
    const emailByPoolId = new Map<string, string>();
    if (inboxIds.length > 0) {
      const inboxRows = await db
        .select({ id: inboxes.id, email: inboxes.email })
        .from(inboxes)
        .where(inArray(inboxes.id, inboxIds));
      for (const r of inboxRows) emailByInboxId.set(r.id, r.email);
    }
    if (poolIds.length > 0) {
      const poolRows = await db
        .select({ id: poolInboxes.id, email: poolInboxes.email })
        .from(poolInboxes)
        .where(inArray(poolInboxes.id, poolIds));
      for (const r of poolRows) emailByPoolId.set(r.id, r.email);
    }

    const list: WarmupSendListRow[] = rows.map((row) => {
      const receiverEmail = row.receiverInboxId
        ? (emailByInboxId.get(row.receiverInboxId) ?? null)
        : row.receiverPoolInboxId
          ? (emailByPoolId.get(row.receiverPoolInboxId) ?? null)
          : null;
      const receiverKind: 'inbox' | 'pool' | null = row.receiverInboxId
        ? 'inbox'
        : row.receiverPoolInboxId
          ? 'pool'
          : null;
      return {
        id: row.id,
        sentAt: row.sentAt ? row.sentAt.toISOString() : null,
        scheduledAt: row.scheduledAt.toISOString(),
        subject: row.subject,
        messageId: row.messageId,
        warmupDay: row.warmupDay,
        receiverEmail,
        receiverKind,
        openedAt: row.openedAt ? row.openedAt.toISOString() : null,
        repliedAt: row.repliedAt ? row.repliedAt.toISOString() : null,
        starredAt: row.starredAt ? row.starredAt.toISOString() : null,
        rescuedAt: row.rescuedAt ? row.rescuedAt.toISOString() : null,
        filedAt: row.filedAt ? row.filedAt.toISOString() : null,
        landedInSpam: row.landedInSpam,
        landedInTab: row.landedInTab,
      };
    });

    return { rows: list, page: safePage, pageSize: safeLimit, total };
  }

  // -------------------------------------------------------------------
  //  /dns-history + /blacklist-history
  // -------------------------------------------------------------------

  async getDnsHistory(
    inboxId: string,
    userId: string | undefined,
    limit: number,
  ): Promise<DnsCheckHistoryRow[]> {
    await this.assertOwnership(inboxId, userId);
    const safeLimit = Math.min(Math.max(1, limit || 5), 50);
    const rows = await db
      .select()
      .from(dnsChecks)
      .where(eq(dnsChecks.inboxId, inboxId))
      .orderBy(desc(dnsChecks.checkedAt))
      .limit(safeLimit);

    return rows.map((r) => ({
      id: r.id,
      checkedAt: r.checkedAt.toISOString(),
      spfValid: r.spfValid,
      dkimValid: r.dkimValid,
      dmarcValid: r.dmarcValid,
      mxValid: r.mxValid,
      rdnsValid: r.rdnsValid,
      score: r.score,
    }));
  }

  async getBlacklistHistory(
    inboxId: string,
    userId: string | undefined,
    limit: number,
  ): Promise<BlacklistCheckHistoryRow[]> {
    await this.assertOwnership(inboxId, userId);
    const safeLimit = Math.min(Math.max(1, limit || 5), 50);
    const rows = await db
      .select()
      .from(blacklistChecks)
      .where(eq(blacklistChecks.inboxId, inboxId))
      .orderBy(desc(blacklistChecks.checkedAt))
      .limit(safeLimit);

    return rows.map((r) => ({
      id: r.id,
      checkedAt: r.checkedAt.toISOString(),
      isClean: r.isClean,
      listedCount: r.listedCount,
      rblResults: (r.rblResults as Record<string, string> | null) ?? null,
    }));
  }

  // -------------------------------------------------------------------
  //  /placement-history
  // -------------------------------------------------------------------

  async getPlacementHistory(
    inboxId: string,
    userId: string | undefined,
  ): Promise<PlacementHistoryRow[]> {
    await this.assertOwnership(inboxId, userId);
    const rows = await db
      .select()
      .from(placementTests)
      .where(
        and(
          eq(placementTests.inboxId, inboxId),
          // Finished tests only. A failed test is shown too, with its reason
          // and no figures, so a test that could not be measured is visible
          // rather than silently absent.
          inArray(placementTests.status, ['complete', 'partial', 'failed']),
        ),
      )
      .orderBy(desc(placementTests.createdAt));

    return rows.map((r) => {
      const hasResult = r.status !== 'failed';
      // Percentages are over seeds that were actually observed.
      const observed = r.observedCount ?? r.seedCount ?? 0;
      const missing = r.missingCount ?? 0;
      const missingPct = hasResult && observed > 0 ? Math.round((missing / observed) * 100) : null;
      return {
        id: r.id,
        status: r.status,
        completedAt: (r.completedAt ?? r.createdAt).toISOString(),
        seedCount: r.seedCount,
        observedCount: r.observedCount ?? r.seedCount,
        errorCount: r.errorCount ?? 0,
        primaryPct: hasResult ? r.primaryPct : null,
        promotionsPct: hasResult ? r.promotionsPct : null,
        spamPct: hasResult ? r.spamPct : null,
        missingPct,
        placementScore: hasResult ? r.placementScore : null,
        failureReason: hasResult ? null : r.failureReason,
      };
    });
  }

  // -------------------------------------------------------------------
  //  /score-history?days=N — same data ScoringController returns, just
  //  filtered to the last N days and omitting the breakdown (the
  //  dashboard's sparkline uses it).
  // -------------------------------------------------------------------

  async getScoreHistory(
    inboxId: string,
    userId: string | undefined,
    days: number,
  ): Promise<{
    current: number | null;
    /** Share (0-100) of the latest score that rests on real, recent measurements. */
    completeness: number | null;
    trend: 'up' | 'down' | 'stable';
    history: ScoreHistoryRow[];
  }> {
    await this.assertOwnership(inboxId, userId);
    const safeDays = Math.min(
      Math.max(1, days || SCORE_HISTORY_DEFAULT_DAYS),
      SCORE_HISTORY_MAX_DAYS,
    );

    const since = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);
    const rows = await db
      .select({
        score: reputationScores.score,
        completeness: reputationScores.completeness,
        recordedAt: reputationScores.recordedAt,
        trend: reputationScores.trend,
      })
      .from(reputationScores)
      .where(and(eq(reputationScores.inboxId, inboxId), gte(reputationScores.recordedAt, since)))
      .orderBy(asc(reputationScores.recordedAt));

    if (rows.length === 0) {
      return { current: null, completeness: null, trend: 'stable', history: [] };
    }
    const latest = rows[rows.length - 1];
    return {
      current: latest.score,
      completeness: latest.completeness,
      trend: (latest.trend as 'up' | 'down' | 'stable') ?? 'stable',
      history: rows.map((r) => ({ recordedAt: r.recordedAt.toISOString(), score: r.score })),
    };
  }

  // -------------------------------------------------------------------
  //  /logs — read the NDJSON file directly. No DB write. Bounded to
  //  the last `limit` lines that match this inbox's id.
  // -------------------------------------------------------------------

  /**
   * Reads the backend NDJSON log file from the end (most-recent line
   * last), filters to lines where `inboxId == inboxId`, applies the
   * optional level filter and free-text search, and returns up to
   * `limit` of the most recent matching lines.
   *
   * Implementation notes:
   *  - We don't load the entire file into memory. Readline streams
   *    line-by-line, we keep only matching lines in a small ring
   *    buffer of size `limit`, then reverse the buffer for
   *    newest-first output.
   *  - Malformed lines (anything `JSON.parse` can't handle) are
   *    silently dropped — they're already dropped by pino on the
   *    write side, so this is defensive.
   *  - Returns `{ lines, totalMatched, fileFound }`. `fileFound=false`
   *    means the NDJSON file isn't there (e.g. production, or
   *    LOG_NDJSON=0). The frontend treats this as an empty log with
   *    a non-error "logs not available" message.
   */
  async getLogs(
    inboxId: string,
    userId: string | undefined,
    levelMin: number | null,
    search: string | null,
    sinceIso: string | null,
    limit: number,
  ): Promise<{ lines: LogLine[]; totalMatched: number; fileFound: boolean }> {
    await this.assertOwnership(inboxId, userId);
    const safeLimit = Math.min(Math.max(1, limit || LOGS_LIMIT_DEFAULT), LOGS_LIMIT_MAX);
    const sinceTs = sinceIso ? new Date(sinceIso) : null;
    const searchLower = search?.toLowerCase() ?? null;

    const ndjsonPath = resolveNdjsonPath();
    if (!ndjsonPath) {
      return { lines: [], totalMatched: 0, fileFound: false };
    }

    const ringBuffer: LogLine[] = [];
    let totalMatched = 0;

    try {
      const stream = fs.createReadStream(ndjsonPath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      for await (const rawLine of rl) {
        const line = rawLine.trim();
        if (!line) continue;
        let parsed: LogLine | null = null;
        try {
          parsed = JSON.parse(line) as LogLine;
        } catch {
          continue;
        }
        if (!parsed || typeof parsed !== 'object') continue;

        // Normalize level field — pino uses `level` as a number; expose
        // it as both `level` (number) and `levelName` (string) for the
        // frontend's level filter chips.
        const levelNum = typeof parsed.level === 'number' ? parsed.level : 30;
        parsed.levelName = PINO_LEVEL_NAMES[levelNum] ?? 'info';
        parsed.time =
          typeof parsed.time === 'number'
            ? new Date(parsed.time).toISOString()
            : typeof parsed.time === 'string'
              ? parsed.time
              : new Date().toISOString();

        if (parsed.inboxId !== inboxId) continue;
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
        { inboxId, err: err?.message, errCode: err?.code },
        'failed to read backend.ndjson for log feed',
      );
      return { lines: [], totalMatched: 0, fileFound: false };
    }

    // Newest first.
    ringBuffer.reverse();
    return { lines: ringBuffer, totalMatched, fileFound: true };
  }

  // -------------------------------------------------------------------
  //  Re-run helpers (POST /inboxes/:id/checks/{dns,blacklist})
  // -------------------------------------------------------------------

  async runDnsCheck(inboxId: string, userId: string | undefined): Promise<void> {
    await this.assertOwnership(inboxId, userId);
    await this.queue.add('dns-check', { inboxId });
    this.logger.info({ inboxId, manual: true }, 'DNS check enqueued by user request');
  }

  async runBlacklistCheck(inboxId: string, userId: string | undefined): Promise<void> {
    await this.assertOwnership(inboxId, userId);
    await this.queue.add('blacklist-check', { inboxId });
    this.logger.info({ inboxId, manual: true }, 'Blacklist check enqueued by user request');
  }
}
