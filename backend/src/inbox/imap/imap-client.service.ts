import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { ImapFlow } from 'imapflow';
import { decrypt } from '../../common/crypto';
import { db } from '../../db';
import { inboxes, poolInboxes } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { GoogleOAuthService } from '../oauth/google-oauth.service';
import { MicrosoftOAuthService } from '../oauth/microsoft-oauth.service';

/**
 * Error thrown when a caller asks for an IMAP connection on an inbox that
 * has no IMAP configured (e.g. a custom-SMTP inbox where the user
 * didn't tick the "also use IMAP" box at connect time). Warmup/placement
 * code should catch this and treat it as "this inbox can't receive —
 * skip" rather than as a hard failure.
 */
export class ImapNotConfiguredError extends Error {
  constructor(id: string) {
    super(`IMAP not configured for ${id}`);
    this.name = 'ImapNotConfiguredError';
  }
}

// Pool-inbox connections are keyed with this prefix in the same pool map as
// regular inboxes. IDs are random UUIDv4s from separate tables so a
// collision is not realistically possible, but the explicit prefix makes
// intent unambiguous to future readers.
const POOL_INBOX_KEY_PREFIX = 'pool:';

@Injectable()
export class ImapClientService {
  private pool = new Map<string, ImapFlow>();

  constructor(
    @InjectPinoLogger(ImapClientService.name)
    private readonly logger: PinoLogger,
    private readonly googleOAuthService: GoogleOAuthService,
    private readonly microsoftOAuthService: MicrosoftOAuthService,
  ) {}

  async getConnection(inboxId: string): Promise<ImapFlow> {
    const existing = this.pool.get(inboxId);
    if (existing?.usable) {
      this.logger.debug({ inboxId }, 'IMAP connection reused from pool');
      return existing;
    }

    const rows = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    const inbox = rows[0];
    if (!inbox) throw new Error('Inbox not found');

    // No IMAP creds on this row at all — surface a typed error so the
    // warmup/placement consumers can no-op instead of throwing.
    if (!inbox.imapHost || !inbox.imapPort) {
      this.logger.warn({ inboxId }, 'IMAP not configured — skipping receive action');
      throw new ImapNotConfiguredError(inboxId);
    }

    const auth: any =
      inbox.provider === 'gmail' || inbox.provider === 'outlook'
        ? inbox.oauthAccessToken
          ? { user: inbox.email, accessToken: decrypt(inbox.oauthAccessToken) }
          : { user: inbox.email, pass: '' } // should not happen for OAuth inboxes
        : inbox.imapUser && inbox.imapPass
          ? { user: inbox.imapUser, pass: decrypt(inbox.imapPass) }
          : (() => {
              throw new ImapNotConfiguredError(inboxId);
            })();

    this.logger.debug(
      {
        inboxId,
        imapHost: inbox.imapHost,
        imapPort: inbox.imapPort,
        provider: inbox.provider,
      },
      'opening new IMAP connection',
    );

    const client = new ImapFlow({
      host: inbox.imapHost,
      port: inbox.imapPort,
      secure: inbox.imapPort === 993,
      auth,
      // Enable the ImapFlow protocol logger only at debug level — it's
      // extremely chatty and only useful when actively debugging an IMAP
      // issue. Default (info) keeps the terminal clean.
      logger: process.env.LOG_LEVEL === 'debug' ? undefined : false,
    });

    // Attach a quiet 'error' listener BEFORE we hand the client out.
    // imapflow emits 'error' on its ImapFlow instance when the underlying
    // socket drops mid-conversation (ECONNRESET, idle timeout, server
    // shutdown, etc.). Without a listener, Node escalates this to an
    // uncaughtException and CRASHES the entire NestJS process — which
    // is exactly what happened in prod on 2026-06-24. We:
    //  1. Log the error so we know the connection died.
    //  2. Evict it from the pool so the next getConnection() rebuilds
    //     a fresh socket instead of handing out a dead one.
    // The actual IMAP command that triggered the error has already
    // failed (its promise rejected with the same error) — there is no
    // in-flight call to "recover" here.
    client.on('error', (err: unknown) => {
      const e = err as { code?: string; message?: string };
      this.logger.warn(
        {
          inboxId,
          imapHost: inbox.imapHost,
          imapPort: inbox.imapPort,
          err: e?.message,
          errCode: e?.code,
        },
        'IMAP socket error — evicting from pool',
      );
      if (this.pool.get(inboxId) === client) {
        this.pool.delete(inboxId);
      }
    });

    try {
      await client.connect();
    } catch (err: any) {
      this.logger.error(
        {
          inboxId,
          imapHost: inbox.imapHost,
          imapPort: inbox.imapPort,
          provider: inbox.provider,
          err: err?.message,
          errCode: err?.code,
        },
        'IMAP connect failed',
      );
      throw err;
    }
    this.pool.set(inboxId, client);
    this.logger.info({ inboxId, provider: inbox.provider }, 'IMAP connection established');
    return client;
  }

