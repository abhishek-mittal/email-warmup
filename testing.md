# EmailWarm — Test Accounts (Phase 1)

> **DO NOT seed these in production.** These accounts exist for local dev, E2E
> tests, and the `feat/003-real-hero-products` demo. If you point this guide
> at a real environment, the `emailwarm.dev` domain never resolves and the
> better-auth signup endpoint will return 422 for every row — that's the
> defense, not a bug.

This file is the source of truth for Phase 1 test users. The catalog here
mirrors `scripts/seed-test-users.mjs`; if you change one, change the other.

## Quick login

Sign in at <http://localhost:3000/sign-in>. Every account uses the same password.

| Email | Password | Plan |
|---|---|---|
| `admin@emailwarm.dev` | `EmailWarm-Phase1-Test!` | enterprise |
| `founder@emailwarm.dev` | `EmailWarm-Phase1-Test!` | agency (trial +14d) |
| `growth@emailwarm.dev` | `EmailWarm-Phase1-Test!` | growth |
| `starter@emailwarm.dev` | `EmailWarm-Phase1-Test!` | starter |123431
| `trial@emailwarm.dev` | `EmailWarm-Phase1-Test!` | trial (+7d) |
| `expired@emailwarm.dev` | `EmailWarm-Phase1-Test!` | trial (expired -3d) |
| `blacklist@emailwarm.dev` | `EmailWarm-Phase1-Test!` | growth |
| `spam@emailwarm.dev` | `EmailWarm-Phase1-Test!` | growth |

Not seeded yet on your machine? Run section 1. What each account is for: section 2.

---

## 1. Seed the accounts

```bash
# 1. Make sure the stack is up
.bin/dev up

# 2. Seed all test users (uses the default password below)
node scripts/seed-test-users.mjs

# 2b. Or seed a single user
node scripts/seed-test-users.mjs --email admin@emailwarm.dev

# 2c. Or wipe and re-seed (deletes the backend + better-auth rows first)
node scripts/seed-test-users.mjs --reset

# 3. Override the password at run-time (recommended for CI)
TEST_USER_PASSWORD='Whatever-You-Like-But-Min-8-Chars!' node scripts/seed-test-users.mjs
```

The script is **idempotent** — re-running it does not create duplicate accounts.
It talks to the better-auth signup endpoint at
`POST ${FRONTEND_URL}/api/auth/sign-up/email` and then upserts the backend's
`users` table (plan, trial_ends_at) so each account starts with the right plan
from the first request.

---

## 2. The catalog

All accounts share the same password. **Do not paste this password into any
other environment.**

| Field | Value |
|---|---|
| **Default password** | `EmailWarm-Phase1-Test!` |
| **Override at run-time** | `TEST_USER_PASSWORD=… node scripts/seed-test-users.mjs` |
| **Sign-in URL** | `http://localhost:3000/sign-in` |
| **Domain** | `@emailwarm.dev` (never resolves publicly — by design) |

### Accounts

| Email | Role | Plan | Trial | What to test with it |
|---|---|---|---|---|
| `admin@emailwarm.dev` | super_admin | enterprise | none | Admin flows. No plan gates. Use to inspect the system from a top-tier view. |
| `founder@emailwarm.dev` | owner | agency | +14d | Highest realistic paid plan. Use to verify the "in-pool inbox + placement test" happy path. |
| `growth@emailwarm.dev` | user | growth | none | Mid-tier paid. **Score breakdown visible.** 5 placement tests / month. Use to verify AI diagnostics end-to-end. |
| `starter@emailwarm.dev` | user | starter | none | Lowest paid. **No breakdown, no diagnostics AI.** 1 placement / month. Use to verify the locked state + quota gate. |
| `trial@emailwarm.dev` | user | trial | +7d | Active 7-day trial. Use to verify the trial countdown banner + upgrade CTA. |
| `expired@emailwarm.dev` | user | trial | -3d | Trial expired 3 days ago. Use to verify the `TrialService` cron path + the "paused" inbox state. |
| `blacklist@emailwarm.dev` | user | growth | none | Use to seed a RBL-listed inbox; verifies the `BlacklistCheckProcessor` pause + `blacklist_hit` notification + diagnostics auto-trigger. |
| `spam@emailwarm.dev` | user | growth | none | Use to seed a high-spam-rate placement result; verifies the AI diagnostics trigger. |

