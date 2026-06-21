# T004 — Better-Auth Guard + User Sync

**Wave:** 1
**Depends on:** T001, T002
**Skills to load:** docs/05-agent-skills/02-skill-auth.md, docs/05-agent-skills/01-skill-database.md

> **Migration note (2026-06-21):** This task was originally scoped for Clerk and the
> filename kept the legacy `clerk-auth` slug to preserve the git history. The current
> implementation uses [better-auth](https://better-auth.com) (MIT, self-hosted) and
> an HMAC-signed bearer token format. All "Clerk" mentions below have been replaced
> with the better-auth equivalents.

---

## What to build

Implement authentication so all API routes require a valid bearer token issued by
the better-auth instance running in the Next.js frontend, and new users are
automatically synced into the local `users` table.

### Token format

The frontend (`frontend/src/lib/bearer-token.ts`) mints short-lived tokens and the
backend (`backend/src/auth/better-auth.guard.ts`) verifies them:

```
v1.<base64url(userId)>.<base64url(expMs)>.<base64url(hmac)>
```

where `hmac` is HMAC-SHA-256 over the first three parts using `BETTER_AUTH_SECRET`,
constant-time-compared on the backend. No third-party API call, no DB lookup.

### AuthModule (`backend/src/auth/`)

**BetterAuthGuard** (`better-auth.guard.ts`)
- Implements `CanActivate`
- Extracts Bearer token from `Authorization` header
- Verifies the `v1.<uid>.<exp>.<sig>` format (HMAC + expiry check)
- Attaches the verified `userId` to `request.userId`
- Throws `UnauthorizedException` on missing, malformed, expired, or invalid tokens
- Fails closed if `BETTER_AUTH_SECRET` is unset

**Apply guard globally** in `main.ts` via `app.useGlobalGuards(new BetterAuthGuard(app.get(Reflector)))`

**Public decorator** (`@Public()`) — skip auth for:
- `GET /health`
- `POST /webhooks/stripe`
- (No more `POST /webhooks/clerk` — better-auth manages user lifecycle directly in Postgres, no webhook needed)

**UserSyncService** (`user-sync.service.ts`)
- `upsertUser({ id, email, plan, trialEndsAt })`
- `updateEmail(id, email)`
- `softDeleteUser(id)` — sets `plan = 'deleted'`
- Trial period: 7 days from first sign-in

> This service is currently unwired. A follow-up adds a `databaseHooks.user.create.after`
> in `frontend/src/lib/auth-server.ts` that calls `userSyncService.upsertUser()` so the
> backend's plan/trial fields stay in sync with the better-auth `user` table.

**Plan gating helpers** (in `billing.service.ts`)
- `assertPlan(userId, allowedPlans[])` — throws `ForbiddenException` if user's plan not in list
- `assertInboxLimit(userId)` — throws `ForbiddenException` if at or over plan limit

### Frontend (`frontend/src/lib/auth-server.ts`)

- Single `betterAuth({...})` instance over Postgres with email+password + Google/Microsoft social providers
- Catch-all route handler at `app/api/auth/[...all]/route.ts` using `toNextJsHandler`
- `useApi()` / `serverApi()` mint a Bearer token from the active better-auth session and attach it as `Authorization: Bearer <token>` on every backend request
- `middleware.ts` uses `getSessionCookie()` from `better-auth/cookies` to gate protected routes (Edge-safe)

### Env vars (shared between frontend and backend)

```
BETTER_AUTH_SECRET=...   # 32+ char random string, must match in both processes
DATABASE_URL=...         # backend uses its own Drizzle pool; frontend uses better-auth's pg pool
```

Frontend-only:
```
NEXT_PUBLIC_BETTER_AUTH_SECRET=...   # copy of BETTER_AUTH_SECRET, exposed so the client can mint tokens
BETTER_AUTH_URL=http://localhost:3000
GOOGLE_CLIENT_ID=...                 # for better-auth sign-in (separate from inbox-connect OAuth)
GOOGLE_CLIENT_SECRET=...
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
```

Backend-only:
```
DATABASE_URL=...         # already present
REDIS_URL=...            # already present
ENCRYPTION_KEY=...       # already present
STRIPE_SECRET_KEY=...
STRIPE_WEBHOOK_SECRET=...
```

---

## Acceptance criteria

- [ ] `GET /inboxes` with no Authorization header returns 401
- [ ] `GET /inboxes` with invalid/malformed Bearer token returns 401
- [ ] `GET /inboxes` with a valid `v1.<uid>.<exp>.<sig>` token returns 200 (even if empty array)
- [ ] `GET /inboxes` with a valid token whose `exp` is in the past returns 401
- [ ] `GET /health` returns 200 without any Authorization header
- [ ] New user row has `plan = 'trial'` and `trial_ends_at = 7 days from now`
- [ ] `assertInboxLimit` throws 403 when user has reached `PLAN_LIMITS[plan].inboxes` count
- [ ] Frontend `GET /api/auth/get-session` returns 200 with body `null` when not signed in
- [ ] Frontend `GET /sign-in` returns 200 (renders the better-auth sign-in form)
- [ ] No `clerk`, `Clerk`, `@clerk/*`, `svix`, `CLERK_*` env vars anywhere in `src/`

## Mark done in SPEC-STATUS.md when all criteria above are verified