  /**
   * Pool-inbox-aware connection. Loads `pool_inboxes`, parses
   * `encrypted_credentials` per the contract documented in T022, and
   * branches on `provider`:
   *  - 'custom': build ImapFlow directly from the decrypted creds.
   *  - 'gmail'/'outlook': mint a fresh access token via the relevant OAuth
   *    service's refreshToken() (no caching — pool inboxes have no column
   *    to cache an access token in, and this is a low-volume path).
   */
  async getPoolInboxConnection(poolInboxId: string): Promise<ImapFlow> {
    const key = POOL_INBOX_KEY_PREFIX + poolInboxId;
    const existing = this.pool.get(key);
    if (existing?.usable) {
      this.logger.debug({ poolInboxId }, 'IMAP connection reused from pool (pool inbox)');
      return existing;
    }

    const rows = await db
      .select()
      .from(poolInboxes)
      .where(eq(poolInboxes.id, poolInboxId))
      .limit(1);
    const poolInbox = rows[0];
    if (!poolInbox) throw new Error('Pool inbox not found');

    const creds = (poolInbox.encryptedCredentials ?? {}) as Record<string, unknown>;

    let client: ImapFlow;
    if (poolInbox.provider === 'custom') {
      const imapHost = creds.imapHost as string | undefined;
      const imapPort = creds.imapPort as number | undefined;
      const imapUser = creds.imapUser as string | undefined;
      const imapPassword = creds.imapPassword as string | undefined;
      if (!imapHost || !imapPort || !imapUser || !imapPassword) {
        this.logger.warn({ poolInboxId }, 'IMAP not configured — skipping receive action');
        throw new ImapNotConfiguredError(poolInboxId);
      }

      this.logger.debug(
        { poolInboxId, imapHost, imapPort, provider: 'custom' },
        'opening new IMAP connection (pool inbox)',
      );
      client = new ImapFlow({
        host: imapHost,
        port: imapPort,
        secure: imapPort === 993,
        auth: { user: imapUser, pass: decrypt(imapPassword) },
        logger: process.env.LOG_LEVEL === 'debug' ? undefined : false,
      });
    } else if (poolInbox.provider === 'gmail' || poolInbox.provider === 'outlook') {
      const clientId = creds.clientId as string | undefined;
      const clientSecretEncrypted = creds.clientSecret as string | undefined;
      const refreshTokenEncrypted = creds.refreshToken as string | undefined;
      if (!clientId || !clientSecretEncrypted || !refreshTokenEncrypted) {
        this.logger.warn({ poolInboxId }, 'IMAP not configured — skipping receive action');
        throw new ImapNotConfiguredError(poolInboxId);
      }

      const clientSecret = decrypt(clientSecretEncrypted);
      const refreshToken = decrypt(refreshTokenEncrypted);
      const oauthService =
        poolInbox.provider === 'gmail' ? this.googleOAuthService : this.microsoftOAuthService;
      const { access_token } = await oauthService.refreshToken(refreshToken, {
        clientId,
        clientSecret,
      });

      this.logger.debug(
        {
          poolInboxId,
          imapHost: poolInbox.provider === 'gmail' ? 'imap.gmail.com' : 'outlook.office365.com',
          imapPort: 993,
          provider: poolInbox.provider,
        },
        'opening new IMAP connection (pool inbox)',
      );
      client = new ImapFlow({
        host: poolInbox.provider === 'gmail' ? 'imap.gmail.com' : 'outlook.office365.com',
        port: 993,
        secure: true,
        auth: { user: poolInbox.email, accessToken: access_token },
        logger: process.env.LOG_LEVEL === 'debug' ? undefined : false,
      });
    } else {
      this.logger.warn({ poolInboxId }, 'IMAP not configured — skipping receive action');
      throw new ImapNotConfiguredError(poolInboxId);
    }

    // Same 'error' listener pattern as getConnection() above — see the
    // comment there for the rationale (this exact path was the source of
    // the 2026-06-24 ECONNRESET crash that took the whole backend down).
    // Pool key uses the 'pool:' prefix; the eviction check below uses
    // the same key so a dead pool-inbox connection doesn't get handed
    // back out as "usable".
    const hostForLog =
      poolInbox.provider === 'gmail'
        ? 'imap.gmail.com'
        : poolInbox.provider === 'outlook'
          ? 'outlook.office365.com'
          : ((creds.imapHost as string | undefined) ?? 'unknown');
    client.on('error', (err: unknown) => {
      const e = err as { code?: string; message?: string };
      this.logger.warn(
        {
          poolInboxId,
          imapHost: hostForLog,
          provider: poolInbox.provider,
          err: e?.message,
          errCode: e?.code,
        },
        'IMAP socket error (pool inbox) — evicting from pool',
      );
      if (this.pool.get(key) === client) {
        this.pool.delete(key);
      }
    });

    try {
      await client.connect();
    } catch (err: any) {
      this.logger.error(
        {
          poolInboxId,
          provider: poolInbox.provider,
          err: err?.message,
          errCode: err?.code,
        },
        'IMAP connect failed (pool inbox)',
      );
      throw err;
    }
    this.pool.set(key, client);
    this.logger.info(
      { poolInboxId, provider: poolInbox.provider },
      'IMAP connection established (pool inbox)',
    );
    return client;
  }

  async close(id: string): Promise<void> {
    const directKey = this.pool.has(id) ? id : undefined;
    const poolKey = this.pool.has(POOL_INBOX_KEY_PREFIX + id)
      ? POOL_INBOX_KEY_PREFIX + id
      : undefined;
    const key = directKey ?? poolKey;
    if (!key) return;

    const client = this.pool.get(key);
    if (client) {
      this.logger.debug({ id, key }, 'IMAP connection closed');
      await client.logout();
      this.pool.delete(key);
    }
  }
}
