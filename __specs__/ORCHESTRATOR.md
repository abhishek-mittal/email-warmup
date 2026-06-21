# EmailWarm — Build Orchestrator

This file defines the exact build sequence for Phase 1. Follow it. Do not skip waves.

---

## How to use this file

1. Read the wave table to understand dependencies
2. Within a wave, tasks can run in parallel (spawn multiple agents)
3. Each task agent must:
   a. Read its task spec from `__specs__/tasks/TXXX-name.md`
   b. Load the relevant skill file(s) from `docs/05-agent-skills/`
   c. Mark its task row as `in_progress` in `__specs__/SPEC-STATUS.md` before starting
   d. Mark its task row as `done` in `__specs__/SPEC-STATUS.md` when complete
   e. Run acceptance criteria checks before marking done
4. Do not start Wave N+1 until all Wave N tasks are `done` in SPEC-STATUS.md

---

## Wave 0 — Foundation
**Goal:** Empty repo → running NestJS + DB + queues. Everything else builds on this.

| Task | Description | Parallelizable? |
|---|---|---|
| T001 | NestJS scaffold, GCP Cloud Run Dockerfile, CI skeleton | — (must run first) |
| T002 | Drizzle schema for all 10 tables + first migration | After T001 |
| T003 | BullMQ module, Redis connection, all 8 queue definitions | After T001 |

**Wave 0 gate:** `GET /health` returns 200. DB migration applies without error. BullMQ connects to Redis.

---

## Wave 1 — Auth + Inbox core
**Goal:** Users can sign in and connect their first inbox.

| Task | Description | Parallelizable? |
|---|---|---|
| T004 | BetterAuthGuard, user sync, plan gating | Yes (with T005) |
| T005 | Gmail OAuth 2.0 exchange + token storage + pre-check | Yes (with T006, T007) |
| T006 | Outlook OAuth 2.0 exchange + token storage + pre-check | Yes (with T005, T007) |
| T007 | Custom SMTP/IMAP credential input + pre-check | Yes (with T005, T006) |

**Wave 1 gate:** A user can sign in via better-auth, connect a Gmail inbox, and see it appear in `GET /inboxes` with status `pending` → `active` after pre-check passes.

---

## Wave 2 — Warmup engine
**Goal:** Connected inboxes begin warming automatically.

| Task | Description | Parallelizable? |
|---|---|---|
| T008 | warmup-send processor: pairing, send via SMTP, record in DB | Yes (with T009) |
| T009 | warmup-receive processor: open, star, reply, rescue, file to WarmupHub | Yes (with T008) |
| T010 | Daily schedule cron, ramp curve, graduation check, pool enrollment | After T008, T009 |

**Wave 2 gate:** An active inbox receives its first warmup send job. The inbox sends and receives warmup emails. Daily volume follows the ramp curve.

---

## Wave 3 — Monitoring + Scoring
**Goal:** Reputation score is computed daily and alerts fire on issues.

| Task | Description | Parallelizable? |
|---|---|---|
| T011 | DNS check processor: SPF, DKIM, DMARC, MX, rDNS | Yes (with T012) |
| T012 | Blacklist check processor: 100+ RBL DNS lookups, pause on hit | Yes (with T011) |
| T013 | Score computation: composite 0–100, history, trend, drop alert | After T011, T012 |

**Wave 3 gate:** `GET /inboxes/:id/score` returns a valid score with breakdown. A test blacklist hit pauses the inbox and triggers an alert.

---

## Wave 4 — Placement + Diagnostics
**Goal:** Users can test inbox placement and get AI-powered fix recommendations.

| Task | Description | Parallelizable? |
|---|---|---|
| T014 | Placement test: seed list send, Gmail tab detection, result storage | Yes (with T015) |
| T015 | AI diagnostics via Claude API + readiness report generation | Yes (with T014) |

**Wave 4 gate:** `POST /inboxes/:id/placement-test` triggers test, results appear within 10 minutes. `GET /inboxes/:id/diagnostics` returns AI analysis with issue codes and fix steps.

---

## Wave 5 — Billing + Notifications
**Goal:** Users can subscribe and upgrade plans. Alerts reach users via email.

| Task | Description | Parallelizable? |
|---|---|---|
| T016 | Stripe checkout, webhooks, portal, trial expiry cron | Yes (with T017) |
| T017 | Notification queue processor: email via Nodemailer, Slack via webhook | Yes (with T016) |

**Wave 5 gate:** A trial user can upgrade to Growth via Stripe checkout. Trial expiry pauses inboxes and sends email. Email notifications fire for all alert types.

---

## Wave 6 — Frontend
**Goal:** Full dashboard UI connected to the live backend.

| Task | Description | Parallelizable? |
|---|---|---|
| T018 | Next.js 15 App Router dashboard: all pages and flows | — (depends on all prior waves) |

**Wave 6 gate:** All Phase 1 user flows work end-to-end in the browser without console errors. Better-auth session middleware protects all dashboard routes.

---

## Subagent prompt template

Use this template when spawning a task agent:

```
You are working on EmailWarm, an email inbox warming SaaS (NestJS + PostgreSQL + BullMQ + Next.js 15).

Your task: [TASK TITLE]
Task spec: __specs__/tasks/TXXX-name.md

Before writing any code:
1. Read the task spec completely
2. Load the skill files listed in the spec
3. Mark your task as in_progress in __specs__/SPEC-STATUS.md
4. Read .claude/CLAUDE.md for project-wide non-negotiables

When done:
1. Verify all acceptance criteria in the task spec
2. Mark your task as done in __specs__/SPEC-STATUS.md with completion notes
```

---

## SPEC-STATUS update protocol

When starting a task:
- Find your row in `SPEC-STATUS.md`
- Change `status` to `in_progress`
- Fill in `started_at` with current timestamp

When completing a task:
- Change `status` to `done`
- Fill in `completed_at`
- Add a one-line note in the `notes` column (e.g., "All 5 acceptance criteria passed")
- If any criterion could not be met, change status to `blocked` and describe the blocker
