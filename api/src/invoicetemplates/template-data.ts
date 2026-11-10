import { formatINR } from '../common/money.util';

/**
 * Everything a fee invoice can SHOW, gathered from the finance engine: the GST invoice (numbers,
 * tax, totals — issued values, never recomputed), the enrolment, the student, the receipts and the
 * payment plan. The template only chooses which of these appear and where.
 */
export interface InvoiceTplItem {
  sno: number; description: string; course: string; fee_type: string; hsn_sac: string; qty: number;
  rate_minor: number; discount_minor: number; taxable_minor: number; gst_pct: number;
  cgst_minor: number; sgst_minor: number; igst_minor: number; total_minor: number;
}

export interface InvoiceTplData {
  status: string;                                  // draft | issued | paid | cancelled
  supply: 'intra' | 'inter';
  org_name: string;
  seller: { name: string; gstin: string; address: string; phone: string; email: string; branch: string; vertical: string; pan: string; state: string };
  vars: Record<string, string>;                    // every {{variable}} as display text
  items: InvoiceTplItem[];
  sums: Record<string, number | null>;             // minor units; null = not applicable
  amount_in_words: string;
  notes: string; terms: string;
}

const money = (minor: number | null | undefined) => formatINR(Number(minor ?? 0), { symbol: false });
const d = (v: unknown): string => {
  if (!v) return '';
  const t = new Date(String(v));
  return Number.isNaN(t.getTime()) ? String(v) : t.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
};
const fy = (v: unknown): string => {
  const t = v ? new Date(String(v)) : new Date();
  const ist = new Date(t.getTime() + 330 * 60_000);
  const y = ist.getUTCFullYear(); const start = ist.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
};
const MODES: Record<string, string> = { cash: 'Cash', upi: 'UPI', card: 'Card', cheque: 'Cheque', bank: 'Bank transfer', neft: 'NEFT', online: 'Online', razorpay: 'Online' };

