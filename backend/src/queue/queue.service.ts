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
}
