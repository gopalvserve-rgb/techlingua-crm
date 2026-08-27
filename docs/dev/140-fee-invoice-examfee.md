# dev/140 — Fee Invoice restructure + Exam Fee + Fee Invoice dashboard (26/27aug Batch B)

Task #227. Finance-critical. Migration **109** (`109_exam_fee.sql`). All new money columns
default **0**, so every existing enrolment's Net / Total / Balance / dues / revenue / invoices
are **unchanged** until an exam fee is actually set on a course/level.

## The exact fee math (CRITICAL rule)

Exam fee is **excluded** from the discount and the instalment plan, and **added on top**:

```
Net           = (course/level fee − discount)     -- discount applies HERE only
instalments   = built on Net                      -- exam fee is NOT split into instalments
Total payable = Net + Exam fee (+ Tax on invoice) -- exam fee added on top, undiscounted
Balance/Due   = Total payable − Amount paid        -- exam fee is collectible
```

### Worked example
Course/level fee ₹20,000; discount 10%; exam fee ₹1,000; GST 18% (intra-state):

| Step | Value |
|---|---|
| Gross (level fee) | ₹20,000 |
| Discount 10% | −₹2,000 |
| **Net** (fee − discount) | **₹18,000** |
| Instalment plan base | ₹18,000 (Net only) |
| Exam fee (never discounted) | +₹1,000 |
| Taxable value on the Fee Invoice | ₹19,000 (Net line + Exam line) |
| GST 18% (CGST 9% + SGST 9%) | +₹3,420 |
| **Grand total (Fee Invoice)** | **₹22,420** = Net + Exam + Tax |
| If ₹5,000 paid | Balance = 19,000 − 5,000 = **₹14,000** (exam fee is in the balance) |

## New migration / columns (109_exam_fee.sql)
- `course_level.exam_fee_minor` BIGINT NOT NULL DEFAULT 0 — per-LEVEL exam fee (master, paise)
- `enrolment_level.exam_fee_minor` BIGINT NOT NULL DEFAULT 0 — per-level exam fee snapshot
- `enrolment.exam_fee_minor` BIGINT NOT NULL DEFAULT 0 — the enrolment's total exam fee snapshot
- single (level-less) course exam fee lives in `m_course.meta->>'exam_fee'` (rupees) — no column

## Per-item — what changed + where to verify

### 1. "Invoice" → "Fee Invoice"
- Nav label `Invoices` → **Fee Invoices** (`web/src/specs.tsx`).
- List title `Tax Invoices` → **Fee Invoices (GST)**; button **New Fee Invoice**; modal headers
  **New Fee Invoice** / **Fee Invoice {no}** (`web/src/invoices.tsx`).
- PDF header **Fee Invoice (Tax Invoice)** + PDF title **Fee Invoice** (`api/src/pdf/documents.ts`).
  GST/tax-invoice semantics kept.
- **Verify:** left nav shows "Fee Invoices"; open it → title/button; New → modal header; a PDF header reads "Fee Invoice (Tax Invoice)".

### 2. Fee Invoice = the enrolment→payment flow (search + auto-pull)
- New Fee Invoice modal: **search box** (enrolment no / student name / phone) → pick an enrolment
  → a read-only **auto-pull panel**: Student·phone, Enrolment no, Course, **Branch › Vertical**,
  Fee plan, Net, **Exam fee**, **Total payable**, Amount paid, Balance (`web/src/invoices.tsx`).
- Server search (`api/src/enrolments/enrolment.service.ts` list `q`) now matches phone too.
- Leaving the line blank lets the server **auto-pull** the course-fee line AND (when set) a separate
  **exam-fee line** (`api/src/invoices/invoice.service.ts enrolmentContext.defaultItems`).
- **Verify:** New Fee Invoice → search a student by name/phone/enrolment no → pick → the summary
  panel fills; Create draft → the draft has a course-fee line + (if exam fee set) an exam-fee line;
  total = Net + Exam + Tax.

