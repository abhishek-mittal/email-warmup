import { Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { reputationScores } from '../db/schema';

export type Trend = 'up' | 'down' | 'stable';

/**
 * DB-dependent trend computation, kept separate from ScoringService (pure
 * functions) per the skill file's module structure — see T013 context
 * addendum #11.
 */
@Injectable()
export class TrendService {
  /**
   * Compares the average of the 3 most recent existing scores against the
   * average of the 2 scores before that, using the 5 most recent EXISTING
   * rows (the current computation's row has not been inserted yet at the
   * point this is called — see addendum #6, which also drops the unused
   * `currentScore` parameter from the skill file's pseudocode signature).
   *
   * Requires at least 4 historical rows before attempting an up/down
   * determination — see addendum #7, which fixes a real bug in the skill
   * file's formula: with fewer than 4 rows, `history.slice(3)` is empty and
   * the skill's `Math.max(1, ...)` denominator would fabricate an average of
   * 0 for the "4-5 positions back" bucket, always reading as an artificial
   * "up" trend.
   */
  async computeTrend(inboxId: string): Promise<Trend> {
    const history = await db
      .select()
      .from(reputationScores)
      .where(eq(reputationScores.inboxId, inboxId))
      .orderBy(desc(reputationScores.recordedAt))
      .limit(5);

    if (history.length < 4) return 'stable';

    const avgLast3 = history.slice(0, 3).reduce((s, r) => s + r.score, 0) / 3;
    const rest = history.slice(3);
    const avgPrev2 = rest.reduce((s, r) => s + r.score, 0) / rest.length;

    if (avgLast3 > avgPrev2 + 3) return 'up';
    if (avgLast3 < avgPrev2 - 3) return 'down';
    return 'stable';
  }
}
