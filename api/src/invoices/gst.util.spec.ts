import { computeGstLine, computeGstTotals, supplyTypeFor, roundToRupeeHalfUp } from './gst.util';
import { amountInWordsINR, integerToIndianWords } from '../common/money.util';

describe('GST split — intra vs inter state', () => {
  it('intra-state: CGST = SGST = rate/2, IGST = 0', () => {
    // ₹10,000 taxable, 18% GST -> CGST 900 + SGST 900 = ₹1,800
    const l = computeGstLine({ qty: 1, unit_price_minor: 1000000, discount_type: 'amount', discount_value: 0, gst_pct: 18 }, 'intra');
    expect(l.taxable_minor).toBe(1000000);
    expect(l.cgst_minor).toBe(90000);
    expect(l.sgst_minor).toBe(90000);
    expect(l.igst_minor).toBe(0);
    expect(l.cgst_minor).toBe(l.sgst_minor);
    expect(l.total_minor).toBe(1000000 + 90000 + 90000);
  });

  it('inter-state: IGST = rate, CGST = SGST = 0', () => {
    const l = computeGstLine({ qty: 1, unit_price_minor: 1000000, discount_type: 'amount', discount_value: 0, gst_pct: 18 }, 'inter');
    expect(l.igst_minor).toBe(180000);
    expect(l.cgst_minor).toBe(0);
    expect(l.sgst_minor).toBe(0);
    expect(l.total_minor).toBe(1000000 + 180000);
  });

  it('the intra CGST+SGST equals the inter IGST for the same taxable value (18%)', () => {
    const intra = computeGstLine({ qty: 1, unit_price_minor: 1000000, discount_type: 'amount', discount_value: 0, gst_pct: 18 }, 'intra');
    const inter = computeGstLine({ qty: 1, unit_price_minor: 1000000, discount_type: 'amount', discount_value: 0, gst_pct: 18 }, 'inter');
    expect(intra.cgst_minor + intra.sgst_minor).toBe(inter.igst_minor);
  });

  it('discount is applied BEFORE tax', () => {
    // ₹10,000 less 10% = ₹9,000 taxable; 18% -> ₹1,620
    const l = computeGstLine({ qty: 1, unit_price_minor: 1000000, discount_type: 'percent', discount_value: 10, gst_pct: 18 }, 'inter');
    expect(l.discount_minor).toBe(100000);
    expect(l.taxable_minor).toBe(900000);
    expect(l.igst_minor).toBe(162000);
  });

  it('odd GST rate (5%) splits to 2.5% + 2.5% intra', () => {
    const l = computeGstLine({ qty: 1, unit_price_minor: 100000, discount_type: 'amount', discount_value: 0, gst_pct: 5 }, 'intra');
    expect(l.cgst_minor).toBe(2500);
    expect(l.sgst_minor).toBe(2500);
  });
});

describe('supplyTypeFor', () => {
  it('same state -> intra; different -> inter; unknown POS -> intra', () => {
    expect(supplyTypeFor(7, 7)).toBe('intra');
    expect(supplyTypeFor(7, 9)).toBe('inter');
    expect(supplyTypeFor(7, null)).toBe('intra');
    expect(supplyTypeFor(null, null)).toBe('intra');
  });
});

describe('totals + round-off', () => {
  it('rounds the grand total to the nearest rupee and reports the delta', () => {
    // taxable 999.50 -> ...; contrive a sub that ends in 50p
    const lines = [computeGstLine({ qty: 1, unit_price_minor: 99950, discount_type: 'amount', discount_value: 0, gst_pct: 0 }, 'intra')];
    const t = computeGstTotals(lines);
    expect(t.sub_total_minor).toBe(99950);
    expect(t.total_minor).toBe(100000);          // rounded up to ₹1000
    expect(t.round_off_minor).toBe(50);
  });

  it('roundToRupeeHalfUp: 49p down, 50p up', () => {
    expect(roundToRupeeHalfUp(12349)).toBe(12300);
    expect(roundToRupeeHalfUp(12350)).toBe(12400);
    expect(roundToRupeeHalfUp(12300)).toBe(12300);
  });

  it('totals are the SUM of the rounded lines (CGST column adds up)', () => {
    const mk = () => computeGstLine({ qty: 1, unit_price_minor: 33333, discount_type: 'amount', discount_value: 0, gst_pct: 18 }, 'intra');
    const lines = [mk(), mk(), mk()];
    const t = computeGstTotals(lines);
    expect(t.cgst_minor).toBe(lines[0].cgst_minor * 3);
    expect(t.sgst_minor).toBe(lines[0].sgst_minor * 3);
    expect(t.taxable_minor).toBe(33333 * 3);
  });
});

describe('amount in words (Indian)', () => {
  it('reads whole and paise', () => {
    expect(amountInWordsINR(12345678)).toBe('Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Seventy Eight Paise Only');
    expect(amountInWordsINR(100000)).toBe('Rupees One Thousand Only');
    expect(amountInWordsINR(0)).toBe('Rupees Zero Only');
  });
  it('crore grouping', () => {
    expect(integerToIndianWords(12345678)).toBe('One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight');
  });
});
