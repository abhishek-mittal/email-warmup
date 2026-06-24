import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { PlacementService } from './placement.service';
import { SeedListService } from './seed-list.service';
import { SmtpClientService } from '../inbox/smtp/smtp-client.service';
import { QueueService } from '../queue/queue.service';
import { db } from '../db';

jest.mock('../db', () => ({
  db: {
    select: jest.fn(),
    insert: jest.fn(),
  },
}));

describe('PlacementService', () => {
  let service: PlacementService;
  let seedListService: { getSeedAddresses: jest.Mock };
  let smtpClientService: { getTransporter: jest.Mock };
  let queueService: { add: jest.Mock };

  const inboxRow = { id: 'inbox-1', userId: 'user-1', email: 'sender@inboxco.com' };

  /**
   * Each entry in `results` backs one `db.select()...` call, in call order.
   * The returned chain resolves whether the caller stops at `.where()`
   * (e.g. a bare "all rows" query) or continues to `.limit()`.
   */
  function mockSelectSequence(results: any[][]) {
    let call = 0;
    (db.select as jest.Mock).mockImplementation(() => {
      const result = results[call] ?? [];
      call += 1;
      const resolved = Promise.resolve(result);
      return {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue(result),
          then: resolved.then.bind(resolved),
          catch: resolved.catch.bind(resolved),
        }),
      };
    });
  }

  function mockInsert() {
    const valuesMock = jest.fn().mockResolvedValue(undefined);
    (db.insert as jest.Mock).mockReturnValue({ values: valuesMock });
    return valuesMock;
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    seedListService = {
      getSeedAddresses: jest.fn().mockResolvedValue([
        { id: 'seed-1', email: 'seed1@gmail.com', provider: 'gmail' },
        { id: 'seed-2', email: 'seed2@outlook.com', provider: 'outlook' },
      ]),
    };
    smtpClientService = {
      getTransporter: jest.fn().mockResolvedValue({ sendMail: jest.fn().mockResolvedValue({}) }),
    };
    queueService = {
      add: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlacementService,
        { provide: SeedListService, useValue: seedListService },
        { provide: SmtpClientService, useValue: smtpClientService },
        { provide: QueueService, useValue: queueService },
      ],
    }).compile();

    service = module.get<PlacementService>(PlacementService);
  });

  describe('runTest', () => {
    it('sends one email via BCC to all seeds with a shared Message-ID, inserts a pending row, and enqueues placement-test with a 5-min delay', async () => {
      mockSelectSequence([
        [inboxRow], // inbox lookup
        [{ plan: 'starter' }], // user plan lookup
        [], // quota count this month (none yet)
      ]);
      const valuesMock = mockInsert();
      const sendMailMock = jest.fn().mockResolvedValue({});
      smtpClientService.getTransporter.mockResolvedValue({ sendMail: sendMailMock });

      const result = await service.runTest('inbox-1', 'user-1');

      expect(seedListService.getSeedAddresses).toHaveBeenCalledWith('quick');
      expect(sendMailMock).toHaveBeenCalledTimes(1);
      const sendArgs = sendMailMock.mock.calls[0][0];
      expect(sendArgs.bcc).toEqual(['seed1@gmail.com', 'seed2@outlook.com']);
      expect(sendArgs.to).toBeUndefined();
      expect(sendArgs.subject).toMatch(/^\[PT-.+\]/);
      expect(sendArgs.headers['Message-ID']).toMatch(/^<.+@emailwarm\.io>$/);

      expect(valuesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          id: expect.any(String),
          inboxId: 'inbox-1',
          seedCount: 2,
          primaryCount: null,
          promotionsCount: null,
          spamCount: null,
          missingCount: null,
          primaryPct: null,
          promotionsPct: null,
          spamPct: null,
          placementScore: null,
        }),
      );

      expect(queueService.add).toHaveBeenCalledWith(
        'placement-test',
        expect.objectContaining({
          testId: result.testId,
          inboxId: 'inbox-1',
          messageId: sendArgs.headers['Message-ID'],
        }),
        { delay: 5 * 60_000 },
      );

      expect(result.testId).toEqual(expect.any(String));
      expect(result.estimatedReadyAt).toEqual(expect.any(String));
    });

    it('throws a clear 503 instead of letting an empty seed list reach sendMail', async () => {
      // Regression test: previously, an empty seed list (e.g. no rows in
      // seed_inboxes yet) fell through to `transporter.sendMail({ bcc: [] })`
      // with no `to`/`cc` either, which nodemailer rejects with an opaque
      // "No recipients defined" EENVELOPE error — surfaced to API callers as
      // an unhandled 500 with no actionable message.
      mockSelectSequence([
        [inboxRow], // inbox lookup
        [{ plan: 'starter' }], // user plan lookup
        [], // quota count this month (none yet)
      ]);
      seedListService.getSeedAddresses.mockResolvedValue([]);
      const sendMailMock = jest.fn().mockResolvedValue({});
      smtpClientService.getTransporter.mockResolvedValue({ sendMail: sendMailMock });

      await expect(service.runTest('inbox-1', 'user-1')).rejects.toMatchObject({
        status: HttpStatus.SERVICE_UNAVAILABLE,
      });
      expect(sendMailMock).not.toHaveBeenCalled();
    });

    it('does not embed seed credentials in the queue job payload', async () => {
      mockSelectSequence([[inboxRow], [{ plan: 'starter' }], []]);
      mockInsert();

      await service.runTest('inbox-1', 'user-1');

      const jobPayload = queueService.add.mock.calls[0][1];
      expect(JSON.stringify(jobPayload)).not.toMatch(/imapPass|imap_pass/i);
    });

    it('uses the full seed list (35) for a growth-plan user', async () => {
      mockSelectSequence([[inboxRow], [{ plan: 'growth' }], []]);
      mockInsert();

      await service.runTest('inbox-1', 'user-1');

      expect(seedListService.getSeedAddresses).toHaveBeenCalledWith('full');
    });

    it('throws 429 TOO_MANY_REQUESTS when a starter-plan user has already used their monthly quota', async () => {
      mockSelectSequence([
        [inboxRow], // inbox lookup
        [{ plan: 'starter' }], // user plan lookup
        [inboxRow], // assertTestQuota: user's inbox ids
        [{ id: 'prior-test', completedAt: new Date() }], // 1 test already this month
      ]);

      await expect(service.runTest('inbox-1', 'user-1')).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
      });
      expect(seedListService.getSeedAddresses).not.toHaveBeenCalled();
    });

    it('throwing 429 produces an HttpException instance', async () => {
      mockSelectSequence([
        [inboxRow],
        [{ plan: 'starter' }],
        [inboxRow],
        [{ id: 'prior-test', completedAt: new Date() }],
      ]);

      await expect(service.runTest('inbox-1', 'user-1')).rejects.toBeInstanceOf(HttpException);
    });

    it('allows a growth-plan user up to 5 tests/month and blocks the 6th', async () => {
      mockSelectSequence([
        [inboxRow],
        [{ plan: 'growth' }],
        [inboxRow],
        [
          { completedAt: new Date() },
          { completedAt: new Date() },
          { completedAt: new Date() },
          { completedAt: new Date() },
          { completedAt: new Date() },
        ],
      ]);

      await expect(service.runTest('inbox-1', 'user-1')).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
      });
    });

    it('never enforces a quota ceiling for agency/enterprise plans (no quota query at all)', async () => {
      mockSelectSequence([
        [inboxRow], // inbox lookup
        [{ plan: 'agency' }], // user plan lookup
        // assertTestQuota short-circuits before any further db.select call for unlimited plans
      ]);
      mockInsert();

      await expect(service.runTest('inbox-1', 'user-1')).resolves.toEqual(
        expect.objectContaining({ testId: expect.any(String) }),
      );
    });
  });
});
