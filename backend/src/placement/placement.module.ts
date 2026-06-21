import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { InboxModule } from '../inbox/inbox.module';
import { SeedListService } from './seed-list.service';
import { PlacementService } from './placement.service';
import { PlacementAnalyzerService } from './placement-analyzer.service';
import { PlacementTestProcessor } from './placement-test.processor';
import { PlacementController } from './placement.controller';

@Module({
  imports: [QueueModule, InboxModule],
  controllers: [PlacementController],
  providers: [SeedListService, PlacementService, PlacementAnalyzerService, PlacementTestProcessor],
  exports: [PlacementService, SeedListService],
})
export class PlacementModule {}
