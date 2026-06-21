# EmailWarm — Technical Specification

**Version:** 0.1  
**Date:** June 2026

---

## 1. Architecture overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      Next.js 15 Frontend                         │
│              (App Router + Server Actions + RSC)                 │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTPS / REST / SSE
┌──────────────────────────▼──────────────────────────────────────┐
│                    NestJS API (Cloud Run)                         │
│  AuthModule │ InboxModule │ WarmupModule │ MonitorModule          │
│  BillingModule │ PoolModule │ DiagnosticsModule                  │
└──────┬────────────────┬──────────────────┬───────────────────────┘
       │                │                  │
  ┌────▼────┐    ┌──────▼──────┐   ┌──────▼────────┐
  │  Cloud  │    │  BullMQ     │   │  Cloud SQL    │
  │  SQL    │    │  Workers    │   │  (PostgreSQL) │
  │  (PG16) │    │  (Redis)    │   └───────────────┘
  └─────────┘    └─────────────┘
                      │
          ┌───────────┼───────────────┐
          │           │               │
   ┌──────▼──┐ ┌──────▼──┐  ┌────────▼────┐
   │ Warmup  │ │ Monitor │  │ Placement   │
   │ Worker  │ │ Worker  │  │ Test Worker │
   └─────────┘ └─────────┘  └─────────────┘
```

**All GCP resources reuse the dmphub project:** `sunny-ship-236913`, region `asia-south1`.

---

## 2. Service map

| Service | NestJS Module | Queue | Cron | Description |
|---|---|---|---|---|
| Auth | AuthModule | — | — | Clerk webhook sync, JWT validation |
| Inbox | InboxModule | — | — | CRUD for connected inboxes, OAuth token management |
| Pool | PoolModule | — | — | Warmup pool membership, pairing algorithm |
| Warmup Engine | WarmupModule | `warmup-send`, `warmup-receive` | Daily schedule per inbox | Send warmup emails, simulate engagement |
| DNS Monitor | MonitorModule | `dns-check` | Daily 06:00 UTC | SPF/DKIM/DMARC/MX/rDNS checks |
| Blacklist Monitor | MonitorModule | `blacklist-check` | Every 6 hours | 100+ RBL checks |
| Placement Test | DiagnosticsModule | `placement-test` | Weekly | Seed list inbox placement |
| Spam Diagnostics | DiagnosticsModule | `diagnostics` | On demand | AI-powered cause analysis |
| Reputation Score | ScoringModule | — | Daily | Composite 0–100 score computation |
| Billing | BillingModule | — | — | Stripe webhook handler, entitlement sync |
| Notifications | NotifyModule | `notify` | — | Email + Slack webhook delivery |

---

## 3. Database schema

### `users`
```sql
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_id        TEXT UNIQUE NOT NULL,
  email           TEXT UNIQUE NOT NULL,
  industry        TEXT,                          -- saas|agency|finance|legal|ecommerce|other
  plan_id         TEXT NOT NULL DEFAULT 'trial', -- trial|starter|growth|agency|enterprise
  inbox_limit     INT NOT NULL DEFAULT 3,
  stripe_customer TEXT,
  stripe_sub_id   TEXT,
  trial_ends_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### `inboxes`
```sql
CREATE TABLE inboxes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  provider        TEXT NOT NULL,                 -- gmail|outlook|custom
  display_name    TEXT,
  timezone        TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  
  -- OAuth (Gmail/Outlook)
  oauth_provider  TEXT,                          -- google|microsoft
  oauth_access_token  TEXT,                      -- encrypted
  oauth_refresh_token TEXT,                      -- encrypted
  oauth_token_expiry  TIMESTAMPTZ,
  
  -- Custom SMTP/IMAP
  smtp_host       TEXT,
  smtp_port       INT,
  smtp_user       TEXT,
  smtp_pass       TEXT,                          -- encrypted (AES-256)
  imap_host       TEXT,
  imap_port       INT,
  imap_user       TEXT,
  imap_pass       TEXT,                          -- encrypted (AES-256)
  
  -- Status
  status          TEXT NOT NULL DEFAULT 'pending', -- pending|active|paused|error|graduated
  warmup_speed    TEXT NOT NULL DEFAULT 'medium',   -- slow|medium|fast
  warmup_day      INT NOT NULL DEFAULT 0,
  warmup_target   INT NOT NULL DEFAULT 50,          -- max emails/day at peak
  pool_enrolled   BOOL NOT NULL DEFAULT FALSE,
  pool_consent_at TIMESTAMPTZ,
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  UNIQUE(user_id, email)
);
```

