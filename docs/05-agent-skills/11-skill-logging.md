# Skill 11 — Structured Logging

Load this skill before writing any new service, processor, controller, or guard.
Load it before debugging any issue where the symptom is "it fails but I don't know why."

---

## What this skill covers

- How the logging system is set up in this project
- Which logger to inject in which context
- What fields to include on each log line
- How to read and filter logs from the CLI
- How to debug SMTP, IMAP, BullMQ, and auth issues using logs

---

## Stack

| Package | Role |
|---|---|
| `pino` | Core JSON logger (fast, non-blocking) |
| `nestjs-pino` | NestJS integration — replaces built-in Logger |
| `pino-http` | HTTP request/response logging middleware |
| `pino-pretty` | Human-readable dev output (not used in production) |

Pino is configured globally in `AppModule` via `LoggerModule.forRoot(...)` and
bootstrapped in `main.ts`. Never install or configure a second logger.

---

## How to inject the logger

### In a NestJS service or processor

```typescript
import { PinoLogger, InjectPinoLogger } from 'nestjs-pino';

@Injectable()
export class MyService {
  constructor(
    @InjectPinoLogger(MyService.name)
    private readonly logger: PinoLogger,
  ) {}
}
```

### In a NestJS controller

Same pattern — inject `PinoLogger` with `@InjectPinoLogger(MyController.name)`.

### Do NOT use NestJS's built-in Logger

```typescript
// ❌ wrong — inconsistent format, no structured fields
import { Logger } from '@nestjs/common';
private readonly logger = new Logger(MyService.name);

// ✅ correct
import { PinoLogger, InjectPinoLogger } from 'nestjs-pino';
@InjectPinoLogger(MyService.name) private readonly logger: PinoLogger
```

---

## Log levels

| Level | When to use |
|---|---|
| `debug` | Connection reuse, token refresh, per-action details, IMAP protocol events |
| `info` | Job started/completed, inbox connected, send succeeded, status changed |
| `warn` | Auth rejected, IMAP not configured (skippable), blacklist hit, inbox paused |
| `error` | SMTP send failed, IMAP connect failed, OAuth refresh failed, unexpected throws |

---

## Required fields — always include these

Every `logger.info(...)`, `logger.error(...)` etc. call must pass a context object
as the first argument and a message string as the second:

```typescript
// ✅ correct
this.logger.info({ inboxId, provider, smtpHost }, 'SMTP verify succeeded');
this.logger.error({ inboxId, err: e.message, errCode: e.code }, 'SMTP send failed');

// ❌ wrong — no structured fields, ungreppable
this.logger.error('send failed');
```

### Field reference by domain

**SMTP events** — always include: `inboxId`, `provider`, `smtpHost`, `smtpPort`  
On errors also include: `err` (message string), `errCode` (SMTP response code e.g. `EAUTH`, `ECONNREFUSED`)

**IMAP events** — always include: `inboxId`, `provider`, `imapHost`, `imapPort`  
On errors also include: `err`, `errCode`

**BullMQ jobs** — always include: `jobId` (from `job.id`), relevant entity IDs  
On job start: `jobId`, `senderInboxId` (or `inboxId`), `warmupDay`  
On job success: `jobId`, `durationMs` (compute as `Date.now() - startedAt`)  
On job error: `jobId`, `err`

**Auth events** — always include: `path` (`req.url`), `method` (`req.method`)  
On rejection: also include `reason` (`'expired' | 'invalid' | 'malformed' | 'missing'`)  
On success: `userId`

**Inbox connect** — always include: `userId`, `provider`, `email`  
On error: also `err`, `smtpHost`, `smtpPort`

### Never log these fields (redact)

- `req.headers.authorization` — bearer token
- `smtpPassword` / `imapPassword` — plaintext passwords (these should never be in memory unencrypted anyway)
- `accessToken` / `refreshToken` — OAuth tokens
- The full `encryptedCredentials` JSONB blob

Pino's `redact` config in `LoggerModule` handles HTTP-layer redaction automatically.
For application-layer logs, simply don't include sensitive values in the log object.

