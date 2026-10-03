import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { ImapFlow } from 'imapflow';
import { db } from '../db';
import { seedInboxes } from '../db/schema';
import { decrypt, encrypt } from '../common/crypto';
import { MAIL_TIMEOUTS, imapTlsOptions } from '../inbox/provider-config';

export type SeedTestType = 'quick' | 'full';
export type SeedProvider = 'gmail' | 'outlook' | 'yahoo';
export type SeedRow = typeof seedInboxes.$inferSelect;

export interface SeedAddress {
  id: string;
  email: string;
  provider: string;
}

/**
 * Target seeds per provider for each test type: quick (10) for
 * demo/trial/starter, full (35) for growth and above.
 */
export const SEED_COUNTS_BY_TYPE: Record<SeedTestType, Record<SeedProvider, number>> = {
  quick: { gmail: 5, outlook: 3, yahoo: 2 },
  full: { gmail: 20, outlook: 10, yahoo: 5 },
};

/**
 * Fewest healthy seeds a test may run with. Below this the result would be
 * anecdote, so the test is refused before any quota is used.
 */
export const MIN_SEEDS_PER_TEST = 3;

const PROVIDERS: SeedProvider[] = ['gmail', 'outlook', 'yahoo'];

/** Columns safe to show an operator: never the stored credential. */
function toPublic(row: SeedRow) {
  return {
    id: row.id,
    email: row.email,
    provider: row.provider,
    imapHost: row.imapHost,
    imapPort: row.imapPort,
    imapUser: row.imapUser,
    active: row.active,
    healthy: row.active === true && row.quarantinedAt === null,
    lastCheckedAt: row.lastCheckedAt,
    lastOkAt: row.lastOkAt,
    lastError: row.lastError,
    quarantinedAt: row.quarantinedAt,
    createdAt: row.createdAt,
  };
}

/**
 * The platform's seed mailboxes for placement testing (MR-14): which ones a
 * test may use, how they are added, and whether they still work.
 *
 * A seed is usable when it is active and not quarantined. A seed that fails
 * to sign in is quarantined on the spot and brought back automatically when a
 * later health check succeeds. Seeds are added by an operator through the
 * internal API; credentials are verified before they are stored and are never
 * returned by any endpoint.
 */
@Injectable()
export class SeedListService {
  private readonly logger = new Logger(SeedListService.name);

  /** Healthy seeds for a test, up to the per-provider target. Never padded. */
  async getSeedAddresses(testType: SeedTestType): Promise<SeedAddress[]> {
    const targets = SEED_COUNTS_BY_TYPE[testType];

    const results = await Promise.all(
      PROVIDERS.map((provider) =>
        db
          .select()
          .from(seedInboxes)
          .where(
            and(
              eq(seedInboxes.active, true),
              isNull(seedInboxes.quarantinedAt),
              eq(seedInboxes.provider, provider),
            ),
          )
          // Least-recently verified first is not wanted here: prefer seeds
          // that were confirmed working most recently.
          .orderBy(asc(seedInboxes.createdAt))
          .limit(targets[provider]),
      ),
    );

    return results.flat().map((row) => ({ id: row.id, email: row.email, provider: row.provider }));
  }

  /** Healthy seed counts per provider against the targets for each test type. */
  async coverage() {
    const rows = await db.select().from(seedInboxes);
    const healthy = rows.filter((row) => row.active === true && row.quarantinedAt === null);
    const byProvider = Object.fromEntries(
      PROVIDERS.map((provider) => [
        provider,
        healthy.filter((r) => r.provider === provider).length,
      ]),
    );
    return {
      total: rows.length,
      healthy: healthy.length,
      quarantined: rows.filter((row) => row.quarantinedAt !== null).length,
      byProvider,
      targets: SEED_COUNTS_BY_TYPE,
      minimumPerTest: MIN_SEEDS_PER_TEST,
      testsAvailable: healthy.length >= MIN_SEEDS_PER_TEST,
    };
  }

  async list() {
    const rows = await db.select().from(seedInboxes).orderBy(asc(seedInboxes.createdAt));
    return rows.map(toPublic);
  }

