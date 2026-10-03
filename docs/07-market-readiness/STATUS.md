# Market readiness status and agent work board

**Updated:** 2026-10-03 (Asia/Kolkata) · **Audited commit:** `0ad4c44`

**Audit documentation: complete. Application remediation: 0/24 work packages verified; 8 in review (MR-01, 02, 03, 05, 07, 08, 12, 13), 11 in progress (MR-06, 09, 10, 11, 14, 15, 16, 18, 19, 21, 22). Public launch: not ready. Release gates: 0/8 verified.**

“Review” means the code and its automated tests are done and passing locally; “verified” additionally needs the real-provider or staging evidence each task names, which has not been gathered.

Implementation coverage: 16 of 20 capability groups contain code (80% coverage); this is not an effort or market-readiness percentage. See [assessment](README.md), [feature matrix](FEATURE-MATRIX.md), [task specifications](TASKS.md) and [release gates](RELEASE-GATES.md).

## Audit progress

- [x] Inventory source, product requirements, historical tracker and deployment files.
- [x] Inspect core warmup, OAuth, billing and placement execution paths.
- [x] Inspect remaining security, monitoring, UI and persistence contracts.
- [x] Attempt local verification and document dependency/network limitations.
- [x] Finish feature matrix, corrective task specifications and launch gates.
- [x] Check documentation links, task coverage and completion accounting.

Runtime build/tests remain unverified because dependencies could not be fetched. See [evidence](EVIDENCE.md). Audit completion is not software acceptance.

## Work board

Before starting, replace `unassigned` with your agent/owner name, set `in_progress`, and add start date/branch under the handoff log. Read dependencies in TASKS.md. Do not edit shared migrations concurrently. Use `review` when code is ready, and `verified` only after acceptance evidence exists. `blocked` requires a named dependency and next action.

| Task | Priority | Work package | Status | Owner | Evidence |
|---|---|---|---|---|---|
| MR-01 | P0 | Secure and separate mailbox OAuth linking | review | Claude | [MR-01](verification/MR-01.md): 18 integration tests + live callback checks; real provider journeys outstanding |
| MR-02 | P0 | Make mail side effects and replies correct | review | Claude | [MR-02](verification/MR-02.md): 18 real SMTP/IMAP tests; real two-mailbox exchange outstanding |
| MR-03 | P0 | Enforce daily volume and idempotent scheduling | review | Claude | [MR-03](verification/MR-03.md): 15 real-Postgres tests + 10 unit; multi-day staging ledger outstanding |
| MR-04 | P0 | Repair payment processing and subscription state | open | unassigned | Not yet verified |
| MR-05 | P0 | Make placement observations reliable | review | Claude | [MR-05](verification/MR-05.md): 15 real-protocol tests. Real provider seed runs outstanding |
| MR-06 | P0 | Make builds and deployment reproducible | in_progress | Claude | [MR-06](verification/MR-06.md): both images build and boot, migration entrypoint verified. Deploy workflow rewritten but never run; web-to-API access unresolved |
| MR-07 | P0 | Remove browser signing authority | review | Claude | [MR-07](verification/MR-07.md): 23 proxy tests, sentinel build scan, 10 live checks; secret rotation is an operator action |
| MR-08 | P0 | Complete OAuth refresh and transport compatibility | review | Claude | [MR-08](verification/MR-08.md): 11 integration tests + TLS-mode unit tests; real provider expiry run outstanding |
| MR-09 | P0 | Enforce entitlements at every entry point | in_progress | Claude | Demo plan with test credits, batch-import limit, resume plan gate. No reservation/locking, Stripe untouched (by decision) |
| MR-10 | P0 | Enforce consent and pool eligibility | in_progress | Claude | Explicit consent (API + UI), transport-gated activation, send-time eligibility. Filing-promise decision and private-pool attestation open |
| MR-11 | P0 | Harden untrusted inputs, egress and secret handling | in_progress | Claude | [MR-11](verification/MR-11.md): host egress policy, import caps, Slack URL limit, CORS. Rate limits, DTO sweep, log redaction, key rotation open |
| MR-12 | P0 | Build bounce protection and emergency stopping | review | Claude | [MR-12](verification/MR-12.md): 18 integration tests (3% rule, notices, stop switches). Notification and real-provider notices outstanding |
| MR-13 | P1 | Make DNS/RBL diagnostics truthful | review | Claude | [MR-13](verification/MR-13.md): 55 unit tests. 5 live zones, not 100+; live lookups not verified |
| MR-14 | P1 | Provision and operate placement seeds | in_progress | Claude | [MR-05](verification/MR-05.md): seed registry, health check, minimum coverage. No seeds provisioned; no weekly schedule |
| MR-15 | P1 | Harden database contracts and durable workflows | in_progress | Claude | Migrations 0005/0006 (ledger, schedules, link states, uniqueness). Ownership FKs, checks, auth migration job open |
| MR-16 | P1 | Make scores, graduation and AI recommendations evidence-based | in_progress | Claude | [MR-16](verification/MR-16.md): score completeness; graduation rule v3 (threshold 80, decided) with one free graduation placement test. AI diagnostics open |
| MR-17 | P1 | Build post-graduation maintenance | open | unassigned | Not yet verified |
| MR-18 | P1 | Complete notifications and customer settings | in_progress | Claude | Revocation and bounce-pause notices queued once per event (tested). Settings UI, notification ledger, independent Slack retry open |
| MR-19 | P1 | Operate workers, cron and recovery in production | in_progress | Claude | [MR-06](verification/MR-06.md): readiness probe, exit on uncaught exception, default retries. Worker split, heartbeat, runbooks, restore open |
| MR-20 | P1 | Align frontend contracts and truthful states | open | unassigned | Not yet verified |
| MR-21 | P1 | Build account recovery, disconnect and privacy lifecycle | in_progress | Claude | [MR-21](verification/MR-21.md): disconnect, export, anonymizing deletion, password reset (8 integration tests). Reset mail delivery unobserved; retention, legal pages open |
| MR-22 | P1 | Establish security and release-quality automation | in_progress | Claude | Protocol harness (Postgres/Redis/GreenMail), frontend test runner. Tenant-isolation HTTP suite and browser tests open |
| MR-23 | P1 | Complete commercial launch prerequisites | open | unassigned | Not yet verified |
| MR-24 | P1 | Run controlled pilot and release acceptance | open | unassigned | Not yet verified |

