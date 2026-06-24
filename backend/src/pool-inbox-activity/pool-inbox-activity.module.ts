import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { PoolInboxActivityController } from './pool-inbox-activity.controller';
import { PoolInboxActivityService } from './pool-inbox-activity.service';

/**
 * Pool inbox activity dashboard (T028). Read-only module — no
 * BullMQ producers, no DB writes — depends only on the Drizzle
 * `db` singleton and pino for logging (both auto-provided by the
 * root AppModule), plus `QueueService` (read-only BullMQ job
 * lookups for the live-status panel).
 */
@Module({
  imports: [QueueModule],
  controllers: [PoolInboxActivityController],
  providers: [PoolInboxActivityService],
})
export class PoolInboxActivityModule {}
