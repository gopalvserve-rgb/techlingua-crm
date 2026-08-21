# dev/116 — Fee Management + Fee Receipt full action set

Client asked for a complete row action set on **Fee Management** (dues) and **Fee Receipt
Records**: **Preview · Generate Invoice · Download PDF · Print · Email · WhatsApp · Send for
Approval · Cancel Invoice · Delete**. Each action wires an EXISTING capability and degrades
cleanly where a channel isn't configured. No new tables/migrations.

## API (NestJS)
New routes, all `@RequirePermission` + scope-enforced (reuse `FeeService.get()` which 404s
outside scope):

- `POST /fees/receipts/:id/email`  (`fee.read`) — emails the receipt **PDF** to the student
  via `MessagingService.sendNow({channel:'email', attachments:[pdf]})` (per-vertical SMTP).
  **Degrades cleanly**: unconfigured SMTP → a `not_configured/failed` send-log row, returns
  `{configured:false}`, never throws. No email on file → `{skipped:'no_email'}`.
- `POST /fees/receipts/:id/whatsapp` (`fee.read`) — WhatsApp the receipt summary; same clean
  degrade.
- `POST /fees/receipts/:id/submit-approval` (`fee.collect`) — routes the receipt into the
  reusable **content-approval workflow** (docs/dev/67, `content_approval` keyed by
  `('fee_receipt', id)`), status → `pending_approval`.
- `POST /fees/receipts/:id/approve` (`enrolment.approve`) — approver clears it → `published`.
- `POST /fees/receipts/:id/reject`  (`enrolment.approve`) — send back with remarks →
  `changes_requested`.
- `POST /invoices/generate` (`invoice.create`) — **Generate Invoice** from `{receipt_id}` or
  `{enrolment_id}`. If a non-cancelled `gst_invoice` already exists for the enrolment it is
  RETURNED (`existing:true` — open it); otherwise a draft is created from the enrolment net
  fee and **issued**. Issue can fail cleanly (e.g. vertical GSTIN not set on UAT) → the draft
  is kept and `{issued:false, issue_error}` returned.

Reused as-is: `GET /fees/receipts/:id/pdf` and `GET /invoices/:id/pdf` (Download/Print,
authed fetch→blob), `POST /invoices/:id/cancel` (void), `DELETE /invoices/:id` (draft),
`DELETE /fees/receipts/:id` (soft-delete + reverses installment allocation, dev/50).

`FeeService.list()` now also returns `approval_status` (content_approval) and the enrolment's
latest `invoice_id/invoice_no/invoice_status`, so the row can label Generate vs Open/Cancel.

## Web (React)
`sprint5.tsx` (Fee Receipt Records) and `paymentplans.tsx` (Fee Management dues): the row now
carries quick icons + a **⋮ RowMenu** (portal dropdown, RBAC-gated items only) with the full
set. Download/Print use the authed **fetch→blob** pattern (`openPdfAuthed`/`printPdf`), NOT a
naive `window.open` (which 401s). Dues rows are enrolments, so receipt-based actions resolve
the latest receipt first (clean toast when none exists); Generate/Cancel Invoice work at the
enrolment level.

## Tests
- `api/src/fees/receipt-actions.spec.ts` — Email/WhatsApp degrade cleanly (no throw, logged,
  `not_configured`); no-email skip; submit sets `pending_approval`, approve → `published`.
- `api/src/invoices/generate.spec.ts` — generate creates+issues when none exists; returns the
  existing invoice otherwise; refuses with neither id.
- Cancel (void) and receipt soft-delete-reverses-allocation keep their existing specs.
