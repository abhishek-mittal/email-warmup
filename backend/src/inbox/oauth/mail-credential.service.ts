import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import { inboxes, poolInboxes, poolMembers } from '../../db/schema';
import { decrypt, encrypt } from '../../common/crypto';
import { QueueService } from '../../queue/queue.service';
import { GoogleOAuthService } from './google-oauth.service';
import { MicrosoftOAuthService } from './microsoft-oauth.service';
import { CredentialRevokedError, OAuthRefreshError, RefreshedToken } from './oauth-errors';

/** Refresh when the stored token has less than this left. */
const REFRESH_SKEW_MS = 5 * 60_000;
/** Providers omit expires_in only when something is off; assume a short life. */
const DEFAULT_EXPIRES_IN_S = 30 * 60;

export const CREDENTIALS_REVOKED_REASON = 'credentials_revoked';

interface CachedToken {
  token: string;
  expiresAt: number;
}

/**
 * The one place that turns stored OAuth credentials into a usable access
 * token (MR-08). SMTP, IMAP and the token-refresh worker all go through here,
 * for interactive, batch-imported and private-pool inboxes alike.
 *
 *  - Refreshes on demand shortly before expiry, never per call.
 *  - One refresh per credential at a time: an in-process in-flight map plus a
 *    Postgres advisory lock so parallel workers/replicas don't race and burn
 *    a rotated refresh token.
 *  - Persists the new expiry and any rotated refresh token, encrypted.
 *  - `invalid_grant` means the grant is gone: the inbox is taken out of
 *    warmup and a CredentialRevokedError is thrown. Any other failure is
 *    temporary and leaves the stored credentials untouched.
 */
@Injectable()
export class MailCredentialService {
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly poolTokenCache = new Map<string, CachedToken>();

  constructor(
    @InjectPinoLogger(MailCredentialService.name)
    private readonly logger: PinoLogger,
    private readonly googleOAuth: GoogleOAuthService,
    private readonly microsoftOAuth: MicrosoftOAuthService,
    private readonly queueService: QueueService,
  ) {}

  /** Access token for an `inboxes` row, refreshed if missing or near expiry. */
  async getInboxAccessToken(inboxId: string, opts: { force?: boolean } = {}): Promise<string> {
    if (!opts.force) {
      const rows = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
      const inbox = rows[0];
      if (!inbox) throw new Error('Inbox not found');
      const fresh = this.usableStoredToken(inbox);
      if (fresh) return fresh;
    }
    return this.singleFlight(`inbox:${inboxId}`, () =>
      this.refreshInbox(inboxId, Boolean(opts.force)),
    );
  }

  /** Access token for a `pool_inboxes` row (cached in memory until near expiry). */
  async getPoolInboxAccessToken(poolInboxId: string): Promise<string> {
    const cached = this.poolTokenCache.get(poolInboxId);
    if (cached && cached.expiresAt - Date.now() > REFRESH_SKEW_MS) {
      return cached.token;
    }
    return this.singleFlight(`pool:${poolInboxId}`, () => this.refreshPoolInbox(poolInboxId));
  }

  private usableStoredToken(inbox: typeof inboxes.$inferSelect): string | null {
    if (!inbox.oauthAccessToken || !inbox.oauthTokenExpiry) return null;
    if (inbox.oauthTokenExpiry.getTime() - Date.now() <= REFRESH_SKEW_MS) return null;
    return decrypt(inbox.oauthAccessToken);
  }

  private singleFlight(key: string, fn: () => Promise<string>): Promise<string> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const promise = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  private async refreshInbox(inboxId: string, force: boolean): Promise<string> {
    try {
      return await db.transaction(async (tx) => {
        // Cross-process lock, released automatically at commit/rollback.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'mail-cred:' + inboxId}))`);

        const rows = await tx.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
        const inbox = rows[0];
        if (!inbox) throw new Error('Inbox not found');

        // Another worker may have refreshed while we waited for the lock.
        if (!force) {
          const fresh = this.usableStoredToken(inbox);
          if (fresh) return fresh;
        }

        if (!inbox.oauthRefreshToken) {
          throw new CredentialRevokedError(inboxId);
        }

        const clientOverride =
          inbox.oauthClientId && inbox.oauthClientSecret
            ? { clientId: inbox.oauthClientId, clientSecret: decrypt(inbox.oauthClientSecret) }
            : undefined;

        this.logger.debug({ inboxId, provider: inbox.provider }, 'OAuth token refresh triggered');
        const refreshed = await this.callProvider(
          inbox.provider,
          decrypt(inbox.oauthRefreshToken),
          clientOverride,
        );

        const expiresInS = refreshed.expires_in || DEFAULT_EXPIRES_IN_S;
        await tx
          .update(inboxes)
          .set({
            oauthAccessToken: encrypt(refreshed.access_token),
            oauthTokenExpiry: new Date(Date.now() + expiresInS * 1000),
            ...(refreshed.refresh_token
              ? { oauthRefreshToken: encrypt(refreshed.refresh_token) }
              : {}),
          })
          .where(eq(inboxes.id, inboxId));

        this.logger.info(
          { inboxId, provider: inbox.provider, rotated: Boolean(refreshed.refresh_token) },
          'OAuth token refreshed',
        );
        return refreshed.access_token;
      });
    } catch (err) {
      if (this.isRevocation(err)) {
        await this.markInboxRevoked(inboxId);
        throw new CredentialRevokedError(inboxId);
      }
      this.logger.warn(
        { inboxId, err: (err as Error)?.message },
        'OAuth token refresh failed (temporary) — stored credentials left untouched',
      );
      throw err;
    }
  }

