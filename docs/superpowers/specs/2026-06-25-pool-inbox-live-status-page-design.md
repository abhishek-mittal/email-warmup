# Pool Inbox Live Status + Full-Page Detail View

**Date:** 2026-06-25
**Status:** Approved, ready for implementation plan

## Problem

The warmup pool engine genuinely opens, stars, replies to, and rescues-from-spam
warmup emails via IMAP (`WarmupReceiveProcessor`, verified live against a real
Outlook inbox during T028 testing). But the only place a user can see this
happening is the Activity tab inside `PoolInboxDetailPanel` — a 400px-wide
slide-over drawer — and that tab only shows a history of events that have
**already** completed. There is no way to see:

1. What's about to happen (a `warmup-receive` job is queued/delayed in BullMQ
   right now, with a known `executeAt` and `actions` list)
2. What's happening right now (a job is actively running)
3. Past history in a properly legible layout (the drawer is cramped —
   Pairings table and Logs viewer both feel squeezed)

This causes the reasonable impression that "nothing is happening" even when
the engine is working correctly, because warmup-receive jobs are jittered
2–240 minutes apart (`RECEIVE_DELAY_MIN_MS` / `RECEIVE_DELAY_MAX_MS` in
`warmup-send.processor.ts`) and there's currently no signal that a job is
queued and *will* run soon.

## Goals

- Make in-flight and upcoming warmup-receive activity for a pool inbox
  visible, sourced from real BullMQ job state — not simulated.
- Replace the drawer with a full-page view, consistent with the existing
  `/inboxes/[id]` activity-dashboard pattern, so Pairings/Logs/Activity get
  proper room.
- No new infrastructure (no websockets/SSE) — polling is sufficient and
  matches the existing Logs tab's "Follow" pattern already in this codebase.

## Non-goals

- True real-time push (websocket/SSE). Explicitly decided against — fast
  polling (3s) is enough given jobs are minutes apart, not sub-second.
- Changing the warmup-receive scheduling/jitter logic itself.
- Editing credentials from this page (already out of scope per T028).

## Design

### 1. New route: `/pool/[id]` (full-page, replaces the drawer)

Mirrors `frontend/src/app/(dashboard)/inboxes/[id]/page.tsx` structure:

- Server component (`page.tsx`) calls `currentUserId()` (redirect to
  `/sign-in` if absent) and `serverApi<PoolInboxResponse>('/pool-inboxes/:id')`
  for the row; `notFound()` on a 404 (not found or not owned).
- Renders a page header: email, provider, readiness badge (reusing
  `ReadinessBadge`), "added" date.
- Renders `<ConnectionSummaryStrip poolInboxId={id} />` (already exists,
  unchanged) below the header.
- Renders the new `<LiveStatusPanel poolInboxId={id} />` (see §2).
- Renders a tab bar mirroring `InboxDashboardTabs`: **Health, Activity,
  Pairings, Logs** — same 4 tabs as today's drawer, same components
  (`PoolActivityTab`, `PoolPairingsTab`, `PoolLogsTab`, plus the Health
  content currently inlined in `PoolInboxDetailPanel`), just full-width.

**Files removed:** `PoolInboxDetailPanel.tsx` (the drawer shell). Its Health
tab content moves into a new `PoolHealthTab.tsx` so it has the same
component-per-tab shape as the others.

**Files changed:**
- `PoolInboxGrid.tsx` — row click becomes `router.push(`/pool/${p.id}`)`
  instead of `setSelected(p)`; the `selected` state and inline
  `<PoolInboxDetailPanel>` render are deleted.

**Files added:**
- `frontend/src/app/(dashboard)/pool/[id]/page.tsx`
- `frontend/src/app/(dashboard)/pool/[id]/_components/PoolDetailTabs.tsx`
  (tab bar shell, mirrors `InboxDashboardTabs`)
