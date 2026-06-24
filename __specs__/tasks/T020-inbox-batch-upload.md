# T020 — Inbox Batch Upload (CSV + Multi-Add Wizard)

**Wave:** 7  
**Depends on:** T019, T005, T006, T007  
**Skills to load:** docs/05-agent-skills/03-skill-inbox-connection.md  

---

## Current state

Adding an inbox requires clicking "Connect Gmail" or "Connect Outlook" and completing an OAuth flow for each inbox individually. There is no way to add multiple inboxes in a single action. There is no CSV upload path. There is no concept of a pool inbox — every inbox connected goes into the inboxes-to-warm list.

The connect flow lives at `POST /auth/{gmail,outlook}/connect` (OAuth) and `POST /inboxes/connect/custom` (SMTP/IMAP). All three write to the `inboxes` table.

---

## What to build

### Two new backend endpoints

**`POST /inboxes/batch`** — batch upload inboxes to warm  
**`POST /pool-inboxes/batch`** — batch upload pool inboxes

Both endpoints accept the same payload shape and follow the same logic. Only the destination table differs (`inboxes` vs `pool_inboxes`).

**Request body:**
```json
{
  "inboxes": [
    {
      "email": "a@domain.com",
      "provider": "gmail",
      "clientId": "...",
      "clientSecret": "...",
      "refreshToken": "..."
    },
    {
      "email": "b@domain.com",
      "provider": "custom",
      "smtpHost": "smtp.domain.com",
      "smtpPort": 587,
      "smtpUser": "b@domain.com",
      "smtpPassword": "...",
      "imapHost": "imap.domain.com",
      "imapPort": 993,
      "imapUser": "b@domain.com",
      "imapPassword": "..."
    }
  ]
}
```

**Processing:**
1. Validate all entries — reject the batch if any entry is structurally malformed (wrong fields for the provider)
2. For each entry:
   a. Encrypt all credential fields with AES-256-GCM before writing (same encryption pattern as existing inbox connect)
   b. Write the record with `status = 'pending'`
   c. Enqueue an `inbox-analysis` job for this inbox (see T021)
3. Return a summary: `{ created: N, failed: [{ email, reason }] }`
4. Partial success is acceptable — process all entries, collect failures, return summary

**`POST /pool-inboxes`** — single pool inbox add  
**`GET /pool-inboxes`** — list all pool inboxes for the authenticated user  
**`DELETE /pool-inboxes/:id`** — remove a pool inbox (soft delete: set status='removed', drain active pairs)

### CSV parsing

Accept `multipart/form-data` with a CSV file at `POST /inboxes/batch/csv` and `POST /pool-inboxes/batch/csv`.

**Expected CSV columns for Gmail/Outlook:**
`email, provider, client_id, client_secret, refresh_token`

**Expected CSV columns for custom SMTP/IMAP:**
`email, provider, smtp_host, smtp_port, smtp_user, smtp_password, imap_host, imap_port, imap_user, imap_password`

Mixed providers in one CSV file are supported. Column detection is by the `provider` column value per row. The parser must:
- Skip header row
- Skip blank rows
- Return a structured error for any row missing required fields for its provider type
- Never store the raw CSV — parse in memory and immediately process per-row

---

## Acceptance criteria

- [ ] `POST /inboxes/batch` accepts a JSON array of inboxes and writes them all (with encrypted credentials) to the `inboxes` table with `status='pending'`
- [ ] `POST /pool-inboxes/batch` accepts the same shape and writes to `pool_inboxes` table instead
- [ ] `POST /inboxes/batch/csv` and `POST /pool-inboxes/batch/csv` accept a CSV file and process it identically to the JSON batch endpoint
- [ ] Each successfully added inbox (both tables) has an `inbox-analysis` job enqueued immediately after write
- [ ] All credential fields are encrypted with AES-256-GCM before being written — never stored as plaintext
- [ ] A structurally malformed row fails gracefully — included in the `failed[]` response, does not block the rest of the batch
- [ ] `GET /pool-inboxes` returns only pool inboxes belonging to the authenticated user
- [ ] `DELETE /pool-inboxes/:id` sets status to removed and cannot be reversed
- [ ] Uploading the same email twice returns a clear duplicate error for that row (not a DB crash)

## Mark done in SPEC-STATUS.md when all criteria above are verified
