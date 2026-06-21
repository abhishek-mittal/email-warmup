import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Cron } from '@nestjs/schedule';
import { Job, UnrecoverableError } from 'bullmq';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { dnsChecks, inboxes } from '../db/schema';
import { DnsService, DnsCheckOutcome, IssueCode } from './dns.service';
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
  private readonly logger = new Logger(DnsCheckProcessor.name);

  constructor(
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

    const inboxRows = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    const inbox = inboxRows[0];
    if (!inbox) {
      throw new UnrecoverableError(`Inbox ${inboxId} not found`);
    }

    const domain = inbox.email.split('@')[1];
    const selector = inbox.dkimSelector ?? 'default';

    const [spf, dkim, dmarc, mx] = await Promise.all([
      this.dnsService.checkSpf(domain),
      this.dnsService.checkDkim(domain, selector),
      this.dnsService.checkDmarc(domain),
      this.dnsService.checkMx(domain),
    ]);

    // rDNS is best-effort and only meaningful when the inbox has a known sending IP
    // (e.g. anything sent via Gmail/Outlook OAuth never has one) — see addendum #6.
    const rdns = inbox.sendingIp ? await this.dnsService.checkRdns(inbox.sendingIp) : null;

    // Read the previous check BEFORE inserting the new row, so the comparison is
    // against the prior state rather than the row we're about to write.
    const previous = await this.getPreviousCheck(inboxId);

    await db.insert(dnsChecks).values({
      inboxId,
      spfValid: spf.status === 'pass',
      spfRecord: spf.detail,
      dkimValid: dkim.status === 'pass',
      dkimSelector: selector,
      dmarcValid: dmarc.status === 'pass',
      dmarcRecord: dmarc.detail,
      mxValid: mx.status === 'pass',
      mxRecords: [mx.detail],
      rdnsValid: rdns ? rdns.status === 'pass' : null,
      rdnsValue: rdns ? rdns.detail : null,
      // score is left unset — T013 (reputation scoring) computes it later.
    });

    await this.maybeAlert(inbox, previous, { spf, dkim, mx });

    await this.queueService.add('score-compute', { inboxId });
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
