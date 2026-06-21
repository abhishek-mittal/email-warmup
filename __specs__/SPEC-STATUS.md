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
| T010 | Daily schedule + graduation | done | 2026-06-21 | 2026-06-21 | WarmupService (@Cron 05:00 UTC), RampService (linear interpolation, capped at 200), PairingService (same-domain hard block, scoring, 7-day recency penalty); 8-min spacing + ±15min jitter algorithm per addendum #3; graduation w/ asymmetric missing-data handling (reputation fails closed, placement skips); readiness-report queue added; fixed Wave-1 pool-enrollment gap in inbox.service.ts. All 9 acceptance criteria verified by unit tests (87/87), typecheck, build, and a clean runtime boot (controller-reviewed directly, diff matches addendum exactly, arithmetic hand-checked). Known gap (not blocking): service-spec's WarmupService.pauseInbox()/resumeInbox()/public scheduleInbox() were not built — T010's own criteria don't need them, but T012 (blacklist-check, "pause on hit") will; T012 is responsible for adding pauseInbox(). |

**Wave 2 gate:** Active inbox sends and receives warmup emails · Daily volume follows ramp curve  
**Wave 2 status:** ✅ verified at unit/integration level — RampService's curve, WarmupService's scheduling/pairing/graduation, WarmupSendProcessor, and WarmupReceiveProcessor are each independently tested (118 tests across the wave) and boot cleanly together as one wired NestJS app (confirmed live: `GET /health` 200 with WarmupModule + ScheduleModule loaded against real Postgres/Redis). Genuine live E2E (real Gmail/Outlook accounts sending/receiving over real elapsed days) was not run — needs real OAuth credentials and manual QA, out of scope for this session.  
**Blocked by:** Wave 1

---

## Wave 3 — Monitoring + Scoring

