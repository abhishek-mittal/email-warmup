# T010 — Daily Schedule + Ramp Curve + Graduation

**Wave:** 2  
**Depends on:** T008, T009  
**Skills to load:** docs/05-agent-skills/04-skill-warmup-engine.md  
**Service spec:** __specs__/services/warmup-engine.md

---

## What to build

The daily cron job that computes how many warmup sends each inbox should do today, spreads jobs across business hours with jitter, and checks for graduation.

### WarmupService (`warmup/warmup.service.ts`)

**`scheduleAllInboxes()`** — called by daily cron at 05:00 UTC
1. Query all inboxes WHERE `status = 'active'`
2. For each inbox:
   a. `volume = getDailyVolume(inbox.warmupSpeed, inbox.warmupDay)`
   b. Spread `volume` jobs across 08:00–18:00 user local time (or UTC if timezone unknown)
   c. Each job time = base slot + `random(-900, 900)` seconds (±15 min jitter)
   d. No two jobs from same sender within 8 minutes of each other
   e. Call `selectPartner()` for each job — if no partner found, skip that send slot
   f. Enqueue each job to `warmup-send` queue with calculated delay
3. After enqueuing: `inbox.warmup_day += 1`
4. Call `checkGraduation(inbox.id)` for any inbox at or past minimum graduation day
5. Target: entire loop completes in < 60 seconds for 10,000 active inboxes

**`getDailyVolume(speed, warmupDay)`** — RampService
- Interpolate linearly between waypoints (see service spec)
- Clamp output to max 200

**`checkGraduation(inboxId)`**
- Criteria (all must be true):
  - `warmupDay >= minDays[speed]` (slow=56, medium=35, fast=21)
  - Average `reputation_scores.score` over last 7 days >= 70
  - Latest placement test `spam_pct <= 5%` (or no placement test yet = skip this criterion)
- If criteria met:
  1. Set `status = 'graduated'`, `graduated_at = now()`
  2. Set `pool_members.active = false` for this inbox
  3. Enqueue `score-compute` job
  4. Trigger `readiness-report` generation via DiagnosticsService
  5. Enqueue `notify` job with type `warmup_complete`

### Pool enrollment

When a new inbox is first activated (pre-check passes):
- Insert row into `pool_members` with `active=true`, `reputation=50` (neutral start)
- `pool_consent_at` must be set — no enrollment without it

---

## Acceptance criteria

- [ ] Cron fires daily at 05:00 UTC (verify with NestJS `@Cron` decorator)
- [ ] Active inbox on day 7 (medium speed) receives exactly 10 warmup-send jobs (±1 for rounding)
- [ ] No two jobs from the same sender scheduled within 8 minutes of each other
- [ ] All jobs have ±15 min jitter applied (no job fires at exact base time)
- [ ] `warmup_day` increments by 1 after each scheduling run
- [ ] Graduation triggers `status='graduated'` and `graduated_at` timestamp
- [ ] Readiness report generation triggered on graduation
- [ ] `warmup_complete` notification enqueued on graduation
- [ ] Inbox with no valid pairing partner skips send slots (no orphaned jobs)

## Mark done in SPEC-STATUS.md when all criteria above are verified
