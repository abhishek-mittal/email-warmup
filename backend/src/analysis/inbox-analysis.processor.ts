import { Injectable } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { AnalysisService, AnalysisJobData } from './analysis.service';

/**
 * Thin processor — delegates straight to AnalysisService.analyse, for
 * consistency with every other queue consumer in this codebase (each BullMQ
 * queue has its own dedicated processor file, e.g. DiagnosticsProcessor).
 */
@Injectable()
@Processor('inbox-analysis')
export class InboxAnalysisProcessor extends WorkerHost {
  constructor(private readonly analysisService: AnalysisService) {
    super();
  }

  async process(job: Job<AnalysisJobData>): Promise<void> {
    const { inboxId, poolInboxId, userId } = job.data;
    await this.analysisService.analyse({ inboxId, poolInboxId, userId });
  }
}
