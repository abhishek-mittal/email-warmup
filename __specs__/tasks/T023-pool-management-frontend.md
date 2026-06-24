# T023 — Pool Management Frontend — Upload UI + Analysis Grid

**Wave:** 7  
**Depends on:** T019, T020, T021, T022, T018  
**Skills to load:** docs/05-agent-skills/10-skill-frontend.md  

---

## Current state

The frontend (T018) has an `/inboxes` page showing a list of connected inboxes and a `/inboxes/connect` page for the OAuth flow. There is no concept of a pool in the UI. There is no batch upload screen. There is no analysis grid showing DNS health per inbox.

---

## What to build

### 1. Warming Pool page — `/pool`

A new top-level page in the dashboard sidebar alongside `/inboxes`.

**Grid columns:**
- Email address
- Provider (Gmail / Outlook / Custom)
- DNS Health (Green chip if health_score ≥ 80 · Amber if 50–79 · Red if < 50)
- Issues (comma-separated issue codes, e.g. "SPF_MISSING, DKIM_MISSING" — empty = "All clear")
- Active Pairs (number from `active_pairs`)
- Status badge (pending / active / error)
- Added date
- Remove button (calls `DELETE /pool-inboxes/:id`)

**Empty state:** "No pool inboxes yet. Add pool inboxes to enable warming." with an "Add pool inboxes" button.

### 2. Inbox analysis column on `/inboxes` page

Extend the existing inboxes grid with two new columns:
- **DNS Health** — same chip pattern as pool page (Green / Amber / Red based on `health_score` from latest `inbox_analysis`)
- **Issues** — issue code list from latest `inbox_analysis`, or "Analysing…" while analysis is pending (status = 'pending'), or "All clear"

### 3. Batch upload flow — shared component used on both pages

**Entry point:** "Add via CSV" button and "Add via wizard" button — both on `/inboxes` and `/pool`.

**CSV upload path:**
1. User clicks "Add via CSV"
2. File picker opens — accepts `.csv` files only
3. After file selection: show a preview table of parsed rows (email, provider, detected credential columns)
4. Highlight any rows with missing required fields in amber
5. "Upload" button calls `POST /inboxes/batch/csv` or `POST /pool-inboxes/batch/csv`
6. After upload: show a result summary — "N added successfully, M failed" with the failure reasons listed
7. Grid refreshes automatically after upload

**Wizard path (multi-add):**
1. User clicks "Add via wizard"
2. Modal opens — single inbox form (same fields as the existing `/inboxes/connect` form)
3. After each inbox: show "Add another" button alongside "Done"
4. "Add another" keeps the modal open and clears the form
5. "Done" submits all collected inboxes to the batch endpoint and closes the modal
6. Grid refreshes after submit

### 4. Pool inbox detail panel

Clicking a pool inbox row opens a side panel showing:
- Full email + provider
- DNS health breakdown (SPF / DKIM / DMARC / MX / rDNS — each with a pass/fail indicator)
- Health score gauge (same `ReputationGauge` component used on inbox detail, but no score history)
- Active pairs count
- Date added

---

## Acceptance criteria

- [ ] `/pool` page renders with the pool inbox grid and correct column values for each pool inbox
- [ ] `/pool` empty state shows with "Add pool inboxes" CTA when no pool inboxes exist
- [ ] DNS Health chip on both `/inboxes` and `/pool` shows correct colour for each inbox based on `health_score`
- [ ] "Analysing…" state shows correctly for inboxes with `status='pending'` and no `inbox_analysis` row yet
- [ ] CSV upload on `/inboxes`: parsed preview shown before submit, result summary shown after, grid refreshes
- [ ] CSV upload on `/pool`: same behaviour, sends to `POST /pool-inboxes/batch/csv`
- [ ] Wizard multi-add: "Add another" keeps modal open and collects multiple inboxes, single batch submit on "Done"
- [ ] Removing a pool inbox calls `DELETE /pool-inboxes/:id` and removes the row from the grid without a full page reload
- [ ] Pool inbox side panel shows DNS breakdown with correct pass/fail per field
- [ ] Sidebar nav shows "Warming Pool" link alongside "Inboxes"
- [ ] Zero TypeScript errors (`pnpm run build` clean, `pnpm run lint` clean)

## Mark done in SPEC-STATUS.md when all criteria above are verified
