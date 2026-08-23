# dev/128 — Leads list: pagination + creation date-time column + Excel import (course & remarks)

Client feedback (task #211). Three fixes on the Leads list / lead import.

## 1. Pagination on the Leads list (functional blocker)
The Leads list fetched `/leads?…&limit=100` with no offset and no pager, so with 99+
leads in scope users could never reach the rest.

- **API** — `LeadsService.list()` already returned `{ total, rows }` and accepted
  `limit`/`offset` (default 50, capped 500). No API change was needed; the gap was
  purely front-end. (Regression-locked with `api/src/leads/lead-pagination.spec.ts`:
  total returned, page-2 offset advances, limit capped at 500 / offset floored at 0.)
- **Web** (`web/src/dyn.tsx`, Leads list) — added a `page` state (PAGE_SIZE = 50) that
  drives `limit`/`offset`, and a `LeadsPager` (Prev / numbered pages / Next +
  "Showing X–Y of N leads"). All filters, global scope, sort and the created-date range
  carry across pages (they are the fetch key); changing any of them resets to page 1
  (a `filterKey` that excludes paging). The pager renders under all three views
  (Classic / Modern / Inbox), which share the one fetch.

## 2. "Created on" column shows date **and** time (IST)
`leadRow()` rendered the Created-on cell with the date-only `fmtDMYIST`. Switched to the
shared `fmtDateTimeIST` (dev/113) so the column reads `DD-MM-YYYY HH:mm` in IST.

## 3. Excel/CSV import — Course (by code or name) + Remarks recognized
The import mapping catalog (`api/src/ingestion/mapping.util.ts`) already carried a
`course` field (aliases incl. `coursecode` / `course_code`) and a note field
(aliases incl. `remark` / `remarks`); the ingestion service resolves a Course by its
master **CODE** (preferred) or name, scoped to the target Branch › Vertical (dev/114),
and keeps the remark on the lead. To remove the client-visible confusion where a
"Remarks" column auto-mapped to a field labelled **Note**, the field is now labelled
**"Remarks / Note"** so the mapping UI makes the match obvious. Regression test added
(`ingestion.spec.ts`): an import row with course code `IELTS01` + a remark creates a
lead with the right `course_id` and the remark on the timeline.

## Tests
- api: `tsc` + build green; `jest` green except the 2 known pre-existing failures
  (`capture`, `followup-reportto`). New: `lead-pagination.spec.ts`, ingestion course-code test.
- web: `tsc` + `vite build` green; `vitest` incl. `listaudit` green except the known
  pre-existing env failures (`qa10` phone pins, `sprint3` calendar, `followupreseed`).
