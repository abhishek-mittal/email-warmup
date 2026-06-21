# EmailWarm — Go-to-Market Brief

**Version:** 0.1  
**Date:** June 2026

---

## 1. Positioning

**Category:** Email deliverability + inbox warmup  
**Target:** Cold outreach agencies and solo SDRs who are losing revenue to spam filters

**Primary headline:** "Warm 100 inboxes for $149. Not $2,500."  
**Secondary headline:** "The only warmup tool that tells you *why* you're in spam — not just that you are."

---

## 2. Pricing tiers

| Tier | Price | Inboxes | Key inclusions | Target buyer |
|---|---|---|---|---|
| **Starter** | $19/mo | 3 | Warmup engine, DNS monitoring, basic placement test (1/month), reputation score | Solo SDR, founder |
| **Growth** | $49/mo | 20 | Everything in Starter + daily DNS checks with fix instructions, placement test (5/month), Promotions vs Primary distinction, spam diagnostics, post-warmup readiness report, Slack alerts | Outreach consultant, small sales team |
| **Agency** | $149/mo | 100 | Everything in Growth + multi-client workspace, bulk CSV import, white-label dashboard, client portal, team seats (10), PDF reports | Cold outreach agency |
| **Enterprise** | Custom | Unlimited | Everything in Agency + API + webhooks + dedicated IP pool + SSO + SLA | ESP, platform, large enterprise |

**Trial:** 7 days free, no credit card, all Growth features unlocked.

---

## 3. Competitor pricing at scale (why we win)

| Tool | 10 inboxes | 50 inboxes | Our price |
|---|---|---|---|
| Warmy | ~$189/mo | ~$945/mo | $49/mo (Growth) |
| Mailreach | $250/mo | $1,250/mo | $49/mo (Growth) |
| Lemwarm | $290/mo | $1,450/mo | $49/mo (Growth) |
| Instantly | ~$30/mo (included) | ~$100/mo | $49/mo (Growth) |

At 50 inboxes: we are 95% cheaper than Warmy and Mailreach. At 100 inboxes: Agency tier at $149 vs $4,900+ on per-inbox tools.

---

## 4. Go-to-market channels

### Channel 1 — Cold outreach communities (primary)
- Slack: Instantly Community, Smartlead Community, Cold Email Wizards, #cold-email on various growth Slacks
- LinkedIn: content targeting "cold email agency" and "SDR deliverability" audiences
- Reddit: r/sales, r/Entrepreneur, r/Emailmarketing (educational content, not ads)
- Strategy: post deliverability how-to content, build trust, link to trial

### Channel 2 — AppSumo (launch play)
- Offer lifetime deal (e.g., 3 inboxes lifetime for $59) to bootstrap initial user base
- AppSumo users contribute their inboxes to the warmup pool → grows pool quality fast
- Use AppSumo community for early feedback and testimonials

### Channel 3 — Direct outreach to cold email agencies
- Identify agencies on LinkedIn / Google ("cold email agency", "B2B lead gen agency")
- Offer free Agency tier trial for 30 days in exchange for a case study
- Target: 10 agencies in first 60 days

### Channel 4 — Integration partnerships
- Cold email platforms that don't have built-in warmup (or have weak warmup): pitch them an embedded warmup module (Phase 2 API)
- Target: Lemlist, Outreach, Salesloft users who need a standalone warmup tool

---

## 5. Launch sequence

### Pre-launch (Weeks 1–2 before release)
- [ ] Set up waitlist landing page with headline pricing
- [ ] Post in 5 cold email communities: "building a flat-rate warmup tool — who wants early access?"
- [ ] Collect 200+ email signups on waitlist
- [ ] Bootstrap warmup pool: create 500 internal Google Workspace accounts, connect to pool

### Soft launch (Week 0)
- [ ] Invite waitlist to trial (batch of 50 users per day for first week)
- [ ] Monitor pool performance and warmup quality
- [ ] Fix any critical issues before wider launch

### Public launch (Week 2)
- [ ] AppSumo listing goes live (if chosen)
- [ ] LinkedIn announcement post
- [ ] Community posts in Instantly / Smartlead / Cold Email Wizards
- [ ] Product Hunt launch (secondary)

### 30-day goal
- 100 paid accounts (any tier)
- $1,500+ MRR
- 0 critical bugs in production
- Pool quality: < 0.5% bounce rate platform-wide

### 90-day goal
- 500 paid accounts
- $5,000+ MRR
- 5+ agency accounts on Agency tier
- First case study published (before/after deliverability data)

---

## 6. Key risks

| Risk | Mitigation |
|---|---|
| Pool too small at launch → poor warmup quality | Bootstrap 500 internal accounts. Don't accept more than 100 paying users until pool is 1,000+ strong |
| Google detects pool as bot network | Aggressive humanisation from day 1. Jitter, varied content, residential proxies for IMAP |
| Instantly copies flat-rate pricing | Build diagnostic depth and agency features. Price is table stakes; quality is the moat |
| User churn if warmup doesn't show results in week 2 | Set expectations at onboarding: show "normal warmup trajectory" graph on day 1 dashboard |
