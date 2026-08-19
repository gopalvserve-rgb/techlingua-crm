import { pickCap, capMinor, resolveCapMinor, DiscountCapRow } from './discount-master.util';

/**
 * DISCOUNT MASTER cap resolver — pure, no DB. Most-specific-wins; the stricter of the
 * percent/amount ceilings binds.
 */
describe('discount-master cap resolver', () => {
  const org: DiscountCapRow = { id: 1, branch_id: null, vertical_id: null, course_id: null, max_percent: 20, max_amount_minor: null };
  const vertical: DiscountCapRow = { id: 2, branch_id: null, vertical_id: 9, course_id: null, max_percent: 30, max_amount_minor: null };
  const course: DiscountCapRow = { id: 3, branch_id: null, vertical_id: 9, course_id: 5, max_percent: null, max_amount_minor: 500000 };
  const caps = [org, vertical, course];

  it('org-wide default applies when nothing more specific matches', () => {
    expect(pickCap(caps, { branch_id: 1, vertical_id: 1, course_id: 1 })?.id).toBe(1);
  });

  it('a vertical cap beats the org default for that vertical', () => {
    expect(pickCap(caps, { vertical_id: 9, course_id: 99 })?.id).toBe(2);
  });

  it('a course cap is MORE SPECIFIC and wins over the vertical cap', () => {
    expect(pickCap(caps, { vertical_id: 9, course_id: 5 })?.id).toBe(3);
  });

  it('no cap matches → null (no limit)', () => {
    const only = [{ id: 7, branch_id: 3, vertical_id: null, course_id: null, max_percent: 10, max_amount_minor: null }];
    expect(pickCap(only, { branch_id: 4 })).toBeNull();
  });

  it('capMinor: percent ceiling on the base', () => {
    // 20% of ₹20,000 = ₹4,000
    expect(capMinor(org, 2000000)).toBe(400000);
  });

  it('capMinor: the stricter of percent AND amount binds', () => {
    const both: DiscountCapRow = { id: 8, branch_id: null, vertical_id: null, course_id: null, max_percent: 50, max_amount_minor: 100000 };
    // 50% of ₹20,000 = ₹10,000, but the ₹1,000 amount cap is stricter → ₹1,000
    expect(capMinor(both, 2000000)).toBe(100000);
  });

  it('capMinor: a cap that constrains neither dimension = no limit (null)', () => {
    const none: DiscountCapRow = { id: 9, branch_id: null, vertical_id: null, course_id: null, max_percent: null, max_amount_minor: null };
    expect(capMinor(none, 2000000)).toBeNull();
  });

  it('resolveCapMinor combines pick + capMinor', () => {
    const r = resolveCapMinor(caps, { vertical_id: 9, course_id: 5 }, 2000000);
    expect(r.cap?.id).toBe(3);
    expect(r.capMinor).toBe(500000); // the course cap is a flat ₹5,000
  });
});
