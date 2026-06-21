import { Injectable } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { DiagnosticsService, DiagnosticTriggerType } from './diagnostics.service';

export interface DiagnosticsJobData {
  inboxId: string;
  triggerType: DiagnosticTriggerType;
}

/**
 * Thin processor — delegates straight to DiagnosticsService.triggerDiagnostics,
 * for consistency with every other queue consumer in this codebase (each
 * BullMQ queue has its own dedicated processor file). See T015 context
 * addendum's "files you create" section.
 */
@Injectable()
@Processor('diagnostics')
export class DiagnosticsProcessor extends WorkerHost {
  constructor(private readonly diagnosticsService: DiagnosticsService) {
    super();
  }

  async process(job: Job<DiagnosticsJobData>): Promise<void> {
    const { inboxId, triggerType } = job.data;
    await this.diagnosticsService.triggerDiagnostics(inboxId, triggerType);
  }
}
