import { pickCap, capMinor, resolveCapMinor, capSpecificity, DiscountCapRow } from './discount-master.util';

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

  /* ------------------------------------------------------------------ LEVEL scope (dev/107) */
  describe('course-LEVEL scope — most-specific-wins including level', () => {
    // Same course (5), two level-specific caps + the course-wide + vertical + org caps.
    const orgD: DiscountCapRow = { id: 1, branch_id: null, vertical_id: null, course_id: null, course_level_id: null, max_percent: 10, max_amount_minor: null };
    const vert: DiscountCapRow = { id: 2, branch_id: null, vertical_id: 9, course_id: null, course_level_id: null, max_percent: 20, max_amount_minor: null };
    const crs: DiscountCapRow = { id: 3, branch_id: null, vertical_id: 9, course_id: 5, course_level_id: null, max_percent: null, max_amount_minor: 500000 };
    const lvlA1: DiscountCapRow = { id: 4, branch_id: null, vertical_id: 9, course_id: 5, course_level_id: 27, max_percent: null, max_amount_minor: 100000 };
    const all = [orgD, vert, crs, lvlA1];

    it('a course+LEVEL rule caps THAT level (beats the course-wide rule)', () => {
      const r = resolveCapMinor(all, { vertical_id: 9, course_id: 5, course_level_id: 27 }, 2050000);
      expect(r.cap?.id).toBe(4);        // the A1 level rule wins
      expect(r.capMinor).toBe(100000);  // its flat ₹1,000 cap
    });

    it('a course rule still applies for a DIFFERENT level with no level rule', () => {
      // level 28 (A2) has no level-specific cap → the broader course cap applies.
      const r = resolveCapMinor(all, { vertical_id: 9, course_id: 5, course_level_id: 28 }, 2050000);
      expect(r.cap?.id).toBe(3);        // the course-wide rule
      expect(r.capMinor).toBe(500000);  // ₹5,000
    });

    it('a level-specific rule NEVER applies to a level-less (course-only) enrolment', () => {
      const r = resolveCapMinor(all, { vertical_id: 9, course_id: 5 }, 2050000);
      expect(r.cap?.id).toBe(3);        // falls back to the course rule, not the A1 level rule
    });

    it('specificity order is course+level > course > vertical > branch > org', () => {
      expect(capSpecificity({ id: 0, branch_id: 1, vertical_id: 9, course_id: 5, course_level_id: 27, max_percent: 0, max_amount_minor: null }))
        .toBeGreaterThan(capSpecificity(crs));
      expect(capSpecificity(crs)).toBeGreaterThan(capSpecificity(vert));
      expect(capSpecificity(vert)).toBeGreaterThan(capSpecificity({ id: 0, branch_id: 1, vertical_id: null, course_id: null, course_level_id: null, max_percent: 0, max_amount_minor: null }));
      expect(capSpecificity({ id: 0, branch_id: 1, vertical_id: null, course_id: null, course_level_id: null, max_percent: 0, max_amount_minor: null }))
        .toBeGreaterThan(capSpecificity(orgD));
    });
  });
});
