import { receiptPdf, studentIdCardPdf, Letterhead } from './documents';

/** dev/143 item 5 — the Fee Receipt / Fee Invoice / Student ID generators consume the
 *  document_template overrides (header title, footer, terms) threaded on the Letterhead. */
const base: Letterhead = { org_name: 'Org', vertical_name: 'V', branch_name: 'B' };
const txt = (b: Buffer) => b.toString('latin1');

describe('document templates are consumed by the generators', () => {
  it('Fee Receipt uses the template header title + footer', () => {
    const b = receiptPdf(
      { receipt_no: 'R1', received_at: '2026-08-28', amount_minor: 1000, mode: 'cash',
        student_name: 'S', enrolment_no: 'E1', net_fee_minor: 2000, paid_minor: 1000, balance_minor: 1000 } as any,
      { ...base, tpl: { header_title: 'CUSTOM RECEIPT TITLE', footer_text: 'Custom receipt footer' } });
    const s = txt(b);
    expect(s).toContain('CUSTOM RECEIPT TITLE');
    expect(s).toContain('Custom receipt footer');
  });

  it('Fee Receipt with no template falls back to the default title', () => {
    const b = receiptPdf(
      { receipt_no: 'R1', received_at: '2026-08-28', amount_minor: 1000, mode: 'cash',
        student_name: 'S', enrolment_no: 'E1', net_fee_minor: 2000, paid_minor: 1000, balance_minor: 1000 } as any,
      base);
    expect(txt(b)).toContain('FEE RECEIPT');
  });

  it('Student ID card uses the template header title', () => {
    const b = studentIdCardPdf(
      { student_name: 'Asha', student_no: 'STU-1' } as any,
      { ...base, tpl: { header_title: 'CAMPUS ID CARD' } });
    expect(txt(b)).toContain('CAMPUS ID CARD');
  });
});
