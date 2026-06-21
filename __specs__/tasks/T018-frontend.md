# T018 — Next.js 15 Frontend Dashboard

**Wave:** 6  
**Depends on:** T004 (auth), T005-T007 (inbox connect), T008-T010 (warmup), T011-T013 (monitoring + scoring), T014-T015 (placement + diagnostics), T016-T017 (billing + notifications)  
**Skills to load:** docs/05-agent-skills/10-skill-frontend.md, docs/05-agent-skills/02-skill-auth.md  
**Service spec:** __specs__/domains/frontend.md

---

## What to build

Complete Next.js 15 App Router frontend: all pages, components, and auth flows connected to the live NestJS backend.

### Pages to build

**1. `/` (Dashboard overview)**
- Summary bar: total inboxes, avg score, count with issues
- Inbox table: email, provider icon, status badge, score (coloured), warmup day, trend arrow
- Empty state with "Connect your first inbox" CTA

**2. `/inboxes` (Inbox management)**
- Full inbox table with actions column: pause / resume / run placement test / view
- "Connect inbox" button

**3. `/inboxes/connect` (Connect flow)**
- Tabs: Gmail | Outlook | Custom SMTP
- Gmail/Outlook: OAuth button → redirect to backend auth endpoint
- Custom SMTP: form with all fields + validation
- Pre-check result: 5-step checklist with animated pass/fail states

**4. `/inboxes/[id]` (Inbox detail)**
- Score gauge (circular, colour-coded by range)
- Score history line chart (30 days, `recharts`)
- Warmup progress indicator (day X / total days)
- DNS status cards (SPF / DKIM / DMARC / MX) — 4 cards in a row
- Blacklist status badge
- Latest placement result bar (Primary / Promotions / Spam)
- "Run Placement Test" button (quota-aware + loading state)

**5. `/inboxes/[id]/diagnostics` (AI analysis)**
- Issue list: icon + severity + explanation + ordered fix steps
- Readiness report card (visible after graduation)
- "Request new analysis" button

**6. `/billing` (Plan management)**
- Current plan card with usage bars
- Feature comparison table (4 tiers)
- "Upgrade" → Stripe checkout redirect
- "Manage subscription" → Stripe portal redirect
- Trial countdown banner

### Key components

- `<ReputationGauge>` — circular score display, breakdown for Growth+
- `<PlacementBar>` — three-segment bar: Primary (green) / Promotions (amber) / Spam (red)
- `<InboxStatusBadge>` — colour-coded status label
- `<DnsStatusCard>` — compact pass/fail card per DNS record type
- `<ScoreHistoryChart>` — recharts LineChart with 30-day data
- `<PlanGate>` — wrapper that shows locked state for features above user's plan

### Auth flow

- All `/(dashboard)` routes protected by Clerk middleware
- OAuth callback: `GET /api/auth/callback/google` → hit backend → redirect to `/inboxes`
- First-run redirect: authenticated user with no inboxes → `/inboxes/connect`

---

## Acceptance criteria

- [ ] `/` renders inbox list with correct score badge colours for all score ranges
- [ ] Gmail OAuth connect flow completes and inbox appears in `/inboxes` list
- [ ] Score gauge colour is green for 80+, blue for 60–79, yellow for 40–59, orange for 20–39, red for 0–19
- [ ] `<PlacementBar>` shows Promotions as amber — not combined with Spam (red)
- [ ] Score breakdown (DNS / blacklist / placement split) NOT shown for Starter/Trial — locked state shown instead
- [ ] "Run Placement Test" button disabled and shows quota message when user is at monthly limit
- [ ] DNS status cards show red for any critical issue code
- [ ] `/billing` shows correct inbox count vs. limit for current plan
- [ ] Stripe checkout redirects on "Upgrade" click
- [ ] Clerk middleware blocks `/inboxes` for unauthenticated users (redirects to `/sign-in`)
- [ ] All pages render with 0 console errors in browser DevTools

## Mark done in SPEC-STATUS.md when all criteria above are verified
