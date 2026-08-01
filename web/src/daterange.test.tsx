/**
 * SHARED DATE-RANGE CONTROL — the client's ask: the SAME picker (Today · Yesterday · This Week ·
 * This Month · Custom, plus All time) on every screen that lists data.
 *
 * These tests pin the two things that must not drift:
 *   1. the preset -> {from,to} MATH is correct for LOCAL calendar days (Today/Yesterday/Week/Month);
 *   2. the control renders the five presets and EMITS the right range (preset, custom, All time).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { DateRange, presetRange, matchPreset, isoDay, DR_PRESETS } from './daterange';

beforeEach(() => cleanup());

const pad = (n: number) => String(n).padStart(2, '0');
const local = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

describe('preset math — LOCAL calendar days', () => {
  // A fixed clock: Wed 15 Jul 2026, 09:30 local. getDay() for 2026-07-15 is Wednesday (3).
  const NOW = new Date(2026, 6, 15, 9, 30, 0);

  it('isoDay uses local parts (not toISOString) — no midnight off-by-one', () => {
    // 23:30 local on the 15th must still be "the 15th", where toISOString would roll to the 16th (UTC+).
    expect(isoDay(new Date(2026, 6, 15, 23, 30))).toBe('2026-07-15');
  });

  it('Today = [today, today]', () => {
    expect(presetRange('today', NOW)).toEqual({ from: '2026-07-15', to: '2026-07-15' });
  });

  it('Yesterday = [yesterday, yesterday]', () => {
    expect(presetRange('yesterday', NOW)).toEqual({ from: '2026-07-14', to: '2026-07-14' });
  });

  it('This Week = [Sunday of this week, today]', () => {
    // 2026-07-15 is a Wednesday; the Sunday before is 2026-07-12.
    expect(presetRange('week', NOW)).toEqual({ from: '2026-07-12', to: '2026-07-15' });
  });

  it('This Month = [1st of month, today]', () => {
    expect(presetRange('month', NOW)).toEqual({ from: '2026-07-01', to: '2026-07-15' });
  });

  it('All time = {} (unbounded)', () => {
    expect(presetRange('all', NOW)).toEqual({});
  });

  it('matchPreset round-trips each preset and detects custom / all', () => {
    expect(matchPreset({}, NOW)).toBe('all');
    expect(matchPreset(presetRange('today', NOW), NOW)).toBe('today');
    expect(matchPreset(presetRange('yesterday', NOW), NOW)).toBe('yesterday');
    expect(matchPreset(presetRange('week', NOW), NOW)).toBe('week');
    expect(matchPreset(presetRange('month', NOW), NOW)).toBe('month');
    expect(matchPreset({ from: '2020-01-01', to: '2020-02-02' }, NOW)).toBe('custom');
  });
});

describe('the control — renders 5 presets and emits the right range', () => {
  function Harness({ onChange }: { onChange: (v: any) => void }) {
    return <DateRange value={{}} onChange={onChange} />;
  }

  it('renders All time + the four dated presets', () => {
    render(<DateRange value={{}} onChange={() => undefined} />);
    for (const label of ['All time', 'Today', 'Yesterday', 'This Week', 'This Month']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    // and the DR_PRESETS list itself carries the five keys
    expect(DR_PRESETS.map((p) => p.key)).toEqual(['all', 'today', 'yesterday', 'week', 'month']);
  });

  it('clicking Today emits today..today', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByText('Today'));
    const t = local(new Date());
    expect(onChange).toHaveBeenCalledWith({ from: t, to: t });
  });

  it('typing a custom From/To emits it verbatim', () => {
    const onChange = vi.fn();
    render(<DateRange value={{ from: '2026-01-01' }} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-03-31' } });
    expect(onChange).toHaveBeenCalledWith({ from: '2026-01-01', to: '2026-03-31' });
  });

  it('All time emits {} (clears both bounds)', () => {
    const onChange = vi.fn();
    render(<DateRange value={{ from: '2026-01-01', to: '2026-03-31' }} onChange={onChange} />);
    fireEvent.click(screen.getByText('All time'));
    expect(onChange).toHaveBeenCalledWith({});
  });

  it('allowAllTime=false hides the All time chip (Quick Stats is always range-scoped)', () => {
    render(<DateRange value={presetRange('month')} onChange={() => undefined} allowAllTime={false} />);
    expect(screen.queryByText('All time')).toBeNull();
    expect(screen.getByText('This Month')).toBeTruthy();
  });
});
