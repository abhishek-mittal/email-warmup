import { eq } from 'drizzle-orm';
import { db } from '../../src/db';
import { inboxes, safetyStops, warmupSends } from '../../src/db/schema';
import { EgressDeniedError } from '../../src/common/egress-policy';
import { BOUNCE_PAUSE_REASON } from '../../src/safety/bounce-monitor.service';
import {
  Engine,
  bounceNotice,
  buildEngine,
  closeDb,
  countInFolder,
  createInbox,
  createPoolInbox,
  createUser,
  deliverSource,
  enroll,
  fakeJob,
  findEverywhere,
  getSend,
  planSend,
  resetDb,
  sendJobFor,
} from './harness';

async function inboxRow(id: string) {
  return (await db.select().from(inboxes).where(eq(inboxes.id, id)))[0];
}

describe('bounce protection and stop switches (MR-12)', () => {
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

  async function pair() {
    const sender = await createInbox(await createUser());
    const receiver = await createInbox(await createUser());
    await enroll(sender);
    await enroll(receiver);
    return { sender, receiver };
  }

  /** `count` sends from `sender` that were accepted just now. */
  async function acceptedSends(sender: any, receiver: any, count: number) {
    const rows = [];
    for (let i = 0; i < count; i++) {
      rows.push(
        await planSend(
          sender,
          { inboxId: receiver.id },
          {
            status: 'accepted',
            claimedAt: new Date(),
            sentAt: new Date(),
          },
        ),
      );
    }
    return rows;
  }
  async function markBounced(ids: string[]) {
    for (const id of ids) {
      await db
        .update(warmupSends)
        .set({ bouncedAt: new Date(), bounceType: 'hard' })
        .where(eq(warmupSends.id, id));
    }
  }

  describe('the 3% rule', () => {
    it('exactly 3% does not pause; more than 3% does', async () => {
      const { sender, receiver } = await pair();
      const sends = await acceptedSends(sender, receiver, 100);

      await markBounced(sends.slice(0, 3).map((s) => s.id));
      let stats = await engine.bounces.enforce(sender.id);
      expect(stats).toMatchObject({ attempted: 100, bounced: 3 });
      expect((await inboxRow(sender.id)).status).toBe('active');

      await markBounced([sends[3].id]);
      stats = await engine.bounces.enforce(sender.id);
      expect(stats).toMatchObject({ attempted: 100, bounced: 4 });
      const paused = await inboxRow(sender.id);
      expect(paused.status).toBe('paused');
      expect(paused.statusReason).toBe(BOUNCE_PAUSE_REASON);

      // One notice for the pause; a further check while paused sends no more.
      await engine.bounces.enforce(sender.id);
      const notices = engine.queue.of('notify').filter((j) => j.payload.type === 'bounce_paused');
      expect(notices).toHaveLength(1);
      expect(notices[0].payload.payload).toEqual({ attempted: 100, bounced: 4 });
    });

    it('applies to small samples and reports the sample size', async () => {
      const { sender, receiver } = await pair();
      const sends = await acceptedSends(sender, receiver, 2);
      await markBounced([sends[0].id]);

      const stats = await engine.bounces.enforce(sender.id);

      expect(stats).toEqual({ attempted: 2, bounced: 1, rate: 0.5, limit: 0.03, windowHours: 24 });
      expect((await inboxRow(sender.id)).status).toBe('paused');
    });

    it('does nothing with no sends in the window', async () => {
      const { sender } = await pair();
      const stats = await engine.bounces.enforce(sender.id);
      expect(stats).toMatchObject({ attempted: 0, bounced: 0, rate: 0 });
      expect((await inboxRow(sender.id)).status).toBe('active');
    });

    it('only counts the last 24 hours, and never counts reservations or canceled sends', async () => {
      const { sender, receiver } = await pair();
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
      // Yesterday: 5 of 5 bounced. Outside the window.
      for (let i = 0; i < 5; i++) {
        await planSend(
          sender,
          { inboxId: receiver.id },
          {
            status: 'accepted',
            claimedAt: old,
            sentAt: old,
            bouncedAt: old,
            bounceType: 'hard',
          },
        );
      }
      await acceptedSends(sender, receiver, 10);
      await planSend(sender, { inboxId: receiver.id }, { status: 'planned' });
      await planSend(sender, { inboxId: receiver.id }, { status: 'canceled' });

      const stats = await engine.bounces.enforce(sender.id);

      expect(stats).toMatchObject({ attempted: 10, bounced: 0 });
      expect((await inboxRow(sender.id)).status).toBe('active');
    });

    it('temporary failures are recorded but do not count', async () => {
      const { sender, receiver } = await pair();
      const sends = await acceptedSends(sender, receiver, 5);
      await db
        .update(warmupSends)
        .set({ bouncedAt: new Date(), bounceType: 'soft' })
        .where(eq(warmupSends.senderInboxId, sender.id));

      const stats = await engine.bounces.enforce(sender.id);
      expect(stats).toMatchObject({ attempted: sends.length, bounced: 0 });
      expect((await inboxRow(sender.id)).status).toBe('active');
    });
  });

  describe('bounce notices read from the sender mailbox', () => {
    it('records a bounce for the matching send, files the notice, and pauses over the limit', async () => {
      const { sender, receiver } = await pair();
      const [send] = await acceptedSends(sender, receiver, 1);
      const notice = bounceNotice({
        to: sender.email,
        messageId: send.messageId!,
        recipient: receiver.email,
      });
      await deliverSource(sender.email, 'MAILER-DAEMON@mx.partner.test', notice);

      const result = await engine.bounces.scanInbox(sender.id);

      expect(result.recorded).toBe(1);
      const row = await getSend(send.id);
      expect(row.bounceType).toBe('hard');
      expect(row.bouncedAt).toBeInstanceOf(Date);
      expect(row.bounceDetail).toContain('No such user');
      expect(await countInFolder(sender.email, 'INBOX')).toBe(0);
      expect(await countInFolder(sender.email, 'WarmupHub')).toBe(1);
      expect((await inboxRow(sender.id)).statusReason).toBe(BOUNCE_PAUSE_REASON);
    });

    it('a duplicate notice and a second scan do not double count', async () => {
      const { sender, receiver } = await pair();
      const sends = await acceptedSends(sender, receiver, 50);
      for (let i = 0; i < 3; i++) {
        await deliverSource(
          sender.email,
          'MAILER-DAEMON@mx.partner.test',
          bounceNotice({
            to: sender.email,
            messageId: sends[0].messageId!,
            recipient: receiver.email,
          }),
        );
      }

      const first = await engine.bounces.scanInbox(sender.id);
      const second = await engine.bounces.scanInbox(sender.id);

      expect(first.recorded).toBe(1);
      expect(second.recorded).toBe(0);
      expect(second.stats).toMatchObject({ attempted: 50, bounced: 1 });
      expect((await inboxRow(sender.id)).status).toBe('active'); // 2% is under the limit
    });

    it('ignores bounce-shaped mail that is not about a send from this inbox', async () => {
      const { sender, receiver } = await pair();
      const other = await createInbox(await createUser());
      const [mine] = await acceptedSends(sender, receiver, 1);
      const [theirs] = await acceptedSends(other, receiver, 1);

      // Unknown message id, another inbox's message id, and the right id with the wrong recipient.
      await deliverSource(
        sender.email,
        'MAILER-DAEMON@evil.test',
        bounceNotice({
          to: sender.email,
          messageId: '<11111111-2222-4333-8444-555555555555@emailwarm.io>',
        }),
      );
      await deliverSource(
        sender.email,
        'MAILER-DAEMON@evil.test',
        bounceNotice({ to: sender.email, messageId: theirs.messageId! }),
      );
      await deliverSource(
        sender.email,
        'MAILER-DAEMON@evil.test',
        bounceNotice({
          to: sender.email,
          messageId: mine.messageId!,
          recipient: 'someone@else.test',
        }),
      );
      // And an ordinary bounce of the owner's own (non-warmup) mail.
      await deliverSource(
        sender.email,
        'postmaster@mx.partner.test',
        bounceNotice({ to: sender.email, messageId: '<personal-mail@owner.example>' }),
      );

      const result = await engine.bounces.scanInbox(sender.id);

      expect(result.recorded).toBe(0);
      expect((await getSend(mine.id)).bouncedAt).toBeNull();
      expect((await getSend(theirs.id)).bouncedAt).toBeNull();
      expect((await inboxRow(sender.id)).status).toBe('active');
      // The owner's own bounce and the unrelated forgeries stay where they are.
      expect(await countInFolder(sender.email, 'INBOX')).toBe(3);
    });

    it('a delay notice is soft and can later be upgraded by a permanent failure', async () => {
      const { sender, receiver } = await pair();
      const sends = await acceptedSends(sender, receiver, 1);
      await deliverSource(
        sender.email,
        'MAILER-DAEMON@mx.partner.test',
        bounceNotice({
          to: sender.email,
          messageId: sends[0].messageId!,
          action: 'delayed',
          status: '4.4.1',
        }),
      );
      await engine.bounces.scanInbox(sender.id);
      expect((await getSend(sends[0].id)).bounceType).toBe('soft');
      expect((await inboxRow(sender.id)).status).toBe('active');

      await deliverSource(
        sender.email,
        'MAILER-DAEMON@mx.partner.test',
        bounceNotice({ to: sender.email, messageId: sends[0].messageId! }),
      );
      await engine.bounces.scanInbox(sender.id);
      expect((await getSend(sends[0].id)).bounceType).toBe('hard');
      expect((await inboxRow(sender.id)).status).toBe('paused');
    });
  });

  it('a permanent rejection at submission is a bounce, counted at once and not retried', async () => {
    const { sender, receiver } = await pair();
    const planned = await planSend(sender, { inboxId: receiver.id });
    jest.spyOn(engine.smtp, 'getTransporter').mockResolvedValue({
      sendMail: async () => {
        throw Object.assign(new Error('550 5.1.1 User unknown'), {
          code: 'EENVELOPE',
          responseCode: 550,
        });
      },
    } as any);

    await expect(engine.sendProcessor.process(sendJobFor(planned))).rejects.toMatchObject({
      name: 'UnrecoverableError',
    });

    const row = await getSend(planned.id);
    expect(row.status).toBe('failed');
    expect(row.bounceType).toBe('hard');
    expect((await inboxRow(sender.id)).statusReason).toBe(BOUNCE_PAUSE_REASON);
  });

  it('an authentication failure is not a bounce', async () => {
    const { sender, receiver } = await pair();
    const planned = await planSend(sender, { inboxId: receiver.id });
    jest.spyOn(engine.smtp, 'getTransporter').mockResolvedValue({
      sendMail: async () => {
        throw Object.assign(new Error('535 Authentication failed'), {
          code: 'EAUTH',
          responseCode: 535,
        });
      },
    } as any);

    await expect(engine.sendProcessor.process(sendJobFor(planned))).rejects.toThrow('535');

    const row = await getSend(planned.id);
    expect(row.status).toBe('failed');
    expect(row.bouncedAt).toBeNull();
    expect((await inboxRow(sender.id)).status).toBe('active');
  });

  describe('a bounce pause is a system hold', () => {
    it('queued sends are released, a user resume does not lift it, an operator release does', async () => {
      const user = await createUser();
      const sender = await createInbox(user, { warmupDay: 13 });
      await createPoolInbox(user);
      await engine.warmup.scheduleInbox(sender.id, new Date(new Date().setUTCHours(5, 0, 0, 0)));
      expect(engine.queue.of('warmup-send').length).toBeGreaterThan(0);

      await engine.warmup.pauseInbox(sender.id, BOUNCE_PAUSE_REASON);
      expect(engine.queue.of('warmup-send')).toHaveLength(0);

      expect(await engine.warmup.resumeInbox(sender.id)).toBe('paused');
      expect((await inboxRow(sender.id)).status).toBe('paused');

      // What POST /internal/safety/inboxes/:id/release does.
      await db.update(inboxes).set({ statusReason: 'released' }).where(eq(inboxes.id, sender.id));
      expect(await engine.warmup.resumeInbox(sender.id)).toBe('active');
    });

    it('a job already in flight when the pause lands sends nothing', async () => {
      const { sender, receiver } = await pair();
      const planned = await planSend(sender, { inboxId: receiver.id });
      const job = sendJobFor(planned);
      await engine.warmup.pauseInbox(sender.id, BOUNCE_PAUSE_REASON);

      await engine.sendProcessor.process(job);

      expect(await findEverywhere(receiver.email, planned.messageId!)).toHaveLength(0);
      expect((await getSend(planned.id)).status).toBe('canceled');
    });
  });

  describe('operator stop switches', () => {
    it.each([
      ['global', () => ({ scope: 'global' })],
      ['provider', () => ({ scope: 'provider', key: 'custom' })],
    ])(
      'a %s stop halts queued sends and new scheduling, and clearing restores both',
      async (_n, make) => {
        const user = await createUser();
        const sender = await createInbox(user, { warmupDay: 13 });
        const pool = await createPoolInbox(user);
        const planned = await planSend(sender, { poolInboxId: pool.id });

        const stop = await engine.stops.activate({
          ...make(),
          reason: 'incident 42',
          actor: 'ops@test',
        } as any);

        await engine.sendProcessor.process(sendJobFor(planned));
        expect((await getSend(planned.id)).status).toBe('canceled');
        expect(await countInFolder(pool.email, 'INBOX')).toBe(0);
        expect(await engine.warmup.scheduleInbox(sender.id)).toBe(0);
        expect((await inboxRow(sender.id)).warmupDay).toBe(13);

        expect(await engine.stops.clear(stop.id, 'ops@test')).toMatchObject({
          clearedBy: 'ops@test',
        });
        const next = await planSend(sender, { poolInboxId: pool.id });
        await engine.sendProcessor.process(sendJobFor(next));
        expect((await getSend(next.id)).status).toBe('accepted');
      },
    );

    it('a user stop halts that account only', async () => {
      const stoppedUser = await createUser();
      const otherUser = await createUser();
      const stopped = await createInbox(stoppedUser);
      const other = await createInbox(otherUser);
      const stoppedPool = await createPoolInbox(stoppedUser);
      const otherPool = await createPoolInbox(otherUser);
      await engine.stops.activate({
        scope: 'user',
        key: stoppedUser,
        reason: 'abuse report',
        actor: 'ops',
      });

      const a = await planSend(stopped, { poolInboxId: stoppedPool.id });
      const b = await planSend(other, { poolInboxId: otherPool.id });
      await engine.sendProcessor.process(sendJobFor(a));
      await engine.sendProcessor.process(sendJobFor(b));

      expect((await getSend(a.id)).status).toBe('canceled');
      expect((await getSend(b.id)).status).toBe('accepted');
    });

    it('a stop holds back replies but still lets mail be opened and filed', async () => {
      const { sender, receiver } = await pair();
      const planned = await planSend(sender, { inboxId: receiver.id });
      await engine.sendProcessor.process(sendJobFor(planned));
      const queued = engine.queue
        .of('warmup-receive')
        .find((j) => j.payload.sendId === planned.id)!;
      await engine.stops.activate({ scope: 'global', reason: 'incident', actor: 'ops' });

      await engine.receiveProcessor.process(
        fakeJob({ ...queued.payload, actions: ['open', 'star', 'reply'] }),
      );

      const row = await getSend(planned.id);
      expect(row.replyStatus).toBeNull();
      expect(row.openedAt).toBeInstanceOf(Date);
      expect(row.filedAt).toBeInstanceOf(Date);
    });

    it('activation is idempotent, validated, and leaves an audit trail', async () => {
      const first = await engine.stops.activate({
        scope: 'global',
        reason: 'drill',
        actor: 'ops-a',
      });
      const again = await engine.stops.activate({
        scope: 'global',
        reason: 'drill again',
        actor: 'ops-b',
      });
      expect(again.id).toBe(first.id);

      await expect(
        engine.stops.activate({ scope: 'planet', reason: 'x', actor: 'o' }),
      ).rejects.toThrow('scope');
      await expect(
        engine.stops.activate({ scope: 'provider', key: 'aol', reason: 'x', actor: 'o' }),
      ).rejects.toThrow('provider');
      await expect(
        engine.stops.activate({ scope: 'user', reason: 'x', actor: 'o' }),
      ).rejects.toThrow('user id');
      await expect(
        engine.stops.activate({ scope: 'global', reason: ' ', actor: 'o' }),
      ).rejects.toThrow('reason');

      await engine.stops.clear(first.id, 'ops-c');
      expect(await engine.stops.clear(first.id, 'ops-c')).toBeNull();
      expect(await engine.stops.list()).toHaveLength(0);
      const audit = await db.select().from(safetyStops);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ createdBy: 'ops-a', clearedBy: 'ops-c', reason: 'drill' });
    });
  });

  describe('customer-supplied mail hosts (MR-11)', () => {
    it.each([
      ['a private address', '10.0.0.5'],
      ['the cloud metadata address', '169.254.169.254'],
      ['IPv6 loopback', '::1'],
      ['localhost by name', 'localhost'],
    ])('refuses to open SMTP to %s', async (_name, host) => {
      const inbox = await createInbox(await createUser(), { smtpHost: host });
      await expect(engine.smtp.getTransporter(inbox.id)).rejects.toBeInstanceOf(EgressDeniedError);
    });

    it('refuses to open IMAP to an internal address, for inboxes and pool inboxes', async () => {
      const user = await createUser();
      const inbox = await createInbox(user, { imapHost: '192.168.1.10' });
      await expect(engine.imap.getConnection(inbox.id)).rejects.toBeInstanceOf(EgressDeniedError);

      const pool = await createPoolInbox(user);
      const creds = pool.encryptedCredentials as Record<string, unknown>;
      const { poolInboxes } = await import('../../src/db/schema');
      await db
        .update(poolInboxes)
        .set({ encryptedCredentials: { ...creds, imapHost: '127.0.0.2', smtpHost: '10.1.1.1' } })
        .where(eq(poolInboxes.id, pool.id));
      await expect(engine.imap.getPoolInboxConnection(pool.id)).rejects.toBeInstanceOf(
        EgressDeniedError,
      );
      await expect(engine.smtp.getPoolInboxTransporter(pool.id)).rejects.toBeInstanceOf(
        EgressDeniedError,
      );
    });

    it('a scheduled send from an inbox with an internal host fails without connecting', async () => {
      const { sender, receiver } = await pair();
      await db.update(inboxes).set({ smtpHost: '10.0.0.5' }).where(eq(inboxes.id, sender.id));
      const planned = await planSend(sender, { inboxId: receiver.id });

      await expect(engine.sendProcessor.process(sendJobFor(planned))).rejects.toThrow();

      expect((await getSend(planned.id)).status).toBe('failed');
      expect(await findEverywhere(receiver.email, planned.messageId!)).toHaveLength(0);
    });
  });
});
