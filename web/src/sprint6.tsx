/**
 * SPRINT 6 — REPORTS & WORKSPACE. Closes Phase 1.
 *
 * Analytics & Reports › Report Builder · Reports · Activity · TAT · Funnel · Campaign ROI
 *                      · Scheduled Delivery
 * Workspace & Productivity › Team Chat · Notes · Knowledge Base · Announcements
 *
 * Every screen reuses the prototype's existing blocks (card, tbl, add-modal, form-grid,
 * kpi-strip, hbars, funnel) — no new visual language, per the project's design rule.
 *
 * WORKSPACE › TASKS IS NOT IN THIS FILE, deliberately: it is the FOLLOW-UP module
 * (`workTasks` in dyn.tsx renders `/follow-ups`), because the doc says "same fields and
 * statuses as follow-up tasks" and a second task screen with the same fields is the fork
 * that sentence forbids.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, Funnel, Kpis, TableCard } from './renderer';
import { toast, useFetch, useRef_ } from './refdata';
import { UserPicker } from './userpicker';
import { fmtINR } from './money';
import { CONVERSION_LABEL_LEAD_WON } from './metrics';

/* ==================================================================== */
/*  shared                                                               */
/* ==================================================================== */

export interface RptColumn { key: string; label: string; type: string; aggregate?: string | null }
export interface RptEntity {
  key: string; label: string; blurb: string;
  columns: Array<RptColumn & { filterable: boolean; groupable: boolean }>;
  date_fields: Array<{ key: string; label: string }>;
  default_date_field: string; default_columns: string[];
}
export interface RptCatalog {
  entities: RptEntity[];
  operators: Array<{ key: string; label: string; types: string[]; arity: number }>;
  date_presets: Array<{ key: string; label: string }>;
  formats: Array<{ key: string; label: string; note?: string }>;
}
export interface RptConfig {
  columns: string[];
  filters: Array<{ col: string; op: string; value?: string; value2?: string }>;
  group_by: string[];
  sort: Array<{ col: string; dir: 'asc' | 'desc' }>;
  date_field?: string;
  date_preset: string;
  date_from?: string;
  date_to?: string;
}
export interface RunOut {
  columns: RptColumn[]; rows: unknown[][]; row_count: number; grouped: boolean;
  truncated: boolean; entity_label: string;
  scope: { user_id: number; unrestricted: boolean; note: string };
  generated_at: string;
}

const RowBtns = ({ items }: { items: Array<[string, string, () => void]> }) => (
  <div className="rowacts">
    {items.map(([icon, title, fn]) => (
      <button className="icon-btn sm" key={title} title={title}
        onClick={(e) => { e.stopPropagation(); fn(); }}><Ic k={icon} /></button>
    ))}
  </div>
);

const dt = (v: unknown) => (v ? new Date(String(v)).toLocaleString('en-IN', {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
}) : '—');

/** Render one report cell the way its TYPE says. A money column is paise on the wire and
 *  is formatted with `fmtINR` — the same function the Sprint-5 money screens use, so the
 *  rupee grouping is right and the report agrees with the quotation. */
export function fmtCell(v: unknown, type: string): string {
  if (v === null || v === undefined || v === '') return '—';
  switch (type) {
    case 'money': return fmtINR(Number(v));
    case 'bool': return v === true || v === 't' || v === 'true' ? 'Yes' : 'No';
    case 'date': return new Date(String(v)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    case 'datetime': return dt(v);
    default: return String(v);
  }
}

const mins = (m: number | null | undefined) => {
  if (m === null || m === undefined) return '—';
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
};

/** The sentence that says WHOSE data is on screen. The client running a shared report
 *  must be able to see why his total differs from his manager's — otherwise he reports
 *  it as a bug, and he is right to. */
const ScopeNote = ({ note }: { note?: string }) => (note ? (
  <div className="sub" style={{ marginTop: 8, display: 'flex', gap: 6, alignItems: 'center' }}>
    <Ic k="shield" /> {note}
  </div>
) : null);

const PhaseNote = ({ children }: { children: React.ReactNode }) => (
  <div className="notice" style={{ marginBottom: 12 }}><Ic k="bolt" /><div>{children}</div></div>
);

/* ==================================================================== */
/*  THE REPORT GRID — one renderer, every screen                          */
/* ==================================================================== */

export function ReportGrid({ out }: { out: RunOut | null }) {
  if (!out) return null;
  return (
    <>
      <TableCard
        title={`${out.entity_label} · ${out.row_count} row${out.row_count === 1 ? '' : 's'}`}
        cols={out.columns.map((c) => c.label)}
        rows={out.rows.map((r) => out.columns.map((c, i) => (
          c.type === 'money' || c.type === 'number'
            ? { node: <span className="mono">{fmtCell(r[i], c.type)}</span> } as Cell
            : fmtCell(r[i], c.type) as Cell
        )))}
        empty="No rows matched this report."
      />
      {out.truncated ? (
        <div className="notice" style={{ marginTop: 8 }}>
          <Ic k="bolt" />
          <div>Showing the first {out.row_count} rows. Export it to Excel for the whole set.</div>
        </div>
      ) : null}
      <ScopeNote note={out.scope?.note} />
    </>
  );
}

/* ==================================================================== */
/*  EXPORT BUTTONS — queue + poll                                         */
/* ==================================================================== */

/**
 * Every export is queued and polled — even a 12-row one. See export.service.ts: one code
 * path means the client's first 40,000-row export in September runs the code that has
 * been exercised every day since July, instead of a branch nobody has ever taken.
 */
export function ExportButtons({ formats, start, disabled }: {
  formats: RptCatalog['formats'];
  start: (format: string) => Promise<{ id: number }>;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  const go = async (format: string) => {
    setBusy(format);
    try {
      const { id } = await start(format);
      toast(`Preparing your ${format.toUpperCase()}…`);
      // Poll. 40 x 750ms = 30s, which is a long time for a spreadsheet and a real limit
      // rather than a spinner that never stops.
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 750));
        const s = await api.get<any>(`/reports/exports/${id}`);
        if (s.status === 'ready') {
          window.open(`/api/reports/exports/${id}/download`, '_blank', 'noopener');
          toast(`${s.file_name} ready (${s.row_count} rows)`);
          return;
        }
        if (s.status === 'failed') { toast(s.error || 'The export failed.', true); return; }
      }
      toast('Still preparing — it will appear in your recent exports.', true);
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(null); }
  };

  return (
    <div style={{ display: 'flex', gap: 8 }}>
      {formats.map((f) => (
        <button key={f.key} className="btn sm" disabled={disabled || !!busy}
          title={f.note || `Export as ${f.label}`}
          onClick={() => go(f.key)}>
          <Ic k="download" />{busy === f.key ? 'Preparing…' : f.label}
        </button>
      ))}
    </div>
  );
}

/* ==================================================================== */
/*  REPORT BUILDER                                                       */
/* ==================================================================== */

const emptyConfig = (e?: RptEntity): RptConfig => ({
  columns: e?.default_columns ?? [],
  filters: [], group_by: [], sort: [],
  date_field: e?.default_date_field, date_preset: 'this_month',
});

