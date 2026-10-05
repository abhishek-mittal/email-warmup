/**
 * Local-dev demo data, so every screen has something to look at.
 *
 *   pnpm db:seed:dev          # (re)create demo data
 *   pnpm db:seed:dev --reset  # remove it again
 *
 * Safe by construction:
 *  - refuses to run unless DATABASE_URL points at localhost and NODE_ENV is not production;
 *  - only ever touches rows whose mailbox address ends in ".test" (a reserved TLD that
 *    can never resolve), so real connected mailboxes are left alone;
 *  - every credential is the encryption of a dummy string and every host is a ".test"
 *    name, so nothing seeded can authenticate or send mail anywhere.
 * Re-running first removes the previous demo rows, so the result is the same each time
 * (dates are relative to "now", the randomness is seeded).
 *
 * Needs the migrated schema and the users created by the test-account setup in testing.md.
 */
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { db } from '../src/db';
import {
  blacklistChecks,
  diagnostics,
  dnsChecks,
  inboxAnalysis,
  inboxes,
  notifications,
  placementResults,
  placementTests,
  poolInboxes,
  poolMembers,
  reputationScores,
  safetyStops,
  seedInboxes,
  stripeEvents,
  users,
  warmupSchedules,
  warmupSends,
} from '../src/db/schema';
import { encrypt } from '../src/common/crypto';

const DAY = 86_400_000;
const NOW = Date.now();
const ago = (days: number, hour = 9, minute = 0) => {
  const d = new Date(NOW - days * DAY);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
};
const ymd = (d: Date) => d.toISOString().slice(0, 10);

// Mulberry32: small seeded PRNG so every run produces the same numbers.
let seed = 20261003;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const chance = (p: number) => rnd() < p;
const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));

const SUBJECTS = [
  'Quick note about Thursday', 'Following up on the proposal', 'Notes from our call', 'Can you take a look at this?',
  'Re: schedule for next week', 'Thanks for the intro', 'Small question on the invoice', 'Draft for your review',
  'Catching up', 'Agenda for tomorrow', 'One more thing on the contract', 'Checking in',
];
const RBL_ZONES = ['zen.spamhaus.org', 'dbl.spamhaus.org', 'bl.spamcop.net', 'b.barracudacentral.org', 'multi.surbl.org'];

type Health = 'good' | 'ok' | 'weak' | 'spam' | 'listed' | 'broken';
interface InboxSpec {
  email: string;
  provider: 'gmail' | 'outlook' | 'custom';
  status: 'pending' | 'active' | 'paused' | 'graduated' | 'error' | 'disconnected';
  statusReason?: string;
  day: number;
  speed?: 'slow' | 'medium' | 'fast';
  consent?: boolean;
  health: Health;
  tests?: number; // placement tests to create
}
interface UserSpec {
  email: string;
  inboxes: InboxSpec[];
  pool?: number; // private pool inboxes to create
  notes?: boolean;
}

