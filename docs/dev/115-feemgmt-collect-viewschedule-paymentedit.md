# dev/115 — Fee Management: Roll No + Balance, View schedule, per-installment Collect, Edit payment (+audit)

Four client-requested changes to Fee Management / Fee Collection. Built on the existing
`POST /fees/collect` oldest-due-first allocation and the append-only `audit_log`.

## 1. Roll Number + Balance columns (Fee Management dues list)
`web/src/paymentplans.tsx` `FeeDuesScreen`. The **Roll Number** column (vertical-wise
`student_vertical_no`) already existed and stays default-visible; a new **Balance** column
was added = enrolment **Net − everything receipted** (the true outstanding, distinct from the
per-installment "Due Fee"). Server support: `api/src/paymentplans/dues.service.ts` — the dues
CTE now also returns `enrolment_paid_minor` + `balance_minor` on both branches (installment
dues and unplanned enrolment balances). Both columns are in the CSV export.

## 2. "Edit schedule" → "View schedule"
The Fee Management row action that opens the plan schedule was labelled **"Edit plan /
schedule"** (pencil). Renamed to **"View schedule"** (eye icon + tooltip); the schedule modal
header now reads "View schedule — {enrolment_no}". The Payment Plans list action was already
"View schedule".

## 3. Per-installment Collect
`PlanDetailModal` (the schedule view) gained a **Collect** column: every installment with
outstanding > 0 (and not waived) shows a **Collect** button, gated by `fee.collect`. It opens
the shared `CollectModal` (extended with `installmentId` + `defaultAmount`), prefilled to that
installment's outstanding and locked to the enrolment. `POST /fees/collect` now carries
`installment_id`, so the payment targets that installment first (overflow oldest-due, via the
existing `PlanService.spread` chosen-installment ordering). On success the schedule + balance
+ parent dues refresh.

## 4. Edit payment (correction) with audit log
New endpoint **`PATCH /fees/receipts/:id`** (`fee.controller.ts` → `FeeService.update`),
`@RequirePermission('fee.collect')`, scope-enforced (the initial `get` 404s outside access).
It: reverses this receipt's installment allocation, re-states amount/mode/reference/date/note,
re-applies the new amount (so schedule + balance stay exact), and writes an **`audit_log`**
row (`entity_type='fee_receipt'`, `action='update'`, `before`→`after`) inside the same
transaction. The over-collection guard survives the edit — the new amount is checked against
the outstanding EXCLUDING this receipt (enrolment locked `FOR UPDATE`). Gateway-captured
(Razorpay) receipts cannot be hand-edited. UI: an **Edit payment** action (pencil) on the Fee
Receipt Records list opens `EditPaymentModal`.

## Tests
- `api/src/fees/fee-update.spec.ts` (new): reverse+re-apply, audit before→after, chosen
  installment targeting, over-collection guard (boundary inclusive), reference-required,
  gateway refusal.
- `api/src/paymentplans/plan.service.spec.ts` already covers chosen-installment collect +
  reverse. api `tsc`+build+jest green (pre-existing `capture` / `followup-reportto` failures
  untouched). web `tsc`+`vite build`+vitest `listaudit` (56) green.