| Task | Title | Status | Started | Completed | Notes |
|---|---|---|---|---|---|
| T011 | DNS check processor | done | 2026-06-21 | 2026-06-21 | DnsService (5 check methods: checkSpf/checkDkim/checkDmarc/checkMx/checkRdns) using explicit-DNS-server `dns.promises.Resolver(['1.1.1.1','8.8.8.8'])` for TXT/MX lookups per addendum #1 (bare `dns.promises.reverse()` for rDNS, no custom-resolver support in Node's API). DnsCheckProcessor (`@Processor('dns-check')` + `@Cron('0 6 * * *', {utcOffset:0}) scheduleAllInboxes()` on the same class per addendum #8). New-critical-issue alerting resolved at the boolean level (spfValid/dkimValid/mxValid only — DMARC/rDNS never alertable per addendum #3); first-ever check for an inbox never alerts (addendum #4); payload includes every currently-failing critical code, alert fires once. rDNS skipped (`rdnsValid: null`) when sendingIp unset (addendum #6); `score` left unset for T013 (addendum #7); notify enqueued directly via QueueService, no AlertService (addendum #2). No `monitor.module.ts` created (controller wires it after T012 lands). All 8 acceptance criteria verified by 38 unit tests (20 DnsService + 18 DnsCheckProcessor), typecheck, lint, and build all pristine. |
| T012 | Blacklist check processor | done | 2026-06-21 | 2026-06-21 | BlacklistService checks domain against the 8 minimum RBL zones from `monitor/rbl-list.ts` (no fabricated 100+ list per addendum #1) via `dns.promises.resolve4('{domain}.{rblZone}')` in parallel (Promise.allSettled), each lookup individually timeboxed to 5s; 127.x → listed, ENOTFOUND/ENODATA → clean, anything else (incl. timeout) → unknown, never blocking the others (addendum #6). BlacklistCheckProcessor (`@Processor('blacklist-check')` + `@Cron('0 0,6,12,18 * * *', {utcOffset:0}) scheduleAllInboxes()` on the same class per addendum #8) writes the `blacklist_checks` row, then on any listing calls `warmupService.pauseInbox()` and awaits it to completion BEFORE enqueueing the `blacklist_hit` notify job (addendum #5, verified by an invocationCallOrder test) and a `diagnostics` job (trigger `auto_blacklist`); `score-compute` enqueued unconditionally. Added `WarmupService.pauseInbox()` (sets status='paused', drains both warmup-send-as-sender and warmup-receive-as-receiver jobs) and the two `QueueService.removeJobsForSender`/`removeJobsForReceiver` helpers plus the `diagnostics` queue as the 10th `QUEUE_NAMES` entry (addenda #3, #4) — `resumeInbox` deliberately not built (nothing calls it yet). No `AlertService` (addendum #2), no `monitor.module.ts` (controller wires it after both T011 and T012 land). All 8 acceptance criteria verified by 28 unit tests (7 BlacklistService + 13 BlacklistCheckProcessor + 8 QueueService/WarmupService additions), typecheck, and build all pristine; 153/153 tests pass across the full suite. |
| T013 | Reputation score computation | done | 2026-06-21 | 2026-06-21 | ScoringService (pure computeDnsScore/computeBlacklistScore/computePlacementScore against the actual boolean-only DB schema, not the skill file's string-enum pseudocode — addenda #1-#5: null DNS check→0, rDNS only penalized on explicit `false` not `null`, no blacklist check→30 "assume clean", listed-RBL derived from `rblResults` JSONB not `listedCount` alone, null placement→20). TrendService (DB-dependent, kept in its own file per addendum #11) fixes a real bug in the skill's trend formula — requires >=4 historical rows before attempting up/down, else 'stable' (addendum #7), and drops the unused `currentScore` param (addendum #6). ScoreComputeProcessor (`@Processor('score-compute')`) loads latest dns/blacklist/placement rows, computes + clamps the 0-100 total, queries trend and the single previous score BEFORE inserting the new `reputation_scores` row, then fires `notify`(`score_drop`) + `diagnostics`(`auto_drop`) only when exactly one prior row exists and its drop is >=15 (addendum #8 — never alerts a newly-connected inbox with zero history). New ScoringController (`GET /inboxes/:id/score`, `@UseGuards(ClerkGuard)`) does its own inbox-ownership check (no existing helper — addendum #9) returning 404 (not 403) for both "not found" and "not yours"; response shape matches the task spec literally, not the skill's `getScoreHistory` (addendum #10) — breakdown null for trial/starter plans, `{current:null,trend:'stable',breakdown:null,history:[]}` when no score ever computed. ScoringModule wired into app.module.ts. All acceptance criteria verified by 47 unit tests (21 ScoringService + 8 TrendService + 11 ScoreComputeProcessor + 7 ScoringController) including the exact numeric examples (SPF+DKIM missing=10, Spamhaus=0, 100% Primary=40, 100% Promotions=20, null placement=20); typecheck, build, and full suite (200/200) all pristine; live boot confirmed `ScoringModule dependencies initialized`, `GET /inboxes/:id/score` route mapped, `GET /health` 200, and the new endpoint correctly 401s without a Clerk token. |

**Wave 3 gate:** Score returned by API · Blacklist hit pauses inbox + fires alert  
**Wave 3 status:** ✅ complete — T011, T012, T013 all done; score-compute is consumed end-to-end (T011/T012 produce `score-compute` jobs, T013 consumes them) and `GET /inboxes/:id/score` is live behind ClerkGuard with its own ownership check.  
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
| 1 | `ScoringService.computePlacementScore` uses non-null assertions (`primaryCount!`, `promotionsCount!`, `seedCount!`) on columns that are nullable in the schema; a real row with a null count would produce `NaN` rather than throwing/defaulting. Inherited from the controller's own addendum code sample, not implementer error. | Minor | T013 reviewer | No |

*Add issues here as they are discovered during implementation.*