const PLAN: UserSpec[] = [
  {
    email: 'founder@emailwarm.dev',
    pool: 5,
    notes: true,
    inboxes: [
      { email: 'sales@acme-outbound.test', provider: 'gmail', status: 'active', day: 24, consent: true, health: 'good', tests: 2 },
      { email: 'hello@acme-outbound.test', provider: 'outlook', status: 'active', day: 9, consent: true, health: 'ok', tests: 1 },
      { email: 'founder@northwind-labs.test', provider: 'custom', status: 'active', day: 3, speed: 'slow', consent: true, health: 'weak' },
      { email: 'team@kestrel-io.test', provider: 'gmail', status: 'graduated', day: 35, consent: true, health: 'good', tests: 2 },
      { email: 'ops@brightpath.test', provider: 'custom', status: 'paused', statusReason: 'user', day: 15, consent: true, health: 'ok', tests: 1 },
      { email: 'billing@northwind-labs.test', provider: 'outlook', status: 'error', statusReason: 'credentials_revoked', day: 11, consent: true, health: 'broken' },
      { email: 'new@brightpath.test', provider: 'gmail', status: 'pending', day: 0, health: 'ok' },
      { email: 'support@kestrel-io.test', provider: 'custom', status: 'disconnected', day: 6, health: 'ok' },
    ],
  },
  {
    email: 'growth@emailwarm.dev',
    pool: 2,
    inboxes: [
      { email: 'outreach@growthlab.test', provider: 'gmail', status: 'active', day: 14, consent: true, health: 'good', tests: 1 },
      { email: 'hi@growthlab.test', provider: 'outlook', status: 'active', day: 6, consent: true, health: 'ok' },
      { email: 'ceo@fieldnote.test', provider: 'gmail', status: 'graduated', day: 35, consent: true, health: 'good', tests: 1 },
    ],
  },
  { email: 'starter@emailwarm.dev', inboxes: [{ email: 'me@solo-studio.test', provider: 'gmail', status: 'active', day: 5, consent: true, health: 'ok' }] },
  { email: 'blacklist@emailwarm.dev', inboxes: [{ email: 'sales@listed-co.test', provider: 'gmail', status: 'paused', statusReason: 'blacklist', day: 12, consent: true, health: 'listed', tests: 1 }] },
  { email: 'spam@emailwarm.dev', inboxes: [{ email: 'outbound@spammy-co.test', provider: 'outlook', status: 'active', day: 18, consent: true, health: 'spam', tests: 2 }] },
];

const rowsPerChunk = 400;
async function insertChunked<T>(table: any, rows: T[]) {
  for (let i = 0; i < rows.length; i += rowsPerChunk) await db.insert(table).values(rows.slice(i, i + rowsPerChunk) as any);
}

function guard() {
  const url = process.env.DATABASE_URL ?? '';
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  })();
  if (process.env.NODE_ENV === 'production' || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    console.error(`Refusing to seed: DATABASE_URL host is "${host || 'unset'}". This script only runs against a local database.`);
    process.exit(1);
  }
}

async function reset() {
  const inb = await db.select({ id: inboxes.id }).from(inboxes).where(like(inboxes.email, '%.test'));
  const ids = inb.map((r) => r.id);
  const pools = await db.select({ id: poolInboxes.id }).from(poolInboxes).where(like(poolInboxes.email, '%.test'));
  const poolIds = pools.map((r) => r.id);
  if (ids.length) {
    const tests = await db.select({ id: placementTests.id }).from(placementTests).where(inArray(placementTests.inboxId, ids));
    if (tests.length) await db.delete(placementResults).where(inArray(placementResults.testId, tests.map((t) => t.id)));
    await db.delete(placementTests).where(inArray(placementTests.inboxId, ids));
    await db.delete(diagnostics).where(inArray(diagnostics.inboxId, ids));
    await db.delete(reputationScores).where(inArray(reputationScores.inboxId, ids));
    await db.delete(blacklistChecks).where(inArray(blacklistChecks.inboxId, ids));
    await db.delete(dnsChecks).where(inArray(dnsChecks.inboxId, ids));
    await db.delete(inboxAnalysis).where(inArray(inboxAnalysis.inboxId, ids));
    await db.delete(notifications).where(inArray(notifications.inboxId, ids));
    await db.delete(warmupSends).where(inArray(warmupSends.senderInboxId, ids));
    await db.delete(warmupSchedules).where(inArray(warmupSchedules.inboxId, ids));
    await db.delete(poolMembers).where(inArray(poolMembers.inboxId, ids));
    await db.delete(inboxes).where(inArray(inboxes.id, ids));
  }
  if (poolIds.length) await db.delete(inboxAnalysis).where(inArray(inboxAnalysis.poolInboxId, poolIds));
  await db.delete(poolInboxes).where(like(poolInboxes.email, '%.test'));
  await db.delete(seedInboxes).where(like(seedInboxes.email, '%.test'));
  await db.delete(safetyStops).where(eq(safetyStops.createdBy, 'seed-dev'));
  await db.delete(stripeEvents).where(like(stripeEvents.id, 'evt_seed_%'));
  await db.delete(notifications).where(sql`${notifications.payload} ->> 'seed' = 'true'`);
}

