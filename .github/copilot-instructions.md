# GitHub Copilot Instructions — EmailWarm

You are working on EmailWarm, a peer-to-peer email inbox warming SaaS.

## Project context
- Backend: NestJS + Drizzle ORM + BullMQ + PostgreSQL 16 + Redis
- Frontend: Next.js 15 App Router + Clerk
- Auth: Clerk (JWT RS256 validation via ClerkGuard)
- Queue: BullMQ — every async operation goes through a queue, never executed inline
- IMAP: imapflow with connection pooling — never open a raw IMAP connection per-action
- Email send: Nodemailer raw SMTP — no ESP abstraction

## Always do
- Load the relevant skill file from docs/05-agent-skills/ before implementing any domain
- Check __specs__/tasks/ for the atomic task spec before writing code
- Encrypt all OAuth tokens and SMTP passwords with AES-256-GCM before DB write
- Add ±15 min random jitter to every warmup send job time
- Verify webhook signatures (SVIX for Clerk, stripe.webhooks.constructEvent for Stripe) before processing

## Never do
- Store credentials in plaintext
- Open a new IMAP connection per action — use the pool
- Pair warmup inboxes from the same domain
- Send from an inbox with status != 'active'
- File warmup emails to the user's real inbox — always WarmupHub folder
- Edit existing Drizzle migration files — generate a new one
- Make direct DB calls from Next.js routes — proxy to NestJS API
- Show placement Promotions and Spam as equivalent outcomes — they differ in score impact

## Key domain modules
- InboxModule — OAuth connect, token management, IMAP pool
- WarmupModule — daily scheduler, pairing, send/receive simulation
- MonitorModule — DNS checks, RBL blacklist checks, alerts
- PlacementModule — seed list management, Gmail tab detection, placement analysis
- ScoringModule — composite 0–100 score (DNS 30 + blacklist 30 + placement 40)
- DiagnosticsModule — AI cause analysis via Claude API, readiness report
- BillingModule — Stripe checkout, webhooks, plan entitlements, trial expiry

## Score formula reminder
score = DNS_score (0–30) + blacklist_score (0–30) + placement_score (0–40)
Placement: Primary=100%, Promotions=50%, Spam/Missing=0%

## Infrastructure
GCP project: sunny-ship-236913, region: asia-south1
Cloud Run for both backend and frontend
Cloud SQL PostgreSQL 16 (emailwarm DB in existing dmphub instance)
Memorystore Redis (new DB index in existing dmphub instance)