### 3. Exam Fee in the fee setup (CRITICAL calc)
- Course form: per-level **Exam fee (₹)** input in the Levels editor; **Standard Exam Fee** for a
  level-less course (`web/src/forms.tsx`, edit path `web/src/dyn.tsx courseEditSpec`).
- API: `course_level.exam_fee_minor` (`api/src/courses/course-levels.service.ts`); level snapshot in
  `resolveLevels` (`api/src/enrolments/level.util.ts` + `sumLevelExamFees`); enrolment write on
  convert / add-enrolment / edit / add-level (`api/src/students/student.service.ts`) and the CRM
  enrolment path (`api/src/enrolments/enrolment.service.ts normaliseMoney`). Net stays fee−discount;
  Total/Balance = Net + Exam − Paid.
- **Verify:** set a level's exam fee (or a course Standard Exam Fee) → enrol a student on it → the
  enrolment's Net excludes it, Total payable = Net + Exam, and the Fee Management Balance/Due includes it.

### 4. Discount over-cap approval in AMOUNT too
- The over-cap decision (`decideMasterDiscount` / `decideDiscount`) compares the **requested discount
  in paise** against the Discount-Master cap = `min(percent-cap, amount-cap)` (`discount-master.util
  capMinor`). A fixed-AMOUNT discount that exceeds the amount cap therefore triggers approval exactly
  like the percent path — held at the cap for a non-authorised user, applied in full for an approver.
  Locked with tests (`api/src/enrolments/exam-fee.spec.ts`).
- **Verify:** a Discount Master with a max **amount** (e.g. ₹1,500); enter a ₹1,800 amount discount as
  a counsellor → the enrolment holds the over-cap portion pending; an approver applies it in full.

### 5. Fee Invoice dashboard
- KPI cards on the Fee Invoice screen: **Total Invoiced · Paid · Outstanding · GST charged** +
  status counts (Issued / Paid / Drafts / Cancelled), with Branch/Vertical/Status/Supply/DateRange
  filters. Reuses `gst_invoice` (same source as the Finance dashboard → reconciles):
  `invoice.service.summary` now returns `paid_minor`, `outstanding_minor`, `total`
  (`api/src/invoices/invoice.service.ts`, `web/src/invoices.tsx`). Total Invoiced = Paid + Outstanding.
- **Verify:** open Fee Invoices → the 8 KPI cards; Paid + Outstanding == Total Invoiced when all
  non-cancelled invoices are issued/paid.

### 6. Record Fee / Payment — Branch › Vertical + search
- CollectModal already carries the **Branch › Vertical › Course** breadcrumb and a search box; the
  search now also matches **phone** (via the enrolment `q`), and the chosen-enrolment hint shows
  Net + Exam + **Total payable** + Balance (`web/src/sprint5.tsx`).
- **Verify:** Fee Management → Record a payment (standalone) → search by phone/name/enrolment →
  Branch › Vertical › Course shows; outstanding includes the exam fee.

## Reconciliation
- Fee Invoice total = Net (post-discount) + Exam fee + Tax (per-line GST).
- Balance = Total payable − Amount paid; Total payable = Net + Exam fee.
- Fee dues / Finance dashboard collectible include the exam fee (Net + Exam − Paid).

## Tests added
`api/src/enrolments/exam-fee.spec.ts` (exam excluded from discount+instalment then added to total;
total/balance math; level-wise Σ exam; amount over-cap triggers approval, cap = min(%,amount)),
`api/src/invoices/fee-invoice-dashboard.spec.ts` (dashboard KPI aggregation Paid/Outstanding/Total;
auto-pull two-line reconciliation to Net+Exam+Tax). Updated `course-levels.spec.ts`,
`courselevels.test.tsx`, `dues-unplanned.spec.ts` for the new column/collectible.

## Build status
api tsc + build + jest green except the known pre-existing fails (`capture`, `followup-reportto`,
`date.util`). web tsc + vite build green.