### `pool_members`
```sql
-- Every inbox that has consented to pool participation
CREATE TABLE pool_members (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id        UUID NOT NULL UNIQUE REFERENCES inboxes(id) ON DELETE CASCADE,
  reputation      INT NOT NULL DEFAULT 50,       -- 0–100, computed daily
  provider        TEXT NOT NULL,
  timezone        TEXT NOT NULL,
  industry        TEXT,
  domain          TEXT NOT NULL,
  active          BOOL NOT NULL DEFAULT TRUE,
  quarantined     BOOL NOT NULL DEFAULT FALSE,
  quarantine_reason TEXT,
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at  TIMESTAMPTZ
);
```

### `warmup_sends`
```sql
CREATE TABLE warmup_sends (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_inbox_id UUID NOT NULL REFERENCES inboxes(id),
  receiver_inbox_id UUID NOT NULL REFERENCES inboxes(id),
  message_id      TEXT,                          -- SMTP Message-ID header
  subject         TEXT,
  sent_at         TIMESTAMPTZ,
  opened_at       TIMESTAMPTZ,
  replied_at      TIMESTAMPTZ,
  starred_at      TIMESTAMPTZ,
  rescued_from_spam_at TIMESTAMPTZ,
  landed_in       TEXT,                          -- inbox|spam|promotions|unknown
  bounce_type     TEXT,                          -- null|hard|soft
  warmup_day      INT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON warmup_sends (sender_inbox_id, created_at);
CREATE INDEX ON warmup_sends (receiver_inbox_id, created_at);
```

### `dns_checks`
```sql
CREATE TABLE dns_checks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id        UUID NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
  checked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  spf_valid       BOOL,
  spf_detail      TEXT,
  dkim_valid      BOOL,
  dkim_detail     TEXT,
  dmarc_valid     BOOL,
  dmarc_policy    TEXT,                          -- none|quarantine|reject
  dmarc_detail    TEXT,
  mx_valid        BOOL,
  mx_detail       TEXT,
  rdns_valid      BOOL,
  rdns_detail     TEXT,
  overall_score   INT                            -- 0–100 DNS sub-score
);

CREATE INDEX ON dns_checks (inbox_id, checked_at DESC);
```

### `blacklist_checks`
```sql
CREATE TABLE blacklist_checks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id        UUID NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
  checked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  listed_count    INT NOT NULL DEFAULT 0,
  rbl_results     JSONB,                         -- { "spamhaus-sbl": false, "barracuda": true, ... }
  is_clean        BOOL NOT NULL DEFAULT TRUE
);

CREATE INDEX ON blacklist_checks (inbox_id, checked_at DESC);
```

### `placement_tests`
```sql
CREATE TABLE placement_tests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id        UUID NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
  tested_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  test_type       TEXT NOT NULL DEFAULT 'weekly', -- baseline|weekly|manual
  results         JSONB NOT NULL,
  -- results shape: { gmail: { primary: 3, promotions: 1, spam: 0, missed: 0 },
  --                  outlook: { primary: 2, promotions: 0, spam: 1, missed: 1 }, ... }
  primary_rate    NUMERIC(5,2),                  -- % across all providers
  promotions_rate NUMERIC(5,2),
  spam_rate       NUMERIC(5,2),
  overall_verdict TEXT                           -- good|warning|poor
);

CREATE INDEX ON placement_tests (inbox_id, tested_at DESC);
```

