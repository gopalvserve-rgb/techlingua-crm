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
