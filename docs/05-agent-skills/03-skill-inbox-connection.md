# Skill: Inbox Connection (OAuth + SMTP/IMAP)

**Domain:** Gmail/Outlook OAuth, custom SMTP/IMAP, token management, imapflow  
**Load when:** Working on InboxModule, OAuth exchange, token refresh, IMAP operations

---

## Module structure

```
src/
├── inbox/
│   ├── inbox.module.ts
│   ├── inbox.service.ts           ← CRUD, pre-check, enrollment
│   ├── inbox.controller.ts        ← REST endpoints
│   ├── oauth/
│   │   ├── google-oauth.service.ts
│   │   └── microsoft-oauth.service.ts
│   ├── imap/
│   │   ├── imap-client.service.ts  ← imapflow wrapper, connection pool
│   │   └── imap-actions.service.ts ← open, star, reply, rescue, file
│   └── smtp/
│       └── smtp-client.service.ts  ← Nodemailer transport per inbox
```

---

## OAuth flows

### Gmail (Google)
```
1. Redirect user to:
   https://accounts.google.com/o/oauth2/v2/auth
   ?client_id=...&redirect_uri=...
   &scope=https://mail.google.com/   ← full IMAP + SMTP scope
   &access_type=offline               ← required for refresh token
   &prompt=consent                    ← forces refresh_token in response

2. Exchange code for tokens:
   POST https://oauth2.googleapis.com/token
   { code, client_id, client_secret, redirect_uri, grant_type: "authorization_code" }
   → { access_token, refresh_token, expires_in }

3. Store both tokens encrypted (AES-256-GCM) in inboxes table
4. Schedule token refresh job (every 45 min)
```

### Outlook (Microsoft)
```
1. Redirect to:
   https://login.microsoftonline.com/common/oauth2/v2.0/authorize
   ?scope=https://outlook.office.com/IMAP.AccessAsUser.All
          https://outlook.office.com/SMTP.Send
          offline_access

2. Exchange code same pattern as Google
3. Microsoft refresh tokens are long-lived (90 days) but must still be refreshed before use
```

### Token refresh job
```typescript
async refreshOAuthToken(inboxId: string): Promise<void> {
  const inbox = await getInbox(inboxId);
  const decrypted = decrypt(inbox.oauthRefreshToken);

  try {
    const newTokens = await (
      inbox.oauthProvider === 'google'
        ? googleOAuth.refresh(decrypted)
        : microsoftOAuth.refresh(decrypted)
    );
    await updateInbox(inboxId, {
      oauthAccessToken: encrypt(newTokens.access_token),
      oauthTokenExpiry: new Date(Date.now() + newTokens.expires_in * 1000)
    });
  } catch (err) {
    // Token revoked or invalid
    await setInboxStatus(inboxId, 'error');
    await alertService.notify(inboxId, 'token_revoked', {});
  }
}
```

---

## IMAP client (imapflow)

```typescript
// imap-client.service.ts — connection pool pattern
import { ImapFlow } from 'imapflow';

const pool = new Map<string, ImapFlow>(); // inboxId → connection

async getConnection(inboxId: string): Promise<ImapFlow> {
  if (pool.has(inboxId) && pool.get(inboxId).usable) {
    return pool.get(inboxId);
  }

  const inbox = await getInbox(inboxId);
  const client = new ImapFlow({
    host: inbox.imapHost ?? imapHostForProvider(inbox.provider),
    port: inbox.imapPort ?? 993,
    secure: true,
    auth: inbox.provider === 'gmail' || inbox.provider === 'outlook'
      ? { user: inbox.email, accessToken: decrypt(inbox.oauthAccessToken) }
      : { user: inbox.imapUser, pass: decrypt(inbox.imapPass) },
    logger: false,
  });

  await client.connect();
  pool.set(inboxId, client);
  return client;
}
```

### Gmail-specific IMAP settings
- Host: `imap.gmail.com:993`
- For OAuth: `auth: { user, accessToken }` — imapflow handles XOAUTH2 format
- WarmupHub folder: Gmail label `WarmupHub` (create if missing via `client.mailboxCreate('WarmupHub')`)

### Outlook-specific IMAP settings
- Host: `outlook.office365.com:993`
- For OAuth: same `{ user, accessToken }` pattern
- WarmupHub folder: regular IMAP folder

---

## Encryption

All sensitive fields encrypted before DB write, decrypted before use:
```typescript
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex'); // 32 bytes from Secret Manager

function encrypt(plaintext: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decrypt(ciphertext: string): string {
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.slice(0, 16);
  const tag = buf.slice(16, 32);
  const data = buf.slice(32);
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
```

---

## Pre-check sequence (on connect)

```
1. Test SMTP AUTH → fail fast if credentials wrong
2. Test IMAP LOGIN → fail fast if credentials wrong
3. Create WarmupHub folder if missing
4. Resolve domain DNS (SPF, DKIM, DMARC, MX)
5. Check top 5 blacklists (fast check — full check runs in background)
6. Return pre-check results to user immediately
7. Enqueue full dns-check + blacklist-check jobs in background
```

---

## What you never do

- **Never store plaintext tokens or passwords** — encrypt before every DB write
- **Never open a new IMAP connection per action** — use the connection pool
- **Never use Gmail IMAP basic auth** — OAuth only for Gmail and Outlook
- **Never use `scope=email profile` for Gmail** — must be `https://mail.google.com/` for IMAP access
- **Never let token refresh failure be silent** — always set inbox status = error and notify user
