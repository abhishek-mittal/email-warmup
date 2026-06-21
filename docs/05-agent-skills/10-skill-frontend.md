# Skill: Frontend (Next.js 15 App Router)

**Domain:** Next.js 15 App Router, dashboard components, data fetching, Clerk frontend  
**Load when:** Working on the frontend app, dashboard pages, inbox management UI, score charts

---

## App structure

```
app/                               ← Next.js App Router root
├── (auth)/
│   ├── sign-in/page.tsx           ← Clerk SignIn component
│   └── sign-up/page.tsx           ← Clerk SignUp component
├── (dashboard)/
│   ├── layout.tsx                 ← sidebar + header shell (ClerkProvider wraps all)
│   ├── page.tsx                   ← overview: score summary cards, inbox list
│   ├── inboxes/
│   │   ├── page.tsx               ← inbox list + connect button
│   │   ├── [id]/page.tsx          ← single inbox detail: score chart, placement, DNS status
│   │   └── connect/page.tsx       ← OAuth connect flow (Gmail / Outlook / Custom SMTP)
│   ├── diagnostics/[id]/page.tsx  ← AI diagnostic report for one inbox
│   ├── placement/[id]/page.tsx    ← placement test results detail
│   └── billing/page.tsx           ← plan status, upgrade, portal link
├── api/                           ← Next.js API routes (thin proxy to NestJS backend)
│   └── auth/callback/route.ts     ← OAuth callback handler
└── layout.tsx                     ← root layout with ClerkProvider
```

---

## Auth setup (Clerk)

```typescript
// app/layout.tsx
import { ClerkProvider } from '@clerk/nextjs';

export default function RootLayout({ children }) {
  return (
    <ClerkProvider>
      <html lang="en"><body>{children}</body></html>
    </ClerkProvider>
  );
}
```

```typescript
// middleware.ts (Next.js middleware — protects all dashboard routes)
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isPublic = createRouteMatcher(['/sign-in(.*)', '/sign-up(.*)', '/api/webhooks(.*)']);

export default clerkMiddleware((auth, req) => {
  if (!isPublic(req)) auth().protect();
});

export const config = { matcher: ['/((?!_next|.*\\..*).*)'] };
```

### Getting the token for API calls
```typescript
// In Server Components:
import { auth } from '@clerk/nextjs/server';
const { getToken } = auth();
const token = await getToken();

// In Client Components:
import { useAuth } from '@clerk/nextjs';
const { getToken } = useAuth();
const token = await getToken();
```

---

## Data fetching patterns

### Server Component (preferred for initial data)
```typescript
// app/(dashboard)/inboxes/page.tsx
import { auth } from '@clerk/nextjs/server';

export default async function InboxesPage() {
  const { getToken } = auth();
  const token = await getToken();

  const inboxes = await fetch(`${process.env.API_URL}/inboxes`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',  // always fresh for dashboard data
  }).then(r => r.json());

  return <InboxList inboxes={inboxes} />;
}
```

### Client Component for interactive state
```typescript
'use client';
import { useAuth } from '@clerk/nextjs';
import useSWR from 'swr';

export function InboxScoreChart({ inboxId }: { inboxId: string }) {
  const { getToken } = useAuth();

  const { data } = useSWR(
    `/api/inboxes/${inboxId}/score?days=30`,
    async (url) => {
      const token = await getToken();
      return fetch(`${process.env.NEXT_PUBLIC_API_URL}${url}`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then(r => r.json());
    }
  );

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
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_...
CLERK_SECRET_KEY=sk_live_...
NEXT_PUBLIC_API_URL=https://api.emailwarm.io   ← NestJS backend
API_URL=https://api.emailwarm.io               ← for server components
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
- **Never expose Clerk's secret key to the browser** — `CLERK_SECRET_KEY` stays server-side only
- **Never store the auth token in localStorage** — Clerk's session cookies handle this; never manually persist tokens
- **Never show the score breakdown (DNS / blacklist / placement split) to Trial or Starter users** — show only the total score with an upgrade prompt
- **Never make direct DB calls from a Next.js API route** — proxy to NestJS backend only; the frontend app has no direct DB access
