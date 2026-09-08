# EmailWarm — Spec Index

This directory contains all atomic build specifications for Phase 1.

Read **ORCHESTRATOR.md** first — it defines the build order, wave groupings, and how to run parallel agents.  
Track all progress in **SPEC-STATUS.md**.

---

## Build waves (Phase 1)

| Wave | Name | Tasks | Depends on |
|---|---|---|---|
| W0 | Foundation | T001–T003 | — |
| W1 | Auth + Inbox core | T004–T007 | W0 |
| W2 | Warmup engine | T008–T010 | W1 |
| W3 | Monitoring + Scoring | T011–T013 | W1 |
| W4 | Placement + Diagnostics | T014–T015 | W2, W3 |
| W5 | Billing + Notifications | T016–T017 | W1 |
| W6 | Frontend | T018 | W2, W3, W4, W5 |
| W7 | Private Pool Architecture | T019–T023 | W0–W6 (all done) |
| W8 | Auth Hotfix | T024 | T004 |
| W9 | Structured Logging | T025 | T024 |

---

## Task directory

| Task | Title | Wave | Service spec |
|---|---|---|---|
| T001 | Project scaffold + infra config | W0 | domains/infra.md |
| T002 | Database schema + migrations | W0 | — |
| T003 | BullMQ + Redis setup | W0 | — |
| T004 | Better-auth guard + user sync | W1 | docs/05-agent-skills/02-skill-auth.md |
| T005 | Gmail OAuth connect | W1 | services/inbox.md |
| T006 | Outlook OAuth connect | W1 | services/inbox.md |
| T007 | Custom SMTP/IMAP connect | W1 | services/inbox.md |
| T008 | Warmup send processor | W2 | services/warmup-engine.md |
| T009 | Warmup receive processor | W2 | services/warmup-engine.md |
| T010 | Daily schedule + graduation | W2 | services/warmup-engine.md |
| T011 | DNS check processor | W3 | services/monitoring.md |
| T012 | Blacklist check processor | W3 | services/monitoring.md |
| T013 | Reputation score computation | W3 | — |
| T014 | Placement test processor | W4 | services/placement-test.md |
| T015 | AI diagnostics + readiness report | W4 | — |
| T016 | Stripe billing + trial | W5 | services/billing.md |
| T017 | Notification dispatch | W5 | — |
| T018 | Next.js frontend dashboard | W6 | domains/frontend.md |
| T019 | Pool inboxes table + schema migration | W7 | — |
| T020 | Inbox batch upload (CSV + wizard) | W7 | — |
| T021 | Initial inbox analysis job | W7 | — |
| T022 | Private pool pairing engine pivot | W7 | — |
| T023 | Pool management frontend | W7 | domains/frontend.md |
| T024 | Wire user sync on first sign-in | W8 | docs/05-agent-skills/02-skill-auth.md |
| T025 | Structured logging system (pino) | W9 | docs/05-agent-skills/11-skill-logging.md |

---

## Service + domain spec files

| File | Covers |
|---|---|
| services/warmup-engine.md | Warmup module contracts, queue design, graduation criteria |
| services/monitoring.md | DNS + RBL check module, alert contracts |
| services/placement-test.md | Seed list, placement analysis API, tab detection |
| services/billing.md | Stripe integration, plan limits, trial lifecycle |
| domains/frontend.md | Next.js page structure, component contracts, API proxying |
| domains/infra.md | GCP Cloud Run, Cloud SQL, Memorystore, Secret Manager, CI/CD |

---

## Waves added post-Phase 1

| Wave | Name | Tasks | Depends on |
|---|---|---|---|
| W10 | Pool UX + PulseDot | T026 | W7 |
| W11 | Inbox Activity Dashboard | T027 | T008, T009, T011, T012, T013, T025 |
| W12 | Pool Inbox Activity Panel + Connection Hints | T028 | T026, T027 |

| Task | Title | Wave | Skill files |
|---|---|---|---|
| T026 | Pool UX + PulseDot + readiness badges | W10 | docs/05-agent-skills/10-skill-frontend.md |
| T027 | Inbox Activity Dashboard (5 tabs + sparkline) | W11 | docs/05-agent-skills/10-skill-frontend.md |
| T028 | Pool Inbox Activity Panel + SMTP/IMAP hints | W12 | docs/05-agent-skills/10-skill-frontend.md |
