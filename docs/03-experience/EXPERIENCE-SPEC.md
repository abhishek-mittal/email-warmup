# EmailWarm — Experience Specification

**Version:** 0.1  
**Date:** June 2026

---

## 1. Design principles

1. **Explain, don't just score.** Every number shown has a plain-English reason beneath it. Users who don't know what DKIM is must still understand what to do.
2. **Warmup emails are invisible.** Users should never encounter warmup traffic in their real inbox. All warmup emails live in a hidden folder.
3. **Alerts are actionable.** Every alert includes a specific next step. Never just "something went wrong."
4. **Progress is visible from day 1.** Even on Day 1, show the trajectory. Show "this is normal" messaging to prevent premature panic.
5. **Mobile is secondary.** Dashboard is desktop-first. Mobile gets a simplified score view only.

---

## 2. Onboarding flow

### Step 1 — Sign up
- Email/password OR Google OAuth (for account login — not inbox connection)
- Email verification required before proceeding
- No credit card on signup — 7-day free trial starts immediately

### Step 2 — 3-question profile wizard
```
Q1: What industry are you in?
    [ SaaS ] [ Agency ] [ Finance ] [ Legal ] [ E-commerce ] [ Other ]

Q2: What are you trying to do?
    [ Warm up a new domain ] [ Recover a damaged domain ] [ Maintain an existing inbox ]

Q3: How many inboxes do you need to warm?
    [ 1–3 ] [ 4–10 ] [ 11–50 ] [ 50+ ]
```
Answers: industry tag stored, goal stored (affects messaging), inbox count → plan recommendation shown immediately after.

### Step 3 — Plan selection (skip-able, returns to this after trial)
Show recommended plan based on inbox count answer. Trial starts on any plan.

### Step 4 — Connect first inbox
Large CTA: "Connect your first inbox to start warming."
Three options:
- **Connect Gmail** → Google OAuth consent screen
- **Connect Outlook** → Microsoft OAuth consent screen  
- **Custom SMTP/IMAP** → form with host/port/credentials

After connection: system runs pre-check immediately (< 30 seconds). Show spinner with "Checking your inbox health…"

### Step 5 — Pre-check results screen
Show punch list of DNS findings:
```
✅ SPF record — valid
✅ DKIM — valid  
⚠️  DMARC — policy is p=none (not enforced)
    → Recommendation: change to p=quarantine for better trust
✅ MX records — correct
✅ Not on any blacklist

Your inbox is ready to start warming.
```
If critical issues (no DKIM, active blacklist): show blocker screen with fix instructions. Do not start warmup until user dismisses.

### Step 6 — Warmup speed selection
```
[ Slow — 6–8 weeks ]      Best for brand new domains
[ Medium — 4–5 weeks ]    Standard for most users       ← default
[ Fast — 2–3 weeks ]      Only if your domain has history
```
Show estimated completion date based on selection.

### Step 7 — Pool consent
```
To warm your inbox, we send emails between real inboxes in our network.
Your inbox will both send and receive warmup emails.

✓ All warmup emails are automatically hidden from your inbox
✓ You'll never see warmup traffic as real email
✓ You can withdraw from the pool at any time

[ ✓ I consent to inbox pool participation ]   [ Connect inbox ]
```
Consent is required. Cannot proceed without it.

### Step 8 — Dashboard (first view)
Warmup begins. Dashboard shows:
- Reputation score: **—** (Day 0 — building baseline)
- Status: **Warming · Day 1**
- "Your first warmup emails will send today between 09:00–18:00 your time."
- Baseline placement test running: "We're running your first placement test. Results in ~5 minutes."

---

## 3. Dashboard layout

### Main dashboard
```
┌─────────────────────────────────────────────────────────────────┐
│  EmailWarm                              [+ Add Inbox]  [Account] │
├──────────────┬──────────────────────────────────────────────────┤
│              │  Inbox: hello@yourdomain.com                     │
│  Inboxes     │  ─────────────────────────────────────────────   │
│  ─────────   │                                                   │
│  ● hello@    │  Reputation Score        Warmup Status           │
│    yourd...  │  ┌──────────────┐        ┌────────────────────┐  │
│              │  │     72       │        │  🔥 Warming        │  │
│  + Add       │  │   / 100      │        │  Day 18 of ~28    │  │
│    inbox     │  └──────────────┘        └────────────────────┘  │
│              │                                                   │
│              │  [Score History: 90-day graph]                   │
│              │                                                   │
│              │  ┌──────────────┬──────────────┬─────────────┐  │
│              │  │ DNS Health   │ Blacklists   │ Placement   │  │
│              │  │ ✅ 4/5 OK   │ ✅ Clean     │ 82% Primary │  │
│              │  │ ⚠️ DMARC    │ Checked 2h   │ 12% Promo   │  │
│              │  │ [View]       │ ago [View]   │ 6% Spam     │  │
│              │  └──────────────┴──────────────┴─────────────┘  │
│              │                                                   │
│              │  Today's Activity                                 │
│              │  Sent: 23 · Opened: 23 · Replied: 21             │
│              │  Rescued from spam: 2                             │
└──────────────┴──────────────────────────────────────────────────┘
```

