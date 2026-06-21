import { Test, TestingModule } from '@nestjs/testing';
import { InboxService } from './inbox.service';
import { GoogleOAuthService } from './oauth/google-oauth.service';
import { MicrosoftOAuthService } from './oauth/microsoft-oauth.service';
import { BillingService } from '@/billing/billing.service';
import { ImapClientService } from './imap/imap-client.service';
import { SmtpClientService } from './smtp/smtp-client.service';
import { QueueService } from '@/queue/queue.service';
import { db } from '@/db';

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
      }),
      close: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InboxService,
        { provide: GoogleOAuthService, useValue: {} },
        { provide: MicrosoftOAuthService, useValue: {} },
        { provide: BillingService, useValue: { assertInboxLimit: jest.fn() } },
        { provide: ImapClientService, useValue: imapClientService },
        { provide: SmtpClientService, useValue: smtpClientService },
        { provide: QueueService, useValue: { addTokenRefresh: jest.fn() } },
      ],
    }).compile();

    service = module.get<InboxService>(InboxService);
  });

  it('inserts a pool_members row with active=true, reputation=50 when precheck passes', async () => {
    mockSelectChain([inboxRow]);
    mockInsert();
    mockUpdate();

    const steps = await (service as any).runPrecheck('inbox-1', 'gmail');

    expect(steps.smtp && steps.imap && steps.dns).toBe(true);

    // db.insert is called twice during a passing precheck: once for the dns_checks
    // row, once (this fix) for the pool_members row. Find the pool_members insert by
    // its distinguishing field (`inboxId` + `reputation`) rather than assuming order.
    const insertMock = db.insert as jest.Mock;
    expect(insertMock).toHaveBeenCalledTimes(2);

    const poolMembersCallIndex = insertMock.mock.results.findIndex((result) => {
      const valuesCalls = result.value.values.mock.calls;
      return valuesCalls.some((call: any[]) => call[0]?.reputation === 50);
    });
    expect(poolMembersCallIndex).toBeGreaterThanOrEqual(0);

    const valuesArg = insertMock.mock.results[poolMembersCallIndex].value.values.mock.calls[0][0];
    expect(valuesArg).toEqual({
      inboxId: 'inbox-1',
      email: 'sender@sendco.com',
      domain: 'sendco.com',
      provider: 'gmail',
      reputation: 50,
      active: true,
      quarantined: false,
    });
  });

  it('also sets inbox status=active and poolConsentAt when precheck passes', async () => {
    mockSelectChain([inboxRow]);
    mockInsert();
    mockUpdate();

    await (service as any).runPrecheck('inbox-1', 'gmail');

    expect(db.update).toHaveBeenCalled();
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
});