### `reputation_scores`
```sql
CREATE TABLE reputation_scores (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id        UUID NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
  scored_at       DATE NOT NULL,
  score           INT NOT NULL,                  -- 0–100
  dns_sub_score   INT,
  blacklist_sub_score INT,
  placement_sub_score INT,
  UNIQUE(inbox_id, scored_at)
);

CREATE INDEX ON reputation_scores (inbox_id, scored_at DESC);
```

### `diagnostics`
```sql
CREATE TABLE diagnostics (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id        UUID NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
  triggered_by    TEXT NOT NULL,                 -- placement_test|manual|score_drop
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  issues          JSONB NOT NULL,
  -- issues shape: [{ code: "SPF_SOFTFAIL", severity: "critical",
  --                  title: "SPF record uses softfail",
  --                  fix: "Change ~all to -all in your SPF record." }]
  ai_summary      TEXT,
  action_plan     TEXT
);
```

### `notifications`
```sql
CREATE TABLE notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  inbox_id        UUID REFERENCES inboxes(id) ON DELETE SET NULL,
  type            TEXT NOT NULL,                 -- blacklist_hit|score_drop|dns_broken|warmup_complete|token_revoked
  channel         TEXT NOT NULL,                 -- email|slack
  payload         JSONB,
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## 4. API contracts

### Auth
All endpoints require `Authorization: Bearer <clerk_jwt>` unless marked `[public]`.

### POST /api/inboxes — Connect inbox
```
Request:
{
  "provider": "gmail" | "outlook" | "custom",
  "oauthCode": "string",          // for OAuth providers — exchange code
  "smtpHost": "string",           // for custom
  "smtpPort": number,
  "smtpUser": "string",
  "smtpPass": "string",
  "imapHost": "string",
  "imapPort": number,
  "imapUser": "string",
  "imapPass": "string",
  "timezone": "string",           // IANA tz, e.g. "Asia/Kolkata"
  "warmupSpeed": "slow"|"medium"|"fast",
  "poolConsent": true             // must be true to enroll
}

Response 201:
{
  "inboxId": "uuid",
  "email": "string",
  "status": "pending",
  "preCheckResults": {
    "spf": { "valid": bool, "detail": "string" },
    "dkim": { "valid": bool, "detail": "string" },
    "dmarc": { "valid": bool, "detail": "string" },
    "blacklisted": bool,
    "issues": [{ "code": "string", "severity": "critical|warning|info", "fix": "string" }]
  }
}

