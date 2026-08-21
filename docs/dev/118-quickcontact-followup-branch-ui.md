# dev/118 — Quick Contact / Follow-ups / Today's Follow-ups / Branch UI batch

Client UI batch (Aug 2026). Live commit for the code: **`692d043`** (deployed from a pristine clone;
served bundle `index-DzHrISGp.js`, changed from `index-DL4fsw2F.js`). No DB migration.

## 1. Quick Contact (`web/src/dyn.tsx` `QuickContact`)
- Added a prominent **Add lead** button next to Search; it opens the full Add-Lead flow
  (`openAdd('dash.quickcontact')`) — no need to search first.
- **Removed the "Custom Contact Property" columns** (Training Mode / Category / Remarks / Course)
  from the Quick Contact screen; only the core Scope + Basic-Details contact fields remain. Those
  attributes are captured on the full Add-Lead form.

## 2. Follow-ups module — filter dropdown → button row (`web/src/followupfilter.tsx`, `dyn.tsx` `Followups`)
- `FollowupFilter` gained a `variant` prop. The Follow-ups module now renders the preset filter as a
  single **row of buttons** (a `.seltabs` segmented toggle group): All Follow-up · Missed · Today ·
  Tomorrow · Next 7 Days · Next 30 Days · Custom. Same emitted params (`followup`/`fu_from`/`fu_to`)
  and logic as the old dropdown; the dropdown variant (default) is unchanged elsewhere. New CSS
  `.fu-btns` / `.fu-seltabs`.

## 3. Today's Follow-ups — 8 KPI stat cards (`dyn.tsx` `TodayFollowups`, `FU_BUCKETS`)
- New `GET /follow-ups/stats` (scope-enforced, IST) returns 8 buckets:
  **overdue · due_today · next7 · no_shows · done_today · rescheduled · hot_leads · unreachable**.
  Date buckets are IST calendar windows; disposition buckets (no_shows / rescheduled / unreachable)
  match on the disposition NAME (ILIKE), so any client-defined disposition rolls into the right bucket.
- The screen shows the 8 numbers as KPI cards (reusing the dashboard Quick-Stats card style). Each
  card is **clickable** and opens exactly its filtered list via `GET /follow-ups?bucket=<key>` — the
  same predicate the count uses (`followupBucketSql`), so the card number equals the list length.
- API: `FOLLOWUP_BUCKETS` + `followupBucketSql()` in `api/src/leads/followups.service.ts`;
  `stats()` service method; `bucket` added to the list filter; `@Get('stats')` controller route.
  Jest: `api/src/leads/followup-stats.spec.ts` (14 tests — the 8 predicates, scope-enforced single
  query, disposition join, soft-delete exclusion, `bucket` list filter, invalid-bucket 400).

## 4. Branch module — Vertical filter (`dyn.tsx` `Branches`)
- Added a **Vertical** multi-select `FilterMulti` (seeded from the top-bar scope) alongside the
  existing search + include-inactive. A branch is shown only if it owns one of the picked verticals
  (client-side over `ref.verticals.branch_id`). Full list treatment retained (export/refresh/columns/
  bulk-select). Export honours the vertical-filtered rows.

## Tests
- web `tsc` + `vite build` + vitest (`followupfilter.test.tsx` incl. new buttons-variant tests,
  `listaudit.test.tsx`) green.
- api `tsc` + build + jest (`followup-stats.spec.ts`, `followup-filter.spec.ts`) green.

## Browser-verified live (Chrome, Windows, Super Admin)
1. Quick Contact shows **+ Add lead** and no Custom-Contact-Property section.
2. Follow-ups filter is a button row; clicking **Missed** narrows to the 3 missed rows.
3. Today's Follow-ups shows the **8 KPI cards** (Overdue 3, rest 0); clicking **Overdue** opens the
   3-row overdue list with a Clear-card-filter control.
4. Branch module has a **Vertical** filter; selecting **INSTA** narrows the list to Vikaspuri only.
No dummy/ZZTEST data created (verification was read-only navigation + filter clicks).
