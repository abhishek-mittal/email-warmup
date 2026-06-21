import { Test, TestingModule } from '@nestjs/testing';
import { ReadinessReportService } from './readiness-report.service';
import { db } from '../db';

jest.mock('../db', () => ({
  db: {
    select: jest.fn(),
    insert: jest.fn(),
  },
}));

describe('ReadinessReportService', () => {
  let service: ReadinessReportService;

  const inbox = { id: 'inbox-1', userId: 'user-1', warmupDay: 40 };

  /**
   * Sequenced db.select() mock. generateReadinessReport issues selects in
   * this order: inbox lookup, reputation_scores history, latest
   * placement_tests, warmup_sends pool-contribution aggregate.
   */
  function mockSelectSequence(results: any[][]) {
    let call = 0;
    (db.select as jest.Mock).mockImplementation(() => {
      const result = results[call] ?? [];
      call += 1;
      const chain: any = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue(result),
      };
      // Some queries (e.g. the warmup-pool-contribution aggregate) await
      // straight off `.where()` with no `.orderBy()`/`.limit()` — make every
      // link in the chain thenable so it resolves regardless of how many
      // links are called before awaiting.
      chain.then = (resolve: any) => Promise.resolve(result).then(resolve);
      return chain;
    });
  }

  function mockInsert(returningResult: any[] = [{ id: 'diag-1' }]) {
    const returningMock = jest.fn().mockResolvedValue(returningResult);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    (db.insert as jest.Mock).mockReturnValue({ values: valuesMock });
    return { valuesMock, returningMock };
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [ReadinessReportService],
    }).compile();

    service = module.get<ReadinessReportService>(ReadinessReportService);
  });

  describe('computeRecommendedVolume', () => {
    it('returns 150 when score >= 80 and primaryPct >= 85', () => {
      expect(service.computeRecommendedVolume(80, 85)).toBe(150);
    });

    it('returns 80 when score >= 70 and primaryPct >= 75 (but not the 150 tier)', () => {
      expect(service.computeRecommendedVolume(70, 75)).toBe(80);
    });

    it('returns 40 when score >= 60 and primaryPct >= 60 (but not the 80 tier)', () => {
      expect(service.computeRecommendedVolume(60, 60)).toBe(40);
    });

    it('returns 20 (conservative default) when thresholds are not met', () => {
      expect(service.computeRecommendedVolume(50, 50)).toBe(20);
    });

    it('falls through to 20 when primaryPlacementPct is null, regardless of score', () => {
      expect(service.computeRecommendedVolume(95, null)).toBe(20);
    });

    it('never exceeds the 200 cap', () => {
      expect(service.computeRecommendedVolume(1000, 1000)).toBeLessThanOrEqual(200);
    });
  });

  describe('generateReadinessReport', () => {
    it('generates a report even when no placement test has ever run (primaryPlacementPct defaults to null)', async () => {
      mockSelectSequence([
        [inbox], // inbox lookup
        [{ score: 75 }, { score: 80 }], // reputation history
        [], // no placement test
        [{ count: 3 }], // warmup pool contribution aggregate
      ]);

      const report = await service.generateReadinessReport('inbox-1');

      expect(report.primaryPlacementPct).toBeNull();
      expect(report.recommendedDailySendVolume).toBe(20);
      expect(report.warmupDaysCompleted).toBe(40);
    });

    it('computes reputationScore as the average of the last 7 days of scores', async () => {
      mockSelectSequence([
        [inbox],
        [{ score: 70 }, { score: 80 }, { score: 90 }],
        [{ primaryPct: 85 }],
        [{ count: 0 }],
      ]);

      const report = await service.generateReadinessReport('inbox-1');

      expect(report.reputationScore).toBe(80);
    });

    it('defaults reputationScore to 0 when there is no score history at all', async () => {
      mockSelectSequence([[inbox], [], [], [{ count: 0 }]]);

      const report = await service.generateReadinessReport('inbox-1');

      expect(report.reputationScore).toBe(0);
    });

    it('caps recommendedDailySendVolume at 200', async () => {
      mockSelectSequence([[inbox], [{ score: 100 }], [{ primaryPct: 100 }], [{ count: 0 }]]);

      const report = await service.generateReadinessReport('inbox-1');

      expect(report.recommendedDailySendVolume).toBeLessThanOrEqual(200);
    });

    it('formats warmupPoolContribution using the distinct-receiver count', async () => {
      mockSelectSequence([[inbox], [{ score: 80 }], [{ primaryPct: 80 }], [{ count: 847 }]]);

      const report = await service.generateReadinessReport('inbox-1');

      expect(report.warmupPoolContribution).toBe('Your inbox helped warm 847 other inboxes');
    });

    it('populates nextSteps and riskFactors as non-empty arrays', async () => {
      mockSelectSequence([[inbox], [], [], [{ count: 0 }]]);

      const report = await service.generateReadinessReport('inbox-1');

      expect(Array.isArray(report.nextSteps)).toBe(true);
      expect(report.nextSteps.length).toBeGreaterThan(0);
      expect(Array.isArray(report.riskFactors)).toBe(true);
      expect(report.riskFactors.length).toBeGreaterThan(0);
    });
  });

  describe('saveReadinessReport', () => {
    it('inserts a diagnostics row with triggerType "graduation", empty issueCodes, and null aiAnalysis', async () => {
      const { valuesMock } = mockInsert([{ id: 'diag-99' }]);
      const report = {
        inboxId: 'inbox-1',
        generatedAt: new Date().toISOString(),
        warmupDaysCompleted: 40,
        reputationScore: 80,
        primaryPlacementPct: 85,
        recommendedDailySendVolume: 150,
        warmupPoolContribution: 'Your inbox helped warm 5 other inboxes',
        nextSteps: ['step'],
        riskFactors: ['risk'],
      };

      const id = await service.saveReadinessReport('inbox-1', report);

      expect(valuesMock).toHaveBeenCalledWith({
        inboxId: 'inbox-1',
        triggerType: 'graduation',
        issueCodes: [],
        aiAnalysis: null,
        readinessReport: report,
      });
      expect(id).toBe('diag-99');
    });
  });
});
