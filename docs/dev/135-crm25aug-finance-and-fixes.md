# dev/135 — crm25aug Batch A: Finance dashboard, fixes, import validation, exam Zoom

Client "crm25aug" batch. Eight items across leads, targets/teams, finance, payments,
lead-import and the assessments/exam module. New migration **104** (`104_exam_zoom_link.sql`).

New migration: **104** only (continues after dev/134's 103). Runs on boot (`migrate.js`),
purely additive + idempotent, so live rows are untouched.

---

## 1. BUG — a manual stage change to "Enrolled" must NOT auto-set Status = WON
`api/src/leads/leads.service.ts` `update()`: the stage→status auto-rule now DROPS the WON
mapping. `autoStatusFromStage()` still returns WON/LOST, but `update()` only honours **LOST**
(Closed → Lost is kept, per client). WON/enrolment happens ONLY through Convert-to-Student
(`students.service.ts` / `enrolments.service.ts` `winLead()`, which set Status = WON via direct
SQL — unchanged). An explicit `status_id` in the same PATCH as a WON stage move is now honoured.
- **VERIFY:** Leads → open a lead → change its pipeline **Stage** to **Enrolled** → Save.
  Lead **Status** must stay as it was (New / In Progress), NOT flip to Won. Then use
  **Convert to Student** on a lead → its Status becomes **Won**. Change a stage to **Closed** →
  Status still becomes **Lost**.

## 2. Fee Receipt Records — Date column
`web/src/sprint5.tsx` (standalone **Fee Receipt Records** list) + `web/src/dyn.tsx` (student
profile Fee Receipt Records; choosable columns `RECEIPT_COL_LABELS`). Added a **Date** column
(receipt `received_at`) to the table AND the column chooser (default visible).
- **VERIFY:** Finance → **Fee Receipt Records** (and Student profile → **Fee Management / Fee
  Receipt Records**): a **Date** column shows each receipt's date; it appears in the
  columns chooser to show/hide.

## 3. Target hierarchy rollup (Vertical / Course)
`api/src/performance/target-def.service.ts` `actuals()`. Verified + documented: a **Vertical**
target rolls up ALL enrolments under that vertical via the denormalised NOT-NULL
`enrolment.vertical_id` (every course beneath it); a **Course** target rolls up all enrolments of
that course via `enrolment.course_id` (incl. multi-level enrolments, which are line-items inside a
single enrolment carrying the parent course_id). Branch rolls up via `enrolment.branch_id`. These
are containment columns, not exact-PK matches. (No code change needed for Branch/Vertical/Course;
covered by new tests.)
- **VERIFY:** Performance & Conversion → **Target & Incentive** → create a target **Target For =
  Vertical** (or Course) with an Admissions/Revenue target → open its **dashboard (chart icon)**:
  the actuals include every enrolment under that vertical/course, not only rows tagged to it.

## 4. Teams manager for Target & Incentive (Team = Σ members)
Team CRUD already exists (`api/src/teams/*` — create/edit/list/get; delete via the soft-delete
surface `DELETE /teams/:id`). Two changes:
- **Actuals fix** (`target-def.service.ts`): a **Team** target's actuals now = the SUM across its
  MEMBER USERS. Every metric attributes to the member who owns the row (`owner_id` /
  `counsellor_id` via a `team_member` sub-select), NOT the usually-unset `enrolment.team_id`.
- **UI**: a **Teams** manager (create/edit/delete a team = name + members) reachable from the
  Target & Incentive area (see `web/src/targetincentive.tsx` / the Target modal's Team picker
  reads `GET /teams`).
- Tables reused: **`team`** + **`team_member`** (from `003_rbac.sql`) — no new migration.
- **VERIFY:** Target & Incentive → **Teams** → create a team with 2 members → create a target
  **Target For = Team** → its dashboard shows the SUM of both members' leads/admissions/revenue.

## 5. Finance Dashboard — filter bar + 12 KPI cards
`api/src/finance/finance-dashboard.{service,controller}.ts` + `web/src/invoices.tsx`
(`FinanceDashboard`). Filter bar (multi-select, driving every figure): **Branch, Vertical,
Counsellor, Course, Trainer, Status, Payment Mode** + the global **DateRange**. 12 KPI cards, each
live from the fee_receipt / payment_plan+installment / gst_invoice / refund / enrolment sources:
Today's Collection · Overdue Fee Collected · Total Collected Fee · Collection Rate (Collected ÷
Collectible ×100) · Total Invoiced · Net Revenue · Total Unpaid Fee · Current Month Instalment Fee ·
Overdue Fee · GST Collected · Refunds · Receipts (count). New API fields:
`overdue_fee_collected_minor`, `total_collectible_minor`, `collection_rate_pct`,
`net_revenue_minor`, `current_month_installment_minor`, `overdue_fee_minor`, `total_unpaid_minor`.
- **VERIFY:** Finance → **Finance Dashboard**: the filter bar (Branch/Vertical/Counsellor/Course/
  Trainer/Status/Payment Mode) + date range drive all figures; all **12** cards populate.

