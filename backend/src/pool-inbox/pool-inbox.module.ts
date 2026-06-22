import { Module } from '@nestjs/common';
import { PoolInboxController } from './pool-inbox.controller';
import { PoolInboxService } from './pool-inbox.service';
import { QueueModule } from '../queue/queue.module';

// Not imported into app.module.ts by this task — wired in afterward by the
// controller (T020 file-ownership boundary), same pattern this codebase
// already used for T011/T012 and T014/T015.
@Module({
  imports: [QueueModule],
  controllers: [PoolInboxController],
  providers: [PoolInboxService],
  exports: [PoolInboxService],
})
export class PoolInboxModule {}
