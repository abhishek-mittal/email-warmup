# T028 — Pool Inbox Activity Panel

**Wave:** 12  
**Priority:** P0  
**Depends on:** T026 (pool page), T027 (inbox activity dashboard — for shared patterns)  
**Skill files to load:** `docs/05-agent-skills/10-skill-frontend.md`, `docs/05-agent-skills/11-skill-logging.md`

---

## 1. Current state (before this change)

The pool inbox detail panel (`PoolInboxDetailPanel.tsx`) is a right-side slide-over that opens when a user clicks a row in the `/pool` page. It currently shows:

- Readiness badge (eligible / not-eligible / analyzing / error)
- Health score gauge (0–100)
- DNS record status grid (SPF / DKIM / DMARC / MX / rDNS) with fix hints
- Active pairs count + date added stats
- Re-analyze button

**What the user cannot see at all:**
- Has this pool inbox been used in any warmup sends?
- Which inboxes is it currently paired with?
- What emails did it receive and what actions did it take (open, star, reply, rescue)?
- Is it currently healthy and active, or silently failing?
- What do the backend logs say about this inbox?
- What are the actual SMTP and IMAP values it was configured with?

---

## 2. After state (what changes)

The panel gains a tabbed layout. The existing DNS / readiness content moves to a "Health" tab. Three new tabs are added: Activity, Pairings, and Logs.

Additionally, the panel header gains a **Connection Summary** strip — a compact read-only view of the SMTP and IMAP settings this pool inbox was configured with, so the user can verify at a glance what credentials are in use.

### Panel layout change

| Before | After |
|---|---|
| Single-scroll panel with DNS, score, stats | Tabbed panel: Health · Activity · Pairings · Logs |
| No connection info visible | Connection Summary strip in header (always visible) |
| No warmup receive history | Activity tab shows received emails and actions taken |
| No pairing visibility | Pairings tab shows which inboxes this pool inbox is serving |
| No log visibility | Logs tab shows filtered backend log stream |

---

## 3. Target components / entry points

1. **`frontend/src/app/(dashboard)/pool/_components/PoolInboxDetailPanel.tsx`** — add tab navigation and three new tab content sections. The existing content becomes the "Health" tab.
2. **New components** (all in `pool/_components/`):
   - `PoolActivityTab.tsx` — received emails + actions timeline
   - `PoolPairingsTab.tsx` — current pairing relationships
   - `PoolLogsTab.tsx` — log stream viewer
   - `ConnectionSummaryStrip.tsx` — SMTP/IMAP read-only display in header
3. **Backend:** 3 new API endpoints under `/pool-inboxes/:id/` — see section 6.

---

## 4. Tab-by-tab UX specification

---

### Always-visible: Connection Summary Strip

Sits between the panel header (email + readiness badge) and the tabs. A compact 2-column read-only card showing the connection settings:

**For Gmail / Outlook pool inboxes:**
```
Provider     Gmail OAuth
OAuth App    client_id: abc123...  (first 12 chars + ellipsis)
Token        ✓ Refresh token present
```

**For Custom SMTP pool inboxes:**
```
SMTP         smtp.gmail.com : 587   TLS
IMAP         imap.gmail.com : 993   SSL
User         myinbox@gmail.com
```

Rules:
- Never show passwords, tokens, client secrets — only show presence (✓ / ✗)
- SMTP host:port and IMAP host:port are always shown in full — these are not secrets
- If IMAP is not configured: show "IMAP — not configured · Receive actions disabled"
- A small "⚠ IMAP missing" amber chip appears if the pool inbox has no IMAP — this means open/star/reply/rescue actions cannot run for emails sent to this inbox

**Data source:** Backend returns this from a new `GET /pool-inboxes/:id/connection-summary` endpoint that reads `pool_inboxes.encrypted_credentials` and returns only the non-secret fields (host, port, user, oauth provider, whether token is present).

---

### Tab 1 — Health (existing content, moved here)

Everything currently in the panel stays exactly as-is. No changes to the readiness badge, score gauge, DNS grid, fix hints, stats, or re-analyze button. Just wrapped in a tab.

---

