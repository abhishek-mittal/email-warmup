import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QueueService } from './queue.service';

export const QUEUE_NAMES = [
  'warmup-send',
  'warmup-receive',
  'dns-check',
  'blacklist-check',
  'placement-test',
  'score-compute',
  'notify',
  'token-refresh',
  'readiness-report',
  'diagnostics',
  'inbox-analysis',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        url: process.env.REDIS_URL,
      },
      defaultJobOptions: {
        // Jobs that set their own attempts (warmup send/receive, placement,
        // notify) keep them. Everything else — the DNS, blocklist, scoring,
        // analysis and report jobs, all of which only read and then write a
        // fresh row — gets a bounded retry instead of failing once for good.
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: { count: 1000, age: 86400 },
        removeOnFail: { count: 500, age: 259200 },
      },
    }),
    ...QUEUE_NAMES.map((name) =>
      BullModule.registerQueue({
        name,
      }),
    ),
  ],
  providers: [QueueService],
  exports: [QueueService, BullModule],
})
export class QueueModule {}
