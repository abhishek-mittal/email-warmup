import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ImapFlow } from 'imapflow';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { placementResults, placementTests, seedInboxes } from '../db/schema';
import { decrypt } from '../common/crypto';
import { MAIL_TIMEOUTS, imapTlsOptions } from '../inbox/provider-config';
import { PlacementAnalyzerService } from './placement-analyzer.service';
import { QueueService } from '../queue/queue.service';
import { PlacementTestJobPayload } from './placement.service';
import { MIN_SEEDS_PER_TEST, SeedListService } from './seed-list.service';

/** Longest one seed may take before it is recorded as timed out. */
export const SEED_TIMEOUT_MS = 90_000;
/** Above this share of observed seeds in spam, a diagnosis is run automatically. */
export const SPAM_DIAGNOSTICS_THRESHOLD_PCT = 20;
/** Seeds checked at once. */
const SEED_CONCURRENCY = 5;

/** Outcomes that are real observations of where the message is (or isn't). */
export const OBSERVATION_OUTCOMES = ['primary', 'promotions', 'other_inbox', 'spam', 'not_found'];

type ResultRow = typeof placementResults.$inferSelect;

export interface PlacementSummary {
  status: 'complete' | 'partial' | 'failed';
  seedCount: number;
  observedCount: number;
  errorCount: number;
  primaryCount: number;
  promotionsCount: number;
  otherInboxCount: number;
  spamCount: number;
  missingCount: number;
  primaryPct: number | null;
  promotionsPct: number | null;
  spamPct: number | null;
  placementScore: number | null;
  failureReason: string | null;
}

/**
 * Turns per-seed results into a test result.
 *
 * Percentages are taken over seeds that were actually observed. A seed that
 * could not be checked (sign-in failure, timeout, removed, rejected at send)
 * is an operational failure of the test, not evidence about the sender, so it
 * is counted separately and never as spam or missing. With too few
 * observations the test is `failed` and reports no percentages at all, rather
 * than a conclusive-looking zero.
 */
export function summarize(results: Pick<ResultRow, 'outcome'>[]): PlacementSummary {
  const count = (outcome: string) => results.filter((r) => r.outcome === outcome).length;
  const primary = count('primary');
  const promotions = count('promotions');
  const other = count('other_inbox');
  const spam = count('spam');
  const notFound = count('not_found');
  const observed = primary + promotions + other + spam + notFound;
  const seedCount = results.length;
  const errorCount = seedCount - observed;

  const base = {
    seedCount,
    observedCount: observed,
    errorCount,
    primaryCount: primary,
    promotionsCount: promotions,
    otherInboxCount: other,
    spamCount: spam,
    missingCount: notFound,
  };

  if (observed < Math.min(MIN_SEEDS_PER_TEST, seedCount) || observed === 0) {
    return {
      ...base,
      status: 'failed',
      primaryPct: null,
      promotionsPct: null,
      spamPct: null,
      placementScore: null,
      failureReason: `Only ${observed} of ${seedCount} seed mailboxes could be checked, which is too few for a result`,
    };
  }

  const pct = (n: number) => Math.round((n / observed) * 100);
  return {
    ...base,
    status: errorCount > 0 ? 'partial' : 'complete',
    primaryPct: pct(primary),
    promotionsPct: pct(promotions),
    spamPct: pct(spam),
    // Primary counts in full; Promotions and other inbox categories half;
    // spam and not-found nothing.
    placementScore: Math.round(((primary + 0.5 * (promotions + other)) / observed) * 100),
    failureReason: null,
  };
}

@Injectable()
@Processor('placement-test')
export class PlacementTestProcessor extends WorkerHost {
  private readonly logger = new Logger(PlacementTestProcessor.name);

  constructor(
    private readonly placementAnalyzerService: PlacementAnalyzerService,
    private readonly queueService: QueueService,
    private readonly seedListService: SeedListService,
  ) {
    super();
  }

