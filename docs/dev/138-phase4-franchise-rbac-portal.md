# dev/138 — Phase 4 Batch 3: Franchise-owner RBAC · Partner Portal · Targets · Compliance

**This is the FINAL franchise batch — it COMPLETES Phase 4.** After it, every Franchise nav
item is a real screen: **no P2 flags remain under Franchise.**

**Migration:** `107_franchise_rbac_portal.sql` (continues after 106).

Single-tenant, multi-branch, future-franchise. A franchise operates one or more BRANCHES; its
data = everything under those branches. This batch lets a **franchise owner** log in and see
ONLY their franchise's mapped branches' data, adds a partner portal, and turns the last two P2
placeholders (Targets & Performance, Compliance & Audits) into real screens.

## 1. Franchise-owner role + RBAC scoping (the sensitive part)

**New system role `Franchise Owner`** (`is_system`, per org) + a franchise↔owner-user link:
`franchise.owner_user_id` (single primary owner) **and** a `franchise_user` mapping table
(franchise_id, user_id, role owner/staff) so a franchise can expose the portal to >1 user. A user
linked either way is a "franchise owner" for scoping.

**Enforcement point (where branch_ids get injected):** the existing RBAC chokepoint
`ScopeResolverService.buildScopeWhere()` (`api/src/rbac/scope-resolver.service.ts`). Every
list/dashboard/report in the app already scopes its SQL through `buildScopeWhere(scope, cols, params)`
(leads, students, fees, finance, enrolments, …). We:

- added `franchiseBranchIds?: number[] | null` to `ResolvedScope` (`rbac.types.ts`);
- in `PermissionsGuard` (`permissions.guard.ts`), resolve the caller's franchise scope ONCE per
  request (`RbacDataService.loadFranchiseScope(userId)` → `{ isOwner, franchiseIds, branchIds }`)
  and stamp `scope.franchiseBranchIds = isOwner ? branchIds : null` onto every resolved scope;
- in `buildScopeWhere`, when `franchiseBranchIds` is an array **and** the entity has a branch column,
  the base grant is **AND-narrowed** with `<branch_col> = ANY($n)`. `all` → `(branch = ANY)`;
  a scoped grant → `(base AND branch = ANY)`; empty array (owner with no mapped branches) → `1=0`;
  org-level entities without a branch column (masters) are left as-is (config stays readable).
- `ScopeEnforcerService` (by-ID + bulk record access) honours the same layer: its `scope.all`
  early-returns are skipped when `franchiseBranchIds` is set, so an owner cannot fetch a single
  lead/student/etc. outside their branches by guessing its id.

**Additive & non-breaking:** for a non-owner (`franchiseBranchIds === null`) `buildScopeWhere`
returns the base fragment verbatim — Super Admin and every existing branch/team/own-scoped role are
completely unchanged.

The **Franchise Owner** role holds READ-only grants at record_scope `all` (dashboard, master,
lead, followup, student, batch, enrolment, fee, finance, franchise, royalty, franchise_portal,
franchise_target, franchise_compliance) — `all` means "all of MY franchise" once the layer narrows
it. It holds no create/update/delete on operational data (read-only portal).

Franchise-entity endpoints (which key off `franchise_id`, not `branch_id`) get a parallel guard —
`FranchiseAccessService.assertCanAccess(userId, franchiseId)` (404 if an owner addresses a franchise
that is not theirs) — applied on every franchise `:id` read/action, and the Franchise LIST endpoints
are filtered to an owner's own franchises.

## 2. Partner self-service portal (owner view)

**Nav: Franchise › Partner Portal** (`dyn: franchisePartnerPortal`). `GET /franchise-portal/me`
returns the owner's own franchise dashboard (branches, students/enrolments, revenue collected, net,
outstanding dues, royalty payable), compliance %, targets and — via `GET /franchise-portal/royalty-invoices`
— their royalty invoices. No franchise selector (fixed to theirs). `/auth/me` now also returns a
`franchise` block for owner accounts so the SPA can render the portal auto-scoped. Head office keeps
the full Franchise module across all franchises.

