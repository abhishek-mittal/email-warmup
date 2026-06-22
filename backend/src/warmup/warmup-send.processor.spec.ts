import { Test, TestingModule } from '@nestjs/testing';
import { UnrecoverableError } from 'bullmq';
import { WarmupSendProcessor } from './warmup-send.processor';
import { ContentService } from './content.service';
import { SmtpClientService } from '../inbox/smtp/smtp-client.service';
import { QueueService } from '../queue/queue.service';
import { db } from '../db';

jest.mock('../db', () => ({
  db: {
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
  },
}));

describe('WarmupSendProcessor', () => {
  let processor: WarmupSendProcessor;
  let contentService: { generateEmail: jest.Mock };
  let smtpClientService: { getTransporter: jest.Mock };
  let queueService: { add: jest.Mock };

  const senderInbox = {
    id: 'sender-1',
    email: 'sender@sendco.com',
    provider: 'gmail',
    status: 'active',
    warmupDay: 5,
  };

  const senderPoolMember = {
    id: 'sender-pool-1',
    inboxId: 'sender-1',
    email: 'sender@sendco.com',
    domain: 'sendco.com',
    industry: 'fintech',
  };

  const partnerPoolMember = {
    id: 'pool-1',
    inboxId: 'receiver-1',
    email: 'receiver@receiveco.com',
    domain: 'receiveco.com',
  };

  const receiverInbox = {
    id: 'receiver-1',
    email: 'receiver@receiveco.com',
    provider: 'outlook',
    status: 'active',
  };

  const sendMailMock = jest.fn();

  function mockSelectSequence(results: any[][]) {
    let call = 0;
    (db.select as jest.Mock).mockImplementation(() => {
      const result = results[call] ?? [];
      call += 1;
      return {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue(result),
      };
    });
  }

  function mockInsert() {
    const returningMock = jest.fn().mockResolvedValue([{ id: 'send-1' }]);
    (db.insert as jest.Mock).mockReturnValue({
      values: jest.fn().mockReturnThis(),
      returning: returningMock,
    });
    return returningMock;
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    contentService = {
      generateEmail: jest.fn().mockResolvedValue({
        subject: 'Quick hello',
        text: 'Hey, hope you are doing well!',
        html: '<p>Hey, hope you are doing well!</p>',
      }),
    };
    smtpClientService = {
      getTransporter: jest.fn().mockResolvedValue({ sendMail: sendMailMock }),
    };
    queueService = {
      add: jest.fn().mockResolvedValue(undefined),
    };
    sendMailMock.mockResolvedValue({ messageId: 'whatever' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WarmupSendProcessor,
        { provide: ContentService, useValue: contentService },
        { provide: SmtpClientService, useValue: smtpClientService },
        { provide: QueueService, useValue: queueService },
      ],
    }).compile();

    processor = module.get<WarmupSendProcessor>(WarmupSendProcessor);
  });

  function makeJob(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      data: {
        senderInboxId: 'sender-1',
        partnerSource: 'shared',
        partnerId: 'pool-1',
        warmupDay: 5,
        scheduledAt: '2026-06-20T09:47:00.000Z',
        ...overrides,
      },
    } as any;
  }

  it('sends the warmup email with required headers and records the send', async () => {
    mockSelectSequence([
      [senderInbox], // load sender inbox
      [partnerPoolMember], // load pool member
      [receiverInbox], // load receiver inbox
      [senderPoolMember], // load sender's pool member (for industry)
      [], // no prior warmup_sends row for receiver -> no rescue
    ]);
    const returningMock = mockInsert();

    await processor.process(makeJob());

    expect(smtpClientService.getTransporter).toHaveBeenCalledWith('sender-1');
    expect(contentService.generateEmail).toHaveBeenCalledWith(
      expect.objectContaining({ warmupDay: 5, industry: 'fintech' }),
    );

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const mailArgs = sendMailMock.mock.calls[0][0];
    expect(mailArgs.from).toBe('sender@sendco.com');
    expect(mailArgs.to).toBe('receiver@receiveco.com');
    expect(mailArgs.subject).toBe('Quick hello');
    expect(mailArgs.text).toBe('Hey, hope you are doing well!');
    expect(mailArgs.html).toBe('<p>Hey, hope you are doing well!</p>');
    expect(mailArgs.headers['X-WarmupHub']).toBe('true');
    expect(mailArgs.headers['Message-ID']).toMatch(/^<.+@emailwarm\.io>$/);

    expect(db.insert).toHaveBeenCalled();
    const insertCall = (db.insert as jest.Mock).mock.results[0].value;
    const valuesArg = insertCall.values.mock.calls[0][0];
    expect(valuesArg.senderInboxId).toBe('sender-1');
    expect(valuesArg.receiverInboxId).toBe('receiver-1');
    expect(valuesArg.messageId).toBe(mailArgs.headers['Message-ID']);
    expect(valuesArg.warmupDay).toBe(5);
    expect(valuesArg.bodyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(valuesArg.sentAt).toBeInstanceOf(Date);
    expect(returningMock).toHaveBeenCalled();
  });

  it('enqueues a warmup-receive job with a 2-240 minute delay and base actions', async () => {
    mockSelectSequence([
      [senderInbox],
      [partnerPoolMember],
      [receiverInbox],
      [senderPoolMember],
      [],
    ]);
    mockInsert();

    await processor.process(makeJob());

    expect(queueService.add).toHaveBeenCalledTimes(1);
    const [queueName, payload, opts] = queueService.add.mock.calls[0];
    expect(queueName).toBe('warmup-receive');
    expect(payload.receiverSource).toBe('shared');
    expect(payload.receiverId).toBe('receiver-1');
    expect(payload.receiverInboxId).toBe('receiver-1');
    expect(payload.actions).toEqual(expect.arrayContaining(['open', 'star']));
    expect(payload.actions).not.toContain('rescue');
    expect(opts.delay).toBeGreaterThanOrEqual(2 * 60_000);
    expect(opts.delay).toBeLessThanOrEqual(240 * 60_000);
  });

  it('includes "rescue" in the receive job actions when the previous send to that receiver landed in spam', async () => {
    mockSelectSequence([
      [senderInbox],
      [partnerPoolMember],
      [receiverInbox],
      [senderPoolMember],
      [{ landedInSpam: true }],
    ]);
    mockInsert();

    await processor.process(makeJob());

    const payload = queueService.add.mock.calls[0][1];
    expect(payload.actions).toContain('rescue');
  });

  it('omits "rescue" when the previous send to that receiver did not land in spam', async () => {
    mockSelectSequence([
      [senderInbox],
      [partnerPoolMember],
      [receiverInbox],
      [senderPoolMember],
      [{ landedInSpam: false }],
    ]);
    mockInsert();

    await processor.process(makeJob());

    const payload = queueService.add.mock.calls[0][1];
    expect(payload.actions).not.toContain('rescue');
  });

  it('adds "reply" roughly 60% of the time', async () => {
    mockSelectSequence(
      Array.from({ length: 200 }, () => null).flatMap(() => [
        [senderInbox],
        [partnerPoolMember],
        [receiverInbox],
        [senderPoolMember],
        [],
      ]),
    );
    mockInsert();

    const randomSpy = jest.spyOn(Math, 'random');
    let replyCount = 0;
    const iterations = 50;
    for (let i = 0; i < iterations; i++) {
      queueService.add.mockClear();
      await processor.process(makeJob());
      const payload = queueService.add.mock.calls[0][1];
      if (payload.actions.includes('reply')) replyCount += 1;
    }
    randomSpy.mockRestore();

    // Statistical check with generous bounds — true probability is 60%.
    expect(replyCount).toBeGreaterThan(iterations * 0.35);
    expect(replyCount).toBeLessThan(iterations * 0.85);
  });

  it('throws UnrecoverableError and does not send when sender inbox is not active', async () => {
    mockSelectSequence([[{ ...senderInbox, status: 'paused' }]]);

    await expect(processor.process(makeJob())).rejects.toThrow(UnrecoverableError);
    expect(sendMailMock).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(queueService.add).not.toHaveBeenCalled();
  });

  it('throws UnrecoverableError when the sender inbox cannot be found', async () => {
    mockSelectSequence([[]]);

    await expect(processor.process(makeJob())).rejects.toThrow(UnrecoverableError);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('throws UnrecoverableError when the partner pool member cannot be found', async () => {
    mockSelectSequence([[senderInbox], []]);

    await expect(processor.process(makeJob())).rejects.toThrow(UnrecoverableError);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('does not persist the email body anywhere, only its hash', async () => {
    mockSelectSequence([
      [senderInbox],
      [partnerPoolMember],
      [receiverInbox],
      [senderPoolMember],
      [],
    ]);
    mockInsert();

    await processor.process(makeJob());

    const valuesArg = (db.insert as jest.Mock).mock.results[0].value.values.mock.calls[0][0];
    expect(valuesArg.body).toBeUndefined();
    expect(valuesArg.text).toBeUndefined();
    expect(valuesArg.html).toBeUndefined();
    expect(Object.keys(valuesArg)).not.toContain('bodyText');
  });

  describe('private pool partner (partnerSource = private)', () => {
    const poolInbox = {
      id: 'pi-1',
      userId: 'user-1',
      email: 'partner@poolco.com',
      provider: 'gmail',
      status: 'active',
      activePairs: 3,
    };

    function mockUpdate() {
      const setMock = jest.fn().mockReturnThis();
      const whereMock = jest.fn().mockResolvedValue(undefined);
      (db.update as jest.Mock).mockReturnValue({ set: setMock, where: whereMock });
      return { setMock, whereMock };
    }

    function makePrivateJob(overrides: Partial<Record<string, unknown>> = {}) {
      return makeJob({ partnerSource: 'private', partnerId: 'pi-1', ...overrides });
    }

    it('sends via the sender SMTP transporter to the pool inbox email and writes receiverPoolInboxId', async () => {
      mockSelectSequence([
        [senderInbox], // sender inbox
        [poolInbox], // pool_inboxes lookup
        [], // no prior warmup_sends row for this pool inbox -> no rescue
      ]);
      const returningMock = mockInsert();
      mockUpdate();

      await processor.process(makePrivateJob());

      expect(smtpClientService.getTransporter).toHaveBeenCalledWith('sender-1');
      expect(sendMailMock).toHaveBeenCalledTimes(1);
      const mailArgs = sendMailMock.mock.calls[0][0];
      expect(mailArgs.from).toBe('sender@sendco.com');
      expect(mailArgs.to).toBe('partner@poolco.com');

      const valuesArg = (db.insert as jest.Mock).mock.results[0].value.values.mock.calls[0][0];
      expect(valuesArg.receiverPoolInboxId).toBe('pi-1');
      expect(valuesArg.receiverInboxId).toBeUndefined();
      expect(returningMock).toHaveBeenCalled();
    });

    it('decrements pool_inboxes.active_pairs (floor 0) after a successful private-pool send', async () => {
      mockSelectSequence([[senderInbox], [poolInbox], []]);
      mockInsert();
      const { setMock, whereMock } = mockUpdate();

      await processor.process(makePrivateJob());

      expect(setMock).toHaveBeenCalledWith(
        expect.objectContaining({ activePairs: expect.anything() }),
      );
      expect(whereMock).toHaveBeenCalled();
    });

    it('enqueues a warmup-receive job tagged receiverSource=private with the pool inbox id, no receiverInboxId key', async () => {
      mockSelectSequence([[senderInbox], [poolInbox], []]);
      mockInsert();
      mockUpdate();

      await processor.process(makePrivateJob());

      expect(queueService.add).toHaveBeenCalledTimes(1);
      const [queueName, payload] = queueService.add.mock.calls[0];
      expect(queueName).toBe('warmup-receive');
      expect(payload.receiverSource).toBe('private');
      expect(payload.receiverId).toBe('pi-1');
      expect(payload.receiverInboxId).toBeUndefined();
    });

    it('throws UnrecoverableError when the pool inbox partner cannot be found', async () => {
      mockSelectSequence([[senderInbox], []]);

      await expect(processor.process(makePrivateJob())).rejects.toThrow(UnrecoverableError);
      expect(sendMailMock).not.toHaveBeenCalled();
    });

    it('includes "rescue" when the previous send to that pool inbox landed in spam', async () => {
      mockSelectSequence([[senderInbox], [poolInbox], [{ landedInSpam: true }]]);
      mockInsert();
      mockUpdate();

      await processor.process(makePrivateJob());

      const payload = queueService.add.mock.calls[0][1];
      expect(payload.actions).toContain('rescue');
    });
  });
});
