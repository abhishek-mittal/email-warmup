# EmailWarm — Spec Status Tracker

**Purpose:** Single source of truth for what has been built, what is in progress, and what is blocked.  
Every coding agent MUST update this file when it starts a task and when it completes one.  
Do not mark a task `done` unless all acceptance criteria in its spec file have been verified.

---

## How to update this file

When **starting** a task:
1. Set `status` → `in_progress`
2. Fill in `started_at` (ISO date)

When **completing** a task:
1. Set `status` → `done`
2. Fill in `completed_at`
3. Write a one-line note confirming which criteria passed

When **blocked**:
1. Set `status` → `blocked`
2. Describe the blocker in `notes`

---

## Wave 0 — Foundation

| Task | Title | Status | Started | Completed | Notes |
|---|---|---|---|---|---|
| T001 | Project scaffold + infra config | done | 2026-06-20 | 2026-06-20 | Health 200, typecheck pass, dev servers start, docker-compose defined, CI/CD scaffolded |
| T002 | Database schema + migrations | done | 2026-06-20 | 2026-06-20 | 10 tables created, migration applied, indexes verified |
| T003 | BullMQ + Redis setup | done | 2026-06-20 | 2026-06-20 | 8 queues registered, retention config set, QueueService unit tests pass |

**Wave 0 gate:** `GET /health` 200 · DB migration clean · BullMQ connects  
**Wave 0 status:** ⬜ not started

---

## Wave 1 — Auth + Inbox core

| Task | Title | Status | Started | Completed | Notes |
|---|---|---|---|---|---|
| T004 | Clerk auth guard + user sync | done | 2026-06-20 | 2026-06-20 | ClerkGuard, Public decorator, webhook sync, billing helpers, tests pass |
| T005 | Gmail OAuth connect | done | 2026-06-20 | 2026-06-20 | GoogleOAuthService, InboxService pre-check, encrypted tokens, token-refresh job queued |
| T006 | Outlook OAuth connect | done | 2026-06-20 | 2026-06-20 | MicrosoftOAuthService, connectOutlook, encrypted tokens, token-refresh queued |
| T007 | Custom SMTP/IMAP connect | done | 2026-06-20 | 2026-06-20 | ConnectCustomSmtpDto, encrypted credentials, pre-check with 422 step errors |

**Wave 1 gate:** Sign in via Clerk · Connect Gmail inbox · Status updates to active  
**Wave 1 status:** ⬜ not started  
**Blocked by:** Wave 0

---

## Wave 2 — Warmup engine

| Task | Title | Status | Started | Completed | Notes |
|---|---|---|---|---|---|
| T008 | Warmup send processor | done | 2026-06-21 | 2026-06-21 | WarmupSendProcessor + ContentService; Message-ID/X-WarmupHub headers, body-hash-only storage, warmup-receive enqueue w/ 2-240min delay + reply/rescue logic, inactive-sender UnrecoverableError, Claude 10s timeout w/ 50-template fallback — all verified by unit tests, typecheck, build |
| T009 | Warmup receive processor | done | 2026-06-21 | 2026-06-21 | WarmupReceiveProcessor: strict rescue→open→star→reply→file order, landed_in_spam unconditional/rescue gated on actions, IMAP pool reused, Gmail-only tab detection. Reviewer caught a real WarmupHub mailbox-selection bug (mailboxOpen before messageMove broke seq-relative MOVE semantics) — fixed in ee0d740, re-reviewed and approved. All verified by unit tests, typecheck, build, and a runtime boot. |
| T010 | Daily schedule + graduation | pending | — | — | — |

**Wave 2 gate:** Active inbox sends and receives warmup emails · Daily volume follows ramp curve  
**Wave 2 status:** ⬜ not started  
**Blocked by:** Wave 1

---

## Wave 3 — Monitoring + Scoring

| Task | Title | Status | Started | Completed | Notes |
|---|---|---|---|---|---|
| T011 | DNS check processor | pending | — | — | — |
| T012 | Blacklist check processor | pending | — | — | — |
| T013 | Reputation score computation | pending | — | — | — |

**Wave 3 gate:** Score returned by API · Blacklist hit pauses inbox + fires alert  
**Wave 3 status:** ⬜ not started  
**Blocked by:** Wave 1

---

## Wave 4 — Placement + Diagnostics

| Task | Title | Status | Started | Completed | Notes |
|---|---|---|---|---|---|
| T014 | Placement test processor | pending | — | — | — |
| T015 | AI diagnostics + readiness report | pending | — | — | — |

**Wave 4 gate:** Placement test results in < 10 min · AI diagnostics with codes + fix steps  
**Wave 4 status:** ⬜ not started  
**Blocked by:** Wave 2, Wave 3

---

## Wave 5 — Billing + Notifications

| Task | Title | Status | Started | Completed | Notes |
|---|---|---|---|---|---|
| T016 | Stripe billing + trial | pending | — | — | — |
| T017 | Notification dispatch | pending | — | — | — |

**Wave 5 gate:** Trial upgrade via Stripe · Trial expiry pauses inboxes · Email alerts fire  
**Wave 5 status:** ⬜ not started  
**Blocked by:** Wave 1

---

## Wave 6 — Frontend

| Task | Title | Status | Started | Completed | Notes |
|---|---|---|---|---|---|
| T018 | Next.js frontend dashboard | pending | — | — | — |

**Wave 6 gate:** All Phase 1 flows work end-to-end in browser · Clerk auth protects routes  
**Wave 6 status:** ⬜ not started  
**Blocked by:** Waves 2, 3, 4, 5

---

## Phase 1 completion gate

All of the following must be true before Phase 1 is declared done:

- [ ] All 18 tasks are `done`
- [ ] All 6 wave gates are verified
- [ ] `GET /health` returns 200 on Cloud Run (asia-south1)
- [ ] A real Gmail inbox can be connected, warmed for 3 days, and shows a rising score
- [ ] A placement test completes and correctly distinguishes Primary vs Promotions
- [ ] A blacklist hit simulation pauses warmup and fires email notification
- [ ] A trial user can upgrade to Growth via Stripe checkout
- [ ] Frontend dashboard renders all pages without console errors

---

## Open issues

| ID | Description | Severity | Raised by | Resolved |
|---|---|---|---|---|
| — | — | — | — | — |

*Add issues here as they are discovered during implementation.*