/** Build the data from a loaded invoice (InvoiceService.get) + its enrolment context. */
export async function loadInvoiceTplData(db: { one: (sql: string, p?: unknown[]) => Promise<any>; query: (sql: string, p?: unknown[]) => Promise<any[]> }, gi: any): Promise<InvoiceTplData> {
  const eid = gi.enrolment_id ? Number(gi.enrolment_id) : null;
  const e = eid ? await db.one(
    `SELECT e.id, e.enrolment_no, e.net_fee_minor, COALESCE(e.exam_fee_minor, 0) AS exam_fee_minor, e.branch_id, e.vertical_id,
            c.name AS course_name,
            (SELECT string_agg(COALESCE(NULLIF(el.label, ''), el.code), ', ' ORDER BY el.ordering, el.id) FROM enrolment_level el WHERE el.enrolment_id = e.id) AS level_name,
            COALESCE(sp.full_name, l.full_name) AS student_name, COALESCE(sp.phone, l.phone) AS phone, COALESCE(sp.email, l.email) AS email,
            sp.father_name, sp.guardian_name, concat_ws(', ', NULLIF(sp.address_line1, ''), NULLIF(sp.address_line2, ''), NULLIF(sp.pincode, '')) AS address,
            (SELECT svi.student_vertical_no FROM student_vertical_id svi WHERE svi.student_id = sp.id AND svi.vertical_id = e.vertical_id ORDER BY svi.id DESC LIMIT 1) AS roll_no,
            COALESCE((SELECT sum(fr.amount_minor) FROM fee_receipt fr WHERE fr.enrolment_id = e.id AND fr.deleted_at IS NULL), 0) AS paid_minor,
            (SELECT min(i.due_date) FROM installment i JOIN payment_plan pp ON pp.id = i.plan_id
              WHERE pp.enrolment_id = e.id AND pp.deleted_at IS NULL AND pp.status IN ('active','completed') AND i.paid_minor < i.amount_minor) AS next_due,
            (SELECT pp.down_payment_minor FROM payment_plan pp WHERE pp.enrolment_id = e.id AND pp.deleted_at IS NULL AND pp.status IN ('active','completed') ORDER BY pp.id DESC LIMIT 1) AS down_payment_minor
       FROM enrolment e
       LEFT JOIN m_course c ON c.id = e.course_id
       LEFT JOIN lead l ON l.id = e.lead_id
       LEFT JOIN student sp ON sp.id = e.student_profile_id
      WHERE e.id = $1::bigint`, [eid]) : null;
  const r = eid ? await db.one(
    `SELECT fr.mode, fr.reference, fr.received_at, u.name AS received_by
       FROM fee_receipt fr LEFT JOIN "user" u ON u.id = fr.received_by
      WHERE fr.enrolment_id = $1::bigint AND fr.deleted_at IS NULL ORDER BY fr.received_at DESC, fr.id DESC LIMIT 1`, [eid]) : null;

  const items: InvoiceTplItem[] = (gi.items ?? []).map((it: any, i: number) => {
    const qty = Number(it.qty ?? 1) || 1;
    const rate = Number(it.unit_price_minor ?? 0);
    return {
      sno: i + 1, description: String(it.description ?? ''), course: String(it.course_name ?? e?.course_name ?? ''),
      fee_type: String(it.fee_type ?? (/exam/i.test(String(it.description ?? '')) ? 'Exam fee' : 'Course fee')),
      hsn_sac: String(it.hsn_sac ?? ''), qty, rate_minor: rate,
      discount_minor: Math.max(0, rate * qty - Number(it.taxable_minor ?? 0)),
      taxable_minor: Number(it.taxable_minor ?? 0), gst_pct: Number(it.gst_pct ?? 0),
      cgst_minor: Number(it.cgst_minor ?? 0), sgst_minor: Number(it.sgst_minor ?? 0), igst_minor: Number(it.igst_minor ?? 0),
      total_minor: Number(it.total_minor ?? 0),
    };
  });
  const subtotal = items.reduce((s, it) => s + it.rate_minor * it.qty, 0);
  const total = Number(gi.total_minor ?? 0);
  const paid = e ? Number(e.paid_minor) : 0;
  const payable = e ? Number(e.net_fee_minor) + Number(e.exam_fee_minor) : total;
  const outstanding = Math.max(0, payable - paid);
  const payStatus = !e ? '' : outstanding <= 0 ? 'Paid' : paid > 0 ? 'Partially paid' : 'Unpaid';
  const status = String(gi.status ?? 'draft');

  const vars: Record<string, string> = {
    invoice_number: String(gi.invoice_no ?? 'DRAFT'), invoice_date: d(gi.invoice_date), due_date: d(e?.next_due) || d(gi.invoice_date),
    financial_year: fy(gi.invoice_date), invoice_status: status.replace(/^\w/, (c) => c.toUpperCase()), payment_status: payStatus,
    place_of_supply: gi.pos_state_name ? `${gi.pos_state_name}${gi.pos_state_code ? ` (${gi.pos_state_code})` : ''}` : '',
    supply_type: gi.supply_type === 'inter' ? 'Inter-state (IGST)' : 'Intra-state (CGST + SGST)', reverse_charge: 'No',
    student_name: String(gi.buyer_name ?? e?.student_name ?? ''), student_id: String(e?.roll_no ?? ''), admission_number: String(gi.enrolment_no ?? e?.enrolment_no ?? ''),
    father_name: String(e?.father_name ?? e?.guardian_name ?? ''), student_mobile: String(gi.buyer_phone ?? e?.phone ?? ''),
    student_email: String(gi.buyer_email ?? e?.email ?? ''), student_address: String(gi.buyer_address ?? e?.address ?? ''), student_gstin: String(gi.buyer_gstin ?? ''),
    branch_name: String(gi.branch_name ?? ''), vertical_name: String(gi.vertical_name ?? ''), course_name: String(e?.course_name ?? items[0]?.course ?? ''),
    level_name: String(e?.level_name ?? ''),
    payment_mode: r ? (MODES[String(r.mode)] ?? String(r.mode ?? '')) : '', transaction_id: String(r?.reference ?? ''), payment_date: d(r?.received_at),
    bank_name: '', reference_number: String(r?.reference ?? ''), utr_number: r && ['bank', 'neft'].includes(String(r.mode)) ? String(r.reference ?? '') : '',
    payment_gateway: r && ['online', 'razorpay'].includes(String(r.mode)) ? 'Razorpay' : '', received_by: String(r?.received_by ?? ''),
    grand_total: money(total), amount_paid: money(paid), outstanding_balance: money(outstanding),
    institute_name: String(gi.vertical_name ?? gi.org_name ?? ''), org_name: String(gi.org_name ?? ''),
    today: d(new Date().toISOString()),
  };
  return {
    status, supply: gi.supply_type === 'inter' ? 'inter' : 'intra', org_name: String(gi.org_name ?? ''),
    seller: {
      name: String(gi.seller_legal_name ?? gi.vertical_name ?? gi.org_name ?? ''), gstin: String(gi.seller_gstin ?? ''),
      address: String(gi.seller_address ?? gi.branch_address ?? ''), phone: String(gi.branch_phone ?? ''), email: String(gi.branch_email ?? ''),
      branch: String(gi.branch_name ?? ''), vertical: String(gi.vertical_name ?? ''), pan: String(gi.seller_pan ?? ''),
      state: gi.seller_state_name ? `${gi.seller_state_name}${gi.seller_state_code ? ` (${gi.seller_state_code})` : ''}` : '',
    },
    vars, items,
    sums: {
      subtotal, registration_fee: null, admission_fee: null, course_fee: items.filter((i) => i.fee_type === 'Course fee').reduce((s, i) => s + i.taxable_minor, 0) || null,
      additional_charges: null, discount: Number(gi.discount_minor ?? 0), coupon_discount: null, taxable: Number(gi.taxable_minor ?? 0),
      cgst: Number(gi.cgst_minor ?? 0), sgst: Number(gi.sgst_minor ?? 0), igst: Number(gi.igst_minor ?? 0), round_off: Number(gi.round_off_minor ?? 0),
      grand_total: total, amount_paid: e ? paid : null, previous_balance: null, outstanding: e ? outstanding : null,
      down_payment: e?.down_payment_minor != null && Number(e.down_payment_minor) > 0 ? Number(e.down_payment_minor) : null,
    },
    amount_in_words: String(gi.amount_in_words ?? ''),
    notes: String(gi.notes ?? ''), terms: String(gi.terms ?? ''),
  };
}

