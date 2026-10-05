import { Controller, Get, NotFoundException, Param, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { asc, eq } from 'drizzle-orm';
import { BetterAuthGuard } from '@/auth/better-auth.guard';
import { db } from '../db';
import { inboxes, users, reputationScores } from '../db/schema';

const HIDDEN_BREAKDOWN_PLANS = new Set(['trial', 'starter']);

export interface ScoreResponse {
  current: number | null;
  completeness: number | null;
  trend: 'up' | 'down' | 'stable';
  breakdown: { dns: number; blacklist: number; placement: number } | null;
  history: { date: string; score: number }[];
}

@Controller('inboxes')
@UseGuards(BetterAuthGuard)
export class ScoringController {
  @Get(':id/score')
  async getScore(
    @Param('id') inboxId: string,
    @Req() req: Request & { userId?: string },
  ): Promise<ScoreResponse> {
    const inboxRows = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    const inbox = inboxRows[0];
    // Don't distinguish "not found" from "not yours" — see T013 context
    // addendum #9.
    if (!inbox || inbox.userId !== req.userId) {
      throw new NotFoundException();
    }

    const userRows = await db.select().from(users).where(eq(users.id, inbox.userId)).limit(1);
    const plan = userRows[0]?.plan ?? 'trial';

    const history = await db
      .select()
      .from(reputationScores)
      .where(eq(reputationScores.inboxId, inboxId))
      .orderBy(asc(reputationScores.recordedAt));

    if (history.length === 0) {
      return { current: null, completeness: null, trend: 'stable', breakdown: null, history: [] };
    }

    const latest = history[history.length - 1];
    const breakdown = HIDDEN_BREAKDOWN_PLANS.has(plan)
      ? null
      : {
          dns: latest.dnsScore,
          blacklist: latest.blacklistScore,
          placement: latest.placementScore,
        };

    return {
      current: latest.score,
      // Share of the score that rests on real, recent measurements. Null for
      // scores recorded before this was tracked.
      completeness: latest.completeness,
      trend: (latest.trend as 'up' | 'down' | 'stable') ?? 'stable',
      breakdown,
      history: history.map((row) => ({
        date: row.recordedAt.toISOString(),
        score: row.score,
      })),
    };
  }
}
