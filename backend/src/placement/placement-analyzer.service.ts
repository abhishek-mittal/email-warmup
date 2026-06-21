import { Injectable } from '@nestjs/common';
import type { ImapFlow } from 'imapflow';

export type Placement = 'primary' | 'promotions' | 'spam' | 'missing';
export type FolderProvider = 'outlook' | 'yahoo';

/**
 * Per-provider spam-folder candidate names, tried in order before falling
 * back to specialUse matching. See T014 context addendum #10: Outlook only
 * uses "Junk Email"; Yahoo tries "Bulk Mail" first, then "Spam" as a
 * fallback (Yahoo's folder naming has varied over time).
 */
const SPAM_FOLDER_CANDIDATES: Record<FolderProvider, string[]> = {
  outlook: ['Junk Email'],
  yahoo: ['Bulk Mail', 'Spam'],
};

/**
 * Classifies where a placement-test email landed, by provider. Gmail uses
 * IMAP labels (X-GM-LABELS); Outlook and Yahoo share one folder-based
 * classification (search INBOX, then the provider's spam-folder
 * candidates) since neither has a "Promotions" concept — see addendum #10.
 */
@Injectable()
export class PlacementAnalyzerService {
  /**
   * Gmail: search by Message-ID, then inspect X-GM-LABELS.
   * \Spam -> spam, \Category_Promotions -> promotions, \Inbox (with neither
   * of those) -> primary. \Category_Social and any other unrecognized
   * combination map to 'missing' — there is no dedicated bucket for them in
   * the placement_tests schema (addendum #10).
   */
  async analyzeGmailPlacement(client: ImapFlow, messageId: string): Promise<Placement> {
    const uids = await client.search({ header: { 'message-id': messageId } });
    if (!uids || uids.length === 0) return 'missing';

    const msg = await client.fetchOne(uids[0], { labels: true } as any);
    const labels: string[] = msg && (msg as any).labels ? Array.from((msg as any).labels) : [];

    if (labels.includes('\\Spam')) return 'spam';
    if (labels.includes('\\Category_Promotions')) return 'promotions';
    if (labels.includes('\\Category_Social')) return 'missing';
    if (labels.includes('\\Inbox')) return 'primary';

    return 'missing';
  }

  /**
   * Outlook/Yahoo: search INBOX first, then the provider's spam-folder
   * candidate list (matched by name or specialUse === '\\Junk', same
   * defensive pattern as T009's spamFolderPath). Found in INBOX -> primary;
   * found in a spam-folder candidate -> spam; found nowhere -> missing.
   * Never returns 'promotions' for these providers.
   */
  async analyzeFolderPlacement(
    client: ImapFlow,
    messageId: string,
    provider: FolderProvider,
  ): Promise<Placement> {
    const foundInInbox = await this.searchFolder(client, 'INBOX', messageId);
    if (foundInInbox) return 'primary';

    const spamFolder = await this.resolveSpamFolder(client, provider);
    if (spamFolder) {
      const foundInSpam = await this.searchFolder(client, spamFolder, messageId);
      if (foundInSpam) return 'spam';
    }

    return 'missing';
  }

  private async searchFolder(
    client: ImapFlow,
    mailboxPath: string,
    messageId: string,
  ): Promise<boolean> {
    await client.mailboxOpen(mailboxPath);
    const results = await client.search({ header: { 'message-id': messageId } });
    return Boolean(results && results.length > 0);
  }

  private async resolveSpamFolder(
    client: ImapFlow,
    provider: FolderProvider,
  ): Promise<string | null> {
    const mailboxes = (await client.list()) as Array<{ path: string; specialUse?: string }>;

    for (const candidateName of SPAM_FOLDER_CANDIDATES[provider]) {
      const byName = mailboxes.find((m) => m.path === candidateName);
      if (byName) return byName.path;
    }

    const bySpecialUse = mailboxes.find((m) => m.specialUse === '\\Junk');
    if (bySpecialUse) return bySpecialUse.path;

    return null;
  }
}