### Tab 2 — Activity

**Purpose:** Show what warmup emails this pool inbox has received and what it did with them.

Pool inboxes are the **receivers** in warmup pairs — they receive emails from the inboxes being warmed and take actions (open, star, reply, rescue). This tab shows that receive history.

**Layout:** Vertical timeline, same visual pattern as T027's Activity Feed tab.

**Event types:**

| Event | Icon colour | Description |
|---|---|---|
| `received` | Blue | "Received warmup email from `{sender_email}`" |
| `opened` | Green | "Opened email from `{sender_email}`" |
| `starred` | Amber | "Starred email from `{sender_email}`" |
| `replied` | Green | "Replied to `{sender_email}`" |
| `rescued` | Purple | "Rescued email from spam (sent by `{sender_email}`)" |
| `spam_landed` | Red | "Email from `{sender_email}` landed in spam" |
| `filed` | Slate | "Filed to WarmupHub" |

**Data source:** `warmup_sends` rows where `receiver_pool_inbox_id = :id`. Each row can yield up to 6 events (one per non-null timestamp column). Merge-sorted by timestamp descending, 50 per page.

**Stats bar above the timeline:**

```
Received: 47   Opened: 46 (98%)   Replied: 28 (60%)   Rescued: 3   Spam rate: 6%
```

These are aggregate counts from the same `warmup_sends` query. Shown as a single row of 5 stat chips above the timeline.

**Empty state:** "No warmup emails received yet. This pool inbox will start appearing here once it is paired with an inbox being warmed."

---

### Tab 3 — Pairings

**Purpose:** Show which inboxes this pool inbox is currently paired with and serving warmup traffic for.

**Layout:** A simple table.

| Column | Notes |
|---|---|
| Inbox | Email address of the inbox being warmed |
| Provider | Gmail / Outlook / Custom |
| Warmup Day | Current warmup day of the inbox being warmed |
| Emails sent | Total warmup sends from that inbox to this pool inbox |
| Last send | Relative timestamp of most recent warmup send |
| Status | Active / Paused |

**Data source:** `GET /pool-inboxes/:id/pairings` — queries `warmup_sends` to find distinct `sender_inbox_id` values where `receiver_pool_inbox_id = :id`, joins with `inboxes` for email/provider/warmupDay/status.