/** Realistic sample data for previewing a design before any invoice exists. */
export function sampleTplData(supply: 'intra' | 'inter' = 'intra'): InvoiceTplData {
  const items: InvoiceTplItem[] = [
    { sno: 1, description: 'French Language — Level A1 + A2', course: 'French Language', fee_type: 'Course fee', hsn_sac: '999293', qty: 1,
      rate_minor: 2000000, discount_minor: 200000, taxable_minor: 1525424, gst_pct: 18,
      cgst_minor: supply === 'intra' ? 137288 : 0, sgst_minor: supply === 'intra' ? 137288 : 0, igst_minor: supply === 'inter' ? 274576 : 0, total_minor: 1800000 },
    { sno: 2, description: 'DELF exam fee', course: 'French Language', fee_type: 'Exam fee', hsn_sac: '999293', qty: 1,
      rate_minor: 250000, discount_minor: 0, taxable_minor: 211864, gst_pct: 18,
      cgst_minor: supply === 'intra' ? 19068 : 0, sgst_minor: supply === 'intra' ? 19068 : 0, igst_minor: supply === 'inter' ? 38136 : 0, total_minor: 250000 },
  ];
  const vars: Record<string, string> = {
    invoice_number: 'INV/2026-27/0042', invoice_date: '10 Nov 2026', due_date: '10 Dec 2026', financial_year: '2026-27',
    invoice_status: 'Issued', payment_status: 'Partially paid', place_of_supply: 'Delhi (07)',
    supply_type: supply === 'inter' ? 'Inter-state (IGST)' : 'Intra-state (CGST + SGST)', reverse_charge: 'No',
    student_name: 'Riya Sharma', student_id: 'VKP01-2026-014', admission_number: 'FR001-2026-021', father_name: 'Rajesh Sharma',
    student_mobile: '+91 98100 00011', student_email: 'riya.sharma@example.com', student_address: '12, Janakpuri, New Delhi 110058', student_gstin: '',
    branch_name: 'Vikaspuri', vertical_name: 'British College of Language', course_name: 'French Language', level_name: 'A1, A2',
    payment_mode: 'UPI', transaction_id: 'UPI/431987652201', payment_date: '10 Nov 2026', bank_name: 'HDFC Bank', reference_number: '431987652201',
    utr_number: '', payment_gateway: '', received_by: 'Front Desk', grand_total: '20,500.00', amount_paid: '10,000.00', outstanding_balance: '10,500.00',
    institute_name: 'British College of Language', org_name: 'Tech Lingua LLP', today: '10 Nov 2026',
  };
  return {
    status: 'issued', supply, org_name: 'Tech Lingua LLP',
    seller: { name: 'British College of Language', gstin: '07ABCDE1234F1Z5', address: 'C-4, Vikaspuri, New Delhi 110018', phone: '+91 11 4000 0000',
      email: 'vikaspuri@bcl.example', branch: 'Vikaspuri', vertical: 'British College of Language', pan: 'ABCDE1234F', state: 'Delhi (07)' },
    vars, items,
    sums: { subtotal: 2250000, registration_fee: null, admission_fee: null, course_fee: 1525424, additional_charges: null, discount: 200000, coupon_discount: null,
      taxable: 1737288, cgst: supply === 'intra' ? 156356 : 0, sgst: supply === 'intra' ? 156356 : 0, igst: supply === 'inter' ? 312712 : 0, round_off: 0,
      grand_total: 2050000, amount_paid: 1000000, previous_balance: null, outstanding: 1050000, down_payment: 500000 },
    amount_in_words: 'Indian Rupees Twenty Thousand Five Hundred Only',
    notes: '', terms: '',
  };
}
