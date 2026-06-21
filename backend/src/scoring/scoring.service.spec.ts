import { Test, TestingModule } from '@nestjs/testing';
import { ScoringService } from './scoring.service';

describe('ScoringService', () => {
  let service: ScoringService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ScoringService],
    }).compile();
    service = module.get<ScoringService>(ScoringService);
  });

  describe('computeDnsScore', () => {
    it('returns 0 when there is no DNS check at all', () => {
      expect(service.computeDnsScore(null)).toBe(0);
    });

    it('returns 30 for a fully passing DNS check', () => {
      expect(
        service.computeDnsScore({
          spfValid: true,
          dkimValid: true,
          dmarcValid: true,
          mxValid: true,
          rdnsValid: true,
        } as any),
      ).toBe(30);
    });

    it('returns 10 for SPF_MISSING + DKIM_MISSING (30 - 10 - 10)', () => {
      expect(
        service.computeDnsScore({
          spfValid: false,
          dkimValid: false,
          dmarcValid: true,
          mxValid: true,
          rdnsValid: true,
        } as any),
      ).toBe(10);
    });

    it('applies -5 for dmarcValid false', () => {
      expect(
        service.computeDnsScore({
          spfValid: true,
          dkimValid: true,
          dmarcValid: false,
          mxValid: true,
          rdnsValid: true,
        } as any),
      ).toBe(25);
    });

    it('applies -5 for mxValid false', () => {
      expect(
        service.computeDnsScore({
          spfValid: true,
          dkimValid: true,
          dmarcValid: true,
          mxValid: false,
          rdnsValid: true,
        } as any),
      ).toBe(25);
    });

    it('applies -1 only when rdnsValid is exactly false', () => {
      expect(
        service.computeDnsScore({
          spfValid: true,
          dkimValid: true,
          dmarcValid: true,
          mxValid: true,
          rdnsValid: false,
        } as any),
      ).toBe(29);
    });

    it('does NOT penalize rdnsValid === null (unknown, not a failure)', () => {
      expect(
        service.computeDnsScore({
          spfValid: true,
          dkimValid: true,
          dmarcValid: true,
          mxValid: true,
          rdnsValid: null,
        } as any),
      ).toBe(30);
    });

    it('clamps at 0 when every field fails', () => {
      expect(
        service.computeDnsScore({
          spfValid: false,
          dkimValid: false,
          dmarcValid: false,
          mxValid: false,
          rdnsValid: false,
        } as any),
      ).toBe(0);
    });
  });

  describe('computeBlacklistScore', () => {
    it('returns 30 when there is no blacklist check yet (assume clean)', () => {
      expect(service.computeBlacklistScore(null)).toBe(30);
    });

    it('returns 30 when isClean is true', () => {
      expect(
        service.computeBlacklistScore({ isClean: true, listedCount: 0, rblResults: {} } as any),
      ).toBe(30);
    });

    it('returns 0 for a Spamhaus listing', () => {
      expect(
        service.computeBlacklistScore({
          isClean: false,
          listedCount: 1,
          rblResults: { 'zen.spamhaus.org': 'listed' },
        } as any),
      ).toBe(0);
    });

    it('returns 18 for exactly 1 non-Spamhaus listing', () => {
      expect(
        service.computeBlacklistScore({
          isClean: false,
          listedCount: 1,
          rblResults: { 'bl.spamcop.net': 'listed', 'b.barracudacentral.org': 'clean' },
        } as any),
      ).toBe(18);
    });

    it('returns 12 for exactly 2 non-Spamhaus listings', () => {
      expect(
        service.computeBlacklistScore({
          isClean: false,
          listedCount: 2,
          rblResults: {
            'bl.spamcop.net': 'listed',
            'b.barracudacentral.org': 'listed',
            'dnsbl.sorbs.net': 'clean',
          },
        } as any),
      ).toBe(12);
    });

    it('returns 5 for 3 or more non-Spamhaus listings', () => {
      expect(
        service.computeBlacklistScore({
          isClean: false,
          listedCount: 3,
          rblResults: {
            'bl.spamcop.net': 'listed',
            'b.barracudacentral.org': 'listed',
            'dnsbl.sorbs.net': 'listed',
          },
        } as any),
      ).toBe(5);
    });

    it('derives listed status from rblResults, not listedCount alone', () => {
      // listedCount says 1 but rblResults shows a spamhaus hit — must still be 0.
      expect(
        service.computeBlacklistScore({
          isClean: false,
          listedCount: 1,
          rblResults: { 'zen.spamhaus.org': 'listed', 'bl.spamcop.net': 'clean' },
        } as any),
      ).toBe(0);
    });
  });

  describe('computePlacementScore', () => {
    it('returns 20 when there is no placement test yet', () => {
      expect(service.computePlacementScore(null)).toBe(20);
    });

    it('returns 40 for 100% Primary placement', () => {
      expect(
        service.computePlacementScore({
          seedCount: 10,
          primaryCount: 10,
          promotionsCount: 0,
          spamCount: 0,
        } as any),
      ).toBe(40);
    });

    it('returns 20 for 100% Promotions placement', () => {
      expect(
        service.computePlacementScore({
          seedCount: 10,
          primaryCount: 0,
          promotionsCount: 10,
          spamCount: 0,
        } as any),
      ).toBe(20);
    });

    it('returns 0 for 100% spam/missing placement', () => {
      expect(
        service.computePlacementScore({
          seedCount: 10,
          primaryCount: 0,
          promotionsCount: 0,
          spamCount: 10,
        } as any),
      ).toBe(0);
    });

    it('weights a mixed placement result correctly', () => {
      // 5 primary + 3 promotions out of 10 seeds: (5*1 + 3*0.5)/10 = 0.65 -> round(0.65*40) = 26
      expect(
        service.computePlacementScore({
          seedCount: 10,
          primaryCount: 5,
          promotionsCount: 3,
          spamCount: 2,
        } as any),
      ).toBe(26);
    });

    it('returns 0 when seedCount is 0 (avoid division by zero)', () => {
      expect(
        service.computePlacementScore({
          seedCount: 0,
          primaryCount: 0,
          promotionsCount: 0,
          spamCount: 0,
        } as any),
      ).toBe(0);
    });
  });
});
