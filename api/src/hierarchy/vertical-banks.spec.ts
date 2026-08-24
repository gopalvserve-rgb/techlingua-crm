import { HierarchyService } from './hierarchy.service';

/**
 * dev/132 ITEM B (task #216) — a vertical's MULTIPLE bank accounts normalise + persist with
 * exactly ONE active/required bank. Pure static, so no DB is needed.
 */
describe('HierarchyService.normBanks — multi-bank persistence', () => {
  it('keeps every non-empty row and uppercases IFSC', () => {
    const out = HierarchyService.normBanks([
      { name: 'HDFC', account_no: '111', ifsc: 'hdfc0000123', branch: 'HSR', account_holder: 'TL', active: false },
      { name: 'ICICI', account_no: '222', ifsc: 'icic0000999', active: true },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].ifsc).toBe('HDFC0000123');
    expect(out[1].active).toBe(true);
  });

  it('guarantees exactly one active bank (first flagged wins; extras cleared)', () => {
    const out = HierarchyService.normBanks([
      { name: 'A', account_no: '1', active: true },
      { name: 'B', account_no: '2', active: true },
    ]);
    expect(out.filter((b) => b.active)).toHaveLength(1);
    expect(out[0].active).toBe(true);
    expect(out[1].active).toBe(false);
  });

  it('defaults the first row to active when none flagged, and drops empty rows', () => {
    const out = HierarchyService.normBanks([
      { name: '', account_no: '' },              // dropped
      { name: 'Axis', account_no: '9' },          // kept -> becomes active
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Axis');
    expect(out[0].active).toBe(true);
  });

  it('non-array input -> empty list', () => {
    expect(HierarchyService.normBanks(undefined)).toEqual([]);
    expect(HierarchyService.normBanks('x')).toEqual([]);
  });
});
