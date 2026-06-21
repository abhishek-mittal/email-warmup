# Skill: Warmup Engine

**Domain:** Warmup scheduler, BullMQ workers, send/receive simulation  
**Load when:** Working on WarmupModule, warmup-send queue, warmup-receive queue, pairing algorithm, ramp curve

---

## Module structure

```
src/
├── warmup/
│   ├── warmup.module.ts
│   ├── warmup.service.ts          ← orchestrates daily scheduling
│   ├── warmup-send.processor.ts   ← BullMQ processor for warmup-send queue
│   ├── warmup-receive.processor.ts← BullMQ processor for warmup-receive queue
│   ├── pairing.service.ts         ← selects pool partner for each send
│   ├── ramp.service.ts            ← computes daily volume from curve
│   └── content.service.ts         ← calls Claude API for email content
```

---

## Public API

```typescript
// WarmupService
scheduleAllInboxes(): Promise<void>  // called by daily cron — enqueues send jobs for all active inboxes
scheduleInbox(inboxId: string): Promise<void>  // enqueue today's jobs for one inbox
pauseInbox(inboxId: string): Promise<void>     // drain + remove pending jobs, set status=paused
resumeInbox(inboxId: string): Promise<void>    // re-enqueue, set status=active
checkGraduation(inboxId: string): Promise<boolean> // evaluate graduation criteria

// RampService
getDailyVolume(speed: WarmupSpeed, warmupDay: number): number

// PairingService
selectPartner(senderInboxId: string): Promise<PoolMember | null>

// ContentService
generateEmail(prompt: WarmupEmailPrompt): Promise<WarmupEmail>
generateReply(original: WarmupEmail, prompt: WarmupEmailPrompt): Promise<WarmupEmail>
```

---

## Key algorithms

### Daily schedule loop
```
1. Cron fires at 05:00 UTC daily
2. Query all inboxes WHERE status = 'active'
3. For each inbox:
   a. volume = getDailyVolume(inbox.warmupSpeed, inbox.warmupDay)
   b. Spread `volume` send jobs across 08:00–18:00 user local time
   c. Each job time = base_time + random(−15min, +15min)  ← MANDATORY JITTER
   d. Add each job to `warmup-send` queue with delay
4. Increment inbox.warmup_day by 1
```

### Pairing algorithm (PairingService.selectPartner)
```
1. SELECT candidates from pool_members WHERE:
   - active = true AND quarantined = false
   - domain != sender.domain                     ← HARD BLOCK
   - id != sender.pool_member_id                 ← HARD BLOCK
2. Score each candidate:
   score = candidate.reputation
   if candidate.provider != sender.provider: score += 20   ← cross-provider bonus
   if candidate.industry == sender.industry: score += 10   ← niche bonus
   if candidate was paired with sender in last 7 days: score -= 15
3. Select candidate with highest score
4. Record pairing in warmup_sends table
```

### Warmup-receive processor (engagement simulation)
```
Job received: { receiverInboxId, messageId, actions }
Delay: 2–240 minutes randomly after send (set when job is enqueued)

For each action in job.actions:
  "open":   IMAP FETCH + mark \Seen flag
  "star":   IMAP STORE + \Flagged flag (Gmail: add "Starred" label)
  "rescue": IMAP MOVE from [Gmail]/Spam to INBOX (if landed in spam)
  "reply":  Generate reply body via ContentService → send via SMTP

After all actions:
  Auto-file to "WarmupHub" folder/label via IMAP MOVE
  Update warmup_sends record with timestamps
```

---

## Performance targets

- Daily schedule loop must complete in < 60 seconds for 10,000 active inboxes
- Pairing query must return in < 100ms (index on `pool_members.domain`, `pool_members.provider`)
- Content generation (Claude API) must have a 10-second timeout with fallback to template pool
- IMAP actions must use connection pooling — do not open a new IMAP connection per action

---

## What you never do

- **Never send from an inbox with `status != 'active'`**
- **Never skip the ±15min jitter on send times**
- **Never pair two inboxes from the same domain**
- **Never store AI-generated email body in DB after 7 days** — schedule purge job on insert
- **Never file warmup emails in user's real INBOX** — always move to WarmupHub folder
- **Never exceed the ramp curve volume for the day** — if pairing fails, skip sends rather than queuing extras
