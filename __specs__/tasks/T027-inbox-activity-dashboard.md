# T027 — Inbox Activity Dashboard

**Wave:** 11  
**Priority:** P0  
**Depends on:** T008, T009, T011, T012, T013, T025  
**Skill files to load:** `docs/05-agent-skills/10-skill-frontend.md`, `docs/05-agent-skills/11-skill-logging.md`

---

## 1. Current state (before this change)

The inbox detail page at `/inboxes/[id]` shows:
- The inbox email address and provider/status as a header
- A single number for the reputation score
- A "Run Placement Test" button
- A text link to `/inboxes/[id]/diagnostics`

Nothing else. The user has zero visibility into:
- What warmup emails have been sent from this inbox
- Who they were sent to (which pool inbox received them)
- What actions were taken on those emails (opened, starred, replied, rescued from spam)
- Whether any email landed in spam
- The history of DNS checks over time
- The history of blacklist checks over time
- The score trend over time
- Any system-level log events for this inbox

All of this data exists in the database (`warmup_sends`, `dns_checks`, `blacklist_checks`, `reputation_scores`, `diagnostics`) but none of it is surfaced to the user.

---

## 2. After state (what changes)

The inbox detail page becomes a full activity dashboard with five tabbed sections. The reputation score is expanded into a trend chart. The page header gains a live status indicator.

### Page header (always visible)
| Before | After |
|---|---|
| Email + provider/status as plain text | Email + provider + animated pulse dot (green=active, amber=paused, red=error) + warmup day badge (e.g. "Day 14") |
| Single score number in a card | Score number + trend arrow (↑↓→) + score history sparkline (last 30 days) |

### Tabs
| Tab | What it shows |
|---|---|
| **Activity Feed** | Chronological log of all warmup events for this inbox — sends, opens, replies, rescues, spam landings |
| **Sent Emails** | Table of every warmup email sent from this inbox with full detail |
| **DNS & Blacklist** | DNS check history + blacklist check history, side by side |
| **Placement** | Placement test results over time |
| **Logs** | Raw structured log stream for this inbox, filterable by level |

---

## 3. Target components / entry points

1. **`/inboxes/[id]/page.tsx`** — the inbox detail page. This is the root entry point. It currently has ~45 lines. It needs to be expanded into a tabbed layout. All new content goes here and in sub-components.
2. **New directory:** `frontend/src/app/(dashboard)/inboxes/[id]/_components/` — create all new components here.
3. **Backend:** new API endpoints under `/inboxes/:id/` — see section 6.

---

## 4. Tab-by-tab UX specification

---

### Tab 1 — Activity Feed

**Purpose:** Give the user a single chronological view of everything that happened to this inbox. Like a Twitter/X timeline but for warmup events.

**Layout:** Vertical timeline. Each event is a row with:
- A coloured icon on the left (see event types below)
- Event description in plain English
- Timestamp (relative: "2 hours ago", absolute on hover)
- Optional detail chip (e.g. subject line, pool inbox email, spam folder name)

**Event types and their display:**

| Event type | Icon colour | Description template |
|---|---|---|
| `sent` | Blue | "Sent warmup email to `{receiver_email}` · Subject: `{subject}`" |
| `opened` | Green | "Warmup email opened by `{receiver_email}`" |
| `replied` | Green | "Reply received from `{receiver_email}`" |
| `starred` | Amber | "Email starred by `{receiver_email}`" |
| `rescued` | Purple | "Email rescued from spam by `{receiver_email}`" |
| `spam_landed` | Red | "Email landed in spam at `{receiver_email}`" |
| `filed` | Slate | "Email filed to WarmupHub folder" |
| `dns_check` | Blue | "DNS check completed · Score: `{score}`" |
| `blacklist_check` | Blue or Red | "Blacklist check: clean" or "Blacklist check: listed on `{n}` RBLs" |
| `score_updated` | Teal | "Reputation score updated: `{prev}` → `{new}` (`{trend}`)" |

