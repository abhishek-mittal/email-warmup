# Service Spec: Warmup Engine

**Tasks covered:** T008, T009, T010  
**Primary skill file:** docs/05-agent-skills/04-skill-warmup-engine.md

---

## Service contracts

### WarmupService
```
scheduleAllInboxes() → void
  Cron: daily at 05:00 UTC
  For each inbox WHERE status = 'active': compute daily volume, spread jobs across 08:00–18:00 user local time with ±15min jitter

scheduleInbox(inboxId) → void
  Enqueue today's warmup-send jobs for a single inbox

pauseInbox(inboxId) → void
  Drain pending jobs, set status = 'paused'

resumeInbox(inboxId) → void
  Set status = 'active', re-enqueue today's remaining jobs

checkGraduation(inboxId) → boolean
  slow: warmupDay >= 56 AND avg score >= 70 last 7 days AND spamPct <= 5%
  medium: warmupDay >= 35 AND avg score >= 70 last 7 days AND spamPct <= 5%
  fast: warmupDay >= 21 AND avg score >= 70 last 7 days AND spamPct <= 5%
```

### RampService
```
getDailyVolume(speed, warmupDay) → integer
  Waypoints:
    slow:   day 1=2, day 14=8, day 28=20, day 42=40, day 56=80
    medium: day 1=3, day 7=10, day 14=25, day 21=50, day 35=100
    fast:   day 1=5, day 5=15, day 10=40, day 15=80, day 21=150
  Interpolate linearly between waypoints. Cap at 200.
```

### PairingService
```
selectPartner(senderInboxId) → PoolMember | null
  Query: pool_members WHERE active=true AND quarantined=false
         AND domain != sender.domain
         AND id != sender.pool_member_id
  Score: base = candidate.reputation
         + 20 if different provider
         + 10 if same industry
         - 15 if paired in last 7 days
  Return highest score. Return null if no valid partner found.
```

---

## Queue definitions

| Queue | Concurrency | Rate limit |
|---|---|---|
| warmup-send | 50 | 100 jobs/second |
| warmup-receive | 50 | 100 jobs/second |

Job retention: completed jobs kept 24 hours. Failed jobs kept 72 hours for debugging.

---

## Warmup-send job payload
```json
{
  "senderInboxId": "uuid",
  "partnerInboxId": "uuid",
  "warmupDay": 5,
  "scheduledAt": "2026-06-20T09:47:00.000Z"
}
```

## Warmup-receive job payload
```json
{
  "receiverInboxId": "uuid",
  "messageId": "<unique@emailwarm.io>",
  "warmupDay": 5,
  "actions": ["open", "star", "reply"],
  "executeAt": "2026-06-20T10:22:00.000Z"
}
```

---

## Graduation criteria
When `checkGraduation()` returns true:
1. Set inbox status = 'graduated'
2. Set `graduated_at` timestamp
3. Remove from pool (set pool_member.active = false)
4. Generate readiness report (DiagnosticsService)
5. Send 'warmup_complete' notification

---

## Acceptance criteria (applies to T008, T009, T010)

- [ ] Active inbox receives warmup-send jobs with ±15 min jitter from scheduled time
- [ ] No two jobs from the same sender land within 8 minutes of each other
- [ ] Pairing never produces same-domain pairs (verified by query constraint, not just check)
- [ ] Receive processor opens, stars, replies, and files to WarmupHub in the correct order
- [ ] Daily volume on day 7 (medium speed) equals 10 ± interpolation rounding
- [ ] Graduation triggers readiness report and 'warmup_complete' notification
- [ ] Paused inbox drains all pending jobs within 60 seconds of pauseInbox() call
