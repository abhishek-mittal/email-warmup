# T003 — BullMQ + Redis Setup

**Wave:** 0  
**Depends on:** T001  
**Skills to load:** docs/05-agent-skills/04-skill-warmup-engine.md (queue section)

---

## What to build

Create the BullMQ module and define all 8 queues. This is infrastructure only — processors are added in later waves.

### QueueModule (`backend/src/queue/`)

- `queue.module.ts` — registers all queues as BullMQ Queue instances via NestJS DI
- `queue.service.ts` — exports typed `add()` wrappers for each queue (type-safe job payload)
- Redis connection via `ioredis` using `REDIS_URL` env var

### 8 queues to register

| Queue name | Purpose | Concurrency (for later processors) |
|---|---|---|
| warmup-send | Send warmup emails | 50 |
| warmup-receive | Simulate engagement on received emails | 50 |
| dns-check | DNS health checks | 20 |
| blacklist-check | RBL blacklist checks | 10 |
| placement-test | Seed list placement analysis | 5 |
| score-compute | Reputation score computation | 20 |
| notify | Email + Slack notifications | 30 |
| token-refresh | OAuth token refresh jobs | 10 |

### Job retention config (applies to all queues)

```
completed: { count: 1000, age: 86400 }    ← keep 1000 completed, max 24 hours
failed:    { count: 500,  age: 259200 }   ← keep 500 failed, max 72 hours
```

### BullMQ Board (optional, dev only)

If time permits: mount `@bull-board/api` at `/admin/queues` behind a dev-only guard.

---

## Acceptance criteria

- [ ] All 8 queues connect to Redis on startup without errors
- [ ] `queueService.add('warmup-send', payload)` adds a job observable in BullMQ dashboard
- [ ] Redis connection drops and reconnects without crashing the NestJS process (ioredis auto-reconnect)
- [ ] Queue names in code match exactly the names listed above (no typos — other specs reference them by name)
- [ ] Job retention settings applied — old completed jobs do not accumulate unbounded

## Mark done in SPEC-STATUS.md when all criteria above are verified