---

## CLI log navigation

### Dev — coloured, formatted output

```bash
npm run start:dev
# or with debug level:
LOG_LEVEL=debug npm run start:dev
```

### Filter by domain (run in a second terminal while server is running)

```bash
# All SMTP events
npm run logs:smtp

# All IMAP events
npm run logs:imap

# Warnings and errors only
npm run logs:warn

# Filter by a specific inboxId (replace <id> with actual UUID)
npm run logs:inbox -- <id>
```

### One-shot grep on a running server (pipe to pino-pretty first)

```bash
# See only errors
LOG_LEVEL=debug npm run start:dev 2>&1 | npx pino-pretty | grep '"level":50'

# See only a specific inbox
LOG_LEVEL=debug npm run start:dev 2>&1 | npx pino-pretty | grep '"inboxId":"abc-123"'

# See job lifecycle for a specific job
LOG_LEVEL=debug npm run start:dev 2>&1 | npx pino-pretty | grep '"jobId":"1"'
```

### Pino level numbers (for raw JSON grep)

| Level name | Number |
|---|---|
| trace | 10 |
| debug | 20 |
| info | 30 |
| warn | 40 |
| error | 50 |
| fatal | 60 |

---

## Debugging recipes

### SMTP connect fails with 403 / no error visible

1. Set `LOG_LEVEL=debug`
2. Call `POST /inboxes/connect/smtp` again
3. Look for lines with `context: SmtpClientService` — you will see `smtpHost`, `smtpPort`, `provider`, and the exact `errCode` (e.g. `EAUTH` = wrong password, `ECONNREFUSED` = wrong port/host, `ETIMEDOUT` = firewall)

```bash
LOG_LEVEL=debug npm run start:dev 2>&1 | npx pino-pretty | grep SmtpClientService
```

### IMAP silent failure

```bash
LOG_LEVEL=debug npm run start:dev 2>&1 | npx pino-pretty | grep ImapClientService
```
Look for `ImapNotConfiguredError` (inbox has no IMAP — normal/warn) vs
`IMAP connect failed` with `errCode` (real error).

### BullMQ job disappears silently

```bash
LOG_LEVEL=debug npm run start:dev 2>&1 | npx pino-pretty | grep -E "WarmupSend|WarmupReceive"
```
Every job emits `info` on start and `info` on success. If you see start but no
success (and no error), check for `UnrecoverableError` lines.

### Auth 401/403

```bash
npm run start:dev 2>&1 | npx pino-pretty | grep BetterAuthGuard
```
Look for `reason: 'expired'` vs `reason: 'invalid'` vs `reason: 'missing'`.

### Inbox pre-check failure (connect wizard returns error)

```bash
npm run logs:smtp
```
Look for `level=error`, `context=SmtpClientService`, `"SMTP verify failed"` —
the `errCode` tells you exactly what's wrong.

---

## Adding logs to a new service or processor

Checklist before submitting any new service/processor:

1. **Inject `PinoLogger`** with `@InjectPinoLogger(MyService.name)`
2. **Log on entry** for any method that does IO (DB, SMTP, IMAP, HTTP, BullMQ)
3. **Log on success** with outcome fields (`messageId`, `durationMs`, `healthScore`, etc.)
4. **Log on error** in every `catch` block — include `err: e.message` and `errCode: e.code`
5. **Never log sensitive values** (passwords, tokens, keys)
6. **Use the right level** — info for happy path, warn for skippable issues, error for failures that need attention
7. **Include the entity ID** on every line (`inboxId`, `jobId`, `userId`) so logs are filterable

---

## Production (GCP Cloud Logging)

In production (`NODE_ENV=production`), pino outputs plain JSON without pino-pretty.
GCP Cloud Logging reads the `level` field and maps it to `severity` automatically:
- `info` → `INFO`
- `warn` → `WARNING`
- `error` → `ERROR`

To query in GCP:
```
resource.type="cloud_run_revision"
jsonPayload.inboxId="<uuid>"
severity>=WARNING
```