**Priority count:** 12 P0 + 12 P1. Nothing is marked verified yet.

**Owner priority (2026-10-03):** email connectivity and warming first. Billing is deferred: accounts run on a demo plan with fixed test credits (`DEMO_MODE=true`) and MR-04 is not being worked.

## Handoff log

| Date | Owner | Action | Evidence / next action |
|---|---|---|---|
| 2026-10-03 | Audit agent | Source/config review and documentation completed | Read MR-07 first; establish schema/test contracts before dependent work. Test/build attempts blocked during dependency installation; no application changes made. |
| 2026-10-03 | Claude | MR-01/02/03/07/08 implemented to review; MR-06/09/10/15/22 partly done. Branch `feat/mr-warmup-core`, uncommitted on top of `0ad4c44`. | Backend: typecheck clean, 512 unit + 74 integration tests pass (`pnpm --dir backend test`, `pnpm --dir backend run test:int` with `docker compose -f docker-compose.test.yml up -d`), build passes. Frontend: typecheck, lint, 23 tests, production build pass. Migrations `0005_warmup_delivery_ledger`, `0006_oauth_link_states` (additive; rollback = drop the added tables/columns/indexes). Applied to the local dev database. Next: real two-mailbox exchange and provider link journeys; MR-12 bounce protection; MR-11 egress policy. Open decisions in each verification file. |
| 2026-10-03 | Claude | MR-12 implemented to review; MR-11 partly done. Same branch, uncommitted. | Backend: typecheck clean, 584 unit + 98 integration tests pass, build passes. Migration `0007_bounce_and_safety_stops` (additive; rollback = drop `safety_stops` and the three `bounce_*` columns). Applied to the local dev database. Live: operator route 401 without secret, 404 through the browser proxy, no CORS header for a foreign origin. Next: Phase 2 (MR-13 blocklists first). |
| 2026-10-03 | Claude | MR-05, MR-13 to review; MR-14, MR-16 partly done. Same branch, uncommitted. | Backend: 602 unit + 113 integration tests pass, typecheck and build clean. Migrations `0008_placement_observations`, `0009_score_completeness`, applied to the local dev database. Next: Phase 3 (MR-18 notifications, MR-21 lifecycle, MR-06/19 deploy). Blocking externals: seed mailboxes, Spamhaus key, graduation threshold decision. |
| 2026-10-03 | Claude | Owner decisions applied: graduation threshold 80; one free graduation placement test; monthly placement allowance (no weekly promise); advertise the verified blocklists only; anonymize on account deletion. MR-21 partly done. | Backend 604 unit + 121 integration tests pass. Migration `0010_placement_purpose` (one column), applied to local dev database. Owner action: obtain a Spamhaus Data Query Service key. |

For subsequent entries include task ID, branch/commit, files changed, exact test commands/results, migration/rollback, remaining issue and next action. Keep work status and gate status separate. If implementation changes scope, revise the feature matrix and task acceptance criteria with a decision note rather than silently dropping requirements.
