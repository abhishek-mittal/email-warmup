import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { and, eq, gte, inArray } from 'drizzle-orm';
import { db } from '../db';
import { inboxes, placementTests, users } from '../db/schema';
import { SeedListService, SeedTestType } from './seed-list.service';
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
  trial: { perMonth: 1, seedType: 'quick' },
  starter: { perMonth: 1, seedType: 'quick' },
  growth: { perMonth: 5, seedType: 'full' },
  agency: { perMonth: null, seedType: 'full' },
  enterprise: { perMonth: null, seedType: 'full' },
};

export interface RunTestResult {
  testId: string;
  estimatedReadyAt: string;
}

export interface PlacementTestJobPayload {
  testId: string;
  inboxId: string;
  messageId: string;
  seedIds: Array<{ id: string; provider: string }>;
  [key: string]: unknown;
}

/**
 * Triggers a placement test: enforces the plan quota, selects the seed
 * list, sends one BCC email to all seeds, inserts a "pending" placement_tests
 * row (status derived from data, not stored — addendum #3), and enqueues the
 * placement-test job with a BullMQ delay (addendum #8).
 */
@Injectable()
export class PlacementService {
  constructor(
    private readonly seedListService: SeedListService,
    private readonly smtpClientService: SmtpClientService,
    private readonly queueService: QueueService,
  ) {}

  async runTest(inboxId: string, userId: string): Promise<RunTestResult> {
    const inbox = await this.getInbox(inboxId);
    const plan = await this.getUserPlan(userId);
    const quota = PLAN_QUOTA[plan] ?? PLAN_QUOTA.trial;

    await this.assertTestQuota(userId, quota.perMonth);

    const seeds = await this.seedListService.getSeedAddresses(quota.seedType);

    const testId = randomUUID();
    const messageId = `<${randomUUID()}@emailwarm.io>`;
    const subject = `[PT-${testId}] ${this.randomTrackingPhrase()}`;

    const transporter = await this.smtpClientService.getTransporter(inboxId);
    await transporter.sendMail({
      from: inbox.email,
      bcc: seeds.map((seed) => seed.email),
      subject,
      text: 'This is an automated placement test email.',
      html: '<p>This is an automated placement test email.</p>',
      headers: {
        'Message-ID': messageId,
      },
    });

    await db.insert(placementTests).values({
      id: testId,
      inboxId,
      seedCount: seeds.length,
      primaryCount: null,
      promotionsCount: null,
      spamCount: null,
      missingCount: null,
      primaryPct: null,
      promotionsPct: null,
      spamPct: null,
      placementScore: null,
    });

    const payload: PlacementTestJobPayload = {
      testId,
      inboxId,
      messageId,
      seedIds: seeds.map((seed) => ({ id: seed.id, provider: seed.provider })),
    };

    await this.queueService.add('placement-test', payload, { delay: CHECK_DELAY_MS });

    return {
      testId,
      estimatedReadyAt: new Date(Date.now() + CHECK_DELAY_MS).toISOString(),
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
    return rows[0]?.plan ?? 'trial';
  }

  /**
   * Counts placement_tests rows requested this calendar month for the user's
   * inboxes, using completedAt as the creation-time proxy (addendum #4/#6 —
   * the column holds a placeholder defaultNow() at insert time until the
   * processor overwrites it with the true completion time). Throws 429 via
   * HttpException (not ForbiddenException) per addendum #6.
   */
  private async assertTestQuota(userId: string, perMonth: number | null): Promise<void> {
    if (perMonth === null) return;

    const userInboxRows = await db.select().from(inboxes).where(eq(inboxes.userId, userId));
    const inboxIds = userInboxRows.map((row) => row.id);
    if (inboxIds.length === 0) return;

    const monthStart = this.startOfCurrentMonth();
    const rows = await db
      .select()
      .from(placementTests)
      .where(
        and(inArray(placementTests.inboxId, inboxIds), gte(placementTests.completedAt, monthStart)),
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
