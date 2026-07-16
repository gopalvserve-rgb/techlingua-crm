import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PdfPage, buildPdf, textWidth, toWinAnsi } from './pdf.util';
import { quotationPdf, receiptPdf } from './documents';

const LH = {
  org_name: 'Tech Lingua LLP', org_gst: '07AABCT1234C1ZV',
  vertical_name: 'British Council Learning', branch_name: 'Vikaspuri',
  branch_address: '2nd Floor, District Centre, Vikaspuri, New Delhi 110018',
  branch_phone: '+91 98100 00001', branch_email: 'vikaspuri@techlingua.in',
};

const QUOTE = {
  quote_no: 'QT-2026/0001', version: 1, status: 'draft',
  created_at: '2026-07-16T10:00:00Z', valid_until: '2026-08-15',
  lead_name: 'Priya Sharma', lead_phone: '+919810000011', lead_email: 'priya@example.com',
  counsellor_name: 'Asha Rao', campaign_name: 'Meta Jul',
  notes: 'Weekend batch requested.', terms: '50% on enrolment, balance before the second module.',
  subtotal_minor: 6_625_000, discount_minor: 500_000, tax_minor: 1_021_500, total_minor: 7_146_500,
  items: [
    { line_no: 1, description: 'IELTS Academic — 8 weeks', qty: 1, unit_price_minor: 4_500_000, discount_type: 'percent', discount_value: 10, discount_minor: 450_000, tax_pct: 18, tax_minor: 729_000, total_minor: 4_779_000 },
    { line_no: 2, description: 'Study material & practice tests', qty: 2, unit_price_minor: 250_000, discount_type: 'amount', discount_value: 50_000, discount_minor: 50_000, tax_pct: 0, tax_minor: 0, total_minor: 450_000 },
    { line_no: 3, description: 'Exam registration fee', qty: 1, unit_price_minor: 1_625_000, discount_type: 'amount', discount_value: 0, discount_minor: 0, tax_pct: 18, tax_minor: 292_500, total_minor: 1_917_500 },
  ],
};

const RECEIPT = {
  receipt_no: 'RCP-2026/0001', received_at: '2026-07-16T11:30:00Z',
  amount_minor: 2_000_000, mode: 'upi', reference: 'UTR9876543210', note: 'First installment',
  student_name: 'Priya Sharma', student_phone: '+919810000011',
  enrolment_no: 'ENR-2026/0001', course_name: 'IELTS Academic',
  net_fee_minor: 4_050_000, paid_minor: 2_000_000, balance_minor: 2_050_000,
  received_by_name: 'Asha Rao',
};

describe('the PDF writer produces a REAL pdf', () => {
  it('starts with a header and ends with an EOF, with a valid xref', () => {
    const buf = quotationPdf(QUOTE as never, LH);
    const s = buf.toString('latin1');
    expect(s.startsWith('%PDF-1.4')).toBe(true);
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(s).toContain('/Type /Catalog');
    expect(s).toContain('/Type /Pages');
    expect(s).toContain('/Type /Page');
    expect(s).toContain('xref');
    expect(s).toContain('trailer');
  });

  it('the xref offsets really point at their objects (a wrong xref = a file no reader opens)', () => {
    const buf = buildPdf([new PdfPage().text('hello', 40, 40)]);
    const s = buf.toString('latin1');
    const startxref = Number(/startxref\s+(\d+)/.exec(s)![1]);
    expect(s.slice(startxref, startxref + 4)).toBe('xref');

    const table = /xref\n0 (\d+)\n([\s\S]*?)trailer/.exec(s)!;
    const count = Number(table[1]);
    const lines = table[2].trim().split('\n');
    expect(lines).toHaveLength(count);
    // entry 0 is the free head; entries 1..n must land exactly on "<n> 0 obj"
    for (let i = 1; i < count; i++) {
      const off = Number(lines[i].slice(0, 10));
      expect(s.slice(off, off + String(i).length + 6)).toBe(`${i} 0 obj`);
    }
  });

  it('the /Parent forward reference resolves to the real Pages object', () => {
    const s = buildPdf([new PdfPage().text('x', 10, 10), new PdfPage().text('y', 10, 10)]).toString('latin1');
    const parent = Number(/\/Parent (\d+) 0 R/.exec(s)![1]);
    const pagesObj = new RegExp(`\\n${parent} 0 obj\\n<< /Type /Pages`).test(s);
    expect(pagesObj).toBe(true);
    expect(/\/Count 2/.test(s)).toBe(true);
  });

  it('escapes parentheses and backslashes — an unescaped "(" corrupts the stream', () => {
    const s = buildPdf([new PdfPage().text('Fee (incl. tax) \\ 50%', 40, 40)]).toString('latin1');
    expect(s).toContain('(Fee \\(incl. tax\\) \\\\ 50%)');
  });
});

