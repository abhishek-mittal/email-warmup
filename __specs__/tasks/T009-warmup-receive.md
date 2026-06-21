# T009 — Warmup Receive Processor

**Wave:** 2  
**Depends on:** T008  
**Skills to load:** docs/05-agent-skills/04-skill-warmup-engine.md, docs/05-agent-skills/03-skill-inbox-connection.md  
**Service spec:** __specs__/services/warmup-engine.md

---

## What to build

The BullMQ processor that simulates human engagement on received warmup emails: open, star, optionally reply, rescue from spam if needed, and file to WarmupHub folder.

### WarmupReceiveProcessor (`warmup/warmup-receive.processor.ts`)

Job payload: `{ receiverInboxId, messageId, actions, executeAt }`

1. Wait until `executeAt` timestamp (delay calculated at job enqueue time)
2. Get IMAP connection from pool for receiver inbox
3. Search for message by `Message-ID` header across all folders
4. If found in Spam/Junk: execute `rescue` first (MOVE to INBOX), update `rescued_at`
5. For each action in `job.data.actions`:
   - `open`: IMAP FETCH the message, set `\Seen` flag; update `opened_at`
   - `star`: IMAP STORE `\Flagged` flag (Gmail: add `Starred` label); update `starred_at`
   - `reply`: generate reply body via `ContentService.generateReply()`, send via SMTP; update `replied_at`
6. MOVE message to `WarmupHub` folder/label; update `filed_at`
7. Update `warmup_sends` row with all timestamps
8. Update `landed_in_spam = true` if message was found in spam, `landed_in_tab` = detected Gmail tab

### Rescue logic
- Check `[Gmail]/Spam` (Gmail) or `Junk Email` (Outlook) before other actions
- If found in spam: move to INBOX first, then proceed with other actions
- Rescue only available when `"rescue"` is in `job.data.actions`

---

## Acceptance criteria

- [ ] Email marked as read (`\Seen`) after `open` action
- [ ] Email starred (`\Flagged`) after `star` action
- [ ] Reply sent and visible in original thread after `reply` action
- [ ] Email moved to `WarmupHub` folder/label as final action
- [ ] `warmup_sends.filed_at` set after WarmupHub move
- [ ] Email found in spam → `landed_in_spam = true` in DB
- [ ] Rescue moves email from Spam to INBOX before other actions proceed
- [ ] IMAP connection pool used — no new connection opened per action (verify with connection pool log)
- [ ] Job processes within 5 minutes of `executeAt` timestamp

## Mark done in SPEC-STATUS.md when all criteria above are verified
