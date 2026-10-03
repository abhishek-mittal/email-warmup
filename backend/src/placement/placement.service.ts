import { PLAN_LIMITS } from '../billing/billing.service';
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { and, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../db';
import { inboxes, placementResults, placementTests, users } from '../db/schema';
import {
  MIN_SEEDS_PER_TEST,
  SEED_COUNTS_BY_TYPE,
  SeedListService,
  SeedTestType,
} from './seed-list.service';
import { SmtpClientService } from '../inbox/smtp/smtp-client.service';
import { QueueService } from '../queue/queue.service';

/** Wait before the processor opens any IMAP connection — see addendum #8. */
const CHECK_DELAY_MS = 5 * 60_000;

const RANDOM_TRACKING_PHRASES = [
  'checking the mail',
  'just saying hello',
  'routine inbox check',
  'placement verification',
  'reaching out',
];

/** Plan -> { monthly test quota (null = unlimited), seed list type }. See service spec. */
const PLAN_QUOTA: Record<string, { perMonth: number | null; seedType: SeedTestType }> = {
  demo: { perMonth: PLAN_LIMITS.demo.placementTests, seedType: 'quick' },
  trial: { perMonth: 1, seedType: 'quick' },
  starter: { perMonth: 1, seedType: 'quick' },
  growth: { perMonth: 5, seedType: 'full' },
  agency: { perMonth: null, seedType: 'full' },
  enterprise: { perMonth: null, seedType: 'full' },
};

export interface RunTestResult {
  testId: string;
  estimatedReadyAt: string;
  /** Seeds this test was sent to. */
  seedCount: number;
  /** Seeds a full test of this type would use; fewer means a reduced sample. */
  targetSeedCount: number;
}

export interface PlacementTestJobPayload {
  testId: string;
  [key: string]: unknown;
}

/** Statuses that count against the monthly allowance: every test except one that failed. */
const FAILED = 'failed';

/**
 * Starts a placement test (MR-05).
 *
 * Order matters:
 *  1. refuse up front if there are too few healthy seeds — before any quota is used;
 *  2. reserve the quota and write the test with one result row per selected
 *     seed, atomically, so parallel requests cannot exceed the allowance and
 *     the set of seeds a result is measured against can never shrink;
 *  3. send one message to the seeds, noting any the mail server rejected;
 *  4. queue the observation job.
 *
 * What the result means: where ONE generic test message from this inbox
 * landed in the platform's seed mailboxes. It is an indicator of the
 * sender's standing, not a prediction for a particular campaign's content.
 */
@Injectable()
export class PlacementService {
  constructor(
    private readonly seedListService: SeedListService,
    private readonly smtpClientService: SmtpClientService,
    private readonly queueService: QueueService,
  ) {}

  /**
   * The one free placement test an inbox gets when it is otherwise ready to
   * graduate, so graduation never depends on the owner timing their monthly
   * allowance. Returns null when the inbox has already had it.
   */
  async runGraduationTest(inboxId: string, userId: string): Promise<RunTestResult | null> {
    const prior = await db
      .select({ id: placementTests.id })
      .from(placementTests)
      .where(
        and(
          eq(placementTests.inboxId, inboxId),
          eq(placementTests.purpose, 'graduation'),
          ne(placementTests.status, FAILED),
        ),
      )
      .limit(1);
    if (prior[0]) return null;
    return this.runTest(inboxId, userId, { purpose: 'graduation' });
  }

  async runTest(
    inboxId: string,
    userId: string,
    opts: { purpose?: 'manual' | 'graduation' } = {},
  ): Promise<RunTestResult> {
    const purpose = opts.purpose ?? 'manual';
    const inbox = await this.getInbox(inboxId);
    const plan = await this.getUserPlan(userId);
    // Unknown or free plans get no placement tests rather than a trial's.
    const quota = PLAN_QUOTA[plan] ?? (purpose === 'graduation' ? PLAN_QUOTA.starter : undefined);
    if (!quota) {
      throw new HttpException(
        'Placement tests are not included in your current plan',
        HttpStatus.FORBIDDEN,
      );
    }

    const seeds = await this.seedListService.getSeedAddresses(quota.seedType);
    if (seeds.length < MIN_SEEDS_PER_TEST) {
      throw new HttpException(
        'Placement testing is temporarily unavailable — too few seed mailboxes are healthy right now. Nothing was used from your allowance.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const testId = randomUUID();
    const messageId = `<${randomUUID()}@emailwarm.io>`;
    const subject = `[PT-${testId}] ${this.randomTrackingPhrase()}`;

    await db.transaction(async (tx) => {
      // One reservation at a time per account.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'placement:' + userId}))`);
      if (purpose === 'manual') await this.assertTestQuota(tx, userId, quota.perMonth);
      await tx.insert(placementTests).values({
        id: testId,
        inboxId,
        status: 'queued',
        purpose,
        messageId,
        seedCount: seeds.length,
        completedAt: null,
      });
      await tx.insert(placementResults).values(
        seeds.map((seed) => ({
          testId,
          seedInboxId: seed.id,
          seedEmail: seed.email,
          provider: seed.provider,
        })),
      );
    });

    let rejected: string[] = [];
    try {
      const transporter = await this.smtpClientService.getTransporter(inboxId);
      const result = await transporter.sendMail({
        from: inbox.email,
        bcc: seeds.map((seed) => seed.email),
        subject,
        text: 'This is an automated placement test email.',
        html: '<p>This is an automated placement test email.</p>',
        messageId,
      });
      rejected = ((result?.rejected ?? []) as Array<string | { address: string }>).map((entry) =>
        (typeof entry === 'string' ? entry : entry.address).toLowerCase(),
      );
    } catch (err) {
      // Nothing was measured: the test is failed and does not use the allowance.
      await db
        .update(placementTests)
        .set({
          status: FAILED,
          completedAt: new Date(),
          failureReason: 'The test message could not be sent from this inbox',
        })
        .where(eq(placementTests.id, testId));
      await db
        .update(placementResults)
        .set({ outcome: 'error', detail: 'test message was not sent' })
        .where(eq(placementResults.testId, testId));
      throw new HttpException(
        `The test message could not be sent from this inbox: ${(err as Error)?.message ?? 'send failed'}`.slice(
          0,
          300,
        ),
        HttpStatus.BAD_GATEWAY,
      );
    }

    if (rejected.length > 0) {
      await db
        .update(placementResults)
        .set({ outcome: 'smtp_rejected', detail: 'the sending server refused this recipient' })
        .where(
          and(
            eq(placementResults.testId, testId),
            inArray(sql`lower(${placementResults.seedEmail})`, rejected),
          ),
        );
    }

    await this.queueService.add('placement-test', { testId } satisfies PlacementTestJobPayload, {
      delay: CHECK_DELAY_MS,
      jobId: `placement-${testId}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
    });

    const targets = SEED_COUNTS_BY_TYPE[quota.seedType];
    return {
      testId,
      estimatedReadyAt: new Date(Date.now() + CHECK_DELAY_MS).toISOString(),
      seedCount: seeds.length,
      targetSeedCount: Object.values(targets).reduce((sum, n) => sum + n, 0),
    };
  }

  private async getInbox(inboxId: string): Promise<typeof inboxes.$inferSelect> {
    const rows = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    const inbox = rows[0];
    if (!inbox) {
      throw new Error(`Inbox ${inboxId} not found`);
    }
    return inbox;
  }

  private async getUserPlan(userId: string): Promise<string> {
    const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    return rows[0]?.plan ?? 'free';
  }

  /**
   * Counts this calendar month's tests across the user's inboxes, by creation
   * time, ignoring tests that failed to produce a result. Runs inside the
   * reservation transaction. Throws 429 when the allowance is used up.
   */
  private async assertTestQuota(
    tx: Parameters<Parameters<(typeof db)['transaction']>[0]>[0],
    userId: string,
    perMonth: number | null,
  ): Promise<void> {
    if (perMonth === null) return;

    const userInboxRows = await tx.select().from(inboxes).where(eq(inboxes.userId, userId));
    const inboxIds = userInboxRows.map((row) => row.id);
    if (inboxIds.length === 0) return;

    const rows = await tx
      .select({ id: placementTests.id })
      .from(placementTests)
      .where(
        and(
          inArray(placementTests.inboxId, inboxIds),
          gte(placementTests.createdAt, this.startOfCurrentMonth()),
          ne(placementTests.status, FAILED),
          eq(placementTests.purpose, 'manual'),
        ),
      );

    if (rows.length >= perMonth) {
      throw new HttpException(
        'Monthly placement test quota exceeded',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private startOfCurrentMonth(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }

  private randomTrackingPhrase(): string {
    const idx = Math.floor(Math.random() * RANDOM_TRACKING_PHRASES.length);
    return RANDOM_TRACKING_PHRASES[idx];
  }
}
