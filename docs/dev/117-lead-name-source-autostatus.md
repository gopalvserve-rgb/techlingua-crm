# dev/117 — Lead Name + Source editable; hardened stage→status auto-rule

Client (Aug 2026): on the **lead edit form** the **Name** and **Source** fields could not be
edited, and the **auto-status from stage** (Enrolled → Won, Closed → Loss) was re-reported as
not working. Two changes.

## #1 — Name + Source editable on the lead edit form (and persisted)

**Before:** `web/src/leadsheet.tsx` showed the lead **name only in the read-only header** (there
was no Name field in the editable "Lead details" block), and **Source** was a hard-coded
read-only `<div>{lead.source_name}</div>`.

**Now (edit mode only; View stays read-only):**
- **Name** — a text input bound to `full_name` via `setEdits`. `full_name` was already in
  `LEAD_UPDATABLE` on the API, so `PATCH /leads/:id` already persisted it — the field simply
  never rendered. It now renders + saves.
- **Source** — a master-backed `<select>` over `ref.sources` (the Source master), bound to
  `source_id`. On the API, `source_id` was **not** an updatable column (only set on create /
  transfer), so `LeadsService.update()` now accepts a changed `source_id`: it is
  **scope-checked** (`enforcer.assertRefInScope(scope,'source',…)`, same as create/transfer),
  written through the normal SET path, and logged as a `field_change` activity. `source_id` was
  added to the no-op `recognised` list so a Source-only change is not treated as "nothing to
  update".

## #2 — Auto-status from stage (Enrolled → Won, Closed → Loss)

The rule already existed (dev/95) keyed on the pipeline stage **TYPE** (`open|won|lost`): a move
to a `won` stage forces Lead Status = **Won** (`m_status.code='WON'`), a `lost` stage forces
**Lost** (`code='LOST'`). Stage `stage_type` is constrained to `open|won|lost` (no `closed`
type) and the seed maps the terminal stages `Enrolled → won` and `Lost → lost`. So the rule is
correct **when the live terminal stages carry the right type**.

To make the client's rule hold **regardless of how a live pipeline was configured** (e.g. a
pipeline whose terminal stage is literally named **"Closed"** but was created with `stage_type
= 'open'`), the resolution is now a small exported helper `autoStatusFromStage(type, name)`:

1. stage **TYPE** is authoritative — `won → WON`, `lost → LOST`;
2. **NAME fallback** — for an `open`/untyped stage, a name reading as `enrol*` / `won` fires
   **WON**, and `clos*` / `lost` / `loss` fires **LOST**;
3. TYPE always wins over the name fallback.

So "Enrolled → Won" and "Closed → Loss" fire whether the live stage is typed or only named.
The forced status still wins over an explicit conflicting `status_id` in the same PATCH and
stays idempotent.

## Tests
- `api/src/leads/lead-name-source-autostatus.spec.ts` (new): `autoStatusFromStage` (type
  authoritative, name fallback, type-wins); `update` persists a changed `full_name`; `update`
  persists a scope-checked `source_id` + logs it; an `open` stage NAMED "Closed"/"Enrolled"
  still sets Lost/Won.
- Existing `lead-autostatus.spec.ts` (dev/95 type-based rule) still green.

## Quality gates
- api `tsc` + `build` clean; jest green except the 2 known pre-existing fails (`capture`,
  `followup-reportto`).
- web `tsc` + `vite build` clean; vitest `listaudit`(56) green; only the 2 known pre-existing
  fails (`qa10matrix` phone pins, `sprint3` calendar).