export function ReportBuilder() {
  const { can } = useAuth();
  const cat = useFetch<RptCatalog>('/reports/catalog', []);
  const [entityKey, setEntityKey] = useState('');
  const [cfg, setCfg] = useState<RptConfig>(emptyConfig());
  const [out, setOut] = useState<RunOut | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [savedId, setSavedId] = useState<number | null>(null);

  const entities = cat.data?.entities ?? [];
  const entity = entities.find((e) => e.key === entityKey);

  useEffect(() => {
    if (!entityKey && entities.length) { setEntityKey(entities[0].key); setCfg(emptyConfig(entities[0])); }
  }, [entities.length]);

  const pickEntity = (k: string) => {
    setEntityKey(k);
    // Changing the data source RESETS the columns and filters. Keeping a `stage` filter
    // when the user switches from Leads to Receipts would produce a 400 they cannot read
    // — the column simply does not exist over there.
    setCfg(emptyConfig(entities.find((e) => e.key === k)));
    setOut(null); setSavedId(null);
  };

  const toggleCol = (k: string) => setCfg((c) => ({
    ...c, columns: c.columns.includes(k) ? c.columns.filter((x) => x !== k) : [...c.columns, k],
  }));
  const toggleGroup = (k: string) => setCfg((c) => ({
    ...c, group_by: c.group_by.includes(k) ? c.group_by.filter((x) => x !== k) : [...c.group_by, k],
  }));

  const opsFor = (colKey: string) => {
    const col = entity?.columns.find((c) => c.key === colKey);
    if (!col) return [];
    return (cat.data?.operators ?? []).filter((o) => o.types.includes(col.type));
  };
  const arityOf = (op: string) => cat.data?.operators.find((o) => o.key === op)?.arity ?? 1;

  const run = async () => {
    setErr(''); setBusy(true);
    try {
      const r = await api.post<RunOut>('/reports/preview', { entity: entityKey, config: cfg });
      setOut(r);
    } catch (e) { setErr((e as Error).message); setOut(null); } finally { setBusy(false); }
  };

  const save = async () => {
    if (!name.trim()) { setErr('Give the report a name first.'); return; }
    setErr(''); setSaving(true);
    try {
      const r = await api.post<any>('/reports', { name, entity: entityKey, config: cfg });
      setSavedId(Number(r.id));
      toast(`"${name}" saved — it is now in your Reports list.`);
    } catch (e) { setErr((e as Error).message); } finally { setSaving(false); }
  };

  if (!cat.data) return <div className="empty-note">Loading the report catalog…</div>;
  if (!entities.length) {
    return <div className="empty-note">Your role does not give you access to any reportable data yet.</div>;
  }

  return (
    <>
      <PhaseNote>
        <b>Every report shows only what your own role lets you see.</b> A report you share
        with a counsellor runs in <i>their</i> scope, not yours — they get their rows, you get
        yours, from the same saved report.
      </PhaseNote>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="ch"><h3><Ic k="analytics" />Build a report</h3></div>
        <div className="cb">
          <div className="form-grid">
            <div className="fld">
              <label htmlFor="rb-entity">Data source <span className="star">*</span></label>
              <select id="rb-entity" className="ainp" value={entityKey} onChange={(e) => pickEntity(e.target.value)}>
                {entities.map((e) => <option key={e.key} value={e.key}>{e.label}</option>)}
              </select>
              <div className="hint">{entity?.blurb}</div>
            </div>
            <div className="fld">
              <label htmlFor="rb-datefield">Date field</label>
              <select id="rb-datefield" className="ainp" value={cfg.date_field ?? ''}
                onChange={(e) => setCfg((c) => ({ ...c, date_field: e.target.value }))}>
                {(entity?.date_fields ?? []).map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="rb-preset">Date range</label>
              <select id="rb-preset" className="ainp" value={cfg.date_preset}
                onChange={(e) => setCfg((c) => ({ ...c, date_preset: e.target.value }))}>
                {cat.data.date_presets.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            </div>
            {cfg.date_preset === 'custom' ? (
              <>
                <div className="fld">
                  <label htmlFor="rb-from">From</label>
                  <input id="rb-from" className="ainp" type="date" value={cfg.date_from ?? ''}
                    onChange={(e) => setCfg((c) => ({ ...c, date_from: e.target.value }))} />
                </div>
                <div className="fld">
                  <label htmlFor="rb-to">To</label>
                  <input id="rb-to" className="ainp" type="date" value={cfg.date_to ?? ''}
                    onChange={(e) => setCfg((c) => ({ ...c, date_to: e.target.value }))} />
                  <div className="hint">Inclusive — rows dated on this day are included.</div>
                </div>
              </>
            ) : null}
          </div>

          {/* ---- columns */}
          <div className="fld" style={{ marginTop: 12 }}>
            <label>Columns <span className="star">*</span></label>
            <div className="chips">
              {(entity?.columns ?? []).map((c) => (
                <button key={c.key} type="button"
                  className={`chip${cfg.columns.includes(c.key) ? ' on' : ''}`}
                  onClick={() => toggleCol(c.key)}>{c.label}</button>
              ))}
            </div>
            <div className="hint">{cfg.columns.length} selected · click to add or remove</div>
          </div>

          {/* ---- group by */}
          <div className="fld" style={{ marginTop: 12 }}>
            <label>Group by</label>
            <div className="chips">
              {(entity?.columns ?? []).filter((c) => c.groupable).map((c) => (
                <button key={c.key} type="button"
                  className={`chip${cfg.group_by.includes(c.key) ? ' on' : ''}`}
                  onClick={() => toggleGroup(c.key)}>{c.label}</button>
              ))}
            </div>
            <div className="hint">
              {cfg.group_by.length
                ? 'Grouped: you get a count plus the total of every money/number column you picked. Text columns are dropped — "the alphabetically-first phone number in this branch" is not a number anybody wants.'
                : 'Leave empty for a plain row list.'}
            </div>
          </div>

          {/* ---- filters */}
          <div className="fld" style={{ marginTop: 12 }}>
            <label>Filters</label>
            {cfg.filters.map((f, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                <select className="ainp" aria-label={`Filter ${i + 1} column`} value={f.col}
                  onChange={(e) => setCfg((c) => {
                    const filters = [...c.filters];
                    // Changing the COLUMN resets the operator: "contains" on a date is a
                    // 400 the user cannot act on, so it must not be reachable.
                    filters[i] = { col: e.target.value, op: '', value: '' };
                    return { ...c, filters };
                  })}>
                  <option value="">Pick a column…</option>
                  {(entity?.columns ?? []).filter((c) => c.filterable).map((c) => (
                    <option key={c.key} value={c.key}>{c.label}</option>
                  ))}
                </select>
                <select className="ainp" aria-label={`Filter ${i + 1} condition`} value={f.op}
                  onChange={(e) => setCfg((c) => {
                    const filters = [...c.filters]; filters[i] = { ...filters[i], op: e.target.value };
                    return { ...c, filters };
                  })}>
                  <option value="">Condition…</option>
                  {opsFor(f.col).map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                </select>
                {arityOf(f.op) >= 1 ? (
                  <input className="ainp" aria-label={`Filter ${i + 1} value`} value={f.value ?? ''}
                    placeholder="Value"
                    onChange={(e) => setCfg((c) => {
                      const filters = [...c.filters]; filters[i] = { ...filters[i], value: e.target.value };
                      return { ...c, filters };
                    })} />
                ) : null}
                {arityOf(f.op) === 2 ? (
                  <input className="ainp" aria-label={`Filter ${i + 1} second value`} value={f.value2 ?? ''}
                    placeholder="and…"
                    onChange={(e) => setCfg((c) => {
                      const filters = [...c.filters]; filters[i] = { ...filters[i], value2: e.target.value };
                      return { ...c, filters };
                    })} />
                ) : null}
                <button className="icon-btn sm" title="Remove filter"
                  onClick={() => setCfg((c) => ({ ...c, filters: c.filters.filter((_, j) => j !== i) }))}>
                  <Ic k="x" />
                </button>
              </div>
            ))}
            <button className="btn sm" onClick={() => setCfg((c) => ({ ...c, filters: [...c.filters, { col: '', op: '', value: '' }] }))}>
              <Ic k="plus" />Add a filter
            </button>
          </div>

          {/* ---- sort */}
          <div className="form-grid" style={{ marginTop: 12 }}>
            <div className="fld">
              <label htmlFor="rb-sort">Sort by</label>
              <select id="rb-sort" className="ainp" value={cfg.sort[0]?.col ?? ''}
                onChange={(e) => setCfg((c) => ({ ...c, sort: e.target.value ? [{ col: e.target.value, dir: c.sort[0]?.dir ?? 'desc' }] : [] }))}>
                <option value="">Default</option>
                {(entity?.columns ?? []).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="rb-dir">Direction</label>
              <select id="rb-dir" className="ainp" value={cfg.sort[0]?.dir ?? 'desc'}
                disabled={!cfg.sort.length}
                onChange={(e) => setCfg((c) => ({ ...c, sort: c.sort.length ? [{ ...c.sort[0], dir: e.target.value as 'asc' | 'desc' }] : [] }))}>
                <option value="desc">Highest / newest first</option>
                <option value="asc">Lowest / oldest first</option>
              </select>
            </div>
          </div>

          {err ? <div className="form-err" role="alert">{err}</div> : null}

          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn primary" onClick={run} disabled={busy || !cfg.columns.length}>
              <Ic k="play" />{busy ? 'Running…' : 'Run report'}
            </button>
            {can('report.create') ? (
              <>
                <input className="ainp" style={{ maxWidth: 240 }} placeholder="Name it to save…"
                  aria-label="Report name" value={name} onChange={(e) => setName(e.target.value)} />
                <button className="btn" onClick={save} disabled={saving || !cfg.columns.length}>
                  <Ic k="save" />{saving ? 'Saving…' : 'Save report'}
                </button>
              </>
            ) : null}
            {out && can('report.export') ? (
              <ExportButtons formats={cat.data.formats}
                start={(format) => api.post<{ id: number }>('/reports/exports', { entity: entityKey, config: cfg, format, name: name || entity?.label })} />
            ) : null}
          </div>
          {savedId ? <div className="hint" style={{ marginTop: 8 }}>Saved. Open <b>Reports</b> to run, share or schedule it.</div> : null}
        </div>
      </div>

      <ReportGrid out={out} />
    </>
  );
}

/* ==================================================================== */
/*  SAVED REPORTS                                                        */
/* ==================================================================== */

export function SavedReports() {
  const { can } = useAuth();
  const [tick, setTick] = useState(0);
  const list = useFetch<any[]>('/reports', [tick]);
  const cat = useFetch<RptCatalog>('/reports/catalog', []);
  const [open, setOpen] = useState<any | null>(null);
  const [out, setOut] = useState<RunOut | null>(null);
  const [share, setShare] = useState<any | null>(null);
  const [sched, setSched] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (r: any) => {
    setBusy(true); setOpen(r); setOut(null);
    try { setOut(await api.post<RunOut>(`/reports/${r.id}/run`, {})); }
    catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };

  const remove = async (r: any) => {
    try { await api.del(`/reports/${r.id}`); toast('Report deleted'); setTick((t) => t + 1); if (open?.id === r.id) { setOpen(null); setOut(null); } }
    catch (e) { toast((e as Error).message, true); }
  };

  const rows = (list.data ?? []).map((r) => [
    { node: <span className="nm">{r.name}</span> } as Cell,
    { b: [r.entity_label, 'b-indigo'] } as Cell,
    r.is_standard ? { b: ['Standard', 'b-cyan'] } as Cell
      : r.is_mine ? { b: ['Mine', 'b-green'] } as Cell
        : { b: [`Shared by ${r.owner_name ?? '—'}`, 'b-amber'] } as Cell,
    String(r.share_count ?? 0),
    r.schedule_count ? { b: [`${r.schedule_count} active`, 'b-green'] } as Cell : '—',
    {
      node: <RowBtns items={[
        ['play', 'Run', () => run(r)],
        ...(can('report.share') ? [['share', 'Share', () => setShare(r)] as [string, string, () => void]] : []),
        ...(can('report.schedule') ? [['clock', 'Schedule', () => setSched(r)] as [string, string, () => void]] : []),
        ...(can('report.delete') && !r.is_standard ? [['trash', 'Delete', () => remove(r)] as [string, string, () => void]] : []),
      ]} />,
    } as Cell,
  ]);

  return (
    <>
      <TableCard title="Saved reports" cols={['Report', 'Data source', 'Owner', 'Shared with', 'Scheduled', '']}
        rows={rows} empty="No saved reports yet — build one in Report Builder." />

      {open ? (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>{open.name}</h3>
            {out && can('report.export') && cat.data ? (
              <ExportButtons formats={cat.data.formats}
                start={(format) => api.post<{ id: number }>(`/reports/${open.id}/export`, { format })} />
            ) : null}
          </div>
          {busy ? <div className="empty-note">Running…</div> : <ReportGrid out={out} />}
        </div>
      ) : null}

      {share ? <ShareModal report={share} onClose={() => { setShare(null); setTick((t) => t + 1); }} /> : null}
      {sched ? <ScheduleModal report={sched} onClose={() => { setSched(null); setTick((t) => t + 1); }} /> : null}
    </>
  );
}

/* ==================================================================== */
/*  SHARE                                                                */
/* ==================================================================== */

export function ShareModal({ report, onClose }: { report: any; onClose: () => void }) {
  const [roles, setRoles] = useState<Array<{ id: number; name: string }>>([]);
  const [userIds, setUserIds] = useState<number[]>(
    (report.shares ?? []).filter((s: any) => s.user_id).map((s: any) => Number(s.user_id)),
  );
  const [roleIds, setRoleIds] = useState<number[]>(
    (report.shares ?? []).filter((s: any) => s.role_id).map((s: any) => Number(s.role_id)),
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { api.get<any[]>('/roles').then(setRoles).catch(() => setRoles([])); }, []);

  const save = async () => {
    setErr(''); setBusy(true);
    try {
      await api.post(`/reports/${report.id}/share`, { user_ids: userIds, role_ids: roleIds });
      toast('Sharing updated'); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 620 }}>
        <div className="ah">
          <h3><Ic k="share" />Share "{report.name}"</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          {/* THE SENTENCE THAT PREVENTS A SUPPORT CALL. Without it the client shares a
              branch report with a counsellor, the counsellor sees three rows, and one of
              them reports a bug. */}
          <div className="notice" style={{ marginBottom: 12 }}>
            <Ic k="shield" />
            <div>
              Sharing lets these people <b>run</b> the report. It does <b>not</b> give them your data:
              when they run it, they see only the records their own role allows. Their totals will
              differ from yours, and that is correct.
            </div>
          </div>
          <div className="fld">
            <label>Share with people</label>
            <UserPicker value={userIds} onChange={setUserIds} />
          </div>
          <div className="fld">
            <label>Share with roles</label>
            <div className="chips">
              {roles.map((r) => (
                <button key={r.id} type="button"
                  className={`chip${roleIds.includes(Number(r.id)) ? ' on' : ''}`}
                  onClick={() => setRoleIds((x) => (x.includes(Number(r.id)) ? x.filter((i) => i !== Number(r.id)) : [...x, Number(r.id)]))}>
                  {r.name}
                </button>
              ))}
            </div>
            <div className="hint">Everyone holding the role sees the report, including people who join it later.</div>
          </div>
          {err ? <div className="form-err" role="alert">{err}</div> : null}
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save sharing'}</button>
        </div>
      </div>
    </div>
  );
}

/* ==================================================================== */
/*  SCHEDULE                                                             */
/* ==================================================================== */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function ScheduleModal({ report, onClose }: { report: any; onClose: () => void }) {
  const [frequency, setFrequency] = useState('daily');
  const [hour, setHour] = useState('8');
  const [minute, setMinute] = useState('0');
  const [dow, setDow] = useState('1');
  const [dom, setDom] = useState('1');
  const [format, setFormat] = useState('xlsx');
  const [userIds, setUserIds] = useState<number[]>([]);
  const [roles, setRoles] = useState<Array<{ id: number; name: string }>>([]);
  const [roleIds, setRoleIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { api.get<any[]>('/roles').then(setRoles).catch(() => setRoles([])); }, []);

  const save = async () => {
    setErr(''); setBusy(true);
    try {
      await api.post('/reports/schedules', {
        report_id: report.id, frequency,
        hour_local: Number(hour), minute_local: Number(minute),
        day_of_week: frequency === 'weekly' ? Number(dow) : null,
        day_of_month: frequency === 'monthly' ? Number(dom) : null,
        format, recipient_user_ids: userIds, recipient_role_ids: roleIds,
      });
      toast('Scheduled — see Scheduled Delivery for the history.'); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 640 }}>
        <div className="ah">
          <h3><Ic k="clock" />Schedule "{report.name}"</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          {/* THE ONE THING THE CLIENT MUST READ BEFORE HE PRESSES SAVE. A scheduled file
              is rendered in the SCHEDULER'S scope — unlike sharing, where the runner's
              scope applies. Emailing your branch report to a counsellor puts branch rows
              in his inbox. That is a legitimate thing to want; it must be a decision. */}
          <div className="notice" style={{ marginBottom: 12 }}>
            <Ic k="shield" />
            <div>
              The file is built with <b>your</b> access and emailed as an attachment. Anyone you
              list will see <b>everything you can see</b> in this report, even if they could not
              see it inside the app. Choose recipients accordingly.
            </div>
          </div>
          <div className="form-grid">
            <div className="fld">
              <label htmlFor="sc-freq">How often <span className="star">*</span></label>
              <select id="sc-freq" className="ainp" value={frequency} onChange={(e) => setFrequency(e.target.value)}>
                <option value="daily">Every day</option>
                <option value="weekly">Every week</option>
                <option value="monthly">Every month</option>
              </select>
            </div>
            {frequency === 'weekly' ? (
              <div className="fld">
                <label htmlFor="sc-dow">On</label>
                <select id="sc-dow" className="ainp" value={dow} onChange={(e) => setDow(e.target.value)}>
                  {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
                </select>
              </div>
            ) : null}
            {frequency === 'monthly' ? (
              <div className="fld">
                <label htmlFor="sc-dom">Day of the month</label>
                <select id="sc-dom" className="ainp" value={dom} onChange={(e) => setDom(e.target.value)}>
                  {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
                {/* 28 is not laziness: "the 31st" is a schedule that silently skips
                    February, and the client would never be told it had. */}
                <div className="hint">Up to the 28th — every month has one.</div>
              </div>
            ) : null}
            <div className="fld">
              <label htmlFor="sc-hour">At (IST) <span className="star">*</span></label>
              <div style={{ display: 'flex', gap: 6 }}>
                <select id="sc-hour" className="ainp" value={hour} onChange={(e) => setHour(e.target.value)}>
                  {Array.from({ length: 24 }, (_, i) => i).map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}</option>)}
                </select>
                <select className="ainp" aria-label="Minute" value={minute} onChange={(e) => setMinute(e.target.value)}>
                  {['0', '15', '30', '45'].map((m) => <option key={m} value={m}>{String(m).padStart(2, '0')}</option>)}
                </select>
              </div>
            </div>
            <div className="fld">
              <label htmlFor="sc-format">Attach as <span className="star">*</span></label>
              <select id="sc-format" className="ainp" value={format} onChange={(e) => setFormat(e.target.value)}>
                <option value="xlsx">Excel (.xlsx)</option>
                <option value="csv">CSV</option>
                <option value="pdf">PDF</option>
              </select>
            </div>
          </div>
          <div className="fld">
            <label>Email it to</label>
            <UserPicker value={userIds} onChange={setUserIds} />
          </div>
          <div className="fld">
            <label>…and everyone with these roles</label>
            <div className="chips">
              {roles.map((r) => (
                <button key={r.id} type="button"
                  className={`chip${roleIds.includes(Number(r.id)) ? ' on' : ''}`}
                  onClick={() => setRoleIds((x) => (x.includes(Number(r.id)) ? x.filter((i) => i !== Number(r.id)) : [...x, Number(r.id)]))}>
                  {r.name}
                </button>
              ))}
            </div>
          </div>
          <div className="hint">
            Delivery needs SMTP in <b>Settings › Channels</b>. Without it the run is recorded as
            skipped with the reason, and it starts sending by itself the day you add it — nothing
            to switch back on.
          </div>
          {err ? <div className="form-err" role="alert">{err}</div> : null}
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Schedule it'}</button>
        </div>
      </div>
    </div>
  );
}

export function ScheduledDelivery() {
  const [tick, setTick] = useState(0);
  const list = useFetch<any[]>('/reports/schedules/all', [tick]);
  const [history, setHistory] = useState<{ s: any; rows: any[] } | null>(null);

  const toggle = async (s: any) => {
    try { await api.patch(`/reports/schedules/${s.id}/active`, { is_active: !s.is_active }); setTick((t) => t + 1); }
    catch (e) { toast((e as Error).message, true); }
  };
  const runNow = async (s: any) => {
    try { const r = await api.post<any>(`/reports/schedules/${s.id}/run`, {}); toast(r.note); setTick((t) => t + 1); if (history?.s.id === s.id) void showHistory(s); }
    catch (e) { toast((e as Error).message, true); }
  };
  const remove = async (s: any) => {
    try { await api.del(`/reports/schedules/${s.id}`); toast('Schedule removed'); setTick((t) => t + 1); }
    catch (e) { toast((e as Error).message, true); }
  };
  const showHistory = async (s: any) => {
    try { setHistory({ s, rows: await api.get<any[]>(`/reports/schedules/${s.id}/history`) }); }
    catch (e) { toast((e as Error).message, true); }
  };

  const freqLabel = (s: any) => {
    const at = `${String(s.hour_local).padStart(2, '0')}:${String(s.minute_local).padStart(2, '0')}`;
    if (s.frequency === 'daily') return `Daily at ${at}`;
    if (s.frequency === 'weekly') return `${DAYS[s.day_of_week ?? 1]}s at ${at}`;
    return `Day ${s.day_of_month} at ${at}`;
  };

  return (
    <>
      <TableCard title="Scheduled reports"
        cols={['Report', 'Recipients', 'Frequency', 'Format', 'Next run', 'Status', '']}
        rows={(list.data ?? []).map((s) => [
          { node: <span className="nm">{s.report_name}</span> } as Cell,
          `${(s.recipient_user_ids ?? []).length} people · ${(s.recipient_role_ids ?? []).length} roles`,
          freqLabel(s),
          { b: [String(s.format).toUpperCase(), 'b-indigo'] } as Cell,
          { mono: s.is_active && s.next_run_at ? dt(s.next_run_at) : '—' } as Cell,
          s.is_active ? { b: ['Active', 'b-green'] } as Cell : { b: ['Paused', 'b-gray'] } as Cell,
          {
            node: <RowBtns items={[
              ['play', 'Send now', () => runNow(s)],
              ['list', 'Delivery history', () => showHistory(s)],
              [s.is_active ? 'pause' : 'play', s.is_active ? 'Pause' : 'Resume', () => toggle(s)],
              ['trash', 'Remove', () => remove(s)],
            ]} />,
          } as Cell,
        ])}
        empty="Nothing scheduled yet — open Reports, pick a report and press Schedule." />

      {history ? (
        <div style={{ marginTop: 14 }}>
          <TableCard title={`Delivery history — ${history.s.report_name}`}
            cols={['Run', 'When', 'Status', 'Recipients', 'Rows', 'Detail']}
            rows={history.rows.map((d) => [
              { mono: d.run_key } as Cell,
              { mono: dt(d.started_at) } as Cell,
              d.status === 'sent' ? { b: ['Sent', 'b-green'] } as Cell
                : d.status === 'skipped' ? { b: ['Skipped', 'b-amber'] } as Cell
                  : d.status === 'failed' ? { b: ['Failed', 'b-rose'] } as Cell
                    : { b: ['Running', 'b-cyan'] } as Cell,
              (d.recipients ?? []).join(', ') || '—',
              d.row_count == null ? '—' : String(d.row_count),
              // The REASON, in the client's own words, on the screen. "Did it send?" must
              // be answerable without a log file he cannot reach.
              d.error || (d.status === 'sent' ? d.file_name : '—'),
            ])}
            empty="This schedule has not run yet." />
        </div>
      ) : null}
    </>
  );
}

/* ==================================================================== */
/*  STANDARD REPORTS                                                     */
/* ==================================================================== */

/** A from/to control shared by the standard reports. */
function RangeBar({ from, to, setFrom, setTo }: {
  from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void;
}) {
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="cb" style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="fld" style={{ margin: 0 }}>
          <label htmlFor="rr-from">From</label>
          <input id="rr-from" className="ainp" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="fld" style={{ margin: 0 }}>
          <label htmlFor="rr-to">To</label>
          <input id="rr-to" className="ainp" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        {from || to ? <button className="btn sm" onClick={() => { setFrom(''); setTo(''); }}>All time</button> : null}
      </div>
    </div>
  );
}

const qs = (from: string, to: string) => {
  const p = new URLSearchParams();
  if (from) p.set('from', from);
  if (to) p.set('to', to);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export function FunnelReport() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const d = useFetch<any>(`/reports/funnel${qs(from, to)}`, [from, to]);
  const COLORS = ['#6366f1', '#0891b2', '#059669', '#d97706', '#e11d48', '#7c3aed'];
  const rows = (d.data?.stages ?? []).map((s: any, i: number) => ({
    label: s.name,
    val: String(s.count),
    sub: s.from_previous_pct == null ? '' : `${s.from_previous_pct}% of previous · ${s.dropped} dropped`,
    pct: s.of_first_pct ?? 0,
    color: COLORS[i % COLORS.length],
  }));
  return (
    <>
      <RangeBar from={from} to={to} setFrom={setFrom} setTo={setTo} />
      <Kpis items={[
        { lab: 'Leads', val: String(d.data?.totals?.leads ?? 0), ic: 'leads' },
        { lab: 'Won', val: String(d.data?.totals?.won ?? 0), ic: 'check' },
        { lab: 'Lost', val: String(d.data?.totals?.lost ?? 0), ic: 'x' },
        { lab: CONVERSION_LABEL_LEAD_WON, val: `${d.data?.totals?.conversion_pct ?? 0}%`, ic: 'bolt' },
      ]} />
      <Funnel title="Stage-to-stage conversion" rows={rows}
        empty="The funnel fills as leads move through stages" />
      <TableCard title="Drop-off by stage"
        cols={['Stage', 'Leads', 'From previous stage', 'Dropped', 'Of first stage']}
        rows={(d.data?.stages ?? []).map((s: any) => [
          s.name, String(s.count),
          s.from_previous_pct == null ? '—' : `${s.from_previous_pct}%`,
          s.dropped == null ? '—' : String(s.dropped),
          s.of_first_pct == null ? '—' : `${s.of_first_pct}%`,
        ])}
        empty="No stages with leads in this range" />
      <ScopeNote note={d.data?.scope?.unrestricted === false ? 'Showing only the records your role gives you access to.' : undefined} />
    </>
  );
}

export function TatReport() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const d = useFetch<any>(`/reports/tat${qs(from, to)}`, [from, to]);
  const fr = d.data?.first_response;
  const le = d.data?.lead_to_enrolment;
  return (
    <>
      <RangeBar from={from} to={to} setFrom={setFrom} setTo={setTo} />
      {/* MEDIAN is the headline and MEAN is next to it. One lead found on Monday after a
          weekend drags a mean into meaninglessness — but a manager chasing that outlier
          needs to know it is there, so both are shown and both are labelled. */}
      <Kpis items={[
        { lab: 'First response (median)', val: mins(fr?.median_minutes), ic: 'clock' },
        { lab: 'First response (mean)', val: mins(fr?.mean_minutes), ic: 'clock' },
        { lab: 'SLA breaches', val: String(fr?.breached ?? 0), ic: 'bolt' },
        { lab: 'Lead → enrolment (median)', val: mins(le?.median_minutes), ic: 'check' },
      ]} />
      <TableCard title="Time in stage" cols={['Stage', 'Leads measured', 'Median', 'Mean']}
        rows={(d.data?.by_stage ?? []).map((s: any) => [
          s.stage, String(s.n), mins(s.median_minutes), mins(s.mean_minutes),
        ])}
        empty="Time-in-stage fills as leads move between stages" />
      <div className="hint" style={{ marginTop: 8 }}>
        Time in stage counts only stages a lead has <b>left</b>. A lead sitting in a stage now
        has not spent a measurable time in it yet — counting it as zero would drag every
        median to the floor.
      </div>
    </>
  );
}

