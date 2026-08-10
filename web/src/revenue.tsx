/**
 * REVENUE + COLLECTION REPORTS (Phase 3 Batch 4).
 *
 *  RevenueScreen         — the two views of revenue: COLLECTION (money in, net of approved
 *                          refunds) and ACCRUAL (fee billed/earned = enrolment net fee
 *                          recognised). Period + branch/vertical/course/counsellor/mode.
 *  CollectionReportsScreen — daily / monthly / branch / vertical / course / counsellor /
 *                          payment-mode collections with totals, exportable to Excel / CSV /
 *                          PDF (values not ids) and a Tally-importable XML export.
 *
 * India-first: ₹ (fmtINR), IST, DateRange. FULL list treatment on the report list.
 */
import { useState } from 'react';
import { Ic } from './icons';
import { Cell, Kpis, TableCard } from './renderer';
import { useFetch, useRef_ } from './refdata';
import { useAuth } from './auth';
import { useScope } from './scope';
import { FilterMulti } from './dyn';
import { DateRange, DateRangeValue } from './daterange';
import { fmtINR } from './money';
import { ListActions, downloadObjectsCsv } from './listtools';

const open = (path: string) => { window.open(`/api${path}`, '_blank', 'noopener'); };
const asOpts = (vals: Array<[string, string]>) => vals.map(([id, name]) => ({ id, name }));

function scopeQs(range: DateRangeValue, branches: number[], verticals: number[]): URLSearchParams {
  const qs = new URLSearchParams();
  if (range.from) qs.set('from', range.from);
  if (range.to) qs.set('to', range.to);
  if (branches.length) qs.set('branch_ids', branches.join(','));
  if (verticals.length) qs.set('vertical_ids', verticals.join(','));
  return qs;
}

/* ==================================================================== */
/*  REVENUE — collection vs accrual                                     */
/* ==================================================================== */

const COLLECTION_DIMS = asOpts([['day', 'Day'], ['month', 'Month'], ['branch', 'Branch'], ['vertical', 'Vertical'], ['course', 'Course'], ['counsellor', 'Counsellor'], ['mode', 'Payment mode']]);
const ACCRUAL_DIMS = asOpts([['day', 'Day'], ['month', 'Month'], ['branch', 'Branch'], ['vertical', 'Vertical'], ['course', 'Course'], ['counsellor', 'Counsellor']]);

