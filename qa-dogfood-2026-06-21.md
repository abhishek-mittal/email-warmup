# EmailWarm — Phase 1 Dogfood Report

**Target:** `http://localhost:3000` (Next.js 16 + better-auth + NestJS)
**Session:** `emailwarm`
**Date:** 2026-06-21
**Tester:** agent-browser (Chrome 150)

## Summary

| Severity | Count |
|----------|-------|
| critical | 3     |
| high     | 0     |
| medium   | 0     |
| low      | 0     |
| **Total** | 3     |

All three issues are **fixed and verified in the running app**.

---

### ISSUE-001: Dashboard renders nested DashboardShell — sidebar+topbar appear twice

| Field | Value |
|---|---|
| **Severity** | critical |
| **Category** | visual / functional |
| **Repro Video** | N/A (static) |
| **Screenshot** | `screenshots/02-dashboard-double-shell.png` |

**Description**

After signing in as `admin@emailwarm.dev`, the dashboard at `/` renders
the entire `DashboardShell` (sidebar + topbar + main content area) **twice**.
"Signed in as admin@emailwarm.dev" appears twice in two separate topbars,
the sidebar nav is duplicated inside the main content area, and the page
is squeezed into a tiny rectangle on the right.

**Repro steps**

1. Open `http://localhost:3000` (redirects to `/sign-in`).
2. Fill `you@company.com` with `admin@emailwarm.dev`.
3. Fill `Password` with `EmailWarm-Phase1-Test!`.
4. Click **Sign in**.
5. Land on `/` (the dashboard).

**Expected**

A single sidebar (left), a single topbar (top), and the dashboard
content (right of sidebar, below topbar).

**Actual**

