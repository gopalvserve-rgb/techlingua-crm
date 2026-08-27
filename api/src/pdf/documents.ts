import { formatINR } from '../common/money.util';
import { PdfPage, buildPdf, rgb } from './pdf.util';

/**
 * THE TWO PHASE-1 DOCUMENTS: a quotation and a fee receipt.
 *
 * BRANDING IS PER-BRANCH AND PER-VERTICAL, which for this client is not decoration:
 * a vertical IS a brand ("each course line sends from its own domain" — the per-vertical
 * SMTP rule). So the letterhead leads with the VERTICAL's name, carries the ORG as the
 * legal entity, and prints the BRANCH's own address / phone / email — the address the
 * customer would actually walk into. A single org-wide letterhead would be wrong for
 * every branch but one.
 *
 * `Rs.` not `₹` — see the long comment in pdf.util.ts. This is a deliberate, flagged
 * decision, not an oversight.
 */

const INK = rgb('#1a1a2e');
const MUTED = rgb('#6b7280');
const RULE = rgb('#d9dbe3');
const BRAND = rgb('#6366f1');
const BG = rgb('#f4f5fb');
const OK = rgb('#059669');

const M = 42;                       // page margin
const W = PdfPage.WIDTH - M * 2;    // usable width

export interface Letterhead {
  org_name: string;
  org_gst?: string | null;
  vertical_name?: string | null;
  branch_name?: string | null;
  branch_address?: string | null;
  branch_phone?: string | null;
  branch_email?: string | null;
}

