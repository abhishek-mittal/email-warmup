import { eq } from 'drizzle-orm';
import { db } from '../../src/db';
import { placementResults, placementTests, seedInboxes, users } from '../../src/db/schema';
import { encrypt } from '../../src/common/crypto';
import { PlacementAnalyzerService } from '../../src/placement/placement-analyzer.service';
import { PlacementService } from '../../src/placement/placement.service';
import { PlacementTestProcessor } from '../../src/placement/placement-test.processor';
import { SeedListService } from '../../src/placement/seed-list.service';
import {
  Engine,
  IMAP_HOST,
  IMAP_PORT,
  buildEngine,
  closeDb,
  createInbox,
  createUser,
  fakeJob,
  moveToJunk,
  resetDb,
  uniqueEmail,
  withMailbox,
} from './harness';

const SEED_PASSWORD = 'seed-password';

async function addSeedRow(overrides: Partial<typeof seedInboxes.$inferInsert> = {}) {
  const email = overrides.email ?? uniqueEmail('seed');
  const [row] = await db
    .insert(seedInboxes)
    .values({
      email,
      provider: 'outlook',
      imapHost: IMAP_HOST,
      imapPort: IMAP_PORT,
      imapUser: email,
      imapPass: encrypt(SEED_PASSWORD),
      active: true,
      ...overrides,
    })
    .returning();
  return row;
}

