import { eq, sql } from 'drizzle-orm';
import { db } from '../../src/db';
import {
  diagnostics,
  dnsChecks,
  inboxes,
  notifications,
  poolInboxes,
  poolMembers,
  users,
  warmupSends,
} from '../../src/db/schema';
import { encrypt } from '../../src/common/crypto';
import { makePinoLoggerStub } from '../../src/common/pino-logger.stub';
import { AccountService } from '../../src/account/account.service';
import { BillingService } from '../../src/billing/billing.service';
import {
  Engine,
  buildEngine,
  closeDb,
  createInbox,
  createPoolInbox,
  createUser,
  enroll,
  findEverywhere,
  getSend,
  planSend,
  resetDb,
  sendJobFor,
} from './harness';

describe('disconnect, export and account deletion (MR-21)', () => {
  let engine: Engine;
  let account: AccountService;

  beforeAll(async () => {
    // Stand-ins for the sign-in tables better-auth owns in the same database.
    await db.execute(sql`create table if not exists "user" (id text primary key, email text)`);
    await db.execute(
      sql`create table if not exists "session" (id text primary key, "userId" text)`,
    );
    await db.execute(
      sql`create table if not exists "account" (id text primary key, "userId" text)`,
    );
  });

  beforeEach(async () => {
    await resetDb();
    await db.execute(sql`truncate table "user", "session", "account"`);
    engine = buildEngine();
    account = new AccountService(makePinoLoggerStub(), engine.warmup, engine.imap);
  });

  afterEach(async () => {
    await engine.imap.onModuleDestroy();
  });

  afterAll(async () => {
    await db.execute(sql`drop table if exists "session", "account", "user"`);
    await closeDb();
  });

  const inboxRow = async (id: string) =>
    (await db.select().from(inboxes).where(eq(inboxes.id, id)))[0];

  describe('disconnect', () => {
    it('stops the inbox, erases every stored credential, and frees its plan slot', async () => {
      const userId = await createUser();
      const inbox = await createInbox(userId, {
        warmupDay: 13,
        oauthRefreshToken: encrypt('refresh'),
        oauthAccessToken: encrypt('access'),
        oauthClientSecret: encrypt('secret'),
      });
      await enroll(inbox);
      await createPoolInbox(userId);
      await engine.warmup.scheduleInbox(inbox.id, new Date(new Date().setUTCHours(5, 0, 0, 0)));
      expect(engine.queue.of('warmup-send').length).toBeGreaterThan(0);

      expect(await account.disconnectInbox(userId, inbox.id)).toEqual({
        id: inbox.id,
        status: 'disconnected',
      });

      const row = await inboxRow(inbox.id);
      expect(row.status).toBe('disconnected');
      for (const field of [
        'oauthAccessToken',
        'oauthRefreshToken',
        'oauthClientSecret',
        'smtpPass',
        'imapPass',
      ] as const) {
        expect(row[field]).toBeNull();
      }
      expect(row.poolConsentAt).toBeNull();
      expect(row.warmupDay).toBe(14); // history kept
      expect(engine.queue.of('warmup-send')).toHaveLength(0);
      const members = await db.select().from(poolMembers).where(eq(poolMembers.inboxId, inbox.id));
      expect(members.every((m) => m.active === false)).toBe(true);

      // Not schedulable, not resumable, and no longer counted against the plan.
      expect(await engine.warmup.scheduleInbox(inbox.id)).toBe(0);
      expect(await engine.warmup.resumeInbox(inbox.id)).toBe('disconnected');
      await db.update(users).set({ plan: 'starter' }).where(eq(users.id, userId));
      const billing = new BillingService(makePinoLoggerStub(), engine.queue as any);
      expect(await billing.remainingInboxSlots(userId)).toBe(3);
    });

    it('a send already queued for a disconnected inbox goes nowhere', async () => {
      const sender = await createInbox(await createUser());
      const receiver = await createInbox(await createUser());
      await enroll(sender);
      await enroll(receiver);
      const planned = await planSend(sender, { inboxId: receiver.id });
      const job = sendJobFor(planned);

      await account.disconnectInbox(sender.userId, sender.id);
      await engine.sendProcessor.process(job);

      expect((await getSend(planned.id)).status).toBe('canceled');
      expect(await findEverywhere(receiver.email, planned.messageId!)).toHaveLength(0);
    });

    it('cannot disconnect an inbox owned by someone else', async () => {
      const inbox = await createInbox(await createUser());
      const stranger = await createUser();
      await expect(account.disconnectInbox(stranger, inbox.id)).rejects.toThrow();
      expect((await inboxRow(inbox.id)).status).toBe('active');
    });
  });

  it('export contains the account’s data and no credentials', async () => {
    const userId = await createUser();
    const inbox = await createInbox(userId);
    const pool = await createPoolInbox(userId);
    await planSend(
      inbox,
      { poolInboxId: pool.id },
      { status: 'accepted', subject: 'Quick hello', sentAt: new Date() },
    );
    const other = await createInbox(await createUser());

    const data = await account.exportData(userId);

    expect(data.account.id).toBe(userId);
    expect(data.inboxes.map((i) => i.email)).toEqual([inbox.email]);
    expect(data.poolInboxes.map((p) => p.email)).toEqual([pool.email]);
    expect(data.warmupSends).toHaveLength(1);
    const text = JSON.stringify(data);
    expect(text).not.toContain(inbox.smtpPass!);
    expect(text).not.toContain(other.email);
    expect(text).not.toMatch(/smtpPass|imapPass|oauthRefreshToken|encryptedCredentials/);
  });

  describe('account deletion', () => {
    async function seedAccount() {
      const userId = await createUser();
      const [user] = await db.select().from(users).where(eq(users.id, userId));
      const inbox = await createInbox(userId, { dkimSelector: 'mailo', sendingIp: '203.0.113.9' });
      await enroll(inbox);
      const pool = await createPoolInbox(userId);
      const partner = await createInbox(await createUser());
      await enroll(partner);
      const sent = await planSend(
        inbox,
        { inboxId: partner.id },
        { status: 'accepted', subject: 'Hello from me', sentAt: new Date() },
      );
      const received = await planSend(
        partner,
        { inboxId: inbox.id },
        { status: 'accepted', subject: 'Hello to them', sentAt: new Date() },
      );
      const reservedToPool = await planSend(inbox, { poolInboxId: pool.id });
      await db
        .insert(dnsChecks)
        .values({ inboxId: inbox.id, spfRecord: 'v=spf1 include:secret-vendor.example -all' });
      await db.insert(diagnostics).values({ inboxId: inbox.id, triggerType: 'manual' });
      await db.insert(notifications).values({ userId, type: 'dns_broken', channel: 'email' });
      await db.execute(sql`insert into "user" (id, email) values (${userId}, ${user.email})`);
      await db.execute(
        sql`insert into "session" (id, "userId") values ('s1', ${userId}), ('s2', ${userId})`,
      );
      await db.execute(sql`insert into "account" (id, "userId") values ('a1', ${userId})`);
      return { userId, user, inbox, pool, partner, sent, received, reservedToPool };
    }

    it('requires the account email as confirmation', async () => {
      const { userId, inbox } = await seedAccount();
      for (const bad of [undefined, '', 'someone@else.test', 42]) {
        await expect(account.deleteAccount(userId, bad)).rejects.toThrow('confirm');
      }
      expect((await inboxRow(inbox.id)).status).toBe('active');
    });

    it('removes everything identifying, keeps partner history intact, and signs the person out', async () => {
      const s = await seedAccount();

      expect(await account.deleteAccount(s.userId, s.user.email.toUpperCase())).toEqual({
        deleted: true,
      });

      // No trace of the customer's addresses, hosts or credentials anywhere.
      const dump = JSON.stringify({
        users: await db.select().from(users),
        inboxes: await db.select().from(inboxes),
        pool: await db.select().from(poolInboxes),
        members: await db.select().from(poolMembers),
        sends: await db.select().from(warmupSends),
      });
      for (const secret of [
        s.user.email,
        s.inbox.email,
        s.pool.email,
        s.inbox.email.split('@')[1],
        s.inbox.smtpPass!,
        '203.0.113.9',
        'Hello from me',
        'Hello to them',
      ]) {
        expect(dump).not.toContain(secret);
      }

      const inbox = await inboxRow(s.inbox.id);
      expect(inbox).toMatchObject({
        status: 'disconnected',
        smtpHost: null,
        imapHost: null,
        smtpPass: null,
      });
      expect(inbox.email).toMatch(/^deleted-.*@deleted\.invalid$/);
      const [pool] = await db.select().from(poolInboxes).where(eq(poolInboxes.id, s.pool.id));
      expect(pool).toMatchObject({ status: 'removed', encryptedCredentials: {} });
      const [user] = await db.select().from(users).where(eq(users.id, s.userId));
      expect(user.plan).toBe('deleted');

      expect(await db.select().from(dnsChecks)).toHaveLength(0);
      expect(await db.select().from(diagnostics)).toHaveLength(0);
      expect(await db.select().from(notifications)).toHaveLength(0);

      // The partner's ledger rows still exist, with their own data untouched.
      expect((await getSend(s.sent.id)).status).toBe('accepted');
      const received = await getSend(s.received.id);
      expect(received.status).toBe('accepted');
      expect(received.senderInboxId).toBe(s.partner.id);
      expect((await inboxRow(s.partner.id)).email).toBe(s.partner.email);
      expect((await getSend(s.reservedToPool.id)).status).toBe('canceled');

      // Signed out everywhere, sign-in identity gone.
      for (const table of ['user', 'session', 'account']) {
        const rows = await db.execute(sql`select count(*)::int as n from ${sql.identifier(table)}`);
        expect((rows.rows[0] as { n: number }).n).toBe(0);
      }
    });

    it('leaves other accounts untouched and can be repeated safely', async () => {
      const s = await seedAccount();
      const [partnerUser] = await db.select().from(users).where(eq(users.id, s.partner.userId));

      await account.deleteAccount(s.userId, s.user.email);

      expect((await db.select().from(users).where(eq(users.id, s.partner.userId)))[0]).toEqual(
        partnerUser,
      );
      expect((await inboxRow(s.partner.id)).status).toBe('active');
      // The old address no longer confirms anything.
      await expect(account.deleteAccount(s.userId, s.user.email)).rejects.toThrow('confirm');
    });

    it('nothing is scheduled to or from a deleted account afterwards', async () => {
      const s = await seedAccount();
      await db.update(inboxes).set({ warmupDay: 13 }).where(eq(inboxes.id, s.partner.id));
      await account.deleteAccount(s.userId, s.user.email);

      await engine.warmup.scheduleInbox(s.partner.id, new Date(new Date().setUTCHours(5, 0, 0, 0)));

      const toDeleted = (await db.select().from(warmupSends)).filter(
        (row) => row.receiverInboxId === s.inbox.id && row.status === 'planned',
      );
      expect(toDeleted).toHaveLength(0);
    });
  });
});
