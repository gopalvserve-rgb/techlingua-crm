/**
 * SHARED DATE-RANGE CONTROL (Aug 2026, client) — one control, used EVERYWHERE data is listed
 * (Leads, Dashboard/Quick Stats, Reports, Walk-ins, Follow-ups, Enrolments, Fee receipts,
 * Audit log, Integration/Error logs). The client asked for the SAME picker on every screen:
 * Today · Yesterday · This Week · This Month · Custom, plus an "All time" (clear) option.
 *
 * ONE COMPUTATION. Every screen resolves a preset through `presetRange()` here, so "This Week"
 * means exactly the same span on the dashboard as it does on the Leads list. This generalises the
 * Quick Stats preset logic that used to live (privately) in dyn.tsx.
 *
 * ONE APP TIMEZONE — Asia/Kolkata (IST). The window is computed in the APP timezone, NOT the
 * browser's local day, so a user in ANY browser timezone gets the SAME IST days — and, crucially,
 * the SAME days the server buckets by (the pg pool runs in APP_TZ too; see api date.util.ts). This
 * closes the old off-by-one where the browser computed "Today" in local days while the server
 * bucketed created_at by UTC. APP_TZ here is the single client-side source of truth (mirrors the
 * server constant); a per-org timezone setting is a later enhancement.
 *
 * EMITS { from, to } as YYYY-MM-DD — exactly the shape the list + API filters already understand
 * (created_from/created_to and equivalents). An undefined/empty bound = unbounded ("All time").
 */
import { Ic } from './icons';

const pad = (n: number) => String(n).padStart(2, '0');

/** The ONE app timezone, mirrored from the server (api/src/common/date.util.ts APP_TZ). */
export const APP_TZ = 'Asia/Kolkata';

/**
 * WEEK START — the day "This Week" begins on, mirrored app-wide (client + Calendar grid).
 * India conventionally treats MONDAY as the first day of the week, so "This Week" runs
 * Monday 00:00 → today (a mid-week Wednesday returns Mon..Wed; a Sunday returns the full
 * Mon..Sun week, not just that one day — the old Sunday-start collapsed "This Week" to
 * "Today" on Sundays, which the client reported as broken). 0 = Sunday, 1 = Monday. Change
 * this ONE constant (and its server mirror, if a week-bucketed report is ever added) to
 * switch the whole app's week-start; it is the single source of truth, like APP_TZ.
 */
export const WEEK_START = 1; // Monday

/** The {y,m,day} of an instant as seen on the wall clock in APP_TZ (IST). */
function tzYMD(d: Date): { y: number; m: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const val = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: val('year'), m: val('month'), day: val('day') };
}

/** YYYY-MM-DD of an instant IN THE APP TIMEZONE (IST) — NOT the browser-local or UTC day. */
export const isoDay = (d: Date = new Date()) => {
  const { y, m, day } = tzYMD(d);
  return `${y}-${pad(m)}-${pad(day)}`;
};

/**
 * DD-MM-YYYY of a value AS SEEN IN IST — the app's India date convention, safe for BOTH plain
 * DATE strings ('YYYY-MM-DD') and full timestamps ('…Z'). A naive slice(0,10) prints the UTC
 * calendar date for a timestamp (OBS-3: a transfer recorded at 02:46 IST showed the prior UTC
 * day); routing through the app timezone fixes that while leaving date-only values unchanged.
 */
export const fmtDMYIST = (v?: string | null): string => {
  if (v == null || v === '') return '—';
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) {
    const s = String(v).slice(0, 10); const [y, m, day] = s.split('-');
    return y && m && day ? `${day}-${m}-${y}` : String(v);
  }
  const { y, m, day } = tzYMD(d);
  return `${pad(day)}-${pad(m)}-${y}`;
};

/**
 * DD-MM-YYYY HH:mm of a TIMESTAMP as seen in IST — the app's India date+time convention, for
 * created/updated/enrolled/status-changed/received timestamps (client: show date AND time). Like
 * `fmtDMYIST` it routes through the app timezone so the wall-clock time is IST in ANY browser tz.
 * A value with NO time component (a plain 'YYYY-MM-DD' date — DOB, due date) has no meaningful
 * clock, so it degrades to date-only. Unparseable input also falls back to the date-only render.
 */
export const fmtDateTimeIST = (v?: string | null): string => {
  if (v == null || v === '') return '—';
  const s = String(v);
  // A bare date ('YYYY-MM-DD', no time) carries no clock — show date only, never 00:00.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return fmtDMYIST(v);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return fmtDMYIST(v);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: APP_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const val = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${fmtDMYIST(v)} ${val('hour')}:${val('minute')}`;
};

export interface DateRangeValue { from?: string; to?: string }

export type PresetKey = 'all' | 'today' | 'yesterday' | 'week' | 'month' | 'custom';

