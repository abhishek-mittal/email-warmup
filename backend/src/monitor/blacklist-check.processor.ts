import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Cron } from '@nestjs/schedule';
import { Job, UnrecoverableError } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { blacklistChecks, inboxes } from '../db/schema';
import { BlacklistService } from './blacklist.service';
import { QueueService } from '../queue/queue.service';
import { WarmupService } from '../warmup/warmup.service';

export interface BlacklistCheckJobData {
  inboxId: string;
}

@Injectable()
@Processor('blacklist-check')
export class BlacklistCheckProcessor extends WorkerHost {
  constructor(
    @InjectPinoLogger(BlacklistCheckProcessor.name)
    private readonly logger: PinoLogger,
    private readonly blacklistService: BlacklistService,
    private readonly queueService: QueueService,
    private readonly warmupService: WarmupService,
  ) {
    super();
  }

  /**
   * Fires at 00:00, 06:00, 12:00, and 18:00 UTC — exactly 4 times per day. This
   * cron expression (combined with enqueueing exactly once per active inbox per
   * firing) is what satisfies "no more than 4 checks per 24h per inbox"; see T012
   * context addendum #8. Do not add any additional triggers elsewhere.
   */
  @Cron('0 0,6,12,18 * * *', { utcOffset: 0 })
  async scheduleAllInboxes(): Promise<void> {
    const activeInboxes = await db.select().from(inboxes).where(eq(inboxes.status, 'active'));

    for (const inbox of activeInboxes) {
      await this.queueService.add('blacklist-check', { inboxId: inbox.id });
    }
  }

  async process(job: Job<BlacklistCheckJobData>): Promise<void> {
    const { inboxId } = job.data;
    const jobId = String(job.id);

    const inboxRows = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    const inbox = inboxRows[0];
    if (!inbox) {
      throw new UnrecoverableError(`Inbox ${inboxId} not found`);
    }

    const domain = inbox.email.split('@')[1];
    this.logger.info({ jobId, inboxId, domain }, 'blacklist check started');
    const result = await this.blacklistService.check(domain, inbox.sendingIp);

    await db.insert(blacklistChecks).values({
      inboxId,
      isClean: result.isClean,
      listedCount: result.listedCount,
      rblResults: result.rblResults,
    });

    // Only a real listing pauses. "Nothing could be checked" (isClean null) and
    // refused or failed lookups are not evidence against the sender.
    if (result.isClean === false) {
      // Pause MUST complete before the alert is sent — see T012 context addendum #5
      // and the monitoring skill file's "never fire blacklist alert without pausing
      // warmup first" rule.
      await this.warmupService.pauseInbox(inboxId, 'blacklist');
      this.logger.warn(
        { jobId, inboxId, listed: result.listed, rbl: Object.keys(result.rblResults ?? {}) },
        'inbox paused due to blacklist hit',
      );

      await this.queueService.add('notify', {
        userId: inbox.userId,
        inboxId,
        type: 'blacklist_hit',
        channel: 'email',
        payload: { listed: result.listed },
      });

      await this.queueService.add('diagnostics', {
        inboxId,
        triggerType: 'auto_blacklist',
      });
    }

    await this.queueService.add('score-compute', { inboxId });
    this.logger.info(
      {
        jobId,
        inboxId,
        domain,
        isClean: result.isClean,
        listedCount: result.listedCount,
        checkedCount: result.checkedCount,
        unknownCount: result.unknownCount,
      },
      'blacklist check completed',
    );
  }
}