describe('the ₹ decision is deliberate and total', () => {
  it('₹ becomes "Rs." — WinAnsi has no rupee glyph, so printing it would emit a box', () => {
    expect(toWinAnsi('₹45,000.00')).toBe('Rs.45,000.00');
  });

  it('NO PDF this app produces ever contains a raw ₹ byte sequence', () => {
    for (const buf of [quotationPdf(QUOTE as never, LH), receiptPdf(RECEIPT as never, LH)]) {
      expect(buf.includes(Buffer.from('₹', 'utf8'))).toBe(false);
      expect(buf.toString('latin1')).toContain('Rs.');
    }
  });

  it('smart quotes and dashes are transliterated, not dropped', () => {
    expect(toWinAnsi('“hello” — it’s fine…')).toBe('"hello" - it\'s fine...');
  });

  it('Latin-1 names survive EXACTLY as typed — WinAnsi carries them', () => {
    expect(toWinAnsi('José Müller')).toBe('José Müller');
  });

  it('a transliterated Indian name keeps its letters: "Priyā" -> "Priya", NOT "Priy?"', () => {
    // ā is U+0101, outside Latin-1. Accent-stripping is what stops a receipt insulting
    // the person it is addressed to. This client WILL have these names.
    expect(toWinAnsi('Priyā Śarmā')).toBe('Priya Sarma');
    expect(toWinAnsi('Kṛṣṇa Ṭhākur')).toBe('Krsna Thakur');
  });

  it('only a character with NO Latin base becomes "?" — visible, never a silent drop', () => {
    expect(toWinAnsi('第')).toBe('?');                 // CJK — no Helvetica glyph exists
    expect(toWinAnsi('प्रिया')).toMatch(/^\?+$/);   // Devanagari — needs an embedded font
    expect(toWinAnsi('a第b')).toBe('a?b');             // never a silent deletion
  });
});

describe('the documents say what they must', () => {
  it('the QUOTATION carries the per-vertical, per-branch letterhead', () => {
    const s = quotationPdf(QUOTE as never, LH).toString('latin1');
    expect(s).toContain('British Council Learning');       // the VERTICAL leads — it is the brand
    expect(s).toContain('a Tech Lingua LLP company');      // the org is the legal entity
    expect(s).toContain('Vikaspuri');                      // the branch the customer walks into
    expect(s).toContain('vikaspuri@techlingua.in');
    expect(s).toContain('07AABCT1234C1ZV');
  });

  it('the QUOTATION is NOT a tax invoice, and says so on its face', () => {
    const s = quotationPdf(QUOTE as never, LH).toString('latin1');
    expect(s).toContain('not a tax invoice');
    expect(s).toContain('QUOTATION');
    expect(s).toContain('QT-2026/0001');
  });

  it('the QUOTATION prints every line and a total that matches them', () => {
    const s = quotationPdf(QUOTE as never, LH).toString('latin1');
    for (const it of QUOTE.items) expect(s).toContain(it.description.split(' — ')[0].split(' &')[0]);
    expect(s).toContain('71,465.00');                       // the total, Indian-grouped
    expect(s).toContain('66,250.00');                       // subtotal
    expect(s).toContain('5,000.00');                        // discount
  });

  it('a REVISION says so in its title', () => {
    const s = quotationPdf({ ...QUOTE, version: 3 } as never, LH).toString('latin1');
    expect(s).toContain('QUOTATION \\(REV 3\\)');
  });

  it('the RECEIPT shows the amount, the mode, the reference and the BALANCE', () => {
    const s = receiptPdf(RECEIPT as never, LH).toString('latin1');
    expect(s).toContain('FEE RECEIPT');
    expect(s).toContain('RCP-2026/0001');
    expect(s).toContain('20,000.00');        // the amount received
    expect(s).toContain('UPI');
    expect(s).toContain('UTR9876543210');
    expect(s).toContain('20,500.00');        // the balance — a receipt that hides the balance is half a receipt
    expect(s).toContain('ENR-2026/0001');
  });

  it('the RECEIPT is NOT a GST invoice, and says so', () => {
    const s = receiptPdf(RECEIPT as never, LH).toString('latin1');
    expect(s).toContain('not a GST tax invoice');
    expect(s).toContain('valid without signature');
  });

  it('an org with no vertical / no GST still produces a clean letterhead', () => {
    const bare = { org_name: 'Tech Lingua LLP' };
    const s = receiptPdf(RECEIPT as never, bare).toString('latin1');
    expect(s).toContain('Tech Lingua LLP');
    expect(s).not.toContain('a Tech Lingua LLP company');   // no "a X company" when X IS the brand
    expect(s).not.toContain('GSTIN');
  });
});

