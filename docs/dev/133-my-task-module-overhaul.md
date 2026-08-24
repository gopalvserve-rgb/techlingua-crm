# dev/133 — MY TASK module overhaul (crm18aug-v2 Batch 2)

Client docx "My task". Tasks and follow-ups share the `follow_up` table; a task is now
first-class. Migration **102** (`102_task_module_overhaul.sql`) adds `entity_type`,
`entity_id`, `task_status`, `completion_note`, `completed_by`, `kind` (all nullable/defaulted;
existing DONE rows backfilled to `task_status='completed'`). Runs on boot (`migrate.js && main.js`).

**Related-To entity type = FIXED ENUM (not a master).** The 13 types each map to a concrete
table/label/search in `api/src/leads/task-entities.ts` (`ENTITY_SOURCES`); a free-form master
entry would have no backing record picker. Register-as-master was therefore NOT chosen.

Where to verify each item (Leads CRM → **My Tasks** screen = `dash / mytasks`, unless noted):

1. **Rename "Reported by Me" → "Created by Me"** — My Tasks: the second tab now reads **Created
   by Me** (was "Reported by Me"). Also in the module list label ("Assigned/Created tasks").
   *Verify:* open My Tasks, see the two tabs "Assigned to Me" / "Created by Me".

2. **"Related To" entity link** — Add/Edit Task modal has a **Related To** type select (Lead,
   Student, Admission, Enrollment, Course, Batch, Payment, Invoice, Follow-up, Employer,
   Placement, Trainer, Staff) + a searchable **Related Record** picker (GET
   `/follow-ups/entity-search?type=&q=`). Stored as `entity_type`+`entity_id`.
   *Verify:* My Tasks → Add Task → pick "Related To = Student", search a student, save; reopen
   the task (Edit pencil) → the type + record prefill.

3. **Task Status column + field** — Add/Edit Task has a **Task Status** select (In Progress /
   On Hold / Completed). **Overdue** is DERIVED (pending + past due) and shown as a coloured
   badge on each task row. *Verify:* task row shows a status badge; Add/Edit shows the select.

4. **Assignee + relationship visible on every row** — each My Tasks row shows `Assignee: <name>`
   and, when linked, `<Type>: <record>` (e.g. "Student: Rahul"). *Verify:* My Tasks list rows.

5. **Task-specific filters** — My Tasks filter bar: **Task Status** (multi), **Related To** type,
   **Assignee** (users) — alongside the date range. *Verify:* the filter row above the cards.

6. **Completion / outcome tracking** — marking a task done opens a confirm with a **completion
   outcome/remark** textarea; server stamps `completed_at` + `completed_by` + `completion_note`.
   The outcome shows on the row ("Outcome: …") and in Edit ("Completion Remark").
   *Verify:* click a task's checkbox → type an outcome → Mark done → the row shows the outcome.

7. **6 cards** — **Open Tasks · Due Today · Overdue · In Progress · Completed · Due Next 7D**,
   each a live count for the current view; clicking a card filters the list (card→list, same
   predicate as the count). *Verify:* click "Overdue" → the list narrows to overdue tasks; the
   active card is highlighted.

8. **BUG FIX — task shows as "Follow-up" on the lead activity** → now labelled **"Task"**. The
   `follow_up` activity carries a `kind` marker ('task' | 'follow_up') written at create/update;
   `activityTitle` (web/src/leadsheet.tsx) renders "Task scheduled/completed/updated" for a task,
   "Follow-up …" for a follow-up. *Verify:* create a task on a lead from My Tasks → open that
   lead → Activity tab → the entry reads "Task scheduled …", not "Follow-up".

## Tests added
- api `task-entities.spec.ts`: 13 entity types + sources; entity-type validation; entity-label
  CASE; task-status validation (rejects derived 'overdue'); `deriveTaskStatus` (completed/overdue/
  keep); the 6 cards' predicates.
- web `taskmodule.test.tsx`: 13 Related-To types + display↔key maps; task-status labels; timeline
  label = "Task" for a task / "Follow-up" for a follow-up (BUG FIX #8).
- web `dashboard.test.tsx`: the My Tasks cards are now live filter buttons (was "must be dead").
- web `qa10matrix.test.tsx`: Add Task form has no phantom fields (new fields reach the body;
  the Related-Record search widget is EXEMPT with a written reason).

## Build/test status
- api `tsc` + build + jest green except the 2 known pre-existing fails (`capture`,
  `followup-reportto`). web `tsc` + `vite build` + vitest green except the 5 known pre-existing
  qa10 fails (Add Course / Configure Course / New student / walk-in convert / Add Lead).
- Entity-type chosen: **fixed enum** (13 types), stated above.