export function ActivityReport() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const d = useFetch<any>(`/reports/activity${qs(from, to)}`, [from, to]);
  return (
    <>
      <RangeBar from={from} to={to} setFrom={setFrom} setTo={setTo} />
      {/* THE MISSING "CALLS" COLUMN, EXPLAINED ON THE SCREEN. The prototype drew it;
          telephony is out of scope, so inventing a call count would be the worst kind of
          green tick. Saying so beats an em-dash the client has to ask about. */}
      {d.data && d.data.telephony === false ? (
        <PhaseNote>
          <b>There is no "Calls" column.</b> Telephony is out of scope for this system, so we
          have no call counts — and we would rather say so than show you a number we invented.
          What the team actually logged is below: dispositions, notes, stage changes and
          completed follow-ups.
        </PhaseNote>
      ) : null}
      <TableCard title="User activity"
        cols={['User', 'Activities logged', 'Notes', 'Follow-ups completed', 'Logins', 'Edits']}
        rows={(d.data?.rows ?? []).map((r: any) => [
          { node: <span className="nm">{r.user_name}</span> } as Cell,
          String(r.activities), String(r.notes), String(r.followups_done), String(r.logins), String(r.edits),
        ])}
        empty="Activity accumulates as the team works" />
      <ScopeNote note={d.data?.scope?.unrestricted === false ? 'Showing only the records your role gives you access to.' : undefined} />
    </>
  );
}

