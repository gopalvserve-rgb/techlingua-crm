/**
 * FEE INVOICE TEMPLATE — the design a Super Admin builds (client 5 Nov 2026). Pure data: what
 * shows, in what order, labelled how, coloured how. Every amount comes from the invoice / fee
 * engine (template-data.ts); a template never computes money.
 *
 * `sanitizeConfig` is the ONLY way a config enters the database or the renderer: unknown keys are
 * dropped, lists are rebuilt from the catalogue (so a field can be reordered or hidden, never
 * invented), strings are length-capped, colours validated, images limited to JPEG data URLs.
 */

export type SectionKey =
  | 'header' | 'invoice_info' | 'student_info' | 'fee_table' | 'summary'
  | 'amount_words' | 'payment' | 'custom' | 'notes_terms' | 'footer';

export const SECTION_CATALOG: Array<{ key: SectionKey; label: string }> = [
  { key: 'header', label: 'Branding & header' },
  { key: 'invoice_info', label: 'Invoice information' },
  { key: 'student_info', label: 'Student information' },
  { key: 'fee_table', label: 'Fee breakdown table' },
  { key: 'summary', label: 'Calculation summary' },
  { key: 'amount_words', label: 'Amount in words' },
  { key: 'payment', label: 'Payment details' },
  { key: 'custom', label: 'Additional details (custom fields)' },
  { key: 'notes_terms', label: 'Terms, refund policy & instructions' },
  { key: 'footer', label: 'Signature, stamp & footer' },
];

export interface FieldDef { key: string; label: string; visible: boolean }

/** B. Invoice information — {{variable}} names follow the client's list. */
export const INVOICE_FIELDS: FieldDef[] = [
  { key: 'invoice_number', label: 'Invoice No.', visible: true },
  { key: 'invoice_date', label: 'Invoice Date', visible: true },
  { key: 'due_date', label: 'Due Date', visible: true },
  { key: 'financial_year', label: 'Financial Year', visible: true },
  { key: 'invoice_status', label: 'Invoice Status', visible: false },
  { key: 'payment_status', label: 'Payment Status', visible: true },
  { key: 'place_of_supply', label: 'Place of Supply', visible: true },
  { key: 'supply_type', label: 'Supply', visible: false },
  { key: 'reverse_charge', label: 'Reverse Charge', visible: false },
];

/** C. Student information */
export const STUDENT_FIELDS: FieldDef[] = [
  { key: 'student_name', label: 'Student Name', visible: true },
  { key: 'student_id', label: 'Student ID', visible: true },
  { key: 'admission_number', label: 'Admission No.', visible: true },
  { key: 'father_name', label: 'Father / Guardian', visible: false },
  { key: 'student_mobile', label: 'Mobile', visible: true },
  { key: 'student_email', label: 'Email', visible: true },
  { key: 'student_address', label: 'Address', visible: false },
  { key: 'student_gstin', label: 'GSTIN', visible: true },
  { key: 'branch_name', label: 'Branch', visible: false },
  { key: 'vertical_name', label: 'Vertical', visible: false },
  { key: 'course_name', label: 'Course', visible: true },
  { key: 'level_name', label: 'Course Level', visible: false },
];

/** F. Payment details (latest payment on the enrolment) */
export const PAYMENT_FIELDS: FieldDef[] = [
  { key: 'payment_mode', label: 'Payment Mode', visible: true },
  { key: 'transaction_id', label: 'Transaction ID', visible: true },
  { key: 'payment_date', label: 'Payment Date', visible: true },
  { key: 'bank_name', label: 'Bank Name', visible: false },
  { key: 'reference_number', label: 'Reference No.', visible: false },
  { key: 'utr_number', label: 'UTR No.', visible: false },
  { key: 'payment_gateway', label: 'Payment Gateway', visible: false },
  { key: 'received_by', label: 'Received By', visible: true },
];

/** D. Fee breakdown columns. `width` is a share of the table width. CGST/SGST/IGST are
 *  conditional: shown only for the supply type that charges them. */
export type ColKey = 'sno' | 'description' | 'course' | 'fee_type' | 'hsn_sac' | 'qty' | 'course_fee'
  | 'discount' | 'taxable' | 'tax_rate' | 'cgst' | 'sgst' | 'igst' | 'total';
