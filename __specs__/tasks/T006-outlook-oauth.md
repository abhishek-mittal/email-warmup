# T006 — Outlook OAuth Connect

**Wave:** 1  
**Depends on:** T002, T004  
**Skills to load:** docs/05-agent-skills/03-skill-inbox-connection.md, docs/05-agent-skills/01-skill-database.md

---

## What to build

Implement Outlook (Microsoft) OAuth 2.0 connect — same pattern as Gmail but with Microsoft identity platform.

### MicrosoftOAuthService (`inbox/oauth/microsoft-oauth.service.ts`)

- `getAuthorizationUrl(state)` — builds Microsoft OAuth URL:
  - Endpoint: `https://login.microsoftonline.com/common/oauth2/v2.0/authorize`
  - Scopes: `https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access`
  - `prompt=consent` for refresh token

- `exchangeCode(code)` — POST to `https://login.microsoftonline.com/common/oauth2/v2.0/token`

- `refreshToken(refreshToken)` — Microsoft refresh tokens are valid for 90 days but must be refreshed before use

**InboxService** — `connectOutlook(userId, code)`:
1. Exchange code for tokens
2. Get email via `https://graph.microsoft.com/v1.0/me` (`mail` property)
3. Assert inbox limit
4. Encrypt tokens
5. Insert with `provider='outlook'`, IMAP host `outlook.office365.com:993`
6. Run pre-check sequence (same 5 steps as Gmail)
7. Enqueue `token-refresh` job (every 45 min)

**IMAP settings for Outlook:**
- Host: `outlook.office365.com`
- Port: `993`
- Auth: `{ user: email, accessToken: decrypted_access_token }` — imapflow handles XOAUTH2
- WarmupHub folder: regular IMAP folder (not a label like Gmail)

### API endpoints

```
GET /auth/outlook/connect
GET /api/auth/callback/microsoft
```

---

## Acceptance criteria

- [ ] Outlook OAuth scopes include `IMAP.AccessAsUser.All`, `SMTP.Send`, and `offline_access`
- [ ] IMAP connection uses OAuth2 XOAUTH2 mechanism (not password)
- [ ] `WarmupHub` folder created as regular IMAP folder (not Gmail label)
- [ ] Pre-check passes for a real Outlook account
- [ ] Microsoft refresh token stored encrypted
- [ ] Token refresh job enqueued at 45-minute repeat interval
- [ ] Inbox status = `active` after successful pre-check

## Mark done in SPEC-STATUS.md when all criteria above are verified
