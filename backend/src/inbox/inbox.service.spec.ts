import { Test, TestingModule } from '@nestjs/testing';
import { InboxService } from './inbox.service';
import { GoogleOAuthService } from './oauth/google-oauth.service';
import { MicrosoftOAuthService } from './oauth/microsoft-oauth.service';
import { BillingService } from '@/billing/billing.service';
import { ImapClientService, ImapNotConfiguredError } from './imap/imap-client.service';
import { SmtpClientService } from './smtp/smtp-client.service';
import { DnsService } from '@/monitor/dns.service';
import { QueueService } from '@/queue/queue.service';
import { db } from '@/db';

import { pinoLoggerStubsFor } from '../common/test-module';
jest.mock('@/db', () => ({
  db: {
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
  },
}));

jest.mock('dns', () => ({
  promises: {
    resolveMx: jest.fn().mockResolvedValue(['mx1.example.com']),
    resolveTxt: jest.fn().mockImplementation((name: string) => {
      if (name.startsWith('_dmarc.')) {
        return Promise.resolve([['v=DMARC1; p=none']]);
      }
      return Promise.resolve([['v=spf1 include:_spf.example.com ~all']]);
    }),
  },
}));

describe('InboxService — pool enrollment on activation (runPrecheck)', () => {
  let service: InboxService;
  let smtpClientService: { verify: jest.Mock };
  let imapClientService: { getConnection: jest.Mock; close: jest.Mock };

  const inboxRow = {
    id: 'inbox-1',
    email: 'sender@sendco.com',
    provider: 'gmail',
  };

  function mockSelectChain(returnValue: any[]) {
    const chain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(returnValue),
    };
    (db.select as jest.Mock).mockReturnValue(chain);
    return chain;
  }

  function mockInsert() {
    (db.insert as jest.Mock).mockImplementation(() => ({
      values: jest.fn().mockResolvedValue(undefined),
    }));
  }

  function mockUpdate() {
    (db.update as jest.Mock).mockReturnValue({
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(undefined),
    });
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    smtpClientService = { verify: jest.fn().mockResolvedValue(undefined) };
    imapClientService = {
      getConnection: jest.fn().mockResolvedValue({
        mailboxCreate: jest.fn().mockResolvedValue(undefined),
        list: jest.fn().mockResolvedValue([{ path: 'INBOX' }]),
      }),
      close: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...pinoLoggerStubsFor(
          InboxService,
          GoogleOAuthService,
          MicrosoftOAuthService,
          BillingService,
          ImapClientService,
          ImapNotConfiguredError,
          SmtpClientService,
          QueueService,
          db,
          Error,
        ),

        InboxService,
        { provide: GoogleOAuthService, useValue: {} },
        { provide: MicrosoftOAuthService, useValue: {} },
        { provide: BillingService, useValue: { assertInboxLimit: jest.fn() } },
        { provide: ImapClientService, useValue: imapClientService },
        { provide: SmtpClientService, useValue: smtpClientService },
        { provide: QueueService, useValue: { addTokenRefresh: jest.fn() } },
        {
          provide: DnsService,
          useValue: {
            checkSpf: jest.fn().mockResolvedValue({ status: 'pass', code: null, detail: '' }),
            checkDkimForInbox: jest
              .fn()
              .mockResolvedValue({ status: 'unknown', code: null, detail: '' }),
            checkDmarc: jest.fn().mockResolvedValue({ status: 'pass', code: null, detail: '' }),
            checkMx: jest.fn().mockResolvedValue({ status: 'pass', code: null, detail: '' }),
          },
        },
      ],
    }).compile();

    service = module.get<InboxService>(InboxService);
  });

  it('does not enroll in the pool or record consent when the owner did not give it', async () => {
    mockSelectChain([inboxRow]);
    mockInsert();
    mockUpdate();

    const steps = await (service as any).runPrecheck('inbox-1', 'gmail');

    expect(steps.smtp && steps.imap && steps.dns).toBe(true);
    // Only the dns_checks row — no pool_members insert without consent.
    const insertMock = db.insert as jest.Mock;
    expect(insertMock).toHaveBeenCalledTimes(1);
    const setCall = (db.update as jest.Mock).mock.results[0].value.set.mock.calls[0][0];
    expect(setCall.status).toBe('active');
    expect(setCall).not.toHaveProperty('poolConsentAt');
  });

  it('records pool consent only when it was explicitly given on the request', async () => {
    mockSelectChain([inboxRow]);
    mockInsert();
    mockUpdate();

    await (service as any).runPrecheck('inbox-1', 'gmail', true);

    const setCall = (db.update as jest.Mock).mock.results[0].value.set.mock.calls[0][0];
    expect(setCall.status).toBe('active');
    expect(setCall.poolConsentAt).toBeInstanceOf(Date);
  });

  it('does not insert a pool_members row when precheck fails (e.g. SMTP verification fails)', async () => {
    smtpClientService.verify.mockRejectedValue(new Error('SMTP down'));
    mockSelectChain([inboxRow]);
    mockInsert();
    mockUpdate();

    await expect((service as any).runPrecheck('inbox-1', 'gmail')).rejects.toThrow();

    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('connects as SMTP-only when custom inbox has no IMAP creds (imaps=skipped, no pool_members row)', async () => {
    // Custom SMTP inbox where the user did not tick "also use IMAP".
    // runPrecheck should still set status=active (SMTP + DNS pass) but
    // skip the IMAP step and skip pool enrollment.
    const customInboxRow = {
      id: 'inbox-2',
      email: 'smtp-only@sendco.com',
      provider: 'custom',
      imapHost: null, // <- no IMAP configured
      imapPort: null,
    };

    // Simulate the real ImapClientService behaviour for a row with no
    // IMAP: it throws ImapNotConfiguredError instead of opening a
    // socket.
    imapClientService.getConnection.mockRejectedValue(new ImapNotConfiguredError('inbox-2'));

    // The runPrecheck does two selects: one to discover whether IMAP
    // was configured (after the IMAP client threw), then one to load
    // the inbox for DNS+pool-enroll. Both return the same row.
    mockSelectChain([customInboxRow, customInboxRow]);
    mockInsert();
    mockUpdate();

    const steps = await (service as any).runPrecheck('inbox-2', 'custom');

    expect(steps.smtp).toBe(true);
    expect(steps.imap).toBe('skipped'); // not false, not true — user opted out
    expect(steps.dns).toBe(true);

    // Should have attempted (and been refused) an IMAP connection —
    // that refusal is what lets us distinguish "no IMAP" from "bad IMAP".
    expect(imapClientService.getConnection).toHaveBeenCalledTimes(1);

    // Should still mark the inbox active (SMTP + DNS are enough to send).
    expect(db.update).toHaveBeenCalled();
    const setCall = (db.update as jest.Mock).mock.results[0].value.set.mock.calls[0][0];
    expect(setCall.status).toBe('active');

    // Should NOT have inserted a pool_members row (warmup needs IMAP).
    const insertMock = db.insert as jest.Mock;
    const poolMembersCall = insertMock.mock.results.find((result) => {
      const valuesCalls = result.value.values.mock.calls;
      return valuesCalls.some((call: any[]) => call[0]?.reputation === 50);
    });
    expect(poolMembersCall).toBeUndefined();
  });

  it('throws when a custom inbox supplied IMAP creds but they fail to connect', async () => {
    // Custom inbox where the user DID tick "use IMAP" and supplied
    // creds, but the creds are wrong. The precheck must surface the
    // failure rather than silently treating it as "no IMAP".
    const customInboxRowWithBadImap = {
      id: 'inbox-3',
      email: 'bad-imap@sendco.com',
      provider: 'custom',
      imapHost: 'imap.sendco.com',
      imapPort: 993,
    };

    imapClientService.getConnection.mockRejectedValue(new Error('auth failed'));

    mockSelectChain([customInboxRowWithBadImap, customInboxRowWithBadImap]);
    mockInsert();
    mockUpdate();

    await expect((service as any).runPrecheck('inbox-3', 'custom')).rejects.toThrow(/auth failed/);
  });

  it('attaches errCode, host, and port to the thrown error when SMTP verify fails', async () => {
    const err = Object.assign(new Error('Invalid login'), { code: 'EAUTH' });
    smtpClientService.verify.mockRejectedValue(err);
    mockSelectChain([{ ...inboxRow, smtpHost: 'smtp.sendco.com', smtpPort: 587 }]);
    mockInsert();
    mockUpdate();

    await expect((service as any).runPrecheck('inbox-1', 'gmail')).rejects.toMatchObject({
      step: 'smtp',
      errCode: 'EAUTH',
      host: 'smtp.sendco.com',
      port: 587,
    });
  });

  it('attaches errCode, host, and port to the thrown error when IMAP verify fails for supplied creds', async () => {
    const customInboxRowWithBadImap = {
      id: 'inbox-3',
      email: 'bad-imap@sendco.com',
      provider: 'custom',
      imapHost: 'imap.sendco.com',
      imapPort: 993,
    };
    const err = Object.assign(new Error('auth failed'), { code: 'IMAP_EAUTH' });
    imapClientService.getConnection.mockRejectedValue(err);
    mockSelectChain([customInboxRowWithBadImap, customInboxRowWithBadImap]);
    mockInsert();
    mockUpdate();

    await expect((service as any).runPrecheck('inbox-3', 'custom')).rejects.toMatchObject({
      step: 'imap',
      errCode: 'IMAP_EAUTH',
      host: 'imap.sendco.com',
      port: 993,
    });
  });

  it('returns a detail object with smtp/imap timing, host, port, and mailbox count on success', async () => {
    mockSelectChain([{ ...inboxRow, smtpHost: 'smtp.sendco.com', smtpPort: 587 }]);
    mockInsert();
    mockUpdate();
    imapClientService.getConnection.mockResolvedValue({
      mailboxCreate: jest.fn().mockResolvedValue(undefined),
      list: jest.fn().mockResolvedValue([{ path: 'INBOX' }, { path: 'WarmupHub' }]),
    });

    const steps = await (service as any).runPrecheck('inbox-1', 'gmail');

    expect(steps.detail.smtp).toMatchObject({ ok: true, host: 'smtp.sendco.com', port: 587 });
    expect(typeof steps.detail.smtp.ms).toBe('number');
    expect(steps.detail.imap).toMatchObject({ ok: true, mailboxCount: 2 });
    expect(typeof steps.detail.imap.ms).toBe('number');
  });
});
