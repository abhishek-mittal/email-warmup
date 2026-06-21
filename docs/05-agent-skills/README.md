# EmailWarm — Agent Skills Index

Skill files tell coding agents exactly how to work within each technical domain. Load the relevant skill file(s) before starting any task.

---

## Skill map

| Skill file | Domain | Load when... |
|---|---|---|
| [01-skill-database.md](01-skill-database.md) | Database / Drizzle ORM | Working on schema, migrations, queries |
| [02-skill-auth.md](02-skill-auth.md) | Auth / Clerk | Working on auth guards, user sync, JWT |
| [03-skill-inbox-connection.md](03-skill-inbox-connection.md) | Inbox OAuth + SMTP/IMAP | Working on inbox connect, token refresh, imapflow |
| [04-skill-warmup-engine.md](04-skill-warmup-engine.md) | Warmup scheduler + BullMQ | Working on send/receive workers, ramp curve, pairing |
| [05-skill-monitoring.md](05-skill-monitoring.md) | DNS + Blacklist monitoring | Working on DNS checks, RBL checks, alert dispatch |
| [06-skill-placement-test.md](06-skill-placement-test.md) | Inbox placement testing | Working on seed list, placement analysis, Promotions detection |
| [07-skill-diagnostics.md](07-skill-diagnostics.md) | AI diagnostics | Working on spam cause analysis, readiness report |
| [08-skill-scoring.md](08-skill-scoring.md) | Reputation scoring | Working on score computation, history, trends |
| [09-skill-billing.md](09-skill-billing.md) | Stripe billing | Working on plans, webhooks, entitlements |
| [10-skill-frontend.md](10-skill-frontend.md) | Next.js 15 frontend | Working on dashboard, components, data fetching |

---

## Non-negotiables (apply to all skills)

- **Never store plaintext credentials.** OAuth tokens + SMTP passwords always AES-256 encrypted before DB write. Key from GCP Secret Manager.
- **Never email content past 7 days.** AI-generated warmup email bodies are purged from DB at 7 days.
- **Never skip pool consent check.** Before enrolling any inbox in the pool, verify `pool_consent_at` is non-null.
- **Never fill warmup emails to user's real inbox.** All warmup traffic must be auto-filed to "WarmupHub" label/folder on arrival.
- **Always jitter send times.** No warmup send may execute at the exact scheduled time. ±15–30 min random offset is mandatory.
