# T005 — Gmail OAuth Connect

**Wave:** 1  
**Depends on:** T002, T004  
**Skills to load:** docs/05-agent-skills/03-skill-inbox-connection.md, docs/05-agent-skills/01-skill-database.md

---

## What to build

Implement the full Gmail OAuth 2.0 connect flow: authorization redirect, code exchange, token storage, and pre-check sequence.

### InboxModule — Gmail flow

**GoogleOAuthService** (`inbox/oauth/google-oauth.service.ts`)

- `getAuthorizationUrl(state)` — builds Google OAuth URL with:
  - scope: `https://mail.google.com/` (full IMAP + SMTP access)
  - `access_type=offline` (required for refresh token)
  - `prompt=consent` (forces refresh token in response even if already connected)
  - `redirect_uri`: `{APP_URL}/api/auth/callback/google`

- `exchangeCode(code)` — POST to `https://oauth2.googleapis.com/token`
  - Returns `{ access_token, refresh_token, expires_in }`
  - Throws if `refresh_token` is missing (user did not go through consent — force re-auth)

- `refreshToken(refreshToken)` — POST to token endpoint with `grant_type=refresh_token`

**InboxService** (`inbox/inbox.service.ts`)

- `connectGmail(userId, code)`:
  1. Exchange code for tokens
  2. Get user email via `https://www.googleapis.com/oauth2/v3/userinfo`
  3. Assert inbox limit (`assertInboxLimit(userId)`)
  4. Encrypt both tokens with AES-256-GCM
  5. Insert into `inboxes` table with `provider='gmail'`, `status='pending'`
  6. Run pre-check sequence (see below)
  7. Enqueue `token-refresh` job (every 45 min)

**Pre-check sequence** (runs synchronously before returning to user):
1. Test SMTP AUTH using Nodemailer `verify()`
2. Test IMAP LOGIN using imapflow connect + close
3. Create `WarmupHub` label if missing (Gmail: `client.mailboxCreate('WarmupHub')`)
4. Resolve domain DNS (SPF, DKIM, DMARC, MX) — fast check, store in dns_checks
5. Check top 5 blacklists (fast check only)
6. If all pass: set status = `active`, enroll in pool (set `pool_consent_at`)
7. Return pre-check result with per-step pass/fail

### API endpoints

```
GET /auth/gmail/connect           → { url: string }  (OAuth authorization URL)
GET /api/auth/callback/google     → exchange code, run pre-check, redirect to /inboxes
GET /inboxes                      → InboxSummary[]
```

---

## Acceptance criteria

- [ ] Authorization URL includes `scope=https://mail.google.com/` and `prompt=consent`
- [ ] Missing `refresh_token` in exchange response throws error (not silently ignored)
- [ ] Both access_token and refresh_token stored encrypted (verify no plaintext in DB row)
- [ ] Pre-check result returned within 30 seconds of OAuth callback
- [ ] `WarmupHub` Gmail label created if it does not already exist
- [ ] Inbox `status` set to `active` after successful pre-check
- [ ] `pool_consent_at` set on inbox record after successful pre-check
- [ ] `token-refresh` BullMQ job enqueued with 45-minute repeat delay
- [ ] Connecting second Gmail inbox for same user when at plan limit returns 403

## Mark done in SPEC-STATUS.md when all criteria above are verified
