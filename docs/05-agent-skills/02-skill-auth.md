# Skill: Auth (better-auth + HMAC bearer)

**Domain:** self-hosted auth, bearer-token verification, NestJS auth guard, plan gating
**Load when:** Working on AuthModule, BetterAuthGuard, user sync, plan gating, frontend auth wiring

> **Migration note (2026-06-21):** Replaces the original Clerk skill. The Clerk
> pieces (`@clerk/backend`, SVIX webhook verifier, ClerkGuard with `verifyToken`)
> are gone. Auth is now self-hosted via [better-auth](https://better-auth.com)
> running in the Next.js frontend; the NestJS backend only verifies HMAC-signed
> tokens it never has to talk to the issuer for.

---

## Token format

The frontend (`frontend/src/lib/bearer-token.ts`) mints short-lived tokens and
the backend (`backend/src/auth/better-auth.guard.ts`) verifies them:

```
v1.<base64url(userId)>.<base64url(expMs)>.<base64url(hmac)>
```

- `hmac` is HMAC-SHA-256 over the first three parts (joined with `.`) using `BETTER_AUTH_SECRET`
- Verification on the backend: constant-time HMAC compare + expiry check
- No DB lookup, no third-party API call, no Clerk

---

## Module structure

### Backend (`backend/src/auth/`)

```
src/auth/
├── auth.module.ts                    ← provides + exports BetterAuthGuard, UserSyncService
├── better-auth.guard.ts              ← NestJS guard: HMAC-verifies the Bearer token
├── better-auth.guard.spec.ts         ← unit tests
├── public.decorator.ts               ← @Public() to skip auth
└── user-sync.service.ts              ← syncs better-auth user data into local users table
```

### Frontend (`frontend/src/`)

```
src/
├── lib/
│   ├── auth-server.ts                ← betterAuth({...}) lazy singleton over Postgres
│   ├── auth.ts                       ← React client (useSession, signIn, signOut, signUp)
│   ├── bearer-token.ts               ← mints v1.<uid>.<exp>.<sig> from a session
│   ├── api.ts                        ← useApi() hook (client) — attaches Bearer
│   └── api-server.ts                 ← serverApi() (RSC) — attaches Bearer
├── middleware.ts                     ← getSessionCookie() from better-auth/cookies
└── app/
    ├── api/auth/[...all]/route.ts   ← toNextJsHandler(getAuth()) catch-all
    ├── sign-in/[[...sign-in]]/page.tsx
    └── sign-up/[[...sign-up]]/page.tsx
```

---

## Backend: HMAC bearer-token guard

```typescript
// better-auth.guard.ts
import { createHmac, timingSafeEqual } from 'crypto';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './public.decorator';

const TOKEN_VERSION = 'v1';

@Injectable()
export class BetterAuthGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const token = this.extractBearerToken(request);
    if (!token) throw new UnauthorizedException('Missing auth token');

    const userId = this.verifyToken(token);
    if (!userId) throw new UnauthorizedException('Invalid or expired token');

    request.userId = userId;
    return true;
  }

  private extractBearerToken(req: any): string | null {
    const auth = req.headers?.authorization;
    return auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  }

  private verifyToken(token: string): string | null {
    const secret = process.env.BETTER_AUTH_SECRET;
    if (!secret) return null; // fail closed

    const parts = token.split('.');
    if (parts.length !== 4 || parts[0] !== TOKEN_VERSION) return null;

    const [version, userPart, expPart, sigPart] = parts;
    const payload = `${version}.${userPart}.${expPart}`;
    const expected = createHmac('sha256', secret).update(payload).digest();

    let provided: Buffer;
    try { provided = Buffer.from(sigPart, 'base64url'); } catch { return null; }
    if (provided.length !== expected.length) return null;
    if (!timingSafeEqual(provided, expected)) return null;

    let exp: number;
    try { exp = Number(Buffer.from(expPart, 'base64url').toString('utf8')); }
    catch { return null; }
    if (!Number.isFinite(exp) || exp < Date.now()) return null;

    try { return Buffer.from(userPart, 'base64url').toString('utf8'); }
    catch { return null; }
  }
}
```

```typescript
// main.ts — register globally
app.useGlobalGuards(new BetterAuthGuard(app.get(Reflector)));
```

```typescript
// controller
@Controller('inboxes')
@UseGuards(BetterAuthGuard)
export class InboxController { /* ... */ }
```

**No Clerk webhook** — better-auth manages user lifecycle directly. If you need
to react to user.created, wire a `databaseHooks.user.create.after` in
`frontend/src/lib/auth-server.ts` to call the backend's `userSyncService.upsertUser()`
via an internal API call.

---

## Frontend: better-auth server config

```typescript
// frontend/src/lib/auth-server.ts
import { betterAuth } from 'better-auth';
import { Pool as PgPool } from 'pg';

let _pool: PgPool | undefined;
let _auth: any;

function getPool(): PgPool {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required for better-auth');
  _pool = new PgPool({ connectionString: url });
  return _pool;
}

function makeAuth() {
  return betterAuth({
    database: getPool(),
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',
    emailAndPassword: { enabled: true },
    socialProviders: {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID ?? '',
        clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      },
      microsoft: {
        clientId: process.env.MICROSOFT_CLIENT_ID ?? '',
        clientSecret: process.env.MICROSOFT_CLIENT_SECRET ?? '',
      },
    },
    session: {
      cookieCache: { enabled: true, maxAge: 60 * 5 },
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
  });
}

export function getAuth(): ReturnType<typeof betterAuth> {
  if (!_auth) _auth = makeAuth();
  return _auth;
}
```

The lazy singleton exists so that build-time page-data collection (which has no
env vars) doesn't fail to import this module — the pg pool only opens on first
use.

```typescript
// frontend/src/app/api/auth/[...all]/route.ts
import { getAuth } from '@/lib/auth-server';
import { toNextJsHandler } from 'better-auth/next-js';
export const { GET, POST } = toNextJsHandler(
  getAuth() as unknown as { handler: (r: Request) => Promise<Response> }
);
```

```typescript
// frontend/src/middleware.ts — Edge-safe session check
import { getSessionCookie } from 'better-auth/cookies';

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isPublic =
    pathname === '/' ||
    pathname.startsWith('/sign-in') ||
    pathname.startsWith('/sign-up') ||
    pathname.startsWith('/api/auth') ||
    pathname.startsWith('/api/webhooks');
  if (isPublic) return NextResponse.next();

  const sessionCookie = getSessionCookie(req);
  if (!sessionCookie) {
    const url = req.nextUrl.clone();
    url.pathname = '/sign-in';
    url.searchParams.set('redirect_url', pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}
```

```typescript
// frontend/src/lib/bearer-token.ts — mints the token the backend verifies
export async function mintBearerToken(
  userId: string,
  secret: string,
  ttlMs: number = 60 * 60 * 1000, // 1h
): Promise<string> {
  const exp = Date.now() + ttlMs;
  const userPart = b64u(userId);
  const expPart = b64u(String(exp));
  const payload = `v1.${userPart}.${expPart}`;
  const sig = await hmac(payload, secret);
  return `${payload}.${b64u(sig)}`;
}
```

```typescript
// frontend/src/lib/api.ts — client side
'use client';
import { createAuthClient } from 'better-auth/react';
import { mintBearerToken } from './bearer-token';

const authClient = createAuthClient({ baseURL: ... });

export function useApi() {
  return async function api<T>(path: string, init?: RequestInit): Promise<T> {
    let token: string | null = null;
    try {
      const session = await authClient.getSession();
      const userId = session?.data?.user?.id;
      const secret = process.env.NEXT_PUBLIC_BETTER_AUTH_SECRET;
      if (userId && secret) token = await mintBearerToken(userId, secret);
    } catch { token = null; }
    // ... fetch with `Authorization: Bearer ${token}` ...
  };
}
```

```typescript
// frontend/src/lib/api-server.ts — RSC side
import 'server-only';
import { headers } from 'next/headers';
import { getAuth } from './auth-server';
import { mintBearerToken } from './bearer-token';

export async function serverApi<T>(path: string, init?: RequestInit): Promise<T> {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  const userId = session?.user?.id;
  const headers_ = { /* ... */ };
  if (userId) {
    const secret = process.env.BETTER_AUTH_SECRET;
    if (secret) headers_.Authorization = `Bearer ${await mintBearerToken(userId, secret)}`;
  }
  // ... fetch ...
}
```

---

## Plan gating (unchanged)

```typescript
// billing.service.ts
async assertPlan(userId: string, allowedPlans: string[]) {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = rows[0];
  if (!user || !allowedPlans.includes(user.plan)) {
    throw new ForbiddenException(`This feature requires plan: ${allowedPlans.join(' or ')}`);
  }
}

async assertInboxLimit(userId: string) {
  const [user] = (await db.select().from(users).where(eq(users.id, userId))).slice(0, 1);
  if (!user) throw new ForbiddenException();
  const limit = PLAN_LIMITS[user.plan]?.inboxes ?? 0;
  const [result] = await db.select({ count: count() }).from(inboxes).where(eq(inboxes.userId, userId));
  if (result.count >= limit) {
    throw new ForbiddenException(`Inbox limit reached for ${user.plan} plan (${limit} inboxes)`);
  }
}
```

---

## Env vars

```
# Shared (both processes)
DATABASE_URL=postgresql://...
BETTER_AUTH_SECRET=replace-with-32+-char-random-string   # MUST match in both

# Frontend only
NEXT_PUBLIC_BETTER_AUTH_SECRET=replace-with-32+-char-random-string  # copy of BETTER_AUTH_SECRET
BETTER_AUTH_URL=http://localhost:3000
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...

# Backend only
REDIS_URL=redis://...
ENCRYPTION_KEY=...   # 64 hex chars
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
ANTHROPIC_API_KEY=sk-ant-...
```

---

## Non-negotiables (CLAUDE.md-equivalent)

- **Never store the HMAC secret in code** — always from env var (`BETTER_AUTH_SECRET`).
- **Never** share the HMAC secret between dev and prod.
- **Never** skip signature verification on the backend — even in test mode the
  guard still validates (use a real `BETTER_AUTH_SECRET` in `.env`/CI).
- **Never** persist the Bearer token to localStorage. It's already short-lived
  (1h default) and the better-auth session cookie handles refresh.
- **Always** use `timingSafeEqual` for HMAC comparison, never `===`.
- **Always** fail closed: if `BETTER_AUTH_SECRET` is unset on the backend, every
  protected request returns 401.
- **Always** validate the token version prefix (`v1.`) before parsing, so a future
  v2 can co-exist without breaking v1 verifiers.
