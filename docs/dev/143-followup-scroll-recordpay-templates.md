# dev/143 — 28aug client batch: follow-up 2-calendars/scroll · record-payment B>V+search (REDO) · target scope cascade · Template Setup · convert Course Type

Six client items. Items 1–3 were reported "done" earlier but the client said they were STILL NOT working — the exact root causes are called out below.

## 1. Follow-up module — remove the DUPLICATE calendar + page scroller
**Root cause (why it wasn't working):** the **Follow-ups** screen (`dyn.tsx` `Followups()`) mounted **TWO** date/"calendar" controls: the shared **`<DateRange>`** (a calendar-icon chip with From/To pickers, `idPrefix="fu-dr"`) AND the **`<FollowupFilter variant="buttons">`** which itself carries a **Custom From/To** range. BOTH filter the SAME follow-up due date (`f.scheduled_at` — see `api/src/leads/followups.service.ts` L215-228: `from/to` and `fu_from/fu_to` both constrain `scheduled_at`). So the module literally showed two calendars doing the same job.
**Fix:** removed the redundant generic `<DateRange>` from `Followups()`. The ONE purpose-built follow-up control (presets Today/Tomorrow/Next7/Next30 + a Custom range) remains. This also shrinks the fixed header, which helps item 2.

## 2. Follow-up + Today's Follow-up — WORKING screen scroller
Both screens ARE in `LIST_SCROLL` (`web/src/Shell.tsx`: `followups`, `todayFollowups`) so they use the `.main--list` + `.tbl-fill` table-only-scroll pattern (sticky header, no page scroll). **Root cause of "not working":** these two are the only LIST_SCROLL screens with a TALL fixed header (KPI cards + one/two filter rows). Under `.main--list` full-height flex that tall header could squeeze the flex:1 results card toward zero (the Roles/Branch collapse class), so the list looked unscrollable.
**Fix:** `styles.css` now gives `.main.main--list .card.tbl-fill` a `min-height:200px` and its `.tbl-scroll`/`.scroll-x` a `min-height:132px`, so the results card + its scroll body always keep a usable, bounded, scrollable height while KPIs/filters stay fixed above — still a single scrollbar. (Removing the duplicate DateRange in item 1 further frees header room.)

## 3. Record Payment — Branch>Vertical breadcrumb + WORKING search (REDO)
The CollectModal (`sprint5.tsx`) already rendered the **Branch › Vertical › Course** breadcrumb and a search box, and `/enrolments?status=active&q=…` already searched. **Root causes it felt broken:** (a) phone matching used a plain `ILIKE` on the stored value, so a number stored formatted (`+91 98765 43210`) never matched a plain-digit query; (b) the search only narrowed a separate `<select>` the user still had to open — it surfaced no clickable results and didn't fill the modal.
**Fix:**
- API (`enrolment.service.ts list`): phone now matched on **DIGITS-ONLY on both sides** (`regexp_replace(l.phone,'\D','','g') ILIKE %<digits>%`); enrolment_no + name keep ILIKE. Returns branch_name/vertical_name/course_name (breadcrumb) — and now `course_type` too.
- Web (`CollectModal`): the search renders a **clickable results list**; picking a result FILLS the modal (sets the enrolment → breadcrumb + fee lines follow) and defaults the amount to the outstanding balance.

## 4. Target scope cascade (Branch → Vertical)
`targetincentive.tsx` `TargetModal`: when **Target For = Vertical / Course / Individual Employee** the scope entity was a FLAT global list. Now a **Branch → Vertical cascade**: pick Branch first (Course also offers a Vertical narrow), and the entity list is filtered — verticals by `branch_id`, courses by `meta.branch_id`/`meta.vertical_id`, employees fetched per branch (`GET /users?branch_id=` resolves multi-branch users through `user_assignment`). Branch/Team targets need no cascade.

## 5. Template Setup module (NEW) — Administration › Template Setup
- **Migration 116** `document_template` (org_id, unique `type`, name, `settings` JSONB, is_active, updated_by) **seeded with the 7 default templates**: fee_invoice, fee_receipt, student_id, employee_id, quotation, certificate, marksheet.
- **API** `api/src/doctemplates/` (new Global module — distinct from the existing message-`templates` module): `GET /document-templates`, `GET/PUT /document-templates/:type` (settings JSON), behind `settings.read`/`settings.update`.
- **Consumers wired** (non-destructively — a blank/missing setting falls back to the built-in default; overrides are threaded on the `Letterhead.tpl`): **Fee Invoice PDF** (header title, footer, terms fallback), **Fee Receipt PDF** (header title, footer), **Student ID card PDF** (header title), **Employee ID card** — NEW `GET /employees/:id/id-card` generator that consumes the `employee_id` template (button wired in HR › Employee Directory). Quotation/Certificate/Marksheet settings are stored + editable.
- **Web** `dyn.tsx` `TemplateSetup` (+ `templateSetup` in DYN, `specs.tsx` Administration › Template Setup): lists the 7 templates, edit modal for header/title, logo toggle, footer, terms (docs) and ID number format (ID cards).

## 6. Convert-to-student / new enrolment — Course Type
`course_type` master (#186) selector added to the convert flow (`convertstudent.tsx` per-course row) — defaults from the picked course's `meta.course_type`, editable, sent in the convert payload. **Migration 115** adds `enrolment.course_type` (nullable, backfilled from the course master). Both enrolment INSERT paths (`students/student.service.ts createConvertEnrolments`, `enrolments/enrolment.service.ts create`) persist it; the enrolment list/get read it; the convert result shows it.

## Migrations
115 `enrolment_course_type` (ADD COLUMN + backfill from m_course.meta) · 116 `document_template` (table + 7 seed rows). Both idempotent/backfilling — live rows unaffected.

## Tests added
- `api/src/doctemplates/doc-template.spec.ts` — CRUD + `overridesFor` mapping + seed order + never-throws.
- `api/src/pdf/template-consume.spec.ts` — Fee Receipt / Student ID PDFs consume the template header/footer; default fallback.
- `api/src/enrolments/record-pay-search.spec.ts` — q searches enrolment_no/name (ILIKE) + phone digits-only; projects branch/vertical/course_type.
- `api/src/students/convert-course-type.spec.ts` — course_type from row else master else NULL.
- `web/src/targetcascade.test.tsx` — Target For Vertical/Course shows a Branch selector; entity list filters by branch.
- api `tsc`+build+jest green except the pre-existing date-sensitive fails (`capture`, `followup-reportto`, `date.util`). web `tsc`+`vite build` green; vitest green except pre-existing `qa10matrix`/`followupreseed`.

## Verify (exact click paths for the main agent)
1. Marketing & Lead Management › **Follow-ups** — ONE follow-up date control (the segmented Follow-up buttons + Custom), no second calendar chip; long list scrolls inside the card with a sticky header, no page double-scroll.
2. Dashboard › **Today's Follow-ups** — same table-only scroll; KPI cards + filters stay fixed.
3. Finance & Collections › **Fee Collection** › **Record payment** — type a phone (formatted or plain) / name / enrolment no → a results list appears → click one → modal fills (Branch › Vertical › Course breadcrumb, amount defaults to outstanding).
4. Sales/Performance › **Target & Incentive** › new/edit target → Target For = **Vertical** (or Course / Individual Employee) → a **Branch** dropdown appears; the entity list is filtered to that branch.
5. Administration › **Template Setup** — 7 templates listed; edit one (e.g. Fee Receipt header title / footer) → download a Fee Receipt PDF and see the change. Employee Directory row → ID card (PDF) action honours the Employee ID template.
6. A lead → **Convert to Student** → each course row has a **Course Type** selector (defaults from the course); after convert the result + the enrolment carry the course type.

## Root-cause summary (items 1–3)
1. Two overlapping date/calendar controls on the Follow-ups screen (DateRange + FollowupFilter), both filtering `scheduled_at`. 2. Tall KPI/filter header collapsed the LIST_SCROLL results card toward zero height. 3. Phone search used plain ILIKE (formatted numbers never matched) and the search didn't surface clickable results / fill the modal.
