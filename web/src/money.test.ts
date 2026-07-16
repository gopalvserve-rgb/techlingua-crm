import { describe, expect, it } from 'vitest';
import { computeLine, computeTotals, fmtINR, minorToInput, parseRupees } from './money';

/**
 * THE CROSS-DRIFT PIN.
 *
 * `web/src/money.ts` and `api/src/common/money.util.ts` implement the SAME rules twice —
 * once so the counsellor sees live totals as he types, once because the server must never
 * trust a total the browser sends. Two implementations of one rule is a drift waiting to
 * happen, so the canonical example below is BYTE-FOR-BYTE the one in
 * `api/src/common/money.util.spec.ts` ("a 3-line quote with mixed discounts and taxes",
 * total ₹71,465.00). If either side changes its rounding, one of the two goes red.
 *
 * The blast radius is bounded either way: the API recomputes every line from the raw
 * inputs, so the worst a drift here can do is show a preview the save then corrects.
 */

describe('parsing what a human types', () => {
  it('takes rupees, commas, the symbol and whitespace', () => {
    expect(parseRupees('45000')).toBe(4_500_000);
    expect(parseRupees('45,000.50')).toBe(4_500_050);
    expect(parseRupees('₹45000')).toBe(4_500_000);
    expect(parseRupees(' 45000.5 ')).toBe(4_500_050);
    expect(parseRupees('')).toBe(0);
  });

  it('returns NULL on junk so the FORM can say so — never a silent ₹0', () => {
    // this is the Campaign Budget bug (QA-13 §4) with money instead of a report
    expect(parseRupees('abc')).toBeNull();
    expect(parseRupees('12abc')).toBeNull();
    expect(parseRupees('1.2.3')).toBeNull();
  });

  it('is exact where floats are not', () => {
    expect(parseRupees('0.1')! + parseRupees('0.2')!).toBe(parseRupees('0.3'));
    expect(parseRupees('1.005')).toBe(101);        // half-up on the paisa
  });

  it('round-trips through the rupee input', () => {
    expect(minorToInput(4_500_050)).toBe('45000.5');
    expect(minorToInput(0)).toBe('');
    expect(parseRupees(minorToInput(4_500_050))).toBe(4_500_050);
  });
});

describe('INDIAN digit grouping (2,2,3)', () => {
  it('groups the Indian way, not the Western way', () => {
    expect(fmtINR(4_500_000)).toBe('₹45,000.00');
    expect(fmtINR(123_456_700)).toBe('₹12,34,567.00');     // NOT ₹1,234,567.00
    expect(fmtINR(1_000_000_000)).toBe('₹1,00,00,000.00'); // one crore
    expect(fmtINR(0)).toBe('₹0.00');
    expect(fmtINR(-4_500_050)).toBe('-₹45,000.50');
    expect(fmtINR(null)).toBe('₹0.00');
    expect(fmtINR('4500000')).toBe('₹45,000.00');          // the API sends BIGINT as a string
  });
});

describe('the line rules match the API exactly', () => {
  const line = (o: Partial<Parameters<typeof computeLine>[0]>) => computeLine({
    course_id: null, description: 'x', qty: '1', unit_price: '0',
    discount_type: 'amount', discount_value: '0', tax_pct: '0', ...o,
  } as any);

  it('AMOUNT discount, then tax', () => {
    const l = line({ unit_price: '45000', discount_type: 'amount', discount_value: '5000', tax_pct: '18' });
    expect(l).toMatchObject({
      gross_minor: 4_500_000, discount_minor: 500_000, taxable_minor: 4_000_000,
      tax_minor: 720_000, total_minor: 4_720_000,
    });
  });

  it('PERCENT discount, then tax', () => {
    const l = line({ unit_price: '45000', discount_type: 'percent', discount_value: '10', tax_pct: '18' });
    expect(l.discount_minor).toBe(450_000);
    expect(l.tax_minor).toBe(729_000);
    expect(l.total_minor).toBe(4_779_000);
  });

  it('tax is on the DISCOUNTED amount', () => {
    expect(line({ unit_price: '10000', discount_type: 'percent', discount_value: '50', tax_pct: '18' }).tax_minor).toBe(90_000);
    expect(line({ unit_price: '10000', tax_pct: '18' }).tax_minor).toBe(180_000);
  });

  it('quantity multiplies the gross first', () => {
    const l = line({ qty: '3', unit_price: '10000', discount_type: 'percent', discount_value: '10' });
    expect(l.gross_minor).toBe(3_000_000);
    expect(l.discount_minor).toBe(300_000);
    expect(l.total_minor).toBe(2_700_000);
  });

  it('clamps a discount to the line', () => {
    expect(line({ unit_price: '10000', discount_type: 'amount', discount_value: '99999' }).total_minor).toBe(0);
  });

  it('reports junk as an ERROR the form shows, rather than quoting a wrong number', () => {
    expect(line({ unit_price: 'free' }).error).toMatch(/not an amount/);
    expect(line({ unit_price: '100', discount_type: 'percent', discount_value: '120' }).error).toMatch(/cannot exceed 100/);
    expect(line({ unit_price: '100', tax_pct: '150' }).error).toMatch(/between 0 and 100/);
    expect(line({ unit_price: '100', qty: '0' }).error).toMatch(/whole number/);
  });
});

describe('THE CANONICAL EXAMPLE — identical to api/src/common/money.util.spec.ts', () => {
  it('a 3-line quote with mixed discounts and taxes totals ₹71,465.00', () => {
    const t = computeTotals([
      { course_id: 21, description: 'IELTS', qty: '1', unit_price: '45000', discount_type: 'percent', discount_value: '10', tax_pct: '18' },
      { course_id: null, description: 'Material', qty: '2', unit_price: '2500', discount_type: 'amount', discount_value: '500', tax_pct: '0' },
      { course_id: null, description: 'Exam fee', qty: '1', unit_price: '16250', discount_type: 'amount', discount_value: '0', tax_pct: '18' },
    ]);
    expect(t.subtotal_minor).toBe(6_625_000);
    expect(t.discount_minor).toBe(500_000);
    expect(t.tax_minor).toBe(1_021_500);
    expect(t.total_minor).toBe(7_146_500);
    expect(fmtINR(t.total_minor)).toBe('₹71,465.00');

    // THE INVARIANT the whole rounding model exists to protect: the column adds up.
    expect(t.total_minor).toBe(t.subtotal_minor - t.discount_minor + t.tax_minor);
  });

  it('the invariant survives awkward fractions', () => {
    const t = computeTotals([
      { course_id: null, description: 'a', qty: '3', unit_price: '333.33', discount_type: 'percent', discount_value: '7.77', tax_pct: '18' },
      { course_id: null, description: 'b', qty: '7', unit_price: '999.99', discount_type: 'percent', discount_value: '12.345', tax_pct: '5.5' },
    ]);
    expect(t.total_minor).toBe(t.subtotal_minor - t.discount_minor + t.tax_minor);
    for (const l of t.lines) expect(Number.isSafeInteger(l.total_minor)).toBe(true);
  });

  it('an empty quote is zero, not NaN', () => {
    expect(computeTotals([])).toMatchObject({ subtotal_minor: 0, total_minor: 0 });
  });
});
