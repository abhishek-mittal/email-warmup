import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { seedInboxes } from '../db/schema';

export type SeedTestType = 'quick' | 'full';
export type SeedProvider = 'gmail' | 'outlook' | 'yahoo';

export type SeedAddress = typeof seedInboxes.$inferSelect;

/**
 * Per-provider seed counts by test type. See T014 context addendum #7:
 * quick (10 seeds) for trial/starter, full (35 seeds) for growth/agency/
 * enterprise, split 5/3/2 (quick) and 20/10/5 (full) across
 * gmail/outlook/yahoo respectively.
 */
const SEED_COUNTS_BY_TYPE: Record<SeedTestType, Record<SeedProvider, number>> = {
  quick: { gmail: 5, outlook: 3, yahoo: 2 },
  full: { gmail: 20, outlook: 10, yahoo: 5 },
};

const PROVIDERS: SeedProvider[] = ['gmail', 'outlook', 'yahoo'];

/**
 * Manages the platform-controlled seed inbox list used for placement
 * testing. There are no real seed accounts provisioned in this environment
 * (see addendum #2) — querying an empty `seed_inboxes` table is expected and
 * must not error; the caller (PlacementService) gets back however many rows
 * exist, never padded with fabricated data.
 */
@Injectable()
export class SeedListService {
  /**
   * Returns active seed addresses for the given test type, limited per
   * provider to the target count in SEED_COUNTS_BY_TYPE. If fewer active
   * rows of a given provider exist than the target, returns however many
   * exist for that provider rather than erroring or padding.
   */
  async getSeedAddresses(testType: SeedTestType): Promise<SeedAddress[]> {
    const targets = SEED_COUNTS_BY_TYPE[testType];

    const results = await Promise.all(
      PROVIDERS.map((provider) =>
        db
          .select()
          .from(seedInboxes)
          .where(and(eq(seedInboxes.active, true), eq(seedInboxes.provider, provider)))
          .limit(targets[provider]),
      ),
    );

    return results.flat();
  }
}