const money = (minor: number) => formatINR(Number(minor ?? 0), { symbol: false });
const dt = (v: unknown) =>
  (v ? new Date(String(v)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

/** The banner + address block. Returns the y to carry on from. */
function letterhead(p: PdfPage, lh: Letterhead, docTitle: string, docNo: string): number {
  p.rect(0, 0, PdfPage.WIDTH, 4, BRAND);
  let y = 58;
  p.text(lh.vertical_name || lh.org_name, M, y, { size: 19, font: 'Helvetica-Bold', color: INK });
  y += 16;
  if (lh.vertical_name && lh.vertical_name !== lh.org_name) {
    p.text(`a ${lh.org_name} company`, M, y, { size: 8.5, color: MUTED });
    y += 12;
  }
  if (lh.branch_name) { p.text(`${lh.branch_name} branch`, M, y, { size: 8.5, color: MUTED }); y += 11; }
  if (lh.branch_address) y = p.paragraph(lh.branch_address, M, y, W * 0.45, { size: 8.5, color: MUTED, leading: 10.5 });
  const contact = [lh.branch_phone, lh.branch_email].filter(Boolean).join('  ·  ');
  if (contact) { p.text(contact, M, y, { size: 8.5, color: MUTED }); y += 11; }
  if (lh.org_gst) { p.text(`GSTIN: ${lh.org_gst}`, M, y, { size: 8.5, color: MUTED }); y += 11; }

  // the document block, right-aligned
  p.text(docTitle.toUpperCase(), M, 58, { size: 15, font: 'Helvetica-Bold', color: BRAND, align: 'right', width: W });
  p.text(docNo, M, 76, { size: 11, font: 'Helvetica-Bold', color: INK, align: 'right', width: W });

  y = Math.max(y + 8, 100);
  p.line(M, y, PdfPage.WIDTH - M, y, { color: RULE });
  return y + 18;
}

function footer(p: PdfPage, note: string) {
  const y = PdfPage.HEIGHT - 44;
  p.line(M, y, PdfPage.WIDTH - M, y, { color: RULE });
  p.paragraph(note, M, y + 12, W, { size: 7.5, color: MUTED, leading: 9 });
}

/** label/value pair grid. */
function kv(p: PdfPage, pairs: Array<[string, string]>, x: number, y: number, colW: number): number {
  let cy = y;
  for (const [k, v] of pairs) {
    p.text(k, x, cy, { size: 8, color: MUTED });
    p.text(PdfPage.clip(v || '—', colW - 96, 9.5, 'Helvetica-Bold'), x + 96, cy, { size: 9.5, font: 'Helvetica-Bold', color: INK });
    cy += 15;
  }
  return cy;
}

/* -------------------------------------------------------------------------- */
/*  QUOTATION                                                                  */
/* -------------------------------------------------------------------------- */

export interface QuotationDoc {
  quote_no: string; version: number; status: string;
  created_at: unknown; valid_until: unknown;
  lead_name: string; lead_phone?: string | null; lead_email?: string | null;
  counsellor_name?: string | null;
  campaign_name?: string | null;
  notes?: string | null; terms?: string | null;
  subtotal_minor: number; discount_minor: number; tax_minor: number; total_minor: number;
  items: Array<{
    line_no: number; description: string; qty: number;
    unit_price_minor: number; discount_type: string; discount_value: string | number;
    discount_minor: number; tax_pct: string | number; tax_minor: number; total_minor: number;
  }>;
}

export function quotationPdf(q: QuotationDoc, lh: Letterhead): Buffer {
  const p = new PdfPage();
  const title = q.version > 1 ? `Quotation (Rev ${q.version})` : 'Quotation';
  let y = letterhead(p, lh, title, q.quote_no);

  // parties
  p.text('QUOTATION FOR', M, y, { size: 8, color: MUTED });
  p.text(q.lead_name, M, y + 14, { size: 12, font: 'Helvetica-Bold', color: INK });
  let ly = y + 28;
  for (const line of [q.lead_phone, q.lead_email].filter(Boolean) as string[]) {
    p.text(line, M, ly, { size: 9, color: MUTED }); ly += 12;
  }
  const rx = M + W * 0.58;
  kv(p, [
    ['Date', dt(q.created_at)],
    ['Valid until', q.valid_until ? dt(q.valid_until) : 'Not specified'],
    ['Counsellor', q.counsellor_name || '—'],
  ], rx, y + 2, W * 0.42);
  y = Math.max(ly, y + 50) + 12;

  // ---- items table
  //
  // COLUMN WIDTHS ARE NOT DECORATION. The first live PDF rendered
  //     "10% 4,500.0018% 7,290.00"
  // because Discount (66pt) and Tax (58pt) were too narrow for "10%  4,500.00" (~55pt of
  // text plus padding), so the right-aligned strings ran into each other. Every unit test
  // passed: they asserted the numbers were PRESENT, not that they were READABLE.
  //
  // So the widths below are sized for the worst realistic case ("100%  1,00,000.00"), and
  // — more importantly — EVERY cell is now clipped to its own column by `cells.forEach`
  // below, so no future value can silently overrun its neighbour. pdf.spec.ts asserts it.
  const cols = [
    { x: M,          w: 150, label: 'Description',  align: 'left'  as const },
    { x: M + 150,    w: 28,  label: 'Qty',          align: 'right' as const },
    { x: M + 178,    w: 76,  label: 'Rate',         align: 'right' as const },
    { x: M + 254,    w: 92,  label: 'Discount',     align: 'right' as const },
    { x: M + 346,    w: 88,  label: 'Tax',          align: 'right' as const },
    { x: M + 434,    w: W - 434, label: 'Amount',   align: 'right' as const },
  ];
  p.rect(M, y - 3, W, 20, BG);
  for (const c of cols) p.text(c.label, c.x + 4, y + 10, { size: 8, font: 'Helvetica-Bold', color: MUTED, align: c.align, width: c.w - 8 });
  y += 24;

  for (const it of q.items) {
    const disc = Number(it.discount_minor) > 0
      ? (it.discount_type === 'percent'
        ? `${Number(it.discount_value)}% ${money(it.discount_minor)}`
        : money(it.discount_minor))
      : '-';
    const tax = Number(it.tax_pct) > 0 ? `${Number(it.tax_pct)}% ${money(it.tax_minor)}` : '-';
    const cells = [
      it.description, String(it.qty), money(it.unit_price_minor), disc, tax, money(it.total_minor),
    ];
    // EVERY cell clipped to its own column — not just the description. See the note above.
    cols.forEach((c, i) => p.text(PdfPage.clip(cells[i], c.w - 8, 9), c.x + 4, y, {
      size: 9, color: INK, align: c.align, width: c.w - 8,
    }));
    y += 8;
    p.line(M, y, PdfPage.WIDTH - M, y, { color: RULE, width: 0.4 });
    y += 14;
  }

  // ---- totals
  const tx = M + W - 210;
  const row = (label: string, val: string, bold = false) => {
    p.text(label, tx, y, { size: bold ? 10.5 : 9, font: bold ? 'Helvetica-Bold' : 'Helvetica', color: bold ? INK : MUTED });
    p.text(val, tx, y, { size: bold ? 10.5 : 9, font: bold ? 'Helvetica-Bold' : 'Helvetica', color: INK, align: 'right', width: 210 });
    y += bold ? 18 : 14;
  };
  y += 4;
  row('Subtotal', money(q.subtotal_minor));
  if (Number(q.discount_minor) > 0) row('Discount', `- ${money(q.discount_minor)}`);
  if (Number(q.tax_minor) > 0) row('Tax', money(q.tax_minor));
  p.line(tx, y - 4, PdfPage.WIDTH - M, y - 4, { color: RULE });
  y += 6;
  row(`Total (INR)`, money(q.total_minor), true);

  y += 12;
  if (q.notes) { p.text('Notes', M, y, { size: 8, color: MUTED }); y = p.paragraph(q.notes, M, y + 12, W, { size: 9, color: INK }) + 6; }
  if (q.terms) { p.text('Terms', M, y, { size: 8, color: MUTED }); y = p.paragraph(q.terms, M, y + 12, W, { size: 9, color: INK }) + 6; }

  footer(p,
    'This is a fee proposal, not a tax invoice. Tax shown is indicative. ' +
    'A GST tax invoice is issued separately on enrolment. ' +
    'Amounts are in Indian Rupees (Rs.). ' +
    `Generated by ${lh.org_name} CRM · ${new Date().toLocaleString('en-IN')}`);
  return buildPdf([p], { title: `${title} ${q.quote_no}`, author: lh.org_name });
}

/* -------------------------------------------------------------------------- */
/*  FEE RECEIPT                                                                */
/* -------------------------------------------------------------------------- */

export interface ReceiptDoc {
  receipt_no: string; received_at: unknown;
  amount_minor: number; mode: string; reference?: string | null; note?: string | null;
  student_name: string; student_phone?: string | null;
  enrolment_no: string; course_name?: string | null;
  net_fee_minor: number; paid_minor: number; balance_minor: number;
  received_by_name?: string | null;
}

const MODE_LABEL: Record<string, string> = {
  cash: 'Cash', upi: 'UPI', card: 'Card', cheque: 'Cheque', online: 'Online transfer',
};

export function receiptPdf(r: ReceiptDoc, lh: Letterhead): Buffer {
  const p = new PdfPage();
  let y = letterhead(p, lh, 'Fee Receipt', r.receipt_no);

  // the amount, big — it is the one number the payer cares about
  p.rect(M, y, W, 52, BG);
  p.text('AMOUNT RECEIVED', M + 14, y + 18, { size: 8, color: MUTED });
  p.text(`Rs. ${money(r.amount_minor)}`, M + 14, y + 40, { size: 21, font: 'Helvetica-Bold', color: OK });
  p.text(MODE_LABEL[r.mode] ?? r.mode, M, y + 20, { size: 10, font: 'Helvetica-Bold', color: INK, align: 'right', width: W - 14 });
  p.text(dt(r.received_at), M, y + 38, { size: 9, color: MUTED, align: 'right', width: W - 14 });
  y += 72;

  y = kv(p, [
    ['Received from', r.student_name],
    ...(r.student_phone ? [['Mobile', r.student_phone] as [string, string]] : []),
    ['Enrolment', r.enrolment_no],
    ...(r.course_name ? [['Course', r.course_name] as [string, string]] : []),
    ...(r.reference ? [['Reference', r.reference] as [string, string]] : []),
    ['Received by', r.received_by_name || '—'],
  ], M, y, W * 0.55);

  // the ledger — a receipt that does not say what is still owed is half a receipt
  y += 10;
  p.line(M, y, PdfPage.WIDTH - M, y, { color: RULE });
  y += 16;
  const tx = M + W - 220;
  const row = (label: string, val: string, bold = false, color = INK) => {
    p.text(label, tx, y, { size: bold ? 10 : 9, font: bold ? 'Helvetica-Bold' : 'Helvetica', color: MUTED });
    p.text(val, tx, y, { size: bold ? 10 : 9, font: bold ? 'Helvetica-Bold' : 'Helvetica', color, align: 'right', width: 220 });
    y += bold ? 17 : 14;
  };
  p.text('Fee summary', M, y, { size: 8, color: MUTED });
  row('Net fee agreed', money(r.net_fee_minor));
  row('Paid to date (incl. this receipt)', money(r.paid_minor));
  p.line(tx, y - 4, PdfPage.WIDTH - M, y - 4, { color: RULE });
  y += 6;
  row('Balance', money(r.balance_minor), true, Number(r.balance_minor) > 0 ? INK : OK);

  if (r.note) { y += 8; p.text('Note', M, y, { size: 8, color: MUTED }); y = p.paragraph(r.note, M, y + 12, W, { size: 9, color: INK }); }

  y += 30;
  p.line(M + W - 170, y + 26, PdfPage.WIDTH - M, y + 26, { color: RULE });
  p.text('Authorised signatory', M + W - 170, y + 38, { size: 8, color: MUTED });

  footer(p,
    'Computer-generated receipt; valid without signature. ' +
    'This acknowledges the amount received only and is not a GST tax invoice. ' +
    'Cheque payments are subject to realisation. Amounts are in Indian Rupees (Rs.). ' +
    `Generated by ${lh.org_name} CRM · ${new Date().toLocaleString('en-IN')}`);
  return buildPdf([p], { title: `Fee Receipt ${r.receipt_no}`, author: lh.org_name });
}

/* -------------------------------------------------------------------------- */
/*  REFUND VOUCHER  (Phase 3 Batch 4) — the document a refund produces on         */
/*  APPROVAL. Same letterhead + "big amount" shape as the receipt, but it is a    */
/*  DEBIT to the customer, so the amount is inked in the brand colour (not the OK  */
/*  green of money received) and the ledger shows collected -> refunded -> net.    */
/* -------------------------------------------------------------------------- */

export interface RefundVoucherDoc {
  refund_no: string; refunded_at: unknown;
  amount_minor: number; mode: string; reference?: string | null; reason: string;
  student_name: string; student_phone?: string | null;
  enrolment_no: string; course_name?: string | null;
  collected_minor: number; net_collected_minor: number;
  approved_by_name?: string | null; requested_by_name?: string | null;
}

export function refundVoucherPdf(r: RefundVoucherDoc, lh: Letterhead): Buffer {
  const p = new PdfPage();
  let y = letterhead(p, lh, 'Refund Voucher', r.refund_no);

  p.rect(M, y, W, 52, BG);
  p.text('AMOUNT REFUNDED', M + 14, y + 18, { size: 8, color: MUTED });
  p.text(`Rs. ${money(r.amount_minor)}`, M + 14, y + 40, { size: 21, font: 'Helvetica-Bold', color: BRAND });
  p.text(MODE_LABEL[r.mode] ?? r.mode, M, y + 20, { size: 10, font: 'Helvetica-Bold', color: INK, align: 'right', width: W - 14 });
  p.text(dt(r.refunded_at), M, y + 38, { size: 9, color: MUTED, align: 'right', width: W - 14 });
  y += 72;

  y = kv(p, [
    ['Refunded to', r.student_name],
    ...(r.student_phone ? [['Mobile', r.student_phone] as [string, string]] : []),
    ['Enrolment', r.enrolment_no],
    ...(r.course_name ? [['Course', r.course_name] as [string, string]] : []),
    ...(r.reference ? [['Payout reference', r.reference] as [string, string]] : []),
    ['Requested by', r.requested_by_name || '—'],
    ['Approved by', r.approved_by_name || '—'],
  ], M, y, W * 0.55);

  y += 8;
  p.text('Reason', M, y, { size: 8, color: MUTED });
  y = p.paragraph(r.reason, M, y + 12, W, { size: 9, color: INK });

  y += 10;
  p.line(M, y, PdfPage.WIDTH - M, y, { color: RULE });
  y += 16;
  const tx = M + W - 220;
  const row = (label: string, val: string, bold = false, color = INK) => {
    p.text(label, tx, y, { size: bold ? 10 : 9, font: bold ? 'Helvetica-Bold' : 'Helvetica', color: MUTED });
    p.text(val, tx, y, { size: bold ? 10 : 9, font: bold ? 'Helvetica-Bold' : 'Helvetica', color, align: 'right', width: 220 });
    y += bold ? 17 : 14;
  };
  p.text('Collection summary', M, y, { size: 8, color: MUTED });
  row('Collected to date', money(r.collected_minor));
  row('This refund', `- ${money(r.amount_minor)}`);
  p.line(tx, y - 4, PdfPage.WIDTH - M, y - 4, { color: RULE });
  y += 6;
  row('Net collected', money(r.net_collected_minor), true, BRAND);

  y += 30;
  p.line(M + W - 170, y + 26, PdfPage.WIDTH - M, y + 26, { color: RULE });
  p.text('Authorised signatory', M + W - 170, y + 38, { size: 8, color: MUTED });

  footer(p,
    'Computer-generated refund voucher; valid without signature. ' +
    'This records a refund of fees collected and is not a GST credit note. ' +
    'Amounts are in Indian Rupees (Rs.). ' +
    `Generated by ${lh.org_name} CRM \u00b7 ${new Date().toLocaleString('en-IN')}`);
  return buildPdf([p], { title: `Refund Voucher ${r.refund_no}`, author: lh.org_name });
}

/* -------------------------------------------------------------------------- */
/*  CERTIFICATE  (Phase 2, Learning) — landscape, branded, India-appropriate.  */
/* -------------------------------------------------------------------------- */

export interface CertificateDoc {
  serial_no: string;
  cert_type: string;           // completion | participation | merit | other
  title: string;
  student_name: string;
  student_no?: string | null;
  course_name?: string | null;
  batch_name?: string | null;
  issue_date: unknown;
  status?: string | null;      // 'revoked' overlays a notice
  issued_by_name?: string | null;
}

const CERT_HEADING: Record<string, string> = {
  completion: 'Certificate of Completion',
  participation: 'Certificate of Participation',
  merit: 'Certificate of Merit',
  other: 'Certificate',
};

export function certificatePdf(c: CertificateDoc, lh: Letterhead): Buffer {
  const p = new PdfPage(PdfPage.LANDSCAPE_WIDTH, PdfPage.LANDSCAPE_HEIGHT);
  const PW = p.width, PH = p.height;
  const cx = PW / 2;

  // decorative double border
  p.rect(0, 0, PW, 6, BRAND);
  p.rect(0, PH - 6, PW, 6, BRAND);
  p.line(28, 28, PW - 28, 28, { color: BRAND, width: 1.4 });
  p.line(28, PH - 28, PW - 28, PH - 28, { color: BRAND, width: 1.4 });
  p.line(28, 28, 28, PH - 28, { color: BRAND, width: 1.4 });
  p.line(PW - 28, 28, PW - 28, PH - 28, { color: BRAND, width: 1.4 });

  // issuing brand
  p.text(lh.vertical_name || lh.org_name, cx - 200, 78, { size: 20, font: 'Helvetica-Bold', color: INK, align: 'center', width: 400 });
  if (lh.vertical_name && lh.vertical_name !== lh.org_name) {
    p.text(`a ${lh.org_name} initiative`, cx - 200, 96, { size: 9, color: MUTED, align: 'center', width: 400 });
  }
  if (lh.branch_name) p.text(`${lh.branch_name} branch`, cx - 200, 110, { size: 9, color: MUTED, align: 'center', width: 400 });

  // heading
  p.text((CERT_HEADING[c.cert_type] ?? 'Certificate').toUpperCase(), cx - 300, 168, { size: 26, font: 'Helvetica-Bold', color: BRAND, align: 'center', width: 600 });

  p.text('This is to certify that', cx - 300, 210, { size: 12, color: MUTED, align: 'center', width: 600 });
  p.text(c.student_name, cx - 300, 250, { size: 24, font: 'Helvetica-Bold', color: INK, align: 'center', width: 600 });
  p.line(cx - 170, 262, cx + 170, 262, { color: RULE, width: 0.8 });

  const line2 = c.cert_type === 'participation'
    ? 'has participated in'
    : c.cert_type === 'merit'
      ? 'is awarded merit for'
      : 'has successfully completed';
  p.text(line2, cx - 300, 292, { size: 12, color: MUTED, align: 'center', width: 600 });
  p.text(PdfPage.clip(c.title, 560, 18, 'Helvetica-Bold'), cx - 300, 320, { size: 18, font: 'Helvetica-Bold', color: INK, align: 'center', width: 600 });
  const sub = [c.course_name, c.batch_name].filter(Boolean).join('  ·  ');
  if (sub) p.text(sub, cx - 300, 342, { size: 11, color: MUTED, align: 'center', width: 600 });

  // footer row: serial + date + signatory
  const fy = PH - 92;
  p.text('Certificate No.', 70, fy, { size: 8, color: MUTED });
  p.text(c.serial_no, 70, fy + 15, { size: 11, font: 'Helvetica-Bold', color: INK });
  p.text('Date of Issue', 70, fy + 34, { size: 8, color: MUTED });
  p.text(dt(c.issue_date), 70, fy + 49, { size: 11, font: 'Helvetica-Bold', color: INK });

  p.line(PW - 250, fy + 30, PW - 70, fy + 30, { color: RULE });
  p.text('Authorised signatory', PW - 250, fy + 45, { size: 9, color: MUTED });
  p.text(lh.org_name, PW - 250, fy + 15, { size: 10, font: 'Helvetica-Bold', color: INK });

  if (c.status === 'revoked') {
    p.text('REVOKED', cx - 200, PH / 2, { size: 60, font: 'Helvetica-Bold', color: rgb('#dc2626'), align: 'center', width: 400 });
  }

  return buildPdf([p], { title: `Certificate ${c.serial_no}`, author: lh.org_name });
}

/* -------------------------------------------------------------------------- */
/*  REPORT CARD  (Phase 2, Learning) — portrait, India grading bands.          */
/* -------------------------------------------------------------------------- */

export interface ReportCardDoc {
  student_name: string;
  student_no?: string | null;
  term: string;
  period_from?: unknown; period_to?: unknown;
  course_name?: string | null;
  batch_name?: string | null;
  attendance_pct?: number | null; attendance_present?: number | null; attendance_total?: number | null;
  test_avg_pct?: number | null; test_count?: number | null;
  assignment_avg_pct?: number | null; assignment_count?: number | null;
  overall_pct?: number | null; overall_grade?: string | null;
  remarks?: string | null;
  status?: string | null;
}

const pct = (v: number | null | undefined) => (v == null ? '—' : `${Number(v)}%`);

export function reportCardPdf(rc: ReportCardDoc, lh: Letterhead): Buffer {
  const p = new PdfPage();
  let y = letterhead(p, lh, 'Report Card', rc.term);

  // student block
  p.text('STUDENT', M, y, { size: 8, color: MUTED });
  p.text(rc.student_name, M, y + 14, { size: 13, font: 'Helvetica-Bold', color: INK });
  let ly = y + 30;
  for (const s of [rc.student_no, [rc.course_name, rc.batch_name].filter(Boolean).join(' · ')].filter(Boolean) as string[]) {
    p.text(s, M, ly, { size: 9, color: MUTED }); ly += 12;
  }
  const rx = M + W * 0.58;
  const period = (rc.period_from || rc.period_to)
    ? `${rc.period_from ? dt(rc.period_from) : '—'}  to  ${rc.period_to ? dt(rc.period_to) : '—'}`
    : 'Full record';
  kv(p, [['Term', rc.term], ['Period', period]], rx, y + 2, W * 0.42);
  y = Math.max(ly, y + 44) + 12;

  // component table
  const cols = [
    { x: M,        w: 220, label: 'Component',      align: 'left'  as const },
    { x: M + 220,  w: 120, label: 'Detail',         align: 'left'  as const },
    { x: M + 340,  w: W - 340, label: 'Result',     align: 'right' as const },
  ];
  p.rect(M, y - 3, W, 20, BG);
  for (const c of cols) p.text(c.label, c.x + 4, y + 10, { size: 8, font: 'Helvetica-Bold', color: MUTED, align: c.align, width: c.w - 8 });
  y += 24;
  const rowT = (label: string, detail: string, result: string) => {
    const cells = [label, detail, result];
    cols.forEach((c, i) => p.text(PdfPage.clip(cells[i], c.w - 8, 9.5, i === 0 ? 'Helvetica-Bold' : 'Helvetica'), c.x + 4, y, {
      size: 9.5, color: INK, align: c.align, width: c.w - 8, font: i === 0 ? 'Helvetica-Bold' : 'Helvetica',
    }));
    y += 8; p.line(M, y, PdfPage.WIDTH - M, y, { color: RULE, width: 0.4 }); y += 14;
  };
  rowT('Attendance', rc.attendance_total ? `${rc.attendance_present ?? 0}/${rc.attendance_total} sessions` : 'No sessions', pct(rc.attendance_pct));
  rowT('Test average', rc.test_count ? `${rc.test_count} test(s)` : 'No scores', pct(rc.test_avg_pct));
  rowT('Assignment average', rc.assignment_count ? `${rc.assignment_count} graded` : 'None graded', pct(rc.assignment_avg_pct));

  // overall
  y += 6;
  p.rect(M, y - 3, W, 44, BG);
  p.text('OVERALL', M + 14, y + 16, { size: 9, color: MUTED });
  p.text(rc.overall_grade ? `Grade ${rc.overall_grade}` : 'Grade —', M + 14, y + 33, { size: 15, font: 'Helvetica-Bold', color: BRAND });
  p.text(pct(rc.overall_pct), M, y + 28, { size: 22, font: 'Helvetica-Bold', color: INK, align: 'right', width: W - 14 });
  y += 60;

  if (rc.remarks) { p.text('Remarks', M, y, { size: 8, color: MUTED }); y = p.paragraph(rc.remarks, M, y + 12, W, { size: 9, color: INK }) + 6; }

  footer(p,
    'Academic progress is computed from attendance, test scores and assignment grades on record. ' +
    'Overall % weights tests 50%, assignments 30% and attendance 20% over the components available. ' +
    'Grades follow standard Indian bands (A+ 90+, A 80+, B 70+, C 60+, D 50+, E 40+, F below 40). ' +
    `Generated by ${lh.org_name} CRM · ${new Date().toLocaleString('en-IN')}`);
  return buildPdf([p], { title: `Report Card ${rc.term} ${rc.student_name}`, author: lh.org_name });
}

/* -------------------------------------------------------------------------- */
/*  PURCHASE ORDER (ERP Batch 5 — Operations / Procurement)                    */
/* -------------------------------------------------------------------------- */

export interface PurchaseOrderDoc {
  po_no: string; status: string;
  order_date: unknown; expected_date: unknown;
  vendor_name: string; vendor_gstin?: string | null; vendor_address?: string | null;
  vendor_phone?: string | null; vendor_email?: string | null;
  branch_name?: string | null;
  notes?: string | null; terms?: string | null;
  subtotal_minor: number; discount_minor: number; tax_minor: number; total_minor: number;
  items: Array<{
    line_no: number; description: string; hsn_code?: string | null; qty: number;
    unit_price_minor: number; discount_type: string; discount_value: string | number;
    discount_minor: number; tax_pct: string | number; tax_minor: number; total_minor: number;
  }>;
}

export function purchaseOrderPdf(po: PurchaseOrderDoc, lh: Letterhead): Buffer {
  const p = new PdfPage();
  let y = letterhead(p, lh, 'Purchase Order', po.po_no);

  // vendor (the party) + PO meta
  p.text('VENDOR', M, y, { size: 8, color: MUTED });
  p.text(po.vendor_name, M, y + 14, { size: 12, font: 'Helvetica-Bold', color: INK });
  let ly = y + 28;
  const vlines = [
    po.vendor_gstin ? `GSTIN: ${po.vendor_gstin}` : null,
    po.vendor_address || null,
    [po.vendor_phone, po.vendor_email].filter(Boolean).join('  ·  ') || null,
  ].filter(Boolean) as string[];
  for (const line of vlines) { ly = p.paragraph(line, M, ly, W * 0.5, { size: 9, color: MUTED, leading: 11 }); }
  const rx = M + W * 0.58;
  kv(p, [
    ['Order date', po.order_date ? dt(po.order_date) : 'Not specified'],
    ['Expected', po.expected_date ? dt(po.expected_date) : 'Not specified'],
    ['Status', String(po.status || 'draft').replace(/^\w/, (c) => c.toUpperCase())],
    ['Deliver to', po.branch_name || '—'],
  ], rx, y + 2, W * 0.42);
  y = Math.max(ly, y + 66) + 12;

  // items table (with HSN/SAC + GST)
  const cols = [
    { x: M,        w: 132, label: 'Item / description', align: 'left'  as const },
    { x: M + 132,  w: 52,  label: 'HSN/SAC',            align: 'left'  as const },
    { x: M + 184,  w: 28,  label: 'Qty',                align: 'right' as const },
    { x: M + 212,  w: 74,  label: 'Rate',               align: 'right' as const },
    { x: M + 286,  w: 76,  label: 'Discount',           align: 'right' as const },
    { x: M + 362,  w: 74,  label: 'GST',                align: 'right' as const },
    { x: M + 436,  w: W - 436, label: 'Amount',         align: 'right' as const },
  ];
  p.rect(M, y - 3, W, 20, BG);
  for (const c of cols) p.text(c.label, c.x + 4, y + 10, { size: 7.5, font: 'Helvetica-Bold', color: MUTED, align: c.align, width: c.w - 8 });
  y += 24;

  for (const it of po.items) {
    const disc = Number(it.discount_minor) > 0
      ? (it.discount_type === 'percent' ? `${Number(it.discount_value)}% ${money(it.discount_minor)}` : money(it.discount_minor))
      : '-';
    const gst = Number(it.tax_pct) > 0 ? `${Number(it.tax_pct)}% ${money(it.tax_minor)}` : '-';
    const cells = [it.description, it.hsn_code || '-', String(it.qty), money(it.unit_price_minor), disc, gst, money(it.total_minor)];
    cols.forEach((c, i) => p.text(PdfPage.clip(cells[i], c.w - 8, 9), c.x + 4, y, { size: 9, color: INK, align: c.align, width: c.w - 8 }));
    y += 8;
    p.line(M, y, PdfPage.WIDTH - M, y, { color: RULE, width: 0.4 });
    y += 14;
  }

  // totals
  const tx = M + W - 210;
  const row = (label: string, val: string, bold = false) => {
    p.text(label, tx, y, { size: bold ? 10.5 : 9, font: bold ? 'Helvetica-Bold' : 'Helvetica', color: bold ? INK : MUTED });
    p.text(val, tx, y, { size: bold ? 10.5 : 9, font: bold ? 'Helvetica-Bold' : 'Helvetica', color: INK, align: 'right', width: 210 });
    y += bold ? 18 : 14;
  };
  y += 4;
  row('Subtotal', money(po.subtotal_minor));
  if (Number(po.discount_minor) > 0) row('Discount', `- ${money(po.discount_minor)}`);
  if (Number(po.tax_minor) > 0) row('GST', money(po.tax_minor));
  p.line(tx, y - 4, PdfPage.WIDTH - M, y - 4, { color: RULE });
  y += 6;
  row('Total (INR)', money(po.total_minor), true);

  y += 12;
  if (po.notes) { p.text('Notes', M, y, { size: 8, color: MUTED }); y = p.paragraph(po.notes, M, y + 12, W, { size: 9, color: INK }) + 6; }
  if (po.terms) { p.text('Terms & conditions', M, y, { size: 8, color: MUTED }); y = p.paragraph(po.terms, M, y + 12, W, { size: 9, color: INK }) + 6; }

  footer(p,
    'This is a purchase order. Goods/services to be supplied per the terms above. ' +
    'GST shown is as per the rates entered. Amounts are in Indian Rupees (Rs.). ' +
    `Generated by ${lh.org_name} CRM · ${new Date().toLocaleString('en-IN')}`);
  return buildPdf([p], { title: `Purchase Order ${po.po_no}`, author: lh.org_name });
}

/* -------------------------------------------------------------------------- */
/*  GST TAX INVOICE  (Phase 3 Batch 1)                                         */
/*                                                                             */
/*  A proper India GST tax invoice: seller GSTIN + state, buyer GSTIN + place  */
/*  of supply, HSN/SAC per line, CGST+SGST (intra-state) or IGST (inter-state) */
/*  breakup, round-off, grand total, and the mandatory "amount in words".      */
/* -------------------------------------------------------------------------- */

export interface InvoiceDoc {
  invoice_no: string | null; invoice_date: unknown; status: string;
  supply_type: 'intra' | 'inter';
  seller_legal_name?: string | null; seller_gstin?: string | null; seller_pan?: string | null;
  seller_address?: string | null; seller_state_name?: string | null; seller_state_code?: string | null;
  buyer_name: string; buyer_gstin?: string | null; buyer_address?: string | null;
  buyer_email?: string | null; buyer_phone?: string | null;
  pos_state_name?: string | null; pos_state_code?: string | null;
  enrolment_no?: string | null;
  taxable_minor: number; discount_minor: number;
  cgst_minor: number; sgst_minor: number; igst_minor: number;
  round_off_minor: number; total_minor: number; amount_in_words?: string | null;
  notes?: string | null; terms?: string | null;
  items: Array<{
    line_no: number; description: string; hsn_sac?: string | null; qty: number;
    unit_price_minor: number; gst_pct: string | number;
    taxable_minor: number; cgst_minor: number; sgst_minor: number; igst_minor: number; total_minor: number;
  }>;
}

export function invoicePdf(inv: InvoiceDoc, lh: Letterhead): Buffer {
  const p = new PdfPage();
  // Seller GSTIN prints in the letterhead's GSTIN slot.
  const lhInv: Letterhead = { ...lh, org_gst: inv.seller_gstin ?? lh.org_gst };
  const isDraft = !inv.invoice_no || inv.status === 'draft';
  // dev/140 item 1 — header reads "Fee Invoice" while keeping the GST/tax-invoice semantics.
  let y = letterhead(p, lhInv, 'Fee Invoice (Tax Invoice)', inv.invoice_no || 'DRAFT');

  // seller legal line + PAN + state under the brand block
  const sellerBits = [
    inv.seller_legal_name ? `Legal name: ${inv.seller_legal_name}` : null,
    inv.seller_pan ? `PAN: ${inv.seller_pan}` : null,
    inv.seller_state_name ? `State: ${inv.seller_state_name}${inv.seller_state_code ? ` (${inv.seller_state_code})` : ''}` : null,
  ].filter(Boolean) as string[];
  for (const s of sellerBits) { p.text(s, M, y, { size: 8.5, color: MUTED }); y += 11; }

  // parties: Bill To (buyer) + invoice meta
  y += 4;
  p.text('BILL TO', M, y, { size: 8, color: MUTED });
  p.text(inv.buyer_name, M, y + 14, { size: 12, font: 'Helvetica-Bold', color: INK });
  let ly = y + 28;
  const buyerBits = [
    inv.buyer_gstin ? `GSTIN: ${inv.buyer_gstin}` : null,
    inv.buyer_address || null,
    [inv.buyer_phone, inv.buyer_email].filter(Boolean).join('  ·  ') || null,
  ].filter(Boolean) as string[];
  for (const line of buyerBits) { ly = p.paragraph(line, M, ly, W * 0.5, { size: 9, color: MUTED, leading: 11 }); }
  const rx = M + W * 0.58;
  kv(p, [
    ['Invoice date', dt(inv.invoice_date)],
    ['Status', String(inv.status || 'draft').replace(/^\w/, (c) => c.toUpperCase())],
    ['Place of supply', inv.pos_state_name ? `${inv.pos_state_name}${inv.pos_state_code ? ` (${inv.pos_state_code})` : ''}` : '—'],
    ['Supply', inv.supply_type === 'inter' ? 'Inter-state (IGST)' : 'Intra-state (CGST+SGST)'],
    ...(inv.enrolment_no ? [['Enrolment', inv.enrolment_no] as [string, string]] : []),
  ], rx, y + 2, W * 0.42);
  y = Math.max(ly, y + 78) + 12;

  // items table
  const cols = [
    { x: M,        w: 132, label: 'Description',   align: 'left'  as const },
    { x: M + 132,  w: 52,  label: 'HSN/SAC',       align: 'left'  as const },
    { x: M + 184,  w: 28,  label: 'Qty',           align: 'right' as const },
    { x: M + 212,  w: 74,  label: 'Rate',          align: 'right' as const },
    { x: M + 286,  w: 76,  label: 'Taxable',       align: 'right' as const },
    { x: M + 362,  w: 74,  label: 'GST',           align: 'right' as const },
    { x: M + 436,  w: W - 436, label: 'Amount',    align: 'right' as const },
  ];
  p.rect(M, y - 3, W, 20, BG);
  for (const c of cols) p.text(c.label, c.x + 4, y + 10, { size: 7.5, font: 'Helvetica-Bold', color: MUTED, align: c.align, width: c.w - 8 });
  y += 24;
  for (const it of inv.items) {
    const taxAmt = Number(it.cgst_minor) + Number(it.sgst_minor) + Number(it.igst_minor);
    const gst = Number(it.gst_pct) > 0 ? `${Number(it.gst_pct)}% ${money(taxAmt)}` : '-';
    const cells = [it.description, it.hsn_sac || '-', String(it.qty), money(it.unit_price_minor), money(it.taxable_minor), gst, money(it.total_minor)];
    cols.forEach((c, i) => p.text(PdfPage.clip(cells[i], c.w - 8, 9), c.x + 4, y, { size: 9, color: INK, align: c.align, width: c.w - 8 }));
    y += 8;
    p.line(M, y, PdfPage.WIDTH - M, y, { color: RULE, width: 0.4 });
    y += 14;
  }

  // totals + tax breakup
  const tx = M + W - 220;
  const row = (label: string, val: string, bold = false) => {
    p.text(label, tx, y, { size: bold ? 10.5 : 9, font: bold ? 'Helvetica-Bold' : 'Helvetica', color: bold ? INK : MUTED });
    p.text(val, tx, y, { size: bold ? 10.5 : 9, font: bold ? 'Helvetica-Bold' : 'Helvetica', color: INK, align: 'right', width: 220 });
    y += bold ? 18 : 14;
  };
  y += 4;
  if (Number(inv.discount_minor) > 0) row('Discount', `- ${money(inv.discount_minor)}`);
  row('Taxable value', money(inv.taxable_minor));
  if (inv.supply_type === 'inter') {
    row('IGST', money(inv.igst_minor));
  } else {
    row('CGST', money(inv.cgst_minor));
    row('SGST', money(inv.sgst_minor));
  }
  if (Number(inv.round_off_minor) !== 0) row('Round off', `${Number(inv.round_off_minor) > 0 ? '+ ' : '- '}${money(Math.abs(Number(inv.round_off_minor)))}`);
  p.line(tx, y - 4, PdfPage.WIDTH - M, y - 4, { color: RULE });
  y += 6;
  row('Grand Total (INR)', money(inv.total_minor), true);

  // amount in words — full width, mandatory on a tax invoice
  y += 6;
  if (inv.amount_in_words) {
    p.text('Amount in words', M, y, { size: 8, color: MUTED });
    y = p.paragraph(inv.amount_in_words, M, y + 12, W, { size: 9.5, font: 'Helvetica-Bold', color: INK, leading: 12 }) + 8;
  }

  if (inv.notes) { p.text('Notes', M, y, { size: 8, color: MUTED }); y = p.paragraph(inv.notes, M, y + 12, W, { size: 9, color: INK }) + 6; }
  if (inv.terms) { p.text('Terms', M, y, { size: 8, color: MUTED }); y = p.paragraph(inv.terms, M, y + 12, W, { size: 9, color: INK }) + 6; }

  y += 18;
  p.line(M + W - 170, y + 26, PdfPage.WIDTH - M, y + 26, { color: RULE });
  p.text('Authorised signatory', M + W - 170, y + 38, { size: 8, color: MUTED });
  p.text(inv.seller_legal_name || lh.org_name, M + W - 170, y + 15, { size: 10, font: 'Helvetica-Bold', color: INK });

  if (isDraft) {
    p.text('DRAFT', M + W / 2 - 120, PdfPage.HEIGHT / 2, { size: 64, font: 'Helvetica-Bold', color: rgb('#e5e7eb'), align: 'center', width: 240 });
  } else if (inv.status === 'cancelled') {
    p.text('CANCELLED', M + W / 2 - 160, PdfPage.HEIGHT / 2, { size: 60, font: 'Helvetica-Bold', color: rgb('#fca5a5'), align: 'center', width: 320 });
  }

  footer(p,
    'This is a GST tax invoice issued under the CGST/SGST/IGST Acts. ' +
    'Tax is charged as CGST+SGST for intra-state supplies and IGST for inter-state supplies, per the place of supply. ' +
    'Amounts are in Indian Rupees (Rs.). ' +
    `Generated by ${lh.org_name} CRM · ${new Date().toLocaleString('en-IN')}`);
  return buildPdf([p], { title: `Fee Invoice ${inv.invoice_no || 'Draft'}`, author: lh.org_name });
}

/* -------------------------------------------------------------------------- */
/*  STUDENT ID CARD  (client feedback item 6) — a printable, branded badge.    */
/*  Portrait A4 with a centred CR-style card: photo (JPEG, else initials),     */
/*  name, Student ID, Course(s), Branch › Vertical, batch, issue + validity.   */
/* -------------------------------------------------------------------------- */

export interface StudentIdCardDoc {
  student_name: string;
  /** Student ID = the customer id (<CENTRE_CODE>-<YEAR>-<NNN>). */
  student_no?: string | null;
  /** Roll Number = the vertical-wise id (<VERTICAL_CODE>-<YEAR>-<NNN>) for the card's vertical. */
  roll_no?: string | null;
  enrollment_no?: string | null;
  courses?: string[];
  batch_name?: string | null;
  branch_name?: string | null;
  vertical_name?: string | null;
  dob?: unknown;
  phone?: string | null;
  blood_group?: string | null;
  issue_date?: unknown;
  valid_until?: unknown;
  /** JPEG bytes of the student photo, if available. PNG/other → initials placeholder. */
  photo?: Buffer | null;
}

const WHITE = rgb('#ffffff');

export function studentIdCardPdf(c: StudentIdCardDoc, lh: Letterhead): Buffer {
  const p = new PdfPage(); // A4 portrait
  const PW = p.width;
  const cardW = 344, cardH = 524;
  const x0 = Math.round((PW - cardW) / 2);
  const y0 = 120;
  const cx = x0 + cardW / 2;

  // card body + border
  p.rect(x0, y0, cardW, cardH, rgb('#ffffff'));
  p.line(x0, y0, x0 + cardW, y0, { color: BRAND, width: 1 });
  p.line(x0, y0 + cardH, x0 + cardW, y0 + cardH, { color: BRAND, width: 1 });
  p.line(x0, y0, x0, y0 + cardH, { color: BRAND, width: 1 });
  p.line(x0 + cardW, y0, x0 + cardW, y0 + cardH, { color: BRAND, width: 1 });

  // header band
  p.rect(x0, y0, cardW, 72, BRAND);
  p.text((lh.vertical_name || lh.org_name).toUpperCase(), x0, y0 + 26, { size: 14, font: 'Helvetica-Bold', color: WHITE, align: 'center', width: cardW });
  const sub = lh.vertical_name && lh.vertical_name !== lh.org_name ? `a ${lh.org_name} initiative` : 'STUDENT IDENTITY CARD';
  p.text(sub, x0, y0 + 44, { size: 8.5, color: rgb('#e5e7ff'), align: 'center', width: cardW });
  p.text('STUDENT IDENTITY CARD', x0, y0 + 60, { size: 8, font: 'Helvetica-Bold', color: rgb('#e5e7ff'), align: 'center', width: cardW });

  // photo box
  const pw = 112, ph = 134, pxx = cx - pw / 2, pyy = y0 + 92;
  let placed = false;
  if (c.photo && c.photo.length) { try { placed = p.image(c.photo, pxx, pyy, pw, ph); } catch { placed = false; } }
  if (!placed) {
    p.rect(pxx, pyy, pw, ph, BG);
    const initials = String(c.student_name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2)
      .map((w: string) => w[0]?.toUpperCase() ?? '').join('') || '?';
    p.text(initials, pxx, pyy + ph / 2 + 4, { size: 40, font: 'Helvetica-Bold', color: BRAND, align: 'center', width: pw });
  }
  p.line(pxx, pyy, pxx + pw, pyy, { color: RULE });
  p.line(pxx, pyy + ph, pxx + pw, pyy + ph, { color: RULE });
  p.line(pxx, pyy, pxx, pyy + ph, { color: RULE });
  p.line(pxx + pw, pyy, pxx + pw, pyy + ph, { color: RULE });

  // name
  p.text(PdfPage.clip(c.student_name || '—', cardW - 32, 16, 'Helvetica-Bold'), x0, pyy + ph + 28, { size: 16, font: 'Helvetica-Bold', color: INK, align: 'center', width: cardW });
  if (c.student_no) p.text(String(c.student_no), x0, pyy + ph + 46, { size: 10, color: MUTED, align: 'center', width: cardW });

  // fields
  const lx = x0 + 26, vx = x0 + 122, vw = cardW - 122 - 20;
  let fy = pyy + ph + 78;
  const row = (label: string, value: string) => {
    p.text(label.toUpperCase(), lx, fy, { size: 7.5, font: 'Helvetica-Bold', color: MUTED });
    const v = PdfPage.clip(value || '—', vw, 9.5, 'Helvetica-Bold');
    p.text(v, vx, fy, { size: 9.5, font: 'Helvetica-Bold', color: INK });
    fy += 24;
  };
  const courses = (c.courses ?? []).filter(Boolean);
  row('Student ID', c.student_no || '—');
  if (c.roll_no) row('Roll Number', c.roll_no);
  if (c.enrollment_no) row('Enrolment No', c.enrollment_no);
  row('Course', courses.length ? courses.join(', ') : '—');
  row('Branch / Vertical', [c.branch_name, c.vertical_name].filter(Boolean).join(' / ') || '—');
  if (c.batch_name) row('Batch', c.batch_name);
  if (c.dob) row('Date of Birth', dt(c.dob));
  if (c.phone) row('Phone', String(c.phone));
  row('Issued', dt(c.issue_date));
  row('Valid Until', dt(c.valid_until));

  // footer signature + brand strip
  const fyy = y0 + cardH - 46;
  p.line(x0 + cardW - 150, fyy, x0 + cardW - 26, fyy, { color: RULE });
  p.text('Authorised signatory', x0 + cardW - 150, fyy + 12, { size: 7.5, color: MUTED });
  p.text(lh.org_name, x0 + 26, fyy + 12, { size: 8, font: 'Helvetica-Bold', color: INK });
  if (lh.branch_phone || lh.branch_email) {
    p.text([lh.branch_phone, lh.branch_email].filter(Boolean).join('  ·  '), x0 + 26, fyy + 24, { size: 7, color: MUTED });
  }
  p.rect(x0, y0 + cardH - 8, cardW, 8, BRAND);

  return buildPdf([p], { title: `Student ID Card ${c.student_no ?? ''}`.trim(), author: lh.org_name });
}
