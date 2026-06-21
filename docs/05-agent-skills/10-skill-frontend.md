# Skill: Frontend (Next.js 16 App Router)

**Domain:** Next.js 16 App Router, dashboard components, data fetching, better-auth frontend  
**Load when:** Working on the frontend app, dashboard pages, inbox management UI, score charts

> **Migration note (2026-06-21):** Replaces the original Clerk skill. The Clerk
> pieces (`ClerkProvider`, `clerkMiddleware`, `<SignIn>`, `<SignUp>`, `<UserButton>`)
> are gone. Auth is now self-hosted via [better-auth](https://better-auth.com)
> running in the same Next.js process; the backend verifies HMAC-signed bearer
> tokens it never has to talk to the issuer for. See
> `docs/05-agent-skills/02-skill-auth.md` for the full contract.

---

## App structure

```
app/                               ← Next.js App Router root
├── (auth)/
│   ├── sign-in/[[...sign-in]]/page.tsx  ← email+password + Google/Microsoft OAuth buttons
│   └── sign-up/[[...sign-up]]/page.tsx  ← email+password sign-up
├── (dashboard)/
│   ├── layout.tsx                 ← sidebar + header shell
│   ├── page.tsx                   ← overview: score summary cards, inbox list
│   ├── inboxes/
│   │   ├── page.tsx               ← inbox list + connect button
│   │   ├── [id]/page.tsx          ← single inbox detail: score chart, placement, DNS status
│   │   └── connect/page.tsx       ← OAuth connect flow (Gmail / Outlook / Custom SMTP)
│   ├── diagnostics/[id]/page.tsx  ← AI diagnostic report for one inbox
│   ├── placement/[id]/page.tsx    ← placement test results detail
│   └── billing/page.tsx           ← plan status, upgrade, portal link
├── api/
│   └── auth/[...all]/route.ts     ← toNextJsHandler(getAuth()) catch-all for better-auth
└── layout.tsx                     ← root layout (no ClerkProvider needed)
```

---

## Auth setup (better-auth)

The frontend hosts better-auth in the same Next.js process. The backend never
talks to the issuer; it only HMAC-verifies the bearer token the frontend mints
from each session.

```typescript
// app/layout.tsx
// (no provider needed — better-auth's React client uses nanostores internally)
import './globals.css';

export default function RootLayout({ children }) {
  return (
    <html lang="en"><body>{children}</body></html>
  );
}
```

```typescript
// middleware.ts (Next.js middleware — protects all dashboard routes)
// Edge-safe: only checks the better-auth session cookie, doesn't verify HMAC.
import { NextResponse, type NextRequest } from 'next/server';
import { getSessionCookie } from 'better-auth/cookies';

const isPublic = (path: string) =>
  path === '/' ||
  path.startsWith('/sign-in') ||
  path.startsWith('/sign-up') ||
  path.startsWith('/api/auth') ||
  path.startsWith('/api/webhooks');

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();
  const sessionCookie = getSessionCookie(req);
  if (!sessionCookie) {
    const url = req.nextUrl.clone();
    url.pathname = '/sign-in';
    url.searchParams.set('redirect_url', pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ['/((?!_next|.*\\..*).*)'] };
```

```typescript
// app/api/auth/[...all]/route.ts — better-auth catch-all
import { getAuth } from '@/lib/auth-server';
import { toNextJsHandler } from 'better-auth/next-js';

export const { GET, POST } = toNextJsHandler(
  getAuth() as unknown as { handler: (r: Request) => Promise<Response> }
);
```

### Getting a Bearer token for API calls

The frontend mints a short-lived `v1.<uid>.<exp>.<sig>` token from the
better-auth session and attaches it as `Authorization: Bearer` on every backend
request. Never persist the token — it's already 1 h TTL.

```typescript
// lib/api.ts — Client Component (useApi hook)
'use client';
import { createAuthClient } from 'better-auth/react';
import { mintBearerToken } from './bearer-token';

const authClient = createAuthClient({ baseURL: ... });

export function useApi() {
  return async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const session = await authClient.getSession();
    const userId = session?.data?.user?.id;
    const secret = process.env.NEXT_PUBLIC_BETTER_AUTH_SECRET;
    const token = userId && secret ? await mintBearerToken(userId, secret) : null;
    // fetch with `Authorization: Bearer ${token}` ...
  };
}
```

```typescript
// lib/api-server.ts — RSC side
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
  // fetch ...
}
```

---

## Data fetching patterns

### Server Component (preferred for initial data)
```typescript
// app/(dashboard)/inboxes/page.tsx
import { currentUserId } from '@/lib/api-server';

export default async function InboxesPage() {
  const userId = await currentUserId();
  if (!userId) redirect('/sign-in');

  const inboxes = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/inboxes`, {
    headers: { Authorization: `Bearer ${await mintToken(userId)}` },
    cache: 'no-store',  // always fresh for dashboard data
  }).then(r => r.json());

  return <InboxList inboxes={inboxes} />;
}
```

### Client Component for interactive state
```typescript
'use client';
import { useApi } from '@/lib/api';

