# dev/134 — Target & Incentive module + Counsellor Performance (crm18aug-v2 Batch 3)

Client docx "Target & Incentive" + "Counsellor Performance". The Sprint-5 **Monthly Target**
module is renamed to **Target & Incentive** and rebuilt as a richer, named target with an
Incentive Plan master; Counsellor Performance gains a calendar + scope filter and a two-row KPI
board.

## Migration
**103** (`103_target_incentive.sql`) — runs on boot (`migrate.js && main.js`). Adds three tables
and backfills:
- **`incentive_plan`** (id, org_id, name, applicable_to `branch|vertical|user`, metric
  `admissions|revenue|collection|leads|walkin|meeting`, status `active|inactive`, soft-delete).
- **`incentive_slab`** (plan_id FK, min_pct, max_pct (nullable = ∞), tier, emoji, label,
  amount_minor, sort_order) — 1:N under a plan.
- **`target_definition`** (id, org_id, name, target_for `user|team|branch|vertical|course`, the
  matching entity FK, period_type `monthly|quarterly|half_yearly|yearly|custom`, period_start,
  period_end (half-open), the six metric targets: leads/walkins/admissions/revenue_minor/
  collection_minor/meetings, incentive_plan_id FK, soft-delete).
- **BACKFILL**: every ACTIVE `monthly_target` row is copied into `target_definition` (period_type
  `monthly`, admissions_target ← enrolment_target, revenue_target_minor carried) — idempotent, so
  the rename loses nothing. The old `monthly_target` table is LEFT INTACT (the Sprint-3 dashboard
  "This month vs target" bar and the Sprint-6 reports still read it via `/performance/targets*`).
- **SEED**: one example plan `Admissions Incentive (example)` with the client's 8 tiers
  (🔴 Critical / 🟠 Below / 🟡 Near / 🟢 Good / 🟢 Strong / 🔵 Achieved / 🟣 Excellent /
  🏆 Exceptional). Every threshold + amount is editable in the UI.

## Is the Incentive Plan a master or a table?
**A DEDICATED TABLE** (`incentive_plan` + `incentive_slab`), NOT a generic `m_*` master — a plan
is an ordered set of achievement slabs with money on each, structure the generic
(name, code, meta) master framework cannot hold or validate.

## API (all under `/performance`, RBAC `target.read` / `target.manage`, reused — no new perms)
- Targets: `GET/POST /performance/target-defs`, `DELETE /performance/target-defs/:id`,
  `GET /performance/target-defs/:id/dashboard` (six progress cards + earned incentive).
- Incentive plans: `GET/POST /performance/incentive-plans`, `DELETE /performance/incentive-plans/:id`,
  `GET /performance/incentive-plans/:id/compute?pct=` (the achievement→incentive resolver, exposed).
- Counsellor Performance: `GET /performance/leaderboard` and `GET /performance/summary` now accept
  `from`, `to`, `branch_id`, `vertical_id`, `user_id` and return `leads_contacted`, `meetings`,
  `adherence_pct` in addition to the Sprint-5 fields.

## The resolver (`resolveIncentive`, pure, unit-tested)
Earned slab = the slab with the GREATEST `min_pct` ≤ achievement %. `max_pct` is a display bound
only, so a decimal (69.5%) and an exact boundary (100%) both resolve deterministically; below the
lowest slab earns ₹0.

## Actuals (one definition, shared with the reports)
Leads = `lead` created in period; Walk-ins = `walk_in`; Admissions = ACTIVE `enrolment` created in
period; Revenue = `net_fee_minor` of those (BOOKED, pre-tax); Collection = `fee_receipt` cash in
period (attributed by the enrolment's entity); Meetings = `calendar_event` type='meeting'.
Attributed by the Target-For entity (counsellor/team/branch/vertical/course).

## WHERE TO VERIFY — Performance & Conversion › **Target & Incentive** (nav renamed from "Monthly Targets")

**Part 1A — Target definition.** Target & Incentive → **Targets** tab → **New target**. Set a
**Target name**, a **Target for** (Individual Employee / Team / Branch / Vertical / Course) + its
entity, a **Period** (Monthly / Quarterly / Half-Yearly / Yearly / Custom), the six metric targets
(Leads · Walk-ins · Admissions · Revenue · Collection · Meetings) and optionally an **Incentive
plan**; Save → the target appears in the list.

**Part 1B — Incentive Plan master.** Target & Incentive → **Incentive Plans** tab. The seeded
`Admissions Incentive (example)` is listed. Edit it → change any slab's From %, To %, label, emoji
or amount → **Compute** with a test % shows the earned band + amount (calls
`/performance/incentive-plans/:id/compute`). New plan / delete also here.

**Part 1C — Target dashboard cards.** Targets tab → click the **chart (progress) icon** on a target
row → six cards Admissions · Revenue · Collection · Leads · Walk-ins · Meetings, each actual/target
+ % with a progress bar, plus the earned incentive from the linked plan.

**Part 2 — Counsellor Performance.** Performance & Conversion › **Counsellor Performance**. Top bar:
**calendar (date-range)** + **Branch / Vertical / Counsellor** dropdowns drive all numbers.
**Row 1 (Sales):** Leads Assigned · Leads Contacted · Enrolments · Conversion %.
**Row 2 (Financial & Productivity):** Revenue Booked · Revenue Collected · Meetings Scheduled ·
Follow-up Adherence %. The leaderboard adds Contacted + Meetings columns.

## Tests added
- `api/src/performance/incentive.spec.ts` — `resolveIncentive` across every band + boundaries +
  order-independence + gaps; `resolvePeriod` (monthly/quarterly/half-yearly/yearly/custom); `pct1`.
- `api/src/performance/target-def.spec.ts` — actuals attribution per Target-For (user/branch/course),
  active-only admissions + booked revenue + receipt collection; save validation; and Counsellor
  Performance Part-2 KPIs (leads_contacted, meetings, conversion %, adherence, scope filter in SQL).
- `web/src/sprint5.test.tsx` — updated for the two-row Counsellor board.

## Note (route-reachability)
The Target modal's Team picker now reads `GET /teams`, so the stale `GET /teams` / `POST /teams`
entries were removed from the reachability quarantine (`api/src/route-reachability.spec.ts`).
There is still no dedicated New-Team form; the path-level matcher can't distinguish the verbs.
