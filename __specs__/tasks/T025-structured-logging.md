# T025 — Structured Logging System

**Wave:** 9 (run after T024)
**Depends on:** T001 (NestJS scaffold), T024 (user sync wiring)
**Skills to load:** docs/05-agent-skills/11-skill-logging.md

---

## Current state (before this change)

The backend has no consistent logging strategy:

- `SmtpClientService` — zero logs. When `transporter.sendMail()` fails, the
  error propagates to BullMQ with no context (no inboxId, no host, no port, no
  provider). You cannot tell from the terminal whether a send failed due to
  wrong password, wrong port, expired OAuth token, or DNS issue.
- `ImapClientService` — zero logs. Connection failures are silent.
- `WarmupSendProcessor` — declares `private readonly logger = new Logger(...)` 
  but **never calls it**. No log on job start, no log on send success, no log
  on failure.
- `BetterAuthGuard` — no logs. A 401/403 produces no trace of which userId was
  attempted.
- Most processors, services, and the auth layer — silent.
- ~13 files use NestJS `Logger` inconsistently — plain text strings, no
  structured fields, impossible to filter by `inboxId`, `jobId`, or `userId`.
- `ImapFlow` connections have `logger: false` — IMAP protocol errors are
  completely invisible.

**Result:** When SMTP/IMAP breaks (as is happening now), there is nothing in the
terminal to diagnose — no host, no port, no provider, no error code, no inbox.

---

## After state (what changes)

Every meaningful action in the backend emits a **structured JSON log line** with
consistent fields. The terminal shows formatted, coloured output in development.
In production (Cloud Run), lines are plain JSON readable by GCP Cloud Logging.

### Log format — every line carries these fields

```json
{
  "level":     "info|warn|error|debug",
  "context":   "WarmupSendProcessor",
  "msg":       "warmup send succeeded",
  "inboxId":   "uuid",
  "jobId":     "bullmq-job-id",
  "ts":        "2026-06-23T10:00:00.000Z"
}
```

Additional fields are appended per domain (see domain coverage below). No
field is ever undefined in the output — omit the key entirely if the value
is not available for a given log line.

### Library choice — pino via nestjs-pino

Use **pino** + **nestjs-pino** (both MIT). Reasons:
- Fastest Node.js JSON logger (async, non-blocking)
- `pino-pretty` for human-readable dev output (colours, aligned columns)
- Native GCP Cloud Logging support — GCP reads `severity` from pino's `level`
  field automatically
- Replaces NestJS's built-in `Logger` transparently — no code-wide refactor,
  just swap the logger in `main.ts`

### Installation (agent must run these)

```bash
cd projects/email-warmup/backend
npm install pino nestjs-pino pino-http
npm install --save-dev pino-pretty @types/pino
```

### Bootstrap wiring — `main.ts`

Replace `NestFactory.create(AppModule)` with:

```typescript
import { Logger } from 'nestjs-pino';

const app = await NestFactory.create(AppModule, { bufferLogs: true });
app.useLogger(app.get(Logger));
```

Add `LoggerModule` to `AppModule` imports:

```typescript
LoggerModule.forRoot({
  pinoHttp: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true, singleLine: true } }
        : undefined,
    // Redact sensitive fields from HTTP request logs
    redact: ['req.headers.authorization', 'req.body.smtpPassword', 'req.body.imapPassword'],
    // Attach inboxId from request body/params to every HTTP log line automatically
    customProps: (req) => ({
      inboxId: (req as any).params?.id ?? (req as any).body?.inboxId,
      userId:  (req as any).userId,
    }),
    autoLogging: {
      ignore: (req) => req.url === '/health',
    },
  },
})
```

### Env var

```
LOG_LEVEL=debug   # default: info
```

---

## Domain coverage — what to log and where

### 1. SmtpClientService (`inbox/smtp/smtp-client.service.ts`)

Inject `PinoLogger` (from `nestjs-pino`). Log at every step that can fail:

| Event | Level | Required fields |
|---|---|---|
| Building transporter | `debug` | `inboxId`, `provider`, `smtpHost`, `smtpPort` |
| `transporter.verify()` success | `info` | `inboxId`, `provider` |
| `transporter.verify()` failure | `error` | `inboxId`, `provider`, `smtpHost`, `smtpPort`, `err.message`, `err.code` |
| `sendMail()` success | `info` | `inboxId`, `to`, `messageId` |
| `sendMail()` failure | `error` | `inboxId`, `provider`, `smtpHost`, `smtpPort`, `to`, `err.message`, `err.code`, `err.responseCode` |
| OAuth token refresh triggered | `debug` | `inboxId`, `provider` |
| OAuth token refresh failure | `error` | `inboxId`, `provider`, `err.message` |

### 2. ImapClientService (`inbox/imap/imap-client.service.ts`)

Inject `PinoLogger`. Enable `ImapFlow` logger only at `debug` level:

```typescript
logger: process.env.LOG_LEVEL === 'debug' ? true : false,
```

| Event | Level | Required fields |
|---|---|---|
| Opening new IMAP connection | `debug` | `inboxId`, `imapHost`, `imapPort`, `provider` |
| Connection established (cache miss → new conn) | `info` | `inboxId`, `provider` |
| Connection reused from pool | `debug` | `inboxId` |
| `ImapNotConfiguredError` thrown | `warn` | `inboxId` (message: "IMAP not configured — skipping receive action") |
| Connection failure | `error` | `inboxId`, `imapHost`, `imapPort`, `provider`, `err.message`, `err.code` |
| `client.logout()` / close | `debug` | `inboxId` |