**Pagination:** Load 50 events at a time. "Load more" button at the bottom. Most recent first.

**Empty state:** "No warmup activity yet. Warmup emails will appear here once the engine starts sending for this inbox."

---

### Tab 2 — Sent Emails

**Purpose:** Full table of every warmup email sent FROM this inbox. User can see exactly what was sent, to whom, and what happened to it.

**Table columns:**

| Column | Source field | Notes |
|---|---|---|
| Date | `warmup_sends.sent_at` | Format: "Jun 20, 14:32" |
| To | `warmup_sends.receiver_inbox_id` or `receiver_pool_inbox_id` | Show the email address of the receiver |
| Subject | `warmup_sends.subject` | Full subject line, truncated to 60 chars |
| Warmup Day | `warmup_sends.warmup_day` | Badge: "Day 7" |
| Opened | `warmup_sends.opened_at` | ✓ with relative time, or — |
| Replied | `warmup_sends.replied_at` | ✓ or — |
| Starred | `warmup_sends.starred_at` | ✓ or — |
| Rescued | `warmup_sends.rescued_at` | ✓ or — |
| Spam | `warmup_sends.landed_in_spam` | Red "Spam" badge or — |
| Tab | `warmup_sends.landed_in_tab` | "Primary" / "Promotions" / "Spam" chip or — |

**Row expand:** Clicking any row expands it to show:
- Full subject line
- Message ID
- Scheduled at vs sent at (latency)
- Filed at (when it was filed to WarmupHub folder)

**Filters (above table):**
- Date range picker (last 7 days / 30 days / all time)
- Status filter: All / Opened / Replied / Rescued / Landed in Spam

**Pagination:** 25 rows per page, standard prev/next controls.

**Empty state:** "No emails sent yet from this inbox."

---

### Tab 3 — DNS & Blacklist

**Layout:** Two side-by-side cards (stack on mobile).

**Left card — DNS History:**

Most recent DNS check displayed as a status grid:

| Check | Status | Value |
|---|---|---|
| SPF | ✓ Valid / ✗ Invalid | SPF record string |
| DKIM | ✓ Valid / ✗ Invalid | Selector used |
| DMARC | ✓ Valid / ✗ Invalid | DMARC record string |
| MX | ✓ Valid / ✗ Invalid | MX records list |
| rDNS | ✓ Valid / ✗ Invalid | PTR value |

Below the grid: a small history list showing the last 5 DNS check scores with timestamps (e.g. "Jun 20 · Score 85", "Jun 15 · Score 70") — so the user can see if their DNS health is improving.

**Right card — Blacklist History:**

Most recent check displayed as:
- Large status: "✓ Clean" (green) or "⚠ Listed on N RBLs" (red)
- Checked at timestamp
- If listed: expandable list of which RBLs flagged it

Below: history of last 5 blacklist checks with timestamps and clean/listed status.

**Re-run buttons:** "Run DNS Check Now" and "Run Blacklist Check Now" buttons in each card header. These call the backend to enqueue an immediate check job for this inbox.

---

### Tab 4 — Placement

**Purpose:** Show placement test results over time — where are warmup emails landing (Primary inbox, Promotions tab, Spam)?

**Layout:** A horizontal bar chart showing the most recent placement result:
- Primary (green): `{primaryPct}%`
- Promotions (amber): `{promotionsPct}%`
- Spam (red): `{spamPct}%`
- Missing (slate): `{missingPct}%`

Below the chart: a history table of all placement tests:

| Date | Seeds Sent | Primary | Promotions | Spam | Missing | Score |
|---|---|---|---|---|---|---|
| Jun 20 | 12 | 75% | 17% | 8% | 0% | 82 |

**Empty state:** "No placement tests run yet. Click 'Run Placement Test' to start."

The existing "Run Placement Test" button moves into this tab.

---

### Tab 5 — Logs

