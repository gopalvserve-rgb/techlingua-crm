/**
 * AUTO FILTERS (client, Nov 2026 — "filters in all modules are missing"). A TableCard on one of
 * the screens below gets a filter bar built from its own columns: a search across every column,
 * a dropdown for each column with a short list of values (Status, Type, Branch…) and a date
 * range on the first date column. Screens with their own filters are not listed here, so no
 * screen ends up with two filter bars.
 */
import { isValidElement, ReactNode, useMemo, useState } from 'react';
import { Ic } from './icons';
import type { Cell } from './renderer';

export const AUTO_FILTER_SCREENS = new Set([
  'leads/scoring', 'leads/sla', 'leads/fields',
  'perf/quotes', 'perf/targets',
  'engage/wabot', 'engage/wabulk', 'engage/journeys', 'engage/templates', 'engage/smstpl', 'engage/notifevents',
  'finance/discounts', 'calls/recordings',
  'analytics/standard', 'analytics/forecasting',
  'work/announce', 'hr/leaves', 'hr/payroll',
  'admin/roles', 'admin/workflow', 'admin/integrations', 'admin/api', 'admin/templates',
  'fran/franchises', 'fran/royaltyPlans', 'fran/perf',
]);

const nodeText = (n: ReactNode): string => {
  if (n == null || typeof n === 'boolean') return '';
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(nodeText).join(' ');
  if (isValidElement(n)) return nodeText((n.props as { children?: ReactNode }).children);
  return '';
};

export function cellText(c: Cell): string {
  if (c == null) return '';
  if (typeof c === 'string' || typeof c === 'number') return String(c);
  if ('b' in c) return c.b[0];
  if ('mono' in c) return c.mono;
  return nodeText(c.node);
}

/** A cell's date as yyyy-mm-dd, or '' — the CRM shows dates as "03 Nov 2026" or ISO. */
export function cellDay(c: Cell): string {
  const t = cellText(c).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const m = /^(\d{1,2}) ([A-Za-z]{3}),? (\d{4})/.exec(t);
  if (!m) return '';
  const d = new Date(`${m[2]} ${m[1]}, ${m[3]}`);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const BLANK = new Set(['', '—', '-']);
const MAX_OPTIONS = 15;
/** Columns worth a dropdown even when only one value exists yet. */
const ALWAYS = /status|type|branch|vertical|channel|category|stage|trigger/i;
const NUMERIC = /^[-₹\d,.\s%]+$/;
/** Names, amounts and counts: every row differs, so a dropdown only repeats the table. */
const NEVER = /when|name|title|code|#|lead|employee|student|variables|revenue|collection|amount|fee|cost|points|gross|basic|hra|allowance|tds|tax|phone|email|key|url/i;
/** Date columns, recognised by name while the list has no dates in it yet. */
const DATE_COL = /date|validity|created|when|^from$|^to$/i;

export function useAutoFilter(cols: string[], rows: Cell[][]) {
  const on = AUTO_FILTER_SCREENS.has(window.location.pathname.replace(/^\/m\//, ''));
  const [q, setQ] = useState('');
  const [picks, setPicks] = useState<Record<number, string>>({});
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const dropdowns = useMemo(() => {
    if (!on) return [];
    return cols.flatMap((name, ci) => {
      if (!name.trim() || /^actions?$/i.test(name.trim()) || NEVER.test(name)) return [];
      const vals = [...new Set(rows.map((r) => cellText(r[ci]).trim()).filter((v) => !BLANK.has(v)))];
      if (!vals.length || vals.length > MAX_OPTIONS || vals.every((v) => NUMERIC.test(v) || !!cellDay(v))) return [];
      if (vals.length < 2 && !ALWAYS.test(name)) return [];
      // a free-text column has nearly one value per row: only short lists help as a dropdown
      if (rows.length > 6 && vals.length > rows.length * 0.7 && !ALWAYS.test(name)) return [];
      return [{ ci, name, vals: vals.sort((a, b) => a.localeCompare(b)) }];
    });
  }, [on, cols, rows]);

  const dateCol = useMemo(() => {
    if (!on) return -1;
    return cols.findIndex((name, ci) => {
      const vals = rows.map((r) => cellText(r[ci]).trim()).filter((v) => !BLANK.has(v));
      return vals.length ? vals.every((v) => !!cellDay(v)) : DATE_COL.test(name);
    });
  }, [on, cols, rows]);

  const ql = q.trim().toLowerCase();
  const active = !!ql || !!from || !!to || Object.values(picks).some(Boolean);
  const passes = (r: Cell[]) => {
    if (ql && !r.some((c) => cellText(c).toLowerCase().includes(ql))) return false;
    for (const [ci, v] of Object.entries(picks)) if (v && cellText(r[Number(ci)]).trim() !== v) return false;
    if ((from || to) && dateCol >= 0) {
      const d = cellDay(r[dateCol]);
      if (!d || (from && d < from) || (to && d > to)) return false;
    }
    return true;
  };
  const clear = () => { setQ(''); setPicks({}); setFrom(''); setTo(''); };

  const bar = on ? (
    <div className="filters auto-filters" data-testid="auto-filters">
      <label className="fchip"><Ic k="search" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search this list" />
      </label>
      {dropdowns.map((d) => (
        <select key={d.ci} className="ainp" aria-label={`Filter by ${d.name}`} value={picks[d.ci] ?? ''}
          onChange={(e) => setPicks((p) => ({ ...p, [d.ci]: e.target.value }))}>
          <option value="">All {d.name}</option>
          {d.vals.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      ))}
      {dateCol >= 0 && (
        <span className="auto-dates">
          <span>{cols[dateCol]}</span>
          <input type="date" className="ainp" aria-label="From date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <input type="date" className="ainp" aria-label="To date" value={to} onChange={(e) => setTo(e.target.value)} />
        </span>
      )}
      {active && <button type="button" className="btn" onClick={clear}><Ic k="x" />Clear</button>}
    </div>
  ) : null;

  return { bar, active: on && active, passes };
}
