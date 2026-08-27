# dev/141 — 27aug client batch C (source/campaign · batch · attendance · teams · sales-closer/quotation)

Eighth client batch after dev/140. Eight items across Source masters, the Batch module, Attendance,
Target-&-Incentive Teams, and the Sales Closer + Quotation. Migrations **110–114** (dev/140 ended at
109). api `tsc`+build+jest green except pre-existing `capture`/`followup-reportto`/`date.util`; web
`tsc`+`vite build` green, vitest green except pre-existing `qa10matrix`/`followupreseed`.

## Item 1 — Source creation must NOT require Campaign + reconcile the two source masters
There were TWO "source" concepts: the campaign-scoped `source` table (lead.source_id → the
Marketing **Lead Source Master** screen) and the generic master `m_source` (Administration ▸ Masters
▸ **Sources**, also the walk-in "How did you hear about us?" list).

- **(a) Campaign optional** — `HierarchyService.createSource` no longer requires `campaign_id`. When
  omitted the source is created **org-level** (branch/vertical/pipeline/campaign all NULL). Migration
  **110** makes those four `source` columns NULLABLE. Web: the Add Lead Source form (`forms.tsx`
  `leads.sources`) Branch/Vertical/Pipeline/Campaign are now OPTIONAL (Campaign hint: "leave blank
  for an org-wide source"); the submit sends `campaign_id` only when chosen.
- **(b) Reconciliation** — **`m_source` is the ONE canonical Source catalogue.** Every campaign-scoped
  `source` is now GUARANTEED to be backed by a canonical `m_source`: on create AND on rename the
  server find-or-creates the `m_source` by (case-insensitive) name and links `source.master_source_id`
  (`ensureMasterSource`). Migration **110** BACKFILLS the link for every existing source (creating any
  missing catalogue rows). The two screens can no longer diverge — the Lead Source Master is a set of
  (optionally campaign-scoped) instances of the canonical `m_source` catalogue, and existing
  `lead.source_id` references are never touched.
- **Verify:** Marketing ▸ **Lead Source Master** ▸ *Add Lead Source* → leave Campaign blank, enter a
  name, Save (succeeds org-level). Then Administration ▸ Masters ▸ **Sources** shows that same name.

## Item 2 — Batch status "On Hold"
Added an 8th lifecycle code `on_hold` (a MANUAL status, like `suspended`). Migration **111** adds it
to `batch_status_def` + widens the `batch_status_check`. Code: `BATCH_STATUS_CODES` +
`BATCH_MANUAL_STATUSES` include `on_hold`; web `BATCH_STATUS_META`/`BATCH_STATUS_ORDER` + Add-batch
status select + the Change-status modal (server catalogue) + the list status filter all carry it.
- **Verify:** Students ▸ **Batches** → a batch ▸ *Change status* → **On Hold** (badge shows amber
  "On Hold"; the list **Status** filter has an *On Hold* checkbox).

## Item 3 — New/Edit Batch: optional Course Level(s)
When the selected course HAS levels the Add/Edit Batch form shows an OPTIONAL **Course Level**
multi-select; hidden when the course has none. Migration **112** adds `batch_level` (batch_id,
course_level_id, code/label snapshot). `BatchService.create/update` persist via `syncBatchLevels`;
list/get return `levels`.
- **Verify:** Students ▸ Batches ▸ *New batch* → pick a course that has levels → the **Course Level**
  chips appear; tick A1/A2, Save; reopen Edit to see them retained.

## Item 4 — Assign a batch from Student Management (per enrolment, with level)
New endpoint `POST /students/:id/enrolments/:eid/assign-batch` (+ `StudentService.assignEnrolmentBatch`)
sets `enrolment.batch_id` (migration **113** adds the index + `batch_assigned_at/by`). Web: an
**Assign batch** action on each Course-Enrollment row opens a modal that surfaces the enrolment's
Branch › Vertical › Course › Level and lists only batches for that branch/vertical/course.
- **Verify:** Students ▸ open a student ▸ **Course Enrollment** tab ▸ *Assign batch* on a row.

## Item 5 — Easy assign for multi-enrolment / uncleared step
Because the action is **per enrolment**, a multi-enrolment student gets a batch per course; each modal
is labelled with that enrolment's Branch›Vertical›Course›Level. The guard was relaxed: assignment is
**NOT hard-blocked** by an incomplete admission step — the API allows it and returns a `warning`, and
the modal shows an amber reminder banner instead of refusing. (A batch for a *different course* is
still rejected.)
- **Verify:** on a student with 2+ enrolments whose admission step isn't "admitted", *Assign batch*
  still saves and shows the warning banner.

## Item 6 — Attendance filters + search
`AttendanceService.list` gains **Course**, **Trainer**, multi-**Status** (Present/Absent/Late/…),
plus a **search** across student name / roll no (student_no) / enrolment number. Web: the Attendance
screen filter bar adds Course, Trainer, Status selects and a search box (consistent with the leads
filter chips). Existing Branch/Vertical/Batch/date-range remain.
- **Verify:** Students ▸ **Attendance** → filter by Course/Trainer/Status and type a student name /
  roll / enrolment in the search box; the **Attendance records** table narrows.

## Item 7 — Target & Incentive Teams: create team with members
New **Teams** tab on Target & Incentive (`targetincentive.tsx`) — a Teams list + a create/edit modal
(name, Branch, Vertical, leader, and a **multi-select member checkbox list**). Uses the existing
`/teams` API (`team.create`/`team.update`, member_ids). The Target form's "Target For = Team" reads
the same `/teams`.
- **Verify:** Performance ▸ **Target & Incentive** ▸ **Teams** tab ▸ *New team* → name it, tick
  several members, Create; the member count shows; then Targets ▸ Add ▸ Target For = **Team**.

## Item 8 — Sales Closer + Quotation: Branch>Vertical>Course>Level>Payment plan
- **Sales Closer** (the "Close the sale — new enrolment" modal, `sprint5.tsx EnrolmentModal`): Branch
  & Vertical come from the lead; added an optional **Course Level** selector (shown when the course
  has levels) that snaps the Total fee to the level fee; **Payment plan** already present.
- **Quotation** (`sprint5.tsx QuotationModal`): added a quotation-level **Payment plan** select
  (persisted — migration **114** `quotation.payment_plan`) and a per-line **Course Level** selector
  (sets the line rate to the level fee). Branch/Vertical are inherited from the lead; Course is the
  existing per-line picker.
- **Verify:** Performance ▸ **Sale Closure** → *Close the sale* → pick a levelled course → **Course
  Level** appears + fee snaps. Performance ▸ **Quotations** → *New quotation* → **Payment plan**
  select in the header; on a line with a levelled course a **Course Level** dropdown appears.

## Migrations added
- 110 `source_campaign_optional` — nullable path cols on `source` + backfill `master_source_id` from `m_source` (find-or-create).
- 111 `batch_on_hold` — `on_hold` code + widened CHECK.
- 112 `batch_course_levels` — `batch_level` table.
- 113 `enrolment_batch_assign` — index + `batch_assigned_at/by` on `enrolment`.
- 114 `quotation_payment_plan` — `quotation.payment_plan`.

## Tests added
- `hierarchy/source-optional-campaign.spec.ts` — org-level source (no campaign) + canonical m_source find-or-create + campaign-path still derived.
- `students/batch-onhold-level.spec.ts` — on_hold is known+manual, changeStatus pins it, list filter accepts it, create writes batch_level.
- `students/enrolment-assign-batch.spec.ts` — assign with incomplete admission returns a warning (not blocked), different-course rejected, unassign clears.
- `academics/attendance-filters.spec.ts` — course/trainer/multi-status/search clauses composed.
- `teams/teams-members.spec.ts` — create inserts each member; update replaces membership.
- `quotations/quotation-payment-plan.spec.ts` — create persists payment_plan.
- `hierarchy/source-reparent.spec.ts` — mock updated for the rename→canonical-sync behaviour.

## Deploy
- Commit `a4d3c20` pushed to `gopalvserve-rgb/techlingua-crm main` (supersedes `03d8108`).
- Deployed from a pristine `--depth 1` clone via `railway up . --path-as-root --service api` (no npm install in the deploy dir). Railway deployment `f0128306-814f-4cee-a3cb-fdde3a5289fe`.
- Served bundle CHANGED `index-cjOPWU-L.js` → **`index-C3F6CvH3.js`**. grep-verified markers in the served JS: `enrol-assignbatch-save`, `att-f-trainer`, `quote-plan`, `team-members-list`, `Only batches for this enrolment`, `org-wide source`, `On Hold`.
- App Online: `/`→200; `/api/enrolments`, `/api/teams`, `/api/batches/status-catalog`→401 (auth-gated) — so migrations 110–114 ran on boot.
