import { Injectable } from '@nestjs/common';
import { dnsChecks, blacklistChecks, placementTests } from '../db/schema';
import { rblCoverage } from '../monitor/blacklist.service';

type DnsCheckRow = typeof dnsChecks.$inferSelect;
type BlacklistCheckRow = typeof blacklistChecks.$inferSelect;
type PlacementTestRow = typeof placementTests.$inferSelect;

/** Bumped whenever the rules below change, so stored scores say which rules produced them. */
export const SCORE_RULE_VERSION = 2;

/** Maximum points per component. They sum to 100. */
export const COMPONENT_WEIGHTS = { dns: 30, blacklist: 30, placement: 40 } as const;

/** A measurement older than this no longer counts as known. */
export const FRESHNESS_MS = {
  dns: 3 * 24 * 60 * 60 * 1000,
  blacklist: 2 * 24 * 60 * 60 * 1000,
  placement: 35 * 24 * 60 * 60 * 1000,
} as const;

/**
 * One component of the score.
 *  - `possible` is how many points could be judged from real, recent data.
 *    Zero means nothing is known about this component.
 *  - `earned` is how many of those points the inbox got.
 * Unknown is never scored as healthy and never as a failure: it simply
 * removes points from both sides.
 */
export interface ComponentScore {
  earned: number;
  possible: number;
}

export interface ComposedScore {
  /** 0-100 over what could be measured, or null when nothing could. */
  score: number | null;
  /** Share of the 100 points that rest on real, recent measurements. */
  completeness: number;
  dns: ComponentScore;
  blacklist: ComponentScore;
  placement: ComponentScore;
}

const UNKNOWN: ComponentScore = { earned: 0, possible: 0 };

function isFresh(at: Date | null | undefined, maxAgeMs: number, now: Date): boolean {
  return Boolean(at) && now.getTime() - at!.getTime() <= maxAgeMs;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Pure score rules (MR-16). No DB access — ScoreComputeProcessor loads the
 * latest rows and passes them in.
 *
 * This is an internal health indicator built from DNS records, blocklist
 * lookups and seed placement tests. It is not a mail provider's reputation
 * figure and does not predict or guarantee future deliverability.
 */
@Injectable()
export class ScoringService {
  /**
   * DNS (30): SPF 10, DKIM 10, DMARC 5, MX 5. A field that is null (lookup
   * did not complete, or no selector/IP to check) is not judged.
   */
  dnsComponent(dns: DnsCheckRow | null, now: Date = new Date()): ComponentScore {
    if (!dns || !isFresh(dns.checkedAt, FRESHNESS_MS.dns, now)) return UNKNOWN;

    let earned = 0;
    let possible = 0;
    for (const [value, points] of [
      [dns.spfValid, 10],
      [dns.dkimValid, 10],
      [dns.dmarcValid, 5],
      [dns.mxValid, 5],
    ] as const) {
      if (value === null || value === undefined) continue;
      possible += points;
      if (value === true) earned += points;
    }
    // A reverse-DNS failure costs a point; unknown or passing rDNS changes nothing.
    if (dns.rdnsValid === false) earned = Math.max(0, earned - 1);
    return { earned, possible };
  }

  /**
   * Blocklists (30). Judged only over the lists that actually answered: if
   * two of five answered and both were clean, 12 of 30 points are known and
   * all 12 are earned. Any Spamhaus listing earns nothing; other listings
   * are tiered by count.
   */
  blacklistComponent(blacklist: BlacklistCheckRow | null, now: Date = new Date()): ComponentScore {
    if (!blacklist || !isFresh(blacklist.checkedAt, FRESHNESS_MS.blacklist, now)) return UNKNOWN;

    const results = (blacklist.rblResults as Record<string, string>) ?? {};
    const coverage = rblCoverage(results);
    const total = Object.keys(results).length;
    if (coverage.checked === 0 || total === 0) return UNKNOWN;

    const listed = Object.entries(results)
      .filter(([, status]) => status === 'listed')
      .map(([zone]) => zone);
    const max = COMPONENT_WEIGHTS.blacklist;

    if (listed.length > 0) {
      // A listing is decisive regardless of how many other lists answered.
      if (listed.some((zone) => zone.includes('spamhaus'))) return { earned: 0, possible: max };
      if (listed.length >= 3) return { earned: 5, possible: max };
      if (listed.length === 2) return { earned: 12, possible: max };
      return { earned: 18, possible: max };
    }

    const possible = Math.round(max * (coverage.checked / total));
    return { earned: possible, possible };
  }

  /**
   * Placement (40). Only a test that produced a result counts; a pending or
   * failed test is unknown. A partial test is judged in proportion to how
   * many of its seeds were observed.
   */
  placementComponent(placement: PlacementTestRow | null, now: Date = new Date()): ComponentScore {
    if (!placement || !['complete', 'partial'].includes(placement.status)) return UNKNOWN;
    if (placement.placementScore === null || placement.placementScore === undefined) return UNKNOWN;
    if (!isFresh(placement.completedAt, FRESHNESS_MS.placement, now)) return UNKNOWN;

    const seedCount = placement.seedCount ?? 0;
    const observed = placement.observedCount ?? seedCount;
    if (seedCount <= 0 || observed <= 0) return UNKNOWN;

    const coverage = clamp(observed / seedCount, 0, 1);
    const possible = Math.round(COMPONENT_WEIGHTS.placement * coverage);
    const earned = Math.round(possible * (clamp(placement.placementScore, 0, 100) / 100));
    return { earned, possible };
  }

  compose(
    dns: DnsCheckRow | null,
    blacklist: BlacklistCheckRow | null,
    placement: PlacementTestRow | null,
    now: Date = new Date(),
  ): ComposedScore {
    const d = this.dnsComponent(dns, now);
    const b = this.blacklistComponent(blacklist, now);
    const p = this.placementComponent(placement, now);
    const possible = d.possible + b.possible + p.possible;
    const earned = d.earned + b.earned + p.earned;
    return {
      score: possible > 0 ? clamp(Math.round((earned / possible) * 100), 0, 100) : null,
      completeness: clamp(possible, 0, 100),
      dns: d,
      blacklist: b,
      placement: p,
    };
  }
}
