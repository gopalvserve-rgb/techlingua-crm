import { resolveBand, validateBands, Band } from './grade';

const INDIA: Band[] = [
  { label: 'Fail', min_pct: 0, max_pct: 50, is_pass: false, ordering: 1 },
  { label: 'C', min_pct: 50, max_pct: 60, is_pass: true, ordering: 2 },
  { label: 'B', min_pct: 60, max_pct: 70, is_pass: true, ordering: 3 },
  { label: 'B+', min_pct: 70, max_pct: 80, is_pass: true, ordering: 4 },
  { label: 'A', min_pct: 80, max_pct: 90, is_pass: true, ordering: 5 },
  { label: 'A+', min_pct: 90, max_pct: 100, is_pass: true, ordering: 6 },
];

describe('grade band resolution — boundaries', () => {
  const g = (p: number) => resolveBand(INDIA, p)?.label;
  it('49.99 -> Fail, 50 -> C (the pass boundary)', () => { expect(g(49.99)).toBe('Fail'); expect(g(50)).toBe('C'); });
  it('59.99 -> C, 60 -> B', () => { expect(g(59.99)).toBe('C'); expect(g(60)).toBe('B'); });
  it('89 -> A, 90 -> A+', () => { expect(g(89)).toBe('A'); expect(g(89.99)).toBe('A'); expect(g(90)).toBe('A+'); });
  it('100 -> A+ (top band closes inclusive)', () => { expect(g(100)).toBe('A+'); });
  it('0 -> Fail; is_pass follows the band', () => {
    expect(g(0)).toBe('Fail');
    expect(resolveBand(INDIA, 49)?.is_pass).toBe(false);
    expect(resolveBand(INDIA, 55)?.is_pass).toBe(true);
  });
});

describe('grade scheme validation', () => {
  it('accepts the contiguous India default and renumbers ordering', () => {
    const v = validateBands(INDIA);
    expect(v.ok).toBe(true);
    if (v.ok) { expect(v.bands[0].label).toBe('Fail'); expect(v.bands[5].label).toBe('A+'); }
  });
  it('rejects a GAP', () => {
    const bands: Band[] = [
      { label: 'Fail', min_pct: 0, max_pct: 50, is_pass: false },
      { label: 'Pass', min_pct: 55, max_pct: 100, is_pass: true },
    ];
    const v = validateBands(bands);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toMatch(/contiguous|gap/i);
  });
  it('rejects an OVERLAP', () => {
    const bands: Band[] = [
      { label: 'Fail', min_pct: 0, max_pct: 55, is_pass: false },
      { label: 'Pass', min_pct: 50, max_pct: 100, is_pass: true },
    ];
    expect(validateBands(bands).ok).toBe(false);
  });
  it('rejects when nothing starts at 0 or ends at 100', () => {
    expect(validateBands([{ label: 'a', min_pct: 10, max_pct: 100, is_pass: true }, { label: 'b', min_pct: 0, max_pct: 10, is_pass: false }]).ok).toBe(true);
    expect(validateBands([{ label: 'a', min_pct: 0, max_pct: 90, is_pass: true }, { label: 'b', min_pct: 90, max_pct: 95, is_pass: true }]).ok).toBe(false);
  });
  it('rejects a scheme with NO pass band', () => {
    const bands: Band[] = [
      { label: 'F1', min_pct: 0, max_pct: 50, is_pass: false },
      { label: 'F2', min_pct: 50, max_pct: 100, is_pass: false },
    ];
    const v = validateBands(bands);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toMatch(/pass/i);
  });
});
