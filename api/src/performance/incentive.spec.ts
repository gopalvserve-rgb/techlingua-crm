import { resolveIncentive, Slab } from './incentive.service';
import { resolvePeriod, pct1 } from './target-def.service';

/* ============================ INCENTIVE SLAB RESOLVER ============================ */

const SLABS: Slab[] = [
  { min_pct: 0, max_pct: 49.99, tier: 'critical', label: 'Critical', amount_minor: 0 },
  { min_pct: 50, max_pct: 69.99, tier: 'below', label: 'Below Target', amount_minor: 0 },
  { min_pct: 70, max_pct: 79.99, tier: 'near', label: 'Near Target', amount_minor: 0 },
  { min_pct: 80, max_pct: 89.99, tier: 'good', label: 'Good', amount_minor: 200000 },
  { min_pct: 90, max_pct: 99.99, tier: 'strong', label: 'Strong', amount_minor: 400000 },
  { min_pct: 100, max_pct: 109.99, tier: 'achieved', label: 'Target Achieved', amount_minor: 700000 },
  { min_pct: 110, max_pct: 124.99, tier: 'excellent', label: 'Excellent', amount_minor: 1000000 },
  { min_pct: 125, max_pct: null, tier: 'exceptional', label: 'Exceptional', amount_minor: 1500000 },
];

describe('resolveIncentive — achievement % → earned slab & amount, across every band', () => {
  it('pays 0 below the first paying band', () => {
    expect(resolveIncentive(SLABS, 0).amount_minor).toBe(0);
    expect(resolveIncentive(SLABS, 49.99).slab?.tier).toBe('critical');
    expect(resolveIncentive(SLABS, 55).slab?.tier).toBe('below');
    expect(resolveIncentive(SLABS, 79.99).amount_minor).toBe(0); // Near Target still ₹0
  });
  it('pays the band the % lands in', () => {
    expect(resolveIncentive(SLABS, 85).amount_minor).toBe(200000);
    expect(resolveIncentive(SLABS, 95).amount_minor).toBe(400000);
    expect(resolveIncentive(SLABS, 105).amount_minor).toBe(700000);
    expect(resolveIncentive(SLABS, 118).amount_minor).toBe(1000000);
    expect(resolveIncentive(SLABS, 130).amount_minor).toBe(1500000);
  });
  it('resolves EXACT boundary values to the band that STARTS there (min_pct inclusive)', () => {
    expect(resolveIncentive(SLABS, 80).slab?.tier).toBe('good');
    expect(resolveIncentive(SLABS, 90).slab?.tier).toBe('strong');
    expect(resolveIncentive(SLABS, 100).slab?.tier).toBe('achieved');
    expect(resolveIncentive(SLABS, 110).slab?.tier).toBe('excellent');
    expect(resolveIncentive(SLABS, 125).slab?.tier).toBe('exceptional');
  });
  it('handles a decimal that falls between printed ranges deterministically', () => {
    expect(resolveIncentive(SLABS, 69.5).slab?.tier).toBe('below');
    expect(resolveIncentive(SLABS, 99.9).slab?.tier).toBe('strong');
  });
  it('the top band is open-ended (125%+ has no ceiling)', () => {
    expect(resolveIncentive(SLABS, 500).amount_minor).toBe(1500000);
  });
  it('below the lowest min_pct there is no slab and 0 is earned', () => {
    const gapped: Slab[] = [{ min_pct: 50, max_pct: null, tier: 'good', label: 'x', amount_minor: 100 }];
    expect(resolveIncentive(gapped, 10).slab).toBeNull();
    expect(resolveIncentive(gapped, 10).amount_minor).toBe(0);
  });
  it('is order-independent (unsorted slabs resolve the same)', () => {
    const shuffled = [...SLABS].reverse();
    expect(resolveIncentive(shuffled, 105).amount_minor).toBe(700000);
  });
});

/* ============================== PERIOD RESOLUTION ============================== */

describe('resolvePeriod — preset → half-open [start, end) span', () => {
  it('monthly', () => {
    expect(resolvePeriod('monthly', { anchor: '2026-08-15' })).toEqual({ start: '2026-08-01', end: '2026-09-01' });
    expect(resolvePeriod('monthly', { anchor: '2026-12-31' })).toEqual({ start: '2026-12-01', end: '2027-01-01' });
  });
  it('quarterly (Q3 for August)', () => {
    expect(resolvePeriod('quarterly', { anchor: '2026-08-15' })).toEqual({ start: '2026-07-01', end: '2026-10-01' });
    expect(resolvePeriod('quarterly', { anchor: '2026-11-01' })).toEqual({ start: '2026-10-01', end: '2027-01-01' });
  });
  it('half-yearly (H2 for August)', () => {
    expect(resolvePeriod('half_yearly', { anchor: '2026-08-15' })).toEqual({ start: '2026-07-01', end: '2027-01-01' });
    expect(resolvePeriod('half_yearly', { anchor: '2026-03-15' })).toEqual({ start: '2026-01-01', end: '2026-07-01' });
  });
  it('yearly', () => {
    expect(resolvePeriod('yearly', { anchor: '2026-08-15' })).toEqual({ start: '2026-01-01', end: '2027-01-01' });
  });
  it('custom uses the given span and rejects an inverted one', () => {
    expect(resolvePeriod('custom', { start: '2026-01-01', end: '2026-02-01' })).toEqual({ start: '2026-01-01', end: '2026-02-01' });
    expect(() => resolvePeriod('custom', { start: '2026-02-01', end: '2026-01-01' })).toThrow(/end after it starts/);
    expect(() => resolvePeriod('custom', {})).toThrow(/start and an end/);
  });
});

describe('pct1 — one-decimal achievement %, never Infinity', () => {
  it('rounds to one decimal and treats a 0 target as 0%', () => {
    expect(pct1(5, 10)).toBe(50);
    expect(pct1(1, 3)).toBe(33.3);
    expect(pct1(13, 10)).toBe(130);
    expect(pct1(5, 0)).toBe(0);
  });
});
