import { eq } from 'drizzle-orm';
import { db } from '../../src/db';
import { inboxes, poolInboxes, poolMembers } from '../../src/db/schema';
import { encrypt } from '../../src/common/crypto';
import { makePinoLoggerStub } from '../../src/common/pino-logger.stub';
import { BillingService } from '../../src/billing/billing.service';
import { InboxService } from '../../src/inbox/inbox.service';
import { DnsService } from '../../src/monitor/dns.service';
import { AnalysisService } from '../../src/analysis/analysis.service';
import {
  Engine,
  IMAP_HOST,
  IMAP_PORT,
  SMTP_HOST,
  SMTP_PORT,
  buildEngine,
  closeDb,
  createInbox,
  createPoolInbox,
  createUser,
  resetDb,
  uniqueEmail,
} from './harness';

const pass = { status: 'pass', code: null, detail: 'ok' };

describe('connect, consent and activation (MR-08 / MR-10)', () => {
  let engine: Engine;
  let inboxService: InboxService;
  let analysis: AnalysisService;
  let userId: string;

  beforeEach(async () => {
    await resetDb();
    engine = buildEngine();
    userId = await createUser();
    inboxService = new InboxService(
      makePinoLoggerStub(),
      new BillingService(makePinoLoggerStub(), engine.queue as any),
      engine.imap,
      engine.smtp,
      engine.queue as any,
      new DnsService(),
    );
    // `.test` domains have no public DNS; DNS evaluation is not what is under test here.
    jest
      .spyOn(inboxService as any, 'checkDns')
      .mockResolvedValue({ spf: true, dkim: true, dmarc: true, mx: true });
    const dns = {
      checkSpf: jest.fn().mockResolvedValue(pass),
      checkDkim: jest.fn().mockResolvedValue(pass),
      checkDmarc: jest.fn().mockResolvedValue(pass),
      checkMx: jest.fn().mockResolvedValue(pass),
      checkRdns: jest.fn().mockResolvedValue(pass),
    };
    analysis = new AnalysisService(makePinoLoggerStub(), dns as any, engine.smtp, engine.imap);
  });

  afterEach(async () => {
    await engine.imap.onModuleDestroy();
  });

  afterAll(async () => {
    await closeDb();
  });

  function smtpDto(email: string, extra: Record<string, unknown> = {}) {
    return {
      email,
      smtpHost: SMTP_HOST,
      smtpPort: SMTP_PORT,
      smtpUser: email,
      smtpPass: 'mailbox-password',
      useImap: true,
      imapHost: IMAP_HOST,
      imapPort: IMAP_PORT,
      imapUser: email,
      imapPass: 'mailbox-password',
      ...extra,
    };
  }
  const members = (inboxId: string) =>
    db.select().from(poolMembers).where(eq(poolMembers.inboxId, inboxId));
  const inboxRow = async (id: string) =>
    (await db.select().from(inboxes).where(eq(inboxes.id, id)))[0];

  it('connects against real SMTP/IMAP without inventing pool consent', async () => {
    const result = await inboxService.connectCustomSmtp(userId, smtpDto(uniqueEmail('connect')));

    expect((result.precheck as any).smtp).toBe(true);
    expect((result.precheck as any).imap).toBe(true);
    const row = await inboxRow(result.inbox.id);
    expect(row.status).toBe('active');
    expect(row.poolConsentAt).toBeNull();
    expect(await members(row.id)).toHaveLength(0);
  });

  it('never returns credential ciphertext from a connect call', async () => {
    const result = await inboxService.connectCustomSmtp(userId, smtpDto(uniqueEmail('connect')));
    for (const field of [
      'smtpPass',
      'imapPass',
      'oauthAccessToken',
      'oauthRefreshToken',
      'oauthClientSecret',
    ]) {
      expect(result.inbox).not.toHaveProperty(field);
    }
    expect(JSON.stringify(result)).not.toContain((await inboxRow(result.inbox.id)).smtpPass);
  });

  it('enrolls in the shared pool only with explicit consent', async () => {
    const result = await inboxService.connectCustomSmtp(
      userId,
      smtpDto(uniqueEmail('connect'), { poolConsent: true }),
    );

    const row = await inboxRow(result.inbox.id);
    expect(row.poolConsentAt).toBeInstanceOf(Date);
    const rows = await members(row.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].active).toBe(true);
  });

  it('precheck passes when the WarmupHub folder already exists', async () => {
    const email = uniqueEmail('connect');
    await inboxService.connectCustomSmtp(userId, smtpDto(email));
    const again = await inboxService.connectCustomSmtp(
      userId,
      smtpDto(email, { poolConsent: true }),
    );

    expect((again.precheck as any).imap).toBe(true);
    expect(await members(again.inbox.id)).toHaveLength(1);
  });

  it('consent can be granted later and withdrawn, without duplicate memberships', async () => {
    const { inbox } = await inboxService.connectCustomSmtp(userId, smtpDto(uniqueEmail('connect')));

    const granted = await inboxService.setPoolConsent(userId, inbox.id, true);
    expect(granted).toMatchObject({ enrolled: true });
    await inboxService.setPoolConsent(userId, inbox.id, true);
    expect(await members(inbox.id)).toHaveLength(1);

    const withdrawn = await inboxService.setPoolConsent(userId, inbox.id, false);
    expect(withdrawn).toMatchObject({ poolConsentAt: null, enrolled: false });
    expect((await inboxRow(inbox.id)).poolConsentAt).toBeNull();
    expect((await members(inbox.id))[0].active).toBe(false);

    await inboxService.setPoolConsent(userId, inbox.id, true);
    const rows = await members(inbox.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].active).toBe(true);
  });

  it('another user cannot change consent on an inbox they do not own', async () => {
    const { inbox } = await inboxService.connectCustomSmtp(userId, smtpDto(uniqueEmail('connect')));
    const stranger = await createUser();

    expect(await inboxService.setPoolConsent(stranger, inbox.id, true)).toBeNull();
    expect((await inboxRow(inbox.id)).poolConsentAt).toBeNull();
  });

  it('a send-only inbox (no IMAP) is activated but not enrolled as a pool receiver', async () => {
    const email = uniqueEmail('sendonly');
    const { inbox } = await inboxService.connectCustomSmtp(userId, {
      email,
      smtpHost: SMTP_HOST,
      smtpPort: SMTP_PORT,
      smtpUser: email,
      smtpPass: 'mailbox-password',
      poolConsent: true,
    });

    expect((await inboxRow(inbox.id)).status).toBe('active');
    expect(await members(inbox.id)).toHaveLength(0);
  });

  it('enforces the plan inbox cap under concurrent connects (no overrun)', async () => {
    // Trial plan allows 3 inboxes. Five connects fired at once must not race
    // past the cap: exactly 3 succeed, 2 are refused, and the DB holds 3.
    const attempts = Array.from({ length: 5 }, () =>
      inboxService.connectCustomSmtp(userId, smtpDto(uniqueEmail('race'))),
    );
    const settled = await Promise.allSettled(attempts);

    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s) => s.status === 'rejected');
    expect(fulfilled).toHaveLength(3);
    expect(rejected).toHaveLength(2);
    for (const r of rejected as PromiseRejectedResult[]) {
      expect(String(r.reason?.message ?? r.reason)).toMatch(/limit/i);
    }

    const rows = await db.select().from(inboxes).where(eq(inboxes.userId, userId));
    expect(rows.filter((row) => row.status !== 'disconnected')).toHaveLength(3);
  });

  describe('imported inboxes are activated by transport, not by DNS', () => {
    it('activates an imported inbox whose mailbox really accepts its credentials', async () => {
      const inbox = await createInbox(userId, { status: 'pending', poolConsentAt: null });

      await analysis.analyse({ inboxId: inbox.id, userId });

      expect((await inboxRow(inbox.id)).status).toBe('active');
    });

    it('marks an imported inbox as errored when its mail server cannot be reached', async () => {
      const inbox = await createInbox(userId, { status: 'pending', smtpPort: 1 });

      await analysis.analyse({ inboxId: inbox.id, userId });

      const row = await inboxRow(inbox.id);
      expect(row.status).toBe('error');
      expect(row.statusReason).toBe('transport_failed');
      // And the scheduler leaves it alone.
      expect(await engine.warmup.scheduleInbox(inbox.id)).toBe(0);
    });

    it('marks an imported OAuth inbox as errored when its refresh token is rejected', async () => {
      const { OAuthRefreshError } = await import('../../src/inbox/oauth/oauth-errors');
      engine.oauth.refreshToken.mockRejectedValue(
        new OAuthRefreshError('revoked', 'invalid_grant', 400),
      );
      const inbox = await createInbox(userId, {
        status: 'pending',
        provider: 'gmail',
        oauthClientId: 'client',
        oauthClientSecret: encrypt('secret'),
        oauthRefreshToken: encrypt('refresh'),
        smtpHost: null,
        smtpPort: null,
        imapHost: null,
        imapPort: null,
      });

      await analysis.analyse({ inboxId: inbox.id, userId });

      expect((await inboxRow(inbox.id)).status).toBe('error');
    });

    it('a late analysis cannot re-activate an inbox that was paused or a pool inbox that was removed', async () => {
      const inbox = await createInbox(userId, { status: 'paused', statusReason: 'user' });
      const pool = await createPoolInbox(userId, { status: 'removed' });

      await analysis.analyse({ inboxId: inbox.id, userId });
      await analysis.analyse({ poolInboxId: pool.id, userId });

      expect((await inboxRow(inbox.id)).status).toBe('paused');
      expect(
        (await db.select().from(poolInboxes).where(eq(poolInboxes.id, pool.id)))[0].status,
      ).toBe('removed');
    });

    it('a pool inbox that cannot receive is marked errored with a reason', async () => {
      const email = uniqueEmail('pool');
      const pool = await createPoolInbox(userId, {
        email,
        status: 'pending',
        encryptedCredentials: {
          smtpHost: SMTP_HOST,
          smtpPort: SMTP_PORT,
          smtpUser: email,
          smtpPassword: encrypt('mailbox-password'),
          imapHost: IMAP_HOST,
          imapPort: 1,
          imapUser: email,
          imapPassword: encrypt('mailbox-password'),
        },
      });

      await analysis.analyse({ poolInboxId: pool.id, userId });

      const row = (await db.select().from(poolInboxes).where(eq(poolInboxes.id, pool.id)))[0];
      expect(row.status).toBe('error');
      expect(row.errorMessage).toContain('Could not connect');
    });
  });
});
