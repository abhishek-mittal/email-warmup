import { Test, TestingModule } from '@nestjs/testing';
import { WarmupService } from './warmup.service';
import { RampService } from './ramp.service';
import { PairingService } from './pairing.service';
import { QueueService } from '../queue/queue.service';
import { WarmupLedgerService } from './warmup-ledger.service';
import { SafetyStopService } from '../safety/safety-stop.service';
import { PlacementService } from '../placement/placement.service';
import { db } from '../db';

jest.mock('../db', () => ({
  db: {
    select: jest.fn(),
    update: jest.fn(),
  },
}));

// Scheduling, pause and resume are covered against a real database in
// test/integration/scheduler.int-spec.ts; this file covers graduation rules.
describe('WarmupService', () => {
  let service: WarmupService;
  let rampService: { getDailyVolume: jest.Mock };
  let pairingService: { selectPartners: jest.Mock };
  const placementService = { runGraduationTest: jest.fn() };
  let queueService: {
    add: jest.Mock;
    removeJobsForSender: jest.Mock;
    removeJobsForReceiver: jest.Mock;
  };

  function mockSelectChain(returnValue: any[]) {
    const chain: any = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(returnValue),
    };
    // Allow awaiting the chain directly when no further method is called (e.g. plain
    // `db.select().from().where()` with no `.limit()`).
    chain.then = (resolve: any) => Promise.resolve(returnValue).then(resolve);
    (db.select as jest.Mock).mockReturnValueOnce(chain);
    return chain;
  }

  function mockUpdate() {
    (db.update as jest.Mock).mockReturnValue({
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(undefined),
    });
  }

  beforeEach(async () => {
    // resetAllMocks (not clearAllMocks) — clearAllMocks only wipes call history, it
    // leaves any queued mockReturnValueOnce/mockResolvedValueOnce values from a
    // previous test in the queue, which leaked db.select() chains across tests here.
    jest.resetAllMocks();

    rampService = { getDailyVolume: jest.fn().mockReturnValue(10) };
    pairingService = { selectPartners: jest.fn().mockResolvedValue([]) };
    queueService = {
      add: jest.fn().mockResolvedValue(undefined),
      removeJobsForSender: jest.fn().mockResolvedValue(undefined),
      removeJobsForReceiver: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WarmupService,
        { provide: RampService, useValue: rampService },
        { provide: PairingService, useValue: pairingService },
        { provide: QueueService, useValue: queueService },
        { provide: WarmupLedgerService, useValue: { recover: jest.fn() } },
        { provide: PlacementService, useValue: placementService },
        {
          provide: SafetyStopService,
          useValue: { activeStopFor: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile();

    service = module.get<WarmupService>(WarmupService);
  });

  describe('checkGraduation', () => {
    const inboxRow = {
      id: 'inbox-1',
      userId: 'user-1',
      warmupSpeed: 'medium',
      warmupDay: 35,
      status: 'active',
    };

    /** `days` score rows, one per day going back from today, each well measured. */
    const measuredDays = (days: number, score = 80, completeness = 100) =>
      Array.from({ length: days }, (_, i) => ({
        score,
        completeness,
        recordedAt: new Date(Date.now() - i * 24 * 60 * 60 * 1000),
      }));
    const goodPlacement = { spamPct: 2, completedAt: new Date(), status: 'complete' };

    it('does not graduate with no scores at all', async () => {
      mockSelectChain([inboxRow]);
      mockSelectChain([]);

      expect(await service.checkGraduation('inbox-1')).toBe(false);
      expect(queueService.add).not.toHaveBeenCalled();
    });

    it('one good score — or many on one day — is not an observation window', async () => {
      mockSelectChain([inboxRow]);
      mockSelectChain([
        { score: 95, completeness: 100, recordedAt: new Date() },
        { score: 96, completeness: 100, recordedAt: new Date() },
        { score: 97, completeness: 100, recordedAt: new Date() },
      ]);
      mockSelectChain([goodPlacement]);

      expect(await service.checkGraduation('inbox-1')).toBe(false);
    });

    it('six measured days are not enough', async () => {
      mockSelectChain([inboxRow]);
      mockSelectChain(measuredDays(6));

      expect(await service.checkGraduation('inbox-1')).toBe(false);
    });

    it('seven measured days are enough', async () => {
      mockSelectChain([inboxRow]);
      mockSelectChain(measuredDays(7));
      mockSelectChain([goodPlacement]);
      mockUpdate();

      expect(await service.checkGraduation('inbox-1')).toBe(true);
    });

    it('a high score resting on too little measurement does not count as a measured day', async () => {
      mockSelectChain([inboxRow]);
      mockSelectChain(measuredDays(7, 100, 30)); // only DNS was known

      expect(await service.checkGraduation('inbox-1')).toBe(false);
    });

    it('scores recorded before completeness was tracked do not count', async () => {
      mockSelectChain([inboxRow]);
      mockSelectChain(measuredDays(7, 100, null as any));

      expect(await service.checkGraduation('inbox-1')).toBe(false);
    });

    it('does not graduate when the average is below 80', async () => {
      mockSelectChain([inboxRow]);
      mockSelectChain(measuredDays(7, 79));
      mockSelectChain([goodPlacement]);

      expect(await service.checkGraduation('inbox-1')).toBe(false);
    });

    it('graduates at an average of exactly 80', async () => {
      mockSelectChain([inboxRow]);
      mockSelectChain(measuredDays(7, 80));
      mockSelectChain([goodPlacement]);
      mockUpdate();

      expect(await service.checkGraduation('inbox-1')).toBe(true);
    });

    it('returns false when warmupDay is below the minimum for the speed', async () => {
      mockSelectChain([{ ...inboxRow, warmupDay: 10 }]);
      mockSelectChain(measuredDays(7));
      mockSelectChain([goodPlacement]);

      expect(await service.checkGraduation('inbox-1')).toBe(false);
    });

    it.each([
      ['no placement test has produced a result', []],
      [
        'the latest test is older than 14 days',
        [{ spamPct: 0, completedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000) }],
      ],
      ['the latest result has no spam figure', [{ spamPct: null, completedAt: new Date() }]],
      ['spam is above 5%', [{ spamPct: 8, completedAt: new Date() }]],
    ])('does not graduate when %s', async (_name, placementRows) => {
      mockSelectChain([inboxRow]);
      mockSelectChain(measuredDays(7, 95));
      mockSelectChain(placementRows as any[]);

      expect(await service.checkGraduation('inbox-1')).toBe(false);
    });

    it('starts the free graduation test when only the placement result is missing', async () => {
      placementService.runGraduationTest.mockResolvedValue({ testId: 't-1' });
      mockSelectChain([inboxRow]);
      mockSelectChain(measuredDays(7, 95));
      mockSelectChain([]);

      expect(await service.checkGraduation('inbox-1')).toBe(false);
      expect(placementService.runGraduationTest).toHaveBeenCalledWith('inbox-1', 'user-1');
    });

    it('does not start a graduation test while the score criterion is unmet, and survives one that cannot start', async () => {
      mockSelectChain([inboxRow]);
      mockSelectChain(measuredDays(3, 95));
      expect(await service.checkGraduation('inbox-1')).toBe(false);
      expect(placementService.runGraduationTest).not.toHaveBeenCalled();

      placementService.runGraduationTest.mockRejectedValue(new Error('no healthy seeds'));
      mockSelectChain([inboxRow]);
      mockSelectChain(measuredDays(7, 95));
      mockSelectChain([]);
      await expect(service.checkGraduation('inbox-1')).resolves.toBe(false);
    });

    it('graduates with spam at exactly 5%', async () => {
      mockSelectChain([inboxRow]);
      mockSelectChain(measuredDays(7));
      mockSelectChain([{ spamPct: 5, completedAt: new Date() }]);
      mockUpdate();

      expect(await service.checkGraduation('inbox-1')).toBe(true);
    });

    it('graduates: sets status=graduated + graduated_at, deactivates pool membership, enqueues score-compute, readiness-report, and notify', async () => {
      mockSelectChain([inboxRow]);
      mockSelectChain(measuredDays(7, 85));
      mockSelectChain([goodPlacement]);
      const setMock = jest.fn().mockReturnThis();
      (db.update as jest.Mock).mockReturnValue({
        set: setMock,
        where: jest.fn().mockResolvedValue(undefined),
      });

      const result = await service.checkGraduation('inbox-1');

      expect(result).toBe(true);

      // inbox status update
      expect(setMock).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'graduated', graduatedAt: expect.any(Date) }),
      );
      // pool_members deactivation
      expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ active: false }));

      const queueCalls = queueService.add.mock.calls;
      expect(queueCalls.find(([name]) => name === 'score-compute')).toBeTruthy();
      expect(queueCalls.find(([name]) => name === 'readiness-report')).toEqual([
        'readiness-report',
        { inboxId: 'inbox-1' },
      ]);
      expect(queueCalls.find(([name]) => name === 'notify')).toEqual([
        'notify',
        {
          userId: 'user-1',
          inboxId: 'inbox-1',
          type: 'warmup_complete',
          channel: 'email',
          payload: { warmupDay: 35 },
        },
      ]);
    });
  });
});
