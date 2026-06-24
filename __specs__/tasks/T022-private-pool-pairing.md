# T022 — Private Pool Pairing Engine Pivot

**Wave:** 7  
**Depends on:** T019, T010 (PairingService), T020 (pool_inboxes table populated)  
**Skills to load:** docs/05-agent-skills/04-skill-warmup-engine.md  

---

## Current state

`PairingService` (built in T010) selects warmup partners from the `pool_members` table, which is a tenant-shared pool. A warmup inbox is paired with pool inboxes belonging to other users who have given pool consent. Without other users in the system, `selectPartner()` returns nothing and no warmup sends can be scheduled.

The pairing rules currently enforced:
- Same-domain pairs are blocked (hard block)
- Partners scored by recent usage with a 7-day recency penalty
- `pool_consent_at` must be non-null before an inbox can be enrolled

---

## What to build

Update `PairingService.selectPartner()` to check the tenant's **own** pool inboxes first before falling back to the shared pool. This is a source pivot — the pairing algorithm and all existing rules stay identical.

### Updated `selectPartner(inbox, userId)` logic

```
1. Query pool_inboxes WHERE user_id = userId AND status = 'active'
   Filter: domain(pool_inbox.email) != domain(inbox.email)   ← same-domain hard block
   Score:  prefer pool inboxes with lower active_pairs count
           prefer pool inboxes not used in last 7 days for this warmup inbox
   Select: top candidate

2. If no private pool inbox qualifies (empty pool, all same domain, all at capacity):
   Fall back to shared pool_members (existing behaviour — unchanged)

3. If neither source yields a partner:
   Return null → calling code skips this send slot (existing behaviour)
```

### `active_pairs` maintenance

When a pairing is established (a `warmup-send` job is enqueued with this pool inbox as sender):
- Increment `pool_inboxes.active_pairs` by 1

When a warmup send completes or the paired inbox is deactivated:
- Decrement `pool_inboxes.active_pairs` by 1 (min 0)

This counter is a best-effort approximation — do not make it transactionally precise. A background cron can recompute it if needed. For now: increment on job enqueue, decrement on job completion or inbox status change.

### Pool enrollment for pool inboxes

Pool inboxes (in `pool_inboxes`) do NOT go through `pool_members` enrollment. They are immediately available as pairing candidates once their `status = 'active'` (set by T021 analysis completion).

The existing `pool_consent_at` check only applies to inboxes-to-warm (inboxes table). Pool inboxes are operator-controlled by the tenant — no separate consent gate needed.

### No changes to pairing algorithm itself

The 8-minute spacing rule, ±15min jitter, and `checkGraduation` logic in `WarmupService` are completely unchanged. The only change is the partner source in `selectPartner`.

---

## Acceptance criteria

- [ ] `selectPartner()` queries `pool_inboxes` (user's private pool) first when `userId` is provided
- [ ] Same-domain hard block is applied to private pool matches (domain of pool inbox != domain of inbox being warmed)
- [ ] Private pool inboxes with lower `active_pairs` count are preferred over those with higher count
- [ ] If private pool yields no valid partner, fallback to `pool_members` shared pool (existing behaviour unchanged)
- [ ] If neither pool yields a partner, `selectPartner()` returns null and the send slot is skipped (existing behaviour unchanged)
- [ ] `pool_inboxes.active_pairs` increments when a pairing is made, decrements on completion
- [ ] A tenant with 3 pool inboxes (all different domains from the inbox being warmed) can warm their inbox without any other users in the system
- [ ] A tenant with only same-domain pool inboxes falls through to the shared pool (not silently blocked)
- [ ] All existing `PairingService` unit tests still pass

## Mark done in SPEC-STATUS.md when all criteria above are verified
