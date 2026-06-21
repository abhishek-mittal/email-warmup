# T012 — Blacklist Check Processor

**Wave:** 3  
**Depends on:** T002, T003  
**Skills to load:** docs/05-agent-skills/05-skill-monitoring.md  
**Service spec:** __specs__/services/monitoring.md

---

## What to build

The BullMQ processor that checks the inbox domain against 100+ RBLs every 6 hours, pauses warmup immediately on any listing, and triggers diagnostics.

### BlacklistCheckProcessor (`monitor/blacklist-check.processor.ts`)

Process a job from the `blacklist-check` queue:

1. Load inbox record, extract domain
2. Run DNS A-record lookup for `{domain}.{rbl-zone}` against all RBLs in parallel via `Promise.allSettled`
   - Result `127.0.0.x` → listed
   - NXDOMAIN → clean
   - Timeout/error → treat as unknown (not listed, not clean — log warning)
3. Collect listed RBLs
4. Write result to `blacklist_checks` table with:
   - `is_clean`: boolean
   - `listed_count`: integer
   - `rbl_results`: JSONB map of `{ rblName: 'clean'|'listed'|'unknown' }`
5. If any listing found:
   a. `warmupService.pauseInbox(inboxId)` ← MUST happen BEFORE alert
   b. Enqueue `notify` job (type `blacklist_hit`, payload includes `listed` array)
   c. Enqueue `diagnostics` job (trigger `auto_blacklist`)
6. Enqueue `score-compute` job

### BlacklistService (`monitor/blacklist.service.ts`)

- Load RBL list from config file: `monitor/rbl-list.ts` (export as string array)
- Minimum 8 RBLs from service spec must be included
- DNS lookup timeout: 5 seconds per RBL (use Promise.race with timeout)
- Parallel lookup via `Promise.allSettled` — never block on one slow RBL

### Schedule

- Cron: every 6 hours (00:00, 06:00, 12:00, 18:00 UTC)
- Enqueue one `blacklist-check` job per active inbox per run

---

## Acceptance criteria

- [ ] All 8 minimum RBLs from service spec are queried on every check
- [ ] `blacklist_checks` row written with `is_clean`, `listed_count`, and `rbl_results` JSONB
- [ ] Warmup paused (`status='paused'`) BEFORE blacklist alert notification is sent
- [ ] `notify` job enqueued with `blacklist_hit` type and array of listed RBL names
- [ ] `score-compute` job enqueued after check
- [ ] Slow RBL (> 5s response) times out and is treated as 'unknown' — does not block the entire check
- [ ] Spamhaus listing results in score = 0 for blacklist component (verified in scoring T013)
- [ ] Check does not run more than 4 times per 24 hours per inbox (schedule enforcement)

## Mark done in SPEC-STATUS.md when all criteria above are verified
