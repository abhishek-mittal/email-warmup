import { Injectable } from '@nestjs/common';
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
    private readonly googleOAuthService: GoogleOAuthService,
    private readonly microsoftOAuthService: MicrosoftOAuthService,
  ) {}

  async getConnection(inboxId: string): Promise<ImapFlow> {
    const existing = this.pool.get(inboxId);
    if (existing?.usable) return existing;

    const rows = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    const inbox = rows[0];
    if (!inbox) throw new Error('Inbox not found');

    // No IMAP creds on this row at all — surface a typed error so the
    // warmup/placement consumers can no-op instead of throwing.
    if (!inbox.imapHost || !inbox.imapPort) {
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

    const client = new ImapFlow({
      host: inbox.imapHost,
      port: inbox.imapPort,
      secure: inbox.imapPort === 993,
      auth,
      logger: false,
    });

    await client.connect();
    this.pool.set(inboxId, client);
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
    if (existing?.usable) return existing;

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
        throw new ImapNotConfiguredError(poolInboxId);
      }

      client = new ImapFlow({
        host: imapHost,
        port: imapPort,
        secure: imapPort === 993,
        auth: { user: imapUser, pass: decrypt(imapPassword) },
        logger: false,
      });
    } else if (poolInbox.provider === 'gmail' || poolInbox.provider === 'outlook') {
      const clientId = creds.clientId as string | undefined;
      const clientSecretEncrypted = creds.clientSecret as string | undefined;
      const refreshTokenEncrypted = creds.refreshToken as string | undefined;
      if (!clientId || !clientSecretEncrypted || !refreshTokenEncrypted) {
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

      client = new ImapFlow({
        host: poolInbox.provider === 'gmail' ? 'imap.gmail.com' : 'outlook.office365.com',
        port: 993,
        secure: true,
        auth: { user: poolInbox.email, accessToken: access_token },
        logger: false,
      });
    } else {
      throw new ImapNotConfiguredError(poolInboxId);
    }

    await client.connect();
    this.pool.set(key, client);
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
      await client.logout();
      this.pool.delete(key);
    }
  }
}