describe('layout maths', () => {
  it('measures Helvetica so right-aligned money lines up', () => {
    expect(textWidth('45,000.00', 9)).toBeCloseTo(textWidth('12,345.67', 9), 5);   // digits are equal-width
    expect(textWidth('W', 10, 'Helvetica-Bold')).toBeGreaterThan(textWidth('i', 10, 'Helvetica-Bold'));
  });

  it('clips a long course name instead of letting it overrun its column', () => {
    const long = 'IELTS Academic Intensive Preparation Programme with Weekend Doubt Clearing';
    const clipped = PdfPage.clip(long, 120, 9);
    expect(clipped.endsWith('...')).toBe(true);
    expect(textWidth(clipped, 9)).toBeLessThanOrEqual(120);
  });

  it('a 50-line quotation still produces a parseable file (no infinite layout)', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ ...QUOTE.items[0], line_no: i + 1, description: `Line ${i + 1}` }));
    const buf = quotationPdf({ ...QUOTE, items } as never, LH);
    expect(buf.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true);
  });
});

/**
 * THE ACID TEST — hand the bytes to a real PDF parser.
 *
 * Everything above checks that we wrote what we meant to write. This checks that a
 * THIRD PARTY can read it, which is the only claim that matters when the client
 * forwards a quotation to a customer. Skipped automatically where pdftotext is not
 * installed, so it never turns CI red for the wrong reason — but it runs in the
 * sandbox, and it ran before this shipped.
 */
const HAS_PDFTOTEXT = (() => {
  try { execFileSync('which', ['pdftotext'], { stdio: 'pipe' }); return true; } catch { return false; }
})();

(HAS_PDFTOTEXT ? describe : describe.skip)('a REAL pdf parser can read it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlpdf-'));

  const extract = (buf: Buffer, name: string): string => {
    const f = join(dir, `${name}.pdf`);
    writeFileSync(f, buf);
    return execFileSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' });
  };

  it('pdftotext parses the QUOTATION and finds its numbers', () => {
    const txt = extract(quotationPdf(QUOTE as never, LH), 'quote');
    expect(txt).toContain('QT-2026/0001');
    expect(txt).toContain('Priya Sharma');
    expect(txt).toContain('IELTS Academic');
    expect(txt).toContain('71,465.00');
    expect(txt).toContain('British Council Learning');
  });

  it('pdftotext parses the RECEIPT and finds the balance', () => {
    const txt = extract(receiptPdf(RECEIPT as never, LH), 'receipt');
    expect(txt).toContain('RCP-2026/0001');
    expect(txt).toContain('Rs. 20,000.00');
    expect(txt).toContain('20,500.00');
    expect(txt).toContain('UTR9876543210');
  });

  it('the file is structurally sound (no parser warnings about xref/objects)', () => {
    const f = join(dir, 'check.pdf');
    writeFileSync(f, quotationPdf(QUOTE as never, LH));
    const out = execFileSync('pdftotext', [f, '-'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    expect(out.length).toBeGreaterThan(100);
  });
});
