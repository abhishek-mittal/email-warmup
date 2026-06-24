import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';
import {
  getLatestAnalysisForInbox,
  getLatestAnalysisForInboxes,
} from '@/analysis/analysis.service';

import { pinoLoggerStubsFor } from '../common/test-module';
jest.mock('@/analysis/analysis.service', () => ({
  getLatestAnalysisForInbox: jest.fn(),
  getLatestAnalysisForInboxes: jest.fn(),
}));

describe('InboxController — batch + GET :id', () => {
  let controller: InboxController;
  let inboxService: {
    batchUpload: jest.Mock;
    findById: jest.Mock;
    connectCustomSmtp: jest.Mock;
    findByUser: jest.Mock;
  };

  function makeReq(userId: string) {
    return { userId } as any;
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    (getLatestAnalysisForInbox as jest.Mock).mockResolvedValue(null);
    (getLatestAnalysisForInboxes as jest.Mock).mockResolvedValue(new Map());

    inboxService = {
      batchUpload: jest.fn(),
      findById: jest.fn(),
      connectCustomSmtp: jest.fn(),
      findByUser: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [InboxController],
      providers: [...pinoLoggerStubsFor(NotFoundException, InboxController, InboxService, getLatestAnalysisForInbox, getLatestAnalysisForInboxes, Map),
      { provide: InboxService, useValue: inboxService }],
    }).compile();

    controller = module.get<InboxController>(InboxController);
  });

  describe('POST /inboxes/batch', () => {
    it('delegates to InboxService.batchUpload with the validated entries and returns the summary', async () => {
      inboxService.batchUpload.mockResolvedValue({ created: 1, failed: [] });

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

      expect(inboxService.batchUpload).toHaveBeenCalledWith('user-1', [
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

  describe('POST /inboxes/batch/csv', () => {
    it('parses the uploaded CSV buffer and delegates to InboxService.batchUpload', async () => {
      inboxService.batchUpload.mockResolvedValue({ created: 1, failed: [] });

      const csv =
        'email,provider,client_id,client_secret,refresh_token\n' +
        'a@domain.com,gmail,cid,csec,rtok\n';
      const file = { buffer: Buffer.from(csv) } as any;

      const result = await controller.batchUploadCsv(makeReq('user-1'), file);

      expect(inboxService.batchUpload).toHaveBeenCalledWith('user-1', [
        {
          email: 'a@domain.com',
          provider: 'gmail',
          clientId: 'cid',
          clientSecret: 'csec',
          refreshToken: 'rtok',
        },
      ]);
      expect(result).toEqual({ created: 1, failed: [] });
    });

    it('throws BadRequestException when no file is uploaded', async () => {
      await expect(
        controller.batchUploadCsv(makeReq('user-1'), undefined as any),
      ).rejects.toThrow();
    });

    it('routes malformed CSV rows into failed[] without calling batchUpload for them, alongside valid rows', async () => {
      inboxService.batchUpload.mockResolvedValue({ created: 1, failed: [] });

      const csv =
        'email,provider,client_id,client_secret,refresh_token\n' +
        'a@domain.com,gmail,cid,csec,rtok\n' +
        'bad@domain.com,gmail,,,\n';
      const file = { buffer: Buffer.from(csv) } as any;

      const result = await controller.batchUploadCsv(makeReq('user-1'), file);

      // The malformed row should never reach InboxService.batchUpload —
      // it's folded directly into the response's failed[] by the controller.
      const passedEntries = inboxService.batchUpload.mock.calls[0][1];
      expect(passedEntries).toHaveLength(1);
      expect(passedEntries[0].email).toBe('a@domain.com');

      expect(result.failed).toContainEqual({
        email: 'bad@domain.com',
        reason: expect.any(String),
      });
    });
  });

  describe('GET /inboxes/:id', () => {
    it('returns the inbox row with its latest analysis attached when owned by the requesting user', async () => {
      const inboxRow = { id: 'inbox-1', userId: 'user-1', email: 'a@domain.com' };
      const analysisRow = { id: 'analysis-1', inboxId: 'inbox-1', healthScore: 90 };
      inboxService.findById.mockResolvedValue(inboxRow);
      (getLatestAnalysisForInbox as jest.Mock).mockResolvedValue(analysisRow);

      const result = await controller.findOne(makeReq('user-1'), 'inbox-1');

      expect(inboxService.findById).toHaveBeenCalledWith('user-1', 'inbox-1');
      expect(getLatestAnalysisForInbox).toHaveBeenCalledWith('inbox-1');
      expect(result).toEqual({ ...inboxRow, analysis: analysisRow });
    });

    it('attaches analysis: null when no analysis row exists yet', async () => {
      const inboxRow = { id: 'inbox-1', userId: 'user-1', email: 'a@domain.com' };
      inboxService.findById.mockResolvedValue(inboxRow);
      (getLatestAnalysisForInbox as jest.Mock).mockResolvedValue(null);

      const result = await controller.findOne(makeReq('user-1'), 'inbox-1');

      expect(result).toEqual({ ...inboxRow, analysis: null });
    });

    it('throws NotFoundException when the inbox does not exist or is not owned by the user', async () => {
      inboxService.findById.mockResolvedValue(null);

      await expect(controller.findOne(makeReq('user-1'), 'inbox-404')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('GET /inboxes', () => {
    it('returns every inbox with its latest analysis attached', async () => {
      const rows = [
        { id: 'inbox-1', userId: 'user-1', email: 'a@domain.com' },
        { id: 'inbox-2', userId: 'user-1', email: 'b@domain.com' },
      ];
      const analysisRow = { id: 'analysis-1', inboxId: 'inbox-1', healthScore: 90 };
      inboxService.findByUser.mockResolvedValue(rows);
      (getLatestAnalysisForInboxes as jest.Mock).mockResolvedValue(
        new Map([['inbox-1', analysisRow]]),
      );

      const result = await controller.findAll(makeReq('user-1'));

      expect(inboxService.findByUser).toHaveBeenCalledWith('user-1');
      expect(getLatestAnalysisForInboxes).toHaveBeenCalledWith(['inbox-1', 'inbox-2']);
      expect(result).toEqual([
        { ...rows[0], analysis: analysisRow },
        { ...rows[1], analysis: null },
      ]);
    });
  });
});