export function RevenueScreen() {
  const ref = useRef_();
  const { scope: gScope } = useScope();
  const [tick, setTick] = useState(0);
  const [view, setView] = useState<'collection' | 'accrual'>('collection');
  const [groupBy, setGroupBy] = useState('vertical');
  const [range, setRange] = useState<DateRangeValue>({});
  const [fBranches, setFBranches] = useState<number[]>(gScope.branches ?? []);
  const [fVerticals, setFVerticals] = useState<number[]>(gScope.verticals ?? []);
  const after = () => setTick((t) => t + 1);

  const dims = view === 'accrual' ? ACCRUAL_DIMS : COLLECTION_DIMS;
  const gb = dims.some((d) => d.id === groupBy) ? groupBy : 'vertical';
  const base = scopeQs(range, fBranches, fVerticals);
  const ov = useFetch<any>(`/revenue/overview?${base.toString()}`, [`ov~${base.toString()}~${tick}`]);
  const detQs = new URLSearchParams(base); detQs.set('view', view); detQs.set('group_by', gb);
  const det = useFetch<any>(`/revenue?${detQs.toString()}`, [`det~${detQs.toString()}~${tick}`]);
  const o = ov.data;
  const rows: any[] = det.data?.rows ?? [];

  return (
    <>
      <Kpis items={[
        { lab: 'Gross collected', val: o ? fmtINR(o.collection.totals.gross_minor) : '—', ic: 'rupee' },
        { lab: 'Refunds', val: o ? fmtINR(o.collection.totals.refunds_minor) : '—', ic: 'bolt' },
        { lab: 'Net collected', val: o ? fmtINR(o.collection.totals.net_minor) : '—', ic: 'check' },
        { lab: 'Accrued (billed)', val: o ? fmtINR(o.accrual.totals.accrual_minor) : '—', ic: 'list' },
      ]} />
      <div className="filters" style={{ marginBottom: 12 }}>
        <div className="seg">
          <button className={`seg-btn ${view === 'collection' ? 'on' : ''}`} onClick={() => { setView('collection'); }}>Collection</button>
          <button className={`seg-btn ${view === 'accrual' ? 'on' : ''}`} onClick={() => { setView('accrual'); }}>Accrual</button>
        </div>
        <label className="fchip"><Ic k="list" />
          <select value={gb} onChange={(e) => setGroupBy(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', font: 'inherit' }}>
            {dims.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
        <FilterMulti label="Branch" icon="branch" value={fBranches} options={(ref.branches ?? []) as any} onChange={setFBranches} />
        <FilterMulti label="Vertical" icon="ops" value={fVerticals} options={(ref.verticals ?? []) as any} onChange={setFVerticals} />
        <DateRange value={range} onChange={setRange} idPrefix="rev-dr" />
      </div>
      <TableCard fill title={view === 'collection' ? 'Collection (money received, net of refunds)' : 'Accrual (fee billed / earned)'} icon="rupee"
        more={<ListActions onExport={() => downloadObjectsCsv('revenue.csv', rows.map((r) => (view === 'collection'
          ? { group: r.label, gross: (r.gross_minor / 100).toFixed(2), refunds: (r.refunds_minor / 100).toFixed(2), net: (r.net_minor / 100).toFixed(2), receipts: r.receipts_n }
          : { group: r.label, accrued: (r.accrual_minor / 100).toFixed(2), enrolments: r.enrolments })))} onRefresh={after} />}
        cols={view === 'collection' ? [dims.find((d) => d.id === gb)?.name ?? 'Group', 'Gross', 'Refunds', 'Net collected', 'Receipts'] : [dims.find((d) => d.id === gb)?.name ?? 'Group', 'Accrued', 'Enrolments']}
        empty="No revenue in this period."
        rows={rows.map((r): Cell[] => view === 'collection'
          ? [r.label, { mono: fmtINR(r.gross_minor) }, { mono: fmtINR(r.refunds_minor) }, { mono: fmtINR(r.net_minor) }, String(r.receipts_n)]
          : [r.label, { mono: fmtINR(r.accrual_minor) }, String(r.enrolments)])} />
    </>
  );
}

/* ==================================================================== */
/*  COLLECTION REPORTS + TALLY EXPORT                                   */
/* ==================================================================== */

const REPORT_DIMS = asOpts([['day', 'Daily'], ['month', 'Monthly'], ['branch', 'By branch'], ['vertical', 'By vertical'], ['course', 'By course'], ['counsellor', 'By counsellor'], ['mode', 'By payment mode']]);

export function CollectionReportsScreen() {
  const { can } = useAuth();
  const ref = useRef_();
  const { scope: gScope } = useScope();
  const [tick, setTick] = useState(0);
  const [dimension, setDimension] = useState('day');
  const [range, setRange] = useState<DateRangeValue>({});
  const [fBranches, setFBranches] = useState<number[]>(gScope.branches ?? []);
  const [fVerticals, setFVerticals] = useState<number[]>(gScope.verticals ?? []);
  const after = () => setTick((t) => t + 1);

  const base = scopeQs(range, fBranches, fVerticals);
  const qs = new URLSearchParams(base); qs.set('dimension', dimension);
  const rep = useFetch<any>(`/collection-reports?${qs.toString()}`, [`${qs.toString()}~${tick}`]);
  const rows: any[] = rep.data?.rows ?? [];
  const totals = rep.data?.totals;
  const dimName = REPORT_DIMS.find((d) => d.id === dimension)?.name ?? 'Group';

  const exportFile = (format: string) => { const q = new URLSearchParams(qs); q.set('format', format); open(`/collection-reports/export?${q.toString()}`); };
  const tally = () => open(`/collection-reports/tally?${base.toString()}`);

  return (
    <>
      <div className="page-actions">
        {can('collection_report.export') && <button className="btn ghost" onClick={() => exportFile('xlsx')}><Ic k="export" />Excel</button>}
        {can('collection_report.export') && <button className="btn ghost" onClick={() => exportFile('pdf')}><Ic k="doc" />PDF</button>}
        {can('collection_report.export') && <button className="btn primary" onClick={tally}><Ic k="export" />Tally export (XML)</button>}
      </div>
      <Kpis items={[
        { lab: 'Gross collected', val: totals ? fmtINR(totals.gross_minor) : '—', ic: 'rupee' },
        { lab: 'Refunds', val: totals ? fmtINR(totals.refunds_minor) : '—', ic: 'bolt' },
        { lab: 'Net collected', val: totals ? fmtINR(totals.net_minor) : '—', ic: 'check' },
        { lab: 'Receipts', val: String(totals?.receipts_n ?? 0), ic: 'list' },
      ]} />
      <div className="filters" style={{ marginBottom: 12 }}>
        <label className="fchip"><Ic k="list" />
          <select value={dimension} onChange={(e) => setDimension(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', font: 'inherit' }}>
            {REPORT_DIMS.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
        <FilterMulti label="Branch" icon="branch" value={fBranches} options={(ref.branches ?? []) as any} onChange={setFBranches} />
        <FilterMulti label="Vertical" icon="ops" value={fVerticals} options={(ref.verticals ?? []) as any} onChange={setFVerticals} />
        <DateRange value={range} onChange={setRange} idPrefix="crep-dr" />
      </div>
      <TableCard fill title={`Collection report — ${dimName}`} icon="rupee"
        more={<ListActions onExport={() => downloadObjectsCsv('collection-report.csv', rows.map((r) => ({
          group: r.label, gross: (r.gross_minor / 100).toFixed(2), refunds: (r.refunds_minor / 100).toFixed(2), net: (r.net_minor / 100).toFixed(2), receipts: r.receipts_n,
        })))} onRefresh={after} />}
        cols={[dimName, 'Gross collected', 'Refunds', 'Net collected', 'Receipts']}
        empty="No collections in this period."
        rows={rows.map((r): Cell[] => [
          r.label, { mono: fmtINR(r.gross_minor) }, { mono: fmtINR(r.refunds_minor) }, { mono: fmtINR(r.net_minor) }, String(r.receipts_n),
        ])} />
    </>
  );
}
