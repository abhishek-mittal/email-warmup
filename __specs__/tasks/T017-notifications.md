# T017 — Notification Dispatch

**Wave:** 5  
**Depends on:** T004 (user data), T003 (queue)  
**Skills to load:** docs/05-agent-skills/05-skill-monitoring.md (alert section)

---

## What to build

The BullMQ processor that delivers notifications via email (all plans) and Slack (Growth+ plans).

### NotifyModule (`notify/`)

**NotifyProcessor** (`notify/notify.processor.ts`)

Process a job from the `notify` queue:

Job payload:
```
{ userId, inboxId?, type, channel, payload }
```

For channel `email`:
- Load user email from DB
- Select email template based on `type`
- Send via Nodemailer using platform SMTP (not the user's inbox — use `PLATFORM_SMTP_*` env vars)
- Use HTML email templates (inline styles only — no external CSS)

For channel `slack`:
- Load user's `slack_webhook_url` from DB
- POST JSON message to Slack webhook URL
- Use Slack Block Kit format for rich message

### Email templates to build

| Type | Subject | Key content |
|---|---|---|
| `dns_broken` | "⚠️ DNS issue detected on {email}" | Which records are broken + fix links |
| `blacklist_hit` | "🚨 {email} is blacklisted" | Which RBLs + delisting instructions |
| `score_drop` | "📉 Reputation score dropped for {email}" | Previous vs current score + diagnostics link |
| `token_revoked` | "🔑 Inbox disconnected: {email}" | Reconnect instructions |
| `warmup_complete` | "🎉 {email} warmup complete!" | Readiness report summary + recommended volume |
| `trial_expired` | "Your 7-day trial has ended" | Upgrade CTA with pricing |
| `plan_activated` | "Welcome to {plan} plan!" | Plan features summary |
| `payment_failed` | "Payment failed — action required" | Update payment method link |

### Slack message format

Use Block Kit with:
- Header block: alert type icon + title
- Section block: inbox email + key metric
- Context block: timestamp + link to dashboard
- Actions block (for critical alerts): "View dashboard" button

### Platform SMTP configuration

```
PLATFORM_SMTP_HOST=smtp.gmail.com  (or SendGrid / AWS SES for prod)
PLATFORM_SMTP_PORT=587
PLATFORM_SMTP_USER=noreply@emailwarm.io
PLATFORM_SMTP_PASS=...             (encrypted, from Secret Manager)
PLATFORM_FROM_EMAIL=EmailWarm <noreply@emailwarm.io>
```

---

## Acceptance criteria

- [ ] `dns_broken` email received within 60 seconds of notify job enqueue
- [ ] `blacklist_hit` email includes the specific RBL names that listed the domain
- [ ] `warmup_complete` email includes recommended send volume number
- [ ] Slack notification fires for Growth+ users when `slack_webhook_url` is set
- [ ] Trial/Starter users do NOT receive Slack notifications (plan gate enforced)
- [ ] Email templates render correctly with inline styles (test in Gmail + Outlook)
- [ ] `payment_failed` notification includes a working link to update payment method
- [ ] Failed notification (SMTP error) retried up to 3 times before marking failed

## Mark done in SPEC-STATUS.md when all criteria above are verified