const dnsFor = (domain: string, h: Health) => {
  const spf = h !== 'broken' && h !== 'weak' ? true : h === 'weak' ? true : false;
  const dkim = !(h === 'weak' || h === 'broken' || h === 'spam');
  const dmarc = h === 'good' || h === 'listed';
  const rdns = h === 'good';
  const mx = h !== 'broken';
  const score = [spf, dkim, dmarc, mx, rdns].filter(Boolean).length * 20;
  return { spf, dkim, dmarc, mx, rdns, score };
};

function scoreSeries(day: number, h: Health): number[] {
  const n = Math.max(0, Math.min(day, 21));
  const end = { good: 86, ok: 66, weak: 46, spam: 44, listed: 38, broken: 30 }[h];
  const start = { good: 38, ok: 34, weak: 30, spam: 62, listed: 70, broken: 55 }[h];
  return Array.from({ length: n }, (_, i) => {
    const t = n === 1 ? 1 : i / (n - 1);
    return Math.max(5, Math.min(99, Math.round(start + (end - start) * t + (rnd() - 0.5) * 5)));
  });
}

const volumeForDay = (d: number, speed: string) => Math.min(Math.round((2 + d * 0.9) * ({ slow: 0.6, medium: 1, fast: 1.4 } as any)[speed]), 32);

const AI_SPAM = {
  primaryCause: 'Messages from outbound@spammy-co.test land in spam at Outlook and Gmail because the domain has no DMARC policy and its DKIM signature does not validate.',
  causes: [
    { code: 'DKIM_INVALID', explanation: 'The DKIM key published at selector "s1._domainkey.spammy-co.test" is empty, so receivers cannot verify the signature.', priority: 'critical' },
    { code: 'DMARC_NONE', explanation: 'A DMARC record exists with p=none. Providers treat unaligned mail more harshly without an enforced policy.', priority: 'warning' },
    { code: 'SPAM_RATE_HIGH', explanation: '38% of the last placement test landed in spam, concentrated at Outlook seeds.', priority: 'critical' },
  ],
  fixes: [
    { step: 1, action: 'Re-enable DKIM signing for spammy-co.test in your mail provider and publish the new public key.', expectedImpact: 'Signatures validate; spam placement at Outlook should fall within a week.' },
    { step: 2, action: 'Move DMARC from p=none to p=quarantine once DKIM and SPF align.', expectedImpact: 'Stronger trust signal for Gmail and Outlook.' },
    { step: 3, action: 'Drop the daily volume to 8 for five days, then resume the ramp.', expectedImpact: 'Lets reputation recover without new complaints.' },
  ],
  estimatedRecoveryDays: 10,
};
const AI_LISTED = {
  primaryCause: 'sales@listed-co.test shares a sending IP that appears on zen.spamhaus.org, so the mailbox was paused automatically.',
  causes: [{ code: 'BLACKLIST_HIT', explanation: 'zen.spamhaus.org lists the sending IP 198.51.100.24.', priority: 'critical' }],
  fixes: [
    { step: 1, action: 'Request delisting at the Spamhaus lookup page and explain the corrective action taken.', expectedImpact: 'Listing is usually lifted within 24 hours when the cause is fixed.' },
    { step: 2, action: 'Check the mailbox for compromised credentials and rotate the password.', expectedImpact: 'Stops the cause of the listing from repeating.' },
    { step: 3, action: 'Resume warm-up after the next blocklist check comes back clean.', expectedImpact: 'Clean checks restore the score over about a week.' },
  ],
  estimatedRecoveryDays: 4,
};
const AI_DNS = {
  primaryCause: 'founder@northwind-labs.test has no DKIM key published, so every message is unsigned.',
  causes: [{ code: 'DKIM_MISSING', explanation: 'No DKIM record was found at the selector for northwind-labs.test.', priority: 'critical' }],
  fixes: [{ step: 1, action: 'Generate a DKIM key for northwind-labs.test and publish the TXT record.', expectedImpact: 'Unsigned mail is the most common cause of early spam placement.' }],
  estimatedRecoveryDays: 3,
};

