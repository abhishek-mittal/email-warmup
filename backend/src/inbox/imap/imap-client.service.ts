import { Injectable } from '@nestjs/common';
import { ImapFlow } from 'imapflow';
import { decrypt } from '../../common/crypto';
import { db } from '../../db';
import { inboxes } from '../../db/schema';
import { eq } from 'drizzle-orm';

@Injectable()
export class ImapClientService {
  private pool = new Map<string, ImapFlow>();

  async getConnection(inboxId: string): Promise<ImapFlow> {
    const existing = this.pool.get(inboxId);
    if (existing?.usable) return existing;

    const rows = await db.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    const inbox = rows[0];
    if (!inbox) throw new Error('Inbox not found');

    const auth: any =
      inbox.provider === 'gmail' || inbox.provider === 'outlook'
        ? { user: inbox.email, accessToken: decrypt(inbox.oauthAccessToken!) }
        : { user: inbox.imapUser!, pass: decrypt(inbox.imapPass!) };

    const client = new ImapFlow({
      host: inbox.imapHost || this.imapHostForProvider(inbox.provider),
      port: inbox.imapPort || 993,
      secure: true,
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

  private imapHostForProvider(provider: string): string {
    switch (provider) {
      case 'gmail':
        return 'imap.gmail.com';
      case 'outlook':
        return 'outlook.office365.com';
      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  }
}
