# T019 — Pool Inboxes Table + Private Pool Schema Migration

**Wave:** 7  
**Depends on:** T002 (base schema), T010 (warmup engine — pool_members table exists)  
**Skills to load:** docs/05-agent-skills/01-skill-database.md  

---

## Current state

The warmup engine currently sources its pool from the `pool_members` table, which is populated by other tenants who have joined and given consent. There is no concept of a tenant owning their own private pool of inboxes for warmup purposes. A tenant with zero other users in the system cannot warm any inbox at all.

The `pool_members` table ties pool participation to `userId` — it assumes the pool inbox belongs to the same user whose warmup is running. It has no concept of a separately managed pool distinct from inboxes being warmed.

---

## What to build

### New table: `pool_inboxes`

A tenant-owned private pool. These are inboxes the tenant controls that act as the other side of all warmup conversations. They are never warmed themselves — they only send, receive, open, reply, and rescue.

```sql
CREATE TABLE pool_inboxes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT NOT NULL,           -- tenant who owns this pool inbox
  email         TEXT NOT NULL,
  provider      TEXT NOT NULL,           -- 'gmail' | 'outlook' | 'custom'
  status        TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'active' | 'error'
  display_name  TEXT,
  encrypted_credentials JSONB NOT NULL,  -- same AES-256-GCM structure as inboxes table
  last_used_at  TIMESTAMPTZ,
  active_pairs  INTEGER NOT NULL DEFAULT 0,  -- count of inboxes currently paired with this pool inbox
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pool_inboxes_user_id ON pool_inboxes(user_id);
CREATE INDEX idx_pool_inboxes_status  ON pool_inboxes(status);
CREATE UNIQUE INDEX idx_pool_inboxes_email ON pool_inboxes(email);
```

### New table: `inbox_analysis`

Stores the result of the initial health analysis that runs automatically when any inbox (to-warm or pool) is added.

```sql
CREATE TABLE inbox_analysis (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id       UUID,                   -- references inboxes.id (nullable — pool inboxes have no inboxes.id)
  pool_inbox_id  UUID,                   -- references pool_inboxes.id (nullable — only set for pool inboxes)
  spf_valid      BOOLEAN,
  dkim_valid     BOOLEAN,
  dmarc_valid    BOOLEAN,
  mx_valid       BOOLEAN,
  rdns_valid     BOOLEAN,
  placement_estimate TEXT,              -- 'inbox' | 'promotions' | 'spam' | 'unknown'
  health_score   INTEGER,               -- 0-100 composite of DNS fields
  issues         TEXT[],                -- array of issue code strings
  analysed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_inbox_analysis_inbox_id      ON inbox_analysis(inbox_id);
CREATE INDEX idx_inbox_analysis_pool_inbox_id ON inbox_analysis(pool_inbox_id);
```

### New BullMQ queue: `inbox-analysis`

Add `'inbox-analysis'` to `QUEUE_NAMES` in `queue/queue.service.ts`. This queue is consumed by T021.

### Migration

Add as a new Drizzle migration file. Do NOT edit any existing migration. Migration must be append-only.

---

## Acceptance criteria

- [ ] `pool_inboxes` table exists with all columns and indexes after migration
- [ ] `inbox_analysis` table exists with all columns and indexes after migration
- [ ] `inbox-analysis` added to `QUEUE_NAMES` in `queue.service.ts`
- [ ] Migration applies cleanly (`npm run db:migrate`) with no errors
- [ ] No existing migration files were modified — only a new file added
- [ ] `inboxes` table and `pool_members` table are completely unchanged

## Mark done in SPEC-STATUS.md when all criteria above are verified