## 3. Franchise Targets & Performance (P2 → real)

**Nav: Franchise › Targets & Performance** (`dyn: franchiseTargets`). New table **`franchise_target`**
(chosen over overloading `target_definition`: a franchise is not one of that table's `target_for`
units, and actuals come from the franchise's branches). Per franchise + period: admissions, enrolments,
revenue, collection targets. `GET /franchise-targets` (list), `POST /franchise-targets`,
`DELETE /franchise-targets/:id`, `GET /franchise-targets/:id/performance` (target-vs-actual, progress
bars, per-metric %), `GET /franchise-targets/leaderboard` (ranked across franchises for head office).
Actuals reconcile with Finance (fee_receipt = revenue, net = collection, enrolment rows in period).

## 4. Compliance & Audits (P2 → real)

**Nav: Franchise › Compliance & Audits** (`dyn: franchiseCompliance`). New tables
**`franchise_compliance_template`** (seeded DEFAULT template — agreement valid, KYC, GST filed,
statutory docs, royalty up to date, fee & brand policy, staff credentials, data privacy) and
**`franchise_compliance_item`** (per franchise, materialised from the template on first access):
status (pending/compliant/non_compliant/na), due date, evidence document (R2), note; live compliance %
and overdue count. `GET /franchises/:id/compliance`, `POST /franchises/:id/compliance/items/:itemId`
(set status/due/evidence), `POST /franchises/:id/compliance/items` (add), `DELETE …/items/:itemId`,
`POST /franchise-compliance/upload-url` (R2 presigned PUT). **Audit view** reuses the existing
append-only `audit_log` filtered to franchise-critical entities — `GET /franchise-audit?franchise_id=`
(owners see only their franchises' rows).

## New tables / migration 107
`franchise_user`, `franchise_target`, `franchise_compliance_template`,
`franchise_compliance_item` + `franchise.owner_user_id` column. New role **Franchise Owner**.
New permissions `franchise_portal.read`, `franchise_target.{read,manage}`,
`franchise_compliance.{read,manage}` (owner gets the reads; Super/Org Admin get all @ all).
Seeds only a compliance TEMPLATE + the role — **no fake franchise data**. Backfills so live rows work.

## Tests (mandatory RBAC isolation) — `api/src/franchise/franchise-rbac.spec.ts`, 9 green
- "a franchise owner's effective scope == their franchise's branch_ids"
- "a franchise owner querying leads is restricted to those branch_ids (ANDed onto a branch grant)"
- "a franchise owner whose franchise maps NO branches sees no rows (1=0)"
- "a franchise owner CANNOT widen to another franchise: only their branch_ids are bound"
- "Super Admin (no franchise link) is UNAFFECTED — full access"
- "a non-owner scoped role behaves exactly as before — no regression"
- "a franchise owner still reads org-level (branch-less) config: masters are not narrowed"
- FranchiseTargetService.performance — target vs actual computation
- FranchiseComplianceService.list — progress % and overdue

## Verify each (Franchise nav)
1. **Franchise › Partner Portal** — log in as a user linked as a franchise owner (set on the franchise
   form's "Portal login user" + assign them the Franchise Owner role under Users); the portal shows
   only that franchise's data.
2. **Franchise › Targets & Performance** — New target → pick franchise + period + metrics → Save;
   Performance shows target-vs-actual bars; leaderboard ranks franchises.
3. **Franchise › Compliance & Audits** — pick a franchise → checklist (materialised from template) with
   status/due/evidence; compliance % + overdue; audit trail below.
4. **All Franchise nav items are real — NO P2 flags remain.**

## Phase 4 status
**Phase 4 (Franchise & Royalty) is now COMPLETE.** Franchise records + branch mapping, royalty plans /
statements / invoices / payments / outstanding ageing / reports, agreements & renewals, onboarding,
territory, franchise-owner RBAC, partner portal, targets & performance, and compliance & audits are all
shipped. Intentionally left as future polish (not gaps): franchise-owner email invites / password
self-set flow, e-sign integration for agreements, and cross-franchise consolidated royalty payouts.