Two sidebars (left column of full viewport, plus a smaller sidebar
*inside* the first sidebar's main content area). Two topbars showing
"Signed in as admin@emailwarm.dev" stacked vertically. The actual
dashboard content ("Dashboard / 0 inboxes connected", "No inboxes yet")
sits in a narrow column on the far right.

**Root cause**

Every page under `frontend/src/app/(dashboard)/` wraps its return
value in `<DashboardShell>...</DashboardShell>`, but the route group's
own `layout.tsx` already does this. The page's wrapper is therefore
rendered *inside* the layout's wrapper, producing the duplicate shell.

**Fix applied**

Removed the `import { DashboardShell }` line and the wrapping
`<DashboardShell>...</DashboardShell>` JSX from the 5 pages under
`(dashboard)/` (`page.tsx`, `inboxes/page.tsx`, `inboxes/[id]/page.tsx`,
`inboxes/[id]/diagnostics/page.tsx`, `billing/page.tsx`). The
`(dashboard)/layout.tsx` continues to own the shell.

**Verified**

`screenshots/03-dashboard-after-fix.png` — single sidebar, single
topbar, single main content area. `pnpm run build` clean.

---

### ISSUE-002: All authenticated backend calls 401/500 — invalid HMAC signature

| Field | Value |
|---|---|
| **Severity** | critical |
| **Category** | functional / auth |
| **Repro Video** | N/A (reproducible by inspecting the generated token) |
| **Screenshot** | N/A — failure is a server-side 500 surfaced in the browser dev overlay (`screenshots/07-after-signout.png` shows the dev-tools error panel) |

**Description**

Every request from the authenticated frontend to the backend that uses
`mintBearerToken` (e.g. `GET /billing/status`, `GET /inboxes`, the
`serverApi` helper used by every server component) returned either:

  * `401 {"message":"Invalid or expired token"}` (when the broken token
    was sent), or
  * `500` with `DrizzleQueryError: Failed query: ...` (see ISSUE-003).

`/billing/status` from the Next.js server component (`api-server.ts`)
hit this 100% of the time. The dashboard's inbox list silently swallowed
it and showed an empty state instead of an error.

**Root cause**

`frontend/src/lib/bearer-token.ts` had a sign/encoding bug:

```ts
// WRONG
const buf = await crypto.subtle.sign('HMAC', key, enc.encode(message));
return new TextDecoder().decode(buf); // raw bytes decoded as UTF-8
// ...
return `${payload}.${b64u(sig)}`; // then base64-encoded the text
```

`TextDecoder().decode(buf)` decodes the 32 raw HMAC bytes as a UTF-8
string. Most bytes are not valid UTF-8, so the decoder inserts U+FFFD
replacement characters. `b64u(sig)` then base64-encodes *that* string.

The backend's `BetterAuthGuard` correctly does `createHmac(...).digest()`
to get the raw bytes and `Buffer.from(sigPart, 'base64url')` to decode
the supplied signature back to raw bytes, then `timingSafeEqual(provided,
expected)`. The two never match because the frontend was base64-encoding
UTF-8 garbage, not the raw HMAC bytes.

**Fix applied**

`hmac()` now returns the raw HMAC bytes directly as base64url (via a
new `bytesToBase64Url` helper), and `mintBearerToken()` no longer
double-encodes the signature.

```ts
// CORRECT
const buf = await crypto.subtle.sign('HMAC', key, enc.encode(message));
return bytesToBase64Url(new Uint8Array(buf));
// ...
return `${payload}.${sig}`; // sig is already base64url
```

**Verified**

After the fix, `mintBearerToken(...)` returns a token whose signature
is a clean base64url string (e.g. `PPFGUjgJi3GRq-b9bQfyrFlbyNekRYZM69Jr9EEtTHk`)
instead of the previous `77-9MO-_ve-_vQ…` corruption. `GET /billing/status`
with that token returns the billing data and `GET /inboxes` returns `[]`.

---

### ISSUE-003: Backend loads with no DB credentials — every request 500s with cryptic Drizzle wrapper error

| Field | Value |
|---|---|
| **Severity** | critical |
| **Category** | functional / dev-experience |
| **Repro Video** | N/A (reproducible from a fresh checkout) |
| **Screenshot** | N/A — same as ISSUE-002, error only visible after the new exception filter |

**Description**

Even after fixing the HMAC signature, every backend query still 500'd.
The Nest default exception handler logged only `DrizzleQueryError: Failed
query: ...` with no underlying cause. Tracing the cause chain revealed:

```
Error: SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string
```

i.e. the `pg.Pool` was created with `connectionString: undefined` because
`process.env.DATABASE_URL` was never populated. The `.env` file in
`backend/.env` exists and is correct, but `ConfigModule.forRoot({ isGlobal:
true, validate })` does **not** load `.env` by default — it only reads
`process.env`.

This was completely invisible from the log output until I added
`UnwrapCauseExceptionFilter` (see Fix B below). Without that filter, this
bug would look like a mystery Postgres failure.

**Root cause**

Two problems stacked on top of each other:

1. `ConfigModule.forRoot()` never loaded `backend/.env`, so
   `process.env.DATABASE_URL` was `undefined` at import time.
2. `backend/src/db/index.ts` constructs the `pg.Pool` at module
   top-level, so the env had to be populated *before* the module
   graph resolved — `envFilePath: '.env'` on `ConfigModule` was too late
   (it's processed during the module init phase, not before imports).

**Fix applied**

* **Fix A (the actual bug):** load `.env` at the very top of
  `backend/src/main.ts` before any other import. `import { config as
  loadDotenv } from 'dotenv'; loadDotenv({ path: ['.env', '../.env'] });`
  runs before `import { AppModule } from './app.module'` (which transitively
  imports `db/index.ts` and creates the Pool). Added `dotenv` to
  `backend/package.json` dependencies.

* **Fix B (so the next person can debug this in 30 seconds):** added
  `backend/src/common/unwrap-cause.filter.ts` — a global Nest
  `ExceptionFilter` that unwraps `error.cause` recursively and logs the
  full chain (`name`, `code`, `message` per level) instead of just the
  outermost Drizzle wrapper. Wired into `main.ts` via
  `app.useGlobalFilters(new UnwrapCauseExceptionFilter())`.

**Verified**

After the fix, `GET /billing/status` returns the real billing data
(`{"plan":"trial",...}`) and `GET /inboxes` returns `[]`. The
exception filter is now active in `main.ts` and will surface real
causes for any future DB / external-API errors.