export function CampaignRoiReport() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const d = useFetch<any>(`/reports/roi${qs(from, to)}`, [from, to]);
  const t = d.data?.totals;
  return (
    <>
      <RangeBar from={from} to={to} setFrom={setFrom} setTo={setTo} />
      <Kpis items={[
        { lab: 'Spend', val: t ? fmtINR(t.cost_minor) : '—', ic: 'rupee' },
        { lab: 'Cost per lead', val: t?.cpl_minor == null ? '—' : fmtINR(t.cpl_minor), ic: 'leads' },
        { lab: 'Cost per enrolment', val: t?.cpa_minor == null ? '—' : fmtINR(t.cpa_minor), ic: 'students' },
        { lab: 'Return on spend', val: t?.roi_x == null ? '—' : `${t.roi_x}x`, ic: 'bolt' },
      ]} />
      {/* BOOKED vs COLLECTED, said out loud. A marketer comparing spend against cash
          would otherwise conclude a campaign lost money because the student pays in three
          instalments. Which basis targets use is an OPEN CLIENT DECISION (§4b). */}
      <PhaseNote>
        Revenue here is <b>booked</b> — the fee of enrolments closed in the range, i.e. what was
        sold. Cash actually receipted is a different number and lives on Fee Collection.
      </PhaseNote>
      <TableCard title="Campaign ROI"
        cols={(d.data?.columns ?? []).map((c: any) => c.label)}
        rows={(d.data?.rows ?? []).map((r: unknown[]) => (d.data.columns as any[]).map((c, i) => (
          c.type === 'money' || c.type === 'number'
            ? { node: <span className="mono">{fmtCell(r[i], c.type)}</span> } as Cell
            : fmtCell(r[i], c.type) as Cell
        )))}
        empty="ROI appears when campaigns carry spend and leads convert" />
      <ScopeNote note={d.data?.scope?.note} />
    </>
  );
}

