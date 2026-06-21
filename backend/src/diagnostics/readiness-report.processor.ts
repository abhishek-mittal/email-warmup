import { Injectable } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ReadinessReportService } from './readiness-report.service';

export interface ReadinessReportJobData {
  inboxId: string;
}

/**
 * Thin processor — delegates to ReadinessReportService.generateReadinessReport
 * then persists the result, for consistency with every other queue consumer
 * in this codebase. See T015 context addendum's "files you create" section.
 */
@Injectable()
@Processor('readiness-report')
export class ReadinessReportProcessor extends WorkerHost {
  constructor(private readonly readinessReportService: ReadinessReportService) {
    super();
  }

  async process(job: Job<ReadinessReportJobData>): Promise<void> {
    const { inboxId } = job.data;
    const report = await this.readinessReportService.generateReadinessReport(inboxId);
    await this.readinessReportService.saveReadinessReport(inboxId, report);
  }
}
