import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { inboxes } from '../db/schema';
import { WarmupService } from '../warmup/warmup.service';

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

  constructor(private readonly warmupService: WarmupService) {}

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
   * just re-queues today's send volume (see WarmupService.resumeInbox).
   */
  async resumeOne(userId: string, inboxId: string): Promise<{ id: string; status: string }> {
    const inbox = await this.assertOwnership(userId, inboxId);
    await this.warmupService.resumeInbox(inboxId);
    this.logger.log(
      { userId, inboxId, from: inbox.status, to: 'active' },
      'inbox resumed by user request',
    );
    return { id: inboxId, status: 'active' };
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
        const result = action === 'pause'
          ? await this.pauseOne(userId, id)
          : await this.resumeOne(userId, id);
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

  private async assertOwnership(userId: string, inboxId: string) {
    const rows = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    const inbox = rows[0];
    if (!inbox || inbox.userId !== userId) {
      throw new NotFoundException();
    }
    return inbox;
  }
}