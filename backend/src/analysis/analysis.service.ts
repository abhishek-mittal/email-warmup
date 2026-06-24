import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { UnrecoverableError } from 'bullmq';
import { desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { inboxAnalysis, inboxes, poolInboxes } from '../db/schema';
import { DnsService, DnsCheckOutcome, IssueCode } from '../monitor/dns.service';

export interface AnalysisJobData {
  inboxId?: string;
  poolInboxId?: string;
  userId: string;
}

type AnalysisRow = typeof inboxAnalysis.$inferSelect;

interface DnsFieldOutcomes {
  spf: DnsCheckOutcome | null;
  dkim: DnsCheckOutcome | null;
  dmarc: DnsCheckOutcome | null;
  mx: DnsCheckOutcome | null;
  rdns: DnsCheckOutcome | null;
}

// Health-score weight per field — see T021 spec step 3. A null field (timeout or
// skipped, e.g. rDNS with no known sending IP) contributes 0 points, never a
// fail-with-points-removed.
const FIELD_POINTS: Record<keyof DnsFieldOutcomes, number> = {
  spf: 25,
  dkim: 25,
  dmarc: 20,
  mx: 15,
  rdns: 15,
};

const ISSUE_CODE_BY_FIELD: Record<keyof DnsFieldOutcomes, IssueCode> = {
  spf: 'SPF_MISSING',
  dkim: 'DKIM_MISSING',
  dmarc: 'DMARC_MISSING',
  mx: 'MX_MISSING',
  rdns: 'RDNS_MISSING',
};

@Injectable()
export class AnalysisService {
  constructor(
    @InjectPinoLogger(AnalysisService.name)
    private readonly logger: PinoLogger,
    private readonly dnsService: DnsService,
  ) {}

  /**
   * Runs the lightweight DNS-derived health analysis for either an inbox-to-warm
   * (inboxId set) or a private pool inbox (poolInboxId set) — exactly one is set,
   * per the inbox-analysis job payload contract. Never writes to dns_checks (that's
   * the full T011 monitoring check) and never throws on a single DNS check
   * failure/timeout — only a missing source row is fatal (UnrecoverableError).
   */
  async analyse(data: AnalysisJobData): Promise<AnalysisRow> {
    const source = await this.loadSource(data);
    this.logger.info(
      {
        jobId: data.inboxId ?? data.poolInboxId,
        inboxId: data.inboxId,
        poolInboxId: data.poolInboxId,
      },
      'analysis started',
    );

    const domain = source.email.split('@')[1];
    const selector = source.dkimSelector ?? 'default';

    const outcomes = await this.runChecks(domain, selector, source.sendingIp);

    const healthScore = this.computeHealthScore(outcomes);
    const issues = this.computeIssues(outcomes);
    const placementEstimate = this.estimatePlacement(healthScore);

    const [inserted] = await db
      .insert(inboxAnalysis)
      .values({
        inboxId: data.inboxId ?? null,
        poolInboxId: data.poolInboxId ?? null,
        spfValid: this.toBoolean(outcomes.spf),
        dkimValid: this.toBoolean(outcomes.dkim),
        dmarcValid: this.toBoolean(outcomes.dmarc),
        mxValid: this.toBoolean(outcomes.mx),
        rdnsValid: this.toBoolean(outcomes.rdns),
        placementEstimate,
        healthScore,
        issues,
      })
      .returning();

    // Status is updated to 'active' unconditionally once analysis completes,
    // regardless of DNS result — see T021 spec step 7 / acceptance criterion.
    if (data.inboxId) {
      await db.update(inboxes).set({ status: 'active' }).where(eq(inboxes.id, data.inboxId));
      this.logger.info(
        { inboxId: data.inboxId, fromStatus: 'pending', toStatus: 'active' },
        'inbox status changed',
      );
    } else if (data.poolInboxId) {
      await db
        .update(poolInboxes)
        .set({ status: 'active' })
        .where(eq(poolInboxes.id, data.poolInboxId));
      this.logger.info(
        { poolInboxId: data.poolInboxId, fromStatus: 'pending', toStatus: 'active' },
        'pool inbox status changed',
      );
    }

    this.logger.info(
      {
        inboxId: data.inboxId,
        poolInboxId: data.poolInboxId,
        healthScore,
        issues,
        placementEstimate,
      },
      'analysis: health score computed',
    );

    return inserted;
  }

  async getLatestForInbox(inboxId: string): Promise<AnalysisRow | null> {
    return getLatestAnalysisForInbox(inboxId);
  }

  async getLatestForPoolInbox(poolInboxId: string): Promise<AnalysisRow | null> {
    return getLatestAnalysisForPoolInbox(poolInboxId);
  }

  /**
   * Batched lookup for a list endpoint that needs the latest analysis row for N
   * pool inboxes in one query rather than N queries. Rows are reduced client-side
   * to "latest per poolInboxId" by analysedAt.
   */
  async getLatestForPoolInboxes(poolInboxIds: string[]): Promise<Map<string, AnalysisRow>> {
    return getLatestAnalysisForPoolInboxes(poolInboxIds);
  }

  private async loadSource(
    data: AnalysisJobData,
  ): Promise<{ email: string; dkimSelector: string | null; sendingIp: string | null }> {
    if (data.inboxId) {
      const rows = await db.select().from(inboxes).where(eq(inboxes.id, data.inboxId)).limit(1);
      const inbox = rows[0];
      if (!inbox) {
        throw new UnrecoverableError(`Inbox ${data.inboxId} not found`);
      }
      return {
        email: inbox.email,
        dkimSelector: inbox.dkimSelector,
        sendingIp: inbox.sendingIp,
      };
    }

    if (data.poolInboxId) {
      const rows = await db
        .select()
        .from(poolInboxes)
        .where(eq(poolInboxes.id, data.poolInboxId))
        .limit(1);
      const poolInbox = rows[0];
      if (!poolInbox) {
        throw new UnrecoverableError(`Pool inbox ${data.poolInboxId} not found`);
      }
      // pool_inboxes has no dkimSelector/sendingIp columns — default selector,
      // and rDNS is always skipped (no sending IP to reverse-resolve).
      return { email: poolInbox.email, dkimSelector: null, sendingIp: null };
    }

    throw new UnrecoverableError('Neither inboxId nor poolInboxId was set on the analysis job');
  }

  private async runChecks(
    domain: string,
    selector: string,
    sendingIp: string | null,
  ): Promise<DnsFieldOutcomes> {
    const [spf, dkim, dmarc, mx] = await Promise.all([
      this.safeCheck(() => this.dnsService.checkSpf(domain)),
      this.safeCheck(() => this.dnsService.checkDkim(domain, selector)),
      this.safeCheck(() => this.dnsService.checkDmarc(domain)),
      this.safeCheck(() => this.dnsService.checkMx(domain)),
    ]);

    const rdns = sendingIp
      ? await this.safeCheck(() => this.dnsService.checkRdns(sendingIp))
      : null;

    return { spf, dkim, dmarc, mx, rdns };
  }

  /**
   * Wraps a single DNS check so a thrown error/timeout never fails the whole job —
   * the field is recorded as null (unknown) and every other check still runs and
   * is written. See T021 spec step 8.
   */
  private async safeCheck(fn: () => Promise<DnsCheckOutcome>): Promise<DnsCheckOutcome | null> {
    try {
      return await fn();
    } catch {
      return null;
    }
  }

  private toBoolean(outcome: DnsCheckOutcome | null): boolean | null {
    if (!outcome) {
      return null;
    }
    return outcome.status === 'pass';
  }

  private computeHealthScore(outcomes: DnsFieldOutcomes): number {
    let score = 0;
    for (const field of Object.keys(FIELD_POINTS) as (keyof DnsFieldOutcomes)[]) {
      if (this.toBoolean(outcomes[field]) === true) {
        score += FIELD_POINTS[field];
      }
    }
    return Math.min(score, 100);
  }

  private computeIssues(outcomes: DnsFieldOutcomes): IssueCode[] {
    const issues: IssueCode[] = [];
    for (const field of Object.keys(FIELD_POINTS) as (keyof DnsFieldOutcomes)[]) {
      if (this.toBoolean(outcomes[field]) === false) {
        issues.push(ISSUE_CODE_BY_FIELD[field]);
      }
    }
    return issues;
  }

  private estimatePlacement(healthScore: number): 'inbox' | 'promotions' | 'spam' | 'unknown' {
    if (healthScore >= 80) return 'inbox';
    if (healthScore >= 50) return 'promotions';
    if (healthScore >= 20) return 'spam';
    return 'unknown';
  }
}

/**
 * Plain, dependency-free query functions (no DnsService, no NestJS DI) so
 * controllers in other modules can read the latest analysis row without
 * importing AnalysisModule. AnalysisModule transitively imports MonitorModule
 * -> WarmupModule -> InboxModule, so InboxModule importing AnalysisModule
 * back would be a circular module dependency; importing these plain
 * functions directly from this file avoids that entirely. AnalysisService's
 * methods above delegate to these for its own (DI-based) consumers.
 */
export async function getLatestAnalysisForInbox(inboxId: string): Promise<AnalysisRow | null> {
  const rows = await db
    .select()
    .from(inboxAnalysis)
    .where(eq(inboxAnalysis.inboxId, inboxId))
    .orderBy(desc(inboxAnalysis.analysedAt))
    .limit(1);

  return rows[0] ?? null;
}

export async function getLatestAnalysisForPoolInbox(
  poolInboxId: string,
): Promise<AnalysisRow | null> {
  const rows = await db
    .select()
    .from(inboxAnalysis)
    .where(eq(inboxAnalysis.poolInboxId, poolInboxId))
    .orderBy(desc(inboxAnalysis.analysedAt))
    .limit(1);

  return rows[0] ?? null;
}

function latestPerKey(
  rows: AnalysisRow[],
  keyOf: (row: AnalysisRow) => string | null,
): Map<string, AnalysisRow> {
  const result = new Map<string, AnalysisRow>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    const existing = result.get(key);
    if (
      !existing ||
      (row.analysedAt && existing.analysedAt && row.analysedAt > existing.analysedAt)
    ) {
      result.set(key, row);
    }
  }
  return result;
}

export async function getLatestAnalysisForPoolInboxes(
  poolInboxIds: string[],
): Promise<Map<string, AnalysisRow>> {
  if (poolInboxIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(inboxAnalysis)
    .where(inArray(inboxAnalysis.poolInboxId, poolInboxIds));
  return latestPerKey(rows, (row) => row.poolInboxId);
}

/**
 * Same batched-latest-per-id pattern, for the GET /inboxes list endpoint
 * (T023's DNS Health / Issues grid columns need this).
 */
export async function getLatestAnalysisForInboxes(
  inboxIds: string[],
): Promise<Map<string, AnalysisRow>> {
  if (inboxIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(inboxAnalysis)
    .where(inArray(inboxAnalysis.inboxId, inboxIds));
  return latestPerKey(rows, (row) => row.inboxId);
}
