import { resolveLevels, sumLevelFees, sumLevelDiscounts, MasterLevel } from './level.util';
import { computeEnrolmentDiscount } from './discount.util';

/**
 * ENROLLMENT LEVEL RE-MODEL (batch 2) — pure resolution + the combined-fee math.
 * ONE enrolment carries N levels; Total = Σ level fees; Net = Total − Discount (overall or
 * level-wise). Fees are SNAPSHOTS from the course master.
 */

const MASTER: MasterLevel[] = [
  { id: 11, code: 'A1', label: 'A1', fee_minor: 1000000 }, // ₹10,000
  { id: 12, code: 'A2', label: 'A2', fee_minor: 1200000 }, // ₹12,000
  { id: 13, code: 'B1', label: 'B1', fee_minor: 1500000 }, // ₹15,000
  { id: 14, code: 'B2', label: 'B2', fee_minor: 1800000 }, // ₹18,000
];

describe('resolveLevels — snapshot + validate', () => {
  it('resolves 4 selected levels and Total = Σ level fees', () => {
    const sel = [{ course_level_id: 11 }, { course_level_id: 12 }, { code: 'B1' }, { code: 'b2' }];
    const levels = resolveLevels(MASTER, sel, 'overall');
    expect(levels.map((l) => l.code)).toEqual(['A1', 'A2', 'B1', 'B2']);
    expect(sumLevelFees(levels)).toBe(1000000 + 1200000 + 1500000 + 1800000); // ₹55,000
    // each fee is a snapshot from the master
    expect(levels[0].fee_minor).toBe(1000000);
    expect(levels[3].fee_minor).toBe(1800000);
  });

  it('honours an explicit per-level fee override', () => {
    const levels = resolveLevels(MASTER, [{ course_level_id: 11, fee_minor: 900000 }], 'overall');
    expect(levels[0].fee_minor).toBe(900000);
  });

  it('rejects an unknown level, a duplicate, and a discount over the level fee', () => {
    expect(() => resolveLevels(MASTER, [{ code: 'Z9' }], 'overall')).toThrow(/not a valid level/);
    expect(() => resolveLevels(MASTER, [{ code: 'A1' }, { course_level_id: 11 }], 'overall')).toThrow(/Duplicate/);
    expect(() => resolveLevels(MASTER, [{ code: 'A1', discount_minor: 2000000 }], 'level')).toThrow(/cannot exceed/);
  });

  it('carries per-level discounts only in level scope', () => {
    const sel = [{ code: 'A1', discount_minor: 100000 }, { code: 'A2', discount_minor: 50000 }];
    expect(sumLevelDiscounts(resolveLevels(MASTER, sel, 'level'))).toBe(150000);
    // overall scope ignores per-level discounts (the discount is applied on the total instead)
    expect(sumLevelDiscounts(resolveLevels(MASTER, sel, 'overall'))).toBe(0);
  });
});

describe('combined Net — overall vs level-wise', () => {
  const sel = [{ code: 'A1' }, { code: 'A2' }, { code: 'B1' }, { code: 'B2' }];
  it('OVERALL: Net = Total − overall discount (percent on the total)', () => {
    const total = sumLevelFees(resolveLevels(MASTER, sel, 'overall')); // ₹55,000
    const d = computeEnrolmentDiscount(total, 'percent', 10); // 10% = ₹5,500
    expect(d.discount_amount_minor).toBe(550000);
    expect(d.net_fee_minor).toBe(total - 550000); // ₹49,500
  });
  it('LEVEL-WISE: Net = Total − Σ per-level discounts', () => {
    const levels = resolveLevels(MASTER, [
      { code: 'A1', discount_minor: 100000 }, { code: 'A2', discount_minor: 200000 },
      { code: 'B1' }, { code: 'B2' }], 'level');
    const total = sumLevelFees(levels);
    const disc = sumLevelDiscounts(levels);
    expect(disc).toBe(300000);
    expect(total - disc).toBe(5500000 - 300000); // ₹52,000
  });
});

describe('resolveLevels — blank/zero level fee falls back to the course Standard Fee (dev/131 item 10)', () => {
  const MASTER0: MasterLevel[] = [
    { id: 21, code: 'A1', label: 'A1', fee_minor: 0 },        // blank fee
    { id: 22, code: 'A2', label: 'A2', fee_minor: 1200000 },  // ₹12,000 set
  ];
  it('uses the standard fee for a level whose master fee is blank/zero', () => {
    const levels = resolveLevels(MASTER0, [{ course_level_id: 21 }, { course_level_id: 22 }], 'overall', 900000); // std ₹9,000
    expect(levels[0].fee_minor).toBe(900000); // fell back to standard
    expect(levels[1].fee_minor).toBe(1200000); // kept its own fee
    expect(sumLevelFees(levels)).toBe(900000 + 1200000);
  });
  it('an explicit blank/zero fee override also falls back to the standard fee', () => {
    const levels = resolveLevels(MASTER0, [{ course_level_id: 22, fee_minor: 0 }], 'overall', 500000);
    expect(levels[0].fee_minor).toBe(500000);
  });
  it('without a standard fee a blank level stays ₹0 (unchanged back-compat)', () => {
    const levels = resolveLevels(MASTER0, [{ course_level_id: 21 }], 'overall');
    expect(levels[0].fee_minor).toBe(0);
  });
});
