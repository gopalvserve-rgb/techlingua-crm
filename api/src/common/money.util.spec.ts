import {
  applyPct, computeLine, computeTotals, divRoundHalfUp, formatINR,
  minorToRupeeString, rupeesToMinor,
} from './money.util';

/**
 * THE MONEY RULES, PINNED.
 *
 * Every number here is one a human can check by hand. If a change to the rounding makes
 * one of these go red, that is the point: the rule changed, and the client must be told,
 * because his quotations and receipts will start showing different totals.
 */

describe('half-up rounding (rule 4)', () => {
  it('rounds .5 UP, away from zero — not Math.round\'s "half toward +Infinity"', () => {
    expect(divRoundHalfUp(5, 10)).toBe(1);       // 0.5 -> 1
    expect(divRoundHalfUp(4, 10)).toBe(0);       // 0.4 -> 0
    expect(divRoundHalfUp(15, 10)).toBe(2);      // 1.5 -> 2
    expect(divRoundHalfUp(25, 10)).toBe(3);      // 2.5 -> 3  (NOT banker's rounding's 2)
    expect(divRoundHalfUp(-5, 10)).toBe(-1);     // -0.5 -> -1 (Math.round gives -0)
    expect(divRoundHalfUp(-15, 10)).toBe(-2);
  });

  it('is exact where floating point is not', () => {
    // the canonical float trap: 0.1 + 0.2 !== 0.3, and 1.005 rounds "wrong"
    expect(rupeesToMinor('0.1') + rupeesToMinor('0.2')).toBe(rupeesToMinor('0.3'));
    expect(rupeesToMinor('1.005')).toBe(101);     // half-up on the paisa
    expect(rupeesToMinor(0.1) + rupeesToMinor(0.2)).toBe(30);
  });
});

describe('rupees <-> paise', () => {
  it('parses what a human types', () => {
    expect(rupeesToMinor('45000')).toBe(4_500_000);
    expect(rupeesToMinor('45,000.50')).toBe(4_500_050);
    expect(rupeesToMinor('₹45000')).toBe(4_500_000);
    expect(rupeesToMinor(' 45000.5 ')).toBe(4_500_050);
    expect(rupeesToMinor(45000)).toBe(4_500_000);
    expect(rupeesToMinor('')).toBe(0);
    expect(rupeesToMinor(null)).toBe(0);
  });

  it('REFUSES junk rather than silently storing 0 (the Campaign Budget bug, QA-13 §4)', () => {
    expect(() => rupeesToMinor('abc')).toThrow(/not an amount/);
    expect(() => rupeesToMinor('12abc')).toThrow(/not an amount/);
    expect(() => rupeesToMinor('1.2.3')).toThrow(/not an amount/);
    expect(() => rupeesToMinor(NaN)).toThrow(/not an amount/);
  });

  it('round-trips', () => {
    for (const r of ['0', '1', '99.99', '45000.05', '1234567.89']) {
      expect(minorToRupeeString(rupeesToMinor(r))).toBe(Number(r).toFixed(2));
    }
  });
});

describe('INDIAN digit grouping (2,2,3)', () => {
  it('groups the Indian way, not the Western way', () => {
    expect(formatINR(4_500_000)).toBe('₹45,000.00');
    expect(formatINR(123_456_700)).toBe('₹12,34,567.00');       // NOT ₹1,234,567.00
    expect(formatINR(1_000_000_000)).toBe('₹1,00,00,000.00');   // one crore = 10^9 paise
    expect(formatINR(9_999)).toBe('₹99.99');
    expect(formatINR(0)).toBe('₹0.00');
    expect(formatINR(-4_500_050)).toBe('-₹45,000.50');
    expect(formatINR(4_500_000, { symbol: false })).toBe('45,000.00');
  });
});

