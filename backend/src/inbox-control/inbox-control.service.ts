import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { inboxes, users } from '../db/schema';
import { PLAN_LIMITS } from '../billing/billing.service';
import { WarmupService } from '../warmup/warmup.service';
import { BounceMonitorService, BOUNCE_PAUSE_REASON } from '../safety/bounce-monitor.service';

/**
 * Bulk + single pause/resume operations on user-owned inboxes. Lives in
 * its own module (`InboxControlModule`) so the inbox controller doesn't
 * need to import `WarmupModule` — that would create a cycle (warmup
 * already imports inbox for `ContentService`). The service is just an
 * ownership-checked thin wrapper around `WarmupService.pauseInbox` /
 * `WarmupService.resumeInbox`; it doesn't touch queues or do any other
 * work itself.
 */
@Injectable()
export class InboxControlService {
  private readonly logger = new Logger(InboxControlService.name);

  constructor(
    private readonly warmupService: WarmupService,
    private readonly bounces: BounceMonitorService,
  ) {}

  /** Ownership-checked bounce figures for one inbox. */
  async bounceStats(userId: string, inboxId: string) {
    const inbox = await this.assertOwnership(userId, inboxId);
    const stats = await this.bounces.stats(inboxId);
    return {
      ...stats,
      ratePct: Math.round(stats.rate * 1000) / 10,
      limitPct: stats.limit * 100,
      held: inbox.status === 'paused' && inbox.statusReason === BOUNCE_PAUSE_REASON,
    };
  }

  /**
   * Pause a single inbox. Idempotent (pauseInbox is idempotent). Returns
   * the updated status so the frontend can update its UI without a
   * separate round-trip.
   */
  async pauseOne(userId: string, inboxId: string): Promise<{ id: string; status: string }> {
    const inbox = await this.assertOwnership(userId, inboxId);
    await this.warmupService.pauseInbox(inboxId);
    this.logger.log(
      { userId, inboxId, from: inbox.status, to: 'paused' },
      'inbox paused by user request',
    );
    return { id: inboxId, status: 'paused' };
  }

  /**
   * Resume a single inbox. Idempotent — resume on an already-active inbox
   * changes nothing and queues no extra mail (see WarmupService.resumeInbox).
   * Returns the inbox's actual status, which stays e.g. 'error' when the
   * inbox can't be resumed by a click.
   */
  async resumeOne(userId: string, inboxId: string): Promise<{ id: string; status: string }> {
    const inbox = await this.assertOwnership(userId, inboxId);
    await this.assertPlanAllowsWarmup(userId);
    const status = (await this.warmupService.resumeInbox(inboxId)) ?? inbox.status;
    this.logger.log(
      { userId, inboxId, from: inbox.status, to: status },
      'inbox resume requested by user',
    );
    return { id: inboxId, status };
  }

  /**
   * Bulk pause. Processes each inboxId independently — a single bad id
   * (not owned, not found) doesn't abort the whole batch. Returns
   * `{ updated: [...], failed: [{ id, reason }] }` mirroring the
   * shape of `POST /inboxes/batch`.
   */
  async pauseMany(
    userId: string,
    inboxIds: string[],
  ): Promise<{
    updated: { id: string; status: string }[];
    failed: { id: string; reason: string }[];
  }> {
    return this.runBulk(userId, inboxIds, 'pause');
  }

  /**
   * Bulk resume. Same shape as pauseMany.
   */
  async resumeMany(
    userId: string,
    inboxIds: string[],
  ): Promise<{
    updated: { id: string; status: string }[];
    failed: { id: string; reason: string }[];
  }> {
    return this.runBulk(userId, inboxIds, 'resume');
  }

  private async runBulk(
    userId: string,
    inboxIds: string[],
    action: 'pause' | 'resume',
  ): Promise<{
    updated: { id: string; status: string }[];
    failed: { id: string; reason: string }[];
  }> {
    const updated: { id: string; status: string }[] = [];
    const failed: { id: string; reason: string }[] = [];

    // Dedupe to avoid accidentally pausing the same inbox twice in
    // one request (the second call would just no-op anyway, but
    // logging it twice is noise).
    const seen = new Set<string>();
    for (const rawId of inboxIds ?? []) {
      const id = String(rawId ?? '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      try {
        const result =
          action === 'pause' ? await this.pauseOne(userId, id) : await this.resumeOne(userId, id);
        updated.push(result);
      } catch (err: any) {
        // 404 (not found / not yours) — surface as a per-row failure
        // rather than aborting the batch. The frontend shows the
        // user which rows didn't apply.
        failed.push({ id, reason: err?.message ?? `${action} failed` });
      }
    }

    return { updated, failed };
  }

  /**
   * An expired trial or cancelled plan pauses every inbox; resuming has to
   * respect that rather than only checking who owns the inbox.
   */
  private async assertPlanAllowsWarmup(userId: string): Promise<void> {
    const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const user = rows[0];
    const plan = user?.plan ?? 'free';
    const trialExpired =
      plan === 'trial' && user?.trialEndsAt != null && user.trialEndsAt.getTime() < Date.now();
    if ((PLAN_LIMITS[plan]?.inboxes ?? 0) === 0 || trialExpired) {
      throw new ForbiddenException('Your current plan does not include warmup — upgrade to resume');
    }
  }

  private async assertOwnership(userId: string, inboxId: string) {
    const rows = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    const inbox = rows[0];
    if (!inbox || inbox.userId !== userId) {
      throw new NotFoundException();
    }
    return inbox;
  }
}
