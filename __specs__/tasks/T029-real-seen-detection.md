# T029 — Detect real human opens via on-demand IMAP \Seen refresh

**Wave:** 13
**Priority:** P1
**Depends on:** T008, T009, T025, T027
**Skill files to load:** `docs/05-agent-skills/03-skill-inbox-connection.md`, `docs/05-agent-skills/04-skill-warmup-engine.md`, `docs/05-agent-skills/11-skill-logging.md`

---

## 1. Problem

`openedAt` on `warmup_sends` is currently written **only** by `warmup-receive.processor.ts:151` when our worker simulates an open via `messageFlagsAdd(..., ['\\Seen'])`. If a real human (the pool inbox owner, or the inbox's real user) opens the warmup email in Gmail/Outlook/Yahoo web UI, we never see it — the `\Seen` flag flip is invisible to us, so the activity feed undercounts opens, the open-rate placement tier is wrong, and `ScoreService.computePlacementScore()` (T013) returns a lower number than reality.

This is the **only** mechanism for getting an honest "did the email actually get opened" signal. Tracking pixels and link-traps are out of scope here — see the security writeup at `docs/06-discussions/2026-06-24-real-open-detection-options.md` for why.

**Design decision (per Abhishek 2026-06-24):** no background cron. The refresh fires **on-demand** when the inbox detail page loads, behind a "Refresh real opens" button (and on initial page mount). One IMAP round-trip per click, capped, idempotent, easy to reason about. If we later want a background scanner, that's a T030 follow-on that does not change this endpoint's contract.

## 2. After state

### Path A — opportunistic detection in the existing receive worker (kept)

In the existing `WarmupReceiveProcessor.process()`, **before** the worker adds `['\Seen']` itself, snapshot the message's existing flags via `client.fetchOne(...)`. If `\Seen` was already true on a message whose `openedAt` is null, treat it as a real human open:
- Set `openedAt = now()` (do NOT call `messageFlagsAdd` — the flag is already on)
- Skip the simulated-open action for this run
- Log `action: 'open_skipped_already_seen'` at debug

This catches the case where a pool owner opened the email between send-time and receive-worker-time (typically 2-15 minutes after send).

### Path B — synchronous on-demand refresh (new)

A new `POST /inboxes/:id/refresh-real-opens` endpoint that:
1. Loads up to **50** recent `warmup_sends` rows for this inbox where `openedAt IS NULL` AND `createdAt > now() - 30 days` (bounded window — we don't scan ancient history)
2. For each row, IMAP SEARCH the receiver's WarmupHub folder for the `X-WarmupHub-Message-Id` header (or fall back to subject match if header is missing — both already exist in the warmup-receive flow)
3. If found AND `\Seen` is set AND `openedAt` is still null → write `openedAt = now(), opened_source = 'imap_rescan'`
4. Return `{ checked: number, newlyOpened: number, durationMs: number }`

The endpoint is **synchronous** (not a queue job) — typical scan is 5-30 IMAP SEARCH+FETCH calls, completes in ~500ms-3s. Frontend shows a small spinner while it runs.

If the IMAP call fails for any reason (transient network, auth expired, etc.), the endpoint returns `{ checked: 0, newlyOpened: 0, error: '<reason>' }` with HTTP 200 — never 5xx. A failed refresh is non-fatal; the next click retries.

### Path B frontend wiring

- On mount of `/inboxes/[id]`, fire `POST /inboxes/:id/refresh-real-opens` silently (no spinner — UI updates as new events arrive on the activity feed)
- Add a `<RefreshRealOpensButton />` next to the activity feed tab header — manual trigger with a small spinner
- New real-open events appear in the activity feed via `router.refresh()` after the endpoint returns
- Show a small toast: "Detected N real open(s)" if `newlyOpened > 0`

### New schema column

Single additive migration `0005_real_seen_detection.sql`:

```sql
-- Distinguishes our simulated opens from real human opens.
-- 'simulated' = we set \Seen ourselves via the warmup-receive worker.
-- 'imap_rescan' = detected via the on-demand IMAP refresh endpoint.
ALTER TABLE warmup_sends
  ADD COLUMN opened_source text
    CHECK (opened_source IN ('simulated', 'imap_rescan'));
-- NULL means "not opened yet" — matches the existing openedAt IS NULL contract.
```

No new tables needed. No cursor — the bounded 50-row window keeps the scan cheap.

No backfill — existing rows keep `opened_source=NULL` and `openedAt` unchanged. The activity service renders `opened_source` only when non-null.

### Activity feed rendering

T027's `ActivityService.getActivity` already fans out `openedAt` to an `opened` event. The event payload gains one new field:

```ts
{ type: 'opened', openedAt: '...', subject: '...', receiverEmail: '...',
  openedSource: 'simulated' | 'imap_rescan' | null }
```

Frontend `<ActivityFeedTab>` renders a small chip next to the open icon:
- `simulated` → invisible (default case, the existing look)
- `imap_rescan` → light-blue chip "Real open" so the user can tell the two apart

## 3. Out of scope (deliberately)

- Background cron / scheduler (T030 candidate — see security writeup Option D)
- Tracking pixels / 1x1 GIFs — security writeup covers why
- Link-traps / unique redirect URLs — security writeup covers why
- Gmail Push / MS Graph webhook subscriptions — T030 candidate
- Scanning more than 30 days of history — the activity feed is bounded to the same window anyway
- Scanning `inbox_analysis` table or pool_inboxes — these never receive warmup emails
- Removing `source='simulated'` rows — historical data must remain for score history reproducibility

## 4. Acceptance criteria

### Functional
1. `WarmupReceiveProcessor.process()` detects pre-existing `\Seen` flag on the message before its own `messageFlagsAdd`, sets `openedAt` if null, and logs `action='open_skipped_already_seen'`
2. New `POST /inboxes/:id/refresh-real-opens` endpoint scans up to 50 recent unopened `warmup_sends` rows for this inbox and writes `openedAt = now(), opened_source = 'imap_rescan'` for any where the IMAP `\Seen` flag is set
3. Endpoint response is `{ checked: number, newlyOpened: number, durationMs: number, error?: string }`, HTTP 200 — even on IMAP failure (non-fatal, retried on next click)
4. Endpoint is ownership-checked (`ActivityService.assertOwnership`-style 404 for not-yours)
5. After the endpoint runs, `GET /inboxes/:id/activity` returns an `opened` event with `openedSource: 'imap_rescan'` for each newly detected real open
6. The receive worker's existing simulated-open path keeps working unchanged; `openedSource: 'simulated'` for those rows
7. Frontend `<RefreshRealOpensButton />` calls the endpoint on click and on inbox-detail mount; shows spinner during the call; fires `router.refresh()` after success; shows a toast if `newlyOpened > 0`

### Non-functional
8. Per-click IMAP workload bounded at **50 messages** (configurable via `WARMUP_REFRESH_BATCH_SIZE` env var, default 50)
9. Window bounded at **30 days** (configurable via `WARMUP_REFRESH_WINDOW_DAYS`, default 30) — matches the activity feed window
10. Total endpoint latency under **5 seconds** for the 50-row batch (sanity: 50 × ~100ms SEARCH/FETCH ≈ 5s)
11. No new IMAP connection per click — uses the existing `ImapClientService.getConnection` pool
12. No new SMTP traffic — receive path only
13. Skipped entirely for inboxes with `status='removed'` or `status='error'` (404 from the controller)
14. Skipped entirely for inboxes without IMAP configured (`ImapNotConfiguredError` → response with `error: 'IMAP not configured'`, HTTP 200, no rows updated)
15. Skipped entirely for custom-SMTP inboxes that didn't opt into IMAP receive (same `ImapNotConfiguredError` handling)

### Tests
16. `ActivityService.refreshRealOpens(userId, inboxId)` unit tests (mocked IMAP) — at minimum:
    - inbox not owned → throws NotFoundException
    - inbox with `status='removed'` → throws NotFoundException
    - 0 unopened rows → returns `{checked:0, newlyOpened:0, durationMs:N}`
    - 3 unopened rows, all `\Seen` set → returns `{checked:3, newlyOpened:3, durationMs:N}` + all 3 rows have `openedAt` set, `opened_source='imap_rescan'`
    - 3 unopened rows, 1 with `\Seen` → returns `{checked:3, newlyOpened:1}` + 1 row updated
    - 3 unopened rows, none `\Seen` → returns `{checked:3, newlyOpened:0}` + 0 rows updated
    - row with `openedAt IS NOT NULL` is NOT in the scan set (only unopened rows)
    - IMAP call throws → returns `{checked:0, newlyOpened:0, error:'<msg>'}` with no exception
    - `ImapNotConfiguredError` → returns `{checked:0, newlyOpened:0, error:'IMAP not configured'}`
17. `WarmupReceiveProcessor` (existing test file) gains one new test: pre-existing `\Seen` → `openedAt` set + `messageFlagsAdd` NOT called

### Quality gates
18. `npm run test` — backend suite green (was 527/527)
19. `npm run lint` + `npx tsc --noEmit` — clean
20. Live boot — new endpoint mounted at `POST /inboxes/:id/refresh-real-opens`, 401 without bearer
21. Manual E2E: connect a real Gmail test inbox, send a warmup email, open it in Gmail web UI, refresh the inbox detail page, verify the open appears in the activity feed with the "Real open" chip within 5 seconds

## 5. Files affected

### New
- `backend/src/db/migrations/0005_real_seen_detection.sql`
- `backend/src/activity/refresh-real-opens.spec.ts` (lives alongside activity.service.spec.ts)
- `frontend/src/app/(dashboard)/inboxes/[id]/_components/RefreshRealOpensButton.tsx`
- `frontend/src/app/(dashboard)/inboxes/[id]/_components/OpenedSourceChip.tsx`

### Modified
- `backend/src/warmup/warmup-receive.processor.ts` — add pre-snapshot of `\Seen` flag, conditional `messageFlagsAdd`, new debug log
- `backend/src/warmup/warmup-receive.processor.spec.ts` — add 1 test (the pre-existing-\Seen case)
- `backend/src/activity/activity.service.ts` — new `refreshRealOpens()` method + read `opened_source` in the existing `getActivity` SELECT, surface it in the activity payload
- `backend/src/activity/activity.controller.ts` — new `POST /inboxes/:id/refresh-real-opens` endpoint
- `frontend/src/app/(dashboard)/inboxes/[id]/page.tsx` — fire silent refresh on mount + render `<RefreshRealOpensButton />` in the activity tab
- `frontend/src/app/(dashboard)/inboxes/[id]/_components/ActivityFeedTab.tsx` — render `<OpenedSourceChip>` when `openedSource='imap_rescan'`
- `backend/.env.example` + `frontend/.env.example` — add `WARMUP_REFRESH_BATCH_SIZE=50`, `WARMUP_REFRESH_WINDOW_DAYS=30`

## 6. Security & abuse notes

The new endpoint is a pure IMAP consumer — it never sends mail, never opens links, never makes outbound HTTP. Attack surfaces:

1. **Token theft** — uses the existing AES-256-GCM-encrypted OAuth refresh tokens; never decrypts SMTP/IMAP passwords (it uses `XOAUTH2` for Gmail/Outlook, raw IMAP login only for custom-SMTP tenants, reusing the existing `getConnection` pool)
2. **IMAP quota / rate limits** — 50 messages/click cap, user-triggered only (not background), so worst case is one user hammering the button on their own inbox. We should rate-limit the endpoint at 1 call / 3 seconds / inbox to prevent accidental UI thrashing
3. **DoS** — the endpoint is auth-guarded, ownership-checked, and rate-limited; an attacker would need a valid session and a real inbox they own to abuse it
4. **Storage leakage** — no new tables, no message content stored; only `opened_source` enum

No new public endpoints beyond this one auth-guarded POST. No new schemas beyond the enum column. The 30-day scan window matches the activity feed's existing window so there's no data asymmetry risk.

### Rate limiting

Add a per-inbox rate limit of **1 call / 3 seconds** (in-memory LRU keyed on `inboxId`, scoped to the controller). If exceeded, return `429 Too Many Requests` with a `Retry-After` header. This is implemented inline in the controller — no new dependency, no Redis hop.