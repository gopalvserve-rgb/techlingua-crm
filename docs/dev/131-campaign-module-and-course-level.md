# dev/131 — Campaign module (#213) + Course/Level rules (#214)

Two crm18aug client-feedback batches. All 8 items below. New master **`campaign_type`**
(migration **100**). No other new tables — the Level master reuses the existing `m_level`
+ generic `meta` filtering; the fee fallback + summary reuse existing tables.

## BATCH A — Campaign module (task #213)

### 1. Clickable lead count
`web/src/dyn.tsx` `Campaigns()` — the **Leads** cell in the Campaigns table is now an
`<a class="mlink" data-testid="camp-leads-<id>">` that calls
`go('leads','all',{ campaign_ids:<id>, ...owner })` → opens the Leads list pre-filtered to
that campaign (reuses the same `campaign_ids` query param the dashboard KPI links use).
**Verify:** Leads › Campaigns & Masters → the number in the **Leads** column is a blue link;
click it → Leads list opens filtered to that campaign.

### 2. Lead Counsellor (owner) filter
`web/src/dyn.tsx` `Campaigns()` — a `FilterMulti label="Lead Counsellor" testid="fm-owner"`
was added to the campaign filter row. It narrows: the rolled-up KPI cards, the per-campaign
lead counts, and the `owner_ids` carried into the clickable lead-count link.
API: `GET /api/leads/summary?owner_ids=` now honoured (`leads.controller.ts` + `leads.service.ts`).
**Verify:** Campaigns page → **Lead Counsellor** filter → pick a user → the cards + Leads
counts + the count-link all narrow to that counsellor.

### 3. More summary cards
`web/src/dyn.tsx` `Campaigns()` cards: **Active campaigns · Leads (MTD) · Won · Lost ·
Revenue · Active leads · Closed**. Won/Lost open the filtered Leads list. Backed by
`leads.service.ts summary()`, extended with `lost` / `active`(open) / `closed`(won+lost) counts
and `revenue_minor` (SUM of `fee_receipt.amount_minor` joined to `enrolment`, the SAME source
the Finance dashboard uses, scope-narrowed). **Verify:** the 7 cards render with real numbers;
Won/Lost are clickable.

### 4. Campaign Type master (customizable)
- Migration **`api/db/migrations/100_campaign_type_master.sql`** — creates `m_campaign_type`
  (m_source shape + soft-delete), seeds the 5 hard-coded values (Digital, Print, Event,
  Referral Drive, Tele-calling) + any distinct `campaign.campaign_type` already stored.
- `api/src/masters/masters.service.ts` `MASTER_TYPES.campaign_type` → full `/api/masters/campaign_type`
  CRUD + Masters-admin auto-list. `api/src/database/seed.ts` seeds it on a fresh DB.
- `web/src/refdata.tsx` loads `campaignTypes` from `/masters/campaign_type`.
- `web/src/forms.tsx` `CampaignModal` — the Campaign Type field is now a master-backed
  `<select data-testid="campaign-type-select">` reading `ref.campaignTypes`, with a blue
  `＋ Master` (`MasterQuickAdd type="campaign_type"`) that adds a type inline and auto-selects it.
  A legacy value not in the master still renders so an old campaign never loses its type.
  `campaign.campaign_type` still stores the label text → existing campaigns unaffected.
**Verify:** Create Campaign → **Campaign Type** is a dropdown of master values + a **＋ Master**
link; add one → it appears + is selected. Administration › Masters → **Campaign Types** is listed.

### 5. Same user as assignee AND manager
`web/src/forms.tsx` `CampaignModal` — the **Agents** (round-robin) and **Campaign Managers**
pickers are independent `UserPicker`s; neither excludes the other, and the API stores them in
separate places (`distribution_config.agent_user_ids` vs `campaign_manager` table) with no
overlap rejection (`hierarchy.service.ts replaceManagers` + `campaign-config.validator.ts`).
No code path removed a user from one list because the other held it — a user can be BOTH.
**Verify:** Create/Edit Campaign → add the same user under Agents AND under Campaign Managers →
Save → reopen → the user is present in both.

## BATCH B — Course / Level rules (task #214)

### 8. Level master follows Branch → Vertical + Fee + Duration
`web/src/mastermodal.tsx` `AddMasterModal` — for `type="level"` the form now surfaces
**Branch**, **Vertical** (filtered by Branch), **Fee** and **Duration**, persisted into the
master's `meta` (`{ branch_id, vertical_id, fee, duration }`). The generic `/api/masters/level`
list already filters by `meta.branch_id` / `meta.vertical_id` (`masters.service.ts`), so the
Level master is now branch/vertical-scoped like other masters. **Verify:** Administration ›
Masters › **Levels** → Add/Edit → Branch, Vertical, Fee, Duration fields present + saved.

### 10. Blank level fee → fall back to standard course fee
`api/src/enrolments/level.util.ts` `resolveLevels(master, input, scope, standardFeeMinor)` —
when a selected level's fee resolves to blank/zero it now uses the course's Standard Fee
(`m_course.meta.fee`) instead of ₹0. `api/src/students/student.service.ts` fetches it via
`fetchStandardFeeMinor(courseId)` and passes it at all three `resolveLevels` call sites
(convert/enrol, edit-enrolment, add-level). **Verify:** define a course level with a blank fee
+ a Standard Fee → enrol/convert on that level → the enrolment Total uses the Standard Fee, not ₹0.

### 11. Hide the Level option when the course has no levels
Already enforced and now locked by tests: `web/src/convertstudent.tsx` gates the level block on
`(rowLevels[i] ?? []).length > 0`; `web/src/dyn.tsx` LevelPicker returns `null` when the course
has no levels; the Add-level modal shows "No further levels" instead of an empty picker. A
no-level course uses its single Standard Fee. **Verify:** convert/enrol a course with zero
levels → NO Level selector appears; a course with levels → the Level checkboxes appear.

## Tests added
- `api/src/masters/campaign-type-master.spec.ts` — campaign_type registered + CRUD round-trip + migration 100 seeds.
- `api/src/leads/campaign-summary.spec.ts` — summary rolls up Won/Lost/Active/Closed + Revenue, and owner_ids narrows kpis + revenue.
- `api/src/enrolments/level.util.spec.ts` (appended) — blank/zero level fee falls back to the standard fee.
- `web/src/campaign-course-level.test.tsx` — campaign-type master select + Level master Branch/Vertical/Fee/Duration + convert hides/shows level.
- `web/src/qa10matrix.test.tsx` — RefData mock updated with `campaignTypes` (Campaign Type is now master-backed).

## Migration / master numbers
- New migration: **100** (`100_campaign_type_master.sql`) — next after 099.
- New master type: **`campaign_type`** → table `m_campaign_type`.