## 6. Record / Collect Payment — Branch›Vertical + search
`web/src/sprint5.tsx` `CollectModal`. Shows the **Branch › Vertical › Course** breadcrumb for the
selected enrolment/student, and adds a **search** ("Find student / enrolment", queries
`/enrolments?status=active&q=`) when opened without a pre-selected enrolment. The live Record
Payment entry point (Fee Collection button) opens this modal.
- **VERIFY:** Finance → **Fee Collection** → **Record payment**: a search box finds a
  student/enrolment; once chosen, the **Branch › Vertical** path shows for it.

## 7. Leads import — course by CODE + strict validation
`api/src/ingestion/lead-ingestion.service.ts` + `import.service.ts`. The CSV bulk import now
validates **Course** strictly: a row whose course **code/name** is not in the Course master for the
import's Branch › Vertical is **rejected** with a clear per-row error (preview = error row; commit =
dead-letter row in the import result), NOT imported with a null course. Other masters (City/State)
stay soft; inbound machine feeds (webhook/form/sheet) stay fully soft (OBS-02 preserved).
- **VERIFY:** Leads → **Import** → map Course to a bad code → **Preview**: that row is an **error**
  ("Unknown Course code/name … not in the Course master"), and it does not import.

## 8. Exam — Zoom link
Migration **104** adds `assessment.zoom_link TEXT`. `api/src/assessments/assessment.service.ts`
(normalise/insert/update + the student-attempt payload) + `web/src/assessments.tsx` (create/edit
form field + the take-test / launch screens). Optional URL, validated as http(s), shown to a
student sitting an online/proctored exam.
- **VERIFY:** Assessments → create/edit a **Test/Exam** → set a **Zoom Link** → Save; open the
  student **attempt/launch** screen for it → a "Join proctored session" link appears.

---

## Tests added / updated (api jest)
- `leads/lead-autostatus.spec.ts` + `leads/lead-name-source-autostatus.spec.ts` — a manual WON
  stage change does NOT set WON; Closed → Lost kept; explicit status honoured (item 1).
- `performance/target-def.spec.ts` — Vertical/Course rollup predicates; Team = Σ members via
  `team_member` sub-select (items 3, 4).
- `finance/finance-dashboard-kpi.spec.ts` (new) — all 12 KPIs map from canned sources incl.
  Collection Rate + GST total + divide-by-zero guard (item 5).
- `ingestion/ingestion.spec.ts` + `ingestion/import.service.spec.ts` — CSV import rejects an
  unknown course; inbound webhook still soft-imports (item 7).
- `assessments/assessments.spec.ts` — create persists zoom_link; invalid URL rejected (item 8).
- Convert-to-student still sets WON: existing `students/students.spec.ts` (unchanged, still green).

Build state: api `tsc` + `nest build` + `jest` green except the known pre-existing date-dependent
suites `capture` and `followup-reportto`. web `tsc` + `vite build` green; touched-area vitest
(`listaudit`, `sprint5`) green.
