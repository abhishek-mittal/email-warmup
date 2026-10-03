import {
  Engine,
  buildEngine,
  closeDb,
  countInFolder,
  createInbox,
  createPoolInbox,
  createUser,
  deliverRaw,
  enroll,
  fakeJob,
  findEverywhere,
  getSend,
  moveToJunk,
  planSend,
  resetDb,
  sendJobFor,
  uniqueEmail,
} from './harness';
import { MessageNotDeliveredYetError } from '../../src/warmup/warmup-receive.processor';

/**
 * Drives the real send and receive processors against real SMTP and IMAP
 * servers (GreenMail) and a real Postgres. Only the queue, the content
 * generator and OAuth HTTP are faked.
 */
describe('warmup send -> receive (MR-02)', () => {
  let engine: Engine;

  beforeEach(async () => {
    await resetDb();
    engine = buildEngine();
  });

  afterEach(async () => {
    await engine.imap.onModuleDestroy();
  });

  afterAll(async () => {
    await closeDb();
  });

  async function sharedPair() {
    const userA = await createUser();
    const userB = await createUser();
    const sender = await createInbox(userA);
    const receiver = await createInbox(userB);
    await enroll(sender);
    await enroll(receiver);
    return { sender, receiver };
  }

  function receiveJob(sendId: string, actions: string[], overrides: Record<string, unknown> = {}) {
    const queued = engine.queue.of('warmup-receive').find((j) => j.payload.sendId === sendId);
    if (!queued) throw new Error('no receive job was published for the send');
    return fakeJob({ ...queued.payload, actions, ...overrides });
  }

  it('completes a full cycle: send, open, star, reply to the sender, file both messages', async () => {
    const { sender, receiver } = await sharedPair();
    const planned = await planSend(sender, { inboxId: receiver.id });

    await engine.sendProcessor.process(sendJobFor(planned));

    const sent = await getSend(planned.id);
    expect(sent.status).toBe('accepted');
    expect(sent.sentAt).toBeInstanceOf(Date);
    expect(sent.receiveEnqueuedAt).toBeInstanceOf(Date);

    const delivered = await findEverywhere(receiver.email, planned.messageId!);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].folder).toBe('INBOX');
    expect(delivered[0].headers.toLowerCase()).toContain('x-warmuphub: true');

    await engine.receiveProcessor.process(receiveJob(planned.id, ['open', 'star', 'reply']));

    const done = await getSend(planned.id);
    expect(done.openedAt).toBeInstanceOf(Date);
    expect(done.starredAt).toBeInstanceOf(Date);
    expect(done.repliedAt).toBeInstanceOf(Date);
    expect(done.filedAt).toBeInstanceOf(Date);
    expect(done.replyStatus).toBe('accepted');
    expect(done.landedInSpam).toBe(false);

    // The original is filed, read and starred — and no longer in the real inbox.
    const filed = await findEverywhere(receiver.email, planned.messageId!);
    expect(filed.map((m) => m.folder)).toEqual(['WarmupHub']);
    expect(filed[0].flags).toEqual(expect.arrayContaining(['\\Seen', '\\Flagged']));

    // Regression for the missing-recipient bug: the reply reaches the address
    // the original was recorded as coming from, threaded onto it.
    const reply = await findEverywhere(sender.email, done.replyMessageId!);
    expect(reply).toHaveLength(1);
    expect(reply[0].to).toBe(sender.email);
    expect(reply[0].from).toBe(receiver.email);
    const replyHeaders = reply[0].headers.toLowerCase();
    expect(replyHeaders).toContain(`in-reply-to: ${planned.messageId}`);
    expect(replyHeaders).toContain(`references: ${planned.messageId}`);
    expect(replyHeaders).toContain('x-warmuphub: true');

    // The reply is warmup traffic too: a filing job moves it out of the sender's inbox.
    const filing = engine.queue
      .of('warmup-receive')
      .find((j) => j.payload.kind === 'reply-filing' && j.payload.sendId === planned.id);
    expect(filing).toBeDefined();
    await engine.receiveProcessor.process(fakeJob(filing!.payload));

    const replyFiled = await findEverywhere(sender.email, done.replyMessageId!);
    expect(replyFiled.map((m) => m.folder)).toEqual(['WarmupHub']);
    expect((await getSend(planned.id)).replyFiledAt).toBeInstanceOf(Date);
  });

  it('works against a private pool inbox, replying through the pool inbox', async () => {
    const user = await createUser();
    const sender = await createInbox(user, { poolConsentAt: null });
    const poolInbox = await createPoolInbox(user);
    const planned = await planSend(sender, { poolInboxId: poolInbox.id });

    await engine.sendProcessor.process(sendJobFor(planned));
    await engine.receiveProcessor.process(receiveJob(planned.id, ['open', 'reply']));

    const done = await getSend(planned.id);
    expect(done.status).toBe('accepted');
    expect(done.filedAt).toBeInstanceOf(Date);
    expect(done.replyStatus).toBe('accepted');
    const reply = await findEverywhere(sender.email, done.replyMessageId!);
    expect(reply[0].from).toBe(poolInbox.email);
  });

  it('retries later when the message has not arrived, recording nothing', async () => {
    const { sender, receiver } = await sharedPair();
    const planned = await planSend(sender, { inboxId: receiver.id }, { status: 'accepted' });

    await expect(
      engine.receiveProcessor.process(
        fakeJob({
          sendId: planned.id,
          receiverSource: 'shared' as const,
          receiverId: receiver.id,
          messageId: planned.messageId!,
          actions: ['open'] as any,
          executeAt: new Date().toISOString(),
        }),
      ),
    ).rejects.toBeInstanceOf(MessageNotDeliveredYetError);

    const row = await getSend(planned.id);
    expect(row.openedAt).toBeNull();
    expect(row.filedAt).toBeNull();
  });

  it('rescues a message from spam based on that message’s own placement', async () => {
    const { sender, receiver } = await sharedPair();
    const planned = await planSend(sender, { inboxId: receiver.id });
    await engine.sendProcessor.process(sendJobFor(planned));
    await moveToJunk(receiver.email, planned.messageId!);

    // No 'rescue' in the action list: rescue no longer depends on a previous send.
    await engine.receiveProcessor.process(receiveJob(planned.id, ['open']));

    const done = await getSend(planned.id);
    expect(done.landedInSpam).toBe(true);
    expect(done.rescuedAt).toBeInstanceOf(Date);
    expect(done.filedAt).toBeInstanceOf(Date);
    const copies = await findEverywhere(receiver.email, planned.messageId!);
    expect(copies.map((m) => m.folder)).toEqual(['WarmupHub']);
  });

  it('still files the message when the reply fails, and never replies twice on retry', async () => {
    const { sender, receiver } = await sharedPair();
    const planned = await planSend(sender, { inboxId: receiver.id });
    await engine.sendProcessor.process(sendJobFor(planned));

    // The reply's SMTP connection is lost after submission: outcome unknown.
    const realGetTransporter = engine.smtp.getTransporter.bind(engine.smtp);
    const spy = jest.spyOn(engine.smtp, 'getTransporter').mockImplementation(async () => {
      return {
        sendMail: async () => {
          throw Object.assign(new Error('socket closed'), { code: 'ESOCKET', command: 'DATA' });
        },
      } as any;
    });

    await engine.receiveProcessor.process(receiveJob(planned.id, ['open', 'star', 'reply']));

    let row = await getSend(planned.id);
    expect(row.replyStatus).toBe('uncertain');
    expect(row.repliedAt).toBeNull();
    expect(row.filedAt).toBeInstanceOf(Date);
    expect((await findEverywhere(receiver.email, planned.messageId!)).map((m) => m.folder)).toEqual(
      ['WarmupHub'],
    );
    const openedAt = row.openedAt;

    // Retry with working SMTP: recorded actions are not repeated, no blind second reply.
    spy.mockImplementation(realGetTransporter);
    await engine.receiveProcessor.process(receiveJob(planned.id, ['open', 'star', 'reply']));

    row = await getSend(planned.id);
    expect(row.openedAt).toEqual(openedAt);
    expect(row.replyStatus).toBe('uncertain');
    expect(await findEverywhere(sender.email, row.replyMessageId!)).toHaveLength(0);
  });

  it('does not resend when a worker died mid-submission; delivery is reconciled by the receive job', async () => {
    const { sender, receiver } = await sharedPair();
    const planned = await planSend(
      sender,
      { inboxId: receiver.id },
      {
        status: 'submitting',
        claimedAt: new Date(),
      },
    );
    // The dead worker's SMTP conversation did complete.
    await deliverRaw({ from: sender.email, to: receiver.email, messageId: planned.messageId! });

    await engine.sendProcessor.process(sendJobFor(planned));

    expect((await getSend(planned.id)).status).toBe('uncertain');
    expect(await findEverywhere(receiver.email, planned.messageId!)).toHaveLength(1);

    await engine.receiveProcessor.process(receiveJob(planned.id, ['open']));
    const reconciled = await getSend(planned.id);
    expect(reconciled.status).toBe('accepted');
    expect(reconciled.sentAt).toBeInstanceOf(Date);
    expect(reconciled.filedAt).toBeInstanceOf(Date);
  });

  it('marks a lost acknowledgement uncertain and does not retry it', async () => {
    const { sender, receiver } = await sharedPair();
    const planned = await planSend(sender, { inboxId: receiver.id });
    jest.spyOn(engine.smtp, 'getTransporter').mockResolvedValue({
      sendMail: async () => {
        throw Object.assign(new Error('Connection closed'), { code: 'ESOCKET', command: 'DATA' });
      },
    } as any);

    await expect(engine.sendProcessor.process(sendJobFor(planned))).rejects.toMatchObject({
      name: 'UnrecoverableError',
    });
    expect((await getSend(planned.id)).status).toBe('uncertain');

    // A second delivery of the same job must not submit again.
    jest.restoreAllMocks();
    await engine.sendProcessor.process(sendJobFor(planned));
    expect(await findEverywhere(receiver.email, planned.messageId!)).toHaveLength(0);
    expect((await getSend(planned.id)).status).toBe('uncertain');
  });

  it('records a definite rejection as failed and sends exactly once on retry', async () => {
    const { sender, receiver } = await sharedPair();
    const planned = await planSend(sender, { inboxId: receiver.id });
    const spy = jest.spyOn(engine.smtp, 'getTransporter').mockResolvedValueOnce({
      sendMail: async () => {
        throw Object.assign(new Error('Mailbox unavailable'), {
          code: 'EMESSAGE',
          responseCode: 450,
        });
      },
    } as any);

    await expect(engine.sendProcessor.process(sendJobFor(planned))).rejects.toThrow(
      'Mailbox unavailable',
    );
    expect((await getSend(planned.id)).status).toBe('failed');
    spy.mockRestore();

    await engine.sendProcessor.process(sendJobFor(planned));
    expect((await getSend(planned.id)).status).toBe('accepted');
    expect(await findEverywhere(receiver.email, planned.messageId!)).toHaveLength(1);
  });

  it('sends one message when the same job is delivered twice, even concurrently', async () => {
    const { sender, receiver } = await sharedPair();
    const planned = await planSend(sender, { inboxId: receiver.id });

    await Promise.all([
      engine.sendProcessor.process(sendJobFor(planned)),
      engine.sendProcessor.process(sendJobFor(planned)),
    ]);
    await engine.sendProcessor.process(sendJobFor(planned));

    expect(await findEverywhere(receiver.email, planned.messageId!)).toHaveLength(1);
    expect(
      engine.queue.of('warmup-receive').filter((j) => j.payload.sendId === planned.id),
    ).toHaveLength(1);
  });

  it('keeps an accepted send when the queue is down, and recovery publishes its receive job', async () => {
    const { sender, receiver } = await sharedPair();
    const planned = await planSend(sender, { inboxId: receiver.id });
    engine.queue.failNextAdd = true;

    await engine.sendProcessor.process(sendJobFor(planned));

    let row = await getSend(planned.id);
    expect(row.status).toBe('accepted');
    expect(row.receiveEnqueuedAt).toBeNull();
    expect(engine.queue.of('warmup-receive')).toHaveLength(0);

    const result = await engine.ledger.recover(new Date(Date.now() + 10 * 60_000));
    expect(result.republished).toBe(1);
    row = await getSend(planned.id);
    expect(row.receiveEnqueuedAt).toBeInstanceOf(Date);
    expect(engine.queue.of('warmup-receive')).toHaveLength(1);
  });

  describe('eligibility is rechecked immediately before sending', () => {
    it.each([
      [
        'sender paused',
        async (s: any) => ({ table: 'sender', id: s.sender.id, set: { status: 'paused' } }),
      ],
      [
        'receiver paused',
        async (s: any) => ({ table: 'receiver', id: s.receiver.id, set: { status: 'paused' } }),
      ],
      [
        'sender without pool consent',
        async (s: any) => ({ table: 'sender', id: s.sender.id, set: { poolConsentAt: null } }),
      ],
      [
        'receiver without pool consent',
        async (s: any) => ({ table: 'receiver', id: s.receiver.id, set: { poolConsentAt: null } }),
      ],
    ])('cancels and sends nothing: %s', async (_name, change) => {
      const pair = await sharedPair();
      const planned = await planSend(pair.sender, { inboxId: pair.receiver.id });
      const { id, set } = await change(pair);
      const { db } = await import('../../src/db');
      const { inboxes } = await import('../../src/db/schema');
      const { eq } = await import('drizzle-orm');
      await db
        .update(inboxes)
        .set(set as any)
        .where(eq(inboxes.id, id));

      await engine.sendProcessor.process(sendJobFor(planned));

      expect((await getSend(planned.id)).status).toBe('canceled');
      expect(await findEverywhere(pair.receiver.email, planned.messageId!)).toHaveLength(0);
    });

    it('never sends to the sender’s own domain', async () => {
      const userA = await createUser();
      const userB = await createUser();
      const sender = await createInbox(userA, { email: uniqueEmail('same') });
      const domain = sender.email.split('@')[1];
      const receiver = await createInbox(userB, { email: `other@${domain}` });
      await enroll(sender);
      await enroll(receiver);
      const planned = await planSend(sender, { inboxId: receiver.id });

      await engine.sendProcessor.process(sendJobFor(planned));

      expect((await getSend(planned.id)).status).toBe('canceled');
      expect(await countInFolder(receiver.email, 'INBOX')).toBe(0);
    });

    it('never uses another tenant’s private pool inbox', async () => {
      const userA = await createUser();
      const userB = await createUser();
      const sender = await createInbox(userA);
      const foreignPool = await createPoolInbox(userB);
      const planned = await planSend(sender, { poolInboxId: foreignPool.id });

      await engine.sendProcessor.process(sendJobFor(planned));

      expect((await getSend(planned.id)).status).toBe('canceled');
      expect(await countInFolder(foreignPool.email, 'INBOX')).toBe(0);
    });
  });

  it('does not engage for a receiver that was paused after the mail was sent', async () => {
    const { sender, receiver } = await sharedPair();
    const planned = await planSend(sender, { inboxId: receiver.id });
    await engine.sendProcessor.process(sendJobFor(planned));
    const job = receiveJob(planned.id, ['open', 'star', 'reply']);
    await engine.warmup.pauseInbox(receiver.id);

    await engine.receiveProcessor.process(job);

    const row = await getSend(planned.id);
    expect(row.openedAt).toBeNull();
    expect(row.replyStatus).toBeNull();
    const copies = await findEverywhere(receiver.email, planned.messageId!);
    expect(copies[0].flags).not.toContain('\\Seen');
  });

  it('two jobs on the same mailbox each act on their own message', async () => {
    const userA = await createUser();
    const userB = await createUser();
    const userC = await createUser();
    const senderA = await createInbox(userA);
    const senderB = await createInbox(userB);
    const receiver = await createInbox(userC);
    await enroll(senderA);
    await enroll(senderB);
    await enroll(receiver);
    const first = await planSend(senderA, { inboxId: receiver.id });
    const second = await planSend(senderB, { inboxId: receiver.id });
    await engine.sendProcessor.process(sendJobFor(first));
    await engine.sendProcessor.process(sendJobFor(second));

    await Promise.all([
      engine.receiveProcessor.process(receiveJob(first.id, ['open', 'star'])),
      engine.receiveProcessor.process(receiveJob(second.id, ['open'])),
    ]);

    const a = await findEverywhere(receiver.email, first.messageId!);
    const b = await findEverywhere(receiver.email, second.messageId!);
    expect(a.map((m) => m.folder)).toEqual(['WarmupHub']);
    expect(b.map((m) => m.folder)).toEqual(['WarmupHub']);
    expect(a[0].flags).toContain('\\Flagged');
    expect(b[0].flags).not.toContain('\\Flagged');
    expect(await countInFolder(receiver.email, 'INBOX')).toBe(0);
  });
});