describe('placement testing (MR-05 / MR-14)', () => {
  let engine: Engine;
  let seeds: SeedListService;
  let service: PlacementService;
  let processor: PlacementTestProcessor;
  let userId: string;
  let inbox: Awaited<ReturnType<typeof createInbox>>;

  beforeEach(async () => {
    await resetDb();
    await db.delete(placementTests);
    engine = buildEngine();
    seeds = new SeedListService();
    service = new PlacementService(seeds, engine.smtp, engine.queue as any);
    processor = new PlacementTestProcessor(
      new PlacementAnalyzerService(),
      engine.queue as any,
      seeds,
    );
    userId = await createUser('growth');
    inbox = await createInbox(userId);
  });

  afterEach(async () => {
    await engine.imap.onModuleDestroy();
  });

  afterAll(async () => {
    await closeDb();
  });

  const testRow = async (id: string) =>
    (await db.select().from(placementTests).where(eq(placementTests.id, id)))[0];
  const resultRows = (id: string) =>
    db.select().from(placementResults).where(eq(placementResults.testId, id));
  const runJob = (testId: string) => processor.process(fakeJob({ testId }));
  /** Where a seed "received" the message: move it as that provider's filter would have. */
  async function moveTo(seedEmail: string, messageId: string, folder: string) {
    if (folder === 'Junk') return moveToJunk(seedEmail, messageId);
    await withMailbox(seedEmail, async (client) => {
      await client.mailboxCreate(folder).catch(() => undefined);
      const lock = await client.getMailboxLock('INBOX');
      try {
        const uids = await client.search({ header: { 'message-id': messageId } }, { uid: true });
        await client.messageMove(String((uids || [])[0]), folder, { uid: true });
      } finally {
        lock.release();
      }
    });
  }
  async function deleteFrom(seedEmail: string, messageId: string) {
    await withMailbox(seedEmail, async (client) => {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const uids = await client.search({ header: { 'message-id': messageId } }, { uid: true });
        await client.messageDelete(String((uids || [])[0]), { uid: true });
      } finally {
        lock.release();
      }
    });
  }

  it('classifies each seed by the folder the message is really in', async () => {
    const inInbox = [await addSeedRow(), await addSeedRow(), await addSeedRow()];
    const inJunk = await addSeedRow({ provider: 'yahoo' });
    const lost = await addSeedRow();

    const started = await service.runTest(inbox.id, userId);
    const test = await testRow(started.testId);
    expect(test).toMatchObject({ status: 'queued', seedCount: 5, completedAt: null });
    expect(await resultRows(started.testId)).toHaveLength(5);

    await moveTo(inJunk.email, test.messageId!, 'Junk');
    await deleteFrom(lost.email, test.messageId!);
    await runJob(started.testId);

    const done = await testRow(started.testId);
    expect(done).toMatchObject({
      status: 'complete',
      observedCount: 5,
      errorCount: 0,
      primaryCount: 3,
      spamCount: 1,
      missingCount: 1,
      primaryPct: 60,
      spamPct: 20,
      placementScore: 60,
    });
    expect(done.completedAt).toBeInstanceOf(Date);
    expect(done.startedAt).toBeInstanceOf(Date);

    const byEmail = Object.fromEntries(
      (await resultRows(started.testId)).map((r) => [r.seedEmail, r.outcome]),
    );
    for (const seed of inInbox) expect(byEmail[seed.email]).toBe('primary');
    expect(byEmail[inJunk.email]).toBe('spam');
    expect(byEmail[lost.email]).toBe('not_found');
    expect(engine.queue.of('score-compute')).toHaveLength(1);
  });

  it('a seed that cannot be reached is an error, not spam or missing, and the rest still count', async () => {
    for (let i = 0; i < 4; i++) await addSeedRow();
    const unreachable = await addSeedRow({ imapPort: 1 });

    const started = await service.runTest(inbox.id, userId);
    await runJob(started.testId);

    const done = await testRow(started.testId);
    expect(done).toMatchObject({
      status: 'partial',
      seedCount: 5,
      observedCount: 4,
      errorCount: 1,
      primaryPct: 100,
      spamPct: 0,
      missingCount: 0,
      placementScore: 100,
    });
    const failed = (await resultRows(started.testId)).find(
      (r) => r.seedEmail === unreachable.email,
    )!;
    expect(['error', 'timeout']).toContain(failed.outcome);
  });

  it('a seed removed after the test started stays in the denominator as unavailable', async () => {
    const kept = [await addSeedRow(), await addSeedRow(), await addSeedRow()];
    const removed = await addSeedRow();

    const started = await service.runTest(inbox.id, userId);
    await db.delete(seedInboxes).where(eq(seedInboxes.id, removed.id));
    await runJob(started.testId);

    const done = await testRow(started.testId);
    expect(done).toMatchObject({
      status: 'partial',
      seedCount: 4,
      observedCount: kept.length,
      errorCount: 1,
    });
    const row = (await resultRows(started.testId)).find((r) => r.seedInboxId === removed.id)!;
    expect(row.outcome).toBe('seed_unavailable');
  });

  it('when no seed can be checked the test fails with no score, and does not move the reputation score', async () => {
    for (let i = 0; i < 3; i++) await addSeedRow();
    const started = await service.runTest(inbox.id, userId);
    await db.update(seedInboxes).set({ imapPort: 1 });

    await runJob(started.testId);

    const done = await testRow(started.testId);
    expect(done.status).toBe('failed');
    expect(done.placementScore).toBeNull();
    expect(done.spamPct).toBeNull();
    expect(done.failureReason).toContain('too few');
    expect(engine.queue.of('score-compute')).toHaveLength(0);
  });

  it('observations already saved survive a crash, and a retry only checks what is left', async () => {
    const seedRows = [await addSeedRow(), await addSeedRow(), await addSeedRow()];
    const started = await service.runTest(inbox.id, userId);
    const test = await testRow(started.testId);
    // A first attempt recorded one seed (as spam) and then died.
    await db
      .update(placementResults)
      .set({ outcome: 'spam', observedAt: new Date() })
      .where(eq(placementResults.seedInboxId, seedRows[0].id));
    await db
      .update(placementTests)
      .set({ status: 'running' })
      .where(eq(placementTests.id, test.id));

    await runJob(started.testId);

    const done = await testRow(started.testId);
    // The saved 'spam' stands even though the message is actually in that seed's inbox.
    expect(done).toMatchObject({ status: 'complete', spamCount: 1, primaryCount: 2 });

    // A redelivered job after completion changes nothing.
    await runJob(started.testId);
    expect((await testRow(started.testId)).completedAt).toEqual(done.completedAt);
    expect(engine.queue.of('score-compute')).toHaveLength(1);
  });

  describe('before anything is sent', () => {
    it('refuses, without using quota, when too few seeds are healthy', async () => {
      await addSeedRow();
      await addSeedRow();
      await addSeedRow({ quarantinedAt: new Date() });
      await addSeedRow({ active: false });

      await expect(service.runTest(inbox.id, userId)).rejects.toMatchObject({ status: 503 });
      expect(await db.select().from(placementTests)).toHaveLength(0);
    });

    it('never selects quarantined or disabled seeds', async () => {
      const good = [await addSeedRow(), await addSeedRow(), await addSeedRow()];
      await addSeedRow({ quarantinedAt: new Date() });
      await addSeedRow({ active: false });

      const started = await service.runTest(inbox.id, userId);

      const used = (await resultRows(started.testId)).map((r) => r.seedInboxId).sort();
      expect(used).toEqual(good.map((s) => s.id).sort());
    });

    it('a free or unknown plan gets no placement tests', async () => {
      for (let i = 0; i < 3; i++) await addSeedRow();
      for (const plan of ['free', 'mystery']) {
        await db.update(users).set({ plan }).where(eq(users.id, userId));
        await expect(service.runTest(inbox.id, userId)).rejects.toMatchObject({ status: 403 });
      }
    });

    it('parallel requests cannot exceed the monthly allowance', async () => {
      for (let i = 0; i < 3; i++) await addSeedRow();
      await db.update(users).set({ plan: 'starter' }).where(eq(users.id, userId)); // 1 per month

      const outcomes = await Promise.allSettled([
        service.runTest(inbox.id, userId),
        service.runTest(inbox.id, userId),
        service.runTest(inbox.id, userId),
      ]);

      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      for (const o of outcomes) {
        if (o.status === 'rejected') expect(o.reason).toMatchObject({ status: 429 });
      }
      expect(await db.select().from(placementTests)).toHaveLength(1);
    });

    it('a test whose message could not be sent is failed and does not use the allowance', async () => {
      for (let i = 0; i < 3; i++) await addSeedRow();
      await db.update(users).set({ plan: 'starter' }).where(eq(users.id, userId));
      const spy = jest
        .spyOn(engine.smtp, 'getTransporter')
        .mockRejectedValueOnce(new Error('auth failed'));

      await expect(service.runTest(inbox.id, userId)).rejects.toMatchObject({ status: 502 });
      spy.mockRestore();

      const [failed] = await db.select().from(placementTests);
      expect(failed.status).toBe('failed');
      expect(engine.queue.of('placement-test')).toHaveLength(0);
      // The allowance is still there.
      await expect(service.runTest(inbox.id, userId)).resolves.toMatchObject({ seedCount: 3 });
    });

    it('records seeds the sending server rejected, separately from observations', async () => {
      const seedRows = [
        await addSeedRow(),
        await addSeedRow(),
        await addSeedRow(),
        await addSeedRow(),
      ];
      jest.spyOn(engine.smtp, 'getTransporter').mockResolvedValue({
        sendMail: async () => ({ accepted: [], rejected: [seedRows[0].email.toUpperCase()] }),
      } as any);

      const started = await service.runTest(inbox.id, userId);

      const rejected = (await resultRows(started.testId)).find(
        (r) => r.seedInboxId === seedRows[0].id,
      )!;
      expect(rejected.outcome).toBe('smtp_rejected');
    });
  });

  describe('seed registry and health', () => {
    it('adds a seed only after it signs in, stores the password encrypted, never returns it', async () => {
      const email = uniqueEmail('newseed');
      const added = await seeds.add({
        email,
        provider: 'gmail',
        imapHost: IMAP_HOST,
        imapPort: IMAP_PORT,
        imapPass: 'the-seed-password',
      });

      expect(added).toMatchObject({ email, provider: 'gmail', healthy: true });
      expect(JSON.stringify(added)).not.toContain('the-seed-password');
      expect(added).not.toHaveProperty('imapPass');
      const [stored] = await db.select().from(seedInboxes).where(eq(seedInboxes.email, email));
      expect(stored.imapPass).not.toContain('the-seed-password');
      expect(JSON.stringify(await seeds.list())).not.toContain(stored.imapPass);
    });

    it('refuses a seed that cannot sign in, a duplicate, and bad input', async () => {
      const email = uniqueEmail('badseed');
      await expect(
        seeds.add({ email, provider: 'outlook', imapHost: IMAP_HOST, imapPort: 1, imapPass: 'x' }),
      ).rejects.toThrow('could not sign in');
      expect(await db.select().from(seedInboxes)).toHaveLength(0);

      await seeds.add({
        email,
        provider: 'outlook',
        imapHost: IMAP_HOST,
        imapPort: IMAP_PORT,
        imapPass: 'x',
      });
      await expect(
        seeds.add({
          email,
          provider: 'outlook',
          imapHost: IMAP_HOST,
          imapPort: IMAP_PORT,
          imapPass: 'x',
        }),
      ).rejects.toThrow('already exists');
      await expect(
        seeds.add({
          email: 'a@b.test',
          provider: 'aol',
          imapHost: IMAP_HOST,
          imapPort: IMAP_PORT,
          imapPass: 'x',
        }),
      ).rejects.toThrow('provider');
    });

    it('the health check quarantines a broken seed and restores it once it works again', async () => {
      const good = await addSeedRow();
      const broken = await addSeedRow({ imapPort: 1 });

      expect(await seeds.checkAll()).toEqual({ checked: 2, healthy: 1, quarantined: 1 });
      const afterFail = (
        await db.select().from(seedInboxes).where(eq(seedInboxes.id, broken.id))
      )[0];
      expect(afterFail.quarantinedAt).toBeInstanceOf(Date);
      expect(afterFail.lastError).toBeTruthy();
      expect((await seeds.getSeedAddresses('quick')).map((s) => s.id)).toEqual([good.id]);

      await db
        .update(seedInboxes)
        .set({ imapPort: IMAP_PORT })
        .where(eq(seedInboxes.id, broken.id));
      expect(await seeds.checkAll()).toEqual({ checked: 2, healthy: 2, quarantined: 0 });
      const restored = (
        await db.select().from(seedInboxes).where(eq(seedInboxes.id, broken.id))
      )[0];
      expect(restored.quarantinedAt).toBeNull();
      expect(restored.lastError).toBeNull();
    });

    it('reports coverage against the targets', async () => {
      await addSeedRow({ provider: 'gmail' });
      await addSeedRow({ provider: 'outlook' });
      await addSeedRow({ provider: 'yahoo', quarantinedAt: new Date() });

      expect(await seeds.coverage()).toMatchObject({
        total: 3,
        healthy: 2,
        quarantined: 1,
        byProvider: { gmail: 1, outlook: 1, yahoo: 0 },
        testsAvailable: false,
      });
    });
  });
});
