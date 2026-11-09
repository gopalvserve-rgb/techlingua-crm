import { describe, it, expect } from 'vitest';
import { cellSortKey, nodeText, textSortKey } from './renderer';

/** client 5 Nov (6) — "sorting option in every module": rich cells sort by what they show. */
describe('sort keys', () => {
  it('a rich node with no explicit sort sorts by its visible text', () => {
    const cell = { node: <div className="cell-u"><span className="nm">Riya Sharma</span><div className="sub">+91 98100 00011</div></div> };
    expect(cellSortKey(cell)).toBe('riya sharma +91 98100 00011');
  });

  it('a component without children sorts by its name/label prop', () => {
    const Avatar = (_: { name: string }) => null;
    expect(nodeText(<span><Avatar name="Aman" /></span>)).toBe('Aman');
  });

  it('an inline select sorts by the chosen option, not every option', () => {
    const sel = <select value="b" onChange={() => undefined}><option value="a">Low</option><option value="b">High</option></select>;
    expect(nodeText(sel)).toBe('High');
  });

  it('IST dates DD-MM-YYYY [HH:mm] sort by time, not by day number', () => {
    const a = textSortKey('05-11-2026 03:05');
    const b = textSortKey('28-10-2026 10:00');
    const c = textSortKey('05-12-2025');
    expect(typeof a).toBe('number');
    expect(Number(b)).toBeLessThan(Number(a));
    expect(Number(c)).toBeLessThan(Number(b));
  });

  it('money sorts by value, including a minus sign and trailing text', () => {
    expect(textSortKey('₹1,23,456.50')).toBe(123456.5);
    expect(textSortKey('− ₹2,000')).toBe(-2000);
    expect(textSortKey('₹2,000 · 3 instalments')).toBe(2000);
  });

  it('a dash or blank sorts last (empty key)', () => {
    expect(textSortKey('—')).toBe('');
    expect(cellSortKey({ node: <span>—</span> })).toBe('');
  });
});
