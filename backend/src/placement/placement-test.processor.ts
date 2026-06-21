import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ImapFlow } from 'imapflow';
import { inArray } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { placementTests, seedInboxes } from '../db/schema';
import { decrypt } from '../common/crypto';
import { PlacementAnalyzerService, Placement } from './placement-analyzer.service';
import { QueueService } from '../queue/queue.service';
import { PlacementTestJobPayload } from './placement.service';

/**
 * Overall backstop timeout for the whole seed-checking batch — a safeguard
 * against the IMAP connection pool itself hanging, not a per-seed timeout
 * (Promise.allSettled already isolates one slow/erroring seed from blocking
 * the others). See T014 context addendum #9.
 */
const OVERALL_TIMEOUT_MS = 15 * 60_000;

type SeedRow = typeof seedInboxes.$inferSelect;

@Injectable()
@Processor('placement-test')
export class PlacementTestProcessor extends WorkerHost {
  private readonly logger = new Logger(PlacementTestProcessor.name);

  constructor(
    private readonly placementAnalyzerService: PlacementAnalyzerService,
    private readonly queueService: QueueService,
  ) {
    super();
  }

  async process(job: Job<PlacementTestJobPayload>): Promise<void> {
    const { testId, inboxId, messageId, seedIds } = job.data;

    const seedRows = seedIds.length > 0 ? await this.loadSeedRows(seedIds.map((s) => s.id)) : [];
    const seedById = new Map(seedRows.map((row) => [row.id, row]));

    const checks = seedIds
      .map((seedRef) => seedById.get(seedRef.id))
      .filter((row): row is SeedRow => Boolean(row))
      .map((row) => this.checkSeed(row, messageId));

    const settled = await this.withOverallTimeout(checks);

    const placements: Placement[] = settled.map((result) =>
      result.status === 'fulfilled' ? result.value : 'missing',
    );

    const counts = this.aggregate(placements);
    const placementScore = this.computePlacementScore(counts);

    await db
      .update(placementTests)
      .set({
        primaryCount: counts.primary,
        promotionsCount: counts.promotions,
        spamCount: counts.spam,
        missingCount: counts.missing,
        primaryPct: this.pct(counts.primary, placements.length),
        promotionsPct: this.pct(counts.promotions, placements.length),
        spamPct: this.pct(counts.spam, placements.length),
        placementScore,
        completedAt: new Date(),
      })
      .where(eq(placementTests.id, testId));

    await this.queueService.add('score-compute', { inboxId });

    this.logger.log(
      `Completed placement test ${testId} for inbox ${inboxId}: primary=${counts.primary} promotions=${counts.promotions} spam=${counts.spam} missing=${counts.missing} score=${placementScore}`,
    );
  }

  /** Resolves seed credentials from the DB at processing time — never trusts the job payload (non-negotiable). */
  private async loadSeedRows(seedIds: string[]): Promise<SeedRow[]> {
    return db.select().from(seedInboxes).where(inArray(seedInboxes.id, seedIds));
  }

  private async checkSeed(seed: SeedRow, messageId: string): Promise<Placement> {
    const client = new ImapFlow({
      host: seed.imapHost,
      port: seed.imapPort,
      secure: true,
      auth: {
        user: seed.imapUser,
        pass: decrypt(seed.imapPass),
      },
      logger: false,
    });

    try {
      await client.connect();
      if (seed.provider === 'gmail') {
        return await this.placementAnalyzerService.analyzeGmailPlacement(client, messageId);
      }
      return await this.placementAnalyzerService.analyzeFolderPlacement(
        client,
        messageId,
        seed.provider as 'outlook' | 'yahoo',
      );
    } finally {
      try {
        await client.logout();
      } catch {
        // Best-effort cleanup only — a failed logout must never fail the check itself.
      }
    }
  }

  /**
   * Races the whole seed-checking batch against a 15-minute backstop timer.
   * Promise.allSettled already isolates a single failing/slow seed; this
   * timeout guards against the batch as a whole hanging (e.g. a wedged
   * connection pool). On timeout, any seed without a settled result is
   * treated as 'missing' (see addendum #9 — there is no separate
   * "incomplete" status).
   */
  private async withOverallTimeout(
    checks: Promise<Placement>[],
  ): Promise<PromiseSettledResult<Placement>[]> {
    if (checks.length === 0) return [];

    let timer: NodeJS.Timeout;
    const timeoutPromise = new Promise<PromiseSettledResult<Placement>[]>((resolve) => {
      timer = setTimeout(
        () =>
          resolve(
            checks.map(
              () =>
                ({
                  status: 'rejected',
                  reason: 'overall-timeout',
                }) as PromiseSettledResult<Placement>,
            ),
          ),
        OVERALL_TIMEOUT_MS,
      );
      // Never let this backstop timer keep the process alive on its own —
      // it only matters while real work is outstanding.
      timer.unref?.();
    });

    try {
      return await Promise.race([Promise.allSettled(checks), timeoutPromise]);
    } finally {
      clearTimeout(timer!);
    }
  }

  private aggregate(placements: Placement[]): {
    primary: number;
    promotions: number;
    spam: number;
    missing: number;
  } {
    return placements.reduce(
      (acc, placement) => {
        acc[placement] += 1;
        return acc;
      },
      { primary: 0, promotions: 0, spam: 0, missing: 0 },
    );
  }

  /** placementScore = round((primaryCount*1.0 + promotionsCount*0.5) / seedCount * 100) — addendum #11. */
  private computePlacementScore(counts: {
    primary: number;
    promotions: number;
    spam: number;
    missing: number;
  }): number {
    const seedCount = counts.primary + counts.promotions + counts.spam + counts.missing;
    if (seedCount === 0) return 0;
    const weighted = counts.primary * 1.0 + counts.promotions * 0.5;
    return Math.round((weighted / seedCount) * 100);
  }

  private pct(count: number, total: number): number {
    if (total === 0) return 0;
    return Math.round((count / total) * 100);
  }
}
