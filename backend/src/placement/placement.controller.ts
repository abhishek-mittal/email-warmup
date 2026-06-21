import { Controller, Get, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { desc, eq } from 'drizzle-orm';
import { BetterAuthGuard } from '@/auth/better-auth.guard';
import { db } from '../db';
import { inboxes, placementTests } from '../db/schema';
import { PlacementService, RunTestResult } from './placement.service';

const HISTORY_LIMIT = 10;

type PlacementTestRow = typeof placementTests.$inferSelect;

export interface PlacementResultResponse {
  status: 'pending' | 'complete';
  primaryPct: number | null;
  promotionsPct: number | null;
  spamPct: number | null;
  missingPct: number | null;
  placementScore: number | null;
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
      .orderBy(desc(placementTests.completedAt))
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

  /**
   * Derives status/completedAt from data rather than a stored column — see
   * addendum #3/#4. A row is "pending" while placementScore is null (the
   * result fields haven't been filled in by the processor yet); completedAt
   * is only surfaced once "complete", even though the underlying DB column
   * always holds some timestamp (an insert-time placeholder while pending).
   */
  private toResponse(test: PlacementTestRow): PlacementResultResponse {
    const isComplete = test.placementScore !== null;

    return {
      status: isComplete ? 'complete' : 'pending',
      primaryPct: isComplete ? test.primaryPct : null,
      promotionsPct: isComplete ? test.promotionsPct : null,
      spamPct: isComplete ? test.spamPct : null,
      missingPct: isComplete ? this.missingPct(test) : null,
      placementScore: isComplete ? test.placementScore : null,
      completedAt: isComplete ? test.completedAt.toISOString() : null,
    };
  }

  private missingPct(test: PlacementTestRow): number {
    if (!test.seedCount || test.seedCount === 0) return 0;
    return Math.round(((test.missingCount ?? 0) / test.seedCount) * 100);
  }
}
