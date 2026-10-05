import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PoolInboxController } from './pool-inbox.controller';
import { PoolInboxService } from './pool-inbox.service';
import {
  getLatestAnalysisForPoolInboxes,
  getLatestAnalysisForPoolInbox,
  getLatestAnalysisForInboxes,
} from '@/analysis/analysis.service';

import { pinoLoggerStubsFor } from '../common/test-module';
jest.mock('@/analysis/analysis.service', () => ({
  getLatestAnalysisForPoolInboxes: jest.fn(),
  getLatestAnalysisForPoolInbox: jest.fn(),
  getLatestAnalysisForInboxes: jest.fn(),
}));

describe('PoolInboxController', () => {
  let controller: PoolInboxController;
  let service: Record<string, jest.Mock>;

  function makeReq(userId: string) {
    return { userId } as any;
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    (getLatestAnalysisForPoolInboxes as jest.Mock).mockResolvedValue(new Map());
    (getLatestAnalysisForInboxes as jest.Mock).mockResolvedValue(new Map());

    service = {
      batchUpload: jest.fn(),
      create: jest.fn(),
      findByUser: jest.fn(),
      findConsentedOwnedForPool: jest.fn().mockResolvedValue([]),
      findById: jest.fn(),
      softDelete: jest.fn(),
      reanalyze: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PoolInboxController],
      providers: [
        ...pinoLoggerStubsFor(
          PoolInboxController,
          PoolInboxService,
          getLatestAnalysisForPoolInboxes,
          Map,
        ),
        { provide: PoolInboxService, useValue: service },
      ],
    }).compile();

    controller = module.get<PoolInboxController>(PoolInboxController);
  });

  describe('POST /pool-inboxes/batch', () => {
    it('delegates to PoolInboxService.batchUpload and returns the summary', async () => {
      service.batchUpload.mockResolvedValue({ created: 1, failed: [] });

      const result = await controller.batchUpload(makeReq('user-1'), {
        inboxes: [
          {
            email: 'a@domain.com',
            provider: 'gmail',
            clientId: 'a',
            clientSecret: 'b',
            refreshToken: 'c',
          },
        ],
      } as any);

      expect(service.batchUpload).toHaveBeenCalledWith('user-1', [
        {
          email: 'a@domain.com',
          provider: 'gmail',
          clientId: 'a',
          clientSecret: 'b',
          refreshToken: 'c',
        },
      ]);
      expect(result).toEqual({ created: 1, failed: [] });
    });
  });

  describe('POST /pool-inboxes/batch/csv', () => {
    it('parses the uploaded CSV buffer and delegates to PoolInboxService.batchUpload', async () => {
      service.batchUpload.mockResolvedValue({ created: 1, failed: [] });

      const csv =
        'email,provider,smtp_host,smtp_port,smtp_user,smtp_password,imap_host,imap_port,imap_user,imap_password\n' +
        'c@domain.com,custom,smtp.h,587,u,p,imap.h,993,u,p\n';
      const file = { buffer: Buffer.from(csv) } as any;

      const result = await controller.batchUploadCsv(makeReq('user-1'), file);

      expect(service.batchUpload).toHaveBeenCalledWith('user-1', [
        {
          email: 'c@domain.com',
          provider: 'custom',
          smtpHost: 'smtp.h',
          smtpPort: 587,
          smtpUser: 'u',
          smtpPassword: 'p',
          imapHost: 'imap.h',
          imapPort: 993,
          imapUser: 'u',
          imapPassword: 'p',
        },
      ]);
      expect(result).toEqual({ created: 1, failed: [] });
    });

    it('throws BadRequestException when no file is uploaded', async () => {
      await expect(
        controller.batchUploadCsv(makeReq('user-1'), undefined as any),
      ).rejects.toThrow();
    });
  });

  describe('POST /pool-inboxes', () => {
    it('delegates to PoolInboxService.create', async () => {
      const created = { id: 'pi-1', email: 'a@domain.com' };
      service.create.mockResolvedValue(created);

      const result = await controller.createOne(makeReq('user-1'), {
        email: 'a@domain.com',
        provider: 'gmail',
        clientId: 'a',
        clientSecret: 'b',
        refreshToken: 'c',
      } as any);

      expect(service.create).toHaveBeenCalledWith('user-1', {
        email: 'a@domain.com',
        provider: 'gmail',
        clientId: 'a',
        clientSecret: 'b',
        refreshToken: 'c',
      });
      expect(result).toEqual(created);
    });
  });

  describe('GET /pool-inboxes', () => {
    it('returns dedicated pool inboxes tagged source=dedicated with their latest analysis attached', async () => {
      const rows = [{ id: 'pi-1', userId: 'user-1' }];
      const analysisRow = { id: 'analysis-1', poolInboxId: 'pi-1', healthScore: 80 };
      service.findByUser.mockResolvedValue(rows);
      (getLatestAnalysisForPoolInboxes as jest.Mock).mockResolvedValue(
        new Map([['pi-1', analysisRow]]),
      );

      const result = await controller.findAll(makeReq('user-1'));

      expect(service.findByUser).toHaveBeenCalledWith('user-1');
      expect(getLatestAnalysisForPoolInboxes).toHaveBeenCalledWith(['pi-1']);
      expect(result).toEqual([{ ...rows[0], source: 'dedicated', analysis: analysisRow }]);
    });

    it('attaches analysis: null when no analysis row exists yet', async () => {
      const rows = [{ id: 'pi-1', userId: 'user-1' }];
      service.findByUser.mockResolvedValue(rows);
      (getLatestAnalysisForPoolInboxes as jest.Mock).mockResolvedValue(new Map());

      const result = await controller.findAll(makeReq('user-1'));

      expect(result).toEqual([{ ...rows[0], source: 'dedicated', analysis: null }]);
    });

    it('also returns consented own inboxes tagged source=owned, analysis keyed by inbox id', async () => {
      const dedicated = [{ id: 'pi-1', userId: 'user-1' }];
      const owned = [{ id: 'ib-1', userId: 'user-1', email: 'me@mine.com', activePairs: 2 }];
      service.findByUser.mockResolvedValue(dedicated);
      service.findConsentedOwnedForPool.mockResolvedValue(owned);
      (getLatestAnalysisForPoolInboxes as jest.Mock).mockResolvedValue(new Map());
      const ownedAnalysis = { id: 'analysis-9', inboxId: 'ib-1', healthScore: 70 };
      (getLatestAnalysisForInboxes as jest.Mock).mockResolvedValue(
        new Map([['ib-1', ownedAnalysis]]),
      );

      const result = await controller.findAll(makeReq('user-1'));

      expect(service.findConsentedOwnedForPool).toHaveBeenCalledWith('user-1');
      expect(getLatestAnalysisForInboxes).toHaveBeenCalledWith(['ib-1']);
      expect(result).toEqual([
        { ...dedicated[0], source: 'dedicated', analysis: null },
        { ...owned[0], source: 'owned', analysis: ownedAnalysis },
      ]);
    });
  });

  describe('GET /pool-inboxes/:id', () => {
    it('returns the pool inbox row with its latest analysis attached when owned by the requesting user', async () => {
      const row = { id: 'pi-1', userId: 'user-1', email: 'a@domain.com' };
      const analysisRow = { id: 'analysis-1', poolInboxId: 'pi-1', healthScore: 90 };
      service.findById.mockResolvedValue(row);
      (getLatestAnalysisForPoolInbox as jest.Mock).mockResolvedValue(analysisRow);

      const result = await controller.findOne(makeReq('user-1'), 'pi-1');

      expect(service.findById).toHaveBeenCalledWith('user-1', 'pi-1');
      expect(getLatestAnalysisForPoolInbox).toHaveBeenCalledWith('pi-1');
      expect(result).toEqual({ ...row, analysis: analysisRow });
    });

    it('attaches analysis: null when no analysis row exists yet', async () => {
      const row = { id: 'pi-1', userId: 'user-1', email: 'a@domain.com' };
      service.findById.mockResolvedValue(row);
      (getLatestAnalysisForPoolInbox as jest.Mock).mockResolvedValue(null);

      const result = await controller.findOne(makeReq('user-1'), 'pi-1');

      expect(result).toEqual({ ...row, analysis: null });
    });

    it('throws NotFoundException when the pool inbox does not exist or is not owned by the user', async () => {
      service.findById.mockResolvedValue(null);

      await expect(controller.findOne(makeReq('user-1'), 'pi-404')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('DELETE /pool-inboxes/:id', () => {
    it('delegates to PoolInboxService.softDelete', async () => {
      service.softDelete.mockResolvedValue(undefined);

      const result = await controller.remove(makeReq('user-1'), 'pi-1');

      expect(service.softDelete).toHaveBeenCalledWith('user-1', 'pi-1');
      expect(result).toEqual({ success: true });
    });
  });

  describe('POST /pool-inboxes/:id/analyze', () => {
    it('delegates to PoolInboxService.reanalyze and returns nothing (204)', async () => {
      service.reanalyze.mockResolvedValue({ jobId: 'job-42' });

      const result = await controller.reanalyze(makeReq('user-1'), 'pi-1');

      expect(service.reanalyze).toHaveBeenCalledWith('user-1', 'pi-1');
      expect(result).toBeUndefined();
    });

    it('propagates ForbiddenException when the inbox is removed', async () => {
      service.reanalyze.mockRejectedValue(new Error('Pool inbox has been removed.'));

      await expect(controller.reanalyze(makeReq('user-1'), 'pi-1')).rejects.toThrow(/removed/i);
    });
  });
});
