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


describe('preset math — IST (Asia/Kolkata) calendar days, independent of browser TZ', () => {
  // A fixed instant: 15 Jul 2026 04:00 UTC = 09:30 IST → the IST day is the 15th (a Wednesday).
  const NOW = new Date('2026-07-15T04:00:00Z');

  it('isoDay returns the IST day of an instant (not the browser-local / UTC day)', () => {
    // The boundary case from the brief: 30 Jul 21:00 UTC = 31 Jul 02:30 IST → "today" is 31 Jul.
    expect(isoDay(new Date('2026-07-30T21:00:00Z'))).toBe('2026-07-31');
    // 15 Jul 18:00 UTC = 23:30 IST — still the 15th in IST.
    expect(isoDay(new Date('2026-07-15T18:00:00Z'))).toBe('2026-07-15');
  });

  it('Today = [today, today] in IST', () => {
    expect(presetRange('today', NOW)).toEqual({ from: '2026-07-15', to: '2026-07-15' });
  });

  it('Today at the UTC/IST boundary: 30 Jul 21:00 UTC is 31 Jul in IST', () => {
    expect(presetRange('today', new Date('2026-07-30T21:00:00Z'))).toEqual({ from: '2026-07-31', to: '2026-07-31' });
  });

  it('Yesterday = [yesterday, yesterday] in IST', () => {
    expect(presetRange('yesterday', NOW)).toEqual({ from: '2026-07-14', to: '2026-07-14' });
  });

  it('This Week = [Monday of this IST week, today] (WEEK_START = Monday, India convention)', () => {
    // 2026-07-15 is a Wednesday; the Monday of that week is 2026-07-13. A MID-WEEK "This Week"
    // must return the whole running week to date, not collapse (the client-reported bug was the
    // old Sunday-start turning "This Week" into "Today" every Sunday).
    expect(presetRange('week', NOW)).toEqual({ from: '2026-07-13', to: '2026-07-15' });
  });

  it('This Week on a Sunday returns the full Mon..Sun week, not just that day', () => {
    // 2026-07-19 is a Sunday; its Monday is 2026-07-13 → the week is [13th, 19th], NOT [19,19].
    expect(presetRange('week', new Date('2026-07-19T06:00:00Z'))).toEqual({ from: '2026-07-13', to: '2026-07-19' });
  });

  it('This Month = [1st of month, today] in IST', () => {
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
    // The control emits the IST "today" (via presetRange), regardless of the browser timezone.
    expect(onChange).toHaveBeenCalledWith(presetRange('today'));
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
