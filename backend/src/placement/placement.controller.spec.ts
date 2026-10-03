import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { PlacementController } from './placement.controller';
import { PlacementService } from './placement.service';
import { db } from '../db';

import { pinoLoggerStubsFor } from '../common/test-module';
jest.mock('../db', () => ({
  db: {
    select: jest.fn(),
  },
}));

describe('PlacementController', () => {
  let controller: PlacementController;
  let placementService: { runTest: jest.Mock };

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
        orderBy: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue(result),
        }),
      };
      return chain;
    });
  }

  function makeReq(userId: string) {
    return { userId } as any;
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    placementService = {
      runTest: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PlacementController],
      providers: [
        ...pinoLoggerStubsFor(
          HttpException,
          HttpStatus,
          NotFoundException,
          PlacementController,
          PlacementService,
          db,
          Date,
        ),
        { provide: PlacementService, useValue: placementService },
      ],
    }).compile();

    controller = module.get<PlacementController>(PlacementController);
  });

  describe('POST /inboxes/:id/placement-test', () => {
    it('throws NotFoundException when the inbox does not exist', async () => {
      mockSelectSequence([[]]);

      await expect(controller.createTest('inbox-1', makeReq('user-1'))).rejects.toThrow(
        NotFoundException,
      );
      expect(placementService.runTest).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the inbox belongs to a different user (does not leak existence)', async () => {
      mockSelectSequence([[otherUsersInboxRow]]);

      await expect(controller.createTest('inbox-2', makeReq('user-1'))).rejects.toThrow(
        NotFoundException,
      );
      expect(placementService.runTest).not.toHaveBeenCalled();
    });

    it('delegates to PlacementService.runTest and returns its result on success', async () => {
      mockSelectSequence([[inboxRow]]);
      placementService.runTest.mockResolvedValue({
        testId: 'test-1',
        estimatedReadyAt: '2026-06-21T12:05:00.000Z',
      });

      const result = await controller.createTest('inbox-1', makeReq('user-1'));

      expect(placementService.runTest).toHaveBeenCalledWith('inbox-1', 'user-1');
      expect(result).toMatchObject({
        testId: 'test-1',
        estimatedReadyAt: '2026-06-21T12:05:00.000Z',
      });
    });

    it('propagates the 429 HttpException from PlacementService.runTest unchanged', async () => {
      mockSelectSequence([[inboxRow]]);
      placementService.runTest.mockRejectedValue(
        new HttpException('quota exceeded', HttpStatus.TOO_MANY_REQUESTS),
      );

      await expect(controller.createTest('inbox-1', makeReq('user-1'))).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
      });
    });
  });

  describe('GET /inboxes/:id/placement-test/:testId', () => {
    it('throws NotFoundException when the inbox does not exist', async () => {
      mockSelectSequence([[]]);

      await expect(controller.getTest('inbox-1', 'test-1', makeReq('user-1'))).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws NotFoundException when the test row does not exist for this inbox', async () => {
      mockSelectSequence([[inboxRow], []]);

      await expect(controller.getTest('inbox-1', 'test-1', makeReq('user-1'))).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns status "pending" with null completedAt and null percentages while placementScore is null', async () => {
      mockSelectSequence([
        [inboxRow],
        [
          {
            id: 'test-1',
            inboxId: 'inbox-1',
            seedCount: 10,
            primaryCount: null,
            promotionsCount: null,
            spamCount: null,
            missingCount: null,
            primaryPct: null,
            promotionsPct: null,
            spamPct: null,
            placementScore: null,
            status: 'queued',
            createdAt: new Date('2026-06-21T11:00:00.000Z'),
            completedAt: new Date('2026-06-21T12:00:00.000Z'), // insert-time placeholder
          },
        ],
      ]);

      const result = await controller.getTest('inbox-1', 'test-1', makeReq('user-1'));

      expect(result).toMatchObject({
        status: 'pending',
        primaryPct: null,
        promotionsPct: null,
        spamPct: null,
        missingPct: null,
        placementScore: null,
        completedAt: null,
      });
    });

    it('returns status "complete" with real percentages and completedAt once placementScore is set', async () => {
      const completedAt = new Date('2026-06-21T12:10:00.000Z');
      mockSelectSequence([
        [inboxRow],
        [
          {
            id: 'test-1',
            inboxId: 'inbox-1',
            seedCount: 10,
            primaryCount: 10,
            promotionsCount: 0,
            spamCount: 0,
            missingCount: 0,
            primaryPct: 100,
            promotionsPct: 0,
            spamPct: 0,
            placementScore: 100,
            status: 'complete',
            createdAt: new Date('2026-06-21T11:00:00.000Z'),
            observedCount: 10,
            completedAt,
          },
        ],
      ]);

      const result = await controller.getTest('inbox-1', 'test-1', makeReq('user-1'));

      expect(result).toMatchObject({
        status: 'complete',
        primaryPct: 100,
        promotionsPct: 0,
        spamPct: 0,
        missingPct: 0,
        placementScore: 100,
        completedAt: completedAt.toISOString(),
      });
    });

    it('computes missingPct from missingCount/seedCount when complete', async () => {
      mockSelectSequence([
        [inboxRow],
        [
          {
            id: 'test-1',
            inboxId: 'inbox-1',
            seedCount: 10,
            primaryCount: 5,
            promotionsCount: 0,
            spamCount: 2,
            missingCount: 3,
            primaryPct: 50,
            promotionsPct: 0,
            spamPct: 20,
            placementScore: 50,
            status: 'complete',
            createdAt: new Date('2026-06-21T11:00:00.000Z'),
            observedCount: 10,
            completedAt: new Date(),
          },
        ],
      ]);

      const result = await controller.getTest('inbox-1', 'test-1', makeReq('user-1'));

      expect(result.missingPct).toBe(30);
    });
  });

  describe('GET /inboxes/:id/placement-tests', () => {
    it('throws NotFoundException when the inbox does not exist', async () => {
      mockSelectSequence([[]]);

      await expect(controller.listTests('inbox-1', makeReq('user-1'))).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns the last 10 results mapped to the same response shape, most recent first', async () => {
      const rows = [
        {
          id: 'test-2',
          inboxId: 'inbox-1',
          seedCount: 10,
          primaryCount: 8,
          promotionsCount: 1,
          spamCount: 1,
          missingCount: 0,
          primaryPct: 80,
          promotionsPct: 10,
          spamPct: 10,
          placementScore: 85,
          status: 'complete',
          createdAt: new Date('2026-06-21T11:00:00.000Z'),
          observedCount: 10,
          completedAt: new Date('2026-06-21T12:10:00.000Z'),
        },
        {
          id: 'test-1',
          inboxId: 'inbox-1',
          seedCount: 10,
          primaryCount: null,
          promotionsCount: null,
          spamCount: null,
          missingCount: null,
          primaryPct: null,
          promotionsPct: null,
          spamPct: null,
          placementScore: null,
          status: 'queued',
          createdAt: new Date('2026-06-21T11:00:00.000Z'),
          completedAt: new Date('2026-06-21T11:00:00.000Z'),
        },
      ];
      mockSelectSequence([[inboxRow], rows]);

      const result = await controller.listTests('inbox-1', makeReq('user-1'));

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(
        expect.objectContaining({ status: 'complete', placementScore: 85 }),
      );
      expect(result[1]).toEqual(
        expect.objectContaining({ status: 'pending', placementScore: null, completedAt: null }),
      );
    });
  });

  describe('partial and failed tests', () => {
    const base = {
      id: 'test-1',
      inboxId: 'inbox-1',
      seedCount: 10,
      createdAt: new Date('2026-06-21T11:00:00.000Z'),
      completedAt: new Date('2026-06-21T11:10:00.000Z'),
    };

    it('a partial test reports its coverage alongside percentages over what was observed', () => {
      const response = (controller as any).toResponse({
        ...base,
        status: 'partial',
        observedCount: 5,
        errorCount: 5,
        primaryCount: 4,
        spamCount: 1,
        otherInboxCount: 0,
        missingCount: 0,
        primaryPct: 80,
        promotionsPct: 0,
        spamPct: 20,
        placementScore: 80,
      });
      expect(response).toMatchObject({
        status: 'partial',
        seedCount: 10,
        observedCount: 5,
        errorCount: 5,
        primaryPct: 80,
        spamPct: 20,
        missingPct: 0,
        placementScore: 80,
      });
    });

    it('a failed test shows a reason and no percentages or score — never a zero', () => {
      const response = (controller as any).toResponse({
        ...base,
        status: 'failed',
        observedCount: 0,
        errorCount: 10,
        primaryPct: null,
        promotionsPct: null,
        spamPct: null,
        placementScore: null,
        failureReason:
          'Only 0 of 10 seed mailboxes could be checked, which is too few for a result',
      });
      expect(response).toMatchObject({
        status: 'failed',
        primaryPct: null,
        spamPct: null,
        missingPct: null,
        placementScore: null,
        errorCount: 10,
      });
      expect(response.failureReason).toContain('too few');
    });
  });
});
