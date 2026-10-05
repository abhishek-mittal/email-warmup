import { NotFoundException } from '@nestjs/common';
import { InboxControlService } from './inbox-control.service';
import { WarmupService } from '../warmup/warmup.service';
import { BounceMonitorService } from '../safety/bounce-monitor.service';
import { db } from '../db';
import { pinoLoggerStubsFor } from '../common/test-module';

jest.mock('../db', () => ({
  db: {
    select: jest.fn(),
    update: jest.fn(),
  },
}));

describe('InboxControlService', () => {
  let service: InboxControlService;
  let warmupService: {
    pauseInbox: jest.Mock;
    resumeInbox: jest.Mock;
    inboxCanWarm: jest.Mock;
    startInbox: jest.Mock;
  };
  const bounceMonitor = {
    stats: jest
      .fn()
      .mockResolvedValue({ attempted: 50, bounced: 2, rate: 0.04, limit: 0.03, windowHours: 24 }),
  };

  function makeSelectChain(rows: unknown[]) {
    const chain: any = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(rows),
    };
    (db.select as jest.Mock).mockReturnValueOnce(chain);
    return chain;
  }

  beforeEach(async () => {
    jest.resetAllMocks();
    warmupService = {
      pauseInbox: jest.fn().mockResolvedValue(undefined),
      resumeInbox: jest.fn().mockResolvedValue('active'),
      inboxCanWarm: jest.fn().mockResolvedValue(true),
      startInbox: jest.fn().mockResolvedValue('active'),
    };

    const module = await Test.createTestingModule({
      providers: [
        ...pinoLoggerStubsFor(NotFoundException, InboxControlService),
        InboxControlService,
        { provide: WarmupService, useValue: warmupService },
        { provide: BounceMonitorService, useValue: bounceMonitor },
      ],
    }).compile();
    service = module.get(InboxControlService);
  });

  // Resolve `Test` lazily so the imports above have already run.
  let Test: typeof import('@nestjs/testing').Test;
  beforeAll(() => {
    Test = require('@nestjs/testing').Test;
  });

  describe('assertOwnership (via pauseOne/resumeOne)', () => {
    it('throws NotFound when the inbox does not exist', async () => {
      makeSelectChain([]);
      await expect(service.pauseOne('user-1', 'missing')).rejects.toThrow(NotFoundException);
      expect(warmupService.pauseInbox).not.toHaveBeenCalled();
    });

    it('throws NotFound when the inbox belongs to another user', async () => {
      makeSelectChain([{ id: 'abc', userId: 'someone-else' }]);
      await expect(service.resumeOne('user-1', 'abc')).rejects.toThrow(NotFoundException);
      expect(warmupService.resumeInbox).not.toHaveBeenCalled();
    });

    it('returns the updated status when the inbox is owned', async () => {
      makeSelectChain([{ id: 'abc', userId: 'user-1' }]);
      const r = await service.pauseOne('user-1', 'abc');
      expect(r).toEqual({ id: 'abc', status: 'paused' });
      expect(warmupService.pauseInbox).toHaveBeenCalledWith('abc');
    });
  });

  describe('startOne (warmup start gate)', () => {
    it('activates a ready inbox that has partners', async () => {
      makeSelectChain([{ id: 'i', userId: 'u', status: 'ready' }]); // ownership
      makeSelectChain([{ id: 'u', plan: 'growth' }]); // plan check
      warmupService.inboxCanWarm.mockResolvedValue(true);
      warmupService.startInbox.mockResolvedValue('active');
      await expect(service.startOne('u', 'i')).resolves.toEqual({ id: 'i', status: 'active' });
      expect(warmupService.startInbox).toHaveBeenCalledWith('i');
    });

    it('rejects 409 no_partners when the ready inbox has no partners', async () => {
      makeSelectChain([{ id: 'i', userId: 'u', status: 'ready' }]);
      makeSelectChain([{ id: 'u', plan: 'growth' }]);
      warmupService.inboxCanWarm.mockResolvedValue(false);
      await expect(service.startOne('u', 'i')).rejects.toMatchObject({
        status: 409,
        response: { code: 'no_partners' },
      });
      expect(warmupService.startInbox).not.toHaveBeenCalled();
    });

    it('rejects 409 not_ready when the inbox is not in ready state', async () => {
      makeSelectChain([{ id: 'i', userId: 'u', status: 'active' }]);
      makeSelectChain([{ id: 'u', plan: 'growth' }]);
      await expect(service.startOne('u', 'i')).rejects.toMatchObject({
        status: 409,
        response: { code: 'not_ready' },
      });
      expect(warmupService.startInbox).not.toHaveBeenCalled();
    });
  });

  describe('resumeOne partner guard', () => {
    it('rejects 409 no_partners when a paused inbox has no partners', async () => {
      makeSelectChain([{ id: 'i', userId: 'u', status: 'paused' }]); // ownership
      makeSelectChain([{ id: 'u', plan: 'growth' }]); // plan check
      warmupService.inboxCanWarm.mockResolvedValue(false);
      await expect(service.resumeOne('u', 'i')).rejects.toMatchObject({
        status: 409,
        response: { code: 'no_partners' },
      });
      expect(warmupService.resumeInbox).not.toHaveBeenCalled();
    });
  });

  describe('bulk operations', () => {
    it('processes each id independently and reports per-row failures', async () => {
      // First id: owned. Second id: not owned. Third id: owned.
      const order: unknown[][] = [
        [{ id: 'a', userId: 'user-1' }],
        [], // missing
        [{ id: 'c', userId: 'user-1' }],
      ];
      (db.select as jest.Mock).mockImplementation(() => {
        const chain: any = {
          from: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          limit: jest.fn().mockResolvedValue(order.shift() ?? []),
        };
        return chain;
      });

      const result = await service.pauseMany('user-1', ['a', 'b', 'c']);
      expect(result.updated.map((r) => r.id)).toEqual(['a', 'c']);
      expect(result.failed).toEqual([{ id: 'b', reason: expect.any(String) }]);
      expect(warmupService.pauseInbox).toHaveBeenCalledTimes(2);
    });

    it('dedupes repeated ids', async () => {
      (db.select as jest.Mock).mockImplementation(() => {
        const chain: any = {
          from: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          // Serves both the inbox ownership lookup and the user plan lookup.
          limit: jest.fn().mockResolvedValue([{ id: 'a', userId: 'user-1', plan: 'demo' }]),
        };
        return chain;
      });

      const r = await service.resumeMany('user-1', ['a', 'a', 'a']);
      expect(r.updated).toEqual([{ id: 'a', status: 'active' }]);
      expect(r.failed).toEqual([]);
      expect(warmupService.resumeInbox).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['free plan', { plan: 'free' }],
      ['unknown plan', { plan: 'mystery' }],
      ['expired trial', { plan: 'trial', trialEndsAt: new Date(Date.now() - 60_000) }],
    ])('refuses to resume on a plan without warmup: %s', async (_name, user) => {
      (db.select as jest.Mock).mockImplementation(() => ({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([{ id: 'a', userId: 'user-1', ...user }]),
      }));

      await expect(service.resumeOne('user-1', 'a')).rejects.toThrow('does not include warmup');
      expect(warmupService.resumeInbox).not.toHaveBeenCalled();
    });
  });

  describe('bounceStats', () => {
    function selectReturns(row: any) {
      (db.select as jest.Mock).mockImplementation(() => ({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue(row ? [row] : []),
      }));
    }

    it('returns the figures with their sample size, and whether the inbox is held', async () => {
      selectReturns({ id: 'a', userId: 'user-1', status: 'paused', statusReason: 'bounce_rate' });
      bounceMonitor.stats.mockResolvedValue({
        attempted: 50,
        bounced: 2,
        rate: 0.04,
        limit: 0.03,
        windowHours: 24,
      });
      await expect(service.bounceStats('user-1', 'a')).resolves.toMatchObject({
        attempted: 50,
        bounced: 2,
        ratePct: 4,
        limitPct: 3,
        held: true,
      });
    });

    it('is not available for an inbox owned by someone else', async () => {
      selectReturns({ id: 'a', userId: 'user-2', status: 'active' });
      await expect(service.bounceStats('user-1', 'a')).rejects.toThrow();
    });
  });
});
