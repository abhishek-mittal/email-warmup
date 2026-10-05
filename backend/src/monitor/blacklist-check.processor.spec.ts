import { Test, TestingModule } from '@nestjs/testing';
import { UnrecoverableError } from 'bullmq';
import { BlacklistCheckProcessor } from './blacklist-check.processor';
import { BlacklistService } from './blacklist.service';
import { QueueService } from '../queue/queue.service';
import { WarmupService } from '../warmup/warmup.service';
import { db } from '../db';
import { RBL_LIST } from './rbl-list';

import { pinoLoggerStubsFor } from '../common/test-module';
jest.mock('../db', () => ({
  db: {
    select: jest.fn(),
    insert: jest.fn(),
  },
}));

describe('BlacklistCheckProcessor', () => {
  let processor: BlacklistCheckProcessor;
  let blacklistService: { check: jest.Mock };
  let queueService: { add: jest.Mock };
  let warmupService: { pauseInbox: jest.Mock };

  const inbox = {
    id: 'inbox-1',
    userId: 'user-1',
    email: 'sender@sendco.com',
    sendingIp: '203.0.113.7',
    status: 'active',
  };

  const cleanResult = {
    isClean: true,
    listed: [],
    listedCount: 0,
    rblResults: Object.fromEntries(RBL_LIST.map((zone) => [zone, 'clean'])),
  };

  const listedResult = {
    isClean: false,
    listed: ['zen.spamhaus.org'],
    listedCount: 1,
    rblResults: {
      ...Object.fromEntries(RBL_LIST.map((zone) => [zone, 'clean'])),
      'zen.spamhaus.org': 'listed',
    },
  };

  function mockSelectSequence(results: any[][]) {
    let call = 0;
    (db.select as jest.Mock).mockImplementation(() => {
      const result = results[call] ?? [];
      call += 1;
      const chain: any = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue(result),
      };
      chain.then = (resolve: any) => Promise.resolve(result).then(resolve);
      return chain;
    });
  }

  function mockInsert() {
    const valuesMock = jest.fn().mockResolvedValue(undefined);
    (db.insert as jest.Mock).mockReturnValue({ values: valuesMock });
    return valuesMock;
  }

  function makeJob(overrides: Partial<{ inboxId: string }> = {}) {
    return { data: { inboxId: 'inbox-1', ...overrides } } as any;
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    blacklistService = { check: jest.fn().mockResolvedValue(cleanResult) };
    queueService = { add: jest.fn().mockResolvedValue(undefined) };
    warmupService = { pauseInbox: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...pinoLoggerStubsFor(
          UnrecoverableError,
          BlacklistCheckProcessor,
          BlacklistService,
          QueueService,
          WarmupService,
          db,
          RBL_LIST,
        ),

        BlacklistCheckProcessor,
        { provide: BlacklistService, useValue: blacklistService },
        { provide: QueueService, useValue: queueService },
        { provide: WarmupService, useValue: warmupService },
      ],
    }).compile();

    processor = module.get<BlacklistCheckProcessor>(BlacklistCheckProcessor);
  });

  describe('process', () => {
    it('throws UnrecoverableError when the inbox cannot be found', async () => {
      mockSelectSequence([[]]);

      await expect(processor.process(makeJob())).rejects.toThrow(UnrecoverableError);
      expect(blacklistService.check).not.toHaveBeenCalled();
    });

    it('extracts the domain from inbox.email and checks it against the RBL list', async () => {
      mockSelectSequence([[inbox]]);
      mockInsert();

      await processor.process(makeJob());

      expect(blacklistService.check).toHaveBeenCalledWith('sendco.com', '203.0.113.7');
    });

    it('writes a blacklist_checks row with isClean, listedCount, and rblResults when clean', async () => {
      mockSelectSequence([[inbox]]);
      const valuesMock = mockInsert();

      await processor.process(makeJob());

      expect(valuesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          inboxId: 'inbox-1',
          isClean: true,
          listedCount: 0,
          rblResults: cleanResult.rblResults,
        }),
      );
    });

    it('does not pause, alert, or trigger diagnostics when the domain is clean', async () => {
      mockSelectSequence([[inbox]]);
      mockInsert();

      await processor.process(makeJob());

      expect(warmupService.pauseInbox).not.toHaveBeenCalled();
      expect(queueService.add).not.toHaveBeenCalledWith('notify', expect.anything());
      expect(queueService.add).not.toHaveBeenCalledWith('diagnostics', expect.anything());
    });

    it('always enqueues score-compute after a check, clean or listed', async () => {
      mockSelectSequence([[inbox]]);
      mockInsert();

      await processor.process(makeJob());

      expect(queueService.add).toHaveBeenCalledWith('score-compute', { inboxId: 'inbox-1' });
    });

    it('writes a blacklist_checks row reflecting the listing when a hit occurs', async () => {
      blacklistService.check.mockResolvedValue(listedResult);
      mockSelectSequence([[inbox]]);
      const valuesMock = mockInsert();

      await processor.process(makeJob());

      expect(valuesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          inboxId: 'inbox-1',
          isClean: false,
          listedCount: 1,
          rblResults: listedResult.rblResults,
        }),
      );
    });

    it('pauses the inbox via warmupService.pauseInbox when a listing is found', async () => {
      blacklistService.check.mockResolvedValue(listedResult);
      mockSelectSequence([[inbox]]);
      mockInsert();

      await processor.process(makeJob());

      expect(warmupService.pauseInbox).toHaveBeenCalledWith('inbox-1', 'blacklist');
    });

    it('pauses the inbox BEFORE enqueueing the blacklist_hit notify job', async () => {
      blacklistService.check.mockResolvedValue(listedResult);
      mockSelectSequence([[inbox]]);
      mockInsert();

      await processor.process(makeJob());

      const pauseCallOrder = warmupService.pauseInbox.mock.invocationCallOrder[0];
      const notifyCall = queueService.add.mock.calls.find(([name]) => name === 'notify');
      const notifyCallIndex = queueService.add.mock.calls.indexOf(notifyCall);
      const notifyCallOrder = queueService.add.mock.invocationCallOrder[notifyCallIndex];

      expect(notifyCall).toBeDefined();
      expect(pauseCallOrder).toBeLessThan(notifyCallOrder);
    });

    it('enqueues a notify job with type blacklist_hit and the listed RBL array when a listing is found', async () => {
      blacklistService.check.mockResolvedValue(listedResult);
      mockSelectSequence([[inbox]]);
      mockInsert();

      await processor.process(makeJob());

      expect(queueService.add).toHaveBeenCalledWith('notify', {
        userId: 'user-1',
        inboxId: 'inbox-1',
        type: 'blacklist_hit',
        channel: 'email',
        payload: { listed: ['zen.spamhaus.org'] },
      });
    });

    it('enqueues a diagnostics job with triggerType auto_blacklist when a listing is found', async () => {
      blacklistService.check.mockResolvedValue(listedResult);
      mockSelectSequence([[inbox]]);
      mockInsert();

      await processor.process(makeJob());

      expect(queueService.add).toHaveBeenCalledWith('diagnostics', {
        inboxId: 'inbox-1',
        triggerType: 'auto_blacklist',
      });
    });

    it('enqueues score-compute after a listing too', async () => {
      blacklistService.check.mockResolvedValue(listedResult);
      mockSelectSequence([[inbox]]);
      mockInsert();

      await processor.process(makeJob());

      expect(queueService.add).toHaveBeenCalledWith('score-compute', { inboxId: 'inbox-1' });
    });
  });

  describe('scheduleAllInboxes', () => {
    it('queries only active inboxes and enqueues a blacklist-check job for each', async () => {
      mockSelectSequence([[{ id: 'inbox-1' }, { id: 'inbox-2' }]]);

      await processor.scheduleAllInboxes();

      expect(queueService.add).toHaveBeenCalledWith('blacklist-check', { inboxId: 'inbox-1' });
      expect(queueService.add).toHaveBeenCalledWith('blacklist-check', { inboxId: 'inbox-2' });
      expect(queueService.add).toHaveBeenCalledTimes(2);
    });

    it('enqueues nothing when there are zero active inboxes', async () => {
      mockSelectSequence([[]]);

      await processor.scheduleAllInboxes();

      expect(queueService.add).not.toHaveBeenCalled();
    });
  });

  describe('when nothing could be checked', () => {
    it('does not pause or alert when every lookup was refused or failed (isClean null)', async () => {
      mockSelectSequence([[inbox]]);
      mockInsert();
      blacklistService.check.mockResolvedValue({
        isClean: null,
        listed: [],
        listedCount: 0,
        rblResults: Object.fromEntries(RBL_LIST.map((zone) => [zone, 'unknown'])),
        checkedCount: 0,
        unknownCount: RBL_LIST.length,
      });

      await processor.process({ id: 'job-1', data: { inboxId: 'inbox-1' } } as any);

      expect(warmupService.pauseInbox).not.toHaveBeenCalled();
      expect(queueService.add).not.toHaveBeenCalledWith('notify', expect.anything());
      expect(queueService.add).not.toHaveBeenCalledWith('diagnostics', expect.anything());
    });
  });
});
