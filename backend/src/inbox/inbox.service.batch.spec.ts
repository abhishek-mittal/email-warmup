import { Test, TestingModule } from '@nestjs/testing';
import { InboxService } from './inbox.service';
import { GoogleOAuthService } from './oauth/google-oauth.service';
import { MicrosoftOAuthService } from './oauth/microsoft-oauth.service';
import { BillingService } from '@/billing/billing.service';
import { ImapClientService } from './imap/imap-client.service';
import { SmtpClientService } from './smtp/smtp-client.service';
import { DnsService } from '@/monitor/dns.service';
import { QueueService } from '@/queue/queue.service';
import { db } from '@/db';
import { encrypt } from '@/common/crypto';

import { pinoLoggerStubsFor } from '../common/test-module';
jest.mock('@/db', () => ({
  db: {
    select: jest.fn(),
    insert: jest.fn(),
    transaction: jest.fn(),
  },
}));

jest.mock('@/common/crypto', () => ({
  encrypt: jest.fn((v: string) => `enc(${v})`),
  decrypt: jest.fn((v: string) => v.replace(/^enc\(/, '').replace(/\)$/, '')),
}));

describe('InboxService.batchUpload', () => {
  let service: InboxService;
  let queueService: { add: jest.Mock };
  let billingService: {
    assertInboxLimit: jest.Mock;
    remainingInboxSlots: jest.Mock;
    lockInboxSlots: jest.Mock;
  };

  function mockSelectExisting(existingEmails: string[]) {
    (db.select as jest.Mock).mockReturnValue({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(existingEmails.map((email) => ({ email }))),
    });
  }

  function mockInsertReturning(idGenerator: () => string) {
    (db.insert as jest.Mock).mockImplementation(() => ({
      values: jest.fn().mockImplementation((vals: any) => ({
        returning: jest.fn().mockResolvedValue([{ ...vals, id: idGenerator() }]),
      })),
    }));
  }

  // batchUpload runs inside a single db.transaction; each row insert is a
  // nested savepoint (tx.transaction). The tx handle reuses the db.select and
  // db.insert mocks so the existing assertions on `db.insert` still apply.
  function wireTransaction() {
    (db.transaction as jest.Mock).mockImplementation(async (cb: (tx: any) => any) =>
      cb({
        execute: jest.fn().mockResolvedValue(undefined),
        select: db.select,
        transaction: jest.fn().mockImplementation(async (spCb: (sp: any) => any) =>
          spCb({ insert: db.insert }),
        ),
      }),
    );
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    (encrypt as jest.Mock).mockImplementation((v: string) => `enc(${v})`);

    queueService = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    billingService = {
      assertInboxLimit: jest.fn(),
      remainingInboxSlots: jest.fn().mockResolvedValue(Number.POSITIVE_INFINITY),
      lockInboxSlots: jest.fn().mockResolvedValue(Number.POSITIVE_INFINITY),
    };
    wireTransaction();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...pinoLoggerStubsFor(
          InboxService,
          GoogleOAuthService,
          MicrosoftOAuthService,
          BillingService,
          ImapClientService,
          SmtpClientService,
          QueueService,
          db,
          encrypt,
        ),

        InboxService,
        { provide: GoogleOAuthService, useValue: {} },
        { provide: MicrosoftOAuthService, useValue: {} },
        { provide: BillingService, useValue: billingService },
        { provide: ImapClientService, useValue: {} },
        { provide: SmtpClientService, useValue: {} },
        { provide: QueueService, useValue: queueService },
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

  it('stops at the plan’s inbox limit and reports the rows it refused', async () => {
    mockSelectExisting([]);
    billingService.lockInboxSlots.mockResolvedValue(2);
    let counter = 0;
    mockInsertReturning(() => `inbox-${++counter}`);
    const entry = (email: string) =>
      ({ email, provider: 'gmail', clientId: 'c', clientSecret: 's', refreshToken: 'r' }) as any;

    const result = await service.batchUpload('user-1', [
      entry('a@one.com'),
      entry('b@two.com'),
      entry('c@three.com'),
      entry('d@four.com'),
    ]);

    expect(result.created).toBe(2);
    expect(result.failed).toEqual([
      { email: 'c@three.com', reason: 'inbox limit reached for your plan' },
      { email: 'd@four.com', reason: 'inbox limit reached for your plan' },
    ]);
    expect(db.insert).toHaveBeenCalledTimes(2);
    expect(queueService.add).toHaveBeenCalledTimes(2);
  });

  it('writes a gmail entry with encrypted clientSecret/refreshToken, status=pending, and enqueues inbox-analysis', async () => {
    mockSelectExisting([]);
    let counter = 0;
    mockInsertReturning(() => `inbox-${++counter}`);

    const result = await service.batchUpload('user-1', [
      {
        email: 'a@domain.com',
        provider: 'gmail',
        clientId: 'cid',
        clientSecret: 'csecret',
        refreshToken: 'rtoken',
      } as any,
    ]);

    expect(result.created).toBe(1);
    expect(result.failed).toEqual([]);

    const insertCall = (db.insert as jest.Mock).mock.results[0].value.values.mock.calls[0][0];
    expect(insertCall).toMatchObject({
      userId: 'user-1',
      email: 'a@domain.com',
      provider: 'gmail',
      oauthProvider: 'google',
      oauthClientId: 'cid',
      oauthClientSecret: 'enc(csecret)',
      oauthRefreshToken: 'enc(rtoken)',
      status: 'pending',
    });
    expect(insertCall.oauthClientSecret).not.toBe('csecret');
    expect(insertCall.oauthRefreshToken).not.toBe('rtoken');

    expect(queueService.add).toHaveBeenCalledWith('inbox-analysis', {
      inboxId: 'inbox-1',
      userId: 'user-1',
    });
  });

  it('writes an outlook entry with oauthProvider=microsoft', async () => {
    mockSelectExisting([]);
    mockInsertReturning(() => 'inbox-1');

    const result = await service.batchUpload('user-1', [
      {
        email: 'b@domain.com',
        provider: 'outlook',
        clientId: 'cid2',
        clientSecret: 'csecret2',
        refreshToken: 'rtoken2',
      } as any,
    ]);

    expect(result.created).toBe(1);
    const insertCall = (db.insert as jest.Mock).mock.results[0].value.values.mock.calls[0][0];
    expect(insertCall.oauthProvider).toBe('microsoft');
  });

  it('writes a custom entry with encrypted smtpPass/imapPass', async () => {
    mockSelectExisting([]);
    mockInsertReturning(() => 'inbox-1');

    const result = await service.batchUpload('user-1', [
      {
        email: 'c@domain.com',
        provider: 'custom',
        smtpHost: 'smtp.domain.com',
        smtpPort: 587,
        smtpUser: 'c@domain.com',
        smtpPassword: 'smtppw',
        imapHost: 'imap.domain.com',
        imapPort: 993,
        imapUser: 'c@domain.com',
        imapPassword: 'imappw',
      } as any,
    ]);

    expect(result.created).toBe(1);
    const insertCall = (db.insert as jest.Mock).mock.results[0].value.values.mock.calls[0][0];
    expect(insertCall).toMatchObject({
      email: 'c@domain.com',
      provider: 'custom',
      smtpHost: 'smtp.domain.com',
      smtpPort: 587,
      smtpUser: 'c@domain.com',
      smtpPass: 'enc(smtppw)',
      imapHost: 'imap.domain.com',
      imapPort: 993,
      imapUser: 'c@domain.com',
      imapPass: 'enc(imappw)',
      status: 'pending',
    });
  });

  it('processes every row independently — one bad row does not block the rest', async () => {
    mockSelectExisting([]);
    let counter = 0;
    mockInsertReturning(() => `inbox-${++counter}`);

    const result = await service.batchUpload('user-1', [
      {
        email: 'good@domain.com',
        provider: 'gmail',
        clientId: 'a',
        clientSecret: 'b',
        refreshToken: 'c',
      } as any,
      { email: 'bad@domain.com', provider: 'gmail' } as any, // missing required oauth fields
      {
        email: 'good2@domain.com',
        provider: 'custom',
        smtpHost: 'h',
        smtpPort: 587,
        smtpUser: 'u',
        smtpPassword: 'p',
        imapHost: 'ih',
        imapPort: 993,
        imapUser: 'iu',
        imapPassword: 'ip',
      } as any,
    ]);

    expect(result.created).toBe(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].email).toBe('bad@domain.com');
    expect(result.failed[0].reason).toBeTruthy();
  });

  it("rejects a duplicate email already present among the user's existing inboxes", async () => {
    mockSelectExisting(['existing@domain.com']);
    mockInsertReturning(() => 'inbox-1');

    const result = await service.batchUpload('user-1', [
      {
        email: 'existing@domain.com',
        provider: 'gmail',
        clientId: 'a',
        clientSecret: 'b',
        refreshToken: 'c',
      } as any,
    ]);

    expect(result.created).toBe(0);
    expect(result.failed).toEqual([
      { email: 'existing@domain.com', reason: expect.stringContaining('duplicate') },
    ]);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('rejects duplicate emails within the same batch (second occurrence fails)', async () => {
    mockSelectExisting([]);
    let counter = 0;
    mockInsertReturning(() => `inbox-${++counter}`);

    const result = await service.batchUpload('user-1', [
      {
        email: 'dup@domain.com',
        provider: 'gmail',
        clientId: 'a',
        clientSecret: 'b',
        refreshToken: 'c',
      } as any,
      {
        email: 'dup@domain.com',
        provider: 'gmail',
        clientId: 'a',
        clientSecret: 'b',
        refreshToken: 'c',
      } as any,
    ]);

    expect(result.created).toBe(1);
    expect(result.failed).toEqual([
      { email: 'dup@domain.com', reason: expect.stringContaining('duplicate') },
    ]);
  });

  it('rejects a structurally malformed row (unknown provider) into failed[]', async () => {
    mockSelectExisting([]);
    mockInsertReturning(() => 'inbox-1');

    const result = await service.batchUpload('user-1', [
      { email: 'x@domain.com', provider: 'yahoo' } as any,
    ]);

    expect(result.created).toBe(0);
    expect(result.failed).toEqual([{ email: 'x@domain.com', reason: expect.any(String) }]);
  });
});