/* ==================================================================== */
/*  WORKSPACE — team chat                                                */
/* ==================================================================== */

export function TeamChat() {
  const { can, me } = useAuth();
  const [tick, setTick] = useState(0);
  const channels = useFetch<any[]>('/workspace/channels', [tick]);
  const [active, setActive] = useState<number | null>(null);
  const [msgs, setMsgs] = useState<any[]>([]);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const list = channels.data ?? [];
  useEffect(() => { if (active == null && list.length) setActive(list[0].id); }, [list.length]);

  const load = async (id: number) => {
    try { setMsgs(await api.get<any[]>(`/workspace/channels/${id}/messages`)); }
    catch (e) { toast((e as Error).message, true); setMsgs([]); }
  };
  useEffect(() => { if (active != null) void load(active); }, [active, tick]);

  const send = async () => {
    if (!body.trim() || active == null) return;
    setBusy(true);
    try { await api.post(`/workspace/channels/${active}/messages`, { body }); setBody(''); await load(active); }
    catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };

  const del = async (m: any) => {
    try { await api.del(`/workspace/messages/${m.id}`); await load(active!); }
    catch (e) { toast((e as Error).message, true); }
  };

  return (
    <>
      <div className="wa-wrap">
        <div className="wa-list">
          <div className="wa-list-head"><Ic k="chat" />Channels</div>
          {list.map((c) => (
            <button key={c.id} className={`wa-item${active === c.id ? ' on' : ''}`} onClick={() => setActive(c.id)}>
              <div className="nm"># {c.name}</div>
              <div className="sub">{c.message_count} messages{c.branch_name ? ` · ${c.branch_name}` : ''}</div>
            </button>
          ))}
          {!list.length ? <div className="empty-note" style={{ marginTop: 20 }}>No channels you can see.</div> : null}
          {can('workspace.manage') ? (
            <button className="btn sm" style={{ margin: 10 }} onClick={() => setAdding(true)}><Ic k="plus" />New channel</button>
          ) : null}
        </div>
        <div className="wa-thread">
          <div className="wa-msgs">
            {msgs.map((m) => (
              <div key={m.id} className={`wa-msg${Number(m.author_id) === Number(me?.user?.id) ? ' mine' : ''}`}>
                <div className="wa-meta">{m.author_name ?? 'System'} · {dt(m.created_at)}</div>
                <div className="wa-body">{m.body}</div>
                {Number(m.author_id) === Number(me?.user?.id) || can('workspace.manage') ? (
                  <button className="icon-btn sm" title="Delete" onClick={() => del(m)}><Ic k="trash" /></button>
                ) : null}
              </div>
            ))}
            {!msgs.length ? <div className="empty-note" style={{ margin: 'auto' }}>No messages yet — say something.</div> : null}
          </div>
          {can('workspace.post') ? (
            <div className="wa-compose">
              <input className="ainp" aria-label="Message" value={body} placeholder="Write a message…"
                onChange={(e) => setBody(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
              <button className="btn primary" onClick={send} disabled={busy || !body.trim()}><Ic k="send" />Send</button>
            </div>
          ) : null}
        </div>
      </div>
      {adding ? <ChannelModal onClose={() => { setAdding(false); setTick((t) => t + 1); }} /> : null}
    </>
  );
}

export function ChannelModal({ onClose }: { onClose: () => void }) {
  const ref = useRef_();
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [branchId, setBranchId] = useState('');
  const [verticalId, setVerticalId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    setErr(''); setBusy(true);
    try {
      await api.post('/workspace/channels', {
        name, topic: topic || null,
        branch_id: branchId ? Number(branchId) : null,
        vertical_id: verticalId ? Number(verticalId) : null,
      });
      toast('Channel created'); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 560 }}>
        <div className="ah">
          <h3><Ic k="chat" />New channel</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          <div className="form-grid">
            <div className="fld">
              <label htmlFor="ch-name">Channel name <span className="star">*</span></label>
              <input id="ch-name" className="ainp" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. vikaspuri-desk" />
            </div>
            <div className="fld">
              <label htmlFor="ch-topic">Topic</label>
              <input id="ch-topic" className="ainp" value={topic} onChange={(e) => setTopic(e.target.value)} />
            </div>
            <div className="fld">
              <label htmlFor="ch-branch">Branch</label>
              <select id="ch-branch" className="ainp" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                <option value="">Everyone (org-wide)</option>
                {ref.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="ch-vertical">Vertical</label>
              <select id="ch-vertical" className="ainp" value={verticalId} onChange={(e) => setVerticalId(e.target.value)}>
                <option value="">Everyone (org-wide)</option>
                {ref.verticals.filter((v) => !branchId || Number(v.branch_id) === Number(branchId))
                  .map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </div>
          </div>
          <div className="hint">Leave both empty and everybody sees the channel. Set a branch and only that branch does.</div>
          {err ? <div className="form-err" role="alert">{err}</div> : null}
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Create channel'}</button>
        </div>
      </div>
    </div>
  );
}

/* ==================================================================== */
/*  WORKSPACE — notes                                                    */
/* ==================================================================== */

export function Notes() {
  const [tick, setTick] = useState(0);
  const [q, setQ] = useState('');
  const list = useFetch<any[]>(`/workspace/notes${q ? `?q=${encodeURIComponent(q)}` : ''}`, [tick, q]);
  const [edit, setEdit] = useState<any | null>(null);

  const del = async (n: any) => {
    try { await api.del(`/workspace/notes/${n.id}`); toast('Note deleted'); setTick((t) => t + 1); }
    catch (e) { toast((e as Error).message, true); }
  };

  return (
    <>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="cb" style={{ display: 'flex', gap: 8 }}>
          <input className="ainp" aria-label="Search notes" placeholder="Search notes…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn primary" onClick={() => setEdit({})}><Ic k="plus" />New note</button>
        </div>
      </div>
      <TableCard title="Notes" cols={['Title', 'Visibility', 'Owner', 'Updated', '']}
        rows={(list.data ?? []).map((n) => [
          { node: <span className="nm">{n.is_pinned ? '📌 ' : ''}{n.title}</span> } as Cell,
          n.is_shared ? { b: ['Shared', 'b-green'] } as Cell : { b: ['Private', 'b-gray'] } as Cell,
          n.owner_name ?? '—',
          { mono: dt(n.updated_at) } as Cell,
          {
            node: <RowBtns items={n.is_mine ? [
              ['edit', 'Edit', () => setEdit(n)],
              ['trash', 'Delete', () => del(n)],
            ] : [['eye', 'View', () => setEdit({ ...n, _readonly: true })]]} />,
          } as Cell,
        ])}
        empty="No notes yet." />
      {edit ? <NoteModal note={edit} onClose={() => { setEdit(null); setTick((t) => t + 1); }} /> : null}
    </>
  );
}

export function NoteModal({ note, onClose }: { note: any; onClose: () => void }) {
  const ref = useRef_();
  const ro = note?._readonly === true;
  const [title, setTitle] = useState(note?.title ?? '');
  const [body, setBody] = useState(note?.body ?? '');
  const [shared, setShared] = useState(note?.is_shared === true);
  const [pinned, setPinned] = useState(note?.is_pinned === true);
  const [branchId, setBranchId] = useState(String(note?.branch_id ?? ''));
  const [verticalId, setVerticalId] = useState(String(note?.vertical_id ?? ''));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    setErr(''); setBusy(true);
    const payload = {
      title, body, is_shared: shared, is_pinned: pinned,
      branch_id: branchId ? Number(branchId) : null,
      vertical_id: verticalId ? Number(verticalId) : null,
    };
    try {
      if (note?.id) await api.patch(`/workspace/notes/${note.id}`, payload);
      else await api.post('/workspace/notes', payload);
      toast('Note saved'); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 640 }}>
        <div className="ah">
          <h3><Ic k="note" />{ro ? note.title : note?.id ? 'Edit note' : 'New note'}</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          {ro ? <div style={{ whiteSpace: 'pre-wrap' }}>{note.body}</div> : (
            <>
              <div className="fld">
                <label htmlFor="nt-title">Title <span className="star">*</span></label>
                <input id="nt-title" className="ainp" value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div className="fld">
                <label htmlFor="nt-body">Note</label>
                <textarea id="nt-body" className="ainp" rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
              </div>
              <div className="form-grid">
                <div className="fld">
                  <label htmlFor="nt-shared">Visibility</label>
                  <select id="nt-shared" className="ainp" value={shared ? '1' : '0'} onChange={(e) => setShared(e.target.value === '1')}>
                    <option value="0">Private — only me</option>
                    <option value="1">Shared with my team</option>
                  </select>
                </div>
                <div className="fld">
                  <label htmlFor="nt-pinned">Pin to the top</label>
                  <select id="nt-pinned" className="ainp" value={pinned ? '1' : '0'} onChange={(e) => setPinned(e.target.value === '1')}>
                    <option value="0">No</option>
                    <option value="1">Yes</option>
                  </select>
                </div>
                {shared ? (
                  <>
                    <div className="fld">
                      <label htmlFor="nt-branch">Branch</label>
                      <select id="nt-branch" className="ainp" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                        <option value="">Everyone</option>
                        {ref.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                      </select>
                    </div>
                    <div className="fld">
                      <label htmlFor="nt-vertical">Vertical</label>
                      <select id="nt-vertical" className="ainp" value={verticalId} onChange={(e) => setVerticalId(e.target.value)}>
                        <option value="">Everyone</option>
                        {ref.verticals.filter((v) => !branchId || Number(v.branch_id) === Number(branchId))
                          .map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                      </select>
                    </div>
                  </>
                ) : null}
              </div>
              {/* A PRIVATE note is private from EVERYONE, including a Branch Manager whose
                  scope covers its author. A notepad a manager can read is not a notepad. */}
              <div className="hint">A private note is yours alone — nobody else can open it, whatever their role.</div>
            </>
          )}
          {err ? <div className="form-err" role="alert">{err}</div> : null}
        </div>
        {!ro ? (
          <div className="af">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={save} disabled={busy || !title.trim()}>{busy ? 'Saving…' : 'Save note'}</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ==================================================================== */
/*  WORKSPACE — knowledge base                                           */
/* ==================================================================== */

export function KnowledgeBase() {
  const { can } = useAuth();
  const [tick, setTick] = useState(0);
  const [q, setQ] = useState('');
  const list = useFetch<any[]>(`/workspace/kb${q ? `?q=${encodeURIComponent(q)}` : ''}`, [tick, q]);
  const [edit, setEdit] = useState<any | null>(null);

  const byCat = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const a of list.data ?? []) { const k = a.category || 'General'; m.set(k, [...(m.get(k) ?? []), a]); }
    return [...m.entries()];
  }, [list.data]);

  const del = async (a: any) => {
    try { await api.del(`/workspace/kb/${a.id}`); toast('Article deleted'); setTick((t) => t + 1); }
    catch (e) { toast((e as Error).message, true); }
  };

  return (
    <>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="cb" style={{ display: 'flex', gap: 8 }}>
          <input className="ainp" aria-label="Search the knowledge base" placeholder="Search articles…" value={q} onChange={(e) => setQ(e.target.value)} />
          {can('kb.manage') ? <button className="btn primary" onClick={() => setEdit({})}><Ic k="plus" />New article</button> : null}
        </div>
      </div>
      {byCat.map(([cat, items]) => (
        <TableCard key={cat} title={cat} cols={['Article', 'Access', 'Author', 'Updated', '']}
          rows={items.map((a) => [
            { node: <span className="nm">{a.title}</span> } as Cell,
            a.branch_name || a.vertical_name ? { b: [a.branch_name ?? a.vertical_name, 'b-cyan'] } as Cell : { b: ['Everyone', 'b-gray'] } as Cell,
            a.author_name ?? '—',
            { mono: dt(a.updated_at) } as Cell,
            {
              node: <RowBtns items={[
                ['eye', 'Read', () => setEdit({ ...a, _readonly: !can('kb.manage') })],
                ...(can('kb.manage') ? [['trash', 'Delete', () => del(a)] as [string, string, () => void]] : []),
              ]} />,
            } as Cell,
          ])} empty="No articles" />
      ))}
      {!byCat.length ? <div className="empty-note">No knowledge-base articles yet.</div> : null}
      {edit ? <ArticleModal article={edit} onClose={() => { setEdit(null); setTick((t) => t + 1); }} /> : null}
    </>
  );
}

export function ArticleModal({ article, onClose }: { article: any; onClose: () => void }) {
  const ref = useRef_();
  const ro = article?._readonly === true;
  const [category, setCategory] = useState(article?.category ?? 'General');
  const [title, setTitle] = useState(article?.title ?? '');
  const [body, setBody] = useState(article?.body ?? '');
  const [published, setPublished] = useState(article?.is_published !== false);
  const [branchId, setBranchId] = useState(String(article?.branch_id ?? ''));
  const [verticalId, setVerticalId] = useState(String(article?.vertical_id ?? ''));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    setErr(''); setBusy(true);
    const payload = {
      category, title, body, is_published: published,
      branch_id: branchId ? Number(branchId) : null,
      vertical_id: verticalId ? Number(verticalId) : null,
    };
    try {
      if (article?.id) await api.patch(`/workspace/kb/${article.id}`, payload);
      else await api.post('/workspace/kb', payload);
      toast('Article saved'); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 720 }}>
        <div className="ah">
          <h3><Ic k="book" />{ro ? article.title : article?.id ? 'Edit article' : 'New article'}</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          {ro ? <div style={{ whiteSpace: 'pre-wrap' }}>{article.body}</div> : (
            <>
              <div className="form-grid">
                <div className="fld">
                  <label htmlFor="kb-cat">Category <span className="star">*</span></label>
                  <input id="kb-cat" className="ainp" value={category} onChange={(e) => setCategory(e.target.value)} list="kb-cats" />
                </div>
                <div className="fld">
                  <label htmlFor="kb-pub">Published</label>
                  <select id="kb-pub" className="ainp" value={published ? '1' : '0'} onChange={(e) => setPublished(e.target.value === '1')}>
                    <option value="1">Yes — the team can read it</option>
                    <option value="0">Draft — only I can see it</option>
                  </select>
                </div>
                <div className="fld">
                  <label htmlFor="kb-branch">Branch</label>
                  <select id="kb-branch" className="ainp" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                    <option value="">Everyone</option>
                    {ref.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>
                <div className="fld">
                  <label htmlFor="kb-vertical">Vertical</label>
                  <select id="kb-vertical" className="ainp" value={verticalId} onChange={(e) => setVerticalId(e.target.value)}>
                    <option value="">Everyone</option>
                    {ref.verticals.filter((v) => !branchId || Number(v.branch_id) === Number(branchId))
                      .map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                </div>
              </div>
              <div className="fld">
                <label htmlFor="kb-title">Title <span className="star">*</span></label>
                <input id="kb-title" className="ainp" value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div className="fld">
                <label htmlFor="kb-body">Article</label>
                <textarea id="kb-body" className="ainp" rows={12} value={body} onChange={(e) => setBody(e.target.value)} />
              </div>
            </>
          )}
          {err ? <div className="form-err" role="alert">{err}</div> : null}
        </div>
        {!ro ? (
          <div className="af">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={save} disabled={busy || !title.trim()}>{busy ? 'Saving…' : 'Save article'}</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ==================================================================== */
/*  WORKSPACE — announcements                                            */
/* ==================================================================== */

export function Announcements() {
  const { can } = useAuth();
  const [tick, setTick] = useState(0);
  const mine = useFetch<any[]>('/workspace/announcements', [tick]);
  const admin = useFetch<any[]>(can('announcement.manage') ? '/workspace/announcements/manage' : null, [tick]);
  const [edit, setEdit] = useState<any | null>(null);

  const read = async (a: any) => {
    try { await api.post(`/workspace/announcements/${a.id}/read`, {}); setTick((t) => t + 1); }
    catch (e) { toast((e as Error).message, true); }
  };
  const del = async (a: any) => {
    try { await api.del(`/workspace/announcements/${a.id}`); toast('Announcement deleted'); setTick((t) => t + 1); }
    catch (e) { toast((e as Error).message, true); }
  };

  return (
    <>
      {can('announcement.manage') ? (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="cb"><button className="btn primary" onClick={() => setEdit({})}><Ic k="plus" />New announcement</button></div>
        </div>
      ) : null}

      <TableCard title="For you" cols={['Announcement', 'Audience', 'Posted by', 'When', '']}
        rows={(mine.data ?? []).map((a) => [
          {
            node: <span className="nm" style={a.is_read ? undefined : { fontWeight: 700 }}>
              {a.is_read ? '' : '● '}{a.title}
            </span>,
          } as Cell,
          a.branch_name || a.vertical_name ? { b: [a.branch_name ?? a.vertical_name, 'b-cyan'] } as Cell : { b: ['Everyone', 'b-gray'] } as Cell,
          a.created_by_name ?? '—',
          { mono: dt(a.published_at) } as Cell,
          { node: <RowBtns items={[['eye', 'Read', () => { setEdit({ ...a, _readonly: true }); void read(a); }]]} /> } as Cell,
        ])}
        empty="Nothing announced yet." />

      {can('announcement.manage') ? (
        <div style={{ marginTop: 14 }}>
          {/* READ TRACKING is the whole reason announcements are not just a channel post:
              the client wants to know who has seen the fee-structure change. */}
          <TableCard title="All announcements (with read tracking)"
            cols={['Title', 'Audience', 'Status', 'Read by', 'Created', '']}
            rows={(admin.data ?? []).map((a) => [
              { node: <span className="nm">{a.title}</span> } as Cell,
              a.branch_name || a.vertical_name ? { b: [a.branch_name ?? a.vertical_name, 'b-cyan'] } as Cell : { b: ['Everyone', 'b-gray'] } as Cell,
              a.is_published ? { b: ['Published', 'b-green'] } as Cell : { b: ['Draft', 'b-gray'] } as Cell,
              `${a.read_count} ${a.read_count === 1 ? 'person' : 'people'}`,
              { mono: dt(a.created_at) } as Cell,
              {
                node: <RowBtns items={[
                  ['edit', 'Edit', () => setEdit(a)],
                  ['trash', 'Delete', () => del(a)],
                ]} />,
              } as Cell,
            ])}
            empty="No announcements yet." />
        </div>
      ) : null}

      {edit ? <AnnouncementModal announcement={edit} onClose={() => { setEdit(null); setTick((t) => t + 1); }} /> : null}
    </>
  );
}

export function AnnouncementModal({ announcement, onClose }: { announcement: any; onClose: () => void }) {
  const ref = useRef_();
  const ro = announcement?._readonly === true;
  const [title, setTitle] = useState(announcement?.title ?? '');
  const [body, setBody] = useState(announcement?.body ?? '');
  const [branchId, setBranchId] = useState(String(announcement?.branch_id ?? ''));
  const [verticalId, setVerticalId] = useState(String(announcement?.vertical_id ?? ''));
  const [roleIds, setRoleIds] = useState<number[]>((announcement?.role_ids ?? []).map(Number));
  const [roles, setRoles] = useState<Array<{ id: number; name: string }>>([]);
  const [published, setPublished] = useState(announcement?.is_published === true);
  const [notify, setNotify] = useState(announcement?.notify !== false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { if (!ro) api.get<any[]>('/roles').then(setRoles).catch(() => setRoles([])); }, [ro]);

  const save = async () => {
    setErr(''); setBusy(true);
    const payload = {
      title, body,
      branch_id: branchId ? Number(branchId) : null,
      vertical_id: verticalId ? Number(verticalId) : null,
      role_ids: roleIds, is_published: published, notify,
    };
    try {
      if (announcement?.id) await api.patch(`/workspace/announcements/${announcement.id}`, payload);
      else await api.post('/workspace/announcements', payload);
      toast(published ? 'Announcement published' : 'Draft saved'); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  if (ro) {
    return (
      <div className="add-scrim">
        <div className="add-modal" style={{ maxWidth: 640 }}>
          <div className="ah">
            <h3><Ic k="bell" />{announcement.title}</h3>
            <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
          </div>
          <div className="abody">
            <div className="sub" style={{ marginBottom: 10 }}>{announcement.created_by_name} · {dt(announcement.published_at)}</div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{announcement.body}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 680 }}>
        <div className="ah">
          <h3><Ic k="bell" />{announcement?.id ? 'Edit announcement' : 'New announcement'}</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          <div className="fld">
            <label htmlFor="an-title">Title <span className="star">*</span></label>
            <input id="an-title" className="ainp" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="fld">
            <label htmlFor="an-body">Message</label>
            <textarea id="an-body" className="ainp" rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
          <div className="form-grid">
            <div className="fld">
              <label htmlFor="an-branch">Branch</label>
              <select id="an-branch" className="ainp" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                <option value="">Everyone</option>
                {ref.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="an-vertical">Vertical</label>
              <select id="an-vertical" className="ainp" value={verticalId} onChange={(e) => setVerticalId(e.target.value)}>
                <option value="">Everyone</option>
                {ref.verticals.filter((v) => !branchId || Number(v.branch_id) === Number(branchId))
                  .map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="an-pub">Publish</label>
              <select id="an-pub" className="ainp" value={published ? '1' : '0'} onChange={(e) => setPublished(e.target.value === '1')}>
                <option value="0">Save as draft</option>
                <option value="1">Publish now</option>
              </select>
            </div>
            <div className="fld">
              <label htmlFor="an-notify">Ring the bell</label>
              <select id="an-notify" className="ainp" value={notify ? '1' : '0'} onChange={(e) => setNotify(e.target.value === '1')}>
                <option value="1">Yes — notify the audience</option>
                <option value="0">No — just post it</option>
              </select>
              {/* Editing a published announcement must not re-ring every bell in the
                  company, and pressing Save twice must not either. */}
              <div className="hint">Only on the first publish — editing a published announcement never re-notifies.</div>
            </div>
          </div>
          <div className="fld">
            <label>Only these roles (optional)</label>
            <div className="chips">
              {roles.map((r) => (
                <button key={r.id} type="button"
                  className={`chip${roleIds.includes(Number(r.id)) ? ' on' : ''}`}
                  onClick={() => setRoleIds((x) => (x.includes(Number(r.id)) ? x.filter((i) => i !== Number(r.id)) : [...x, Number(r.id)]))}>
                  {r.name}
                </button>
              ))}
            </div>
            <div className="hint">Pick none and everyone in the branch/vertical above sees it.</div>
          </div>
          {err ? <div className="form-err" role="alert">{err}</div> : null}
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy || !title.trim()}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
