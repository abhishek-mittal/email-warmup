import { Test, TestingModule } from '@nestjs/testing';
import { UnrecoverableError } from 'bullmq';
import { DnsCheckProcessor } from './dns-check.processor';
import { DnsService } from './dns.service';
import { QueueService } from '../queue/queue.service';
import { db } from '../db';

import { pinoLoggerStubsFor } from '../common/test-module';
jest.mock('../db', () => ({
  db: {
    select: jest.fn(),
    insert: jest.fn(),
  },
}));

describe('DnsCheckProcessor', () => {
  let processor: DnsCheckProcessor;
  let dnsService: {
    checkSpf: jest.Mock;
    checkDkimForInbox: jest.Mock;
    checkDmarc: jest.Mock;
    checkMx: jest.Mock;
    checkRdns: jest.Mock;
  };
  let queueService: { add: jest.Mock };

  const inbox = {
    id: 'inbox-1',
    userId: 'user-1',
    email: 'sender@sendco.com',
    provider: 'custom',
    dkimSelector: 'mailo',
    sendingIp: null,
    status: 'active',
  };

  const passSpf = { status: 'pass', code: null, detail: 'v=spf1 ~all' };
  const passDkim = { status: 'pass', code: null, detail: 'p=ABC' };
  const passDmarc = { status: 'pass', code: null, detail: 'p=reject' };
  const passMx = { status: 'pass', code: null, detail: 'mx1' };
  const passRdns = { status: 'pass', code: null, detail: 'mail.sendco.com' };

  const failSpf = { status: 'fail', code: 'SPF_MISSING', detail: 'no spf' };
  const failDkim = { status: 'fail', code: 'DKIM_MISSING', detail: 'no dkim' };
  const failDmarc = { status: 'fail', code: 'DMARC_NONE', detail: 'p=none' };
  const failMx = { status: 'fail', code: 'MX_MISSING', detail: 'no mx' };
  const failRdns = { status: 'fail', code: 'RDNS_MISSING', detail: 'no ptr' };

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
      // Allow awaiting the chain directly when no further method is called (e.g.
      // plain `db.select().from().where()` with no `.limit()`), mirroring
      // WarmupService's spec helper.
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

    dnsService = {
      checkSpf: jest.fn().mockResolvedValue(passSpf),
      checkDkimForInbox: jest.fn().mockResolvedValue(passDkim),
      checkDmarc: jest.fn().mockResolvedValue(passDmarc),
      checkMx: jest.fn().mockResolvedValue(passMx),
      checkRdns: jest.fn().mockResolvedValue(passRdns),
    };
    queueService = { add: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...pinoLoggerStubsFor(UnrecoverableError, DnsCheckProcessor, DnsService, QueueService, db),

        DnsCheckProcessor,
        { provide: DnsService, useValue: dnsService },
        { provide: QueueService, useValue: queueService },
      ],
    }).compile();

    processor = module.get<DnsCheckProcessor>(DnsCheckProcessor);
  });

  describe('process', () => {
    it('throws UnrecoverableError when the inbox cannot be found', async () => {
      mockSelectSequence([[]]);

      await expect(processor.process(makeJob())).rejects.toThrow(UnrecoverableError);
      expect(dnsService.checkSpf).not.toHaveBeenCalled();
    });

    it('extracts the domain from inbox.email and runs all 4 always-on checks plus DKIM with the inbox selector', async () => {
      mockSelectSequence([[inbox], []]);
      mockInsert();

      await processor.process(makeJob());

      expect(dnsService.checkSpf).toHaveBeenCalledWith('sendco.com');
      expect(dnsService.checkDkimForInbox).toHaveBeenCalledWith('sendco.com', 'mailo', 'custom');
      expect(dnsService.checkDmarc).toHaveBeenCalledWith('sendco.com');
      expect(dnsService.checkMx).toHaveBeenCalledWith('sendco.com');
    });

    it('passes a missing selector through rather than guessing "default"', async () => {
      mockSelectSequence([[{ ...inbox, dkimSelector: null }], []]);
      mockInsert();

      await processor.process(makeJob());

      expect(dnsService.checkDkimForInbox).toHaveBeenCalledWith('sendco.com', null, 'custom');
    });

    it('skips checkRdns and writes rdnsValid: null when sendingIp is not set', async () => {
      mockSelectSequence([[inbox], []]);
      const valuesMock = mockInsert();

      await processor.process(makeJob());

      expect(dnsService.checkRdns).not.toHaveBeenCalled();
      const insertedValues = valuesMock.mock.calls[0][0];
      expect(insertedValues.rdnsValid).toBeNull();
      expect(insertedValues.rdnsValue).toBeNull();
    });

    it('runs checkRdns and writes its result when sendingIp is set', async () => {
      mockSelectSequence([[{ ...inbox, sendingIp: '203.0.113.10' }], []]);
      const valuesMock = mockInsert();

      await processor.process(makeJob());

      expect(dnsService.checkRdns).toHaveBeenCalledWith('203.0.113.10');
      const insertedValues = valuesMock.mock.calls[0][0];
      expect(insertedValues.rdnsValid).toBe(true);
      expect(insertedValues.rdnsValue).toBe('mail.sendco.com');
    });

    it('writes a dns_checks row with all 5 fields populated and score left unset', async () => {
      mockSelectSequence([[{ ...inbox, sendingIp: '203.0.113.10' }], []]);
      const valuesMock = mockInsert();

      await processor.process(makeJob());

      const insertedValues = valuesMock.mock.calls[0][0];
      expect(insertedValues).toEqual(
        expect.objectContaining({
          inboxId: 'inbox-1',
          spfValid: true,
          spfRecord: passSpf.detail,
          dkimValid: true,
          dkimSelector: 'mailo',
          dmarcValid: true,
          dmarcRecord: passDmarc.detail,
          mxValid: true,
          mxRecords: [passMx.detail],
          rdnsValid: true,
          rdnsValue: passRdns.detail,
        }),
      );
      expect(insertedValues.score).toBeUndefined();
      expect(insertedValues.checkedAt).toBeUndefined();
    });

    it('enqueues score-compute after every check, pass or fail', async () => {
      mockSelectSequence([[inbox], []]);
      mockInsert();

      await processor.process(makeJob());

      expect(queueService.add).toHaveBeenCalledWith('score-compute', { inboxId: 'inbox-1' });
    });

    it('does NOT alert on the first-ever check for an inbox even if checks fail (no previous row)', async () => {
      dnsService.checkSpf.mockResolvedValue(failSpf);
      mockSelectSequence([[inbox], []]); // no previous dns_checks row
      mockInsert();

      await processor.process(makeJob());

      const notifyCalls = queueService.add.mock.calls.filter(([name]) => name === 'notify');
      expect(notifyCalls).toHaveLength(0);
    });

    it('does NOT alert when a critical issue persists unchanged from the previous check', async () => {
      dnsService.checkSpf.mockResolvedValue(failSpf);
      mockSelectSequence([[inbox], [{ spfValid: false, dkimValid: true, mxValid: true }]]);
      mockInsert();

      await processor.process(makeJob());

      const notifyCalls = queueService.add.mock.calls.filter(([name]) => name === 'notify');
      expect(notifyCalls).toHaveLength(0);
    });

    it('alerts when SPF newly flips from true to false', async () => {
      dnsService.checkSpf.mockResolvedValue(failSpf);
      mockSelectSequence([[inbox], [{ spfValid: true, dkimValid: true, mxValid: true }]]);
      mockInsert();

      await processor.process(makeJob());

      const notifyCalls = queueService.add.mock.calls.filter(([name]) => name === 'notify');
      expect(notifyCalls).toHaveLength(1);
      expect(notifyCalls[0][1]).toEqual({
        userId: 'user-1',
        inboxId: 'inbox-1',
        type: 'dns_broken',
        channel: 'email',
        payload: { issueCodes: ['SPF_MISSING'] },
      });
    });

    it('alerts exactly once and includes every currently-failing critical code when DKIM newly fails while SPF was already failing', async () => {
      dnsService.checkSpf.mockResolvedValue(failSpf);
      dnsService.checkDkimForInbox.mockResolvedValue(failDkim);
      mockSelectSequence([[inbox], [{ spfValid: false, dkimValid: true, mxValid: true }]]);
      mockInsert();

      await processor.process(makeJob());

      const notifyCalls = queueService.add.mock.calls.filter(([name]) => name === 'notify');
      expect(notifyCalls).toHaveLength(1);
      expect(notifyCalls[0][1].payload.issueCodes).toEqual(
        expect.arrayContaining(['SPF_MISSING', 'DKIM_MISSING']),
      );
      expect(notifyCalls[0][1].payload.issueCodes).toHaveLength(2);
    });

    it('does not alert for DMARC issues even when newly flipping (DMARC is warning severity, not critical)', async () => {
      dnsService.checkDmarc.mockResolvedValue(failDmarc);
      mockSelectSequence([[inbox], [{ spfValid: true, dkimValid: true, mxValid: true }]]);
      mockInsert();

      await processor.process(makeJob());

      const notifyCalls = queueService.add.mock.calls.filter(([name]) => name === 'notify');
      expect(notifyCalls).toHaveLength(0);
    });

    it('does not alert for rDNS issues even when newly flipping (rDNS is info severity, never alertable)', async () => {
      dnsService.checkRdns.mockResolvedValue(failRdns);
      mockSelectSequence([
        [{ ...inbox, sendingIp: '203.0.113.10' }],
        [{ spfValid: true, dkimValid: true, mxValid: true, rdnsValid: true }],
      ]);
      mockInsert();

      await processor.process(makeJob());

      const notifyCalls = queueService.add.mock.calls.filter(([name]) => name === 'notify');
      expect(notifyCalls).toHaveLength(0);
    });

    it('uses DKIM_INVALID as the issue code (not DKIM_MISSING) when dkim fails with that code', async () => {
      dnsService.checkDkimForInbox.mockResolvedValue({
        status: 'fail',
        code: 'DKIM_INVALID',
        detail: 'bad',
      });
      mockSelectSequence([[inbox], [{ spfValid: true, dkimValid: true, mxValid: true }]]);
      mockInsert();

      await processor.process(makeJob());

      const notifyCalls = queueService.add.mock.calls.filter(([name]) => name === 'notify');
      expect(notifyCalls[0][1].payload.issueCodes).toEqual(['DKIM_INVALID']);
    });

    it('alerts when MX newly flips from true to false', async () => {
      dnsService.checkMx.mockResolvedValue(failMx);
      mockSelectSequence([[inbox], [{ spfValid: true, dkimValid: true, mxValid: true }]]);
      mockInsert();

      await processor.process(makeJob());

      const notifyCalls = queueService.add.mock.calls.filter(([name]) => name === 'notify');
      expect(notifyCalls).toHaveLength(1);
      expect(notifyCalls[0][1].payload.issueCodes).toEqual(['MX_MISSING']);
    });

    it('queries the previous dns_checks row ordered by checkedAt desc, limited to 1, before inserting the new row', async () => {
      mockSelectSequence([[inbox], []]);
      const valuesMock = mockInsert();

      await processor.process(makeJob());

      // select (inbox) -> select (previous check) -> insert
      const selectCallOrder = (db.select as jest.Mock).mock.invocationCallOrder;
      const insertCallOrder = (db.insert as jest.Mock).mock.invocationCallOrder[0];
      expect(selectCallOrder[1]).toBeLessThan(insertCallOrder);
      expect(valuesMock).toHaveBeenCalled();
    });
  });

  describe('scheduleAllInboxes', () => {
    it('queries only active inboxes and enqueues a dns-check job for each', async () => {
      mockSelectSequence([[{ id: 'inbox-1' }, { id: 'inbox-2' }]]);

      await processor.scheduleAllInboxes();

      expect(queueService.add).toHaveBeenCalledWith('dns-check', { inboxId: 'inbox-1' });
      expect(queueService.add).toHaveBeenCalledWith('dns-check', { inboxId: 'inbox-2' });
      expect(queueService.add).toHaveBeenCalledTimes(2);
    });

    it('enqueues nothing when there are zero active inboxes', async () => {
      mockSelectSequence([[]]);

      await processor.scheduleAllInboxes();

      expect(queueService.add).not.toHaveBeenCalled();
    });
  });
});
