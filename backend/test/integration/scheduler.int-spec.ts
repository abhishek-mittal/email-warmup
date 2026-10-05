import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../src/db';
import { inboxes, poolInboxes, warmupSchedules, warmupSends } from '../../src/db/schema';
import { LIVE_SEND_STATUSES, PAIRING_LIMITS } from '../../src/warmup/pairing.service';
import {
  Engine,
  buildEngine,
  closeDb,
  createInbox,
  createPoolInbox,
  createUser,
  enroll,
  resetDb,
  uniqueEmail,
} from './harness';

const MIN = 60_000;
const SPACING_MS = 8 * MIN;

/** 05:00 UTC today — when the daily cron fires. */
function cronTime(): Date {
  const d = new Date();
  d.setUTCHours(5, 0, 0, 0);
  return d;
}
function atUtc(hours: number, minutes = 0): Date {
  const d = new Date();
  d.setUTCHours(hours, minutes, 0, 0);
  return d;
}

async function sendsFor(inboxId: string) {
  return db.select().from(warmupSends).where(eq(warmupSends.senderInboxId, inboxId));
}
async function liveSendsFor(inboxId: string) {
  return db
    .select()
    .from(warmupSends)
    .where(
      and(eq(warmupSends.senderInboxId, inboxId), inArray(warmupSends.status, LIVE_SEND_STATUSES)),
    );
}
async function inboxRow(id: string) {
  return (await db.select().from(inboxes).where(eq(inboxes.id, id)))[0];
}
function assertSpacing(rows: { scheduledAt: Date }[]) {
  const times = rows.map((r) => r.scheduledAt.getTime()).sort((a, b) => a - b);
  for (let i = 1; i < times.length; i++) {
    expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(SPACING_MS);
  }
}

