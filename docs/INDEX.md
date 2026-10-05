# EmailWarm — Master Documentation Index

> **Current release assessment (2026-10-03):** Start with [Market readiness audit](07-market-readiness/README.md) for implemented capabilities, gaps, 24 actionable work packages and the agent status board. Historical task completion does not imply launch readiness.


**Project:** EmailWarm (name TBD)  
**Version:** 0.1 — Implemented MVP under readiness review
**Last updated:** 3 October 2026
**Status:** Substantial implementation; not ready for public market release. See the current audit above.

---

## Quick navigation

| Doc | Purpose | Status |
|---|---|---|
| [PRD.md](01-product/PRD.md) | Product requirements, user types, phased scope, success metrics | ✅ |
| [TECH-SPEC.md](02-technical/TECH-SPEC.md) | Architecture, services, schema, API contracts, auth, caching | ✅ |
| [EXPERIENCE-SPEC.md](03-experience/EXPERIENCE-SPEC.md) | UX flows, onboarding, dashboard, alerts | ✅ |
| [WARMUP-SCHEMA.md](03-experience/WARMUP-SCHEMA.md) | Warmup pool data schema + ramp curve config | ✅ |
| [GTM-BRIEF.md](04-gtm/GTM-BRIEF.md) | Pricing tiers, go-to-market plan, pilot strategy | ✅ |
| [Agent skills README](05-agent-skills/README.md) | Skill index for coding agents | ✅ |

---

## Stack (historical design; verify against current audit)

| Layer | Choice | Key reason |
|---|---|---|
| Backend framework | NestJS (Node 22) | Modular DI — queues, guards, interceptors as injectable services |
| Job queue | BullMQ + Redis | Millisecond-precision delays, per-inbox rate limiting, parent-child flows |
| Database | PostgreSQL 16 | Relational integrity for pool pairing, tenant isolation, audit logs |
| ORM | Drizzle ORM | Type-safe, zero-overhead SQL, schema-as-code |
| Auth | better-auth (self-hosted) | OAuth social login + email/password; HMAC-signed bearer tokens issued per session |
| Email send | Nodemailer (raw SMTP) | Direct protocol control — no ESP abstraction |
| IMAP client | imapflow | Modern OAuth-aware IMAP; handles token refresh natively |
| AI content | Anthropic Claude API | Industry-aware warmup email generation |
| Frontend | Next.js 16 (App Router) | Latest stable; RSC + server actions |
| Hosting | GCP Cloud Run | Reuse dmphub infrastructure (asia-south1) |
| Database host | GCP Cloud SQL (PostgreSQL) | Reuse dmphub Cloud SQL instance |
| Cache / Queue | GCP Memorystore (Redis) | Reuse dmphub Memorystore |
| Payments | Stripe | Subscription + usage-based billing |
| DNS checks | Native Node dns module + custom resolvers | No third-party dependency for SPF/DKIM/DMARC lookups |
| Blacklist checks | Spamhaus DNS API + MXToolbox | Commercial RBL feeds |

---

## Open decisions

| ID | Decision | Options | Owner | Due |
|---|---|---|---|---|
| OD001 | Final product name | WarmHub / Inboxly / MailWarm / other | Abhishek | Before domain purchase |
| OD002 | Warmup pool bootstrap strategy | Build 500 internal accounts vs invite-only | Abhishek | Before T010 |
| OD003 | AI content provider | Anthropic Claude API vs OpenAI GPT-4o | Abhishek | Before T007 |
| OD004 | BIMI support in Phase 1 | Include or defer to Phase 2 | Abhishek | Before T004 |
| OD005 | Seed list provider | Build own vs buy (GlockApps / MailTester) | Abhishek | Before T009 |

---

## Phase 1 definition of done

All of the following must be true before Phase 1 is considered live:

- [ ] Gmail + Outlook OAuth inbox connection working end-to-end
- [ ] Warmup engine sending + receiving + engaging (open / star / reply / rescue from spam)
- [ ] Weekly inbox placement test showing Primary / Promotions / Spam distinction
- [ ] DNS health checks (SPF / DKIM / DMARC / MX / rDNS) running daily with alerts
- [ ] Blacklist monitoring (100+ RBLs) running every 6 hours with alerts
- [ ] Reputation score 0–100 showing 90-day trajectory on dashboard
- [ ] Stripe subscription billing live (Starter + Growth tiers)
- [ ] Health endpoints returning 200 from production Cloud Run URL
- [ ] End-to-end user flow tested in production (signup → connect → warmup → score visible)
