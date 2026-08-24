# dev/132 — Calendar date-range (A) · Vertical multi-bank/UPI/QR (B) · Popup notifications (C) · Distribution turn-wise + conditional (D) · Campaign Type ＋Master (E)

crm18aug-v2 Batch 1 — five client-feedback items. Migration **101**. Live commit supersedes `7851b2a` (dev/131).

## ITEM A — Calendar date-range filters + total count (task #215)
`web/src/sprint3.tsx` `Calendar()`. The shared `DateRange` control (All time / Today / Yesterday /
This Week / This Month / Custom, `daterange.tsx`) now drives the `/calendar?from=&to=` feed AND a
**total count** line (`data-testid="cal-count"`) — e.g. "2 follow-ups · 1 event · 1 overdue". The
month-grid prev/next/Today buttons keep working and set the range to that whole month. "All time"
sends a wide window (2015-01-01 .. +2y) since `/calendar` always needs a window. The bottom list
title reads "In selected range — N results". The only true month-grid calendar in the app is this one
(grep `cal-grid`); the Follow-ups list already had its own DateRange.
**Verify:** Marketing & Lead Management › **Calendar** → the chip row (All time / This Week / This Month …)
filters the grid + updates the "N follow-ups · N events" count; prev/next month still work.

## ITEM B — Vertical: multiple bank accounts + checkbox + UPI + QR (task #216)
Migration **`api/db/migrations/101_vertical_multibank_upi_qr.sql`** — adds `vertical.banks jsonb`,
`vertical.upi_id`, `vertical.qr_r2_key`; backfills `banks[]` from the legacy single-bank columns.
- `api/src/hierarchy/hierarchy.service.ts` — `normBanks()` normalises the rows and guarantees exactly
  ONE active/required bank; the active bank is mirrored into the legacy `bank_*` columns (so any old
  reader keeps working). `banks`/`upi_id` added to create INSERT + `updateVertical` whitelist. New
  `qrUploadUrl()` + `attachQr()` presign methods (mirror the vertical-logo flow) → `qr_r2_key`; list
  attaches a presigned `qr_url`.
- `api/src/hierarchy/hierarchy.controller.ts` — `POST /verticals/:id/qr/upload-url` + `POST /verticals/:id/qr`.
- `api/src/storage/storage.service.ts` — `verticalQrKey()`.
- `web/src/documents.tsx` — `VerticalBanksEditor` (add-more bank rows + a **Required/active** radio +
  UPI id field) and `VerticalQrUpload` (R2 image upload). `web/src/dyn.tsx` `Verticals()` wires them into
  the **edit** form's `extra` (banks/UPI via a ref → PATCH `banks`,`upi_id`; QR upload needs the vertical id),
  and the View shows all banks + UPI + QR. `web/src/forms.tsx` spec swaps the single-bank fields for a
  **UPI ID** field (banks[0] is seeded from the legacy fields on Add; full multi-bank management is on Edit).
- Invoices/receipts do NOT currently print bank details, so nothing else changed there.
**Verify:** Administration › Verticals › **Edit** a vertical → "Bank Accounts" (Add bank account, tick
Required), **UPI ID**, **Payment QR** (upload). Save, re-open → persists. View shows Bank 1 (active) · UPI · QR.

## ITEM C — Popup/toast notifications for the six events (task #217)
`web/src/notifications.tsx` `NotificationBell` — the existing 60s badge poll now also fetches
`GET /notifications?unread=1&limit=20` every **45s**, seeds a "seen" set on the first poll (no login
flood), then renders a **toast** for every NEW unread row + increments the bell. The 37-event catalog
(`fire()`) only fans to SMS/email/WhatsApp, so the six events must write an in-app `notification` row:
- reminder due / follow-up missed / SLA breach — already written by `reminder.worker` (unchanged).
- lead created / lead assigned — added `notifier.notify()` in `leads.service.create()` + `reassign()`.
- red flag — added `notifier.notify()` in `leads.service.addRedFlag()`.
- task assigned — added `notifier.notify()` in `followups.service.create()` (a task IS a follow-up).
`LeadsModule` now imports `NotificationsModule`; `NotifierService` injected (optional/trailing) into
`LeadsService` + `FollowUpsService`.
**Verify:** create a lead / assign a lead / add a follow-up for another user / red-flag a lead → within
~45s a toast pops and the bell count rises (also visible in the bell dropdown). Reminders/SLA already toast.

## ITEM D — Distribution: turn-wise persistence + conditional (task #218)
Audited: the round-robin cursor is ALREADY turn-wise persistent — `campaign_distribution_state.last_agent_idx`
is a single monotonic per-campaign counter bumped once per assignment (`ingestion.pickOwner`), modulo at
pick time (`distribution.util.pickFromPool`). NO code resets it per day/month (grep confirmed). On-Demand
is live end-to-end (`handout.service` + the "Start Calling" page `calling.tsx`); Conditional is live
(`resolvePool` → `matchCondition`). Change: added `source` to the conditional match context in
`lead-ingestion.service.ts` (the `source` COND_FIELD was previously always unmatched). Locked with tests
(cross-day + cross-month cursor continuation). No distribution-UI redesign (that is PARKED per instruction).
**Verify:** a campaign with Equal distribution + 4 agents → hand out 3 leads today, 1 tomorrow → the 4th
lead goes to the 4th agent (not back to #1). On-Demand campaign → Start Calling hands out N. Conditional
→ leads matching a rule go to that rule's user.

## ITEM E — Campaign Type ＋Master link (tiny fix)
`web/src/forms.tsx` `CampaignModal` — the `MasterQuickAdd type="campaign_type"` blue ＋ Master link was
rendered only on Add (`!initial`), so it was absent on the Edit form. Now it renders on BOTH.
**Verify:** Leads › Campaigns → **Edit** a campaign → the Campaign Type field shows the blue **＋ Master**
link (and on Add too).

## Migrations
- **101** `101_vertical_multibank_upi_qr.sql` (continues after dev/131's 100). Runs on boot (`migrate.js && main.js`), idempotent, backfills banks.

## Tests added
- api `leads/distribution.spec.ts` — turn-wise cursor persistence across "days" and a "month".
- api `hierarchy/vertical-banks.spec.ts` — `normBanks` multi-bank persistence (one-active guarantee, IFSC upcase, empty-row drop).
- api `notifications/notification-unread.spec.ts` — the `GET /notifications?unread=1` poll endpoint.
- web `sprint3.test.tsx` — calendar total-count render + date-range shortcut re-drives the `/calendar` query.
- (on-demand hand-out `leads/handout.spec.ts` + conditional matching in `distribution.spec.ts` already existed.)

## Test baseline (unchanged known fails)
api tsc+build green; jest: only the 2 known pre-existing fails `capture`, `followup-reportto` (date-relative).
web tsc+vite build green; vitest: `sprint3` calendar now GREEN (fixture pinned to current month); other known
pre-existing fails (`followupreseed`, `qa10matrix` date) unchanged.
