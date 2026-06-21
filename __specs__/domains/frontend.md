# Domain Spec: Frontend

**Tasks covered:** T018  
**Primary skill file:** docs/05-agent-skills/10-skill-frontend.md

---

## Pages to build (Phase 1)

### 1. Dashboard overview (`/`)
**Purpose:** At-a-glance health of all inboxes

Sections:
- Summary bar: total inboxes, average score, inboxes with issues
- Inbox list: each row shows email, status badge, score (coloured), warmup day, trend arrow, quick-action button
- Empty state: "Connect your first inbox" CTA when no inboxes

### 2. Inbox list (`/inboxes`)
**Purpose:** Full inbox management
- Table: email, provider icon, status, score, warmup speed, warmup day, placement last run, actions (pause / resume / run placement test / view detail)
- "Connect inbox" button (top right)

### 3. Connect inbox (`/inboxes/connect`)
**Purpose:** OAuth or custom SMTP setup
- Three tabs: Gmail | Outlook | Custom SMTP
- Gmail/Outlook: single "Connect with Google/Microsoft" button → redirect to OAuth
- Custom SMTP: form fields: SMTP host, port, user, password, IMAP host, port, user, password, DKIM selector
- Show pre-check result after connection (5-step checklist with pass/fail indicators)

### 4. Inbox detail (`/inboxes/[id]`)
**Purpose:** Deep view of one inbox
Sections:
- Score gauge (circular, coloured, with breakdown for Growth+ plans)
- Score history chart (30-day line chart)
- Warmup progress bar (day X of total days for speed)
- DNS status cards: SPF / DKIM / DMARC / MX — green/red/yellow per status
- Blacklist status: "Clean" or listed RBL names
- Latest placement test result: Primary% / Promotions% / Spam% bar
- "Run Placement Test" button (quota-gated)

### 5. Diagnostics (`/inboxes/[id]/diagnostics`)
**Purpose:** AI analysis + readiness report
- Issue list: icon + code + explanation + fix steps for each issue
- Readiness report (shown after graduation): recommended send volume, pool contribution summary, next steps
- "Request new analysis" button

### 6. Billing (`/billing`)
**Purpose:** Plan management
- Current plan card: name, price, inbox count / limit, placement tests used / limit
- Feature comparison table (4 plans)
- "Upgrade" button → Stripe checkout
- "Manage subscription" button → Stripe portal (only if subscribed)
- Trial countdown banner if on trial

---

## Component contracts

### `<ReputationGauge score={76} breakdown={{ dns: 24, blacklist: 30, placement: 22 }} plan="growth" />`
- Circular arc gauge, colour-coded by range
- `breakdown` only rendered if `plan` is growth/agency/enterprise
- Trend arrow below gauge

### `<PlacementBar primary={73} promotions={18} spam={9} />`
- Three colour segments: green / amber / red
- Labels with percentages
- Never combine Promotions and Spam into one segment

### `<InboxStatusBadge status="active" />`
- Maps status → label + colour per STATUS_CONFIG table in skill file

### `<DnsStatusCard type="spf" status="missing" />`
- Compact card: icon + label + status indicator
- Links to fix documentation on click

---

## Routing and auth

All routes under `/(dashboard)` are protected by better-auth session middleware
(`getSessionCookie()` from `better-auth/cookies` in `src/middleware.ts`).
Public routes: `/sign-in`, `/sign-up`, `/api/auth/*`, `/api/webhooks/*`

Redirects:
- Unauthenticated → `/sign-in?redirect_url=...`
- Authenticated + no inboxes → `/inboxes/connect` (first-run state)
- Inbox-connect OAuth callback → `GET /auth/callback/{google,microsoft}` on the **backend** → redirects to `/inboxes`

The frontend never builds its own Google/Microsoft OAuth URL — it only calls
`/auth/{gmail,outlook}/connect` on the backend and follows the returned redirect.
The `useApi()` / `serverApi()` helpers mint a `v1.<uid>.<exp>.<sig>` Bearer token
from the active better-auth session and attach it as `Authorization: Bearer` on
every backend call. The backend verifies the HMAC against the shared
`BETTER_AUTH_SECRET`.

---

## Acceptance criteria (T018)

- [ ] `/` renders inbox list with correct score and status for each inbox
- [ ] Gmail inbox-connect OAuth flow completes end-to-end and inbox appears in list
- [ ] Inbox detail page shows score gauge with correct colour for score range
- [ ] Placement bar shows three distinct segments (Primary / Promotions / Spam)
- [ ] Score breakdown hidden for Starter plan user — shows locked state
- [ ] "Run Placement Test" button disabled and shows quota message when quota exhausted
- [ ] Billing page shows current plan with correct inbox count / limit
- [ ] Stripe checkout redirect works from billing page
- [ ] All pages render without console errors
- [ ] Better-auth middleware blocks access to dashboard routes for unauthenticated users (redirects to `/sign-in`)
- [ ] No `clerk`, `Clerk`, `@clerk/*` in `src/` or `package.json`
