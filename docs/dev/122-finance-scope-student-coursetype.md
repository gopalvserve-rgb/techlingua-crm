# dev/122 — Finance top-bar scope filter + Student Placement Course Type

Two client items, browser-verified on the live build.

## 1. BUG — Finance module ignored the global top-bar Branch › Vertical scope

**Symptom (client):** changing the top-bar Branch/Vertical scope refreshed the Finance
screens but the figures never changed.

**Root cause.** The global scope selector (`web/src/scope.tsx`) folds the selection into
`branch_ids` / `vertical_ids` query params, and the data screens seed their in-panel
Branch/Vertical filters from it. Most Finance **lists** already honoured this (Fee
Management dues, Revenue, Collection Reports, GST invoice list, Refund list, Payment-plan
list). But the prominent **KPI / summary** endpoints were called with **no scope at all**,
and two screens ignored the scope entirely:

- `GET /invoices/summary`, `GET /refunds/summary`, `GET /payment-plans/summary` — the
  service `summary()` took only the RBAC scope, no branch/vertical narrowing; the
  front-end fetched them with no params.
- **Fee Collection** (`/fees/receipts` + `/fees/summary`) — no scope on the list or the
  KPIs, and no Branch/Vertical filter on the screen.
- **Discount Master** — the in-panel Branch/Vertical filter was not seeded from the global
  scope, and the list endpoint did not accept a scope.
- GST invoice **list** applied `branch_ids` but not `vertical_ids`.

Because the KPI cards are the numbers the client watches, the module looked inert.

**Fix — wire every Finance screen + endpoint to the global scope, mirroring the Fee
Management dues path that already worked:**

- API summaries now accept + AND `branch_ids` / `vertical_ids` on top of the RBAC scope
  (never widening): `invoices/invoice.service.ts`, `refunds/refund.service.ts`,
  `paymentplans/plan.service.ts`, `fees/fee.service.ts` (receipt aggregates AND the
  outstanding snapshot), with their controllers parsing the params. Fee Collection list
  (`fees/fee.service.ts` `list`) narrows too. `finance/discount-master.service.ts` `list`
  narrows to the rules that APPLY in the chosen branch/vertical (pinned rows + the
  org-wide `NULL` rows).
- Front-end fetches pass the scope on both list AND summary:
  `web/src/invoices.tsx` (adds a Vertical filter + scopes the summary), `web/src/refunds.tsx`,
  `web/src/paymentplans.tsx` (Payment Plans summary), `web/src/sprint5.tsx` (Fee Collection
  — new Branch/Vertical filters seeded from the global scope, scoped list + summary),
  `web/src/discountmaster.tsx` (seed the filters from the global scope). The Finance
  Dashboard + Fee Management dues already scoped and are unchanged.

The screens remount on a scope change (the Shell keys the screen by the scope key), so the
seeded filters re-initialise and every list/KPI recomputes for the selected Branch/Vertical.

**Test:** `api/src/finance/scope-narrow.spec.ts` — proves invoice / fee / payment-plan /
refund summaries emit the `branch_id = ANY(...)` / `vertical_id = ANY(...)` narrowing and
bind the id arrays (and emit nothing when no scope is set).

## 2. Student add/edit — Course Type dropdown under Placement

The student add/edit form (`web/src/dyn.tsx` `StudentModal`) gains a **Course Type**
dropdown in the **Placement** section, master-backed by the manageable Course Type master
(`GET /api/masters/course_type`, dev/106) with the inline **＋ Master** quick-add — the
same `mopts` pattern the Course form uses. The chosen course-type **label** persists on the
student as `placement_course_type` and rehydrates on reopen.

- **Migration `098_student_placement_course_type.sql`** — `ALTER TABLE student ADD COLUMN
  IF NOT EXISTS placement_course_type VARCHAR(120)` (idempotent).
- `students/student.service.ts` `profilePairs` maps `placement_course_type` (used by both
  create and update); the profile read is `SELECT s.*`, so it returns automatically.
- **Test:** `api/src/students/placement-course-type.spec.ts` — persists the label, clears
  to NULL when blank, omits the column on a partial edit that doesn't touch it.

## Build / deploy

api `tsc` + jest green (only the two known-pre-existing failures: `capture`,
`followup-reportto`). web `tsc` + `vite build` + vitest green incl. `listaudit`
(only the two known: `qa10` phone pins, `sprint3` calendar). Deployed from a pristine
`--depth 1` clone via `railway up . --path-as-root --service api`; migration `098` applied
on boot.
