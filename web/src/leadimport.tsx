/**
 * Bulk CSV lead import (Marketing & Lead Management › Import Leads).
 *
 * Wizard: Upload -> Target -> Map columns -> Validate & preview -> Import + result.
 * (Target is chosen BEFORE the preview because duplicate detection, stage and
 * master resolution are all campaign-relative — you cannot validate a row until
 * you know which campaign it lands in.)
 *
 * Everything the server does is the shared ingestion pipeline; this screen only
 * drives it. Parsing is done server-side by ONE real RFC-4180 parser, so a
 * quoted field with commas/newlines previews exactly as it will import.
 */
import { useMemo, useRef, useState } from 'react';
import { api, getToken } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, TableCard } from './renderer';
import { toast, useFetch, useRef_ } from './refdata';
import { DateRange, DateRangeValue } from './daterange';

const MAX_BYTES = 5 * 1024 * 1024;

interface FieldDef { key: string; label: string; required?: boolean; hint?: string }
interface ParseResult {
  headers: string[]; total_rows: number; sample: Array<Record<string, string>>;
  mapping: Record<string, string>; fields: FieldDef[];
  custom_fields: Array<{ key: string; label: string }>;
}
interface PreviewRow {
  row_num: number; status: 'valid' | 'duplicate' | 'error';
  reason?: string; name?: string; phone?: string; duplicate_of?: number | null;
  action?: 'ignore' | 'create' | 'merge' | 'merge_and_reopen' | 'skip' | null;
  /** import course fix: the row imports, but a master value (e.g. Course) could not be resolved. */
  warning?: string;
}
interface PreviewResult {
  total: number; valid: number; duplicates: number; errors: number; warnings?: number;
  duplicate_action: string; duplicate_scope: string; distribution_mode: string;
  rows: PreviewRow[]; truncated: boolean;
}
interface Batch {
  id: number; file_name: string; status: string; total_rows: number;
  created_count: number; duplicate_count: number; skipped_count: number; failed_count: number;
  pending?: number; created_at: string; created_by_name?: string;
  campaign_name?: string; source_name?: string; branch_name?: string; vertical_name?: string;
  errors?: Array<{ row_num: number; reason: string }>;
}

const STEPS = ['Upload', 'Target', 'Map columns', 'Preview', 'Result'];

const DIST_LABEL: Record<string, string> = {
  equal: 'Equal (round-robin)', conditional: 'Conditional rules', on_demand: 'On demand (stays unassigned)',
};
const DUP_LABEL: Record<string, string> = {
  ignore: 'Ignore duplicate (row skipped, existing lead untouched)',
  create: 'Create duplicate lead (second lead, flagged & linked)',
  merge: 'Merge into the existing lead (blanks filled; conflicts keep the existing value)',
  merge_and_reopen: 'Merge & re-open closed leads',
};
/** The per-row badge: WHICH action this duplicate row will get. */
const ROW_ACTION: Record<string, [string, string]> = {
  ignore: ['Duplicate → Ignore', 'b-gray'],
  create: ['Duplicate → Create', 'b-amber'],
  merge: ['Duplicate → Merge', 'b-cyan'],
  merge_and_reopen: ['Duplicate → Merge & re-open', 'b-cyan'],
  skip: ['Duplicate in file', 'b-gray'],
};

/** Read a File as text. Blob.text() is not everywhere (older Safari, jsdom) — fall back. */
function readFile(f: File): Promise<string> {
  if (typeof (f as Blob).text === 'function') return (f as Blob).text();
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result ?? ''));
    r.onerror = () => rej(new Error('Could not read the file'));
    r.readAsText(f);
  });
}

/** Authenticated file download (the error CSV comes back as text/csv, not JSON). */
async function download(path: string, fallbackName: string) {
  const res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) { toast('Download failed', true); return; }
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') ?? '';
  const name = /filename="?([^"]+)"?/.exec(cd)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click();
  a.remove(); URL.revokeObjectURL(url);
}

/** Status badge for an import run. */
function statusBadge(status: string): [string, string] {
  if (status === 'done') return ['Completed', 'b-green'];
  if (status === 'failed') return ['Failed', 'b-rose'];
  if (status === 'running') return ['Running', 'b-amber'];
  return ['Queued', 'b-gray'];
}

