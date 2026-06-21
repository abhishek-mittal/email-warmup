import { Test, TestingModule } from '@nestjs/testing';
import { UnrecoverableError } from 'bullmq';
import { ScoreComputeProcessor } from './score-compute.processor';
import { ScoringService } from './scoring.service';
import { TrendService } from './trend.service';
import { QueueService } from '../queue/queue.service';
import { db } from '../db';

jest.mock('../db', () => ({
  db: {
    select: jest.fn(),
    insert: jest.fn(),
  },
}));

describe('ScoreComputeProcessor', () => {
  let processor: ScoreComputeProcessor;
  let scoringService: {
    computeDnsScore: jest.Mock;
    computeBlacklistScore: jest.Mock;
    computePlacementScore: jest.Mock;
  };
  let trendService: { computeTrend: jest.Mock };
  let queueService: { add: jest.Mock };

  const inbox = { id: 'inbox-1', userId: 'user-1', email: 'sender@sendco.com', status: 'active' };
  const dnsRow = { id: 'dns-1' };
  const blacklistRow = { id: 'bl-1' };
  const placementRow = { id: 'pl-1' };

  /**
   * Sequenced db.select() mock. ScoreComputeProcessor issues selects in this
   * order: inbox lookup, latest dns_checks, latest blacklist_checks, latest
   * placement_tests, previous reputation_scores row (for drop-alert check).
   * TrendService's own select (called via the real or mocked computeTrend)
   * is NOT part of this sequence since trendService is mocked here.
   */
  function mockSelectSequence(results: any[][]) {
    let call = 0;
    (db.select as jest.Mock).mockImplementation(() => {
      const result = results[call] ?? [];
      call += 1;
      return {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue(result),
      };
    });
  }

  function mockInsert() {
    const valuesMock = jest.fn().mockResolvedValue(undefined);
    (db.insert as jest.Mock).mockReturnValue({ values: valuesMock });
    return valuesMock;
  }

  function makeJob(overrides: Partial<{ inboxId: string }> = {}) {
    return { data: { inboxId: 'inbox-1', ...overrides } } as any;
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    scoringService = {
      computeDnsScore: jest.fn().mockReturnValue(30),
      computeBlacklistScore: jest.fn().mockReturnValue(30),
      computePlacementScore: jest.fn().mockReturnValue(40),
    };
    trendService = { computeTrend: jest.fn().mockResolvedValue('stable') };
    queueService = { add: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScoreComputeProcessor,
        { provide: ScoringService, useValue: scoringService },
        { provide: TrendService, useValue: trendService },
        { provide: QueueService, useValue: queueService },
      ],
    }).compile();

    processor = module.get<ScoreComputeProcessor>(ScoreComputeProcessor);
  });

  describe('process', () => {
    it('throws UnrecoverableError when the inbox cannot be found', async () => {
      mockSelectSequence([[]]);

      await expect(processor.process(makeJob())).rejects.toThrow(UnrecoverableError);
      expect(scoringService.computeDnsScore).not.toHaveBeenCalled();
    });

    it('loads latest dns, blacklist, and placement rows and computes each component', async () => {
      mockSelectSequence([[inbox], [dnsRow], [blacklistRow], [placementRow], []]);
      mockInsert();

      await processor.process(makeJob());

      expect(scoringService.computeDnsScore).toHaveBeenCalledWith(dnsRow);
      expect(scoringService.computeBlacklistScore).toHaveBeenCalledWith(blacklistRow);
      expect(scoringService.computePlacementScore).toHaveBeenCalledWith(placementRow);
    });

    it('passes null to component functions when no row exists for that check', async () => {
      mockSelectSequence([[inbox], [], [], [], []]);
      mockInsert();

      await processor.process(makeJob());

      expect(scoringService.computeDnsScore).toHaveBeenCalledWith(null);
      expect(scoringService.computeBlacklistScore).toHaveBeenCalledWith(null);
      expect(scoringService.computePlacementScore).toHaveBeenCalledWith(null);
    });

    it('inserts a reputation_scores row with total = sum of the three components', async () => {
      scoringService.computeDnsScore.mockReturnValue(10);
      scoringService.computeBlacklistScore.mockReturnValue(18);
      scoringService.computePlacementScore.mockReturnValue(26);
      mockSelectSequence([[inbox], [dnsRow], [blacklistRow], [placementRow], []]);
      const valuesMock = mockInsert();

      await processor.process(makeJob());

      expect(valuesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          inboxId: 'inbox-1',
          score: 54,
          dnsScore: 10,
          blacklistScore: 18,
          placementScore: 26,
          trend: 'stable',
        }),
      );
    });

    it('clamps the total score between 0 and 100', async () => {
      scoringService.computeDnsScore.mockReturnValue(30);
      scoringService.computeBlacklistScore.mockReturnValue(30);
      scoringService.computePlacementScore.mockReturnValue(40);
      mockSelectSequence([[inbox], [dnsRow], [blacklistRow], [placementRow], []]);
      const valuesMock = mockInsert();

      await processor.process(makeJob());

      expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ score: 100 }));
    });

    it('still writes a reputation_scores row when all three components default (null inputs)', async () => {
      scoringService.computeDnsScore.mockReturnValue(0);
      scoringService.computeBlacklistScore.mockReturnValue(30);
      scoringService.computePlacementScore.mockReturnValue(20);
      mockSelectSequence([[inbox], [], [], [], []]);
      const valuesMock = mockInsert();

      await processor.process(makeJob());

      expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ score: 50 }));
    });

    it('calls trendService.computeTrend with the inboxId before inserting, and writes its result as trend', async () => {
      trendService.computeTrend.mockResolvedValue('down');
      mockSelectSequence([[inbox], [dnsRow], [blacklistRow], [placementRow], []]);
      const valuesMock = mockInsert();

      await processor.process(makeJob());

      expect(trendService.computeTrend).toHaveBeenCalledWith('inbox-1');
      expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ trend: 'down' }));

      const trendCallOrder = trendService.computeTrend.mock.invocationCallOrder[0];
      const insertCallOrder = (db.insert as jest.Mock).mock.invocationCallOrder[0];
      expect(trendCallOrder).toBeLessThan(insertCallOrder);
    });

    it('does NOT trigger a drop alert for a newly connected inbox with no history', async () => {
      scoringService.computeDnsScore.mockReturnValue(0);
      scoringService.computeBlacklistScore.mockReturnValue(0);
      scoringService.computePlacementScore.mockReturnValue(0);
      mockSelectSequence([[inbox], [], [], [], []]); // no previous reputation_scores row
      mockInsert();

      await processor.process(makeJob());

      expect(queueService.add).not.toHaveBeenCalledWith('notify', expect.anything());
      expect(queueService.add).not.toHaveBeenCalledWith('diagnostics', expect.anything());
    });

    it('triggers score_drop notify + diagnostics when drop >= 15 vs the previous score', async () => {
      scoringService.computeDnsScore.mockReturnValue(10);
      scoringService.computeBlacklistScore.mockReturnValue(10);
      scoringService.computePlacementScore.mockReturnValue(10); // total = 30
      mockSelectSequence([[inbox], [dnsRow], [blacklistRow], [placementRow], [{ score: 45 }]]); // prev = 45, drop = 15
      mockInsert();

      await processor.process(makeJob());

      expect(queueService.add).toHaveBeenCalledWith('notify', {
        userId: 'user-1',
        inboxId: 'inbox-1',
        type: 'score_drop',
        channel: 'email',
        payload: { prev: 45, current: 30, delta: 15 },
      });
      expect(queueService.add).toHaveBeenCalledWith('diagnostics', {
        inboxId: 'inbox-1',
        triggerType: 'auto_drop',
      });
    });

    it('does NOT trigger a drop alert when the drop is less than 15', async () => {
      scoringService.computeDnsScore.mockReturnValue(15);
      scoringService.computeBlacklistScore.mockReturnValue(15);
      scoringService.computePlacementScore.mockReturnValue(15); // total = 45
      mockSelectSequence([[inbox], [dnsRow], [blacklistRow], [placementRow], [{ score: 59 }]]); // drop = 14
      mockInsert();

      await processor.process(makeJob());

      expect(queueService.add).not.toHaveBeenCalledWith('notify', expect.anything());
      expect(queueService.add).not.toHaveBeenCalledWith('diagnostics', expect.anything());
    });

    it('does NOT trigger a drop alert when the score improves or stays flat', async () => {
      scoringService.computeDnsScore.mockReturnValue(30);
      scoringService.computeBlacklistScore.mockReturnValue(30);
      scoringService.computePlacementScore.mockReturnValue(40); // total = 100
      mockSelectSequence([[inbox], [dnsRow], [blacklistRow], [placementRow], [{ score: 50 }]]);
      mockInsert();

      await processor.process(makeJob());

      expect(queueService.add).not.toHaveBeenCalledWith('notify', expect.anything());
      expect(queueService.add).not.toHaveBeenCalledWith('diagnostics', expect.anything());
    });
  });
});
