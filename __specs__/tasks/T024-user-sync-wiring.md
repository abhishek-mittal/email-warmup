# T024 — Wire User Sync on First Sign-In

**Wave:** 8 (hotfix — run immediately, before W7)
**Depends on:** T004 (BetterAuthGuard + UserSyncService — both exist, sync is just unwired)
**Skills to load:** docs/05-agent-skills/02-skill-auth.md, docs/05-agent-skills/01-skill-database.md

---

## Current state (before this change)

`UserSyncService.upsertUser()` is fully implemented and the `users` table exists.
However, nothing ever calls `upsertUser()`.

The `BetterAuthGuard` verifies the token HMAC and attaches `request.userId` — but it
does NOT look up or create a user row. So when `InboxService.findByUser(userId)` (or any
other service) does a `WHERE user_id = ?` join against the `users` table, it finds nothing
and throws a 403 `User not found`.

**Observed symptom:** `POST /inboxes/connect/smtp` with a valid bearer token returns:
```json
{ "message": "User not found", "error": "Forbidden", "statusCode": 403 }
```

The T004 spec itself notes this gap explicitly:
> "This service is currently unwired. A follow-up adds a `databaseHooks.user.create.after`
> in `frontend/src/lib/auth-server.ts` that calls `userSyncService.upsertUser()` so the
> backend's plan/trial fields stay in sync."

---

## After state (what changes)

| Location | Before | After |
|---|---|---|
| `frontend/src/lib/auth-server.ts` | No `databaseHooks` wired | `databaseHooks.user.create.after` calls backend `POST /internal/user-sync` |
| `backend/src/auth/` (new controller) | No internal sync endpoint | `POST /internal/user-sync` — @Public(), creates user row via UserSyncService |
| `BetterAuthGuard` | Attaches userId only | Unchanged — guard stays pure (no DB) |

### Option A — better-auth database hook (preferred)

Wire the `databaseHooks.user.create.after` callback inside `betterAuth({...})` in
`frontend/src/lib/auth-server.ts`. When better-auth writes a new user to its own table,
the hook fires and calls `UserSyncService.upsertUser()`.

Because the hook runs server-side in the Next.js process, it can import and call
`UserSyncService` directly (via a shared Drizzle connection) or call the backend
over HTTP at `NEXT_PUBLIC_API_URL/internal/user-sync`.

**HTTP approach (simpler, no shared Drizzle pool):**
```
hook fires → POST http://localhost:3001/internal/user-sync
  body: { id, email }
  header: X-Internal-Secret: <INTERNAL_SECRET env var>
```

Backend `InternalController` (`@Public()`) verifies `X-Internal-Secret`, then calls
`UserSyncService.upsertUser({ id, email, plan: 'trial' })`.

### Option B — upsert inside BetterAuthGuard (fallback / simpler)

If wiring the hook proves difficult: inject `UserSyncService` into `BetterAuthGuard`
and call `upsertUser()` on every verified request. This is a lazy-upsert pattern —
the first request from any user creates the row, subsequent requests hit the UPDATE
branch which is a no-op if nothing changed.

**Trade-off:** adds one DB call to every request. Acceptable for an early-stage app.
Pick this if Option A runs into circular dependency or edge runtime issues.

---

## Target components / entry points

1. `frontend/src/lib/auth-server.ts` — the `betterAuth({...})` config object; add `databaseHooks`
2. `backend/src/auth/better-auth.guard.ts` — inject `UserSyncService` here if going Option B
3. `backend/src/auth/auth.module.ts` — update providers if Option B
4. New file (Option A only): `backend/src/auth/internal.controller.ts` — `POST /internal/user-sync`

---

## Before / after flow

**Before:**
1. User signs in via better-auth on the frontend → session cookie set
2. Frontend mints bearer token → attaches to API request
3. Guard verifies token → `request.userId` set
4. `InboxService.findByUser(userId)` → `SELECT * FROM users WHERE id = ?` → **0 rows → 403**

**After (Option A):**
1. User signs in → better-auth writes user row to its own table → `databaseHooks.user.create.after` fires
2. Hook calls `POST /internal/user-sync` → `UserSyncService.upsertUser()` → row exists in `users`
3. Frontend mints bearer token → API request → guard verifies → `InboxService.findByUser` → **row found → 200**

**After (Option B):**
1. User signs in → frontend mints token → API request → guard verifies
2. Guard calls `UserSyncService.upsertUser(userId, email)` — creates row on first call, no-op on subsequent
3. `InboxService.findByUser` → **row found → 200**

---

## Acceptance criteria

- [ ] A new user who signs in for the first time and immediately calls `POST /inboxes/connect/smtp` receives 200 (not 403)
- [ ] A `users` row exists after first authenticated request — `id` matches the token uid, `plan = 'trial'`, `trial_ends_at` is 7 days from now
- [ ] Subsequent requests from the same user do not create duplicate rows (upsert is idempotent)
- [ ] `GET /health` still returns 200 with no Authorization header (public route unaffected)
- [ ] All existing `BetterAuthGuard` unit tests still pass
- [ ] If Option A: `POST /internal/user-sync` with a missing or wrong `X-Internal-Secret` returns 401

## Mark done in SPEC-STATUS.md when all criteria above are verified