/**
 * IMPORT HISTORY (client Aug 2026) — a proper, auditable, RBAC-scoped list of every import run
 * with per-run drill-down. Columns: File · Branch · Vertical · Campaign · Rows · Created ·
 * Duplicate · Failed · Uploaded by · When · Status. Expand a run to see the exact rows that did
 * NOT import, with the reason each failed, and download that as a CSV to fix and re-upload. The
 * shared DateRange control filters the list (server-side, created_at). Every row is already scoped
 * to the user's units by the backend, so a branch/campaign user only sees their own imports.
 */
function ImportHistoryTab() {
  const [range, setRange] = useState<DateRangeValue>({});
  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<Record<number, Batch>>({});
  const [loadingId, setLoadingId] = useState<number | null>(null);

  const qs = new URLSearchParams({ limit: '100' });
  if (range.from) qs.set('from', range.from);
  if (range.to) qs.set('to', range.to);
  const history = useFetch<Batch[]>(`/lead-imports?${qs.toString()}`, [range.from, range.to]);
  const rows = history.data ?? [];

  const toggle = async (b: Batch) => {
    if (openId === b.id) { setOpenId(null); return; }
    setOpenId(b.id);
    if (!detail[b.id]) {
      setLoadingId(b.id);
      try { const full = await api.get<Batch>(`/lead-imports/${b.id}`); setDetail((d) => ({ ...d, [b.id]: full })); }
      catch { toast('Could not load the import detail', true); }
      finally { setLoadingId(null); }
    }
  };

  const when = (iso: string) => new Date(iso).toLocaleString('en-IN',
    { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <>
      {/* DEF-06 — use the standard, compact .card-head (which sizes its h3 icon to 15px) instead of a
          bare .card-pad h3: an un-sized inline <svg viewBox> was rendering at the browser default
          (300x150), pushing the Runs table below the fold. The table is now the primary content at top. */}
      <div className="card"><div className="card-head" style={{ gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h3><Ic k="clock" /> Import History</h3>
          <p className="page-sub" style={{ margin: '4px 0 0' }}>Every import run in your scope. Expand a run to see and download the rows that did not import.</p>
        </div>
        <DateRange value={range} onChange={setRange} idPrefix="imp" />
      </div></div>

      <div className="card">
        <div className="card-head"><h3><Ic k="list" />Runs</h3>
          <span className="more">{rows.length} run{rows.length === 1 ? '' : 's'}{history.loading ? ' · loading…' : ''}</span></div>
        <div className="scroll-x">
          <table className="tbl">
            <thead><tr>
              <th style={{ width: 28 }} /><th>File</th><th>Branch</th><th>Vertical</th><th>Campaign</th>
              <th>Rows</th><th>Created</th><th>Duplicate</th><th>Failed</th><th>Uploaded by</th><th>When</th><th>Status</th>
            </tr></thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td className="empty" colSpan={12}>No imports in this range — upload a CSV in the Import Leads tab.</td></tr>
              ) : rows.flatMap((b) => {
                const open = openId === b.id;
                const d = detail[b.id];
                const [lab, tone] = statusBadge(b.status);
                const main = (
                  <tr key={b.id} onClick={() => toggle(b)} style={{ cursor: 'pointer' }}>
                    <td><span className="mono">{open ? '▾' : '▸'}</span></td>
                    <td><span className="nm">{b.file_name}</span></td>
                    <td>{b.branch_name ?? '—'}</td>
                    <td>{b.vertical_name ?? '—'}</td>
                    <td>{b.campaign_name ?? '—'}</td>
                    <td><span className="mono">{b.total_rows}</span></td>
                    <td><span className="mono">{b.created_count}</span></td>
                    <td><span className="mono">{b.duplicate_count}</span></td>
                    <td><span className="mono">{b.failed_count}</span></td>
                    <td>{b.created_by_name ?? '—'}</td>
                    <td>{when(b.created_at)}</td>
                    <td><span className={`bdg ${tone}`}>{lab}</span></td>
                  </tr>
                );
                if (!open) return [main];
                const detailRow = (
                  <tr key={`${b.id}-d`}><td colSpan={12} style={{ background: 'var(--surface-2, var(--surface-3))', padding: 14 }}>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                      <span className="sub">Source: <b>{d?.source_name ?? b.source_name ?? '—'}</b></span>
                      <span className="sub" style={{ marginLeft: 12 }}>Skipped (already imported): <b>{b.skipped_count}</b></span>
                      {b.failed_count > 0 && (
                        <button className="btn" style={{ marginLeft: 'auto' }}
                          onClick={(e) => { e.stopPropagation(); void download(`/lead-imports/${b.id}/errors.csv`, `${b.file_name}-errors.csv`); }}>
                          <Ic k="export" />Download failed rows ({b.failed_count})
                        </button>
                      )}
                    </div>
                    {loadingId === b.id && !d ? (
                      <div className="empty-note">Loading failed rows…</div>
                    ) : b.failed_count === 0 ? (
                      <div className="empty-note">Every row imported — no failed rows for this run.</div>
                    ) : (
                      <table className="tbl">
                        <thead><tr><th style={{ width: 60 }}>Row</th><th>Reason it was not imported</th></tr></thead>
                        <tbody>
                          {(d?.errors ?? []).map((er) => (
                            <tr key={er.row_num}><td><span className="mono">{er.row_num}</span></td><td>{er.reason}</td></tr>
                          ))}
                          {d && (d.errors?.length ?? 0) === 0 && (
                            <tr><td colSpan={2} className="empty">Loading…</td></tr>
                          )}
                          {d && (d.errors?.length ?? 0) < b.failed_count && (d.errors?.length ?? 0) > 0 && (
                            <tr><td colSpan={2} className="sub">Showing the first {d?.errors?.length} of {b.failed_count} — download the CSV for all.</td></tr>
                          )}
                        </tbody>
                      </table>
                    )}
                  </td></tr>
                );
                return [main, detailRow];
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

export default function LeadImport() {
  const { can } = useAuth();
  const ref = useRef_();
  const fileInput = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState(0);
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [target, setTarget] = useState<{ branch?: number; vertical?: number; pipeline?: number; campaign?: number; source?: number }>({});
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);

  const [view, setView] = useState<'import' | 'history'>('import');
  const canImport = can('lead.import');

  /* ---------------------------- step 1: upload ---------------------------- */
  const onFile = async (f: File) => {
    setErr('');
    if (!/\.csv$/i.test(f.name)) { setErr('Choose a .csv file (export from Excel / Google Sheets as CSV).'); return; }
    if (f.size > MAX_BYTES) { setErr(`That file is ${(f.size / 1048576).toFixed(1)} MB — the limit is 5 MB per import. Split it and import in parts.`); return; }
    const text = await readFile(f);
    setBusy(true);
    try {
      const p = await api.post<ParseResult>('/lead-imports/parse', { csv: text });
      setCsv(text); setFileName(f.name); setParsed(p); setMapping(p.mapping); setPreview(null); setBatch(null);
      setStep(1);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  /* ------------------------------ step 3->4 ------------------------------- */
  const runPreview = async () => {
    setErr(''); setBusy(true);
    try {
      const p = await api.post<PreviewResult>('/lead-imports/preview', {
        csv, mapping, campaign_id: target.campaign, source_id: target.source,
      });
      setPreview(p); setStep(3);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const startImport = async () => {
    setErr(''); setBusy(true);
    try {
      const b = await api.post<Batch>('/lead-imports', {
        csv, mapping, campaign_id: target.campaign, source_id: target.source, file_name: fileName,
      });
      setBatch(b); setStep(4); setTick((t) => t + 1);
      poll(b.id);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  /** Progress polling — the worker drains the queue asynchronously. */
  const poll = (id: number) => {
    let tries = 0;
    const t = setInterval(async () => {
      tries++;
      try {
        const b = await api.get<Batch>(`/lead-imports/${id}`);
        setBatch(b);
        if ((b.status === 'done' || b.status === 'failed') || tries > 150) {
          clearInterval(t); setBusy(false); setTick((x) => x + 1);
        }
      } catch { clearInterval(t); setBusy(false); }
    }, 1200);
  };

  const reset = () => {
    setStep(0); setCsv(''); setFileName(''); setParsed(null); setMapping({});
    setPreview(null); setBatch(null); setErr('');
    if (fileInput.current) fileInput.current.value = '';
  };

  /* ------------------------------ derived --------------------------------- */
  const verticals = ref.verticals.filter((v) => !target.branch || Number(v.branch_id) === target.branch);
  const pipelines = ref.pipelines.filter((p) => !target.vertical || Number(p.vertical_id) === target.vertical);
  const campaigns = ref.campaigns.filter((c) => !target.pipeline || Number(c.pipeline_id) === target.pipeline);
  const sources = ref.sources.filter((s) => !target.campaign || Number(s.campaign_id) === target.campaign);

  const allTargets = useMemo(() => [
    ...(parsed?.fields ?? []),
    ...(parsed?.custom_fields ?? []).map((c) => ({ key: c.key, label: `${c.label} (custom)` })),
  ], [parsed]);

  const mapErrors = useMemo(() => {
    const t = Object.values(mapping).filter(Boolean);
    const out: string[] = [];
    if (!t.includes('full_name')) out.push('Map a column to Name.');
    if (!t.includes('phone')) out.push('Map a column to Mobile Number.');
    const dupes = t.filter((x, i) => t.indexOf(x) !== i);
    if (dupes.length) out.push(`Two columns point at the same field (${[...new Set(dupes)].join(', ')}).`);
    return out;
  }, [mapping]);

  const targetReady = !!target.campaign && !!target.source;

  if (!canImport) {
    return <div className="card"><div className="empty-note">You do not have permission to import leads.</div></div>;
  }

  /* ------------------------------- render --------------------------------- */
  const sel = (label: string, icon: string, value: number | undefined, list: Array<{ id: number; name: string }>,
    set: (v?: number) => void, disabled?: boolean) => (
    <div className="fld" key={label}>
      <label>{label} <span className="star">*</span></label>
      <select className="ainp" aria-label={label} value={value ?? ''} disabled={disabled}
        onChange={(e) => set(e.target.value ? Number(e.target.value) : undefined)}>
        <option value="">Select {label}…</option>
        {list.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </div>
  );

  return (
    <>
      {/* Import Leads has two views: the upload wizard, and a full auditable History (client Aug 2026). */}
      <div className="tabs" style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button className={`fchip${view === 'import' ? ' on' : ''}`} onClick={() => setView('import')}>Import Leads</button>
        <button className={`fchip${view === 'history' ? ' on' : ''}`} onClick={() => setView('history')}>History</button>
      </div>

      {view === 'history' && <ImportHistoryTab />}

      {view === 'import' && (
      <>
      {/* stepper */}
      <div className="card">
        <div className="card-pad">
          <div className="stepper">
            {STEPS.map((s, i) => (
              <div key={s} style={{ display: 'flex', alignItems: 'center' }}>
                {i > 0 && <div className={`step-line ${i <= step ? 'done' : ''}`} />}
                <div className={`step ${i === step ? 'active' : i < step ? 'done' : ''}`}
                  onClick={() => { if (i < step) setStep(i); }}>
                  <div className="sd">{i < step ? '✓' : i + 1}</div>
                  <div className="sl">{s}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {err && <div className="form-err" role="alert">{err}</div>}

      {/* ---------------------------- 1. upload ---------------------------- */}
      {step === 0 && (
        <div className="card">
          <div className="card-head"><h3><Ic k="export" />Upload a CSV</h3>
            <span className="more"><a className="mlink" style={{ cursor: 'pointer' }}
              onClick={() => download('/lead-imports/template', 'lead-import-template.csv')}>Download template</a></span>
          </div>
          <div className="card-pad">
            <p className="page-sub" style={{ marginBottom: 14 }}>
              Export your sheet as <b>CSV</b>. Quoted fields (commas or line breaks inside a value) are handled.
              Maximum 5 MB / 20,000 rows per import — leads are assigned by the campaign's distribution rule.
            </p>
            <input ref={fileInput} type="file" accept=".csv,text/csv" aria-label="CSV file"
              className="ainp" disabled={busy}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); }} />
          </div>
        </div>
      )}

      {/* ---------------------------- 2. target ---------------------------- */}
      {step === 1 && parsed && (
        <div className="card">
          <div className="card-head"><h3><Ic k="branch" />Where do these leads land?</h3>
            <span className="more">{parsed.total_rows} rows · {fileName}</span></div>
          <div className="form-grid">
            {sel('Branch', 'branch', target.branch, ref.branches, (v) => setTarget({ branch: v }))}
            {sel('Vertical', 'grid', target.vertical, verticals, (v) => setTarget((t) => ({ ...t, vertical: v, pipeline: undefined, campaign: undefined, source: undefined })), !target.branch)}
            {sel('Pipeline', 'list', target.pipeline, pipelines, (v) => setTarget((t) => ({ ...t, pipeline: v, campaign: undefined, source: undefined })), !target.vertical)}
            {sel('Campaign', 'bolt', target.campaign, campaigns, (v) => setTarget((t) => ({ ...t, campaign: v, source: undefined })), !target.pipeline)}
            {sel('Source', 'leads', target.source, sources, (v) => setTarget((t) => ({ ...t, source: v })), !target.campaign)}
          </div>
          <div className="card-pad" style={{ display: 'flex', gap: 8, borderTop: '1px solid var(--border)' }}>
            <button className="btn ghost" onClick={reset}>Back</button>
            <button className="btn primary" disabled={!targetReady} onClick={() => setStep(2)}>
              Next: map columns<Ic k="chev" />
            </button>
          </div>
        </div>
      )}

      {/* -------------------------- 3. map columns -------------------------- */}
      {step === 2 && parsed && (
        <div className="card">
          <div className="card-head"><h3><Ic k="link" />Map your columns</h3>
            <span className="more">{parsed.headers.length} columns · auto-mapped by header name</span></div>
          <div className="scroll-x">
            <table className="tbl">
              <thead><tr><th>CSV column</th><th>First value</th><th>Import into</th></tr></thead>
              <tbody>
                {parsed.headers.map((h) => (
                  <tr key={h}>
                    <td><span className="nm">{h}</span></td>
                    <td><span className="mono sub">{parsed.sample[0]?.[h] || '—'}</span></td>
                    <td>
                      <select className="ainp" aria-label={`Map ${h}`} value={mapping[h] ?? ''}
                        onChange={(e) => setMapping((m) => ({ ...m, [h]: e.target.value }))}>
                        <option value="">— Ignore this column —</option>
                        {allTargets.map((f) => (
                          <option key={f.key} value={f.key}>{f.label}{(f as FieldDef).required ? ' *' : ''}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card-pad" style={{ borderTop: '1px solid var(--border)' }}>
            {mapErrors.length > 0 && <div className="form-err">{mapErrors.join(' ')}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn ghost" onClick={() => setStep(1)}>Back</button>
              <button className="btn primary" disabled={busy || mapErrors.length > 0} onClick={runPreview}>
                {busy ? 'Validating…' : 'Validate & preview'}<Ic k="check" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------------------------- 4. preview ---------------------------- */}
      {step === 3 && preview && (
        <>
          <div className="kpi-strip" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
            {([
              ['Rows in file', preview.total, 'list', 'indigo'],
              ['Will be created', preview.valid, 'check', 'green'],
              ['Duplicates', preview.duplicates, 'refresh', 'amber'],
              ['Rows with errors', preview.errors, 'bolt', 'rose'],
            ] as Array<[string, number, string, string]>).map(([lab, val, ic, tone]) => (
              <div className="card kpi" key={lab}>
                <div className={`ic ${tone}`}><Ic k={ic} /></div>
                <div className="lab">{lab}</div>
                <div className="val">{val}</div>
              </div>
            ))}
          </div>
          <div className="notice">
            <Ic k="bolt" />
            <div>
              Campaign rules that will apply: duplicates checked <b>{preview.duplicate_scope.replace(/_/g, ' ')}</b> by phone
              → <b>{DUP_LABEL[preview.duplicate_action] ?? preview.duplicate_action}</b>.
              Assignment: <b>{DIST_LABEL[preview.distribution_mode] ?? preview.distribution_mode}</b>.
              Rows with errors are <b>not</b> imported — you can download them afterwards, fix and re-upload.
              {!!preview.warnings && (
                <> <b>{preview.warnings}</b> row{preview.warnings === 1 ? '' : 's'} reference a Course (or other master)
                that is not configured for this Branch › Vertical — those leads still import, and the value is kept
                on the lead note so nothing is lost.</>
              )}
            </div>
          </div>
          <TableCard title="Row-by-row validation" icon="check"
            more={preview.truncated ? `first ${preview.rows.length} of ${preview.total} rows` : `${preview.rows.length} rows`}
            cols={['Row', 'Name', 'Phone', 'Result', 'Detail']}
            rows={preview.rows.map((r): Cell[] => [
              { mono: String(r.row_num) },
              r.name || '—', r.phone || '—',
              {
                b: r.status === 'valid' ? (r.warning ? ['Imported · note', 'b-amber'] : ['Valid', 'b-green'])
                  : r.status === 'duplicate' ? (ROW_ACTION[r.action ?? 'ignore'] ?? ['Duplicate', 'b-amber'])
                  : ['Error', 'b-rose'],
              },
              r.warning || r.reason || '—',
            ])} />
          <div className="card"><div className="card-pad" style={{ display: 'flex', gap: 8 }}>
            <button className="btn ghost" onClick={() => setStep(2)}>Back to mapping</button>
            <button className="btn primary" disabled={busy || preview.valid + preview.duplicates === 0} onClick={startImport}>
              {busy ? 'Importing…' : `Import ${preview.total - preview.errors} row${preview.total - preview.errors === 1 ? '' : 's'}`}<Ic k="check" />
            </button>
          </div></div>
        </>
      )}

      {/* ----------------------------- 5. result ---------------------------- */}
      {step === 4 && batch && (
        <>
          <div className="kpi-strip" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
            {([
              ['Created', batch.created_count, 'check', 'green'],
              ['Duplicates', batch.duplicate_count, 'refresh', 'amber'],
              ['Skipped (already imported)', batch.skipped_count, 'clock', 'cyan'],
              ['Failed', batch.failed_count, 'bolt', 'rose'],
            ] as Array<[string, number, string, string]>).map(([lab, val, ic, tone]) => (
              <div className="card kpi" key={lab}>
                <div className={`ic ${tone}`}><Ic k={ic} /></div>
                <div className="lab">{lab}</div>
                <div className="val">{val ?? 0}</div>
              </div>
            ))}
          </div>
          <div className="card">
            <div className="card-head"><h3><Ic k="check" />{fileName || batch.file_name}</h3>
              <span className="more">{batch.status === 'done' ? 'Import complete' : batch.status === 'failed' ? 'Import failed' : `Importing… ${batch.pending ?? 0} rows left`}</span></div>
            <div className="card-pad">
              <div className="track" style={{ height: 8, background: 'var(--surface-3)', borderRadius: 20, overflow: 'hidden' }}>
                <div style={{
                  height: '100%', borderRadius: 20, background: 'var(--primary)', transition: 'width .3s',
                  width: `${batch.total_rows ? Math.round(((batch.total_rows - (batch.pending ?? 0)) / batch.total_rows) * 100) : 100}%`,
                }} />
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
                {batch.failed_count > 0 && (
                  <button className="btn" onClick={() => download(`/lead-imports/${batch.id}/errors.csv`, 'import-errors.csv')}>
                    <Ic k="export" />Download error CSV ({batch.failed_count})
                  </button>
                )}
                <button className="btn ghost" onClick={reset}><Ic k="plus" />Import another file</button>
              </div>
            </div>
          </div>
          {!!batch.errors?.length && (
            <TableCard title="Failed rows" icon="bolt" cols={['Row', 'Reason']}
              more={`${batch.failed_count} failed`}
              rows={batch.errors.map((e): Cell[] => [{ mono: String(e.row_num) }, e.reason])} />
          )}
        </>
      )}

      </>
      )}
    </>
  );
}