describe('the line maths (rules 2, 3, 5)', () => {
  it('AMOUNT discount, then tax', () => {
    // ₹45,000 x 1, less ₹5,000, +18% tax on ₹40,000 = ₹7,200 -> ₹47,200
    const l = computeLine({ qty: 1, unit_price_minor: 4_500_000, discount_type: 'amount', discount_value: 500_000, tax_pct: 18 });
    expect(l).toEqual({
      gross_minor: 4_500_000, discount_minor: 500_000, taxable_minor: 4_000_000,
      tax_minor: 720_000, total_minor: 4_720_000,
    });
  });

  it('PERCENT discount, then tax', () => {
    // ₹45,000 less 10% = ₹4,500 -> ₹40,500; +18% = ₹7,290 -> ₹47,790
    const l = computeLine({ qty: 1, unit_price_minor: 4_500_000, discount_type: 'percent', discount_value: 10, tax_pct: 18 });
    expect(l.discount_minor).toBe(450_000);
    expect(l.taxable_minor).toBe(4_050_000);
    expect(l.tax_minor).toBe(729_000);
    expect(l.total_minor).toBe(4_779_000);
  });

  it('TAX IS ON THE DISCOUNTED AMOUNT — not the gross (rule 2)', () => {
    const discounted = computeLine({ qty: 1, unit_price_minor: 1_000_000, discount_type: 'percent', discount_value: 50, tax_pct: 18 });
    const notDiscounted = computeLine({ qty: 1, unit_price_minor: 1_000_000, discount_type: 'amount', discount_value: 0, tax_pct: 18 });
    expect(discounted.tax_minor).toBe(90_000);      // 18% of ₹5,000
    expect(notDiscounted.tax_minor).toBe(180_000);  // 18% of ₹10,000
  });

  it('QUANTITY multiplies the gross before anything else', () => {
    const l = computeLine({ qty: 3, unit_price_minor: 1_000_000, discount_type: 'percent', discount_value: 10, tax_pct: 0 });
    expect(l.gross_minor).toBe(3_000_000);
    expect(l.discount_minor).toBe(300_000);         // 10% of the LINE, not of one unit
    expect(l.total_minor).toBe(2_700_000);
  });

  it('CLAMPS a discount to the line — 120% off does not pay the customer (rule 5)', () => {
    const pct = computeLine({ qty: 1, unit_price_minor: 1_000_000, discount_type: 'percent', discount_value: 120, tax_pct: 18 });
    expect(pct.discount_minor).toBe(1_000_000);
    expect(pct.taxable_minor).toBe(0);
    expect(pct.tax_minor).toBe(0);
    expect(pct.total_minor).toBe(0);

    const amt = computeLine({ qty: 1, unit_price_minor: 1_000_000, discount_type: 'amount', discount_value: 9_999_999, tax_pct: 0 });
    expect(amt.discount_minor).toBe(1_000_000);
    expect(amt.total_minor).toBe(0);
  });

  it('refuses a negative discount and a non-positive quantity', () => {
    expect(() => computeLine({ qty: 1, unit_price_minor: 100, discount_type: 'amount', discount_value: -1, tax_pct: 0 })).toThrow(/negative/);
    expect(() => computeLine({ qty: 1, unit_price_minor: 100, discount_type: 'percent', discount_value: -5, tax_pct: 0 })).toThrow(/negative/);
    expect(() => computeLine({ qty: 0, unit_price_minor: 100, discount_type: 'amount', discount_value: 0, tax_pct: 0 })).toThrow(/Quantity/);
  });

  it('rounds a fractional percentage half-up, on the line', () => {
    // 33.333% of ₹100.00 = ₹33.333 -> 3333 paise (33.3 -> round(3333.3) = 3333)
    expect(applyPct(10_000, 33.333)).toBe(3_333);
    // 12.5% of ₹1.00 = 12.5 paise -> 13 paise, HALF-UP
    expect(applyPct(100, 12.5)).toBe(13);
  });
});

describe('MULTI-LINE totals — the document\'s own column must add up (rule 3)', () => {
  it('a 3-line quote with mixed discounts and taxes', () => {
    const lines = [
      // IELTS ₹45,000, 10% off, 18% tax
      computeLine({ qty: 1, unit_price_minor: 4_500_000, discount_type: 'percent', discount_value: 10, tax_pct: 18 }),
      // Study material ₹2,500 x 2, ₹500 off, no tax
      computeLine({ qty: 2, unit_price_minor: 250_000, discount_type: 'amount', discount_value: 50_000, tax_pct: 0 }),
      // Exam fee ₹16,250, no discount, 18% tax
      computeLine({ qty: 1, unit_price_minor: 1_625_000, discount_type: 'amount', discount_value: 0, tax_pct: 18 }),
    ];
    const t = computeTotals(lines);

    expect(t.subtotal_minor).toBe(4_500_000 + 500_000 + 1_625_000);   // ₹66,250
    expect(t.discount_minor).toBe(450_000 + 50_000 + 0);              // ₹5,000
    expect(t.tax_minor).toBe(729_000 + 0 + 292_500);                  // ₹10,215
    expect(t.total_minor).toBe(4_779_000 + 450_000 + 1_917_500);      // ₹71,465

    // THE INVARIANT: total == subtotal - discount + tax. If rule 3 ever drifts to
    // "round the total", this is what goes red.
    expect(t.total_minor).toBe(t.subtotal_minor - t.discount_minor + t.tax_minor);
    expect(formatINR(t.total_minor)).toBe('₹71,465.00');
  });

  it('the invariant holds for awkward fractions too (per-line rounding is consistent)', () => {
    const lines = [
      computeLine({ qty: 3, unit_price_minor: 33_333, discount_type: 'percent', discount_value: 7.77, tax_pct: 18 }),
      computeLine({ qty: 1, unit_price_minor: 1, discount_type: 'percent', discount_value: 50, tax_pct: 18 }),
      computeLine({ qty: 7, unit_price_minor: 99_999, discount_type: 'percent', discount_value: 12.345, tax_pct: 5.5 }),
    ];
    const t = computeTotals(lines);
    expect(t.total_minor).toBe(t.subtotal_minor - t.discount_minor + t.tax_minor);
    for (const l of lines) expect(l.total_minor).toBe(l.gross_minor - l.discount_minor + l.tax_minor);
    // every stored value is an exact integer
    for (const l of lines) for (const v of Object.values(l)) expect(Number.isSafeInteger(v)).toBe(true);
  });

  it('an empty quote is zero, not NaN', () => {
    expect(computeTotals([])).toEqual({ subtotal_minor: 0, discount_minor: 0, tax_minor: 0, total_minor: 0 });
  });
});
