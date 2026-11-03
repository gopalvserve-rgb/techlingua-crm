import { receivedAtOf } from './fee.service';

/**
 * Client 31 Oct (8): a payment recorded at 05:14 IST on 1 Nov with Received on = 01-11-2026 was
 * refused as "in the future". A bare day is an Indian calendar day.
 */
describe('receivedAtOf — the received date of a payment', () => {
  const realNow = Date.now;
  afterEach(() => { Date.now = realNow; });
  const at = (iso: string) => { Date.now = () => new Date(iso).getTime(); };

  it('accepts today early in the morning IST (before 05:30, when UTC is still yesterday)', () => {
    at('2026-10-31T23:44:00Z');                       // 1 Nov 05:14 IST
    expect(() => receivedAtOf('2026-11-01', new Date())).not.toThrow();
  });

  it('refuses tomorrow (IST)', () => {
    at('2026-10-31T23:44:00Z');
    expect(() => receivedAtOf('2026-11-02', new Date())).toThrow(/cannot be received in the future/);
  });

  it('places an earlier day at noon IST, so it stays that day in every report', () => {
    at('2026-11-04T10:00:00Z');
    expect(receivedAtOf('2026-11-01', new Date()).toISOString()).toBe('2026-11-01T06:30:00.000Z');
  });

  it('keeps a full timestamp, and still refuses one in the future', () => {
    at('2026-11-04T10:00:00Z');
    expect(receivedAtOf('2026-11-03T09:00:00Z', new Date()).toISOString()).toBe('2026-11-03T09:00:00.000Z');
    expect(() => receivedAtOf('2026-11-05T09:00:00Z', new Date())).toThrow(/future/);
  });

  it('falls back when no date is sent, and refuses rubbish', () => {
    const fb = new Date('2026-01-01T00:00:00Z');
    expect(receivedAtOf(undefined, fb)).toBe(fb);
    expect(() => receivedAtOf('not a date', fb)).toThrow(/not a date/);
  });
});
