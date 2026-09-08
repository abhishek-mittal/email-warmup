import { Test, TestingModule } from '@nestjs/testing';
import { WarmupReceiveProcessor } from './warmup-receive.processor';
import { ImapClientService, ImapNotConfiguredError } from '../inbox/imap/imap-client.service';
import { SmtpClientService } from '../inbox/smtp/smtp-client.service';
import { ContentService } from './content.service';
import { db } from '../db';

import { pinoLoggerStubsFor } from '../common/test-module';
jest.mock('../db', () => ({
  db: {
    select: jest.fn(),
    update: jest.fn(),
  },
}));

describe('WarmupReceiveProcessor', () => {
  let processor: WarmupReceiveProcessor;
  let imapClientService: { getConnection: jest.Mock; getPoolInboxConnection: jest.Mock };
  let smtpClientService: { getTransporter: jest.Mock; getPoolInboxTransporter: jest.Mock };
  let contentService: { generateReply: jest.Mock };
  let updateSetMock: jest.Mock;
  let updateWhereMock: jest.Mock;

  const receiverInbox = {
    id: 'receiver-1',
    email: 'receiver@receiveco.com',
    provider: 'gmail',
  };

  function makeImapClient(overrides: Partial<Record<string, jest.Mock>> = {}) {
    return {
      usable: true,
      list: jest.fn().mockResolvedValue([
        { path: 'INBOX', specialUse: undefined },
        { path: '[Gmail]/Spam', specialUse: '\\Junk' },
        { path: '[Gmail]/All Mail', specialUse: '\\All' },
      ]),
      mailboxOpen: jest.fn().mockResolvedValue({ path: 'INBOX' }),
      mailboxCreate: jest.fn().mockResolvedValue({ path: 'WarmupHub', created: true }),
      search: jest.fn().mockResolvedValue([1]),
      fetchOne: jest.fn().mockResolvedValue({
        seq: 1,
        uid: 1,
        envelope: { messageId: '<abc@emailwarm.io>' },
        labels: new Set(['\\Inbox']),
      }),
      messageFlagsAdd: jest.fn().mockResolvedValue(true),
      messageMove: jest.fn().mockResolvedValue({ path: 'INBOX', destination: 'WarmupHub' }),
      ...overrides,
    };
  }

  function makeJob(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      data: {
        receiverSource: 'shared',
        receiverId: 'receiver-1',
        messageId: '<abc@emailwarm.io>',
        actions: ['open', 'star'],
        executeAt: '2026-06-20T10:22:00.000Z',
        ...overrides,
      },
    } as any;
  }

  function mockSelectInbox(inbox: any) {
    (db.select as jest.Mock).mockReturnValue({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(inbox ? [inbox] : []),
    });
  }

  function mockUpdate() {
    updateWhereMock = jest.fn().mockResolvedValue(undefined);
    updateSetMock = jest.fn().mockReturnValue({ where: updateWhereMock });
    (db.update as jest.Mock).mockReturnValue({ set: updateSetMock });
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    imapClientService = {
      getConnection: jest.fn(),
      getPoolInboxConnection: jest.fn(),
    };
    smtpClientService = {
      getTransporter: jest.fn(),
      getPoolInboxTransporter: jest.fn(),
    };
    contentService = {
      generateReply: jest.fn().mockResolvedValue({
        subject: 'Re: hello',
        text: 'Replying!',
        html: '<p>Replying!</p>',
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...pinoLoggerStubsFor(
          WarmupReceiveProcessor,
          ImapClientService,
          SmtpClientService,
          ContentService,
          db,
          Set,
          Error,
          ImapNotConfiguredError,
        ),

        WarmupReceiveProcessor,
        { provide: ImapClientService, useValue: imapClientService },
        { provide: SmtpClientService, useValue: smtpClientService },
        { provide: ContentService, useValue: contentService },
      ],
    }).compile();

    processor = module.get<WarmupReceiveProcessor>(WarmupReceiveProcessor);
  });

  it('uses the pooled IMAP connection and never closes it', async () => {
    const client = makeImapClient();
    imapClientService.getConnection.mockResolvedValue(client);
    mockSelectInbox(receiverInbox);
    mockUpdate();

    await processor.process(makeJob());

    expect(imapClientService.getConnection).toHaveBeenCalledWith('receiver-1');
    expect(imapClientService.getConnection).toHaveBeenCalledTimes(1);
  });

  it('marks the message \\Seen for the open action and records opened_at', async () => {
    const client = makeImapClient();
    imapClientService.getConnection.mockResolvedValue(client);
    mockSelectInbox(receiverInbox);
    mockUpdate();

    await processor.process(makeJob({ actions: ['open'] }));

    expect(client.messageFlagsAdd).toHaveBeenCalledWith(expect.anything(), ['\\Seen']);
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ openedAt: expect.any(Date) }),
    );
  });

  it('flags the message \\Flagged for the star action and records starred_at', async () => {
    const client = makeImapClient();
    imapClientService.getConnection.mockResolvedValue(client);
    mockSelectInbox(receiverInbox);
    mockUpdate();

    await processor.process(makeJob({ actions: ['star'] }));

    expect(client.messageFlagsAdd).toHaveBeenCalledWith(expect.anything(), ['\\Flagged']);
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ starredAt: expect.any(Date) }),
    );
  });

  it('sends a reply via SMTP for the reply action and records replied_at', async () => {
    const client = makeImapClient();
    imapClientService.getConnection.mockResolvedValue(client);
    mockSelectInbox(receiverInbox);
    mockUpdate();
    const sendMailMock = jest.fn().mockResolvedValue({ messageId: 'whatever' });
    smtpClientService.getTransporter.mockResolvedValue({ sendMail: sendMailMock });

    await processor.process(makeJob({ actions: ['reply'] }));

    expect(contentService.generateReply).toHaveBeenCalled();
    expect(smtpClientService.getTransporter).toHaveBeenCalledWith('receiver-1');
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ repliedAt: expect.any(Date) }),
    );
  });

  it('always moves the message to WarmupHub as the final step and records filed_at', async () => {
    const client = makeImapClient();
    imapClientService.getConnection.mockResolvedValue(client);
    mockSelectInbox(receiverInbox);
    mockUpdate();

    await processor.process(makeJob({ actions: [] }));

    expect(client.messageMove).toHaveBeenCalledWith(expect.anything(), 'WarmupHub');
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ filedAt: expect.any(Date) }),
    );
  });

  it('files to WarmupHub even when actions is empty (never leaves mail in the real inbox)', async () => {
    const client = makeImapClient();
    imapClientService.getConnection.mockResolvedValue(client);
    mockSelectInbox(receiverInbox);
    mockUpdate();

    await processor.process(makeJob({ actions: [] }));

    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    expect(client.messageMove).toHaveBeenCalledWith(expect.anything(), 'WarmupHub');
  });

  it('rescues from spam before any other action when message found in spam and "rescue" requested', async () => {
    const order: string[] = [];
    const client = makeImapClient();
    // First mailbox checked is INBOX (miss), second is Spam (hit). After the
    // rescue move, INBOX is re-checked and must hit this time (relocated).
    client.search.mockImplementation(async () => {
      const opened = client.mailboxOpen.mock.calls.at(-1)?.[0];
      return opened === '[Gmail]/Spam' || client.mailboxOpen.mock.calls.length > 2 ? [1] : [];
    });
    client.messageMove.mockImplementation(async (_seq: unknown, dest: string) => {
      order.push(`move:${dest}`);
      return { path: '[Gmail]/Spam', destination: dest };
    });
    client.messageFlagsAdd.mockImplementation(async (_seq: unknown, flags: string[]) => {
      order.push(`flag:${flags[0]}`);
      return true;
    });
    imapClientService.getConnection.mockResolvedValue(client);
    mockSelectInbox(receiverInbox);
    mockUpdate();

    await processor.process(makeJob({ actions: ['rescue', 'open', 'star'] }));

    expect(order[0]).toBe('move:INBOX');
    expect(order).toContain('move:WarmupHub');
    expect(order.indexOf('move:INBOX')).toBeLessThan(order.indexOf('flag:\\Seen'));
    expect(order.indexOf('move:INBOX')).toBeLessThan(order.indexOf('move:WarmupHub'));
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ rescuedAt: expect.any(Date), landedInSpam: true }),
    );
  });

  it('sets landed_in_spam = true when found in spam even if "rescue" was not requested', async () => {
    const client = makeImapClient();
    client.search.mockImplementation(async () => {
      const opened = client.mailboxOpen.mock.calls.at(-1)?.[0];
      return opened === '[Gmail]/Spam' ? [1] : [];
    });
    imapClientService.getConnection.mockResolvedValue(client);
    mockSelectInbox(receiverInbox);
    mockUpdate();

    await processor.process(makeJob({ actions: ['open'] }));

    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ landedInSpam: true }));
    // No rescue requested -> no move out of spam before filing, only the final WarmupHub move.
    expect(client.messageMove).toHaveBeenCalledTimes(1);
    expect(client.messageMove).toHaveBeenCalledWith(expect.anything(), 'WarmupHub');
  });

  it('does not rescue when "rescue" is absent from actions even if found in spam', async () => {
    const client = makeImapClient();
    client.search.mockImplementation(async () => {
      const opened = client.mailboxOpen.mock.calls.at(-1)?.[0];
      return opened === '[Gmail]/Spam' ? [1] : [];
    });
    imapClientService.getConnection.mockResolvedValue(client);
    mockSelectInbox(receiverInbox);
    mockUpdate();

    await processor.process(makeJob({ actions: ['open'] }));

    expect(client.messageMove).not.toHaveBeenCalledWith(
      expect.anything(),
      'INBOX',
      expect.anything(),
    );
  });

  it('detects Outlook junk folder ("Junk Email") for rescue', async () => {
    const outlookInbox = { ...receiverInbox, provider: 'outlook' };
    const client = makeImapClient({
      list: jest.fn().mockResolvedValue([
        { path: 'INBOX', specialUse: undefined },
        { path: 'Junk Email', specialUse: '\\Junk' },
      ]),
    });
    client.search.mockImplementation(async () => {
      const opened = client.mailboxOpen.mock.calls.at(-1)?.[0];
      return opened === 'Junk Email' || client.mailboxOpen.mock.calls.length > 2 ? [1] : [];
    });
    imapClientService.getConnection.mockResolvedValue(client);
    mockSelectInbox(outlookInbox);
    mockUpdate();

    await processor.process(makeJob({ actions: ['rescue'] }));

    expect(client.messageMove).toHaveBeenCalledWith(expect.anything(), 'INBOX');
  });

  it('creates the WarmupHub mailbox when it does not already exist before filing', async () => {
    const client = makeImapClient();
    imapClientService.getConnection.mockResolvedValue(client);
    mockSelectInbox(receiverInbox);
    mockUpdate();

    await processor.process(makeJob({ actions: [] }));

    expect(client.mailboxCreate).toHaveBeenCalledWith('WarmupHub');
  });

  it('swallows an "already exists" error from mailboxCreate and still files the message', async () => {
    const client = makeImapClient({
      mailboxCreate: jest.fn().mockRejectedValue(new Error('Mailbox already exists')),
    });
    imapClientService.getConnection.mockResolvedValue(client);
    mockSelectInbox(receiverInbox);
    mockUpdate();

    await processor.process(makeJob({ actions: [] }));

    expect(client.mailboxCreate).toHaveBeenCalledWith('WarmupHub');
    expect(client.messageMove).toHaveBeenCalledWith(expect.anything(), 'WarmupHub');
  });

  it('never selects (mailboxOpen) the WarmupHub folder before moving the message into it', async () => {
    const client = makeImapClient();
    imapClientService.getConnection.mockResolvedValue(client);
    mockSelectInbox(receiverInbox);
    mockUpdate();

    await processor.process(makeJob({ actions: [] }));

    // The destination mailbox must only ever be touched via mailboxCreate,
    // never via mailboxOpen -- opening it would change the selected mailbox
    // and corrupt the sequence-number context for messageMove.
    expect(client.mailboxOpen).not.toHaveBeenCalledWith('WarmupHub');
    expect(client.mailboxCreate).toHaveBeenCalledWith('WarmupHub');
    expect(client.messageMove).toHaveBeenCalledWith(expect.anything(), 'WarmupHub');

    // And mailboxCreate must happen strictly before the move.
    const createOrder = client.mailboxCreate.mock.invocationCallOrder[0];
    const moveOrder = client.messageMove.mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(moveOrder);
  });

  it('throws and does not proceed to flag/file when relocation after rescue fails', async () => {
    const client = makeImapClient();
    client.search.mockImplementation(async () => {
      const opened = client.mailboxOpen.mock.calls.at(-1)?.[0];
      if (opened === '[Gmail]/Spam') return [1];
      if (opened === 'INBOX') return []; // post-rescue relocation finds nothing
      return [];
    });
    imapClientService.getConnection.mockResolvedValue(client);
    mockSelectInbox(receiverInbox);
    mockUpdate();

    await expect(
      processor.process(makeJob({ actions: ['rescue', 'open', 'star'] })),
    ).rejects.toThrow('Rescued message not found in INBOX after move');

    expect(client.messageMove).toHaveBeenCalledWith(expect.anything(), 'INBOX');
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    expect(client.messageMove).not.toHaveBeenCalledWith(expect.anything(), 'WarmupHub');
    expect(db.update).not.toHaveBeenCalled();
  });

  it('best-effort detects the Gmail tab from labels and sets landed_in_tab', async () => {
    const client = makeImapClient();
    client.fetchOne.mockResolvedValue({
      seq: 1,
      uid: 1,
      envelope: { messageId: '<abc@emailwarm.io>' },
      labels: new Set(['\\Inbox', '\\Category\\Promotions']),
    });
    imapClientService.getConnection.mockResolvedValue(client);
    mockSelectInbox(receiverInbox);
    mockUpdate();

    await processor.process(makeJob({ actions: ['open'] }));

    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ landedInTab: 'promotions' }),
    );
  });

  it('sets landed_in_tab to null when it cannot be reliably detected (non-Gmail)', async () => {
    const outlookInbox = { ...receiverInbox, provider: 'outlook' };
    const client = makeImapClient({
      list: jest.fn().mockResolvedValue([{ path: 'INBOX', specialUse: undefined }]),
    });
    imapClientService.getConnection.mockResolvedValue(client);
    mockSelectInbox(outlookInbox);
    mockUpdate();

    await processor.process(makeJob({ actions: ['open'] }));

    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ landedInTab: null }));
  });

  it('updates the warmup_sends row by messageId', async () => {
    const client = makeImapClient();
    imapClientService.getConnection.mockResolvedValue(client);
    mockSelectInbox(receiverInbox);
    mockUpdate();

    await processor.process(makeJob());

    expect(db.update).toHaveBeenCalled();
    expect(updateWhereMock).toHaveBeenCalled();
  });

  it('throws when the receiver inbox cannot be found', async () => {
    mockSelectInbox(null);

    await expect(processor.process(makeJob())).rejects.toThrow();
    expect(imapClientService.getConnection).not.toHaveBeenCalled();
  });

  it('throws when the message cannot be found in any folder', async () => {
    const client = makeImapClient({ search: jest.fn().mockResolvedValue([]) });
    imapClientService.getConnection.mockResolvedValue(client);
    mockSelectInbox(receiverInbox);
    mockUpdate();

    await expect(processor.process(makeJob())).rejects.toThrow();
    expect(client.messageMove).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('performs actions in the fixed order rescue -> open -> star -> reply -> file regardless of payload order', async () => {
    const order: string[] = [];
    const client = makeImapClient();
    // First INBOX check misses, Spam hits, post-rescue INBOX re-check hits (relocated).
    client.search.mockImplementation(async () => {
      const opened = client.mailboxOpen.mock.calls.at(-1)?.[0];
      return opened === '[Gmail]/Spam' || client.mailboxOpen.mock.calls.length > 2 ? [1] : [];
    });
    client.messageMove.mockImplementation(async (_seq: unknown, dest: string) => {
      order.push(`move:${dest}`);
      return { path: 'x', destination: dest };
    });
    client.messageFlagsAdd.mockImplementation(async (_seq: unknown, flags: string[]) => {
      order.push(`flag:${flags[0]}`);
      return true;
    });
    const sendMailMock = jest.fn().mockImplementation(async () => {
      order.push('reply');
      return { messageId: 'whatever' };
    });
    smtpClientService.getTransporter.mockResolvedValue({ sendMail: sendMailMock });
    imapClientService.getConnection.mockResolvedValue(client);
    mockSelectInbox(receiverInbox);
    mockUpdate();

    // Payload order intentionally scrambled.
    await processor.process(makeJob({ actions: ['reply', 'star', 'rescue', 'open'] }));

    expect(order).toEqual([
      'move:INBOX',
      'flag:\\Seen',
      'flag:\\Flagged',
      'reply',
      'move:WarmupHub',
    ]);
  });

  describe('private pool receiver (receiverSource = private)', () => {
    const poolInbox = {
      id: 'pi-1',
      email: 'partner@poolco.com',
      provider: 'gmail',
    };

    function mockSelectPoolInbox(row: any) {
      (db.select as jest.Mock).mockReturnValue({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue(row ? [row] : []),
      });
    }

    function makePrivateJob(overrides: Partial<Record<string, unknown>> = {}) {
      return makeJob({ receiverSource: 'private', receiverId: 'pi-1', ...overrides });
    }

    it('loads the receiver from pool_inboxes and uses getPoolInboxConnection', async () => {
      const client = makeImapClient();
      imapClientService.getPoolInboxConnection.mockResolvedValue(client);
      mockSelectPoolInbox(poolInbox);
      mockUpdate();

      await processor.process(makePrivateJob());

      expect(imapClientService.getPoolInboxConnection).toHaveBeenCalledWith('pi-1');
      expect(imapClientService.getConnection).not.toHaveBeenCalled();
    });

    it('marks \\Seen for the open action against the pool inbox connection', async () => {
      const client = makeImapClient();
      imapClientService.getPoolInboxConnection.mockResolvedValue(client);
      mockSelectPoolInbox(poolInbox);
      mockUpdate();

      await processor.process(makePrivateJob({ actions: ['open'] }));

      expect(client.messageFlagsAdd).toHaveBeenCalledWith(expect.anything(), ['\\Seen']);
      expect(updateSetMock).toHaveBeenCalledWith(
        expect.objectContaining({ openedAt: expect.any(Date) }),
      );
    });

    it('sends a reply via getPoolInboxTransporter for the reply action', async () => {
      const client = makeImapClient();
      imapClientService.getPoolInboxConnection.mockResolvedValue(client);
      mockSelectPoolInbox(poolInbox);
      mockUpdate();
      const sendMailMock = jest.fn().mockResolvedValue({ messageId: 'whatever' });
      smtpClientService.getPoolInboxTransporter.mockResolvedValue({ sendMail: sendMailMock });

      await processor.process(makePrivateJob({ actions: ['reply'] }));

      expect(smtpClientService.getPoolInboxTransporter).toHaveBeenCalledWith('pi-1');
      expect(smtpClientService.getTransporter).not.toHaveBeenCalled();
      expect(sendMailMock).toHaveBeenCalledTimes(1);
      expect(updateSetMock).toHaveBeenCalledWith(
        expect.objectContaining({ repliedAt: expect.any(Date) }),
      );
    });

    it('still files to WarmupHub and updates warmup_sends by messageId', async () => {
      const client = makeImapClient();
      imapClientService.getPoolInboxConnection.mockResolvedValue(client);
      mockSelectPoolInbox(poolInbox);
      mockUpdate();

      await processor.process(makePrivateJob({ actions: [] }));

      expect(client.messageMove).toHaveBeenCalledWith(expect.anything(), 'WarmupHub');
      expect(db.update).toHaveBeenCalled();
      expect(updateWhereMock).toHaveBeenCalled();
    });

    it('rescues from spam using the pool inbox connection', async () => {
      const client = makeImapClient();
      client.search.mockImplementation(async () => {
        const opened = client.mailboxOpen.mock.calls.at(-1)?.[0];
        return opened === '[Gmail]/Spam' || client.mailboxOpen.mock.calls.length > 2 ? [1] : [];
      });
      imapClientService.getPoolInboxConnection.mockResolvedValue(client);
      mockSelectPoolInbox(poolInbox);
      mockUpdate();

      await processor.process(makePrivateJob({ actions: ['rescue'] }));

      expect(client.messageMove).toHaveBeenCalledWith(expect.anything(), 'INBOX');
      expect(updateSetMock).toHaveBeenCalledWith(
        expect.objectContaining({ rescuedAt: expect.any(Date), landedInSpam: true }),
      );
    });

    it('throws when the pool inbox cannot be found', async () => {
      mockSelectPoolInbox(null);

      await expect(processor.process(makePrivateJob())).rejects.toThrow();
      expect(imapClientService.getPoolInboxConnection).not.toHaveBeenCalled();
    });

    it('no-ops gracefully when IMAP is not configured for the pool inbox', async () => {
      const { ImapNotConfiguredError } = jest.requireActual('../inbox/imap/imap-client.service');
      imapClientService.getPoolInboxConnection.mockRejectedValue(
        new ImapNotConfiguredError('pi-1'),
      );
      mockSelectPoolInbox(poolInbox);

      await expect(processor.process(makePrivateJob())).resolves.toBeUndefined();
      expect(db.update).not.toHaveBeenCalled();
    });
  });
});