  /**
   * Adds a seed after proving its credentials sign in. The password is
   * encrypted before it is written and is not echoed back.
   */
  async add(input: {
    email: string;
    provider: string;
    imapHost: string;
    imapPort: number;
    imapUser?: string;
    imapPass: string;
  }) {
    const provider = input.provider as SeedProvider;
    if (!PROVIDERS.includes(provider)) {
      throw new Error(`provider must be one of ${PROVIDERS.join(', ')}`);
    }
    const email = String(input.email ?? '')
      .trim()
      .toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('email is not valid');
    const imapPort = Number(input.imapPort);
    if (!Number.isInteger(imapPort) || imapPort < 1 || imapPort > 65535) {
      throw new Error('imapPort is not valid');
    }
    if (!input.imapHost || !input.imapPass) throw new Error('imapHost and imapPass are required');

    const existing = await db
      .select()
      .from(seedInboxes)
      .where(eq(seedInboxes.email, email))
      .limit(1);
    if (existing[0]) throw new Error('a seed with this email already exists');

    const candidate = {
      email,
      provider,
      imapHost: input.imapHost.trim(),
      imapPort,
      imapUser: (input.imapUser ?? email).trim(),
    };
    const problem = await this.trySignIn({ ...candidate, password: input.imapPass });
    if (problem) throw new Error(`could not sign in to the seed mailbox: ${problem}`);

    const now = new Date();
    const [row] = await db
      .insert(seedInboxes)
      .values({
        ...candidate,
        imapPass: encrypt(input.imapPass),
        active: true,
        lastCheckedAt: now,
        lastOkAt: now,
      })
      .returning();
    this.logger.log({ seedId: row.id, provider }, 'seed inbox added');
    return toPublic(row);
  }

  /** Takes a seed out of rotation. History that references it is kept. */
  async disable(id: string) {
    const [row] = await db
      .update(seedInboxes)
      .set({ active: false })
      .where(eq(seedInboxes.id, id))
      .returning();
    return row ? toPublic(row) : null;
  }

  /** Records a sign-in failure seen during a test and quarantines the seed. */
  async quarantine(id: string, reason: string): Promise<void> {
    await db
      .update(seedInboxes)
      .set({
        lastCheckedAt: new Date(),
        lastError: reason.slice(0, 300),
        quarantinedAt: new Date(),
      })
      .where(and(eq(seedInboxes.id, id), isNull(seedInboxes.quarantinedAt)));
    this.logger.warn({ seedId: id, reason }, 'seed inbox quarantined');
  }

  /** Daily at 04:30 UTC: verify every active seed still signs in. */
  @Cron('30 4 * * *', { utcOffset: 0 })
  async checkAll(): Promise<{ checked: number; healthy: number; quarantined: number }> {
    const rows = await db.select().from(seedInboxes).where(eq(seedInboxes.active, true));
    let healthy = 0;
    for (const row of rows) {
      if (await this.checkOne(row)) healthy += 1;
    }
    const summary = { checked: rows.length, healthy, quarantined: rows.length - healthy };
    if (summary.quarantined > 0) {
      this.logger.warn(summary, 'seed health check: some seeds are not usable');
    }
    return summary;
  }

  /** Verifies one seed; quarantines it on failure, restores it on success. */
  async checkOne(row: SeedRow): Promise<boolean> {
    let problem: string | null;
    try {
      problem = await this.trySignIn({
        imapHost: row.imapHost,
        imapPort: row.imapPort,
        imapUser: row.imapUser,
        password: decrypt(row.imapPass),
      });
    } catch (err) {
      problem = `stored credential could not be read: ${(err as Error)?.message}`;
    }
    const now = new Date();
    await db
      .update(seedInboxes)
      .set(
        problem
          ? {
              lastCheckedAt: now,
              lastError: problem.slice(0, 300),
              quarantinedAt: row.quarantinedAt ?? now,
            }
          : { lastCheckedAt: now, lastOkAt: now, lastError: null, quarantinedAt: null },
      )
      .where(eq(seedInboxes.id, row.id));
    return problem === null;
  }

  /** Null when sign-in and a mailbox listing succeed, otherwise a short reason. */
  private async trySignIn(seed: {
    imapHost: string;
    imapPort: number;
    imapUser: string;
    password: string;
  }): Promise<string | null> {
    const client = new ImapFlow({
      host: seed.imapHost,
      port: seed.imapPort,
      ...imapTlsOptions(seed.imapPort),
      connectionTimeout: MAIL_TIMEOUTS.connection,
      greetingTimeout: MAIL_TIMEOUTS.greeting,
      socketTimeout: MAIL_TIMEOUTS.socket,
      auth: { user: seed.imapUser, pass: seed.password },
      logger: false,
    } as ConstructorParameters<typeof ImapFlow>[0]);
    client.on('error', () => undefined);
    try {
      await client.connect();
      await client.list();
      return null;
    } catch (err) {
      return (err as Error)?.message || 'connection failed';
    } finally {
      await client.logout().catch(() => undefined);
    }
  }
}