describe('warmup scheduling (MR-03)', () => {
  let engine: Engine;

  beforeEach(async () => {
    await resetDb();
    engine = buildEngine();
  });

  afterAll(async () => {
    await closeDb();
  });

  /** A sender (medium speed, warmupDay 13 -> 25/day target) with a roomy private pool. */
  async function senderWithPrivatePool(poolSize = 5, warmupDay = 13) {
    const user = await createUser();
    const sender = await createInbox(user, { warmupDay });
    const pool = [];
    for (let i = 0; i < poolSize; i++) pool.push(await createPoolInbox(user));
    return { user, sender, pool };
  }

  it('reserves the day’s volume once, with spaced slots inside the send window', async () => {
    const { sender } = await senderWithPrivatePool(5, 13);

    const reserved = await engine.warmup.scheduleInbox(sender.id, cronTime());

    const [schedule] = await db
      .select()
      .from(warmupSchedules)
      .where(eq(warmupSchedules.inboxId, sender.id));
    expect(reserved).toBe(schedule.plannedVolume);
    const rows = await sendsFor(sender.id);
    expect(rows).toHaveLength(schedule.plannedVolume);
    expect(rows.every((r) => r.status === 'planned')).toBe(true);
    assertSpacing(rows);
    for (const row of rows) {
      expect(row.scheduledAt.getTime()).toBeGreaterThanOrEqual(atUtc(8).getTime());
      expect(row.scheduledAt.getTime()).toBeLessThanOrEqual(atUtc(18).getTime());
    }
    expect(engine.queue.of('warmup-send')).toHaveLength(schedule.plannedVolume);
    expect((await inboxRow(sender.id)).warmupDay).toBe(14);
  });

  it('a second run the same day changes nothing (second cron, second replica)', async () => {
    const { sender } = await senderWithPrivatePool();
    await engine.warmup.scheduleInbox(sender.id, cronTime());
    const before = await sendsFor(sender.id);

    expect(await engine.warmup.scheduleInbox(sender.id, cronTime())).toBe(0);
    expect(await engine.warmup.scheduleInbox(sender.id, atUtc(9))).toBe(0);

    expect(await sendsFor(sender.id)).toHaveLength(before.length);
    expect((await inboxRow(sender.id)).warmupDay).toBe(14);
    expect(await db.select().from(warmupSchedules)).toHaveLength(1);
  });

  it('two replicas scheduling concurrently cannot overshoot the daily cap', async () => {
    const { sender } = await senderWithPrivatePool();
    const other = buildEngine();

    await Promise.all([
      engine.warmup.scheduleInbox(sender.id, cronTime()),
      other.warmup.scheduleInbox(sender.id, cronTime()),
      engine.warmup.scheduleInbox(sender.id, cronTime()),
    ]);

    const [schedule] = await db.select().from(warmupSchedules);
    expect(await db.select().from(warmupSchedules)).toHaveLength(1);
    expect(await liveSendsFor(sender.id)).toHaveLength(schedule.plannedVolume);
    expect((await inboxRow(sender.id)).warmupDay).toBe(14);
  });

  it('resume on an active inbox is a no-op, however often it is clicked', async () => {
    const { sender } = await senderWithPrivatePool();
    await engine.warmup.scheduleInbox(sender.id, cronTime());
    const before = (await sendsFor(sender.id)).length;

    for (let i = 0; i < 5; i++) {
      expect(await engine.warmup.resumeInbox(sender.id)).toBe('active');
    }

    expect(await sendsFor(sender.id)).toHaveLength(before);
    expect((await inboxRow(sender.id)).warmupDay).toBe(14);
  });

  it('pause releases reservations; resume tops up to the cap without advancing the day', async () => {
    const { sender, pool } = await senderWithPrivatePool();
    await engine.warmup.scheduleInbox(sender.id, cronTime());
    const [schedule] = await db.select().from(warmupSchedules);
    // Three of today's sends already went out before the pause.
    const planned = await sendsFor(sender.id);
    const accepted = planned.slice(0, 3).map((r) => r.id);
    await db
      .update(warmupSends)
      .set({ status: 'accepted', sentAt: new Date() })
      .where(inArray(warmupSends.id, accepted));

    await engine.warmup.pauseInbox(sender.id);

    expect((await inboxRow(sender.id)).status).toBe('paused');
    expect(await liveSendsFor(sender.id)).toHaveLength(3);
    expect(engine.queue.of('warmup-send')).toHaveLength(0);
    const poolAfterPause = await db
      .select()
      .from(poolInboxes)
      .where(
        inArray(
          poolInboxes.id,
          pool.map((p) => p.id),
        ),
      );
    expect(poolAfterPause.reduce((sum, p) => sum + p.activePairs, 0)).toBe(3);

    await engine.warmup.resumeInbox(sender.id);
    await engine.warmup.resumeInbox(sender.id);

    const live = await liveSendsFor(sender.id);
    expect(live.length).toBeLessThanOrEqual(schedule.plannedVolume);
    expect((await inboxRow(sender.id)).status).toBe('active');
    expect((await inboxRow(sender.id)).warmupDay).toBe(14);
    expect(await db.select().from(warmupSchedules)).toHaveLength(1);
    // Everything newly reserved is in the future — no burst of overdue slots.
    const fresh = live.filter((r) => r.status === 'planned');
    for (const row of fresh) {
      expect(row.scheduledAt.getTime()).toBeGreaterThan(Date.now());
    }
    expect(engine.queue.of('warmup-send').every((j) => j.opts.delay > 0)).toBe(true);
  });

  it('a late-day start gets only the slots that still fit, all in the future', async () => {
    const { sender } = await senderWithPrivatePool(5, 20); // ~46/day target
    const late = atUtc(17, 30);

    const reserved = await engine.warmup.scheduleInbox(sender.id, late);

    // 17:38 -> 18:00 leaves room for 3 sends at 8-minute spacing.
    expect(reserved).toBe(3);
    const rows = await sendsFor(sender.id);
    assertSpacing(rows);
    for (const row of rows) {
      expect(row.scheduledAt.getTime()).toBeGreaterThanOrEqual(late.getTime() + SPACING_MS);
      expect(row.scheduledAt.getTime()).toBeLessThanOrEqual(atUtc(18).getTime());
    }
  });

  it('holds spacing and the cap under extreme jitter', async () => {
    for (const extreme of [0, 1]) {
      await resetDb();
      const local = buildEngine();
      local.warmup.rng = () => extreme;
      const user = await createUser();
      const sender = await createInbox(user, { warmupSpeed: 'fast', warmupDay: 21 }); // 150/day target
      for (let i = 0; i < 10; i++) await createPoolInbox(user);

      await local.warmup.scheduleInbox(sender.id, cronTime());

      const rows = await sendsFor(sender.id);
      expect(rows.length).toBeLessThanOrEqual(76); // what a 10h window holds at 8-minute spacing
      expect(rows.length).toBeGreaterThan(0);
      assertSpacing(rows);
      for (const row of rows) {
        expect(row.scheduledAt.getTime()).toBeLessThanOrEqual(atUtc(18).getTime());
      }
    }
  });

  it('does not schedule or advance the day for an inbox that is not active', async () => {
    const user = await createUser();
    await createPoolInbox(user);
    for (const status of ['paused', 'pending', 'error', 'graduated']) {
      const inbox = await createInbox(user, { status, warmupDay: 4 });
      expect(await engine.warmup.scheduleInbox(inbox.id, cronTime())).toBe(0);
      expect((await inboxRow(inbox.id)).warmupDay).toBe(4);
    }
    expect(await db.select().from(warmupSends)).toHaveLength(0);
  });

  it('one inbox failing does not stop the rest of the day', async () => {
    const a = await senderWithPrivatePool(2, 1);
    const b = await senderWithPrivatePool(2, 1);
    const real = engine.warmup.scheduleInbox.bind(engine.warmup);
    jest.spyOn(engine.warmup, 'scheduleInbox').mockImplementation(async (id, now) => {
      if (id === a.sender.id) throw new Error('boom');
      return real(id, now);
    });

    await engine.warmup.scheduleAllInboxes(cronTime());

    expect((await sendsFor(b.sender.id)).length).toBeGreaterThan(0);
  });

  describe('shared-pool pairing', () => {
    async function sharedSender(warmupDay = 13) {
      const user = await createUser();
      const sender = await createInbox(user, { warmupDay });
      await enroll(sender);
      return sender;
    }
    async function sharedPartner(overrides: Parameters<typeof createInbox>[1] = {}, member = {}) {
      const user = await createUser();
      const inbox = await createInbox(user, overrides);
      await enroll(inbox, member);
      return inbox;
    }

    it('spreads volume across partners instead of aiming it at the best one', async () => {
      const sender = await sharedSender(13); // 25/day target
      const partners = [];
      for (let i = 0; i < 4; i++) partners.push(await sharedPartner());

      await engine.warmup.scheduleInbox(sender.id, cronTime());

      const rows = await sendsFor(sender.id);
      // 4 partners x 3 per pair per day.
      expect(rows).toHaveLength(4 * PAIRING_LIMITS.sharedPerPair);
      for (const partner of partners) {
        expect(rows.filter((r) => r.receiverInboxId === partner.id)).toHaveLength(
          PAIRING_LIMITS.sharedPerPair,
        );
      }
    });

    it('only pairs with consenting, active, non-quarantined inboxes on other domains', async () => {
      const sender = await sharedSender();
      const good = await sharedPartner();
      const sameDomain = await sharedPartner({ email: `x@${sender.email.split('@')[1]}` });
      const noConsent = await sharedPartner({ poolConsentAt: null });
      const paused = await sharedPartner({ status: 'paused' });
      const quarantined = await sharedPartner({}, { quarantined: true });
      const inactiveMember = await sharedPartner({}, { active: false });

      await engine.warmup.scheduleInbox(sender.id, cronTime());

      const receivers = new Set((await sendsFor(sender.id)).map((r) => r.receiverInboxId));
      expect(receivers).toEqual(new Set([good.id]));
      for (const excluded of [sameDomain, noConsent, paused, quarantined, inactiveMember]) {
        expect(receivers.has(excluded.id)).toBe(false);
      }
    });

    it('a sender without pool consent is never placed in the shared pool', async () => {
      const user = await createUser();
      const sender = await createInbox(user, { poolConsentAt: null, warmupDay: 13 });
      await enroll(sender);
      await sharedPartner();

      expect(await engine.warmup.scheduleInbox(sender.id, cronTime())).toBe(0);
    });

    it('respects a receiver’s daily inbound capacity across all senders', async () => {
      const receiver = await sharedPartner();
      const senders = [];
      // All senders share one domain, so they can never pair with each other:
      // `receiver` is each one's only candidate (3 sends each, 48 wanted in total).
      const domain = uniqueEmail('fleet').split('@')[1];
      for (let i = 0; i < 16; i++) {
        const user = await createUser();
        const sender = await createInbox(user, { warmupDay: 13, email: `s${i}@${domain}` });
        await enroll(sender);
        senders.push(sender);
      }

      for (const sender of senders) {
        await engine.warmup.scheduleInbox(sender.id, cronTime());
      }

      const inbound = await db
        .select()
        .from(warmupSends)
        .where(
          and(
            eq(warmupSends.receiverInboxId, receiver.id),
            inArray(warmupSends.status, LIVE_SEND_STATUSES),
          ),
        );
      expect(inbound.length).toBe(PAIRING_LIMITS.receiverInbound);
    });

    it('uses the tenant’s private pool before the shared pool', async () => {
      const user = await createUser();
      const sender = await createInbox(user, { warmupDay: 1 }); // 3/day target
      await enroll(sender);
      const own = await createPoolInbox(user, { email: uniqueEmail('own') });
      await sharedPartner();

      await engine.warmup.scheduleInbox(sender.id, cronTime());

      const rows = await sendsFor(sender.id);
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.receiverPoolInboxId === own.id)).toBe(true);
    });
  });

  it('recovery releases reservations whose slot passed, rather than sending them late', async () => {
    const { sender } = await senderWithPrivatePool();
    await engine.warmup.scheduleInbox(sender.id, cronTime());

    const result = await engine.ledger.recover(new Date(atUtc(23).getTime()));

    expect(result.expired).toBe((await sendsFor(sender.id)).length);
    expect(await liveSendsFor(sender.id)).toHaveLength(0);
  });
});
