import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { BillingModule } from '../billing/billing.module';
import { DiagnosticsService } from './diagnostics.service';
import { AiAnalyzerService } from './ai-analyzer.service';
import { ReadinessReportService } from './readiness-report.service';
import { DiagnosticsController } from './diagnostics.controller';
import { DiagnosticsProcessor } from './diagnostics.processor';
import { ReadinessReportProcessor } from './readiness-report.processor';

@Module({
  imports: [QueueModule, BillingModule],
  controllers: [DiagnosticsController],
  providers: [
    DiagnosticsService,
    AiAnalyzerService,
    ReadinessReportService,
    DiagnosticsProcessor,
    ReadinessReportProcessor,
  ],
  exports: [DiagnosticsService, AiAnalyzerService, ReadinessReportService],
})
export class DiagnosticsModule {}