- `frontend/src/app/(dashboard)/pool/[id]/_components/PoolHealthTab.tsx`
  (Health tab content, extracted from the old drawer's `HealthTab` function)
- `frontend/src/app/(dashboard)/pool/[id]/_components/LiveStatusPanel.tsx`

`PoolActivityTab`, `PoolPairingsTab`, `PoolLogsTab`, `ConnectionSummaryStrip`
stay in `pool/_components/` (they're not page-specific) and get imported into
the new `pool/[id]/_components/` tree — no file moves needed for these four.

### 2. Live Status panel — new section, above the tab bar

**Purpose:** answer "is anything happening with this pool inbox right now."

**New backend endpoint:** `GET /pool-inboxes/:id/live-status`

Implementation: reads BullMQ job state directly via `QueueService`, no DB
query needed for the job data itself (DB is only used for the existing
ownership check, same `assertPoolOwnership` already used by the other 5
T028 endpoints).

```ts
// Returned shape
interface PoolLiveStatus {
  active: LiveJob[];     // jobs currently processing (BullMQ state 'active')
  upcoming: LiveJob[];   // jobs queued/delayed, sorted by executeAt ascending, max 5
}

interface LiveJob {
  jobId: string;
  actions: ('open' | 'star' | 'reply' | 'rescue')[];
  senderEmail: string | null;  // resolved from warmup_sends via messageId, best-effort
  executeAt: string;           // ISO timestamp
  state: 'active' | 'delayed' | 'waiting';
}
```

Backend logic (`PoolInboxActivityService.getLiveStatus`, same module as the
existing 5 endpoints):

1. `assertPoolOwnership(id, userId)` — existing helper, unchanged.
2. `queueService.getQueue('warmup-receive')` needs a new accessor — today
   `QueueService` only exposes `add`/`getJobCounts`/`removeJobsFor*`. Add a
   `getJobsForReceiver(queueName, receiverId, states)` method that calls
   `queue.getJobs(states)` and filters `data.receiverId === receiverId`
   (mirrors the existing filter logic in `removeJobsForReceiver`, which
   filters on `data.receiverInboxId` for the shared-pool case — private-pool
   jobs use `data.receiverId` per `warmup-send.processor.ts` §`enqueueReceiveJob`).
3. Fetch `active` + `delayed` + `waiting` jobs for this pool inbox. Each
   job's payload carries `messageId` (set at enqueue time in
   `warmup-send.processor.ts`). Batch-resolve `senderEmail` by querying
   `warmup_sends` where `messageId IN (...)` (one query for all jobs) to get
   each row's `senderInboxId`, then a second batched query against `inboxes`
   for the emails — same two-step resolve pattern already used by
   `PoolInboxActivityService.getActivity`. Best-effort: null if no matching
   row (shouldn't happen since the send row is created before the receive
   job is enqueued, but a job whose send row is somehow missing should not
   break the panel).
4. Sort `upcoming` (delayed/waiting) by `executeAt` ascending, cap at 5.
5. Return `{ active, upcoming }`.

**Frontend component:** `LiveStatusPanel.tsx`

- Polls `/pool-inboxes/:id/live-status` every 3s while the page is mounted
  (same `useEffect` + `setInterval` + cleanup pattern as `PoolLogsTab`'s
  Follow mode — no new pattern introduced).
- Renders using the existing `<PulseDot>` component:
  - `active.length > 0` → `state="live"`, e.g. "Opening + starring email
    from sender@x.com — started 4s ago" (relative time computed client-side
    from a job-start timestamp; BullMQ job `processedOn` gives this).
  - `active.length === 0 && upcoming.length > 0` → `state="idle"`, list up
    to 5 upcoming entries: "Will open + reply to sender@y.com in 12 min"
    (relative time from `executeAt`).
  - both empty → `state="idle"`, single line: "No warmup activity scheduled
    right now — jobs run on a jittered 2–240 minute delay after each send."
    (the explicit delay range sets expectations so an empty panel doesn't
    read as broken).
- No "Load more" / pagination — capped at 5 upcoming by design, this is a
  glance-level status indicator, not a full job list.

### 3. Tab order on the new page

Live Status panel (always visible, not a tab) → tab bar: **Activity** (default,
history) → **Health** → **Pairings** → **Logs**. Activity becomes the default
tab (was Health in the old drawer) so the page reads top-to-bottom as
"happening now → just happened" without a tab switch.

## Data flow summary

```
BullMQ 'warmup-receive' queue
        │
        │ getJobs(['active','delayed','waiting'])
        │ filter by data.receiverId === poolInboxId
        ▼
QueueService.getJobsForReceiver()  (new method)
        ▼
PoolInboxActivityService.getLiveStatus()  (new method, existing module)
        ▼
GET /pool-inboxes/:id/live-status  (new endpoint, existing controller)
        ▼
LiveStatusPanel.tsx  (new component, polls every 3s)
```

## Testing

- Backend: unit tests for `QueueService.getJobsForReceiver` (mock `Queue`,
  assert correct filter on `receiverId`) and
  `PoolInboxActivityService.getLiveStatus` (ownership 404, empty case, active
  + upcoming sorting, senderEmail resolution) — same patterns as the existing
  14 tests in `pool-inbox-activity.service.spec.ts`.
- Frontend: no test framework exists in this project (confirmed during T028
  verification) — verify live via Playwright against the dev stack:
  enqueue a real `warmup-receive` job with a future `delay`, load
  `/pool/[id]`, confirm it appears in "Upcoming" with the correct countdown,
  confirm it disappears (and ideally shows in "Active" briefly, history-
  permitting given the 3s poll) once the job is picked up by the worker.
- Manual check: full backend suite + frontend typecheck/lint/build clean,
  per this project's existing verification bar.

## Open questions resolved during brainstorming

- **Live mechanism:** fast polling (3s), not websockets/SSE — confirmed by
  user, justified by job spacing (minutes, not seconds).
- **Page vs. drawer:** dedicated `/pool/[id]` route, matching the existing
  `/inboxes/[id]` pattern exactly — confirmed by user.
- **Live Status placement:** new section above Activity tab, not merged
  into the Activity timeline — confirmed by user, keeps past vs. future
  visually distinct.
