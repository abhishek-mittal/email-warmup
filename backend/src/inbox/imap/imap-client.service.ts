import { Injectable } from '@nestjs/common';
import { ImapFlow } from 'imapflow';
import { decrypt } from '../../common/crypto';
import { db } from '../../db';
import { inboxes } from '../../db/schema';
import { eq } from 'drizzle-orm';

/**
 * Error thrown when a caller asks for an IMAP connection on an inbox that
 * has no IMAP configured (e.g. a custom-SMTP inbox where the user
 * didn't tick the "also use IMAP" box at connect time). Warmup/placement
 * code should catch this and treat it as "this inbox can't receive —
 * skip" rather than as a hard failure.
 */
export class ImapNotConfiguredError extends Error {
  constructor(inboxId: string) {
    super(`IMAP not configured for inbox ${inboxId}`);
    this.name = 'ImapNotConfiguredError';
  }
}

@Injectable()
export class ImapClientService {
  private pool = new Map<string, ImapFlow>();

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
          : (() => { throw new ImapNotConfiguredError(inboxId); })();

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

  async close(inboxId: string): Promise<void> {
    const client = this.pool.get(inboxId);
    if (client) {
      await client.logout();
      this.pool.delete(inboxId);
    }
  }
}
