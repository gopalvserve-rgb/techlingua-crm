# dev/127 — Quick Contact · Task Branch/Vertical · Add Referral student search · Enrollment View + Fee columns

Client Aug 2026 batch (4 changes). Front-end `web/src/dyn.tsx` + `web/src/forms.tsx`; API `api/src/leads/followups.service.ts`, `api/src/students/student.service.ts`; migration `099_task_branch_vertical.sql`.

## 1) Quick Contact — Branch › Vertical + Campaign overview
- Removed the right-column **Campaign** select card and the **Contact Source** checkbox block (the custom source block).
- Added a **Branch › Vertical** card (reads the chosen scope) and a read-only **Campaign overview** panel (Campaign / Pipeline / Vertical / Branch summary). Campaign is still chosen in the left "Lead Details — Scope" grid, which drives the overview. Core quick-contact fields unchanged.

## 2) Add/Edit Task — Branch + Vertical
- `dash.mytasks` form gains **Branch** + **Vertical** selectors (shared CASCADE: Vertical filters by Branch).
- Persisted on the `follow_up` (task) row via new nullable `branch_id` / `vertical_id` columns (migration 099, guarded `ADD COLUMN IF NOT EXISTS` + FKs `ON DELETE SET NULL`).
- Create (`POST /follow-ups`) + update (`PATCH /follow-ups/:id`) accept + persist them; the list SELECT exposes `COALESCE(f.branch_id, l.branch_id)` (falls back to the lead's path) + names, so Edit prefills consistently.
- Jest: `api/src/leads/task-branch-vertical.spec.ts` (create/update persist + clear; list SELECT exposure).

## 3) Add Referral — existing-student search + auto-fill
- New `StudentLookup` control + `studentlookup` field type. Shown when **Referrer Type = Existing Student** (now the default); other referrer types keep the manual-entry path.
- Reuses the Student Management search `GET /students?q=` (name / phone / student id); on select, auto-fills Referrer Name, Referrer Contact Number, Branch, Vertical, Course Interested from `GET /students/:id`.
- qa10: the helper carries no payload of its own, so it is EXEMPT (like Levels / Class days).

## 4) Course Enrollment View + Fee Management columns
- (a) Read-only **View** action on each Course Enrollment row (visible to users WITHOUT edit permission) — `ViewEnrolmentModal` renders course, levels, fee, discount, net, plan, status, dates read-only.
- (b) **Fee Management** within the student profile now shows the same enrolment columns: Roll Number · Enrolment Number · Branch · Vertical · Course · Level · Total Fee · Net Fee · Fee Plan · Due Fee · Status (+ Actions). Added `outstanding_minor` (Due) to the profile fees enrolments query.
