# EmailWarm — Coding Agent Context

Read this file at the start of every coding session. It tells you what this project is, what stack to use, and the non-negotiables that apply to every task.

---

## What this project is

EmailWarm is an email inbox warming SaaS. It runs a peer-to-peer warmup pool: inboxes in the pool send, open, reply, and rescue-from-spam for each other, building sender reputation over time.

**Phase 1 scope:** Gmail + Outlook OAuth connect, warmup engine, inbox placement testing, DNS + blacklist monitoring.

---

## Repository location

This project lives at:
`projects/email-warmup/` inside the shuhari monorepo
It is a **standalone sub-project** — do not import from or depend on the shuhari hub app.

---

## Stack

| Layer | Technology |
|---|---|
| Backend API | NestJS (TypeScript) |
| Database | PostgreSQL 16 (Drizzle ORM) |
| Queue | BullMQ + Redis |
| Email send | Nodemailer (raw SMTP) |
| IMAP | imapflow (connection pool) |
| Auth | Clerk (JWT RS256) |
| Billing | Stripe |
| AI content | Anthropic Claude API (claude-haiku-4-5) |
| Frontend | Next.js 15 App Router |
| Infra | GCP Cloud Run (asia-south1, project: sunny-ship-236913) |
| DB host | GCP Cloud SQL PostgreSQL 16 (new emailwarm DB in dmphub instance) |
| Redis host | GCP Memorystore (new DB index in dmphub instance) |
| Secrets | GCP Secret Manager |
| File storage | GCP Cloud Storage |

---

## Skill files — load before working on a domain

| Task area | Skill file to load |
|---|---|
| Schema / queries / migrations | docs/05-agent-skills/01-skill-database.md |
| Auth / Clerk guards / JWT | docs/05-agent-skills/02-skill-auth.md |
| Gmail/Outlook OAuth, IMAP, SMTP | docs/05-agent-skills/03-skill-inbox-connection.md |
| Warmup engine / BullMQ workers | docs/05-agent-skills/04-skill-warmup-engine.md |
| DNS + blacklist monitoring | docs/05-agent-skills/05-skill-monitoring.md |
| Placement testing | docs/05-agent-skills/06-skill-placement-test.md |
| AI diagnostics + readiness report | docs/05-agent-skills/07-skill-diagnostics.md |
| Reputation scoring | docs/05-agent-skills/08-skill-scoring.md |
| Stripe billing | docs/05-agent-skills/09-skill-billing.md |
| Next.js frontend | docs/05-agent-skills/10-skill-frontend.md |

**Always read the relevant skill file(s) before writing any code for that domain.**

---

## Spec files — your acceptance criteria

All atomic task specs live in __specs__/tasks/. Find your task, read it, and implement against its acceptance criteria.

Track status in __specs__/SPEC-STATUS.md — update the task row when you start and when you finish.

---

## Non-negotiables (no exceptions)

1. **Never store plaintext credentials.** OAuth tokens and SMTP passwords always encrypted with AES-256-GCM before DB write. Key from GCP Secret Manager via env var ENCRYPTION_KEY.

2. **Never skip SVIX or Stripe signature verification.** Both webhook endpoints must verify signatures before processing any event.

3. **Never send from an inbox with status != 'active'.** Check status before every warmup send job.

4. **Always jitter warmup send times.** No job may fire at the exact scheduled time. +-15-30 min random offset required.

5. **Never pair two inboxes on the same domain.** The pairing algorithm must hard-block same-domain pairs.

6. **Never file warmup emails in the user's real inbox.** All warmup traffic auto-filed to WarmupHub label/folder on receipt.

7. **Never purge warmup email bodies inline.** Body purge is handled by a scheduled purge job — 7-day retention enforced there, not in processors.

8. **Never open a new IMAP connection per action.** Use the imapflow connection pool.

9. **Pool consent check before enrollment.** pool_consent_at must be non-null before enrolling any inbox in the pool.

10. **Migrations are append-only.** Never edit existing Drizzle migration files — generate a new one.

---

## Running the project

```bash
cd projects/email-warmup

# Backend (NestJS)
cd backend
npm install
npm run db:migrate      # apply DB migrations
npm run start:dev       # NestJS dev server on :4611

# Frontend (Next.js)
cd frontend
npm install
npm run dev             # Next.js on :3000
```

---

## Environment

See .env.example in the project root. Key variables:
- DATABASE_URL — GCP Cloud SQL PostgreSQL 16 connection string
- REDIS_URL — GCP Memorystore Redis connection string
- ENCRYPTION_KEY — 32-byte hex key from GCP Secret Manager
- CLERK_SECRET_KEY, CLERK_WEBHOOK_SECRET
- STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
- ANTHROPIC_API_KEY
- GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
- MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET
