import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { MonitorModule } from '../monitor/monitor.module';
import { AnalysisService } from './analysis.service';
import { InboxAnalysisProcessor } from './inbox-analysis.processor';

// QueueModule is imported here (not just transitively via MonitorModule, which
// does not re-export it) because every module in this codebase that declares a
// @Processor(...) class imports QueueModule directly — see NotifyModule,
// ScoringModule, PlacementModule — so the 'inbox-analysis' queue registered in
// QUEUE_NAMES is resolvable for InboxAnalysisProcessor's worker registration.
@Module({
  imports: [QueueModule, MonitorModule],
  providers: [AnalysisService, InboxAnalysisProcessor],
  exports: [AnalysisService],
})
export class AnalysisModule {}
