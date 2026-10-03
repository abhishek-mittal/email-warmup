import { createHash } from 'crypto';
import { ForbiddenException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db';
import { inboxes, oauthLinkStates } from '../../src/db/schema';
import { decrypt, encrypt } from '../../src/common/crypto';
import { makePinoLoggerStub } from '../../src/common/pino-logger.stub';
import { InboxService } from '../../src/inbox/inbox.service';
import { DnsService } from '../../src/monitor/dns.service';
import { GoogleOAuthService } from '../../src/inbox/oauth/google-oauth.service';
import { MicrosoftOAuthService } from '../../src/inbox/oauth/microsoft-oauth.service';
import { MailboxLinkService } from '../../src/inbox/oauth/mailbox-link.service';
import { emailFromIdToken } from '../../src/inbox/oauth/id-token';
import { Engine, buildEngine, closeDb, createInbox, createUser, resetDb } from './harness';

function idToken(claims: Record<string, unknown>): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part(claims)}.signature`;
}

describe('mailbox OAuth linking (MR-01)', () => {
  let engine: Engine;
  let google: GoogleOAuthService;
  let microsoft: MicrosoftOAuthService;
  let inboxService: InboxService;
  let link: MailboxLinkService;
  let billing: { assertInboxLimit: jest.Mock };
  let exchange: jest.SpyInstance;
  let userId: string;

  beforeEach(async () => {
    await resetDb();
    await db.delete(oauthLinkStates);
    process.env.APP_URL = 'https://app.example.test';
    engine = buildEngine();
    userId = await createUser();
    google = new GoogleOAuthService();
    microsoft = new MicrosoftOAuthService();
    billing = { assertInboxLimit: jest.fn() };
    inboxService = new InboxService(
      makePinoLoggerStub(),
      billing as any,
      engine.imap,
      engine.smtp,
      engine.queue as any,
      new DnsService(),
    );
    // The pre-check talks to the real provider; it is covered separately
    // against the protocol harness. Here it stands in for "mailbox works".
    jest.spyOn(inboxService as any, 'runPrecheck').mockImplementation(async (...args: any[]) => {
      await db.update(inboxes).set({ status: 'active' }).where(eq(inboxes.id, args[0]));
      return { smtp: true, imap: true, dns: true, detail: {} };
    });
    link = new MailboxLinkService(makePinoLoggerStub(), google, microsoft, inboxService);
    exchange = jest.spyOn(google, 'exchangeCode').mockResolvedValue({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_in: 3600,
      email: 'owner@gmail.com',
    });
    jest.spyOn(microsoft, 'exchangeCode').mockResolvedValue({
      access_token: 'ms-access',
      refresh_token: 'ms-refresh',
      expires_in: 3600,
      email: 'owner@outlook.com',
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  async function startGmail(forUser = userId, opts = {}) {
    const { url } = await link.start(forUser, 'gmail', opts);
    const parsed = new URL(url);
    return { url: parsed, state: parsed.searchParams.get('state')! };
  }
  const userInboxes = (id: string) => db.select().from(inboxes).where(eq(inboxes.userId, id));

  it('issues a random state, stores only its hash, and uses PKCE and a mailbox-only redirect', async () => {
    const { url, state } = await startGmail();

    expect(Buffer.from(state, 'base64url')).toHaveLength(32);
    const [row] = await db.select().from(oauthLinkStates);
    expect(row.stateHash).toBe(createHash('sha256').update(state).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(state);
    expect(row.userId).toBe(userId);
    expect(row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(5 * 60_000);

    // The state carries no identity.
    expect(Buffer.from(state, 'base64url').toString('utf8')).not.toContain(userId);

    const challenge = url.searchParams.get('code_challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(challenge).toBe(
      createHash('sha256').update(decrypt(row.codeVerifier)).digest('base64url'),
    );
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://app.example.test/api/mailbox-oauth/callback/google',
    );
    expect(url.searchParams.get('redirect_uri')).not.toContain('/api/auth/callback');
    expect(url.searchParams.get('scope')).toContain('openid email');

    const second = await startGmail();
    expect(second.state).not.toBe(state);
  });

  it('a valid callback links the mailbox to the user who started it', async () => {
    const { state } = await startGmail(userId, { poolConsent: true });
    const runPrecheck = jest.spyOn(inboxService as any, 'runPrecheck');

    const result = await link.complete(userId, 'gmail', { code: 'auth-code', state });

    const [row] = await db.select().from(oauthLinkStates);
    expect(exchange).toHaveBeenCalledWith('auth-code', decrypt(row.codeVerifier));
    const mine = await userInboxes(userId);
    expect(mine).toHaveLength(1);
    expect(mine[0].email).toBe('owner@gmail.com');
    expect(mine[0].imapHost).toBe('imap.gmail.com');
    expect(decrypt(mine[0].oauthRefreshToken!)).toBe('refresh-1');
    expect(result.inbox).not.toHaveProperty('oauthRefreshToken');
    // Consent chosen at the start of the flow travels with the server-side state.
    expect(runPrecheck).toHaveBeenCalledWith(mine[0].id, 'gmail', true);
    expect(engine.queue.of('token-refresh')).toHaveLength(1);
  });

  describe('rejected before any token exchange', () => {
    afterEach(async () => {
      expect(exchange).not.toHaveBeenCalled();
      expect(await db.select().from(inboxes)).toHaveLength(0);
    });

    it('an edited state', async () => {
      const { state } = await startGmail();
      const edited = state.slice(0, -2) + (state.endsWith('AA') ? 'BB' : 'AA');
      await expect(
        link.complete(userId, 'gmail', { code: 'c', state: edited }),
      ).rejects.toMatchObject({
        code: 'state_invalid',
      });
    });

    it('a forged state naming a user id (the old format)', async () => {
      await startGmail();
      const forged = Buffer.from(JSON.stringify({ userId })).toString('base64url');
      await expect(
        link.complete(userId, 'gmail', { code: 'c', state: forged }),
      ).rejects.toMatchObject({
        code: 'state_invalid',
      });
    });

    it('a state started by a different user', async () => {
      const attacker = await createUser();
      const { state } = await startGmail(attacker);
      await expect(link.complete(userId, 'gmail', { code: 'c', state })).rejects.toMatchObject({
        code: 'state_invalid',
      });
    });

    it('a state issued for the other provider', async () => {
      const { state } = await startGmail();
      await expect(link.complete(userId, 'outlook', { code: 'c', state })).rejects.toMatchObject({
        code: 'state_invalid',
      });
    });

    it('an expired state', async () => {
      const { state } = await startGmail();
      await db.update(oauthLinkStates).set({ expiresAt: new Date(Date.now() - 1000) });
      await expect(link.complete(userId, 'gmail', { code: 'c', state })).rejects.toMatchObject({
        code: 'state_invalid',
      });
    });

    it('a missing state or code', async () => {
      const { state } = await startGmail();
      await expect(link.complete(userId, 'gmail', { code: 'c' })).rejects.toMatchObject({
        code: 'state_invalid',
      });
      await expect(link.complete(userId, 'gmail', { state })).rejects.toMatchObject({
        code: 'state_invalid',
      });
    });

    it('declined consent — and the state cannot be reused afterwards', async () => {
      const { state } = await startGmail();
      await expect(
        link.complete(userId, 'gmail', { state, error: 'access_denied' }),
      ).rejects.toMatchObject({ code: 'denied' });
      await expect(link.complete(userId, 'gmail', { code: 'c', state })).rejects.toMatchObject({
        code: 'state_invalid',
      });
    });
  });

  it('a replayed callback is rejected and links nothing more', async () => {
    const { state } = await startGmail();
    await link.complete(userId, 'gmail', { code: 'auth-code', state });

    await expect(
      link.complete(userId, 'gmail', { code: 'auth-code', state }),
    ).rejects.toMatchObject({
      code: 'state_invalid',
    });
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(await userInboxes(userId)).toHaveLength(1);
  });

  it('concurrent callbacks with the same state link exactly once', async () => {
    const { state } = await startGmail();
    const results = await Promise.allSettled([
      link.complete(userId, 'gmail', { code: 'auth-code', state }),
      link.complete(userId, 'gmail', { code: 'auth-code', state }),
      link.complete(userId, 'gmail', { code: 'auth-code', state }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(await userInboxes(userId)).toHaveLength(1);
  });

  it('a provider failure surfaces a safe message, not provider internals', async () => {
    exchange.mockRejectedValue(new Error('invalid_client: secret sk-live-abc is wrong'));
    const { state } = await startGmail();

    const error = await link.complete(userId, 'gmail', { code: 'c', state }).catch((e) => e);

    expect(error.code).toBe('provider_error');
    expect(JSON.stringify(error.getResponse())).not.toContain('sk-live-abc');
  });

  it('refuses a mailbox already connected to another account', async () => {
    const other = await createUser();
    await createInbox(other, { email: 'Owner@Gmail.com', provider: 'gmail' });
    const { state } = await startGmail();

    await expect(link.complete(userId, 'gmail', { code: 'c', state })).rejects.toMatchObject({
      code: 'duplicate',
    });
    expect(await userInboxes(userId)).toHaveLength(0);
  });

  it('reports the plan limit as a typed error', async () => {
    billing.assertInboxLimit.mockRejectedValue(new ForbiddenException('Inbox limit reached'));
    const { state } = await startGmail();

    await expect(link.complete(userId, 'gmail', { code: 'c', state })).rejects.toMatchObject({
      code: 'limit',
    });
    expect(await userInboxes(userId)).toHaveLength(0);
  });

  it('linking a mailbox the user already has reconnects it in place', async () => {
    const existing = await createInbox(userId, {
      email: 'owner@gmail.com',
      provider: 'gmail',
      status: 'error',
      statusReason: 'credentials_revoked',
      oauthRefreshToken: encrypt('dead-refresh'),
      oauthClientId: 'customer-app',
      oauthClientSecret: encrypt('customer-secret'),
      warmupDay: 12,
    });
    const { state } = await startGmail();

    await link.complete(userId, 'gmail', { code: 'auth-code', state });

    const mine = await userInboxes(userId);
    expect(mine).toHaveLength(1);
    expect(mine[0].id).toBe(existing.id);
    expect(mine[0].status).toBe('active');
    expect(mine[0].statusReason).toBeNull();
    expect(mine[0].warmupDay).toBe(12);
    expect(decrypt(mine[0].oauthRefreshToken!)).toBe('refresh-1');
    expect(mine[0].oauthClientId).toBeNull();
    // A reconnect does not consume another inbox slot.
    expect(billing.assertInboxLimit).not.toHaveBeenCalled();
  });

  it('works for outlook with its own callback and scopes', async () => {
    const { url } = await link.start(userId, 'outlook');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'https://app.example.test/api/mailbox-oauth/callback/microsoft',
    );
    expect(parsed.searchParams.get('scope')).toContain('openid email');

    await link.complete(userId, 'outlook', {
      code: 'c',
      state: parsed.searchParams.get('state')!,
    });
    const mine = await userInboxes(userId);
    expect(mine[0].smtpHost).toBe('smtp.office365.com');
    expect(mine[0].smtpPort).toBe(587);
  });
});

describe('emailFromIdToken', () => {
  it('reads the address from Google and Microsoft style claims', () => {
    expect(emailFromIdToken(idToken({ email: 'Me@Gmail.com', email_verified: true }))).toBe(
      'me@gmail.com',
    );
    expect(emailFromIdToken(idToken({ preferred_username: 'me@contoso.com' }))).toBe(
      'me@contoso.com',
    );
  });

  it('rejects unverified, malformed or missing identities', () => {
    expect(emailFromIdToken(idToken({ email: 'me@gmail.com', email_verified: false }))).toBeNull();
    expect(emailFromIdToken(idToken({ preferred_username: 'not-an-address' }))).toBeNull();
    expect(emailFromIdToken(idToken({}))).toBeNull();
    expect(emailFromIdToken('not.a.jwt')).toBeNull();
    expect(emailFromIdToken(undefined)).toBeNull();
  });
});