/** The five presets the client asked for, plus "All time". `custom` is implicit (the inputs). */
export const DR_PRESETS: Array<{ key: Exclude<PresetKey, 'custom'>; label: string }> = [
  { key: 'all', label: 'All time' },
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: 'This Week' },
  { key: 'month', label: 'This Month' },
];

/**
 * A preset -> { from, to } in LOCAL calendar days. PURE — the clock is an argument, so the
 * unit tests are stable and never flake at midnight. "This Week" starts on WEEK_START (Monday by
 * default — India convention); "This Month" runs from the 1st to today.
 */
export function presetRange(key: PresetKey, now: Date = new Date()): DateRangeValue {
  // Take the IST wall-clock date of `now`, then do all calendar math on a UTC-ANCHORED date so it
  // is independent of the BROWSER's timezone — a user in any tz gets IST days, matching the server.
  const { y, m, day } = tzYMD(now);
  const today = new Date(Date.UTC(y, m - 1, day));
  const fmt = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  switch (key) {
    case 'today':
      return { from: fmt(today), to: fmt(today) };
    case 'yesterday': {
      const yd = new Date(today); yd.setUTCDate(today.getUTCDate() - 1);
      return { from: fmt(yd), to: fmt(yd) };
    }
    case 'week': {
      // Wind back to the most recent WEEK_START (Monday by default). `getUTCDay()` is
      // 0=Sun..6=Sat; `back` is how many days we are past this week's start. A mid-week
      // day returns [weekStart, today]; on the week-start day itself back=0 (= [today,today]);
      // and, crucially, a Sunday returns the FULL Mon..Sun week instead of collapsing to Today.
      const s = new Date(today);
      const back = (today.getUTCDay() - WEEK_START + 7) % 7;
      s.setUTCDate(today.getUTCDate() - back);
      return { from: fmt(s), to: fmt(today) };
    }
    case 'month': {
      const s = new Date(Date.UTC(y, m - 1, 1));
      return { from: fmt(s), to: fmt(today) };
    }
    case 'all':
    case 'custom':
    default:
      return {};
  }
}

/** Which preset does a value correspond to (for highlighting the active chip)? */
export function matchPreset(v: DateRangeValue, now: Date = new Date()): PresetKey {
  const from = v.from || undefined;
  const to = v.to || undefined;
  if (!from && !to) return 'all';
  for (const { key } of DR_PRESETS) {
    if (key === 'all') continue;
    const r = presetRange(key, now);
    if ((r.from || undefined) === from && (r.to || undefined) === to) return key;
  }
  return 'custom';
}

/**
 * THE control. Controlled component: it takes the current `{from,to}` and calls `onChange` with a
 * new one. Same markup and classes on every screen (`.daterange` + the shared `.fchip` chips),
 * so it looks and behaves identically wherever it is dropped.
 *
 * `allowAllTime` — hide the "All time" chip on screens that are inherently range-scoped (Quick
 * Stats always shows some range). `defaultToday` is not a prop: each SCREEN owns its own default
 * (see docs/dev/24), because "don't hide existing data by defaulting to Today" is a per-screen call.
 */
export function DateRange({
  value, onChange, allowAllTime = true, idPrefix = 'dr', style,
}: {
  value: DateRangeValue;
  onChange: (v: DateRangeValue) => void;
  allowAllTime?: boolean;
  idPrefix?: string;
  style?: React.CSSProperties;
}) {
  const active = matchPreset(value);
  const pick = (key: PresetKey) => onChange(presetRange(key));
  const setCustom = (k: 'from' | 'to', val: string) => onChange({ ...value, [k]: val || undefined });

  return (
    <div className="daterange" role="group" aria-label="Date range" style={style}>
      {DR_PRESETS.filter((p) => allowAllTime || p.key !== 'all').map((p) => (
        <button
          key={p.key} type="button"
          className={`fchip${active === p.key ? ' on' : ''}`}
          aria-pressed={active === p.key}
          onClick={() => pick(p.key)}
        >{p.label}</button>
      ))}
      <span className={`fchip dr-custom${active === 'custom' ? ' on' : ''}`}>
        <Ic k="cal" />
        {/* the visible <label> IS the accessible name (no aria-label) — so getByLabelText('From')
            keeps working and screen readers read the on-screen text. */}
        <label htmlFor={`${idPrefix}-from`} className="dr-lbl">From</label>
        <input
          id={`${idPrefix}-from`} type="date" className="ainp dr-inp"
          value={value.from ?? ''} onChange={(e) => setCustom('from', e.target.value)}
        />
        <label htmlFor={`${idPrefix}-to`} className="dr-lbl">To</label>
        <input
          id={`${idPrefix}-to`} type="date" className="ainp dr-inp"
          value={value.to ?? ''} onChange={(e) => setCustom('to', e.target.value)}
        />
      </span>
    </div>
  );
}