**Purpose:** Show the raw structured log stream for this inbox — exactly what the backend logged for every operation touching this inbox. This is for the user to understand what's happening under the hood and for debugging.

**Layout:** Terminal-style log viewer.

- Dark background, monospace font
- Each line: `[LEVEL] [TIME] [CONTEXT] MESSAGE {fields}`
- Level colour coding: INFO = green, WARN = amber, ERROR = red, DEBUG = slate
- Auto-scroll to bottom (toggle: "Follow" button)

**Filter bar above the log:**
- Level selector: All / INFO / WARN / ERROR / DEBUG
- Search box: free-text grep across all fields
- Time range: Last 15 min / 1 hour / 6 hours / 24 hours / All

**How it works:**
- Backend endpoint: `GET /inboxes/:id/logs?level=&since=&search=&limit=`
- Returns the last N structured log lines where `inboxId = {id}` from the NDJSON log file (`.bin/.runtime/backend.ndjson`)
- Frontend polls every 5 seconds when "Follow" is on, otherwise static load on tab open
- Limit: 200 lines maximum in the viewer at any time (oldest drop off when Follow is on)

**Empty state:** "No log entries found for this inbox. Logs appear here once warmup activity starts."

---

## 5. Score history chart (page header)

Replace the bare score number with:
- The current score as a large number (same as before)
- A trend arrow: ↑ if last 3 scores are rising, ↓ if falling, → if flat
- A mini line chart (last 30 days of `reputation_scores.score`) directly below the number
- Chart is small (120px tall), no axes labels, just the curve with a dot at current value

Data source: `GET /inboxes/:id/score-history?days=30`

---

## 6. New backend API endpoints required

| Method | Path | Returns | Source tables |
|---|---|---|---|
| `GET` | `/inboxes/:id/activity?cursor=&limit=50` | Paginated activity events (merged from warmup_sends, dns_checks, blacklist_checks, reputation_scores) | `warmup_sends`, `dns_checks`, `blacklist_checks`, `reputation_scores` |
| `GET` | `/inboxes/:id/sends?page=&limit=25&status=&from=&to=` | Paginated warmup_sends rows with receiver email resolved | `warmup_sends`, `inboxes`, `pool_inboxes` |
| `GET` | `/inboxes/:id/dns-history?limit=5` | Last N dns_checks rows for this inbox | `dns_checks` |
| `GET` | `/inboxes/:id/blacklist-history?limit=5` | Last N blacklist_checks rows | `blacklist_checks` |
| `GET` | `/inboxes/:id/placement-history` | All placement_tests rows for this inbox | `placement_tests` |
| `GET` | `/inboxes/:id/score-history?days=30` | reputation_scores for last N days | `reputation_scores` |
| `GET` | `/inboxes/:id/logs?level=&since=&search=&limit=` | Filtered log lines from NDJSON where inboxId matches | `.bin/.runtime/backend.ndjson` |
| `POST` | `/inboxes/:id/checks/dns` | Enqueues immediate DNS check job | dns-check queue |
| `POST` | `/inboxes/:id/checks/blacklist` | Enqueues immediate blacklist check job | blacklist-check queue |

**Activity feed merge logic (for `/activity` endpoint):**

The activity feed combines rows from 4 tables into a single chronological stream. Merge them in the backend by:
1. Query each table for rows where `inbox_id = :id` within the time window
2. Map each row to a common `ActivityEvent` shape: `{ type, timestamp, payload }`
3. For `warmup_sends`: emit up to 6 events per row — one for each non-null timestamp field (`sentAt`, `openedAt`, `repliedAt`, `starredAt`, `rescuedAt`, `filedAt`) plus one for `landedInSpam=true`
4. Merge-sort all events by timestamp descending
5. Return with a cursor (ISO timestamp of the oldest event in the page) for pagination

---

## 7. Before/after flow — user checking warmup activity

**Before:**
1. User opens `/inboxes/[id]`
2. Sees a score number and two buttons
3. Has no idea what the warmup engine is doing or has done
4. Cannot see any emails, any actions, any logs

