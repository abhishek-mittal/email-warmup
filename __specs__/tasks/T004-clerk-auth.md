# T004 — Clerk Auth Guard + User Sync

**Wave:** 1  
**Depends on:** T001, T002  
**Skills to load:** docs/05-agent-skills/02-skill-auth.md, docs/05-agent-skills/01-skill-database.md

---

## What to build

Implement authentication so all API routes require a valid Clerk JWT, and new users are automatically synced into the local `users` table.

### AuthModule (`backend/src/auth/`)

**ClerkGuard** (`clerk.guard.ts`)
- Implements `CanActivate`
- Extracts Bearer token from `Authorization` header
- Validates via `@clerk/backend` `verifyToken()` with `CLERK_SECRET_KEY`
- Attaches `payload.sub` (Clerk user ID) to `request.userId`
- Throws `UnauthorizedException` on missing or invalid token

**Apply guard globally** in `main.ts` via `app.useGlobalGuards(new ClerkGuard())`

**Public decorator** (`@Public()`) — skip auth for:
- `GET /health`
- `POST /webhooks/clerk`
- `POST /webhooks/stripe`

**ClerkWebhookController** (`clerk-webhook.controller.ts`)
- `POST /webhooks/clerk` — raw body required
- Verify SVIX signature using `svix` package and `CLERK_WEBHOOK_SECRET`
- Handle events: `user.created` → upsert user, `user.updated` → update email, `user.deleted` → soft delete

**UserSyncService** (`user-sync.service.ts`)
- `upsertUser({ id, email, plan, trialEndsAt })` — called on `user.created`
- Trial period: 7 days from Clerk account creation

**Plan gating helpers** (in `billing.service.ts` or shared utility)
- `assertPlan(userId, allowedPlans[])` — throws `ForbiddenException` if user's plan not in list
- `assertInboxLimit(userId)` — throws `ForbiddenException` if at or over plan limit

---

## Acceptance criteria

- [ ] `GET /inboxes` with no Authorization header returns 401
- [ ] `GET /inboxes` with invalid JWT returns 401
- [ ] `GET /inboxes` with valid Clerk JWT returns 200 (even if empty array)
- [ ] `GET /health` returns 200 without any Authorization header
- [ ] `POST /webhooks/clerk` with valid SVIX signature creates user in `users` table
- [ ] `POST /webhooks/clerk` with invalid signature returns 400
- [ ] New user row has `plan = 'trial'` and `trial_ends_at = 7 days from now`
- [ ] `assertInboxLimit` throws 403 when user has reached PLAN_LIMITS[plan].inboxes count

## Mark done in SPEC-STATUS.md when all criteria above are verified