  private async refreshPoolInbox(poolInboxId: string): Promise<string> {
    const rows = await db
      .select()
      .from(poolInboxes)
      .where(eq(poolInboxes.id, poolInboxId))
      .limit(1);
    const poolInbox = rows[0];
    if (!poolInbox) throw new Error('Pool inbox not found');

    const creds = (poolInbox.encryptedCredentials ?? {}) as Record<string, unknown>;
    const clientId = creds.clientId as string | undefined;
    const clientSecretEncrypted = creds.clientSecret as string | undefined;
    const refreshTokenEncrypted = creds.refreshToken as string | undefined;
    if (!clientId || !clientSecretEncrypted || !refreshTokenEncrypted) {
      throw new Error(`OAuth credentials missing for pool inbox ${poolInboxId}`);
    }

    this.logger.debug(
      { poolInboxId, provider: poolInbox.provider },
      'OAuth token refresh triggered (pool inbox)',
    );

    let refreshed: RefreshedToken;
    try {
      refreshed = await this.callProvider(poolInbox.provider, decrypt(refreshTokenEncrypted), {
        clientId,
        clientSecret: decrypt(clientSecretEncrypted),
      });
    } catch (err) {
      if (this.isRevocation(err)) {
        this.poolTokenCache.delete(poolInboxId);
        await db
          .update(poolInboxes)
          .set({
            status: 'error',
            errorMessage: 'Mailbox access was revoked — reconnect this pool inbox',
            updatedAt: new Date(),
          })
          .where(and(eq(poolInboxes.id, poolInboxId), eq(poolInboxes.status, 'active')));
        this.logger.error({ poolInboxId }, 'pool inbox credentials revoked');
        throw new CredentialRevokedError(poolInboxId);
      }
      this.logger.error(
        { poolInboxId, provider: poolInbox.provider, err: (err as Error)?.message },
        'OAuth token refresh failed (pool inbox)',
      );
      throw err;
    }

    if (refreshed.refresh_token) {
      await db
        .update(poolInboxes)
        .set({
          encryptedCredentials: { ...creds, refreshToken: encrypt(refreshed.refresh_token) },
          updatedAt: new Date(),
        })
        .where(eq(poolInboxes.id, poolInboxId));
    }

    const expiresInS = refreshed.expires_in || DEFAULT_EXPIRES_IN_S;
    this.poolTokenCache.set(poolInboxId, {
      token: refreshed.access_token,
      expiresAt: Date.now() + expiresInS * 1000,
    });
    return refreshed.access_token;
  }

  private callProvider(
    provider: string,
    refreshToken: string,
    clientOverride?: { clientId: string; clientSecret: string },
  ): Promise<RefreshedToken> {
    const service = provider === 'gmail' ? this.googleOAuth : this.microsoftOAuth;
    return service.refreshToken(refreshToken, clientOverride);
  }

  private isRevocation(err: unknown): boolean {
    return (
      err instanceof CredentialRevokedError || (err instanceof OAuthRefreshError && err.revoked)
    );
  }

  /**
   * Takes a revoked inbox out of warmup: it stops sending (status) and stops
   * being offered as a partner (pool membership). The refresh token is kept —
   * it is already useless and overwriting it on reconnect is simpler than
   * reasoning about a half-cleared row. Idempotent: only the first call
   * changes anything, so callers can't spam the owner.
   */
  private async markInboxRevoked(inboxId: string): Promise<void> {
    const changed = await db
      .update(inboxes)
      .set({ status: 'error', statusReason: CREDENTIALS_REVOKED_REASON })
      .where(
        and(
          eq(inboxes.id, inboxId),
          or(isNull(inboxes.statusReason), ne(inboxes.statusReason, CREDENTIALS_REVOKED_REASON)),
        ),
      )
      .returning({ id: inboxes.id, userId: inboxes.userId });
    if (changed.length === 0) return;

    await db.update(poolMembers).set({ active: false }).where(eq(poolMembers.inboxId, inboxId));
    this.logger.error(
      { inboxId },
      'inbox credentials revoked — warmup stopped, reconnect required',
    );

    // Tell the owner once. Only the first transition reaches this point, and
    // the job id makes a duplicate publish a no-op.
    try {
      await this.queueService.add(
        'notify',
        {
          userId: changed[0].userId,
          inboxId,
          type: 'token_revoked',
          channel: 'email',
          payload: {},
        },
        {
          jobId: `notify-token-revoked-${inboxId}-${Date.now()}`,
          attempts: 5,
          backoff: { type: 'exponential', delay: 60_000 },
        },
      );
    } catch (err) {
      this.logger.error(
        { inboxId, err: (err as Error)?.message },
        'could not queue revocation notice',
      );
    }
  }
}