**After:**
1. User opens `/inboxes/[id]`
2. Immediately sees: inbox email, live status dot, warmup day badge, current score with trend arrow and 30-day sparkline
3. Activity Feed tab (default) shows a live timeline: "Sent to pool-inbox@gmail.com · 2 hours ago", "Email rescued from spam · 1 hour ago", "Score updated: 61 → 68 ↑ · 30 min ago"
4. User clicks "Sent Emails" tab — sees a table of all 47 warmup emails sent, with open/reply/spam status per row
5. User clicks a row — it expands to show the message ID, subject, scheduled vs sent latency
6. User clicks "DNS & Blacklist" — sees SPF ✓, DKIM ✓, DMARC ✗ (can act on this), plus blacklist clean
7. User clicks "Logs" tab — sees real-time log lines filtered to this inbox, spots an SMTP warning from yesterday

---

## 8. Design reference

Design file: `prompt-library/email-warmup/designs/T026-inbox-activity-dashboard.png`

*(No design PNG exists yet — the agent should implement using the existing design system: slate palette, rounded-2xl cards, border-slate-200, indigo-600 for primary actions, consistent with the existing Pool page and Dashboard Shell components.)*

Until a design file is created, match the visual language of:
- `_components/PoolInboxDetailPanel.tsx` — card structure and DNS status display
- `_components/PoolInboxGrid.tsx` — table structure and badge styling
- `components/ReputationGauge.tsx` — score display pattern
- `components/ScoreHistoryChart.tsx` — chart pattern (may already have the chart component needed for the sparkline)

---

## 9. Acceptance criteria

All of the following must be true before T026 is marked done:

- [ ] **Activity Feed:** Opening `/inboxes/[id]` (default tab) shows a chronological list of warmup events. At least `sent`, `opened`, `replied`, and `spam_landed` events render correctly with the right icon colour and description.
- [ ] **Sent Emails table:** The "Sent Emails" tab shows a table of `warmup_sends` rows. Each row shows the receiver email, subject, and open/reply/spam status. Expanding a row shows the message ID and sent latency.
- [ ] **Sent Emails filters:** The date range filter and status filter both narrow the table correctly. Pagination works (next/prev).
- [ ] **DNS tab:** The "DNS & Blacklist" tab shows the most recent DNS check as a status grid with correct ✓/✗ per field. The DNS score history shows the last 5 checks with timestamps.
- [ ] **Blacklist tab:** The blacklist card shows "Clean" or "Listed on N RBLs". If listed, the RBL names are expandable.
- [ ] **Re-run DNS/Blacklist:** Clicking "Run DNS Check Now" enqueues a job and shows a toast "DNS check queued". Same for blacklist.
- [ ] **Placement tab:** Shows the most recent placement test as a bar chart (Primary / Promotions / Spam / Missing). History table shows all previous tests.
- [ ] **Score sparkline:** The page header shows the current score with a trend arrow and a 30-day mini line chart.
- [ ] **Logs tab:** The "Logs" tab loads the last 100 log lines for this inbox. Level filter narrows correctly. Search box filters by text. "Follow" mode polls every 5 seconds.
- [ ] **Empty states:** All tabs show a meaningful empty state message when there is no data yet.
- [ ] **No new console errors** are introduced by this page.
- [ ] **Auth:** All new API endpoints require a valid bearer token and return 401 if missing. The inbox must belong to the authenticated user (return 404 if not found or belongs to another user).
- [ ] **Performance:** The activity feed initial load completes in under 1 second on a local dev DB with 1,000 warmup_sends rows.

---

## 10. Out of scope for T026

- Real-time WebSocket push for the activity feed (polling is acceptable for now)
- The ability to manually trigger a warmup send from this page
- Editing inbox credentials from this page
- Exporting the activity log to CSV
- The diagnostics tab (that already exists at `/inboxes/[id]/diagnostics`)
