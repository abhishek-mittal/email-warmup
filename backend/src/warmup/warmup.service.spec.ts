import { Test, TestingModule } from '@nestjs/testing';
import { WarmupService } from './warmup.service';
import { RampService } from './ramp.service';
import { PairingService } from './pairing.service';
import { QueueService } from '../queue/queue.service';
import { db } from '../db';

jest.mock('../db', () => ({
  db: {
    select: jest.fn(),
    update: jest.fn(),
  },
}));

describe('WarmupService', () => {
  let service: WarmupService;
  let rampService: { getDailyVolume: jest.Mock };
  let pairingService: { selectPartner: jest.Mock };
  let queueService: {
    add: jest.Mock;
    removeJobsForSender: jest.Mock;
    removeJobsForReceiver: jest.Mock;
  };

  const activeInbox = {
    id: 'inbox-1',
    userId: 'user-1',
    email: 'sender@sendco.com',
    provider: 'gmail',
    warmupSpeed: 'medium',
    warmupDay: 6,
    status: 'active',
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
    pairingService = {
      selectPartner: jest.fn().mockResolvedValue({ id: 'pool-partner-1', inboxId: 'inbox-2' }),
    };
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
      ],
    }).compile();

    service = module.get<WarmupService>(WarmupService);
  });

  describe('scheduleAllInboxes', () => {
    it('queries only active inboxes', async () => {
      mockSelectChain([]);

      await service.scheduleAllInboxes();

      expect(db.select).toHaveBeenCalled();
    });

    it('enqueues exactly `volume` warmup-send jobs for an active inbox on day 7 medium speed (10 jobs)', async () => {
      mockSelectChain([activeInbox]);
      mockUpdate();
      rampService.getDailyVolume.mockReturnValue(10);

      await service.scheduleAllInboxes();

      const sendJobs = queueService.add.mock.calls.filter(([name]) => name === 'warmup-send');
      expect(sendJobs).toHaveLength(10);
    });

    it('calls selectPartner once per send slot and passes its .id as partnerInboxId', async () => {
      mockSelectChain([activeInbox]);
      mockUpdate();
      rampService.getDailyVolume.mockReturnValue(3);

      await service.scheduleAllInboxes();

      expect(pairingService.selectPartner).toHaveBeenCalledTimes(3);
      expect(pairingService.selectPartner).toHaveBeenCalledWith('inbox-1');

      const sendJobs = queueService.add.mock.calls.filter(([name]) => name === 'warmup-send');
      for (const [, payload] of sendJobs) {
        expect(payload.partnerInboxId).toBe('pool-partner-1');
        expect(payload.senderInboxId).toBe('inbox-1');
      }
    });

    it('skips a send slot (no orphaned job) when selectPartner returns null for that slot', async () => {
      mockSelectChain([activeInbox]);
      mockUpdate();
      rampService.getDailyVolume.mockReturnValue(3);
      pairingService.selectPartner
        .mockResolvedValueOnce({ id: 'pool-1', inboxId: 'inbox-2' })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'pool-3', inboxId: 'inbox-4' });

      await service.scheduleAllInboxes();

      const sendJobs = queueService.add.mock.calls.filter(([name]) => name === 'warmup-send');
      expect(sendJobs).toHaveLength(2);
    });

    it('applies non-zero jitter to every job (no job fires at the exact base slot time)', async () => {
      mockSelectChain([activeInbox]);
      mockUpdate();
      rampService.getDailyVolume.mockReturnValue(10);

      await service.scheduleAllInboxes();

      const sendJobs = queueService.add.mock.calls.filter(([name]) => name === 'warmup-send');
      const windowStart = new Date();
      windowStart.setUTCHours(8, 0, 0, 0);
      const spacingMs = (600 / 10) * 60_000; // 60 min spacing at volume=10

      sendJobs.forEach(([, payload], i) => {
        const baseSlotMs = windowStart.getTime() + i * spacingMs;
        const scheduledMs = new Date(payload.scheduledAt).getTime();
        expect(scheduledMs).not.toBe(baseSlotMs);
        expect(Math.abs(scheduledMs - baseSlotMs)).toBeLessThanOrEqual(15 * 60_000 + 1000);
      });
    });

    it('never schedules two jobs from the same sender within 8 minutes of each other', async () => {
      mockSelectChain([activeInbox]);
      mockUpdate();
      rampService.getDailyVolume.mockReturnValue(10);

      await service.scheduleAllInboxes();

      const sendJobs = queueService.add.mock.calls
        .filter(([name]) => name === 'warmup-send')
        .map(([, payload]) => new Date(payload.scheduledAt).getTime())
        .sort((a, b) => a - b);

      for (let i = 1; i < sendJobs.length; i++) {
        const gapMinutes = (sendJobs[i] - sendJobs[i - 1]) / 60_000;
        expect(gapMinutes).toBeGreaterThanOrEqual(8);
      }
    });

    it('increments warmup_day by 1 after scheduling', async () => {
      mockSelectChain([activeInbox]);
      const setMock = jest.fn().mockReturnThis();
      (db.update as jest.Mock).mockReturnValue({
        set: setMock,
        where: jest.fn().mockResolvedValue(undefined),
      });
      rampService.getDailyVolume.mockReturnValue(2);

      await service.scheduleAllInboxes();

      expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ warmupDay: 7 }));
    });

    it('handles a high-volume day by extending past the 18:00 window rather than dropping sends', async () => {
      mockSelectChain([activeInbox]);
      mockUpdate();
      rampService.getDailyVolume.mockReturnValue(100); // medium day 35 — spacing forced to 8 min, window extends past 18:00

      await service.scheduleAllInboxes();

      const sendJobs = queueService.add.mock.calls.filter(([name]) => name === 'warmup-send');
      // Ramp volume is never reduced to fit the clock window.
      expect(sendJobs).toHaveLength(100);
    });

    it('does not query graduation criteria for an inbox far below its minimum graduation day (perf optimization)', async () => {
      // warmupDay 6 -> nextWarmupDay 7, medium minimum is 35 — nowhere close.
      mockSelectChain([activeInbox]);
      mockUpdate();
      rampService.getDailyVolume.mockReturnValue(1);

      await service.scheduleAllInboxes();

      // Only the initial active-inboxes query should have happened — no extra
      // db.select calls for reputation_scores/placement_tests/graduation re-fetch.
      expect((db.select as jest.Mock).mock.calls.length).toBe(1);
    });

    it('calls checkGraduation for an inbox whose incremented warmup_day reaches its minimum graduation day', async () => {
      const almostGraduatedInbox = { ...activeInbox, warmupDay: 34 }; // medium min=35, nextWarmupDay=35
      mockSelectChain([almostGraduatedInbox]); // active inboxes query
      mockUpdate();
      rampService.getDailyVolume.mockReturnValue(1);
      // checkGraduation's internal queries: inbox lookup, reputation_scores, placement_tests
      mockSelectChain([{ ...almostGraduatedInbox, warmupDay: 35 }]);
      mockSelectChain([]); // no reputation_scores rows -> fails closed, returns false

      await service.scheduleAllInboxes();

      // 1 (active inboxes) + 1 (graduation's inbox lookup) + 1 (reputation_scores) = 3.
      // placement_tests is only queried if the reputation criterion passes, so it's
      // short-circuited here.
      expect((db.select as jest.Mock).mock.calls.length).toBe(3);
    });
  });

  describe('checkGraduation', () => {
    const inboxRow = {
      id: 'inbox-1',
      userId: 'user-1',
      warmupSpeed: 'medium',
      warmupDay: 35,
      status: 'active',
    };

    it('returns false (does not graduate) when there are zero reputation_scores rows (missing data fails the criterion)', async () => {
      mockSelectChain([inboxRow]); // load inbox
      mockSelectChain([]); // reputation_scores rows (empty -> avg undefined)
      mockSelectChain([]); // placement_tests rows (empty -> skip criterion)

      const result = await service.checkGraduation('inbox-1');

      expect(result).toBe(false);
      expect(queueService.add).not.toHaveBeenCalled();
    });

    it('returns true when warmupDay meets minimum, avg score >= 70, and no placement test exists yet (skipped)', async () => {
      mockSelectChain([inboxRow]);
      mockSelectChain([{ score: 75 }, { score: 80 }]); // avg 77.5
      mockSelectChain([]); // no placement test -> skip criterion
      mockUpdate();

      const result = await service.checkGraduation('inbox-1');

      expect(result).toBe(true);
    });

    it('returns false when avg reputation score is below 70 even if other criteria pass', async () => {
      mockSelectChain([inboxRow]);
      mockSelectChain([{ score: 50 }, { score: 60 }]); // avg 55
      mockSelectChain([]);

      const result = await service.checkGraduation('inbox-1');

      expect(result).toBe(false);
    });

    it('returns false when warmupDay is below the minimum for the speed', async () => {
      mockSelectChain([{ ...inboxRow, warmupDay: 10 }]);
      mockSelectChain([{ score: 90 }]);
      mockSelectChain([]);

      const result = await service.checkGraduation('inbox-1');

      expect(result).toBe(false);
    });

    it('returns false when the latest placement test spamPct exceeds 5%, even with good score/day', async () => {
      mockSelectChain([inboxRow]);
      mockSelectChain([{ score: 90 }]);
      mockSelectChain([{ spamPct: 8, completedAt: new Date() }]);

      const result = await service.checkGraduation('inbox-1');

      expect(result).toBe(false);
    });

    it('graduates: sets status=graduated + graduated_at, deactivates pool membership, enqueues score-compute, readiness-report, and notify', async () => {
      mockSelectChain([inboxRow]);
      mockSelectChain([{ score: 75 }]);
      mockSelectChain([{ spamPct: 2, completedAt: new Date() }]);
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

  describe('pauseInbox', () => {
    it("sets the inbox status to 'paused'", async () => {
      const setMock = jest.fn().mockReturnThis();
      (db.update as jest.Mock).mockReturnValue({
        set: setMock,
        where: jest.fn().mockResolvedValue(undefined),
      });

      await service.pauseInbox('inbox-1');

      expect(setMock).toHaveBeenCalledWith({ status: 'paused' });
    });

    it('drains pending warmup-send jobs where this inbox is the sender', async () => {
      mockUpdate();

      await service.pauseInbox('inbox-1');

      expect(queueService.removeJobsForSender).toHaveBeenCalledWith('warmup-send', 'inbox-1');
    });

    it('drains pending warmup-receive jobs where this inbox is the receiver', async () => {
      mockUpdate();

      await service.pauseInbox('inbox-1');

      expect(queueService.removeJobsForReceiver).toHaveBeenCalledWith('warmup-receive', 'inbox-1');
    });
  });
});
