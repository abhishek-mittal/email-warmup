#!/usr/bin/env node
/**
 * scripts/seed-test-users.mjs
 *
 * Idempotently creates the Phase 1 test accounts against the running stack.
 * Hits the better-auth sign-up endpoint directly (no Clerk involved), then
 * optionally back-fills the backend `users` table (plan, trial_ends_at) via
 * a direct SQL upsert so the seeded accounts have the right plan from day 1.
 *
 * Usage:
 *   1. .bin/dev up
 *   2. node scripts/seed-test-users.mjs                       # create all
 *   3. node scripts/seed-test-users.mjs --email admin@emailwarm.dev # create one
 *   4. node scripts/seed-test-users.mjs --reset                # delete all seeded users first
 *
 * Env vars (with safe local defaults — DO NOT use these defaults in prod):
 *   FRONTEND_URL     default http://localhost:3000  (where better-auth lives)
 *   BACKEND_URL      default http://localhost:4611  (NestJS — only used for the SQL back-fill)
 *   DATABASE_URL     default postgresql://emailwarm:localdev@localhost:5432/emailwarm
 *   TEST_USER_PASSWORD  default 'EmailWarm-Phase1-Test!'  (override per run)
 *
 * The script is idempotent: re-running it does NOT create duplicate accounts
 * (better-auth returns 422 "USER_EMAIL_EXISTS" which we treat as success).
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// `pg` is only installed under backend/ — there is no node_modules next to
// this script, so a bare `import pg from 'pg'` fails with ERR_MODULE_NOT_FOUND.
// Resolve it from the backend's install instead.
const pg = createRequire(resolve(ROOT, 'backend/package.json'))('pg');

// ---------- env + arg parsing ----------

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const singleEmail = args.find((a) => !a.startsWith('--'));

// Load .env files if present (no extra deps — just naive parsing)
function loadDotenv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadDotenv(resolve(ROOT, '.env'));
loadDotenv(resolve(ROOT, '.env.local'));
loadDotenv(resolve(ROOT, 'backend/.env'));
loadDotenv(resolve(ROOT, 'backend/.env.local'));
loadDotenv(resolve(ROOT, 'frontend/.env.local'));

const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:3000';
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:4611';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://emailwarm:localdev@localhost:5432/emailwarm';
const TEST_USER_PASSWORD = process.env.TEST_USER_PASSWORD ?? 'EmailWarm-Phase1-Test!';

// ---------- user catalog ----------
// Mirrors testing.md exactly. Update both in lockstep.

const USERS = [
  {
    email: 'admin@emailwarm.dev',
    name: 'Phase 1 Admin',
    role: 'super_admin',
    plan: 'enterprise',
    trialDays: 0,
    notes: 'Full plan, full inboxes. For admin flows + PlanGate skip.',
  },
  {
    email: 'founder@emailwarm.dev',
    name: 'Founder',
    role: 'owner',
    plan: 'agency',
    trialDays: 14,
    notes: 'High-tier plan, in-pool inbox. For testing placement + diagnostics AI path.',
  },
  {
    email: 'growth@emailwarm.dev',
    name: 'Growth User',
    role: 'user',
    plan: 'growth',
    trialDays: 0,
    notes: 'Mid-tier paid. Score breakdown visible. 5 placement tests / month.',
  },
  {
    email: 'starter@emailwarm.dev',
    name: 'Starter User',
    role: 'user',
    plan: 'starter',
    trialDays: 0,
    notes: 'Lowest paid tier. NO breakdown, NO diagnostics AI. 1 placement / month.',
  },
  {
    email: 'trial@emailwarm.dev',
    name: 'Trial User',
    role: 'user',
    plan: 'trial',
    trialDays: 7,
    notes: 'Active 7-day trial. Verifies trial banner + upgrade CTA.',
  },
  {
    email: 'expired@emailwarm.dev',
    name: 'Expired Trial',
    role: 'user',
    plan: 'trial',
    trialDays: -3,
    notes: 'Trial already expired (3 days ago). Verifies trial-expiry cron + paused-inbox state.',
  },
  {
    email: 'blacklist@emailwarm.dev',
    name: 'Blacklisted Inbox Owner',
    role: 'user',
    plan: 'growth',
    trialDays: 0,
    notes: 'Use to seed a RBL-listed inbox; verifies the pause-on-blacklist-hit flow.',
  },
  {
    email: 'spam@emailwarm.dev',
    name: 'Spam Placement Owner',
    role: 'user',
    plan: 'growth',
    trialDays: 0,
    notes: 'Use to seed a high-spam-rate placement result; verifies the AI diagnostics trigger.',
  },
];

// ---------- helpers ----------

async function signup({ email, name, password }) {
  // better-auth's CSRF protection requires the Origin (or Referer) header to
  // match the configured baseURL. The Next.js frontend sends this automatically
  // because the form posts are same-origin. From a script we have to set it
  // ourselves or better-auth returns 403.
  const res = await fetch(`${FRONTEND_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': FRONTEND_URL,
      'Referer': `${FRONTEND_URL}/sign-up`,
    },
    body: JSON.stringify({ email, password, name, callbackURL: '/inboxes' }),
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
  // better-auth returns 422 for duplicate email — treat as success for idempotency
  if (res.status === 422 && /USER_EMAIL_EXISTS|already exists|already been registered/i.test(text)) {
    return { status: 'exists', body };
  }
  if (!res.ok) {
    return { status: 'error', statusCode: res.status, body: body ?? text };
  }
  return { status: 'created', body };
}

async function backfillBackend({ email, name, plan, trialDays }) {
  // The frontend better-auth only owns the `user` + `session` + `account` tables.
  // The backend's `users` table has plan/trial fields; back-fill it via a direct
  // upsert so the seeded accounts have the right plan from the first request.
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const trialEndsAt = trialDays === 0
      ? null
      : new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000);
    await client.query(
      `INSERT INTO users (id, email, plan, trial_ends_at, created_at)
       SELECT u.id, u.email, $2::text, $3::timestamptz, NOW()
         FROM "user" u
        WHERE u.email = $1
       ON CONFLICT (id) DO UPDATE
         SET plan         = EXCLUDED.plan,
             trial_ends_at = EXCLUDED.trial_ends_at,
             email        = EXCLUDED.email`,
      [email, plan, trialEndsAt],
    );
    return { status: 'ok' };
  } catch (err) {
    return { status: 'error', error: err.message };
  } finally {
    await client.end();
  }
}

// ---------- main ----------

const targetUsers = singleEmail ? USERS.filter((u) => u.email === singleEmail) : USERS;
if (singleEmail && targetUsers.length === 0) {
  console.error(`[seed] No user with email=${singleEmail} in the catalog.`);
  console.error(`[seed] Known emails:`);
  for (const u of USERS) console.error(`         - ${u.email}`);
  process.exit(1);
}

if (flags.has('--reset')) {
  console.log('[seed] --reset: dropping seeded users from backend.users + better-auth tables…');
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const emails = targetUsers.map((u) => u.email);
    await client.query(`DELETE FROM users WHERE email = ANY($1::text[])`, [emails]);
    await client.query(`DELETE FROM "session" WHERE "userId" IN (SELECT id FROM "user" WHERE email = ANY($1::text[]))`, [emails]);
    await client.query(`DELETE FROM "account" WHERE "userId" IN (SELECT id FROM "user" WHERE email = ANY($1::text[]))`, [emails]);
    await client.query(`DELETE FROM "user" WHERE email = ANY($1::text[])`, [emails]);
  } finally {
    await client.end();
  }
  console.log('[seed] reset complete.');
}

console.log(`[seed] Creating ${targetUsers.length} test user(s) against ${FRONTEND_URL}…`);
console.log(`[seed] Password for all: ${TEST_USER_PASSWORD}  (set TEST_USER_PASSWORD to override)`);
console.log('');

let created = 0, existed = 0, errors = 0;

for (const u of targetUsers) {
  process.stdout.write(`  ${u.email.padEnd(34)} `);
  const r = await signup({ email: u.email, name: u.name, password: TEST_USER_PASSWORD });
  if (r.status === 'created') {
    process.stdout.write('signup OK   ');
    created++;
  } else if (r.status === 'exists') {
    process.stdout.write('exists      ');
    existed++;
  } else {
    process.stdout.write(`FAILED (${r.statusCode}) `);
    errors++;
  }
  // Always try to back-fill the backend row so plan/trial are right.
  const b = await backfillBackend(u);
  process.stdout.write(`${b.status === 'ok' ? 'plan=' + u.plan.padEnd(10) : 'BACKFILL FAILED: ' + b.error}`);
  console.log('');
}

console.log('');
console.log(`[seed] Done. created=${created}  existed=${existed}  errors=${errors}`);
console.log(`[seed] Sign in at ${FRONTEND_URL}/sign-in`);

process.exit(errors > 0 ? 1 : 0);
