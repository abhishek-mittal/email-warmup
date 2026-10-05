import { ScoringService } from './scoring.service';
import { RBL_ZONES } from '../monitor/rbl-list';

const NOW = new Date('2026-10-03T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const daysAgo = (d: number) => hoursAgo(d * 24);

const dnsRow = (overrides: Record<string, unknown> = {}) =>
  ({
    spfValid: true,
    dkimValid: true,
    dmarcValid: true,
    mxValid: true,
    rdnsValid: null,
    checkedAt: hoursAgo(1),
    ...overrides,
  }) as any;

const rbl = (statuses: Record<string, string>, overrides: Record<string, unknown> = {}) =>
  ({
    rblResults: { ...Object.fromEntries(RBL_ZONES.map((z) => [z.zone, 'unknown'])), ...statuses },
    checkedAt: hoursAgo(1),
    ...overrides,
  }) as any;

const placementRow = (overrides: Record<string, unknown> = {}) =>
  ({
    status: 'complete',
    seedCount: 10,
    observedCount: 10,
    placementScore: 90,
    completedAt: daysAgo(2),
    ...overrides,
  }) as any;

describe('ScoringService', () => {
  const service = new ScoringService();

  describe('DNS component', () => {
    it('all four records passing earns 30 of 30', () => {
      expect(service.dnsComponent(dnsRow(), NOW)).toEqual({ earned: 30, possible: 30 });
    });

    it('a failing record loses its points', () => {
      expect(service.dnsComponent(dnsRow({ spfValid: false }), NOW)).toEqual({
        earned: 20,
        possible: 30,
      });
      expect(service.dnsComponent(dnsRow({ dmarcValid: false, mxValid: false }), NOW)).toEqual({
        earned: 20,
        possible: 30,
      });
    });

    it('an unknown record is neither credited nor penalised', () => {
      // DKIM could not be checked (no selector): 20 points knowable, all earned.
      expect(service.dnsComponent(dnsRow({ dkimValid: null }), NOW)).toEqual({
        earned: 20,
        possible: 20,
      });
      expect(
        service.dnsComponent(
          dnsRow({ spfValid: null, dkimValid: null, dmarcValid: null, mxValid: null }),
          NOW,
        ),
      ).toEqual({ earned: 0, possible: 0 });
    });

    it('a reverse-DNS failure costs one point; unknown reverse DNS costs nothing', () => {
      expect(service.dnsComponent(dnsRow({ rdnsValid: false }), NOW)).toEqual({
        earned: 29,
        possible: 30,
      });
      expect(service.dnsComponent(dnsRow({ rdnsValid: null }), NOW).earned).toBe(30);
    });

    it('no check, or a stale one, is unknown', () => {
      expect(service.dnsComponent(null, NOW)).toEqual({ earned: 0, possible: 0 });
      expect(service.dnsComponent(dnsRow({ checkedAt: daysAgo(4) }), NOW)).toEqual({
        earned: 0,
        possible: 0,
      });
    });
  });

  describe('blocklist component', () => {
    it('no check is unknown — not "assume clean"', () => {
      expect(service.blacklistComponent(null, NOW)).toEqual({ earned: 0, possible: 0 });
    });

    it('nothing answered is unknown', () => {
      expect(service.blacklistComponent(rbl({}), NOW)).toEqual({ earned: 0, possible: 0 });
    });

    it('clean answers are credited only for the share of lists that answered', () => {
      const twoOfEight = rbl({ 'dbl.spamhaus.org': 'clean', 'multi.surbl.org': 'clean' });
      const result = service.blacklistComponent(twoOfEight, NOW);
      expect(result.possible).toBe(Math.round(30 * (2 / RBL_ZONES.length)));
      expect(result.earned).toBe(result.possible);
    });

    it('a Spamhaus listing earns nothing out of the full 30', () => {
      expect(service.blacklistComponent(rbl({ 'dbl.spamhaus.org': 'listed' }), NOW)).toEqual({
        earned: 0,
        possible: 30,
      });
    });

    it('other listings are tiered by count', () => {
      expect(service.blacklistComponent(rbl({ 'bl.spamcop.net': 'listed' }), NOW)).toEqual({
        earned: 18,
        possible: 30,
      });
      expect(
        service.blacklistComponent(
          rbl({ 'bl.spamcop.net': 'listed', 'multi.surbl.org': 'listed' }),
          NOW,
        ),
      ).toEqual({ earned: 12, possible: 30 });
    });

    it('a stale check is unknown', () => {
      const stale = rbl({ 'dbl.spamhaus.org': 'clean' }, { checkedAt: daysAgo(3) });
      expect(service.blacklistComponent(stale, NOW)).toEqual({ earned: 0, possible: 0 });
    });
  });

  describe('placement component', () => {
    it('no test is unknown — not a neutral 20', () => {
      expect(service.placementComponent(null, NOW)).toEqual({ earned: 0, possible: 0 });
    });

    it.each([
      ['queued', { status: 'queued', placementScore: null }],
      ['running', { status: 'running', placementScore: null }],
      ['failed', { status: 'failed', placementScore: null }],
      ['stale', { completedAt: daysAgo(40) }],
      ['with zero seeds', { seedCount: 0, observedCount: 0 }],
    ])('a %s test is unknown', (_name, overrides) => {
      expect(service.placementComponent(placementRow(overrides), NOW)).toEqual({
        earned: 0,
        possible: 0,
      });
    });

    it('a complete test earns its score out of 40', () => {
      expect(service.placementComponent(placementRow({ placementScore: 90 }), NOW)).toEqual({
        earned: 36,
        possible: 40,
      });
      expect(service.placementComponent(placementRow({ placementScore: 0 }), NOW)).toEqual({
        earned: 0,
        possible: 40,
      });
    });

    it('a partial test is judged in proportion to the seeds observed', () => {
      const half = placementRow({ status: 'partial', observedCount: 5, placementScore: 100 });
      expect(service.placementComponent(half, NOW)).toEqual({ earned: 20, possible: 20 });
    });

    it('clamps out-of-range inputs', () => {
      expect(service.placementComponent(placementRow({ placementScore: 250 }), NOW).earned).toBe(
        40,
      );
      expect(service.placementComponent(placementRow({ placementScore: -5 }), NOW).earned).toBe(0);
      expect(
        service.placementComponent(placementRow({ observedCount: 99, placementScore: 100 }), NOW),
      ).toEqual({ earned: 40, possible: 40 });
    });
  });

  describe('compose', () => {
    it('with nothing measured there is no score at all', () => {
      expect(service.compose(null, null, null, NOW)).toMatchObject({
        score: null,
        completeness: 0,
      });
    });

    it('a never-measured inbox no longer scores 50', () => {
      // Old rules: 0 (dns) + 30 (assumed clean) + 20 (neutral placement) = 50.
      const composed = service.compose(
        dnsRow({ spfValid: false, dkimValid: false, dmarcValid: false, mxValid: false }),
        null,
        null,
        NOW,
      );
      expect(composed).toMatchObject({ score: 0, completeness: 30 });
    });

    it('scores over what is known and reports how much that is', () => {
      const composed = service.compose(dnsRow(), null, null, NOW);
      expect(composed).toMatchObject({ score: 100, completeness: 30 });
    });

    it('everything measured and healthy is 100 at full completeness', () => {
      const allClean = rbl(Object.fromEntries(RBL_ZONES.map((z) => [z.zone, 'clean'])));
      const composed = service.compose(
        dnsRow(),
        allClean,
        placementRow({ placementScore: 100 }),
        NOW,
      );
      expect(composed).toMatchObject({ score: 100, completeness: 100 });
    });

    it('a listing pulls the score down across the whole 100', () => {
      const listed = rbl({ 'dbl.spamhaus.org': 'listed' });
      const composed = service.compose(
        dnsRow(),
        listed,
        placementRow({ placementScore: 100 }),
        NOW,
      );
      expect(composed).toMatchObject({ score: 70, completeness: 100 });
    });
  });
});