### Plan-limits reference (for picking the right account)

| Plan | Inbox limit | Placement tests / mo | AI diagnostics | Score breakdown |
|---|---|---|---|---|
| `trial` | 3 | 1 | no | locked |
| `starter` | 3 | 1 | no | locked |
| `growth` | 10 | 5 | yes | yes |
| `agency` | 30 | unlimited | yes | yes |
| `enterprise` | unlimited | unlimited | yes | yes |

---

## 3. Manual recipe: sign in + use the dashboard

```bash
# In a browser:
#   1. open http://localhost:3000/sign-in
#   2. sign in as one of the emails above with the password
#   3. land on /inboxes (or /inboxes/connect for a fresh user)
```

Or via curl (server-rendered session cookie path, for tests):

```bash
# Sign in — captures the better-auth session cookie in /tmp/cookies.txt
curl -sS -c /tmp/cookies.txt -X POST http://localhost:3000/api/auth/sign-in/email \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://localhost:3000' \
  -d '{"email":"growth@emailwarm.dev","password":"EmailWarm-Phase1-Test!"}'

# Use the session cookie to load a server-rendered page
curl -sS -b /tmp/cookies.txt http://localhost:3000/inboxes
```

> The backend (`http://localhost:4611`) is auth'd by **bearer token**, not by
> the cookie. The cookie lives only on the frontend, and there is no
> `/api/inboxes` proxy route on the frontend — the app calls the backend
> directly with a `v1.<uid>.<exp>.<sig>` token. To exercise the backend in a
> test, mint the token the same way the frontend does — see
> `frontend/src/lib/bearer-token.ts`.

---

## 4. Wiping and re-seeding

```bash
# Drops every @emailwarm.dev account from the backend `users` table AND
# from better-auth's `user` / `session` / `account` tables, then re-creates
# the default catalog.
node scripts/seed-test-users.mjs --reset
```

To nuke only the seeded accounts without re-creating them:

```bash
node -e "
  import('pg').then(async ({Client}) => {
    const c = new Client({ connectionString: 'postgresql://emailwarm:localdev@localhost:5432/emailwarm' });
    await c.connect();
    try {
      await c.query(\`DELETE FROM users WHERE email LIKE '%@emailwarm.dev'\`);
      await c.query(\`DELETE FROM \\\"session\\\" WHERE \\\"userId\\\" IN (SELECT id FROM \\\"user\\\" WHERE email LIKE '%@emailwarm.dev')\`);
      await c.query(\`DELETE FROM \\\"account\\\" WHERE \\\"userId\\\" IN (SELECT id FROM \\\"user\\\" WHERE email LIKE '%@emailwarm.dev')\`);
      await c.query(\`DELETE FROM \\\"user\\\" WHERE email LIKE '%@emailwarm.dev'\`);
    } finally { await c.end(); }
  });
"
```

---

## 5. What this guide does NOT do

- **It does not create rows in `inboxes`, `pool_members`, `placement_tests`,
  `diagnostics`, or any other domain table.** Those need real OAuth credentials
  (Gmail / Outlook) or real DNS / blacklist data and must be seeded per-flow.
- **It does not bypass plan gates.** `starter@emailwarm.dev` still can't see
  the score breakdown, and `growth@emailwarm.dev` still can't exceed 10 inboxes.
  That's the point — the plan-limits above are real, not cosmetic.
- **It does not run the warmup engine.** Connecting an inbox and warming it
  for 3 days requires real IMAP/SMTP credentials, not a stub user.

---

## 6. Safety rules

1. **Never run the seed script against a non-local database.** It uses the
   default `postgresql://emailwarm:localdev@…` URL and the `emailwarm.dev`
   domain on purpose.
2. **Never commit a real password.** The default `EmailWarm-Phase1-Test!` is a
   marker. CI should set `TEST_USER_PASSWORD` via a secret.
3. **Never give these accounts Stripe customer IDs or real OAuth tokens.** If
   a real OAuth flow is needed for a test, use a real Gmail / Outlook account
   in a sandbox and link it to `founder@emailwarm.dev` only.
4. **Never put these accounts in a billing export or a marketing list.** The
   `emailwarm.dev` domain is intentionally non-routable so this can't happen
   by accident.
