import { Controller, Get, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { desc, eq } from 'drizzle-orm';
import { BetterAuthGuard } from '@/auth/better-auth.guard';
import { db } from '../db';
import { inboxes, placementTests } from '../db/schema';
import { PlacementService, RunTestResult } from './placement.service';

const HISTORY_LIMIT = 10;

type PlacementTestRow = typeof placementTests.$inferSelect;

export interface PlacementResultResponse {
  id: string;
  /**
   * pending:  queued or still checking seeds
   * complete: every selected seed was observed
   * partial:  some seeds could not be checked; percentages cover the rest
   * failed:   too few observations for a result — no percentages
   */
  status: 'pending' | 'complete' | 'partial' | 'failed';
  seedCount: number | null;
  /** Seeds actually observed: the denominator of every percentage. */
  observedCount: number | null;
  /** Seeds that could not be checked. Not counted as spam or missing. */
  errorCount: number | null;
  primaryPct: number | null;
  promotionsPct: number | null;
  otherInboxPct: number | null;
  spamPct: number | null;
  missingPct: number | null;
  placementScore: number | null;
  failureReason: string | null;
  createdAt: string;
  completedAt: string | null;
}

/**
 * 3 endpoints per the T014 context addendum. Ownership check is done inline
 * here (no shared "verify inbox belongs to req.userId" helper exists yet —
 * mirrors ScoringController/T013's pattern) and never distinguishes "not
 * found" from "not yours", to avoid leaking existence of other users'
 * inboxes.
 */
@Controller('inboxes')
@UseGuards(BetterAuthGuard)
export class PlacementController {
  constructor(private readonly placementService: PlacementService) {}

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(':id/placement-test')
  async createTest(
    @Param('id') inboxId: string,
    @Req() req: Request & { userId?: string },
  ): Promise<RunTestResult> {
    await this.assertOwnership(inboxId, req.userId);
    return this.placementService.runTest(inboxId, req.userId!);
  }

  @Get(':id/placement-test/:testId')
  async getTest(
    @Param('id') inboxId: string,
    @Param('testId') testId: string,
    @Req() req: Request & { userId?: string },
  ): Promise<PlacementResultResponse> {
    await this.assertOwnership(inboxId, req.userId);

    const rows = await db
      .select()
      .from(placementTests)
      .where(eq(placementTests.id, testId))
      .limit(1);
    const test = rows[0];
    if (!test || test.inboxId !== inboxId) {
      throw new NotFoundException();
    }

    return this.toResponse(test);
  }

  @Get(':id/placement-tests')
  async listTests(
    @Param('id') inboxId: string,
    @Req() req: Request & { userId?: string },
  ): Promise<PlacementResultResponse[]> {
    await this.assertOwnership(inboxId, req.userId);

    const rows = await db
      .select()
      .from(placementTests)
      .where(eq(placementTests.inboxId, inboxId))
      .orderBy(desc(placementTests.createdAt))
      .limit(HISTORY_LIMIT);

    return rows.map((row) => this.toResponse(row));
  }

  private async assertOwnership(inboxId: string, userId?: string): Promise<void> {
    const rows = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    const inbox = rows[0];
    if (!inbox || inbox.userId !== userId) {
      throw new NotFoundException();
    }
  }

  private toResponse(test: PlacementTestRow): PlacementResultResponse {
    const status: PlacementResultResponse['status'] =
      test.status === 'queued' || test.status === 'running'
        ? 'pending'
        : (test.status as 'complete' | 'partial' | 'failed');
    const hasResult = status === 'complete' || status === 'partial';
    const observed = test.observedCount ?? 0;
    const pct = (count: number | null) =>
      hasResult && observed > 0 ? Math.round(((count ?? 0) / observed) * 100) : null;

    return {
      id: test.id,
      status,
      seedCount: test.seedCount,
      observedCount: status === 'pending' ? null : test.observedCount,
      errorCount: status === 'pending' ? null : test.errorCount,
      primaryPct: hasResult ? test.primaryPct : null,
      promotionsPct: hasResult ? test.promotionsPct : null,
      otherInboxPct: pct(test.otherInboxCount),
      spamPct: hasResult ? test.spamPct : null,
      missingPct: pct(test.missingCount),
      placementScore: hasResult ? test.placementScore : null,
      failureReason: status === 'failed' ? test.failureReason : null,
      createdAt: test.createdAt.toISOString(),
      completedAt: status !== 'pending' && test.completedAt ? test.completedAt.toISOString() : null,
    };
  }
}
