# T008 — Warmup Send Processor

**Wave:** 2  
**Depends on:** T005, T006, T007 (at least one inbox connect method)  
**Skills to load:** docs/05-agent-skills/04-skill-warmup-engine.md, docs/05-agent-skills/03-skill-inbox-connection.md  
**Service spec:** __specs__/services/warmup-engine.md

---

## What to build

The BullMQ processor that executes each warmup send job: picks the right SMTP credentials, generates email content via Claude API, sends via Nodemailer, and records the outcome.

### WarmupSendProcessor (`warmup/warmup-send.processor.ts`)

Process a job from the `warmup-send` queue:

1. Load sender inbox (decrypt SMTP credentials)
2. Load receiver inbox (from pool_members)
3. Generate email content via `ContentService.generateEmail()` — Claude API, 10s timeout, fallback to template pool on timeout
4. Create Nodemailer transport for sender
5. Send email with:
   - `from`: sender email
   - `to`: receiver email
   - `subject`: AI-generated subject line
   - `Message-ID`: unique `<uuid@emailwarm.io>` header (for placement tracking)
   - `X-WarmupHub`: `true` header (for filtering on receive side)
   - `text` + `html` body (from ContentService)
6. Record in `warmup_sends`: messageId, bodyHash (sha256 of body), warmupDay, sentAt
7. Enqueue corresponding `warmup-receive` job on the receiver's queue with:
   - random delay: 2–240 minutes
   - actions array: `["open", "star"]` (always); add `"reply"` 60% of the time; add `"rescue"` only if previous send landed in spam

### ContentService (`warmup/content.service.ts`)

- `generateEmail(prompt)` → calls `claude-haiku-4-5`
- Prompt must request industry-aware content (use inbox.industry if set)
- Temperature-like variation: vary prompt slightly per call (not copy-paste identical emails)
- Fallback pool: 50 pre-written template emails for when Claude API times out
- Body purge: after inserting to warmup_sends, schedule a delayed job at `now + 7 days` to null out body data in that row

---

## Acceptance criteria

- [ ] Warmup email received in receiver's inbox within 5 minutes of job execution
- [ ] `Message-ID` header present and unique per send
- [ ] `X-WarmupHub: true` header present
- [ ] `warmup_sends` row created with correct `sender_inbox_id`, `receiver_inbox_id`, `sent_at`, `message_id`
- [ ] `body_hash` is SHA-256 hex — body text itself NOT stored in DB (or stored and purge job scheduled)
- [ ] `warmup-receive` job enqueued with 2–240 min random delay for the receiver
- [ ] Claude API timeout (>10s) falls back to template pool without failing the job
- [ ] Sending from an inbox with `status != 'active'` causes job to be discarded (not retried)

## Mark done in SPEC-STATUS.md when all criteria above are verified