### 3. WarmupSendProcessor (`warmup/warmup-send.processor.ts`)

Fill in the existing empty `logger`. Log at every job lifecycle point:

| Event | Level | Required fields |
|---|---|---|
| Job started | `info` | `jobId`, `senderInboxId`, `partnerSource`, `partnerId`, `warmupDay` |
| Sender not found / not active | `warn` | `jobId`, `senderInboxId`, `status` |
| Send succeeded | `info` | `jobId`, `senderInboxId`, `to`, `messageId`, `warmupDay`, `durationMs` |
| Receive job enqueued | `debug` | `jobId`, `receiverSource`, `receiverId`, `actions`, `delayMs` |
| Any thrown error | `error` | `jobId`, `senderInboxId`, `err.message` |

### 4. WarmupReceiveProcessor (`warmup/warmup-receive.processor.ts`)

| Event | Level | Required fields |
|---|---|---|
| Job started | `info` | `jobId`, `receiverSource`, `receiverId`, `actions` |
| Message found / not found in IMAP | `info`/`warn` | `jobId`, `receiverId`, `messageId`, `found: bool` |
| Each action completed (open/star/reply/rescue) | `debug` | `jobId`, `action`, `receiverId` |
| Rescue-from-spam result | `info` | `jobId`, `receiverId`, `rescued: bool` |
| Any thrown error | `error` | `jobId`, `receiverId`, `err.message` |

### 5. BetterAuthGuard (`auth/better-auth.guard.ts`)

| Event | Level | Required fields |
|---|---|---|
| Token missing | `warn` | `path`, `method` |
| Token invalid / expired | `warn` | `path`, `method`, `reason: 'expired'|'invalid'|'malformed'` |
| Token verified | `debug` | `userId` |

### 6. InboxService / PoolInboxService — connect + pre-check

| Event | Level | Required fields |
|---|---|---|
| Inbox connect attempt | `info` | `userId`, `provider`, `email` |
| Pre-check passed | `info` | `inboxId`, `provider`, `email` |
| Pre-check failed | `error` | `inboxId`, `provider`, `email`, `err.message` |
| Inbox status changed | `info` | `inboxId`, `fromStatus`, `toStatus` |

### 7. DNS check + Blacklist processors

| Event | Level | Required fields |
|---|---|---|
| DNS check started | `info` | `jobId`, `inboxId`, `domain` |
| Per-check result (SPF/DKIM/DMARC/MX/rDNS) | `debug` | `jobId`, `check`, `result: bool\|null` |
| Blacklist hit | `warn` | `jobId`, `inboxId`, `rbl`, `domain` |
| Inbox paused due to blacklist | `warn` | `inboxId`, `rbl` |

### 8. Analysis processor (T021)

| Event | Level | Required fields |
|---|---|---|
| Analysis started | `info` | `jobId`, `inboxId\|poolInboxId` |
| Health score computed | `info` | `inboxId\|poolInboxId`, `healthScore`, `issues[]`, `placementEstimate` |
| Status set to active | `info` | `inboxId\|poolInboxId` |

---

## Agent skill file

Write `docs/05-agent-skills/11-skill-logging.md` (see content below). Every
future coding agent working on this project must load this skill before writing
any new service or processor.

---

## CLI tools for log navigation

Add these npm scripts to `backend/package.json`:

```json
"logs:dev":   "LOG_LEVEL=debug npm run start:dev 2>&1 | pino-pretty --colorize",
"logs:smtp":  "LOG_LEVEL=debug npm run start:dev 2>&1 | pino-pretty --colorize | grep -i smtp",
"logs:imap":  "LOG_LEVEL=debug npm run start:dev 2>&1 | pino-pretty --colorize | grep -i imap",
"logs:warn":  "npm run start:dev 2>&1 | pino-pretty --colorize --levelFirst | grep -E 'WARN|ERROR'",
"logs:inbox": "LOG_LEVEL=debug npm run start:dev 2>&1 | pino-pretty --colorize | grep -i"
```

Usage: `npm run logs:smtp` to see every SMTP event. `npm run logs:inbox -- abc123` to filter by inboxId.

---

## Acceptance criteria

- [ ] `npm run start:dev` prints coloured pino-pretty output — no raw JSON in dev terminal
- [ ] `POST /inboxes/connect/smtp` with wrong App Password logs: level=error, context=SmtpClientService, smtpHost, smtpPort, err.message, err.code
- [ ] `POST /inboxes/connect/smtp` with correct credentials logs: level=info, context=SmtpClientService, "verify succeeded"
- [ ] A BullMQ warmup-send job logs: level=info on start with jobId+senderInboxId, level=info on success with messageId+durationMs
- [ ] A 401 from BetterAuthGuard logs: level=warn with path+method+reason
- [ ] A 403 "User not found" logs: level=warn with userId+path
- [ ] `LOG_LEVEL=debug` shows IMAP connection open/reuse events
- [ ] No `Authorization` header or `smtpPassword` value appears in any log line (redacted)
- [ ] In production mode (`NODE_ENV=production`), output is plain JSON — no pino-pretty
- [ ] All existing unit tests still pass (pino uses `nestjs-pino`'s `PinoLogger` which is mockable)
- [ ] `npm run logs:smtp` filters to only SMTP-related lines

## Mark done in SPEC-STATUS.md when all criteria above are verified
