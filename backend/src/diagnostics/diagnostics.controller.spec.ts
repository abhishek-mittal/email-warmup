import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DiagnosticsController } from './diagnostics.controller';
import { BillingService } from '../billing/billing.service';
import { QueueService } from '../queue/queue.service';
import { db } from '../db';

jest.mock('../db', () => ({
  db: {
    select: jest.fn(),
  },
}));

describe('DiagnosticsController', () => {
  let controller: DiagnosticsController;
  let billingService: { assertPlan: jest.Mock };
  let queueService: { add: jest.Mock };

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
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue(result),
      };
      chain.then = (resolve: any) => Promise.resolve(result).then(resolve);
      return chain;
    });
  }

  function makeReq(userId: string) {
    return { userId } as any;
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    billingService = { assertPlan: jest.fn().mockResolvedValue(undefined) };
    queueService = { add: jest.fn().mockResolvedValue({ id: 'job-123' }) };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DiagnosticsController],
      providers: [
        { provide: BillingService, useValue: billingService },
        { provide: QueueService, useValue: queueService },
      ],
    }).compile();

    controller = module.get<DiagnosticsController>(DiagnosticsController);
  });

  describe('getDiagnostics', () => {
    it('throws NotFoundException when the inbox does not exist', async () => {
      mockSelectSequence([[]]);

      await expect(controller.getDiagnostics('inbox-1', makeReq('user-1'))).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws NotFoundException when the inbox belongs to a different user (does not leak existence)', async () => {
      mockSelectSequence([[otherUsersInboxRow]]);

      await expect(controller.getDiagnostics('inbox-2', makeReq('user-1'))).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns empty defaults when no diagnostics row exists yet', async () => {
      mockSelectSequence([[inboxRow], []]);

      const result = await controller.getDiagnostics('inbox-1', makeReq('user-1'));

      expect(result).toEqual({
        issueCodes: [],
        aiAnalysis: null,
        readinessReport: null,
        createdAt: null,
      });
    });

    it('returns the latest diagnostics row mapped to the response shape', async () => {
      const createdAt = new Date('2026-01-01T00:00:00.000Z');
      const analysis = {
        primaryCause: 'SPF missing',
        causes: [],
        fixes: [],
        estimatedRecoveryDays: 3,
      };
      mockSelectSequence([
        [inboxRow],
        [
          {
            issueCodes: ['SPF_MISSING'],
            aiAnalysis: analysis,
            readinessReport: null,
            createdAt,
          },
        ],
      ]);

      const result = await controller.getDiagnostics('inbox-1', makeReq('user-1'));

      expect(result).toEqual({
        issueCodes: ['SPF_MISSING'],
        aiAnalysis: analysis,
        readinessReport: null,
        createdAt: createdAt.toISOString(),
      });
    });

    it('returns aiAnalysis: null for a non-Growth plan row (value stored by the service, just passed through)', async () => {
      mockSelectSequence([
        [inboxRow],
        [
          {
            issueCodes: ['SPF_MISSING'],
            aiAnalysis: null,
            readinessReport: null,
            createdAt: new Date(),
          },
        ],
      ]);

      const result = await controller.getDiagnostics('inbox-1', makeReq('user-1'));

      expect(result.aiAnalysis).toBeNull();
    });
  });

  describe('runDiagnostics', () => {
    it('throws NotFoundException when the inbox does not exist', async () => {
      mockSelectSequence([[]]);

      await expect(controller.runDiagnostics('inbox-1', makeReq('user-1'))).rejects.toThrow(
        NotFoundException,
      );
      expect(billingService.assertPlan).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the inbox belongs to a different user', async () => {
      mockSelectSequence([[otherUsersInboxRow]]);

      await expect(controller.runDiagnostics('inbox-2', makeReq('user-1'))).rejects.toThrow(
        NotFoundException,
      );
    });

    it('hard-rejects (403) a non-Growth+ plan via billingService.assertPlan', async () => {
      mockSelectSequence([[inboxRow]]);
      billingService.assertPlan.mockRejectedValue(new ForbiddenException('nope'));

      await expect(controller.runDiagnostics('inbox-1', makeReq('user-1'))).rejects.toThrow(
        ForbiddenException,
      );
      expect(billingService.assertPlan).toHaveBeenCalledWith('user-1', [
        'growth',
        'agency',
        'enterprise',
      ]);
      expect(queueService.add).not.toHaveBeenCalled();
    });

    it('enqueues a manual diagnostics job and returns the job id as diagnosticId for an eligible plan', async () => {
      mockSelectSequence([[inboxRow]]);

      const result = await controller.runDiagnostics('inbox-1', makeReq('user-1'));

      expect(queueService.add).toHaveBeenCalledWith('diagnostics', {
        inboxId: 'inbox-1',
        triggerType: 'manual',
      });
      expect(result).toEqual({ diagnosticId: 'job-123' });
    });
  });
});