**Active pairs count** in this tab header matches the number in the stats card (they're the same `pool_inboxes.active_pairs` field).

**Empty state:** "Not currently paired with any inboxes. Pairing happens automatically when warmed inboxes run their daily send schedule."

---

### Tab 4 — Logs

**Purpose:** Raw structured log stream for this pool inbox — exactly what the backend logged for every IMAP, SMTP, and BullMQ operation touching this pool inbox.

**Layout and behaviour:** Identical to T027's Logs tab, but filtered by `poolInboxId` instead of `inboxId`.

- Dark background, monospace font
- Level colour coding: INFO green · WARN amber · ERROR red · DEBUG slate
- Filter bar: Level selector + text search + time range
- "Follow" toggle: polls every 5 seconds

**Backend:** `GET /pool-inboxes/:id/logs?level=&since=&search=&limit=` — reads `.bin/.runtime/backend.ndjson` filtering for lines where `poolInboxId = :id` OR where `receiverId = :id` (warmup-receive logs reference pool inboxes by `receiverId`).

**Empty state:** "No log entries found for this pool inbox."

---

## 5. SMTP / IMAP Connection Hint — ConnectInboxForm enhancement

This is a separate but related change. The custom SMTP form at `/inboxes/connect` and the pool inbox batch wizard currently have bare input fields with no provider hints.

### What to add

**Provider quick-fill buttons** — a row of buttons above the SMTP fields:

```
Fill settings for:  [ Gmail ]  [ Outlook ]  [ Yahoo ]  [ Zoho ]  [ Custom ]
```

Clicking a provider auto-fills the SMTP host, port, IMAP host, and IMAP port with the correct values:

| Provider | SMTP host | SMTP port | IMAP host | IMAP port |
|---|---|---|---|---|
| Gmail | smtp.gmail.com | 587 | imap.gmail.com | 993 |
| Outlook / Hotmail | smtp-mail.outlook.com | 587 | outlook.office365.com | 993 |
| Yahoo | smtp.mail.yahoo.com | 587 | imap.mail.yahoo.com | 993 |
| Zoho | smtp.zoho.com | 587 | imap.zoho.com | 993 |

The user still fills in email address, password, and DKIM selector — these cannot be pre-filled.

**Per-provider setup note** — a small info box appears after quick-fill:

For Gmail:
> "Gmail requires an **App Password** (not your account password) when using SMTP. Go to Google Account → Security → 2-Step Verification → App passwords. Use the generated 16-character password as your SMTP password."

For Outlook:
> "Outlook requires an **App Password** if you have 2FA enabled. Go to Microsoft Account → Security → Advanced security → App passwords."

For Yahoo:
> "Yahoo requires an **App Password**. Go to Yahoo Account Security → Generate app password."

**Port selector chips** instead of bare number input for SMTP port:

```
SMTP port:  [ 587 TLS ]  [ 465 SSL ]  [ 25 ]
```

Clicking auto-selects that port. The currently selected chip is highlighted. The number input stays for custom ports.

**Connection test result display** — after the user clicks "Connect inbox", the current code shows a generic toast. Replace with a more informative inline result:

```
✓ SMTP connected  (smtp.gmail.com:587 responded in 340ms)
✓ IMAP connected  (imap.gmail.com:993, 12 mailboxes found)
✓ Pre-check passed — inbox added
```

Or on failure:
```
✗ SMTP failed  EAUTH — wrong username or password
  → Check your App Password (Gmail requires a 16-char app password, not your account password)
```

The error hint maps known `errCode` values to plain-language explanations:

| errCode | Plain message |
|---|---|
| `EAUTH` | Wrong username or password. Gmail/Yahoo/Outlook require an App Password, not your account password. |
| `ECONNREFUSED` | Cannot reach `{host}:{port}`. Check the SMTP host and port — try 587 instead of 465 or vice versa. |
| `ETIMEDOUT` | Connection timed out. Your SMTP host may be blocking port `{port}` — try a different port. |
| `ENOTFOUND` | Hostname `{host}` not found. Check for typos in the SMTP host. |
| `IMAP_EAUTH` | IMAP login failed. If SMTP passed, your IMAP password may be different from your SMTP password. |

**These error hints apply to both:**
- `/inboxes/connect` custom SMTP form
- Pool inbox `BatchUploadWizard.tsx` (custom provider fields)

---

## 6. New backend API endpoints required

| Method | Path | Returns |
|---|---|---|
| `GET` | `/pool-inboxes/:id/connection-summary` | Non-secret connection info: host, port, user, provider, token-present boolean |
| `GET` | `/pool-inboxes/:id/activity?cursor=&limit=50` | Paginated events from `warmup_sends` where `receiver_pool_inbox_id = :id` |
| `GET` | `/pool-inboxes/:id/activity-stats` | Aggregate counts: received, opened, replied, rescued, spam_count, open_rate, reply_rate, spam_rate |
| `GET` | `/pool-inboxes/:id/pairings` | Distinct sender inboxes paired with this pool inbox + send counts + last send |
| `GET` | `/pool-inboxes/:id/logs?level=&since=&search=&limit=` | Filtered log lines from NDJSON where poolInboxId or receiverId matches |

All endpoints are ownership-checked (userId must match `pool_inboxes.user_id`). Return 404 if not found or belongs to another user.

**`connection-summary` response shape:**
```json
{
  "provider": "custom",
  "smtpHost": "smtp.gmail.com",
  "smtpPort": 587,
  "smtpUser": "myinbox@gmail.com",
  "smtpPasswordPresent": true,
  "imapConfigured": true,
  "imapHost": "imap.gmail.com",
  "imapPort": 993,
  "imapUser": "myinbox@gmail.com",
  "imapPasswordPresent": true
}
```

For OAuth pool inboxes:
```json
{
  "provider": "gmail",
  "oauthClientIdPrefix": "abc123...",
  "clientSecretPresent": true,
  "refreshTokenPresent": true
}
```

---

## 7. Before/after flow

**Before:**
1. User clicks a pool inbox row → panel opens
2. Sees DNS status and health score
3. Has no idea if this pool inbox is actually receiving and acting on warmup emails
4. Cannot tell which inboxes it's serving
5. Cannot see SMTP/IMAP settings it was configured with
6. Cannot diagnose a silent failure

**After:**
1. User clicks a pool inbox row → panel opens
2. **Header:** Sees "smtp.gmail.com:587 / imap.gmail.com:993" connection strip. If IMAP is missing, sees amber "⚠ IMAP missing — receive actions disabled" chip immediately.
3. **Health tab (default):** Same DNS/readiness content as before
4. **Activity tab:** Sees "Received 47 emails · Opened 98% · Replied 60% · Rescued 3 · Spam rate 6%" stats bar, then timeline of receive events
5. **Pairings tab:** Sees "Currently serving 3 inboxes" — table showing which inboxes it's warming for
6. **Logs tab:** Sees real-time backend log lines for this pool inbox — can spot IMAP failures, SMTP reply errors, rescue events

**Connect inbox form (before):**
1. User types smtp.gmail.com manually
2. Types port 587 manually
3. Gets a generic "Failed to connect" toast with no hint
4. Doesn't know they need an App Password

**Connect inbox form (after):**
1. User clicks "Gmail" quick-fill → SMTP + IMAP fields auto-populate
2. Info box appears: "Gmail requires an App Password…"
3. User enters email + app password + connects
4. On success: sees "✓ SMTP connected · ✓ IMAP connected · ✓ Pre-check passed"
5. On failure: sees "✗ SMTP failed · EAUTH — wrong username or password → Check your App Password"

---

## 8. Design reference

No design PNG yet. Match the visual language of:
- `PoolInboxDetailPanel.tsx` — existing panel structure, tab pattern to match `ConnectInboxForm.tsx` tab buttons
- T027 Activity Feed and Logs tab — reuse the same timeline and log viewer components once T027 is built
- `DnsStatusCard.tsx` — same chip/card pattern for the connection summary strip

---

## 9. Acceptance criteria

- [ ] **Connection strip:** Panel header shows SMTP host:port and IMAP host:port (or OAuth provider) for every pool inbox. Never shows passwords or tokens. An amber "IMAP missing" chip appears when IMAP is not configured.
- [ ] **Activity tab:** Shows aggregate stats (received, opened %, replied %, rescued, spam %). Timeline shows warmup receive events with correct icons. Empty state shown when no activity.
- [ ] **Activity pagination:** "Load more" loads the next 50 events. Most recent first.
- [ ] **Pairings tab:** Shows the distinct sender inboxes currently paired with this pool inbox. Shows total sends and last send timestamp per pairing. Empty state shown when not yet paired.
- [ ] **Logs tab:** Shows the last 100 log lines where `poolInboxId` or `receiverId` matches this pool inbox. Level filter works. Search works. Follow mode polls every 5 seconds.
- [ ] **Provider quick-fill (connect form):** Clicking Gmail/Outlook/Yahoo/Zoho fills SMTP host, SMTP port, IMAP host, IMAP port. The per-provider App Password note appears.
- [ ] **Port chips:** SMTP port renders as 587 TLS / 465 SSL / 25 chips. Selecting a chip updates the port field.
- [ ] **Connection test result:** After connect attempt, shows inline ✓/✗ per SMTP and IMAP with ms timing on success. On SMTP failure, shows the errCode mapped to plain English with a fix hint.
- [ ] **Error hints in pool wizard:** Same EAUTH/ECONNREFUSED/ETIMEDOUT/ENOTFOUND hints appear when a batch upload entry fails SMTP pre-check.
- [ ] **Auth:** All new endpoints require a valid bearer token and ownership check (pool inbox must belong to authenticated user).
- [ ] **No new console errors** introduced.

---

## 10. Out of scope for T028

- Editing SMTP/IMAP credentials from within the panel (view-only)
- Bulk re-analyze from the activity tab
- Exporting activity or logs to CSV
- OAuth token refresh UI
