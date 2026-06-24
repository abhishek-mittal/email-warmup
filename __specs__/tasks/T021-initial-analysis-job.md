# T021 — Initial Inbox Analysis Job

**Wave:** 7  
**Depends on:** T019, T011 (DNS check infrastructure), T014 (placement test infrastructure)  
**Skills to load:** docs/05-agent-skills/05-skill-monitoring.md, docs/05-agent-skills/06-skill-placement-test.md  

---

## Current state

When an inbox is connected today, there is no automatic health check. The user sees it appear with `status='pending'` and must manually trigger DNS checks and placement tests later. There is no consolidated initial health view per inbox.

DNS checking (T011) and placement testing (T014) already exist as separate scheduled/manual flows. This task wires them together into a single lightweight analysis job that fires automatically on any inbox add — for both inboxes-to-warm and pool inboxes.

---

## What to build

### `InboxAnalysisProcessor` — processes the `inbox-analysis` queue

**Location:** `backend/src/analysis/inbox-analysis.processor.ts`

**Job payload:**
```typescript
{
  inboxId?: string;       // set if this is an inbox-to-warm
  poolInboxId?: string;   // set if this is a pool inbox
  userId: string;
}
```

**Processing steps (in order):**

1. **Load credentials** — resolve encrypted credentials from `inboxes` or `pool_inboxes` table depending on which ID is set. Decrypt using AES-256-GCM.

2. **DNS check** — reuse `DnsService` (built in T011). Run `checkSpf`, `checkDkim`, `checkDmarc`, `checkMx`, `checkRdns` against the inbox's domain (extracted from the email address). Do not write to `dns_checks` table — this is a lightweight read-only analysis, not the full monitoring check.

3. **Health score calculation:**
   - SPF valid: +25 pts
   - DKIM valid: +25 pts
   - DMARC valid: +20 pts
   - MX valid: +15 pts
   - rDNS valid: +15 pts
   - Cap at 100

4. **Issue codes** — derive array of failing checks. Use codes: `SPF_MISSING`, `DKIM_MISSING`, `DMARC_MISSING`, `MX_MISSING`, `RDNS_MISSING`. Empty array = all passing.

5. **Placement estimate** — a quick send-and-check is out of scope for initial analysis (it takes minutes and requires seed inboxes). Instead, derive a conservative estimate from DNS health:
   - `health_score >= 80` → `'inbox'`
   - `health_score >= 50` → `'promotions'`
   - `health_score >= 20` → `'spam'`
   - `health_score < 20`  → `'unknown'`

6. **Write result** — insert one row into `inbox_analysis` table with all computed fields.

7. **Update inbox status** — if all DNS checks pass (`health_score >= 85`), set the inbox/pool inbox `status = 'active'`. If any critical check fails (SPF or DKIM missing), set `status = 'active'` anyway but surface the issues via the `inbox_analysis` row — do not block activation, let the user see the problem and fix it.

8. **No retries on DNS timeout** — if DNS resolution times out on any check, treat that field as `null` (not false) and continue. Never fail the job due to a single DNS lookup timeout.

### `AnalysisModule`

Wire `InboxAnalysisProcessor` into its own `AnalysisModule`. Import `AnalysisModule` in `app.module.ts`. Import `DnsModule` (from T011) for `DnsService` injection.

---

## Acceptance criteria

- [ ] Every inbox added via `POST /inboxes/batch` or `POST /pool-inboxes/batch` has an `inbox-analysis` job enqueued and processed — `inbox_analysis` row exists within 30 seconds of the add
- [ ] `inbox_analysis` row contains correct SPF/DKIM/DMARC/MX/rDNS boolean values for the inbox's domain
- [ ] `health_score` is computed correctly from the DNS field values
- [ ] `issues` array contains the correct issue codes for any failing DNS check
- [ ] `placement_estimate` is derived from `health_score` per the 4-tier formula
- [ ] Inbox `status` is updated to `active` after analysis completes regardless of DNS result
- [ ] A DNS lookup timeout on one check does not fail the job — field is `null`, other fields still written
- [ ] Analysis runs for pool inboxes (`pool_inbox_id` set) as well as inboxes-to-warm (`inbox_id` set)
- [ ] `GET /inboxes/:id` response includes the latest `inbox_analysis` row for that inbox
- [ ] `GET /pool-inboxes` response includes the latest `inbox_analysis` row for each pool inbox

## Mark done in SPEC-STATUS.md when all criteria above are verified
