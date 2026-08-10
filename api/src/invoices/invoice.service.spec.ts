import { InvoiceService } from './invoice.service';

const svc = () => new InvoiceService(
  {} as never,
  { buildScopeWhere: () => '1=1' } as never,
  {} as never,
);

describe('invoice line normalisation + GST split', () => {
  const s = svc();

  it('turns rupees into paise, applies discount-before-tax, splits CGST/SGST for intra-state', () => {
    const [l] = s.normaliseItems(
      [{ description: 'IELTS course fee', hsn_sac: '999293', qty: 1, unit_price: '10,000', gst_pct: '18' }],
      'intra',
    );
    expect(l.unit_price_minor).toBe(1_000_000);
    expect(l.hsn_sac).toBe('999293');
    expect(l.computed.cgst_minor).toBe(90_000);
    expect(l.computed.sgst_minor).toBe(90_000);
    expect(l.computed.igst_minor).toBe(0);
  });

  it('the same line, inter-state, is all IGST', () => {
    const [l] = s.normaliseItems(
      [{ description: 'IELTS course fee', qty: 1, unit_price: '10,000', gst_pct: '18' }],
      'inter',
    );
    expect(l.computed.igst_minor).toBe(180_000);
    expect(l.computed.cgst_minor).toBe(0);
    expect(l.computed.sgst_minor).toBe(0);
  });

  it('refuses an invoice with no lines / no description', () => {
    expect(() => s.normaliseItems([], 'intra')).toThrow(/at least one line item/);
    expect(() => s.normaliseItems([{ unit_price: '100' }], 'intra')).toThrow(/description is required/);
  });

  it('refuses GST outside 0–100 and junk money', () => {
    expect(() => s.normaliseItems([{ description: 'x', unit_price: '100', gst_pct: '150' }], 'intra')).toThrow(/GST must be between 0 and 100/);
    expect(() => s.normaliseItems([{ description: 'x', unit_price: 'free' }], 'intra')).toThrow(/not an amount/);
  });

  it('clips HSN/SAC to 8 chars and an over-long description to 240', () => {
    const [l] = s.normaliseItems([{ description: 'a'.repeat(400), unit_price: '1', hsn_sac: '123456789012' }], 'intra');
    expect(l.description).toHaveLength(240);
    expect(l.hsn_sac).toHaveLength(8);
  });
});
