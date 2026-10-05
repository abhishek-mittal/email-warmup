import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { UnrecoverableError } from 'bullmq';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { inboxAnalysis, inboxes, poolInboxes } from '../db/schema';
import { DnsService, DnsCheckOutcome, IssueCode, outcomeToBoolean } from '../monitor/dns.service';
import { SmtpClientService } from '../inbox/smtp/smtp-client.service';
import { ImapClientService, ImapNotConfiguredError } from '../inbox/imap/imap-client.service';

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
    private readonly smtpClientService: SmtpClientService,
    private readonly imapClientService: ImapClientService,
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

    const outcomes = await this.runChecks(
      domain,
      source.dkimSelector,
      source.provider,
      source.sendingIp,
    );

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

    // DNS health alone says nothing about whether the stored credentials
    // work. A batch-imported mailbox is only activated once it has actually
    // authenticated for SMTP (and IMAP, where it must receive); otherwise the
    // scheduler would queue mail for it every day and every send would fail.
    // The update is conditional on 'pending' so a slow analysis can never
    // re-activate a mailbox that was paused or removed in the meantime.
    const transport = await this.verifyTransport(data);
    if (data.inboxId) {
      const changed = await db
        .update(inboxes)
        .set(
          transport.ok
            ? { status: 'active', statusReason: null }
            : { status: 'error', statusReason: 'transport_failed' },
        )
        .where(and(eq(inboxes.id, data.inboxId), eq(inboxes.status, 'pending')))
        .returning({ id: inboxes.id });
      if (changed.length > 0) {
        this.logger.info(
          {
            inboxId: data.inboxId,
            fromStatus: 'pending',
            toStatus: transport.ok ? 'active' : 'error',
            reason: transport.reason,
          },
          'inbox status changed',
        );
      }
    } else if (data.poolInboxId) {
      const changed = await db
        .update(poolInboxes)
        .set(
          transport.ok
            ? { status: 'active', errorMessage: null, updatedAt: new Date() }
            : { status: 'error', errorMessage: transport.reason, updatedAt: new Date() },
        )
        .where(and(eq(poolInboxes.id, data.poolInboxId), eq(poolInboxes.status, 'pending')))
        .returning({ id: poolInboxes.id });
      if (changed.length > 0) {
        this.logger.info(
          {
            poolInboxId: data.poolInboxId,
            fromStatus: 'pending',
            toStatus: transport.ok ? 'active' : 'error',
            reason: transport.reason,
          },
          'pool inbox status changed',
        );
      }
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

  /**
   * Proves the mailbox can do what warmup needs of it. A warmed inbox must
   * be able to send; IMAP is required unless it is a custom inbox the owner
   * connected as send-only. A pool inbox must do both — receiving and
   * replying is its whole job.
   */
  private async verifyTransport(data: AnalysisJobData): Promise<{ ok: boolean; reason?: string }> {
    try {
      if (data.inboxId) {
        await this.smtpClientService.verify(data.inboxId);
        try {
          await this.imapClientService.withInbox(data.inboxId, (client) => client.list());
        } catch (err) {
          if (!(err instanceof ImapNotConfiguredError)) throw err;
        }
      } else if (data.poolInboxId) {
        await this.smtpClientService.verifyPoolInbox(data.poolInboxId);
        await this.imapClientService.withPoolInbox(data.poolInboxId, (client) => client.list());
      }
      return { ok: true };
    } catch (err) {
      const reason = `Could not connect to the mailbox: ${(err as Error)?.message ?? 'unknown error'}`;
      return { ok: false, reason: reason.slice(0, 300) };
    }
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

  private async loadSource(data: AnalysisJobData): Promise<{
    email: string;
    provider: string;
    dkimSelector: string | null;
    sendingIp: string | null;
  }> {
    if (data.inboxId) {
      const rows = await db.select().from(inboxes).where(eq(inboxes.id, data.inboxId)).limit(1);
      const inbox = rows[0];
      if (!inbox) {
        throw new UnrecoverableError(`Inbox ${data.inboxId} not found`);
      }
      return {
        email: inbox.email,
        provider: inbox.provider,
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
      return {
        email: poolInbox.email,
        provider: poolInbox.provider,
        dkimSelector: null,
        sendingIp: null,
      };
    }

    throw new UnrecoverableError('Neither inboxId nor poolInboxId was set on the analysis job');
  }

  private async runChecks(
    domain: string,
    selector: string | null,
    provider: string,
    sendingIp: string | null,
  ): Promise<DnsFieldOutcomes> {
    const [spf, dkim, dmarc, mx] = await Promise.all([
      this.safeCheck(() => this.dnsService.checkSpf(domain)),
      this.safeCheck(() => this.dnsService.checkDkimForInbox(domain, selector, provider)),
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
    return outcomeToBoolean(outcome);
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

  /**
   * Issue codes for the dashboard: the specific code a check reported (a
   * failure, or advice attached to a pass such as DMARC_NONE), falling back
   * to the field's generic code. Unknown results produce no issue.
   */
  private computeIssues(outcomes: DnsFieldOutcomes): IssueCode[] {
    const issues: IssueCode[] = [];
    for (const field of Object.keys(FIELD_POINTS) as (keyof DnsFieldOutcomes)[]) {
      const outcome = outcomes[field];
      if (!outcome) continue;
      if (outcome.status === 'fail') issues.push(outcome.code ?? ISSUE_CODE_BY_FIELD[field]);
      else if (outcome.status === 'pass' && outcome.code) issues.push(outcome.code);
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
