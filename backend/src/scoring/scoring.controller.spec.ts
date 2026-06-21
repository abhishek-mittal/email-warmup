import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ScoringController } from './scoring.controller';
import { db } from '../db';

jest.mock('../db', () => ({
  db: {
    select: jest.fn(),
  },
}));

describe('ScoringController', () => {
  let controller: ScoringController;

  const inboxRow = { id: 'inbox-1', userId: 'user-1' };
  const otherUsersInboxRow = { id: 'inbox-2', userId: 'someone-else' };

  function mockSelectSequence(results: any[][]) {
    let call = 0;
    (db.select as jest.Mock).mockImplementation(() => {
      const result = results[call] ?? [];
      call += 1;
      const chain: any = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue(result),
        orderBy: jest.fn().mockImplementation(() => Promise.resolve(result)),
      };
      return chain;
    });
  }

  function makeReq(userId: string) {
    return { userId } as any;
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ScoringController],
    }).compile();
    controller = module.get<ScoringController>(ScoringController);
  });

  it('throws NotFoundException when the inbox does not exist', async () => {
    mockSelectSequence([[]]);

    await expect(controller.getScore('inbox-1', makeReq('user-1'))).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws NotFoundException when the inbox belongs to a different user (does not leak existence)', async () => {
    mockSelectSequence([[otherUsersInboxRow]]);

    await expect(controller.getScore('inbox-2', makeReq('user-1'))).rejects.toThrow(
      NotFoundException,
    );
  });

  it('returns null current/empty history when no score has ever been computed', async () => {
    mockSelectSequence([
      [inboxRow], // inbox ownership lookup
      [{ plan: 'growth' }], // user plan lookup
      [], // reputation_scores history
    ]);

    const result = await controller.getScore('inbox-1', makeReq('user-1'));

    expect(result).toEqual({ current: null, trend: 'stable', breakdown: null, history: [] });
  });

  it('returns breakdown for a growth-plan user', async () => {
    const recordedAt = new Date('2026-01-01T00:00:00.000Z');
    mockSelectSequence([
      [inboxRow],
      [{ plan: 'growth' }],
      [
        {
          score: 75,
          dnsScore: 25,
          blacklistScore: 30,
          placementScore: 20,
          trend: 'up',
          recordedAt,
        },
      ],
    ]);

    const result = await controller.getScore('inbox-1', makeReq('user-1'));

    expect(result).toEqual({
      current: 75,
      trend: 'up',
      breakdown: { dns: 25, blacklist: 30, placement: 20 },
      history: [{ date: recordedAt.toISOString(), score: 75 }],
    });
  });

  it('hides breakdown (null) for a trial-plan user', async () => {
    mockSelectSequence([
      [inboxRow],
      [{ plan: 'trial' }],
      [
        {
          score: 60,
          dnsScore: 20,
          blacklistScore: 20,
          placementScore: 20,
          trend: 'stable',
          recordedAt: new Date(),
        },
      ],
    ]);

    const result = await controller.getScore('inbox-1', makeReq('user-1'));

    expect(result.breakdown).toBeNull();
  });

  it('hides breakdown (null) for a starter-plan user', async () => {
    mockSelectSequence([
      [inboxRow],
      [{ plan: 'starter' }],
      [
        {
          score: 60,
          dnsScore: 20,
          blacklistScore: 20,
          placementScore: 20,
          trend: 'stable',
          recordedAt: new Date(),
        },
      ],
    ]);

    const result = await controller.getScore('inbox-1', makeReq('user-1'));

    expect(result.breakdown).toBeNull();
  });

  it('uses the most recent row (last in ascending history) for current/trend', async () => {
    const older = {
      score: 50,
      dnsScore: 10,
      blacklistScore: 20,
      placementScore: 20,
      trend: 'down',
      recordedAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    const newer = {
      score: 90,
      dnsScore: 30,
      blacklistScore: 30,
      placementScore: 30,
      trend: 'up',
      recordedAt: new Date('2026-01-02T00:00:00.000Z'),
    };
    mockSelectSequence([[inboxRow], [{ plan: 'growth' }], [older, newer]]);

    const result = await controller.getScore('inbox-1', makeReq('user-1'));

    expect(result.current).toBe(90);
    expect(result.trend).toBe('up');
    expect(result.history).toEqual([
      { date: older.recordedAt.toISOString(), score: 50 },
      { date: newer.recordedAt.toISOString(), score: 90 },
    ]);
  });
});
