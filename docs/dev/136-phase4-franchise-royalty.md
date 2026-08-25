# dev/136 — Phase 4 Batch 1: Franchise & Royalty (foundation + royalty)

**Migration:** `105_franchise_royalty.sql` (continues after 104).
**New nav:** top-level **Franchise** group — real screens wired in (module-level P2 badge dropped;
the not-yet-built franchise sub-screens stay flagged P2).

Single-tenant, multi-branch, future-franchise. A **franchise operates one or more BRANCHES**; its
data = everything under those branches. Every ₹ figure is a scoped aggregate over the SAME finance
sources the Finance Dashboard uses (`fee_receipt` = collected, approved `refund` = refunds,
`enrolment.net_fee` = booked net), so franchise numbers RECONCILE with Finance.

## What shipped (items 1–5)

1. **Franchise entity + onboarding + branch mapping.**
   Tables `franchise` (name, code, owner name/email/phone, address/city, GST no, status
   Prospect/Onboarding/Active/Suspended/Terminated, agreement start/end, note) + `franchise_branch`
   join (a branch belongs to ≤1 franchise — `uq_franchise_branch_once`). List + Add/Edit/View with a
   branch multi-select. **Verify:** nav **Franchise › Franchises** → New franchise → fill + tick
   branches → Save; View shows the mapping; Edit re-hydrates.

2. **Franchise-scoped access (foundation).** `FranchiseService.branchIds()` resolves a franchise to
   its `branch_ids`; **`GET /franchises/:id/scope`** returns `{ franchise_id, code, name, branch_ids }`.
   All rollups + the statement reuse this resolver. **Verify:** the **View** dialog shows a "Data scope
   (branch IDs)" line (it calls `/scope`). Full "franchise-owner sees only own franchise" RBAC = later batch.

3. **Royalty / revenue-share configuration.** `royalty_plan` per franchise (or reusable template,
   `franchise_id NULL`) with an **effective date range** and four models — **% of collected revenue**,
   **% of net revenue**, **fixed monthly fee**, and **tiered** (`royalty_slab`: royalty % varies by
   revenue band, resolved greatest-min-≤-base like the dev/134 incentive slabs). Optional **monthly
   minimum guarantee** floors the payable. **Verify:** **Franchise › Royalty Plans** → New → pick a
   model (tiered reveals a bands editor) → Save → Compute preview.

4. **Royalty computation + statement.** Pure `computeRoyalty()` (royalty.util.ts). Statement for a
   franchise + period = gross collected, refunds, net collected, the rate applied, royalty amount,
   adjustments, payable — computed from the franchise's branches' collections. **Verify:**
   **Franchise › Royalty Statement** → pick franchise + DateRange (+ optional adjustments) → Generate.

5. **Franchise dashboard rollup.** Per-franchise KPI cards (active branches, students, enrolments,
   revenue collected, net revenue, outstanding dues, royalty payable, booked net fee) live from the
   franchise's branches, with a franchise selector + DateRange, + a royalty detail card. **Verify:**
   **Franchise › Franchise Dashboard**.

## API routes
- `GET /franchises`, `GET /franchises/:id`, `POST /franchises`, `DELETE /franchises/:id`
- `GET /franchises/:id/scope`, `GET /franchises/:id/dashboard?from&to`
- `GET /franchises/:id/royalty/statement?from&to&plan_id&adjustments_minor`
- `GET /royalty-plans?franchise_id`, `GET /royalty-plans/:id`, `POST /royalty-plans`,
  `DELETE /royalty-plans/:id`, `GET /royalty-plans/:id/compute?gross_minor&refunds_minor&months`

## New tables / migration 105
`franchise`, `franchise_branch`, `royalty_plan`, `royalty_slab` + permissions
`franchise.{read,create,update,delete}` and `royalty.{read,manage}` (granted to Super Admin &
Organization Admin at `all`). No franchise rows are seeded — the module opens empty.

## RBAC / permission catalog
`permission-catalog.ts` gains `franchise` (read/create/update/delete) and `royalty` (read/manage).

## Tests added (api/src/franchise/royalty.spec.ts — 18 tests, all green)
`pctOfMinor` (whole/half-up/zero), `resolveRoyaltySlab` (band, exact boundary, open-top,
order-independent, below-lowest→null), `monthsInPeriod`, `computeRoyalty` (percent_collected,
percent_net, fixed×months, tiered on gross, tiered on net, exact band boundary, minimum-guarantee
floor applied / not applied), `FranchiseService.branchIds` resolver, `FranchiseService.dashboard`
rollup aggregation.

## DEFERRED to the next Phase-4 batch
- Franchise-owner **login / RBAC** (a franchise owner sees only their own franchise's data) + partner
  **self-service portal**.
- Royalty **invoicing / payment tracking** (royalty invoice series, collection, outstanding ageing).
- Franchise-level **targets & performance**, leaderboard/benchmarking, territory, agreements/renewals
  (e-sign), compliance/audits, brand & training — the sub-screens still flagged **P2** under Franchise.
