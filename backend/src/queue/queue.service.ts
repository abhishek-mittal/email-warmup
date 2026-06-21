import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { QueueName, QUEUE_NAMES } from './queue.module';

type JobPayload = Record<string, unknown>;

@Injectable()
export class QueueService {
  constructor(
    @InjectQueue('warmup-send') private readonly warmupSendQueue: Queue,
    @InjectQueue('warmup-receive') private readonly warmupReceiveQueue: Queue,
    @InjectQueue('dns-check') private readonly dnsCheckQueue: Queue,
    @InjectQueue('blacklist-check') private readonly blacklistCheckQueue: Queue,
    @InjectQueue('placement-test') private readonly placementTestQueue: Queue,
    @InjectQueue('score-compute') private readonly scoreComputeQueue: Queue,
    @InjectQueue('notify') private readonly notifyQueue: Queue,
    @InjectQueue('token-refresh') private readonly tokenRefreshQueue: Queue,
    @InjectQueue('readiness-report') private readonly readinessReportQueue: Queue,
    @InjectQueue('diagnostics') private readonly diagnosticsQueue: Queue,
  ) {}

  private getQueue(name: QueueName): Queue {
    switch (name) {
      case 'warmup-send':
        return this.warmupSendQueue;
      case 'warmup-receive':
        return this.warmupReceiveQueue;
      case 'dns-check':
        return this.dnsCheckQueue;
      case 'blacklist-check':
        return this.blacklistCheckQueue;
      case 'placement-test':
        return this.placementTestQueue;
      case 'score-compute':
        return this.scoreComputeQueue;
      case 'notify':
        return this.notifyQueue;
      case 'token-refresh':
        return this.tokenRefreshQueue;
      case 'readiness-report':
        return this.readinessReportQueue;
      case 'diagnostics':
        return this.diagnosticsQueue;
      default:
        throw new Error(`Unknown queue: ${name}`);
    }
  }

  async add(name: QueueName, payload: JobPayload, opts?: Parameters<Queue['add']>[2]) {
    return this.getQueue(name).add(name, payload, opts);
  }

  async addTokenRefresh(payload: { inboxId: string }, opts?: Parameters<Queue['add']>[2]) {
    return this.add('token-refresh', payload, opts);
  }

  async getJobCounts(name: QueueName) {
    return this.getQueue(name).getJobCounts();
  }

  /**
   * Drains pending (delayed/waiting) jobs from `queueName` whose payload identifies
   * `senderInboxId` as the sender. Used by WarmupService.pauseInbox to stop a
   * paused inbox from sending further warmup mail.
   */
  async removeJobsForSender(queueName: QueueName, senderInboxId: string): Promise<void> {
    const queue = this.getQueue(queueName);
    const jobs = await queue.getJobs(['delayed', 'waiting']);
    await Promise.all(
      jobs.filter((job) => job.data.senderInboxId === senderInboxId).map((job) => job.remove()),
    );
  }

  /**
   * Drains pending (delayed/waiting) jobs from `queueName` whose payload identifies
   * `receiverInboxId` as the receiver. Used by WarmupService.pauseInbox to stop a
   * paused inbox from engaging with (opening/replying to/rescuing) warmup mail
   * already sent to it.
   */
  async removeJobsForReceiver(queueName: QueueName, receiverInboxId: string): Promise<void> {
    const queue = this.getQueue(queueName);
    const jobs = await queue.getJobs(['delayed', 'waiting']);
    await Promise.all(
      jobs.filter((job) => job.data.receiverInboxId === receiverInboxId).map((job) => job.remove()),
    );
  }
}