export const COLUMN_CATALOG: Array<FieldDef & { key: ColKey; width: number; align: 'left' | 'right' | 'center' }> = [
  { key: 'sno', label: 'S. No.', visible: true, width: 5, align: 'center' },
  { key: 'description', label: 'Fee Description', visible: true, width: 26, align: 'left' },
  { key: 'course', label: 'Course / Program', visible: false, width: 16, align: 'left' },
  { key: 'fee_type', label: 'Fee Type', visible: false, width: 10, align: 'left' },
  { key: 'hsn_sac', label: 'HSN/SAC', visible: true, width: 9, align: 'left' },
  { key: 'qty', label: 'Qty', visible: true, width: 5, align: 'right' },
  { key: 'course_fee', label: 'Rate', visible: true, width: 11, align: 'right' },
  { key: 'discount', label: 'Discount', visible: false, width: 10, align: 'right' },
  { key: 'taxable', label: 'Taxable', visible: true, width: 11, align: 'right' },
  { key: 'tax_rate', label: 'GST %', visible: true, width: 6, align: 'right' },
  { key: 'cgst', label: 'CGST', visible: true, width: 9, align: 'right' },
  { key: 'sgst', label: 'SGST', visible: true, width: 9, align: 'right' },
  { key: 'igst', label: 'IGST', visible: true, width: 9, align: 'right' },
  { key: 'total', label: 'Amount', visible: true, width: 12, align: 'right' },
];

/** E. Calculation summary — every value from the fee engine. */
export type SumKey = 'subtotal' | 'registration_fee' | 'admission_fee' | 'course_fee' | 'additional_charges'
  | 'discount' | 'coupon_discount' | 'taxable' | 'cgst' | 'sgst' | 'igst' | 'round_off' | 'grand_total'
  | 'amount_paid' | 'previous_balance' | 'outstanding' | 'down_payment';
export const SUMMARY_CATALOG: Array<FieldDef & { key: SumKey }> = [
  { key: 'subtotal', label: 'Subtotal', visible: true },
  { key: 'registration_fee', label: 'Registration Fee', visible: false },
  { key: 'admission_fee', label: 'Admission Fee', visible: false },
  { key: 'course_fee', label: 'Course Fee', visible: false },
  { key: 'additional_charges', label: 'Additional Charges', visible: false },
  { key: 'discount', label: 'Discount', visible: true },
  { key: 'coupon_discount', label: 'Coupon Discount', visible: false },
  { key: 'taxable', label: 'Taxable Amount', visible: true },
  { key: 'cgst', label: 'CGST', visible: true },
  { key: 'sgst', label: 'SGST', visible: true },
  { key: 'igst', label: 'IGST', visible: true },
  { key: 'round_off', label: 'Round Off', visible: true },
  { key: 'grand_total', label: 'Grand Total', visible: true },
  { key: 'amount_paid', label: 'Amount Paid', visible: true },
  { key: 'previous_balance', label: 'Previous Balance', visible: false },
  { key: 'outstanding', label: 'Outstanding Balance', visible: true },
  { key: 'down_payment', label: 'Down Payment', visible: false },
];

export interface InvoiceTemplateConfig {
  v: 1;
  layout: 'professional' | 'minimal' | 'detailed';
  page: { size: 'A4' | 'Letter'; orientation: 'portrait' | 'landscape'; margin: number };
  branding: {
    institute_name: string; tagline: string; title: string; show_logo: boolean; logo: string;
    branch_name: boolean; address: string; phone: string; email: string; website: string; gstin: string;
    header_bg: string; header_text: string; accent: string; title_align: 'left' | 'right' | 'center';
  };
  sections: Array<{ key: SectionKey; visible: boolean; title: string }>;
  invoice_fields: FieldDef[];
  student_fields: FieldDef[];
  payment_fields: FieldDef[];
  columns: Array<FieldDef & { key: ColKey }>;
  extra_rows: Array<{ description: string; amount: string }>;
  summary: Array<FieldDef & { key: SumKey }>;
  custom_fields: Array<{ label: string; value: string; visible: boolean }>;
  footer: {
    terms: string; refund_policy: string; payment_instructions: string; bank_details: string;
    upi_qr: string; upi_id: string; signature_label: string; signature_img: string; stamp_img: string;
    accountant_name: string; thank_you: string; show_generated_at: boolean; show_page_number: boolean; note: string;
  };
  design: { font_size: number; spacing: 'compact' | 'normal' | 'relaxed'; borders: boolean; striped: boolean; rounded_header: boolean };
}

const fieldsCopy = (f: FieldDef[]) => f.map((x) => ({ ...x }));

