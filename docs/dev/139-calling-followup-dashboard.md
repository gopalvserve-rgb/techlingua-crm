# dev/139 — Calling CRM + Follow-up/Campaign/Dashboard batch (26/27 Aug 2026)

Client "Calling CRM" batch. Six items. Reuses the existing masters framework, the leads-list
filter/column-chooser, the Start Calling hand-out, the Follow-ups module, the Campaign summary
cards (dev/131) and the Dashboard Overview.

**Migration 108** `108_call_disposition_lastcall.sql` (idempotent):
- `m_call_disposition` master table + de-dup indexes + seed (9 values).
- `lead.last_call_disposition_id` + `lead.last_call_disposition_at` (nullable; no backfill).
- `user.last_seen_at` (nullable; the live team-status heartbeat).

**New master:** `call_disposition` → `/api/masters/call_disposition` (registered in
`MASTER_TYPES`, auto-listed in Administration › Masters). Seeded: Connected · Not Connected / RNR ·
Busy · Switched Off · Wrong Number · Call Back · Interested · Not Interested · Follow-up Scheduled.

---

## Item 1 — Last Call Disposition (master + lead column + filters)
- **What changed:** new `call_disposition` master; `lead.last_call_disposition_id` set whenever a
  disposition is logged (Start Calling save & next, or the new lead-row "Log call disposition"
  control → `POST /leads/:id/call-disposition`). LEAD_SELECT now returns it; it is a Leads-list
  column (via the column chooser) and a multi-select Leads-list filter (`call_disposition_ids`);
  shown read-only on the lead detail.
- **Verify (Masters):** Administration › Masters → open **Call Dispositions** → the 9 seeded values,
  Add/Edit/Delete work.
- **Verify (Leads list):** Marketing & Lead Management › **Leads** → the **"Columns"** button →
  tick **"Last Call Disposition"** → the column appears. The filter bar has a **"Last Call
  Disposition"** multi-select that narrows the list.
- **Verify (Log):** on a lead row, the **phone/call** row-action ("Log call disposition") opens a
  modal → pick a disposition → Save → the lead detail's **"Last call disposition"** field + the
  list column update.

## Item 2 — Start Calling: all filters
- **What changed:** the Start Calling screen (Marketing & Lead Management › **Start Calling**) now
  has a **campaign-picker filter row** (Branch / Vertical / Pipeline — narrows the on-demand
  campaigns you call from) and, when a batch is open, a **queue filter row** (Source · Status ·
  Stage · Last Call Disposition · worked-state · search) that narrows the batch queue. A **Call
  Disposition** select was added to the disposition form (sets last_call_disposition_id).
- **Verify:** open **Start Calling**, pull a batch → above "My batch" use the Source / Status /
  Stage / **Last Call Disposition** / search controls → the queue list narrows. The disposition
  form shows a **Call Disposition** dropdown.

## Item 3 — Today's Follow-ups filters
- **What changed:** the **Today's Follow-ups** screen gains Branch › Vertical › Campaign (cascade),
  Lead Counsellor, Type and Disposition multi-select filters (consistent with the Follow-ups list),
  wired to the `/follow-ups` params + the global top-bar scope.
- **Verify:** Dashboard → **Today's Follow-ups** (or the top-bar Due-Today shortcut) → the filter
  row with Branch/Vertical/Campaign/Lead Counsellor/Type/Disposition narrows the list.

## Item 4 — Follow-up module table scroll ("roller")
- **What changed:** the **Today's Follow-ups** list now scrolls **within the table** (sticky card
  head, its own scrollbar) instead of growing the page — the LIST_SCROLL mechanism (`todayFollowups`
  added to the set in `web/src/Shell.tsx`) + a `.tbl-fill`/`.tbl-scroll` wrapper.
- **Verify:** Today's Follow-ups with many rows → the list scrolls inside the card; the KPI cards +
  filter row stay fixed.

## Item 5 — Campaign "Total Lead" card
- **What changed:** the **Campaign** module gains a **Total Lead** summary card (total leads across
  the current scope + Lead-Counsellor narrow), alongside the dev/131 cards; clicking opens the Leads
  list.
- **Verify:** Marketing & Lead Management › **Campaigns** → the KPI strip shows **Total Lead**.

## Item 6 — Dashboard live team status
- **What changed:** a read-only **"Team status — live"** widget on the Dashboard Overview
  (manager/admin views) lists in-scope agents with **Online / Away / Offline** (from
  `user.last_seen_at`, thresholds <5m / <30m / else), plus **open leads** and **today's follow-ups**.
  `last_seen_at` is touched by the JWT guard on each authenticated request (throttled ~55s); the
  widget polls every 30s. New endpoint `GET /dashboard/team-status` (`lead.read`, RBAC-scoped).
- **Verify:** log in as an admin/manager → Dashboard Overview → the **"Team status — live"** table
  under the Team performance widget (agents with a coloured Online/Away/Offline dot).

---

### Build / tests
- New migration **108** (continues after 107). API `tsc`+build+jest green except pre-existing
  `capture` / `followup-reportto` / `date.util`. web `tsc`+`vite build`+vitest green except
  pre-existing `qa10matrix` / `followupreseed`.
- Tests added: `masters/call-disposition-master.spec.ts`, `leads/lead-call-disposition.spec.ts`,
  `dashboard/dashboard.spec.ts` (teamStatus bucketing + scope), `web/src/calling.test.tsx`
  (queue filter application). Existing `sprint3-rbac` + `handout.testkit` updated for the new
  route/columns.
- NOT browser-verified by the developer — the main agent re-verifies live.
