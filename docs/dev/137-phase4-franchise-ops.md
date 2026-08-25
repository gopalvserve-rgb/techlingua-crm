# dev/137 — Phase 4 Batch 2: Franchise royalty ops & lifecycle

**Migration:** `106_franchise_ops.sql` (continues after 105).
**Nav:** the six P2 placeholders under **Franchise** become real screens (P2 badge dropped).
Only **Targets & Performance** and **Compliance & Audits** stay flagged P2 (Batch 3).

Reuses Batch-1 (`computeRoyalty`, the royalty statement, the dashboard rollup) + the finance
patterns: the numbering series (like GST invoices) and IST ageing (like Phase-3 fee dues). Every ₹
figure still reconciles with Finance (same `fee_receipt` / approved `refund` sources).

## What shipped (items 1–6)

1. **Royalty Invoices.** Generate a royalty invoice for a franchise + period FROM its royalty
   statement (reuses `RoyaltyService.statement` → `computeRoyalty`), freezing that period's revenue
   + royalty + adjustments into `amount_minor`. Own numbering series **ROY-<FY>/####** (new
   `royalty_invoice` NumberingService kind, FY reset — SEPARATE from student `INV-`). Status
   Draft / Issued / Paid / Cancelled, preview + **Print / PDF** (browser print of the invoice),
   list + generate-from-statement + view. **Verify:** **Franchise › Royalty Invoices** → *Generate
   invoice* → pick franchise + DateRange (+ optional adjustments) → *Preview statement* → *Generate
   & issue* → the row appears; click the invoice no to view/print.
   Routes: `GET /royalty-invoices`, `GET /royalty-invoices/:id`, `POST
   /royalty-invoices/from-statement`, `POST /royalty-invoices/:id/status`, `DELETE
   /royalty-invoices/:id`.

2. **Outstanding Royalties.** Ageing of unpaid / partly-paid royalty invoices per franchise —
   **current / 31-60 / 61-90 / 90+** buckets computed in IST (anchored on `issue_date`) — with a
   **record-payment** action (amount, date, mode, reference) that inserts a `royalty_payment`,
   reduces outstanding and **flips the invoice to Paid** when fully collected (re-opens to Issued if
   a payment is deleted). **Verify:** **Franchise › Outstanding Royalties** → the four bucket KPI
   cards + a per-invoice list; click the ₹ icon to record a payment and watch the outstanding drop.
   Routes: `GET /royalty-invoices/outstanding`, `POST /royalty-invoices/:id/payments`, `DELETE
   /royalty-invoices/:id/payments/:paymentId`.

3. **Agreements & Renewals.** Franchise agreement records (agreement no, sign / start / end /
   renewal dates), a signed **document uploaded to R2** (presigned PUT via StorageService, presigned
   GET on open), status Active / Expiring / Expired / Renewed (Expiring/Expired **derived** from
   `end_date` vs today), plus a **renewal reminder** banner listing agreements expiring within 60
   days. List + add/edit + document upload. **Verify:** **Franchise › Agreements & Renewals** → *New
   agreement* → fill dates + attach a PDF → Save; the expiring-soon banner shows near-expiry ones.
   Routes: `GET /franchise-agreements`, `GET /franchise-agreements/expiring`, `GET
   /franchise-agreements/:id`, `POST /franchise-agreements`, `POST /franchise-agreements/upload-url`,
   `DELETE /franchise-agreements/:id`.

4. **Onboarding.** A per-franchise onboarding checklist **materialised from a seeded default
   template** (migration 106 seeds `franchise_onboarding_template`: Application received → Agreement
   signed → Fee collected → Branches mapped → Royalty plan configured → KYC → Territory → Team →
   Training → Go-live) into `franchise_onboarding_step` on first access. Each step done/pending with
   completed-by/at + a live **progress %** bar; add / remove custom steps. **Verify:** **Franchise ›
   Onboarding** → pick a franchise → tick steps (progress % updates), add a custom step.
   Routes: `GET /franchises/:id/onboarding`, `POST /franchises/:id/onboarding/steps`, `POST
   /franchises/:id/onboarding/:stepId/toggle`, `DELETE /franchises/:id/onboarding/steps/:stepId`.

5. **Territory.** Territory mapping per franchise — allowed operating area(s) by city / region /
   pincode / area (`franchise_territory` table). Simple list + add/remove; a value shared with
   another franchise is surfaced as an **overlap warning** (shared, not blocked — a metro can be
   shared while pincodes are carved). **Verify:** **Franchise › Territory** → pick a franchise → add
   a city / pincode; add the same value to a second franchise to see the overlap warning.
   Routes: `GET /franchises/:id/territory`, `POST /franchises/:id/territory`, `DELETE
   /franchises/:id/territory/:territoryId`.

6. **Franchise Reports.** A per-franchise rollup — branches, students / enrolments, revenue
   collected, net revenue, outstanding dues, and **royalty billed vs paid vs outstanding** (from
   `royalty_invoice` / `royalty_payment` in the period) — as an on-screen table with a Totals row +
   **CSV export**, driven by a DateRange. Reuses the Batch-1 dashboard rollup + the new royalty
   numbers. **Verify:** **Franchise › Franchise Reports** → pick a DateRange → Export CSV.
   Route: `GET /franchise-reports`.

## New tables / migration 106
`royalty_invoice`, `royalty_payment`, `franchise_agreement`, `franchise_onboarding_template`
(+ seeded default steps), `franchise_onboarding_step`, `franchise_territory`. Backfill-safe (all
`CREATE TABLE IF NOT EXISTS`, no changes to existing rows). **No new permission keys** — reuses
`royalty.read` / `royalty.manage` (invoices, payments, outstanding) and `franchise.read` /
`franchise.update` (agreements, onboarding, territory, reports); migration 105 already grants both
admin roles, so live rows keep working.

## Numbering
`numbering.service.ts` gains the `royalty_invoice` kind → **ROY-<FY>/####**, reset per Indian FY
(like GST invoices). Lazily created; nothing else allocates from it.

## Tests added (api/src/franchise/franchise-ops.spec.ts — 13 tests, all green)
Royalty-invoice amount == `computeRoyalty` + adjustments (percent + tiered band frozen); ROY-
numbering series formats & increments (FY reset) + the kind is registered; ageing buckets
(current / 31-60 / 61-90 / 90+ boundaries + summed, zero-outstanding ignored); payment reduces
outstanding + flips to Paid when full (+ overpayment clamps); onboarding progress % (0/25/100 +
empty = 0, no divide-by-zero); migration 106 ships the five ops tables + seeds the template (and
seeds NO franchise rows); franchise report row carries every CSV column (billed − paid ==
outstanding). Pure helpers live in `franchise-ops.util.ts`. Pre-existing unrelated fails remain:
api `capture`, `followup-reportto`; web `qa10matrix`, `followupreseed` (date-sensitive, untouched).

## DEFERRED to Batch 3 (remaining Phase-4 work)
Franchise-owner **login / RBAC** (own-franchise-only) + **partner self-service portal**,
franchise-level **targets & performance** (leaderboard / benchmarking), and **compliance & audits**
— the two sub-screens still flagged **P2** under Franchise.
