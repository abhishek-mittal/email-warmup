import { Controller, Get, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { desc, eq } from 'drizzle-orm';
import { BetterAuthGuard } from '@/auth/better-auth.guard';
import { db } from '../db';
import { inboxes, diagnostics } from '../db/schema';
import { BillingService } from '../billing/billing.service';
import { QueueService } from '../queue/queue.service';
import { DiagnosticAnalysis } from './ai-analyzer.service';
import { ReadinessReport } from './readiness-report.service';

const AI_ANALYSIS_PLANS = ['growth', 'agency', 'enterprise'];

export interface DiagnosticsResponse {
  issueCodes: string[];
  aiAnalysis: DiagnosticAnalysis | null;
  readinessReport: ReadinessReport | null;
  createdAt: string | null;
}

@Controller('inboxes')
@UseGuards(BetterAuthGuard)
export class DiagnosticsController {
  constructor(
    private readonly billingService: BillingService,
    private readonly queueService: QueueService,
  ) {}

  /**
   * Own ownership check, mirroring T013's ScoringController pattern (no
   * existing shared helper) — undifferentiated NotFoundException for both
   * "not found" and "not yours". See T015 context addendum #6.
   */
  @Get(':id/diagnostics')
  async getDiagnostics(
    @Param('id') inboxId: string,
    @Req() req: Request & { userId?: string },
  ): Promise<DiagnosticsResponse> {
    const inboxRows = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    const inbox = inboxRows[0];
    if (!inbox || inbox.userId !== req.userId) {
      throw new NotFoundException();
    }

    const rows = await db
      .select()
      .from(diagnostics)
      .where(eq(diagnostics.inboxId, inboxId))
      .orderBy(desc(diagnostics.createdAt))
      .limit(1);

    const latest = rows[0];
    if (!latest) {
      return { issueCodes: [], aiAnalysis: null, readinessReport: null, createdAt: null };
    }

    return {
      issueCodes: (latest.issueCodes as string[]) ?? [],
      aiAnalysis: (latest.aiAnalysis as DiagnosticAnalysis) ?? null,
      readinessReport: (latest.readinessReport as ReadinessReport) ?? null,
      createdAt: latest.createdAt.toISOString(),
    };
  }

  /**
   * Hard-gated (403) unlike the automatic blacklist/score-drop triggers,
   * which run triggerDiagnostics for everyone and self-degrade. See T015
   * context addendum #5.
   */
  @Post(':id/diagnostics/run')
  async runDiagnostics(
    @Param('id') inboxId: string,
    @Req() req: Request & { userId?: string },
  ): Promise<{ diagnosticId: string }> {
    const inboxRows = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    const inbox = inboxRows[0];
    if (!inbox || inbox.userId !== req.userId) {
      throw new NotFoundException();
    }

    await this.billingService.assertPlan(req.userId as string, AI_ANALYSIS_PLANS);

    const job = await this.queueService.add('diagnostics', {
      inboxId,
      triggerType: 'manual',
    });

    return { diagnosticId: String(job.id) };
  }
}