  async process(job: Job<PlacementTestJobPayload>): Promise<void> {
    const { testId } = job.data;

    const tests = await db
      .select()
      .from(placementTests)
      .where(eq(placementTests.id, testId))
      .limit(1);
    const test = tests[0];
    if (!test || !test.messageId) {
      this.logger.warn(`Placement test ${testId} not found — nothing to do`);
      return;
    }
    // Already finished (a redelivered job): results stand.
    if (!['queued', 'running'].includes(test.status)) return;

    await db
      .update(placementTests)
      .set({ status: 'running', startedAt: test.startedAt ?? new Date() })
      .where(eq(placementTests.id, testId));

    // Only seeds without a recorded outcome are checked, so a retry resumes
    // instead of repeating, and observations already saved are never lost.
    const pending = await db
      .select()
      .from(placementResults)
      .where(and(eq(placementResults.testId, testId), eq(placementResults.outcome, 'pending')));

    const queue = [...pending];
    const workers = Array.from({ length: Math.min(SEED_CONCURRENCY, queue.length) }, async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        const { outcome, detail } = await this.checkSeed(row, test.messageId!);
        await db
          .update(placementResults)
          .set({ outcome, detail, observedAt: new Date() })
          .where(eq(placementResults.id, row.id));
      }
    });
    await Promise.all(workers);

    const results = await db
      .select()
      .from(placementResults)
      .where(eq(placementResults.testId, testId));
    const summary = summarize(results);

    await db
      .update(placementTests)
      .set({
        status: summary.status,
        observedCount: summary.observedCount,
        errorCount: summary.errorCount,
        primaryCount: summary.primaryCount,
        promotionsCount: summary.promotionsCount,
        otherInboxCount: summary.otherInboxCount,
        spamCount: summary.spamCount,
        missingCount: summary.missingCount,
        primaryPct: summary.primaryPct,
        promotionsPct: summary.promotionsPct,
        spamPct: summary.spamPct,
        placementScore: summary.placementScore,
        failureReason: summary.failureReason,
        completedAt: new Date(),
      })
      .where(eq(placementTests.id, testId));

    // A failed test says nothing about the sender, so it must not move the score.
    if (summary.status !== 'failed') {
      await this.queueService.add('score-compute', { inboxId: test.inboxId });

      // A high spam share from a test that produced a result triggers a
      // diagnosis, once per test.
      if ((summary.spamPct ?? 0) > SPAM_DIAGNOSTICS_THRESHOLD_PCT) {
        await this.queueService.add(
          'diagnostics',
          { inboxId: test.inboxId, triggerType: 'auto_spam', placementTestId: testId },
          { jobId: `diagnostics-spam-${testId}` },
        );
      }
    }

    this.logger.log(
      `Placement test ${testId} ${summary.status}: observed=${summary.observedCount}/${summary.seedCount} primary=${summary.primaryCount} promotions=${summary.promotionsCount} other=${summary.otherInboxCount} spam=${summary.spamCount} notFound=${summary.missingCount} errors=${summary.errorCount}`,
    );
  }

  /**
   * Looks for the message in one seed mailbox. Never throws: every way this
   * can go wrong becomes a named non-observation outcome.
   */
  private async checkSeed(
    row: ResultRow,
    messageId: string,
  ): Promise<{ outcome: string; detail: string | null }> {
    const seeds = await db
      .select()
      .from(seedInboxes)
      .where(inArray(seedInboxes.id, [row.seedInboxId]));
    const seed = seeds[0];
    if (!seed || seed.active !== true) {
      return { outcome: 'seed_unavailable', detail: 'seed mailbox was removed or disabled' };
    }

    let client: ImapFlow | null = null;
    let timer: NodeJS.Timeout | undefined;
    try {
      const work = (async () => {
        client = new ImapFlow({
          host: seed.imapHost,
          port: seed.imapPort,
          ...imapTlsOptions(seed.imapPort),
          connectionTimeout: MAIL_TIMEOUTS.connection,
          greetingTimeout: MAIL_TIMEOUTS.greeting,
          socketTimeout: MAIL_TIMEOUTS.socket,
          auth: { user: seed.imapUser, pass: decrypt(seed.imapPass) },
          logger: false,
        } as ConstructorParameters<typeof ImapFlow>[0]);
        client.on('error', () => undefined);
        await client.connect();
        return this.placementAnalyzerService.observe(client, messageId, seed.provider);
      })();
      const timeout = new Promise<'__timeout__'>((resolve) => {
        timer = setTimeout(() => resolve('__timeout__'), SEED_TIMEOUT_MS);
        timer.unref?.();
      });

      const outcome = await Promise.race([work, timeout]);
      if (outcome === '__timeout__') {
        // Let the abandoned attempt fail quietly once its connection is closed.
        work.catch(() => undefined);
        return { outcome: 'timeout', detail: 'seed mailbox did not respond in time' };
      }
      return { outcome, detail: null };
    } catch (err) {
      const e = err as { authenticationFailed?: boolean; message?: string };
      if (e?.authenticationFailed) {
        await this.seedListService.quarantine(seed.id, e.message ?? 'authentication failed');
        return { outcome: 'auth_error', detail: 'could not sign in to the seed mailbox' };
      }
      return { outcome: 'error', detail: (e?.message ?? 'seed check failed').slice(0, 200) };
    } finally {
      if (timer) clearTimeout(timer);
      const open = client as ImapFlow | null;
      if (open) {
        try {
          open.close();
        } catch {
          // Best-effort cleanup only.
        }
      }
    }
  }
}
