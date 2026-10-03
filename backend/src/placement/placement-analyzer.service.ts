import { Injectable } from '@nestjs/common';
import type { ImapFlow } from 'imapflow';

/**
 * Where a placement-test message was observed in a seed mailbox.
 *  - primary:     the main inbox view
 *  - promotions:  Gmail's Promotions tab
 *  - other_inbox: delivered, but to another inbox category (Social, Updates,
 *                 Forums) or archived out of the inbox by the provider
 *  - spam:        the junk/spam folder
 *  - not_found:   the mailbox was searched successfully and the message is not there
 */
export type Observation = 'primary' | 'promotions' | 'other_inbox' | 'spam' | 'not_found';

interface MailboxInfo {
  path: string;
  specialUse?: string;
  flags?: Set<string>;
}

type FolderProvider = 'outlook' | 'yahoo';

/**
 * Per-provider spam folder names, tried in order before falling back to the
 * \Junk special-use flag.
 */
const SPAM_FOLDER_CANDIDATES: Record<string, string[]> = {
  gmail: ['[Gmail]/Spam'],
  outlook: ['Junk Email', 'Junk'],
  yahoo: ['Bulk Mail', 'Bulk', 'Spam'],
};

// Gmail has exposed category labels under more than one spelling over time.
const PROMOTIONS_LABELS = [
  '\\Category\\Promotions',
  '\\Category_Promotions',
  'CATEGORY_PROMOTIONS',
];
const OTHER_CATEGORY_LABELS = [
  '\\Category\\Social',
  '\\Category_Social',
  'CATEGORY_SOCIAL',
  '\\Category\\Updates',
  '\\Category_Updates',
  'CATEGORY_UPDATES',
  '\\Category\\Forums',
  '\\Category_Forums',
  'CATEGORY_FORUMS',
];

/**
 * Finds a placement-test message in a seed mailbox (MR-05).
 *
 * Every search runs with its mailbox explicitly selected and locked — an IMAP
 * SEARCH with no mailbox selected is a protocol error, not "not found". Any
 * IMAP failure propagates to the caller, which records it as "could not
 * observe"; it is never converted into a placement.
 */
@Injectable()
export class PlacementAnalyzerService {
  async observe(client: ImapFlow, messageId: string, provider: string): Promise<Observation> {
    const mailboxes = (await client.list()) as MailboxInfo[];

    const inboxPath = mailboxes.find((m) => m.specialUse === '\\Inbox')?.path ?? 'INBOX';
    const inInbox = await this.findIn(client, inboxPath, messageId);
    if (inInbox !== null) {
      // Only Gmail splits its inbox into tabs. For every other provider,
      // "in the inbox" is all that can be said.
      return provider === 'gmail'
        ? this.gmailCategory(client, inboxPath, inInbox, messageId)
        : 'primary';
    }

    const spamPath = this.spamFolder(mailboxes, provider);
    if (spamPath && (await this.findIn(client, spamPath, messageId)) !== null) {
      return 'spam';
    }

    // Delivered but neither in the inbox nor in spam (e.g. auto-archived).
    const allMail = mailboxes.find((m) => m.specialUse === '\\All')?.path;
    if (allMail && (await this.findIn(client, allMail, messageId)) !== null) {
      return 'other_inbox';
    }

    return 'not_found';
  }

  /** UID of the message in `path`, or null. Selects and locks the mailbox for the search. */
  private async findIn(client: ImapFlow, path: string, messageId: string): Promise<number | null> {
    const lock = await client.getMailboxLock(path);
    try {
      const uids = await client.search({ header: { 'message-id': messageId } }, { uid: true });
      return uids && uids.length > 0 ? uids[uids.length - 1] : null;
    } finally {
      lock.release();
    }
  }

  private async gmailCategory(
    client: ImapFlow,
    inboxPath: string,
    uid: number,
    messageId: string,
  ): Promise<Observation> {
    const lock = await client.getMailboxLock(inboxPath);
    try {
      // Labels and category search are Gmail extensions. A "gmail" seed
      // reached through a server without them can only be read as inbox.
      if (!client.capabilities.has('X-GM-EXT-1')) return 'primary';
      const message = await client.fetchOne(String(uid), { labels: true }, { uid: true });
      const labels = message && message.labels ? [...message.labels] : [];
      if (labels.some((label) => PROMOTIONS_LABELS.includes(label))) return 'promotions';
      if (labels.some((label) => OTHER_CATEGORY_LABELS.includes(label))) return 'other_inbox';

      // Category membership is not always present in the label list; Gmail's
      // own search syntax is the authoritative way to ask.
      {
        const bare = messageId.replace(/^<|>$/g, '');
        const inCategory = async (category: string) => {
          const hits = await client.search(
            { gmraw: `rfc822msgid:${bare} category:${category}` } as Parameters<
              ImapFlow['search']
            >[0],
            { uid: true },
          );
          return Boolean(hits && hits.length > 0);
        };
        if (await inCategory('promotions')) return 'promotions';
        for (const category of ['social', 'updates', 'forums']) {
          if (await inCategory(category)) return 'other_inbox';
        }
      }
      return 'primary';
    } finally {
      lock.release();
    }
  }

  private spamFolder(mailboxes: MailboxInfo[], provider: string): string | null {
    for (const name of SPAM_FOLDER_CANDIDATES[provider as FolderProvider] ?? []) {
      const byName = mailboxes.find((m) => m.path === name);
      if (byName) return byName.path;
    }
    return mailboxes.find((m) => m.specialUse === '\\Junk')?.path ?? null;
  }
}
