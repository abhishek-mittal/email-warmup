import { eq } from 'drizzle-orm';
import { db } from '../../src/db';
import { inboxes, poolInboxes, poolMembers } from '../../src/db/schema';
import { decrypt, encrypt } from '../../src/common/crypto';
import { CredentialRevokedError, OAuthRefreshError } from '../../src/inbox/oauth/oauth-errors';
import { TokenRefreshProcessor } from '../../src/inbox/oauth/token-refresh.processor';
import { makePinoLoggerStub } from '../../src/common/pino-logger.stub';
import {
  Engine,
  buildEngine,
  closeDb,
  createInbox,
  createPoolInbox,
  createUser,
  enroll,
  fakeJob,
  resetDb,
} from './harness';

async function row(id: string) {
  return (await db.select().from(inboxes).where(eq(inboxes.id, id)))[0];
}

describe('mail credentials (MR-08)', () => {
  let engine: Engine;
  let userId: string;

  beforeEach(async () => {
    await resetDb();
    engine = buildEngine();
    userId = await createUser();
  });

  afterAll(async () => {
    await closeDb();
  });

  function gmailInbox(overrides: Partial<typeof inboxes.$inferInsert> = {}) {
    return createInbox(userId, {
      provider: 'gmail',
      oauthProvider: 'google',
      oauthAccessToken: encrypt('stored-access'),
      oauthRefreshToken: encrypt('stored-refresh'),
      oauthTokenExpiry: new Date(Date.now() + 30 * 60_000),
      smtpHost: null,
      smtpPort: null,
      imapHost: null,
      imapPort: null,
      ...overrides,
    });
  }

  it('uses the stored token while it is still valid', async () => {
    const inbox = await gmailInbox();
    expect(await engine.credentials.getInboxAccessToken(inbox.id)).toBe('stored-access');
    expect(engine.oauth.refreshToken).not.toHaveBeenCalled();
  });

  it('refreshes an expired token once and stores the new one encrypted', async () => {
    const inbox = await gmailInbox({ oauthTokenExpiry: new Date(Date.now() - 60_000) });
    engine.oauth.refreshToken.mockResolvedValue({ access_token: 'fresh-access', expires_in: 3600 });

    expect(await engine.credentials.getInboxAccessToken(inbox.id)).toBe('fresh-access');
    expect(await engine.credentials.getInboxAccessToken(inbox.id)).toBe('fresh-access');

    expect(engine.oauth.refreshToken).toHaveBeenCalledTimes(1);
    expect(engine.oauth.refreshToken).toHaveBeenCalledWith('stored-refresh', undefined);
    const stored = await row(inbox.id);
    expect(stored.oauthAccessToken).not.toContain('fresh-access');
    expect(decrypt(stored.oauthAccessToken!)).toBe('fresh-access');
    expect(stored.oauthTokenExpiry!.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    expect(decrypt(stored.oauthRefreshToken!)).toBe('stored-refresh');
  });

  it('concurrent callers and a second replica share one refresh', async () => {
    const inbox = await gmailInbox({ oauthTokenExpiry: new Date(Date.now() - 60_000) });
    const replica = buildEngine();
    let calls = 0;
    const slowRefresh = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { access_token: `fresh-${calls}`, expires_in: 3600 };
    };
    engine.oauth.refreshToken.mockImplementation(slowRefresh);
    replica.oauth.refreshToken.mockImplementation(slowRefresh);

    const tokens = await Promise.all([
      engine.credentials.getInboxAccessToken(inbox.id),
      engine.credentials.getInboxAccessToken(inbox.id),
      replica.credentials.getInboxAccessToken(inbox.id),
      replica.credentials.getInboxAccessToken(inbox.id),
    ]);

    expect(calls).toBe(1);
    expect(new Set(tokens)).toEqual(new Set(['fresh-1']));
  });

  it('persists a rotated refresh token', async () => {
    const inbox = await gmailInbox({
      provider: 'outlook',
      oauthProvider: 'microsoft',
      oauthTokenExpiry: new Date(Date.now() - 60_000),
    });
    engine.oauth.refreshToken.mockResolvedValue({
      access_token: 'fresh-access',
      expires_in: 3600,
      refresh_token: 'rotated-refresh',
    });

    await engine.credentials.getInboxAccessToken(inbox.id);

    expect(decrypt((await row(inbox.id)).oauthRefreshToken!)).toBe('rotated-refresh');
  });

  it('a batch-imported inbox (refresh token only) refreshes with its own OAuth app', async () => {
    const inbox = await gmailInbox({
      oauthAccessToken: null,
      oauthTokenExpiry: null,
      oauthClientId: 'customer-client-id',
      oauthClientSecret: encrypt('customer-client-secret'),
    });
    engine.oauth.refreshToken.mockResolvedValue({
      access_token: 'imported-access',
      expires_in: 3600,
    });

    expect(await engine.credentials.getInboxAccessToken(inbox.id)).toBe('imported-access');
    expect(engine.oauth.refreshToken).toHaveBeenCalledWith('stored-refresh', {
      clientId: 'customer-client-id',
      clientSecret: 'customer-client-secret',
    });
  });

  it('a revoked grant stops the inbox and its pool membership, once', async () => {
    const inbox = await gmailInbox({ oauthTokenExpiry: new Date(Date.now() - 60_000) });
    await enroll(inbox);
    engine.oauth.refreshToken.mockRejectedValue(
      new OAuthRefreshError('Token has been expired or revoked.', 'invalid_grant', 400),
    );

    await expect(engine.credentials.getInboxAccessToken(inbox.id)).rejects.toBeInstanceOf(
      CredentialRevokedError,
    );
    await expect(engine.credentials.getInboxAccessToken(inbox.id)).rejects.toBeInstanceOf(
      CredentialRevokedError,
    );

    const stored = await row(inbox.id);
    expect(stored.status).toBe('error');
    expect(stored.statusReason).toBe('credentials_revoked');
    const members = await db.select().from(poolMembers).where(eq(poolMembers.inboxId, inbox.id));
    expect(members.every((m) => m.active === false)).toBe(true);
    // The owner is told exactly once, however many times the refresh is retried.
    const notices = engine.queue.of('notify').filter((j) => j.payload.type === 'token_revoked');
    expect(notices).toHaveLength(1);
    expect(notices[0].payload).toMatchObject({ userId, inboxId: inbox.id, channel: 'email' });
    // A click on Resume cannot bring it back.
    expect(await engine.warmup.resumeInbox(inbox.id)).toBe('error');
  });

  it('a temporary provider failure leaves the stored credentials and status untouched', async () => {
    const inbox = await gmailInbox({ oauthTokenExpiry: new Date(Date.now() - 60_000) });
    engine.oauth.refreshToken.mockRejectedValue(
      new OAuthRefreshError('Service unavailable', 'temporarily_unavailable', 503),
    );

    await expect(engine.credentials.getInboxAccessToken(inbox.id)).rejects.toBeInstanceOf(
      OAuthRefreshError,
    );

    const stored = await row(inbox.id);
    expect(stored.status).toBe('active');
    expect(decrypt(stored.oauthRefreshToken!)).toBe('stored-refresh');
    expect(decrypt(stored.oauthAccessToken!)).toBe('stored-access');
  });

  it('pool inbox tokens are cached and a revoked pool inbox is marked as errored', async () => {
    const poolInbox = await createPoolInbox(userId, {
      provider: 'outlook',
      encryptedCredentials: {
        clientId: 'pool-client',
        clientSecret: encrypt('pool-secret'),
        refreshToken: encrypt('pool-refresh'),
      },
    });
    engine.oauth.refreshToken.mockResolvedValue({
      access_token: 'pool-access',
      expires_in: 3600,
      refresh_token: 'pool-refresh-rotated',
    });

    expect(await engine.credentials.getPoolInboxAccessToken(poolInbox.id)).toBe('pool-access');
    expect(await engine.credentials.getPoolInboxAccessToken(poolInbox.id)).toBe('pool-access');
    expect(engine.oauth.refreshToken).toHaveBeenCalledTimes(1);
    const stored = (await db.select().from(poolInboxes).where(eq(poolInboxes.id, poolInbox.id)))[0];
    expect(decrypt((stored.encryptedCredentials as any).refreshToken)).toBe('pool-refresh-rotated');

    const fresh = buildEngine();
    fresh.oauth.refreshToken.mockRejectedValue(
      new OAuthRefreshError('revoked', 'invalid_grant', 400),
    );
    await expect(fresh.credentials.getPoolInboxAccessToken(poolInbox.id)).rejects.toBeInstanceOf(
      CredentialRevokedError,
    );
    const after = (await db.select().from(poolInboxes).where(eq(poolInboxes.id, poolInbox.id)))[0];
    expect(after.status).toBe('error');
  });

  describe('token-refresh worker', () => {
    function worker() {
      return new TokenRefreshProcessor(
        makePinoLoggerStub(),
        engine.credentials,
        engine.queue as any,
      );
    }

    it('refreshes and re-arms itself', async () => {
      const inbox = await gmailInbox();
      engine.oauth.refreshToken.mockResolvedValue({
        access_token: 'fresh-access',
        expires_in: 3600,
      });

      await worker().process(fakeJob({ inboxId: inbox.id }));

      expect(decrypt((await row(inbox.id)).oauthAccessToken!)).toBe('fresh-access');
      const next = engine.queue.of('token-refresh');
      expect(next).toHaveLength(1);
      expect(next[0].payload).toEqual({ inboxId: inbox.id });
      expect(next[0].opts.delay).toBeGreaterThan(0);
    });

    it('keeps the chain alive through a temporary failure', async () => {
      const inbox = await gmailInbox();
      engine.oauth.refreshToken.mockRejectedValue(
        new OAuthRefreshError('down', 'server_error', 500),
      );

      await worker().process(fakeJob({ inboxId: inbox.id }));

      expect(engine.queue.of('token-refresh')).toHaveLength(1);
      expect((await row(inbox.id)).status).toBe('active');
    });

    it('ends the chain when the grant is revoked or the inbox is not OAuth', async () => {
      const revoked = await gmailInbox();
      engine.oauth.refreshToken.mockRejectedValue(
        new OAuthRefreshError('revoked', 'invalid_grant', 400),
      );
      await worker().process(fakeJob({ inboxId: revoked.id }));

      const custom = await createInbox(userId);
      await worker().process(fakeJob({ inboxId: custom.id }));
      await worker().process(fakeJob({ inboxId: '00000000-0000-0000-0000-000000000000' }));

      expect(engine.queue.of('token-refresh')).toHaveLength(0);
    });
  });
});
