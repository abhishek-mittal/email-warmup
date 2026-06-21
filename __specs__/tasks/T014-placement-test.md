# T014 — Placement Test Processor

**Wave:** 4  
**Depends on:** T008 (for SMTP send pattern), T011 (for IMAP pattern)  
**Skills to load:** docs/05-agent-skills/06-skill-placement-test.md, docs/05-agent-skills/03-skill-inbox-connection.md  
**Service spec:** __specs__/services/placement-test.md

---

## What to build

The full inbox placement testing system: seed list management, test email send, Gmail tab detection, Outlook folder detection, result aggregation, and score update.

### PlacementModule (`placement/`)

**SeedListService** (`placement/seed-list.service.ts`)
- `getSeedAddresses(type)` — returns 10 (quick) or 35 (full) seed addresses from DB
- Seed inboxes are platform-controlled accounts stored in a `seed_inboxes` table (add this table to schema via migration)
- Seed inboxes have their own encrypted IMAP credentials

**PlacementService** (`placement/placement.service.ts`)
- `runTest(inboxId, userId)`:
  1. `assertTestQuota(userId, plan)` — quota per month
  2. Select seed list by plan
  3. Generate unique tracking subject: `[PT-{testId}] {random phrase}`
  4. Send to all seeds via inbox's SMTP
  5. Insert `placement_tests` row with `status='pending'`
  6. Enqueue `placement-test` job with `sentAt = now()`
  7. Return `{ testId, estimatedReadyAt: now + 10min }`

**PlacementTestProcessor** (`placement/placement-test.processor.ts`)
- Process job: wait until `sentAt + 5min`, then check all seed inboxes in parallel
- For each seed:
  - Gmail: get IMAP connection, use X-GM-LABELS to detect tab
  - Outlook: check INBOX then Junk Email folder
  - Record: 'primary', 'promotions', 'spam', 'other', 'missing'
- Aggregate counts and percentages
- Compute `placement_score`
- Update `placement_tests` row with results
- Enqueue `score-compute` job

---

## Acceptance criteria

- [ ] `POST /inboxes/:id/placement-test` returns `testId` and `estimatedReadyAt` immediately
- [ ] Results available via `GET /inboxes/:id/placement-test/:testId` within 10 minutes
- [ ] Gmail Promotions tab correctly detected via `\Category_Promotions` label
- [ ] Gmail Primary correctly identified (in INBOX without Promotions/Social label)
- [ ] Outlook Junk Email correctly classified as 'spam'
- [ ] `placement_score` computed correctly: 100% Primary → 100, 100% Promotions → 50
- [ ] Monthly quota enforced: Starter plan's second test in a month returns 429
- [ ] `score-compute` job enqueued after test completes
- [ ] `placement_tests` row updated with primaryPct, promotionsPct, spamPct, placementScore

## Mark done in SPEC-STATUS.md when all criteria above are verified
