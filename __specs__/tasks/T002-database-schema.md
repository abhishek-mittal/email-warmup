# T002 — Database Schema + Migrations

**Wave:** 0  
**Depends on:** T001 (project scaffold must exist)  
**Skills to load:** docs/05-agent-skills/01-skill-database.md

---

## What to build

Define the complete Drizzle ORM schema for all 10 tables and generate the initial migration.

### Tables to define (in `backend/src/db/schema/`)

1. **users** — Clerk user ID as PK, email, plan, trial_ends_at, stripe IDs, slack_webhook_url
2. **inboxes** — inbox config, provider, all encrypted credential fields, warmup state, status
3. **pool_members** — pool enrollment record, domain, provider, industry, reputation, quarantined
4. **warmup_sends** — per-send record with all timestamp fields and engagement flags
5. **dns_checks** — SPF, DKIM, DMARC, MX, rDNS results per inbox per check
6. **blacklist_checks** — isClean, listedCount, rblResults (JSONB), per inbox per check
7. **placement_tests** — seed count, per-tab counts, percentages, placement score
8. **reputation_scores** — composite score, DNS/blacklist/placement components, trend
9. **diagnostics** — trigger type, issue codes (JSONB), AI analysis (JSONB), readiness report (JSONB)
10. **notifications** — type, channel, payload, sent_at, per user per inbox

### DB module

- `backend/src/db/index.ts` — exports `db` (drizzle instance with pool)
- Pool: max 20 connections, 30s idle timeout, 5s connection timeout
- All schema tables exported from `backend/src/db/schema/index.ts`

### Migration

- Run `drizzle-kit generate` to produce the initial migration file
- Migration file goes into `backend/src/db/migrations/`
- `npm run db:migrate` must apply cleanly to a fresh postgres database

### Indexes to create

- `pool_members`: index on `domain`, index on `provider`
- `warmup_sends`: index on `sender_inbox_id`, index on `created_at`
- `reputation_scores`: index on `inbox_id, recorded_at DESC`
- `placement_tests`: index on `inbox_id`

---

## Acceptance criteria

- [ ] `npm run db:migrate` runs to completion on a fresh `emailwarm` database with 0 errors
- [ ] All 10 tables exist in the DB after migration
- [ ] `db.select().from(users).limit(1)` executes without TypeScript error
- [ ] All `*Token`, `*Pass` columns are `text` type (encrypted strings — not bytea)
- [ ] `pool_members.domain` index exists (verify with `\d pool_members` in psql)
- [ ] `warmup_sends` table has all timestamp columns: scheduled_at, sent_at, opened_at, replied_at, starred_at, rescued_at, filed_at
- [ ] `reputation_scores` has dns_score, blacklist_score, placement_score as separate integer columns

## Mark done in SPEC-STATUS.md when all criteria above are verified
