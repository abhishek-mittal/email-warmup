import { Injectable } from '@nestjs/common';
import { dnsChecks, blacklistChecks, placementTests } from '../db/schema';

type DnsCheckRow = typeof dnsChecks.$inferSelect;
type BlacklistCheckRow = typeof blacklistChecks.$inferSelect;
type PlacementTestRow = typeof placementTests.$inferSelect;

/**
 * Pure score-component functions. No DB access here — ScoreComputeProcessor
 * loads the rows and passes them in. See T013 context addendum #1-#5 for the
 * exact resolutions against the actual (boolean-only) DB schema, which differs
 * from the skill file's string-enum pseudocode.
 */
@Injectable()
export class ScoringService {
  /**
   * DNS component (0-30). Returns 0 when there is no DNS check at all (never
   * compute score without at least a DNS check result — addendum #2).
   */
  computeDnsScore(dns: DnsCheckRow | null): number {
    if (!dns) return 0;

    let score = 30;
    if (!dns.spfValid) score -= 10;
    if (!dns.dkimValid) score -= 10;
    if (!dns.dmarcValid) score -= 5;
    if (!dns.mxValid) score -= 5;
    // rDNS null means "unknown" (no sendingIp), not a failure — only the
    // explicit false case is penalized. See addendum #3.
    if (dns.rdnsValid === false) score -= 1;

    return Math.max(0, score);
  }

  /**
   * Blacklist component (0-30). No check yet defaults to "assume clean" (30) —
   * see addendum #4. Spamhaus listings are an immediate 0; otherwise tiered by
   * number of RBLs reporting the domain as listed (derived from rblResults,
   * since there is no separate `listed` column in the schema).
   */
  computeBlacklistScore(blacklist: BlacklistCheckRow | null): number {
    if (!blacklist) return 30;
    if (!blacklist.isClean) {
      const listed: string[] = Object.entries(
        (blacklist.rblResults as Record<string, string>) ?? {},
      )
        .filter(([, status]) => status === 'listed')
        .map(([rbl]) => rbl);

      if (listed.some((rbl) => rbl.includes('spamhaus'))) return 0;
      if (listed.length >= 3) return 5;
      if (listed.length === 2) return 12;
      if (listed.length === 1) return 18;
    }
    return 30;
  }

  /**
   * Placement component (0-40). No test yet defaults to a neutral 20 (50% of
   * max) — see addendum #5. `seedCount` is the denominator (no separate
   * "total" field on placement_tests).
   */
  computePlacementScore(placement: PlacementTestRow | null): number {
    if (!placement) return 20;

    const weighted = placement.primaryCount! * 1.0 + placement.promotionsCount! * 0.5;
    const ratio = placement.seedCount! > 0 ? weighted / placement.seedCount! : 0;
    return Math.round(ratio * 40);
  }
}