export function defaultConfig(layout: InvoiceTemplateConfig['layout'] = 'professional'): InvoiceTemplateConfig {
  const minimal = layout === 'minimal';
  const detailed = layout === 'detailed';
  return {
    v: 1, layout,
    page: { size: 'A4', orientation: 'portrait', margin: 36 },
    branding: {
      institute_name: '', tagline: '', title: 'TAX INVOICE', show_logo: true, logo: '',
      branch_name: true, address: '', phone: '', email: '', website: '', gstin: '',
      header_bg: minimal ? '#ffffff' : '#4f46e5', header_text: minimal ? '#111827' : '#ffffff', accent: '#4f46e5',
      title_align: 'right',
    },
    sections: SECTION_CATALOG.map((s) => ({
      key: s.key, title: s.key === 'fee_table' ? 'Fee Details' : s.key === 'payment' ? 'Payment Details'
        : s.key === 'student_info' ? 'Billed To' : s.key === 'custom' ? 'Additional Details' : '',
      visible: s.key === 'custom' ? false : s.key === 'payment' ? !minimal : true,
    })),
    invoice_fields: fieldsCopy(INVOICE_FIELDS).map((f) => (detailed ? { ...f, visible: true } : f)),
    student_fields: fieldsCopy(STUDENT_FIELDS).map((f) => (detailed ? { ...f, visible: true } : f)),
    payment_fields: fieldsCopy(PAYMENT_FIELDS),
    columns: COLUMN_CATALOG.map(({ key, label, visible }) => ({ key, label, visible: minimal ? ['sno', 'description', 'qty', 'total'].includes(key) : detailed ? true : visible })),
    extra_rows: [],
    summary: SUMMARY_CATALOG.map(({ key, label, visible }) => ({ key, label, visible })),
    custom_fields: [],
    footer: {
      terms: 'Fees once paid are non-refundable except as per the refund policy.',
      refund_policy: '', payment_instructions: '', bank_details: '', upi_qr: '', upi_id: '',
      signature_label: 'Authorised Signatory', signature_img: '', stamp_img: '', accountant_name: '',
      thank_you: 'Thank you for choosing us.', show_generated_at: true, show_page_number: true, note: '',
    },
    design: { font_size: 9, spacing: detailed ? 'compact' : 'normal', borders: !minimal, striped: !minimal, rounded_header: false },
  };
}

/* ------------------------------------------------------------------ sanitise */

const str = (v: unknown, max: number, dflt = ''): string => (typeof v === 'string' ? v.slice(0, max) : dflt);
const bool = (v: unknown, dflt: boolean): boolean => (typeof v === 'boolean' ? v : dflt);
const color = (v: unknown, dflt: string): string => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : dflt);
const oneOf = <T extends string>(v: unknown, opts: readonly T[], dflt: T): T => (opts.includes(v as T) ? (v as T) : dflt);
const num = (v: unknown, min: number, max: number, dflt: number): number => {
  const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};
/** A JPEG data URL (the builder converts PNG/SVG to JPEG in the browser), at most ~600 KB. */
export const MAX_IMAGE_CHARS = 820_000;
const image = (v: unknown): string =>
  (typeof v === 'string' && v.startsWith('data:image/jpeg;base64,') && v.length <= MAX_IMAGE_CHARS && /^[A-Za-z0-9+/=]+$/.test(v.slice(23)) ? v : '');

/** Rebuild an ordered list from the catalogue: keep the saved order / labels / visibility for
 *  known keys, append any catalogue entry the saved list lacks, drop unknown keys. */
function ordered<T extends FieldDef>(saved: unknown, catalog: T[]): T[] {
  const byKey = new Map(catalog.map((c) => [c.key, c]));
  const out: T[] = [];
  const seen = new Set<string>();
  for (const s of Array.isArray(saved) ? saved : []) {
    const k = String((s as any)?.key ?? '');
    const base = byKey.get(k);
    if (!base || seen.has(k)) continue;
    seen.add(k);
    out.push({ ...base, label: str((s as any).label, 60, base.label) || base.label, visible: bool((s as any).visible, base.visible) });
  }
  for (const c of catalog) if (!seen.has(c.key)) out.push({ ...c });
  return out;
}

