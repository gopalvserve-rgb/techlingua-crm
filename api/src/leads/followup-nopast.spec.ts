import { BadRequestException } from '@nestjs/common';
import { assertNotPastSchedule } from './followups.service';

/**
 * UAT-R2 #12 — a task / follow-up "Due Date" may not be back-dated (today or later only).
 * The client-side input `min` blocks it in the picker; this is the server backstop that
 * refuses a past date whatever the client sends. Mirrors the walk-in Date-of-Visit guard.
 */
const iso = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

describe('assertNotPastSchedule (#12 — no back-dated due dates)', () => {
  it('accepts today', () => {
    expect(() => assertNotPastSchedule(iso(new Date()))).not.toThrow();
  });

  it('accepts a future date', () => {
    const future = new Date(); future.setDate(future.getDate() + 7);
    expect(() => assertNotPastSchedule(iso(future))).not.toThrow();
  });

  it('accepts an earlier time on the SAME day (today counts, only past DAYS are blocked)', () => {
    const earlierToday = new Date(); earlierToday.setHours(0, 1, 0, 0);
    expect(() => assertNotPastSchedule(iso(earlierToday))).not.toThrow();
  });

  it('REJECTS a past day with a 400 the client can show', () => {
    const past = new Date(); past.setDate(past.getDate() - 1);
    expect(() => assertNotPastSchedule(iso(past))).toThrow(BadRequestException);
    try { assertNotPastSchedule(iso(past)); } catch (e: any) {
      expect(e.message).toContain('cannot be in the past');
    }
  });

  it('rejects a garbage date', () => {
    expect(() => assertNotPastSchedule('not-a-date')).toThrow(BadRequestException);
  });

  it('passes an empty / undefined value (nothing to check)', () => {
    expect(() => assertNotPastSchedule('')).not.toThrow();
    expect(() => assertNotPastSchedule(null)).not.toThrow();
    expect(() => assertNotPastSchedule(undefined)).not.toThrow();
  });
});
