# T007 — Custom SMTP/IMAP Connect

**Wave:** 1  
**Depends on:** T002, T004  
**Skills to load:** docs/05-agent-skills/03-skill-inbox-connection.md, docs/05-agent-skills/01-skill-database.md

---

## What to build

Allow users to connect any email provider via raw SMTP + IMAP credentials (for non-Gmail/Outlook providers like Zoho, Fastmail, custom domains, etc.).

### API endpoint

```
POST /inboxes/connect/smtp
Body: {
  email: string,
  smtpHost: string, smtpPort: number, smtpUser: string, smtpPass: string,
  imapHost: string, imapPort: number, imapUser: string, imapPass: string,
  dkimSelector?: string   // optional — used for DNS DKIM check
}
```

### InboxService — `connectCustomSmtp(userId, dto)`

1. Validate all required fields present
2. Assert inbox limit
3. Test SMTP: `nodemailer.createTransport({host, port, auth}).verify()`
4. Test IMAP: `new ImapFlow({host, port, auth: {user, pass}}).connect()` then close
5. If either fails: return 422 with which step failed and error message
6. Encrypt `smtpPass` and `imapPass` with AES-256-GCM
7. Insert into `inboxes` with `provider='custom'`
8. Create `WarmupHub` folder via IMAP
9. Run DNS checks (fast)
10. Check top 5 blacklists (fast)
11. Set status = `active` on pass
12. Return pre-check result

### Validation rules

- `smtpPort` must be 25, 465, or 587
- `imapPort` must be 143 or 993
- `email` must be valid email format
- All credential fields required (no optional SMTP fields)

---

## Acceptance criteria

- [ ] Invalid SMTP credentials return 422 with `{ step: 'smtp', error: '...' }` — not 500
- [ ] Invalid IMAP credentials return 422 with `{ step: 'imap', error: '...' }`
- [ ] `smtpPass` and `imapPass` stored encrypted in DB (no plaintext)
- [ ] `WarmupHub` IMAP folder created on successful connect
- [ ] Pre-check result includes per-step status for all 5 steps
- [ ] Invalid port number (e.g., 8080 for SMTP) returns 400 validation error
- [ ] Connecting at plan limit returns 403

## Mark done in SPEC-STATUS.md when all criteria above are verified
