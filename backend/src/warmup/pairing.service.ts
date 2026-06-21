import { Injectable } from '@nestjs/common';
import { and, eq, gte, ne } from 'drizzle-orm';
import { db } from '../db';
import { poolMembers, warmupSends } from '../db/schema';

const PAIRED_RECENTLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const CROSS_PROVIDER_BONUS = 20;
const SAME_INDUSTRY_BONUS = 10;
const RECENTLY_PAIRED_PENALTY = 15;

type PoolMember = typeof poolMembers.$inferSelect;

@Injectable()
export class PairingService {
  /**
   * Selects the best available warmup partner for a sender inbox.
   * Returns the winning `pool_members` row (so `.id` can be used directly as
   * `partnerInboxId` in the warmup-send job payload) or null if no eligible
   * candidate exists. Selection only — does not write to warmup_sends; that
   * insert already happens in WarmupSendProcessor (T008).
   */
  async selectPartner(senderInboxId: string): Promise<PoolMember | null> {
    const senderRows = await db
      .select()
      .from(poolMembers)
      .where(eq(poolMembers.inboxId, senderInboxId))
      .limit(1);
    const sender = senderRows[0];
    if (!sender) {
      return null;
    }

    const candidates = await db
      .select()
      .from(poolMembers)
      .where(
        and(
          eq(poolMembers.active, true),
          eq(poolMembers.quarantined, false),
          ne(poolMembers.domain, sender.domain),
          ne(poolMembers.id, sender.id),
        ),
      );

    if (candidates.length === 0) {
      return null;
    }

    let best: PoolMember | null = null;
    let bestScore = -Infinity;

    for (const candidate of candidates) {
      const score = await this.scoreCandidate(sender, candidate, senderInboxId);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    return best;
  }

  private async scoreCandidate(
    sender: PoolMember,
    candidate: PoolMember,
    senderInboxId: string,
  ): Promise<number> {
    let score = candidate.reputation ?? 0;

    if (candidate.provider !== sender.provider) {
      score += CROSS_PROVIDER_BONUS;
    }
    if (candidate.industry && candidate.industry === sender.industry) {
      score += SAME_INDUSTRY_BONUS;
    }
    if (await this.pairedInLast7Days(senderInboxId, candidate.inboxId)) {
      score -= RECENTLY_PAIRED_PENALTY;
    }

    return score;
  }

  private async pairedInLast7Days(
    senderInboxId: string,
    candidateInboxId: string,
  ): Promise<boolean> {
    const since = new Date(Date.now() - PAIRED_RECENTLY_WINDOW_MS);
    const rows = await db
      .select()
      .from(warmupSends)
      .where(
        and(
          eq(warmupSends.senderInboxId, senderInboxId),
          eq(warmupSends.receiverInboxId, candidateInboxId),
          gte(warmupSends.sentAt, since),
        ),
      )
      .limit(1);

    return rows.length > 0;
  }
}
