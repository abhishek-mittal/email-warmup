import { Injectable } from '@nestjs/common';
import { and, eq, gte, ne } from 'drizzle-orm';
import { db } from '../db';
import { inboxes, poolInboxes, poolMembers, warmupSends } from '../db/schema';

const PAIRED_RECENTLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const CROSS_PROVIDER_BONUS = 20;
const SAME_INDUSTRY_BONUS = 10;
const RECENTLY_PAIRED_PENALTY = 15;

type PoolMember = typeof poolMembers.$inferSelect;
type PoolInbox = typeof poolInboxes.$inferSelect;

export type PairingPartner =
  | { source: 'private'; poolInbox: PoolInbox }
  | { source: 'shared'; poolMember: PoolMember };

@Injectable()
export class PairingService {
  /**
   * Selects the best available warmup partner for a sender inbox.
   *
   * When `userId` is provided, the tenant's own private pool (`pool_inboxes`,
   * status='active') is checked first — same-domain hard block applied,
   * scored by lower active_pairs then by not having been used for this
   * sender in the last 7 days. If no private-pool candidate qualifies, falls
   * back to the existing shared `pool_members` logic (unchanged). Returns
   * null if neither source yields a partner.
   *
   * Selection only — does not write to warmup_sends; that insert already
   * happens in WarmupSendProcessor (T008).
   */
  async selectPartner(senderInboxId: string, userId?: string): Promise<PairingPartner | null> {
    if (userId) {
      const privatePartner = await this.selectPrivatePoolPartner(senderInboxId, userId);
      if (privatePartner) {
        return { source: 'private', poolInbox: privatePartner };
      }
    }

    const sharedPartner = await this.selectSharedPoolPartner(senderInboxId);
    if (sharedPartner) {
      return { source: 'shared', poolMember: sharedPartner };
    }

    return null;
  }

  /**
   * Tenant's own pool_inboxes, filtered by same-domain hard block, scored by
   * lower active_pairs (preferred) then by not having been paired with this
   * sender in the last 7 days (preferred). Pool inboxes require no
   * pool_members enrollment and no pool_consent_at check — they are
   * operator-controlled by the tenant and available once status='active'.
   */
  private async selectPrivatePoolPartner(
    senderInboxId: string,
    userId: string,
  ): Promise<PoolInbox | null> {
    const senderRows = await db
      .select()
      .from(inboxes)
      .where(eq(inboxes.id, senderInboxId))
      .limit(1);
    const sender = senderRows[0];
    if (!sender) {
      return null;
    }
    const senderDomain = sender.email.split('@')[1]?.toLowerCase();

    const candidates = await db
      .select()
      .from(poolInboxes)
      .where(and(eq(poolInboxes.userId, userId), eq(poolInboxes.status, 'active')));

    const eligible = candidates.filter((candidate) => {
      const candidateDomain = candidate.email.split('@')[1]?.toLowerCase();
      return candidateDomain !== senderDomain;
    });

    if (eligible.length === 0) {
      return null;
    }

    let best: PoolInbox | null = null;
    let bestScore = -Infinity;

    for (const candidate of eligible) {
      const score = await this.scorePrivateCandidate(candidate, senderInboxId);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    return best;
  }

  /**
   * Lower active_pairs scores higher (inverted so "prefer lower" becomes
   * "prefer higher score"). A recency penalty applies if this pool inbox was
   * used as the receiver for this sender in the last 7 days.
   */
  private async scorePrivateCandidate(
    candidate: PoolInbox,
    senderInboxId: string,
  ): Promise<number> {
    let score = -(candidate.activePairs ?? 0);

    if (await this.privatePairedInLast7Days(senderInboxId, candidate.id)) {
      score -= RECENTLY_PAIRED_PENALTY;
    }

    return score;
  }

  private async privatePairedInLast7Days(
    senderInboxId: string,
    candidatePoolInboxId: string,
  ): Promise<boolean> {
    const since = new Date(Date.now() - PAIRED_RECENTLY_WINDOW_MS);
    const rows = await db
      .select()
      .from(warmupSends)
      .where(
        and(
          eq(warmupSends.senderInboxId, senderInboxId),
          eq(warmupSends.receiverPoolInboxId, candidatePoolInboxId),
          gte(warmupSends.sentAt, since),
        ),
      )
      .limit(1);

    return rows.length > 0;
  }

  /** Existing shared pool_members selection logic — unchanged behavior. */
  private async selectSharedPoolPartner(senderInboxId: string): Promise<PoolMember | null> {
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
