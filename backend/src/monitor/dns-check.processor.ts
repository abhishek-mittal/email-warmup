import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Cron } from '@nestjs/schedule';
import { Job, UnrecoverableError } from 'bullmq';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { dnsChecks, inboxes } from '../db/schema';
import { DnsService, DnsCheckOutcome, IssueCode, outcomeToBoolean } from './dns.service';
import { QueueService } from '../queue/queue.service';

export interface DnsCheckJobData {
  inboxId: string;
}

// "Critical" per the issue-code severity table in the monitoring service spec —
// see T011 context addendum #3. DMARC issues are warning severity and rDNS issues
// are info severity; neither ever triggers the new-critical-issue alert.
const CRITICAL_FIELDS = ['spfValid', 'dkimValid', 'mxValid'] as const;
type CriticalField = (typeof CRITICAL_FIELDS)[number];

@Injectable()
@Processor('dns-check')
export class DnsCheckProcessor extends WorkerHost {
  constructor(
    @InjectPinoLogger(DnsCheckProcessor.name)
    private readonly logger: PinoLogger,
    private readonly dnsService: DnsService,
    private readonly queueService: QueueService,
  ) {
    super();
  }

  /** Daily cron at 06:00 UTC. Enqueues a dns-check job for every active inbox. */
  @Cron('0 6 * * *', { utcOffset: 0 })
  async scheduleAllInboxes(): Promise<void> {
    const activeInboxes = await db.select().from(inboxes).where(eq(inboxes.status, 'active'));

    for (const inbox of activeInboxes) {
      await this.queueService.add('dns-check', { inboxId: inbox.id });
    }
  }

  async process(job: Job<DnsCheckJobData>): Promise<void> {
    const { inboxId } = job.data;
    const jobId = String(job.id);

    const inboxRows = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    const inbox = inboxRows[0];
    if (!inbox) {
      throw new UnrecoverableError(`Inbox ${inboxId} not found`);
    }
    const domain = inbox.email.split('@')[1];
    this.logger.info({ jobId, inboxId, domain }, 'DNS check started');

    const [spf, dkim, dmarc, mx] = await Promise.all([
      this.dnsService
        .checkSpf(domain)
        .then(
          (r) => (
            this.logger.debug(
              { jobId, check: 'spf', result: r.status === 'pass' },
              'DNS check result',
            ),
            r
          ),
        ),
      this.dnsService
        .checkDkimForInbox(domain, inbox.dkimSelector, inbox.provider)
        .then(
          (r) => (
            this.logger.debug(
              { jobId, check: 'dkim', result: r.status === 'pass' },
              'DNS check result',
            ),
            r
          ),
        ),
      this.dnsService
        .checkDmarc(domain)
        .then(
          (r) => (
            this.logger.debug(
              { jobId, check: 'dmarc', result: r.status === 'pass' },
              'DNS check result',
            ),
            r
          ),
        ),
      this.dnsService
        .checkMx(domain)
        .then(
          (r) => (
            this.logger.debug(
              { jobId, check: 'mx', result: r.status === 'pass' },
              'DNS check result',
            ),
            r
          ),
        ),
    ]);

    // rDNS is best-effort and only meaningful when the inbox has a known sending IP
    // (e.g. anything sent via Gmail/Outlook OAuth never has one) — see addendum #6.
    const rdns = inbox.sendingIp ? await this.dnsService.checkRdns(inbox.sendingIp) : null;
    if (rdns) {
      this.logger.debug(
        { jobId, check: 'rdns', result: rdns.status === 'pass' },
        'DNS check result',
      );
    }

    // Read the previous check BEFORE inserting the new row, so the comparison is
    // against the prior state rather than the row we're about to write.
    const previous = await this.getPreviousCheck(inboxId);

    await db.insert(dnsChecks).values({
      inboxId,
      // true = pass, false = fail, null = the lookup could not be completed
      // (or there was nothing to look up). Null is never stored as a failure.
      spfValid: outcomeToBoolean(spf),
      spfRecord: spf.detail,
      dkimValid: outcomeToBoolean(dkim),
      dkimSelector: inbox.dkimSelector ?? null,
      dmarcValid: outcomeToBoolean(dmarc),
      dmarcRecord: dmarc.detail,
      mxValid: outcomeToBoolean(mx),
      mxRecords: [mx.detail],
      rdnsValid: outcomeToBoolean(rdns),
      rdnsValue: rdns ? rdns.detail : null,
      // score is left unset — T013 (reputation scoring) computes it later.
    });

    await this.maybeAlert(inbox, previous, { spf, dkim, mx });

    await this.queueService.add('score-compute', { inboxId });
    this.logger.info({ jobId, inboxId, domain }, 'DNS check completed');
  }

  private async getPreviousCheck(
    inboxId: string,
  ): Promise<typeof dnsChecks.$inferSelect | undefined> {
    const rows = await db
      .select()
      .from(dnsChecks)
      .where(eq(dnsChecks.inboxId, inboxId))
      .orderBy(desc(dnsChecks.checkedAt))
      .limit(1);

    return rows[0];
  }

  /**
   * Fires one `dns_broken` notify job if any of the 3 critical fields (spf/dkim/mx)
   * newly flips from passing (or no previous row) to failing. The very first check
   * for an inbox never alerts — see addendum #4 — since there's no real baseline to
   * compare against, and alerting on every pre-existing issue the moment monitoring
   * turns on for a backlog of inboxes would be noise, not signal.
   */
  private async maybeAlert(
    inbox: typeof inboxes.$inferSelect,
    previous: typeof dnsChecks.$inferSelect | undefined,
    current: { spf: DnsCheckOutcome; dkim: DnsCheckOutcome; mx: DnsCheckOutcome },
  ): Promise<void> {
    if (!previous) {
      return;
    }

    const currentByField: Record<CriticalField, DnsCheckOutcome> = {
      spfValid: current.spf,
      dkimValid: current.dkim,
      mxValid: current.mx,
    };

    const hasNewCriticalIssue = CRITICAL_FIELDS.some((field) => {
      const isFailingNow = currentByField[field].status === 'fail';
      const wasPassingBefore = previous[field] !== false;
      return isFailingNow && wasPassingBefore;
    });

    if (!hasNewCriticalIssue) {
      return;
    }

    const issueCodes: IssueCode[] = CRITICAL_FIELDS.map(
      (field) => currentByField[field].code,
    ).filter((code): code is IssueCode => code !== null);

    await this.queueService.add('notify', {
      userId: inbox.userId,
      inboxId: inbox.id,
      type: 'dns_broken',
      channel: 'email',
      payload: { issueCodes },
    });
  }
}