### DNS health panel (expanded)
Shows each record with:
- Status icon (✅ / ⚠️ / ❌)
- Record type + current value
- Plain-English explanation of what it means
- Fix instruction if invalid

### Placement test panel (expanded)
Shows grid: rows = providers (Gmail, Outlook, Yahoo), columns = placement (Primary / Promotions / Spam / Missed).
Shows "Why Promotions matters" tooltip for users who don't know the distinction.

### Diagnostics panel (visible when spam_rate > 0)
Shows issue list with:
- Severity badge (CRITICAL / WARNING / INFO)
- Title ("SPF record uses softfail")
- Fix instruction ("Update your DNS SPF record to use `-all` instead of `~all`")
- AI-generated summary at top: "Your emails are landing in spam primarily because of your SPF configuration and domain age. Fixing SPF will likely move 40–60% of spam placements to inbox within 48 hours."

---

## 4. Key UX flows

### Flow: Blacklist alert
1. Blacklist check detects listing (Spamhaus SBL)
2. Warmup pauses automatically
3. User receives email: "⚠️ Your inbox was listed on Spamhaus SBL. Warmup has been paused. [View delisting steps]"
4. In-dashboard: amber banner "Your inbox is on a blacklist — warmup paused" with action button
5. Clicking action: shows step-by-step delisting instructions for that specific RBL
6. After user reports fix: system re-checks within 1 hour; on clean → warmup resumes, green success notification

### Flow: Score drop alert
1. Score drops > 10 points in 24 hours
2. Email notification: "Your reputation score dropped from 74 to 61. [See what happened]"
3. Dashboard: score card shows red border + "Score dropped 13 points — investigate"
4. Clicking: opens diagnostics panel with AI analysis of likely causes

### Flow: Warmup completion
1. System detects graduation criteria met (score ≥ 80 for 5 days, placement ≥ 85% primary, no blacklist)
2. Dashboard: "Warmup complete" banner with confetti moment
3. Email notification: "Your inbox is ready to send. Here's your readiness report."
4. Readiness report shows:
   - Final score + trajectory chart
   - Recommended safe daily volume (e.g., "Start at 30/day, scale 20% per week")
   - Best send window for your timezone
   - Signals to watch (bounce rate threshold, score floor)
   - Maintenance mode note: "We're keeping 5–10 warmup emails/day running to protect your score"
5. Inbox status badge changes: 🔥 Warming → ✅ Ready

### Flow: Token revoked
1. OAuth token refresh fails (user revoked access in Google/Microsoft account)
2. Warmup pauses immediately
3. Email within 1 hour: "Action required: your Gmail connection was revoked. [Reconnect now]"
4. Dashboard: red status badge "Connection lost — click to reconnect"
5. One-click reconnect via OAuth (no need to re-enter settings)

---

## 5. Alert system design

### Alert types and channels

| Alert type | Email | In-app | Slack webhook |
|---|---|---|---|
| Blacklist hit | ✅ immediate | ✅ banner | ✅ Growth+ |
| Score drop > 10 pts | ✅ same day | ✅ banner | ✅ Growth+ |
| DNS record broken | ✅ same day | ✅ banner | — |
| OAuth token revoked | ✅ within 1hr | ✅ banner | ✅ Growth+ |
| Warmup complete | ✅ | ✅ | — |
| Bounce rate > 3% | ✅ immediate | ✅ | ✅ Growth+ |
| Placement test complete | — | ✅ card update | — |

### Alert copy rules
- Always name the inbox: "Your inbox hello@yourdomain.com…"
- Always include a single clear next action
- Never use jargon without immediate plain-English translation
- Subject lines are specific: "⚠️ hello@yourdomain.com listed on Spamhaus — warmup paused"

---

## 6. Empty states

| Screen | Empty state message |
|---|---|
| Inbox list (no inboxes) | "Connect your first inbox to start warming. Takes 2 minutes." + CTA |
| Score history (day 0) | "Your score will appear here after your first 24 hours of warming." |
| Placement test (not run yet) | "Your first placement test is running. Results appear here in ~5 minutes." |
| Diagnostics (no issues) | "No issues found. Your inbox looks healthy." |
| Blacklist check (clean) | "No blacklist listings found. Checked 2 hours ago." |