export function InboxScoreChart({ inboxId }: { inboxId: string }) {
  const api = useApi();
  const { data } = useSWR(`/api/inboxes/${inboxId}/score?days=30`, (url) => api(url));
  // Render recharts LineChart from data.history
}
```

---

## Key UI components

### Reputation score gauge
```
Score: 76 / 100      ← circular gauge, colour-coded
DNS:   ▓▓▓▓▓▓▓▓░░   24/30
BL:    ▓▓▓▓▓▓▓▓▓▓   30/30
Place: ▓▓▓▓▓▓▓░░░   22/40
Trend: ↑ up (was 71 yesterday)
```

- Gauge uses `recharts` RadialBarChart or simple SVG arc
- Breakdown only visible for Growth+ plans — show locked icon otherwise

### Inbox status badge
```typescript
const STATUS_CONFIG = {
  pending:   { label: 'Pending Setup', color: 'gray' },
  active:    { label: 'Warming Up', color: 'blue' },
  paused:    { label: 'Paused', color: 'yellow' },
  graduated: { label: 'Graduated', color: 'green' },
  error:     { label: 'Needs Attention', color: 'red' },
};
```

### Placement result bar
```
Primary:    ████████████░░░░ 73%
Promotions: ████░░░░░░░░░░░░ 18%
Spam:       ██░░░░░░░░░░░░░░  9%
```
- Primary = green, Promotions = amber, Spam = red
- Never collapse Promotions into Spam — they are separate outcomes

---

## Environment variables

```
# Self-hosted better-auth (must match backend BETTER_AUTH_SECRET)
DATABASE_URL=postgresql://...
BETTER_AUTH_SECRET=replace-with-32+-char-random-string
NEXT_PUBLIC_BETTER_AUTH_SECRET=replace-with-32+-char-random-string
BETTER_AUTH_URL=http://localhost:3000
# better-auth sign-in OAuth providers (separate from inbox-connect OAuth)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
# Backend
NEXT_PUBLIC_API_URL=http://localhost:3001
```

---

## Component conventions

- All data-fetching pages are Server Components by default; add `'use client'` only when hooks or event handlers are needed
- Loading states: use `<Suspense>` with a skeleton component — do not block the entire page
- Error boundaries: wrap each major section (score, placement, DNS) independently
- Tables use `@tanstack/react-table` — configure columns in a separate `columns.ts` file per table
- Charts use `recharts` — never import all of recharts; import only the components needed

---

## What you never do

- **Never fetch data from the NestJS API in a Client Component on initial render** — do the initial fetch in a Server Component and pass as props; use SWR only for real-time updates
- **Never expose `BETTER_AUTH_SECRET` or `GOOGLE_CLIENT_SECRET` to the browser** — only `NEXT_PUBLIC_*` vars are safe in client bundles
- **Never store the bearer token in localStorage** — better-auth's session cookies handle this; the bearer token is short-lived (1 h) and minted per request
- **Never show the score breakdown (DNS / blacklist / placement split) to Trial or Starter users** — show only the total score with an upgrade prompt
- **Never make direct DB calls from a Next.js API route** — proxy to NestJS backend only; the frontend app has no direct DB access