export function sanitizeConfig(raw: unknown): InvoiceTemplateConfig {
  const r: any = raw && typeof raw === 'object' ? raw : {};
  const layout = oneOf(r.layout, ['professional', 'minimal', 'detailed'] as const, 'professional');
  const d = defaultConfig(layout);
  const b = r.branding ?? {}; const f = r.footer ?? {}; const g = r.design ?? {}; const p = r.page ?? {};
  const secCat = SECTION_CATALOG.map((s) => ({ key: s.key, label: s.key, visible: true })) as FieldDef[];
  const savedSections = Array.isArray(r.sections) ? r.sections : d.sections;
  const sections = ordered(savedSections.map((s: any) => ({ key: s?.key, label: 'x', visible: s?.visible })), secCat)
    .map((s) => {
      const saved = (savedSections as any[]).find((x) => x?.key === s.key);
      const dflt = d.sections.find((x) => x.key === s.key)!;
      return { key: s.key as SectionKey, visible: saved ? bool(saved.visible, dflt.visible) : dflt.visible, title: str(saved?.title, 60, dflt.title) };
    });
  return {
    v: 1, layout,
    page: {
      size: oneOf(p.size, ['A4', 'Letter'] as const, 'A4'),
      orientation: oneOf(p.orientation, ['portrait', 'landscape'] as const, 'portrait'),
      margin: num(p.margin, 18, 72, d.page.margin),
    },
    branding: {
      institute_name: str(b.institute_name, 120), tagline: str(b.tagline, 160), title: str(b.title, 40, d.branding.title) || d.branding.title,
      show_logo: bool(b.show_logo, true), logo: image(b.logo), branch_name: bool(b.branch_name, true),
      address: str(b.address, 300), phone: str(b.phone, 60), email: str(b.email, 120), website: str(b.website, 120), gstin: str(b.gstin, 20),
      header_bg: color(b.header_bg, d.branding.header_bg), header_text: color(b.header_text, d.branding.header_text),
      accent: color(b.accent, d.branding.accent), title_align: oneOf(b.title_align, ['left', 'right', 'center'] as const, 'right'),
    },
    sections,
    invoice_fields: ordered(r.invoice_fields, INVOICE_FIELDS),
    student_fields: ordered(r.student_fields, STUDENT_FIELDS),
    payment_fields: ordered(r.payment_fields, PAYMENT_FIELDS),
    columns: ordered(r.columns, COLUMN_CATALOG.map(({ key, label, visible }) => ({ key, label, visible }))) as InvoiceTemplateConfig['columns'],
    extra_rows: (Array.isArray(r.extra_rows) ? r.extra_rows : []).slice(0, 10)
      .map((x: any) => ({ description: str(x?.description, 120), amount: str(x?.amount, 20).replace(/[^0-9.]/g, '') }))
      .filter((x: { description: string }) => x.description.trim()),
    summary: ordered(r.summary, SUMMARY_CATALOG.map(({ key, label, visible }) => ({ key, label, visible }))) as InvoiceTemplateConfig['summary'],
    custom_fields: (Array.isArray(r.custom_fields) ? r.custom_fields : []).slice(0, 20)
      .map((x: any) => ({ label: str(x?.label, 60), value: str(x?.value, 300), visible: bool(x?.visible, true) }))
      .filter((x: { label: string }) => x.label.trim()),
    footer: {
      terms: str(f.terms, 2000, d.footer.terms), refund_policy: str(f.refund_policy, 2000), payment_instructions: str(f.payment_instructions, 1000),
      bank_details: str(f.bank_details, 600), upi_qr: image(f.upi_qr), upi_id: str(f.upi_id, 80),
      signature_label: str(f.signature_label, 60, d.footer.signature_label), signature_img: image(f.signature_img), stamp_img: image(f.stamp_img),
      accountant_name: str(f.accountant_name, 80), thank_you: str(f.thank_you, 200, d.footer.thank_you),
      show_generated_at: bool(f.show_generated_at, true), show_page_number: bool(f.show_page_number, true), note: str(f.note, 400),
    },
    design: {
      font_size: num(g.font_size, 7, 12, 9), spacing: oneOf(g.spacing, ['compact', 'normal', 'relaxed'] as const, d.design.spacing),
      borders: bool(g.borders, d.design.borders), striped: bool(g.striped, d.design.striped), rounded_header: bool(g.rounded_header, false),
    },
  };
}

/** {{variable}} substitution for custom text (custom fields, terms, notes, thank-you). */
export function fillVars(text: string, vars: Record<string, string>): string {
  return String(text ?? '').replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (m, k) => (k in vars ? vars[k] : m));
}
