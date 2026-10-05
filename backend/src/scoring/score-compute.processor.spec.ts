import { Test, TestingModule } from '@nestjs/testing';
import { UnrecoverableError } from 'bullmq';
import { ScoreComputeProcessor } from './score-compute.processor';
import { SCORE_RULE_VERSION, ScoringService } from './scoring.service';
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
  let scoringService: { compose: jest.Mock };
  let trendService: { computeTrend: jest.Mock };
  let queueService: { add: jest.Mock };

  const inbox = { id: 'inbox-1', userId: 'user-1', email: 'sender@sendco.com', status: 'active' };
  const dnsRow = { id: 'dns-1' };
  const blacklistRow = { id: 'bl-1' };
  const placementRow = { id: 'pl-1' };

  const composed = (score: number | null, completeness = 100) => ({
    score,
    completeness,
    dns: { earned: 30, possible: 30 },
    blacklist: { earned: 30, possible: 30 },
    placement: { earned: 40, possible: 40 },
  });

  /**
   * Sequenced db.select() mock. ScoreComputeProcessor issues selects in this
   * order: inbox lookup, latest dns_checks, latest blacklist_checks, latest
   * placement_tests, previous reputation_scores row (for drop-alert check).
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

  const job = { data: { inboxId: 'inbox-1' } } as any;

  beforeEach(async () => {
    jest.clearAllMocks();
    scoringService = { compose: jest.fn().mockReturnValue(composed(100)) };
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

  it('throws UnrecoverableError when the inbox cannot be found', async () => {
    mockSelectSequence([[]]);

    await expect(processor.process(job)).rejects.toThrow(UnrecoverableError);
    expect(scoringService.compose).not.toHaveBeenCalled();
  });

  it('passes the latest dns, blocklist and placement rows to the rules', async () => {
    mockSelectSequence([[inbox], [dnsRow], [blacklistRow], [placementRow], []]);
    mockInsert();

    await processor.process(job);

    expect(scoringService.compose).toHaveBeenCalledWith(dnsRow, blacklistRow, placementRow);
  });

  it('passes null for a check that has never run', async () => {
    mockSelectSequence([[inbox], [], [], [], []]);
    mockInsert();

    await processor.process(job);

    expect(scoringService.compose).toHaveBeenCalledWith(null, null, null);
  });

  it('writes the score with its components, completeness, rule version and trend', async () => {
    mockSelectSequence([[inbox], [dnsRow], [blacklistRow], [placementRow], []]);
    const values = mockInsert();
    scoringService.compose.mockReturnValue({
      score: 82,
      completeness: 70,
      dns: { earned: 25, possible: 30 },
      blacklist: { earned: 0, possible: 0 },
      placement: { earned: 32, possible: 40 },
    });
    trendService.computeTrend.mockResolvedValue('up');

    await processor.process(job);

    expect(values).toHaveBeenCalledWith({
      inboxId: 'inbox-1',
      score: 82,
      dnsScore: 25,
      blacklistScore: 0,
      placementScore: 32,
      completeness: 70,
      ruleVersion: SCORE_RULE_VERSION,
      trend: 'up',
    });
  });

  it('writes no score at all when nothing could be measured', async () => {
    mockSelectSequence([[inbox], [], [], [], []]);
    const values = mockInsert();
    scoringService.compose.mockReturnValue(composed(null, 0));

    await processor.process(job);

    expect(values).not.toHaveBeenCalled();
    expect(queueService.add).not.toHaveBeenCalled();
  });

  describe('drop alerts', () => {
    it('never alerts for an inbox with no previous score', async () => {
      mockSelectSequence([[inbox], [dnsRow], [blacklistRow], [placementRow], []]);
      mockInsert();
      scoringService.compose.mockReturnValue(composed(10));

      await processor.process(job);

      expect(queueService.add).not.toHaveBeenCalled();
    });

    it('alerts and runs diagnostics when the score drops by 15 or more', async () => {
      mockSelectSequence([
        [inbox],
        [dnsRow],
        [blacklistRow],
        [placementRow],
        [{ score: 90, completeness: 100 }],
      ]);
      mockInsert();
      scoringService.compose.mockReturnValue(composed(70));

      await processor.process(job);

      expect(queueService.add).toHaveBeenCalledWith(
        'notify',
        expect.objectContaining({
          type: 'score_drop',
          payload: { prev: 90, current: 70, delta: 20 },
        }),
      );
      expect(queueService.add).toHaveBeenCalledWith('diagnostics', {
        inboxId: 'inbox-1',
        triggerType: 'auto_drop',
      });
    });

    it('does not alert for a smaller drop, or for an improvement', async () => {
      for (const current of [80, 95]) {
        mockSelectSequence([
          [inbox],
          [dnsRow],
          [blacklistRow],
          [placementRow],
          [{ score: 90, completeness: 100 }],
        ]);
        mockInsert();
        scoringService.compose.mockReturnValue(composed(current));
        await processor.process(job);
      }
      expect(queueService.add).not.toHaveBeenCalled();
    });

    it('does not alert when the score moved because how much could be measured changed', async () => {
      // Previous score rested on DNS alone (30%); now everything is measured.
      mockSelectSequence([
        [inbox],
        [dnsRow],
        [blacklistRow],
        [placementRow],
        [{ score: 100, completeness: 30 }],
      ]);
      mockInsert();
      scoringService.compose.mockReturnValue(composed(60, 100));

      await processor.process(job);

      expect(queueService.add).not.toHaveBeenCalled();
    });
  });
});
