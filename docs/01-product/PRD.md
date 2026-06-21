# EmailWarm — Product Requirements Document

**Version:** 0.1  
**Date:** June 2026  
**Author:** Nexus OS (Abhishek Mittal)

---

## 1. Problem statement

Cold outreach teams — SDRs, agencies, solo founders — buy email domains and start sending campaigns. Within days, their emails land in spam. They do not know why, they do not know how to fix it, and the tools that exist to help them either charge per inbox (making agencies pay $2,000+/month for 50 inboxes) or give a score without telling them what to do about it.

The specific problems this product solves:

1. **New domain reputation is zero.** ESP algorithms treat unknown senders as suspicious. Emails go to spam before any campaign is sent.
2. **Per-inbox pricing punishes agencies.** Warmy charges $49/inbox. Mailreach charges $25/inbox. An agency with 50 client inboxes pays $1,250–$2,500/month for a tool that only warms — not diagnoses.
3. **Tools show scores, not causes.** When placement fails, existing tools say "you're in spam." They do not say why, and they do not say how to fix it.
4. **Nobody distinguishes Promotions from Primary.** Cold outreach needs Primary inbox placement. Landing in Gmail's Promotions tab is nearly as bad as spam — but no warmup tool surfaces this distinction.
5. **Warmup ends with no guidance.** When a warmup completes, tools say "done." They do not tell users what volume to start at, what to watch, or what to do if things go wrong.

---

## 2. Users

### User Type A — Solo Outreacher / SDR
- Warms 1–3 inboxes for personal cold outreach
- Technically capable but not a sysadmin — doesn't know what DKIM is
- Needs: dead-simple connect → warm → send flow with plain-English health guidance
- Pain point: spending $49–$99/month per inbox is painful at their scale

### User Type B — Cold Outreach Agency
- Manages 10–100 client inboxes across multiple client accounts
- Needs multi-client workspace, bulk import, and client-facing reporting
- Pain point: per-inbox pricing makes the category unaffordable at scale; no white-label option for client-facing dashboards
- Currently: tolerates Instantly's lower-quality warmup because it's free with their sending platform

### User Type C — SaaS Platform / ESP (API buyer)
- Building cold email software and wants to embed warmup natively
- Needs a clean REST API and webhook events, not a UI
- Pain point: building a warmup network from scratch requires 6–12 months and a seed pool

---

## 3. Core value proposition

**Flat-rate pricing that agencies can afford, with diagnostics that actually tell you why you're in spam — not just that you are.**

---

## 4. Hard constraints (non-negotiable)

- **No basic auth storage for Gmail/Outlook.** Both providers deprecated basic auth in 2026. OAuth only for Google and Microsoft.
- **Warmup emails must never appear in the pool member's real inbox.** All warmup traffic auto-filed to a hidden "WarmupHub" folder. Pool members must not see warmup emails as real correspondence.
- **No email content stored beyond 7 days.** Privacy requirement. AI-generated warmup bodies purged after 7 days.
- **Pool participation is opt-in and explicit.** Every user consents to their inbox participating in the pool at connection time. No silent enrollment.
- **Bounce rate auto-pause.** If any inbox exceeds 3% bounce rate in a 24-hour period, warmup pauses automatically. No exceptions.
- **Reuse dmphub GCP infrastructure.** Cloud SQL instance, Memorystore, Cloud Run region (asia-south1). No new GCP projects for Phase 1.

---

## 5. Phased scope

### Phase 1 — MVP (target: 8 weeks from build start)

**What is in:**
- Gmail + Outlook OAuth inbox connection
- Custom SMTP/IMAP connection (other providers)
- Warmup engine: peer-to-peer network, AI-generated content, positive engagement simulation (open / star / reply / rescue from spam)
- Warmup ramp curve (slow / medium / fast) with configurable daily volume
- DNS health monitoring: SPF, DKIM, DMARC, MX, rDNS — daily checks with plain-English fix instructions
- Blacklist monitoring: 100+ RBLs, every 6 hours, email + Slack webhook alerts
- Inbox placement test: weekly seed-list test with Primary / Promotions / Spam breakdown per provider
- Spam diagnostics: when placement fails, AI identifies specific causes and fix steps
- Reputation score 0–100 with 90-day trajectory graph
- Post-warmup readiness report: safe sending volume, recommended send window, watch signals
- Maintenance warmup mode (5–10 emails/day post-completion)
- Stripe billing: Starter ($19/mo, 3 inboxes) + Growth ($49/mo, 20 inboxes)
- Dashboard: per-inbox health, score history, DNS status, placement results

**What is NOT in Phase 1:**
- Agency tier (multi-client workspace, white-label, bulk import) — Phase 2
- API / webhook access — Phase 2
- PDF report generation — Phase 2
- BIMI check — Phase 2
- Reputation event timeline with user annotations — Phase 2
- White-label dashboard — Phase 2

### Phase 2 — Agency Layer (target: 12 weeks after Phase 1 launch)

- Agency tier ($149/mo, 100 inboxes)
- Multi-client workspace with separate client accounts
- Bulk inbox import (CSV)
- White-label dashboard + custom domain
- Client-facing read-only portal
- PDF health report generation (branded)
- Team member access (up to 10 seats)
- Slack + webhook notifications

### Phase 3 — API + Enterprise (Month 5+)

- Full REST API + webhooks
- Headless/embedded mode
- Dedicated IP pools per enterprise client
- SSO (SAML/OIDC)
- Audit logs
- Custom ramp curves via API
- SLA + enterprise contracts

---

## 6. Success metrics

### Phase 1 success metrics

| Metric | Target | How measured |
|---|---|---|
| Inbox placement improvement | ≥ 30 percentage points lift from baseline to week 4 | Weekly placement test results in DB |
| Reputation score at warmup completion | ≥ 80/100 | Composite score at graduation event |
| Time to first warmup email sent | < 5 minutes from signup | Server-side event: `warmup.first_send` timestamp minus `user.created_at` |
| Bounce rate across pool | < 0.5% platform-wide | Bounce events / total sends in analytics |
| User-reported deliverability improvement | ≥ 80% of surveyed users | 30-day post-signup in-app survey |
| MRR at Phase 1 close | $2,000+ | Stripe MRR dashboard |

### Phase 2 success metrics

| Metric | Target |
|---|---|
| Agency accounts with 10+ inboxes | 10+ paying agencies |
| Inbox count per agency account | Average ≥ 25 |
| Churn rate | < 5% monthly |

---

## 7. User stories (Phase 1)

### Onboarding
- As a solo outreacher, I want to connect my Gmail account in under 2 minutes so I can start warming immediately.
- As a user, I want to see exactly what's wrong with my DNS configuration so I know what to fix before my warmup begins.
- As a user, I want to choose my warmup speed so I can balance safety with urgency.

### Warmup
- As a user, I want to see my reputation score improve over time so I know the warmup is working.
- As a user, I want to be alerted immediately if my domain hits a blacklist so I can act fast.
- As a user, I want to know if my emails are landing in Promotions vs Primary, not just "inbox."

### Diagnostics
- As a user whose emails are going to spam, I want to know the specific reason — not just the outcome.
- As a user who finished warmup, I want a clear recommendation of how many emails I can safely send per day.

### Billing
- As a user, I want a 7-day free trial with no credit card required so I can verify it works before paying.
- As a user, I want to upgrade my plan without losing my warmup progress.