Response 422: { "error": "INBOX_LIMIT_REACHED", "limit": 3 }
Response 400: { "error": "OAUTH_EXCHANGE_FAILED", "detail": "string" }
```

### GET /api/inboxes — List user's inboxes
```
Response 200:
[{
  "id": "uuid",
  "email": "string",
  "provider": "string",
  "status": "string",
  "warmupDay": number,
  "reputationScore": number,
  "lastDnsCheck": { "valid": bool, "checkedAt": "iso" },
  "lastBlacklistCheck": { "clean": bool, "checkedAt": "iso" },
  "lastPlacementTest": { "primaryRate": number, "spamRate": number, "testedAt": "iso" }
}]
```

### GET /api/inboxes/:id/score-history — Reputation timeline
```
Query: ?days=90
Response 200:
{
  "inboxId": "uuid",
  "history": [{ "date": "YYYY-MM-DD", "score": number }]
}
```

### GET /api/inboxes/:id/placement — Latest placement test
```
Response 200:
{
  "testedAt": "iso",
  "results": {
    "gmail": { "primary": number, "promotions": number, "spam": number, "missed": number },
    "outlook": { "primary": number, "promotions": number, "spam": number, "missed": number }
  },
  "primaryRate": number,
  "promotionsRate": number,
  "spamRate": number,
  "verdict": "good"|"warning"|"poor"
}
```

### POST /api/inboxes/:id/placement-test — Trigger manual placement test
```
Response 202: { "jobId": "string", "estimatedMinutes": 5 }
```

### GET /api/inboxes/:id/diagnostics — Latest diagnostic report
```
Response 200:
{
  "createdAt": "iso",
  "issues": [{ "code": "string", "severity": "string", "title": "string", "fix": "string" }],
  "aiSummary": "string",
  "actionPlan": "string"
}
```

### PATCH /api/inboxes/:id — Update warmup settings
```
Request: { "warmupSpeed": "slow"|"medium"|"fast", "status": "active"|"paused" }
Response 200: { "id": "uuid", "warmupSpeed": "string", "status": "string" }
```

### DELETE /api/inboxes/:id — Disconnect inbox
```
Response 204
Side effects: removes from pool, cancels all pending jobs, purges warmup email content
```

### GET /api/dashboard — Dashboard summary
```
Response 200:
{
  "totalInboxes": number,
  "activeWarmups": number,
  "graduatedInboxes": number,
  "avgReputationScore": number,
  "alertsToday": [{ "inboxId": "uuid", "type": "string", "message": "string" }]
}
```

### POST /api/billing/portal — Stripe customer portal redirect
```
Response 200: { "url": "string" }
```

### POST /api/webhooks/clerk — Clerk user lifecycle [public, SVIX-signed]
### POST /api/webhooks/stripe — Stripe billing events [public, Stripe-signed]

---

## 5. Auth design

- **Identity provider:** Clerk
- **Session:** Clerk issues a JWT (RS256) per session. Backend validates via Clerk's JWKS endpoint.
- **NestJS guard:** `ClerkAuthGuard` — validates JWT on every protected request, attaches `userId` to request context
- **OAuth tokens for inboxes:** Stored encrypted (AES-256-GCM) in `inboxes` table. Key in GCP Secret Manager.
- **Token refresh:** BullMQ repeating job `oauth-token-refresh` runs every 45 minutes per OAuth inbox. On 401 from IMAP/SMTP, triggers immediate refresh. On refresh failure, sets inbox status = `error`, fires `token_revoked` notification.
- **Webhook verification:** Clerk webhooks verified via SVIX signature. Stripe webhooks verified via `stripe.webhooks.constructEvent`.

---

## 6. Queue design (BullMQ)

### Queue: `warmup-send`
- **Purpose:** Send warmup email from one inbox to a pool partner
- **Concurrency:** 50 workers (one per active inbox max)
- **Rate limit:** Per inbox — max N sends/hour where N = today's ramp volume / 8 hours
- **Job data:** `{ senderInboxId, receiverInboxId, subject, body, warmupDay }`
- **On failure:** Retry 3x with exponential backoff. After 3 failures, set inbox status = `error`.

### Queue: `warmup-receive`
- **Purpose:** Perform IMAP actions on a received warmup email (open, star, reply, rescue)
- **Concurrency:** 30 workers
- **Delay:** Random 2–240 minutes after send timestamp (humanisation)
- **Job data:** `{ receiverInboxId, messageId, actions: ["open","star","reply","rescue"] }`

### Queue: `dns-check`
- **Purpose:** Daily DNS audit per inbox
- **Schedule:** Cron `0 6 * * *` UTC — spawns one job per active inbox
- **Job data:** `{ inboxId }`

### Queue: `blacklist-check`
- **Purpose:** RBL check per inbox
- **Schedule:** Cron `0 */6 * * *` — every 6 hours, spawns one job per active inbox
- **Job data:** `{ inboxId }`

### Queue: `placement-test`
- **Purpose:** Weekly seed-list placement test
- **Schedule:** Cron `0 8 * * 1` (Monday 08:00 UTC) — one job per active inbox
- **Job data:** `{ inboxId, testType: "weekly"|"baseline"|"manual" }`
- **Duration:** ~5 minutes per inbox (wait for seed results)

### Queue: `diagnostics`
- **Purpose:** Run AI diagnostic analysis
- **Triggered by:** placement test with spam_rate > 20%, score drop > 10 points, manual request
- **Job data:** `{ inboxId, triggeredBy }`

### Queue: `notify`
- **Purpose:** Deliver email or Slack notification
- **Job data:** `{ userId, inboxId, type, channel, payload }`

### Queue: `oauth-token-refresh`
- **Purpose:** Proactive OAuth token refresh
- **Schedule:** Repeating every 45 minutes per OAuth inbox
- **Job data:** `{ inboxId, provider }`

---

## 7. Caching (Redis / Memorystore)

| Key pattern | Value | TTL | Invalidated by |
|---|---|---|---|
| `inbox:{id}:score:latest` | Latest reputation score (int) | 24h | Daily score computation |
| `inbox:{id}:dns:latest` | Latest DNS check result (JSON) | 24h | DNS check job completion |
| `inbox:{id}:blacklist:latest` | Latest blacklist result (JSON) | 6h | Blacklist check job completion |
| `inbox:{id}:placement:latest` | Latest placement test (JSON) | 7d | Placement test job completion |
| `user:{id}:dashboard` | Dashboard summary (JSON) | 5m | Any inbox update for this user |
| `pool:active_count` | Count of active pool members (int) | 1h | Pool member status change |

---

## 8. Warmup ramp curves

```typescript
// emails/day by warmup day and speed
const RAMP_CURVES = {
  slow: [
    { day: 1,  volume: 2  },
    { day: 4,  volume: 5  },
    { day: 8,  volume: 8  },
    { day: 14, volume: 12 },
    { day: 21, volume: 18 },
    { day: 28, volume: 25 },
    { day: 42, volume: 40 },
    { day: 56, volume: 50 },  // peak
  ],
  medium: [
    { day: 1,  volume: 3  },
    { day: 4,  volume: 8  },
    { day: 8,  volume: 15 },
    { day: 14, volume: 25 },
    { day: 21, volume: 35 },
    { day: 28, volume: 50 },  // peak
  ],
  fast: [
    { day: 1,  volume: 5  },
    { day: 4,  volume: 12 },
    { day: 8,  volume: 25 },
    { day: 14, volume: 40 },
    { day: 21, volume: 50 },  // peak
  ],
};
// Interpolate linearly between waypoints for days not explicitly listed
```

---

## 9. Reputation score algorithm

```
score = (dns_sub_score × 0.30) + (blacklist_sub_score × 0.30) + (placement_sub_score × 0.40)

