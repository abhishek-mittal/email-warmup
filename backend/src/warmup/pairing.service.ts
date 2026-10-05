import { Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { db } from '../db';
import { inboxes, poolInboxes, poolMembers, warmupSends } from '../db/schema';

const PAIRED_RECENTLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const CROSS_PROVIDER_BONUS = 20;
const SAME_INDUSTRY_BONUS = 10;
const RECENTLY_PAIRED_PENALTY = 15;

/**
 * Daily caps. A sender's volume for the day is spread over partners instead
 * of being aimed at whichever one scores highest, and no receiver is asked to
 * absorb more warmup mail than this from the whole pool.
 */
export const PAIRING_LIMITS = {
  /** Sends per day from one sender to one shared-pool partner. */
  sharedPerPair: 3,
  /** Sends per day from one sender to one of its own private-pool inboxes. */
  privatePerPair: 10,
  /** Inbound warmup mail per day for any one receiver, across all senders. */
  receiverInbound: 40,
} as const;

/** Rows that hold (or have used) a slot of capacity. Failed/canceled rows release theirs. */
export const LIVE_SEND_STATUSES = ['planned', 'submitting', 'accepted', 'uncertain'];

type InboxRow = typeof inboxes.$inferSelect;
type PoolMember = typeof poolMembers.$inferSelect;
type PoolInbox = typeof poolInboxes.$inferSelect;

/** `db` or an open transaction — pairing reads must see the caller's reservations. */
export type DbExecutor = typeof db | Parameters<Parameters<(typeof db)['transaction']>[0]>[0];

export type PairingPartner =
  | { source: 'private'; poolInbox: PoolInbox }
  | { source: 'shared'; poolMember: PoolMember };

interface Candidate {
  partner: PairingPartner;
  score: number;
  capacity: number;
}

@Injectable()
export class PairingService {
  /**
   * Chooses receivers for up to `count` sends from `sender` today.
   *
   * The tenant's own private pool (`pool_inboxes`, status='active') is used
   * first; whatever is left over is filled from the shared pool. Returns
   * fewer than `count` entries when there isn't enough eligible capacity —
   * the ramp volume is a target, never a reason to overload a partner.
   *
   * Hard rules, applied to both sources: never the sender's own domain, and
   * the receiver must be active. The shared pool additionally requires
   * recorded pool consent on BOTH sides and an active, non-quarantined
   * membership for the receiver.
   *
   * Selection only — the caller writes the reservations.
   */
  async selectPartners(
    sender: InboxRow,
    count: number,
    since: Date,
    executor: DbExecutor = db,
  ): Promise<PairingPartner[]> {
    if (count <= 0) return [];

    const privateCandidates = await this.privateCandidates(sender, since, executor);
    const chosen = this.distribute(privateCandidates, count);
    if (chosen.length >= count) return chosen;

    const sharedCandidates = await this.sharedCandidates(sender, since, executor);
    return chosen.concat(this.distribute(sharedCandidates, count - chosen.length));
  }

  /**
   * Cheap existence check powering the warmup start gate: does this inbox have
   * at least one eligible warm-with partner with spare capacity right now — a
   * different-domain private pool inbox, or (when consented) a shared pool
   * member? Same filters as selectPartners, no scoring/distribution.
   */
  async hasEligiblePartners(
    sender: InboxRow,
    since: Date = new Date(Date.now() - PAIRED_RECENTLY_WINDOW_MS),
    executor: DbExecutor = db,
  ): Promise<boolean> {
    const priv = await this.privateCandidates(sender, since, executor);
    if (priv.some((c) => c.capacity > 0)) return true;
    const shared = await this.sharedCandidates(sender, since, executor);
    return shared.some((c) => c.capacity > 0);
  }

  /**
   * Round-robin over candidates in score order, so the best partner gets the
   * first send but not all of them.
   */
  private distribute(candidates: Candidate[], count: number): PairingPartner[] {
    const pool = candidates
      .filter((c) => c.capacity > 0)
      .sort((a, b) => b.score - a.score)
      .map((c) => ({ ...c }));
    const chosen: PairingPartner[] = [];

    while (chosen.length < count) {
      let progressed = false;
      for (const candidate of pool) {
        if (chosen.length >= count) break;
        if (candidate.capacity <= 0) continue;
        chosen.push(candidate.partner);
        candidate.capacity -= 1;
        progressed = true;
      }
      if (!progressed) break;
    }
    return chosen;
  }

  private async privateCandidates(
    sender: InboxRow,
    since: Date,
    executor: DbExecutor,
  ): Promise<Candidate[]> {
    const senderDomain = domainOf(sender.email);
    const rows = await executor
      .select()
      .from(poolInboxes)
      .where(and(eq(poolInboxes.userId, sender.userId), eq(poolInboxes.status, 'active')));
    const eligible = rows.filter((row) => domainOf(row.email) !== senderDomain);
    if (eligible.length === 0) return [];

    const ids = eligible.map((row) => row.id);
    const usage = await this.usage(
      executor,
      warmupSends.receiverPoolInboxId,
      ids,
      sender.id,
      since,
    );

    return eligible.map((poolInbox) => {
      const used = usage.get(poolInbox.id) ?? { inboundToday: 0, fromSenderToday: 0, recent: 0 };
      // Lower active_pairs scores higher; a partner used in the last week scores lower.
      let score = -(poolInbox.activePairs ?? 0);
      if (used.recent > 0) score -= RECENTLY_PAIRED_PENALTY;
      return {
        partner: { source: 'private' as const, poolInbox },
        score,
        capacity: Math.min(
          PAIRING_LIMITS.privatePerPair - used.fromSenderToday,
          PAIRING_LIMITS.receiverInbound - used.inboundToday,
        ),
      };
    });
  }

  private async sharedCandidates(
    sender: InboxRow,
    since: Date,
    executor: DbExecutor,
  ): Promise<Candidate[]> {
    // Pool consent is a precondition for touching the shared pool at all.
    if (!sender.poolConsentAt) return [];

    const senderMemberRows = await executor
      .select()
      .from(poolMembers)
      .where(and(eq(poolMembers.inboxId, sender.id), eq(poolMembers.active, true)))
      .limit(1);
    const senderMember = senderMemberRows[0];
    if (!senderMember || senderMember.quarantined) return [];

    const rows = await executor
      .select({ member: poolMembers })
      .from(poolMembers)
      .innerJoin(inboxes, eq(inboxes.id, poolMembers.inboxId))
      .where(
        and(
          eq(poolMembers.active, true),
          eq(poolMembers.quarantined, false),
          ne(poolMembers.domain, senderMember.domain),
          ne(poolMembers.inboxId, sender.id),
          // 'ready' inboxes (consented, verified, not yet started warming their
          // own sends) are still valid receivers others can warm against.
          inArray(inboxes.status, ['active', 'ready']),
          isNotNull(inboxes.poolConsentAt),
        ),
      );

    const senderDomain = domainOf(sender.email);
    // One candidate per inbox even if a duplicate membership row exists.
    const byInbox = new Map<string, PoolMember>();
    for (const { member } of rows) {
      if (member.domain.toLowerCase() === senderDomain) continue;
      if (!byInbox.has(member.inboxId)) byInbox.set(member.inboxId, member);
    }
    if (byInbox.size === 0) return [];

    const usage = await this.usage(
      executor,
      warmupSends.receiverInboxId,
      [...byInbox.keys()],
      sender.id,
      since,
    );

    return [...byInbox.values()].map((member) => {
      const used = usage.get(member.inboxId) ?? { inboundToday: 0, fromSenderToday: 0, recent: 0 };
      let score = member.reputation ?? 0;
      if (member.provider !== senderMember.provider) score += CROSS_PROVIDER_BONUS;
      if (member.industry && member.industry === senderMember.industry)
        score += SAME_INDUSTRY_BONUS;
      if (used.recent > 0) score -= RECENTLY_PAIRED_PENALTY;
      return {
        partner: { source: 'shared' as const, poolMember: member },
        score,
        capacity: Math.min(
          PAIRING_LIMITS.sharedPerPair - used.fromSenderToday,
          PAIRING_LIMITS.receiverInbound - used.inboundToday,
        ),
      };
    });
  }

  /**
   * One grouped query for all candidates: how much each receiver has been
   * sent today (by anyone, and by this sender) and whether this sender used
   * it in the last week. Replaces a query per candidate per slot.
   */
  private async usage(
    executor: DbExecutor,
    receiverColumn: typeof warmupSends.receiverInboxId | typeof warmupSends.receiverPoolInboxId,
    receiverIds: string[],
    senderInboxId: string,
    dayStart: Date,
  ): Promise<Map<string, { inboundToday: number; fromSenderToday: number; recent: number }>> {
    const weekAgo = new Date(Date.now() - PAIRED_RECENTLY_WINDOW_MS);
    const earliest = weekAgo < dayStart ? weekAgo : dayStart;

    const rows = await executor
      .select({
        receiverId: receiverColumn,
        inboundToday: sql<number>`count(*) filter (where ${warmupSends.scheduledAt} >= ${dayStart.toISOString()}::timestamp)::int`,
        fromSenderToday: sql<number>`count(*) filter (where ${warmupSends.scheduledAt} >= ${dayStart.toISOString()}::timestamp and ${warmupSends.senderInboxId} = ${senderInboxId})::int`,
        recent: sql<number>`count(*) filter (where ${warmupSends.senderInboxId} = ${senderInboxId} and ${warmupSends.sentAt} is not null)::int`,
      })
      .from(warmupSends)
      .where(
        and(
          inArray(receiverColumn, receiverIds),
          inArray(warmupSends.status, LIVE_SEND_STATUSES),
          gte(warmupSends.scheduledAt, earliest),
        ),
      )
      .groupBy(receiverColumn);

    const result = new Map<
      string,
      { inboundToday: number; fromSenderToday: number; recent: number }
    >();
    for (const row of rows) {
      if (!row.receiverId) continue;
      result.set(row.receiverId, {
        inboundToday: Number(row.inboundToday),
        fromSenderToday: Number(row.fromSenderToday),
        recent: Number(row.recent),
      });
    }
    return result;
  }
}

function domainOf(email: string): string {
  return email.split('@')[1]?.toLowerCase() ?? '';
}