async function main() {
  guard();
  await reset();
  if (process.argv.includes('--reset')) {
    console.log('Demo data removed.');
    return;
  }

  /* ---------- global seed list (placement seeds) ---------- */
  const seedSpecs = [
    ...Array.from({ length: 5 }, (_, i) => ({ email: `seed${i + 1}@gmail-seed.test`, provider: 'gmail', host: 'imap.gmail-seed.test' })),
    ...Array.from({ length: 4 }, (_, i) => ({ email: `seed${i + 1}@outlook-seed.test`, provider: 'outlook', host: 'imap.outlook-seed.test' })),
    ...Array.from({ length: 3 }, (_, i) => ({ email: `seed${i + 1}@yahoo-seed.test`, provider: 'yahoo', host: 'imap.yahoo-seed.test' })),
  ];
  const seeds = await db
    .insert(seedInboxes)
    .values(
      seedSpecs.map((s, i) => ({
        email: s.email,
        provider: s.provider,
        imapHost: s.host,
        imapPort: 993,
        imapUser: s.email,
        imapPass: encrypt('demo-not-a-real-password'),
        active: true,
        lastCheckedAt: ago(0, 6),
        lastOkAt: i === 11 ? ago(4, 6) : ago(0, 6),
        lastError: i === 11 ? 'IMAP login failed: invalid credentials' : null,
        quarantinedAt: i === 11 ? ago(3, 6) : null,
      })),
    )
    .returning();

  await db.insert(safetyStops).values({ scope: 'global', key: '*', reason: 'Provider outage drill', createdBy: 'seed-dev', createdAt: ago(5, 10), clearedBy: 'seed-dev', clearedAt: ago(5, 11) });
  await db.insert(stripeEvents).values([{ id: 'evt_seed_checkout_1' }, { id: 'evt_seed_invoice_1' }]);

  const summary: string[] = [];

  for (const u of PLAN) {
    const [user] = await db.select().from(users).where(eq(users.email, u.email)).limit(1);
    if (!user) {
      console.warn(`skip ${u.email}: user not found (create the test accounts first)`);
      continue;
    }

    /* ---------- private pool inboxes (the other side of the conversations) ---------- */
    const pools: (typeof poolInboxes.$inferSelect)[] = [];
    const poolProviders = ['gmail', 'outlook', 'custom', 'gmail', 'custom'] as const;
    for (let i = 0; i < (u.pool ?? 0); i++) {
      const provider = poolProviders[i % poolProviders.length];
      const handle = `${u.email.split('@')[0]}-pool${i + 1}@pool-${i + 1}.test`;
      const failed = i === 4;
      const [row] = await db
        .insert(poolInboxes)
        .values({
          userId: user.id,
          email: handle,
          provider,
          status: failed ? 'error' : 'active',
          displayName: ['Maya Chen', 'Dev Okoro', 'Priya Raman', 'Sam Lee', 'Tomás Ruiz'][i],
          encryptedCredentials:
            provider === 'custom'
              ? { smtpHost: 'smtp.pool.test', smtpPort: 587, smtpUser: handle, smtpPassword: encrypt('demo'), imapHost: 'imap.pool.test', imapPort: 993, imapUser: handle, imapPassword: encrypt('demo') }
              : { clientId: 'demo-client.test', clientSecret: encrypt('demo'), refreshToken: encrypt('demo') },
          lastUsedAt: failed ? ago(3) : ago(0, 8),
          errorMessage: failed ? 'IMAP login failed: invalid credentials' : null,
          createdAt: ago(30),
        })
        .returning();
      pools.push(row);
      await db.insert(inboxAnalysis).values({ poolInboxId: row.id, spfValid: true, dkimValid: true, dmarcValid: !failed, mxValid: true, rdnsValid: true, placementEstimate: failed ? 'unknown' : 'inbox', healthScore: failed ? 70 : 100, issues: failed ? ['DMARC_NONE'] : [] });
    }

    /* ---------- warmed inboxes ---------- */
    const created: { row: typeof inboxes.$inferSelect; spec: InboxSpec }[] = [];
    for (const spec of u.inboxes) {
      const domain = spec.email.split('@')[1];
      const oauth = spec.provider !== 'custom';
      const [row] = await db
        .insert(inboxes)
        .values({
          userId: user.id,
          email: spec.email,
          provider: spec.provider,
          oauthProvider: oauth ? spec.provider : null,
          oauthAccessToken: oauth ? encrypt('demo-access-token') : null,
          oauthRefreshToken: oauth ? encrypt('demo-refresh-token') : null,
          oauthTokenExpiry: oauth ? ago(-1) : null,
          smtpHost: oauth ? null : `smtp.${domain}`,
          smtpPort: oauth ? null : 587,
          smtpUser: oauth ? null : spec.email,
          smtpPass: oauth ? null : encrypt('demo'),
          imapHost: oauth ? null : `imap.${domain}`,
          imapPort: oauth ? null : 993,
          imapUser: oauth ? null : spec.email,
          imapPass: oauth ? null : encrypt('demo'),
          dkimSelector: spec.health === 'weak' || spec.health === 'broken' ? null : 'google',
          sendingIp: spec.health === 'listed' ? '198.51.100.24' : spec.health === 'good' ? '203.0.113.10' : null,
          warmupSpeed: spec.speed ?? 'medium',
          warmupDay: spec.day,
          status: spec.status,
          statusReason: spec.statusReason ?? null,
          poolConsentAt: spec.consent ? ago(spec.day + 1) : null,
          enrolledInPoolAt: spec.consent && spec.status !== 'pending' ? ago(spec.day) : null,
          graduatedAt: spec.status === 'graduated' ? ago(5, 12) : null,
          createdAt: ago(Math.max(spec.day + 1, 1)),
        })
        .returning();
      created.push({ row, spec });
    }

    for (const { row, spec } of created) {
      const domain = spec.email.split('@')[1];
      const d = dnsFor(domain, spec.health);
      const active = spec.status === 'active' || spec.status === 'graduated';

      /* pool membership */
      if (spec.consent && spec.status !== 'pending') {
        await db.insert(poolMembers).values({
          inboxId: row.id,
          email: spec.email,
          domain,
          provider: spec.provider,
          industry: pick(['SaaS', 'Agency', 'Ecommerce', 'Consulting']),
          reputation: Math.max(10, Math.min(95, scoreSeries(spec.day, spec.health).slice(-1)[0] ?? 40)),
          active: spec.status === 'active' || spec.status === 'paused',
          quarantined: spec.health === 'listed',
        });
      }

      /* health analysis (run when connected) */
      await db.insert(inboxAnalysis).values({
        inboxId: row.id,
        spfValid: d.spf, dkimValid: d.dkim, dmarcValid: d.dmarc, mxValid: d.mx, rdnsValid: d.rdns,
        placementEstimate: spec.health === 'spam' ? 'spam' : spec.health === 'good' ? 'inbox' : spec.health === 'ok' ? 'promotions' : 'unknown',
        healthScore: d.score,
        issues: [!d.spf && 'SPF_MISSING', !d.dkim && 'DKIM_MISSING', !d.dmarc && 'DMARC_NONE', !d.mx && 'MX_MISSING', spec.health === 'listed' && 'BLACKLIST_HIT'].filter(Boolean) as string[],
        analysedAt: ago(spec.day + 1),
      });
      if (spec.status === 'pending') continue;

      /* dns + blocklist history, every other day */
      const checks = Math.max(2, Math.min(Math.floor(spec.day / 2) + 1, 10));
      const dnsRows = [];
      const blRows = [];
      for (let i = 0; i < checks; i++) {
        const when = ago(i * 2, 4, int(0, 40));
        dnsRows.push({
          inboxId: row.id,
          spfValid: d.spf, spfRecord: d.spf ? `v=spf1 include:_spf.${spec.provider === 'outlook' ? 'protection.outlook.com' : 'google.com'} ~all` : null,
          dkimValid: d.dkim, dkimSelector: row.dkimSelector,
          dmarcValid: d.dmarc, dmarcRecord: d.dmarc ? `v=DMARC1; p=quarantine; rua=mailto:dmarc@${domain}` : spec.health === 'ok' || spec.health === 'spam' ? `v=DMARC1; p=none` : null,
          mxValid: d.mx, mxRecords: d.mx ? [`10 mx1.${domain}`, `20 mx2.${domain}`] : [],
          rdnsValid: d.rdns, rdnsValue: d.rdns ? `mail.${domain}` : null,
          score: d.score, checkedAt: when,
        });
        const listed = spec.health === 'listed' && i < 2;
        blRows.push({
          inboxId: row.id,
          isClean: !listed,
          listedCount: listed ? 1 : 0,
          rblResults: Object.fromEntries(RBL_ZONES.map((z) => [z, listed && z === 'zen.spamhaus.org' ? 'listed' : spec.health === 'broken' && z === 'multi.surbl.org' ? 'unknown' : 'clean'])),
          checkedAt: when,
        });
      }
      await insertChunked(dnsChecks, dnsRows);
      await insertChunked(blacklistChecks, blRows);

      /* reputation score history */
      const series = scoreSeries(spec.day, spec.health);
      await insertChunked(
        reputationScores,
        series.map((score, i) => {
          const prev = series.slice(Math.max(0, i - 3), i);
          const avg = prev.length ? prev.reduce((a, b) => a + b, 0) / prev.length : score;
          return {
            inboxId: row.id,
            score,
            dnsScore: d.score,
            blacklistScore: spec.health === 'listed' && i > series.length - 3 ? 0 : 100,
            placementScore: Math.max(0, Math.min(100, score + int(-8, 6))),
            completeness: i < 2 ? 55 : 100,
            ruleVersion: 1,
            trend: i < 3 ? 'stable' : score > avg + 3 ? 'up' : score < avg - 3 ? 'down' : 'stable',
            recordedAt: ago(series.length - 1 - i, 5, 30),
          };
        }),
      );

      /* placement tests against the global seed list */
      for (let t = 0; t < (spec.tests ?? 0); t++) {
        const when = ago(t === 0 ? 2 : 11, 10);
        const bad = spec.health === 'spam' ? 0.38 : spec.health === 'listed' ? 0.3 : spec.health === 'good' ? 0.03 : 0.1;
        const picked = seeds.filter((s) => !s.quarantinedAt);
        const outcomes = picked.map((s) => {
          const r = rnd();
          if (r < bad) return 'spam';
          if (r < bad + 0.06) return 'not_found';
          if (r < bad + 0.06 + 0.16) return 'promotions';
          if (r < bad + 0.06 + 0.16 + 0.05) return 'other_inbox';
          return 'primary';
        });
        const n = (o: string) => outcomes.filter((x) => x === o).length;
        const observed = outcomes.length - n('not_found');
        const pct = (c: number) => (observed ? Math.round((c / observed) * 100) : 0);
        const [test] = await db
          .insert(placementTests)
          .values({
            inboxId: row.id, seedCount: picked.length, primaryCount: n('primary'), promotionsCount: n('promotions'), spamCount: n('spam'), missingCount: n('not_found'),
            primaryPct: pct(n('primary')), promotionsPct: pct(n('promotions')), spamPct: pct(n('spam')),
            placementScore: Math.max(0, Math.round(100 - pct(n('spam')) * 2 - pct(n('promotions')) / 2)),
            status: n('not_found') ? 'partial' : 'complete', messageId: `<placement-${row.id.slice(0, 8)}-${t}@${domain}>`,
            createdAt: when, startedAt: when, completedAt: new Date(when.getTime() + 4 * 60_000),
            observedCount: observed, otherInboxCount: n('other_inbox'), errorCount: 0, purpose: t === 1 && spec.status === 'graduated' ? 'graduation' : 'manual',
          })
          .returning();
        await db.insert(placementResults).values(
          picked.map((s, i) => ({ testId: test.id, seedInboxId: s.id, seedEmail: s.email, provider: s.provider, outcome: outcomes[i], observedAt: new Date(when.getTime() + (i + 1) * 20_000) })),
        );
      }

      /* schedules + sends: one schedule row per UTC day, sends spread across it */
      if (spec.day > 0 && spec.status !== 'disconnected') {
        const peers = created.filter((c) => c.row.id !== row.id && c.row.email.split('@')[1] !== domain && ['active', 'graduated', 'paused'].includes(c.spec.status));
        const daysBack = Math.min(spec.day, 14);
        const sendRows: any[] = [];
        for (let back = daysBack - 1; back >= 0; back--) {
          const dayNo = Math.max(1, spec.day - back);
          const date = ago(back, 0);
          const planned = volumeForDay(dayNo, spec.speed ?? 'medium');
          const [sched] = await db.insert(warmupSchedules).values({ inboxId: row.id, scheduleDate: ymd(date), warmupDay: dayNo, plannedVolume: planned, createdAt: ago(back, 5) }).returning();
          for (let slot = 0; slot < planned; slot++) {
            const hour = 7 + Math.floor((slot / planned) * 10);
            const at = ago(back, hour, int(0, 59));
            const future = at.getTime() > NOW;
            const paused = spec.status === 'paused' && back === 0;
            const toPool = pools.length > 0 && (peers.length === 0 || chance(0.7));
            const poolRow = toPool ? pick(pools.filter((p) => p.status === 'active')) : undefined;
            const peer = !toPool && peers.length ? pick(peers) : undefined;
            const ok = !future && !paused;
            const failed = ok && (spec.health === 'broken' ? chance(0.7) : chance(0.015));
            const spam = ok && !failed && chance(spec.health === 'spam' ? 0.38 : spec.health === 'good' ? 0.01 : 0.07);
            const opened = ok && !failed && chance(spam ? 0.5 : 0.75);
            const replied = opened && chance(0.38);
            const hardBounce = ok && !failed && spec.health === 'broken' && chance(0.05);
            sendRows.push({
              senderInboxId: row.id,
              receiverInboxId: peer?.row.id ?? null,
              receiverPoolInboxId: poolRow?.id ?? null,
              messageId: future || paused ? null : `<${row.id.slice(0, 8)}.${back}.${slot}@${domain}>`,
              subject: pick(SUBJECTS),
              bodyHash: `h${int(100000, 999999)}`,
              warmupDay: dayNo,
              scheduledAt: at,
              sentAt: ok && !failed ? at : null,
              openedAt: opened ? new Date(at.getTime() + int(2, 90) * 60_000) : null,
              repliedAt: replied ? new Date(at.getTime() + int(30, 240) * 60_000) : null,
              starredAt: opened && chance(0.1) ? new Date(at.getTime() + 20 * 60_000) : null,
              rescuedAt: spam && chance(0.85) ? new Date(at.getTime() + 15 * 60_000) : null,
              filedAt: ok && !failed ? new Date(at.getTime() + 8 * 60_000) : null,
              landedInSpam: spam,
              landedInTab: ok && !failed && !spam && chance(0.2) ? 'promotions' : null,
              status: future ? 'planned' : paused ? 'canceled' : failed ? 'failed' : 'accepted',
              deliveryKey: `${sched.id}:${slot}`,
              scheduleId: sched.id,
              slotIndex: slot,
              claimedAt: ok ? at : null,
              smtpResponse: ok && !failed ? '250 2.0.0 OK queued' : failed ? '535 5.7.8 Authentication credentials invalid' : null,
              failureReason: failed ? 'smtp_auth_failed' : paused ? 'inbox_paused' : null,
              receiveEnqueuedAt: ok && !failed ? at : null,
              replyStatus: replied ? 'accepted' : null,
              replyFiledAt: replied ? new Date(at.getTime() + 260 * 60_000) : null,
              bouncedAt: hardBounce ? new Date(at.getTime() + 2 * 60_000) : null,
              bounceType: hardBounce ? 'hard' : null,
              bounceDetail: hardBounce ? '550 5.1.1 The email account does not exist' : null,
              createdAt: at,
            });
          }
        }
        await insertChunked(warmupSends, sendRows);
      }

      /* diagnostics */
      const diag = async (triggerType: string, issueCodes: string[], aiAnalysis: unknown, readinessReport: unknown, daysAgo: number) =>
        db.insert(diagnostics).values({ inboxId: row.id, triggerType, issueCodes, aiAnalysis: aiAnalysis as any, readinessReport: readinessReport as any, createdAt: ago(daysAgo, 11) });
      if (spec.health === 'spam') await diag('auto_spam', ['SPAM_RATE_HIGH', 'DKIM_INVALID', 'DMARC_NONE'], AI_SPAM, null, 1);
      if (spec.health === 'listed') await diag('auto_blacklist', ['BLACKLIST_HIT'], AI_LISTED, null, 1);
      if (spec.health === 'weak') await diag('manual', ['DKIM_MISSING'], AI_DNS, null, 0);
      if (spec.status === 'graduated') {
        await diag('graduation', [], null, {
          inboxId: row.id, generatedAt: ago(5, 12).toISOString(), warmupDaysCompleted: spec.day, reputationScore: 86, primaryPlacementPct: 91,
          recommendedDailySendVolume: 60, warmupPoolContribution: 'Sent 412 and received 388 warm-up messages while ramping.',
          nextSteps: ['Start sending real campaigns at 20 a day and add 10 a day each week.', 'Keep the pool enrolment off now that the mailbox has graduated.', 'Run a placement test monthly.'],
          riskFactors: ['No DMARC enforcement yet; move to p=quarantine within 30 days.'],
        }, 5);
      }

      /* notifications */
      if (u.notes) {
        const base = { seed: 'true' };
        const add = (type: string, daysAgo: number, payload: object = {}) =>
          db.insert(notifications).values({ userId: user.id, inboxId: row.id, type, channel: 'email', payload: { ...base, ...payload }, sentAt: ago(daysAgo, 9), createdAt: ago(daysAgo, 9) });
        if (spec.status === 'graduated') await add('warmup_complete', 5, { warmupDay: spec.day });
        if (spec.status === 'error') await add('inbox_error', 2, { reason: 'credentials_revoked' });
        if (spec.status === 'paused') await add('inbox_paused', 4, { reason: spec.statusReason });
      }
    }

    if (pools.length) {
      const live = created.filter((c) => ['active', 'graduated'].includes(c.spec.status)).length;
      await db.update(poolInboxes).set({ activePairs: live }).where(and(eq(poolInboxes.userId, user.id), eq(poolInboxes.status, 'active')));
    }

    // Per-user notifications that don't hang off one inbox.
    if (u.email === 'blacklist@emailwarm.dev') {
      const [ib] = created;
      await db.insert(notifications).values({ userId: user.id, inboxId: ib.row.id, type: 'blacklist_hit', channel: 'email', payload: { seed: 'true', zone: 'zen.spamhaus.org' }, sentAt: ago(1, 7), createdAt: ago(1, 7) });
    }
    summary.push(`${u.email}: ${u.inboxes.length} inbox(es)${u.pool ? `, ${u.pool} pool inboxes` : ''}`);
  }

  const counts = await Promise.all([inboxes, warmupSends, reputationScores, placementTests, diagnostics, poolInboxes, seedInboxes].map(async (t: any) => {
    const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(t);
    return r.n;
  }));
  console.log(summary.join('\n'));
  console.log(`rows now: inboxes ${counts[0]}, warmup_sends ${counts[1]}, scores ${counts[2]}, placement tests ${counts[3]}, diagnostics ${counts[4]}, pool inboxes ${counts[5]}, seed inboxes ${counts[6]}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('seed failed:', err);
    process.exit(1);
  });