dns_sub_score:
  SPF valid:    +25
  DKIM valid:   +35
  DMARC valid:  +25
  MX valid:     +10
  rDNS valid:   +5
  (total 100)
  Softfail instead of hardfail: -10

blacklist_sub_score:
  0 listings:   100
  1 listing:    40
  2+ listings:  0

placement_sub_score:
  primary_rate × 1.0 (e.g. 85% primary → 85 sub-score)
  promotions counted as 0.3 × promotions_rate
  spam_rate: each % subtracts 2 points
```

---

## 10. Deployment

### Phase 1 target: GCP Cloud Run (asia-south1)

**Services:**
- `emailwarm-api` — NestJS API container (Cloud Run, min 1 instance)
- `emailwarm-worker` — BullMQ worker container (Cloud Run, min 1 instance, max 10)
- `emailwarm-frontend` — Next.js 15 container (Cloud Run, min 0)

**Shared infrastructure (reuse dmphub):**
- Cloud SQL: New `emailwarm` database in existing instance
- Memorystore: New Redis database index in existing instance
- Secret Manager: New secrets for EmailWarm (encryption keys, API keys)
- Artifact Registry: New repository `emailwarm`

**Environment variables (all loaded from Secret Manager at runtime):**
```
DATABASE_URL
REDIS_URL
CLERK_SECRET_KEY
CLERK_WEBHOOK_SECRET
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
ENCRYPTION_KEY           # AES-256 key for OAuth tokens + SMTP passwords
ANTHROPIC_API_KEY        # Claude AI for content generation
SPAMHAUS_API_KEY
MXTOOLBOX_API_KEY
SLACK_WEBHOOK_URL        # Platform-level alerts
```

**CI/CD:** GitHub Actions → Cloud Build → push to Artifact Registry → deploy to Cloud Run
