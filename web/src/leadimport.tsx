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
}
interface PreviewResult {
  total: number; valid: number; duplicates: number; errors: number;
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
  ignore: 'Ignore duplicate (row skipped)', create: 'Create duplicate lead (flagged)',
  merge: 'Merge (flagged — merge engine lands next)', merge_and_reopen: 'Merge & reopen (flagged — merge engine lands next)',
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

  const history = useFetch<Batch[]>('/leads/import?limit=25', [tick]);
  const canImport = can('lead.import');

  /* ---------------------------- step 1: upload ---------------------------- */
  const onFile = async (f: File) => {
    setErr('');
    if (!/\.csv$/i.test(f.name)) { setErr('Choose a .csv file (export from Excel / Google Sheets as CSV).'); return; }
    if (f.size > MAX_BYTES) { setErr(`That file is ${(f.size / 1048576).toFixed(1)} MB — the limit is 5 MB per import. Split it and import in parts.`); return; }
    const text = await readFile(f);
    setBusy(true);
    try {
      const p = await api.post<ParseResult>('/leads/import/parse', { csv: text });
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
      const p = await api.post<PreviewResult>('/leads/import/preview', {
        csv, mapping, campaign_id: target.campaign, source_id: target.source,
      });
      setPreview(p); setStep(3);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const startImport = async () => {
    setErr(''); setBusy(true);
    try {
      const b = await api.post<Batch>('/leads/import', {
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
        const b = await api.get<Batch>(`/leads/import/${id}`);
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
              onClick={() => download('/leads/import/template', 'lead-import-template.csv')}>Download template</a></span>
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
            </div>
          </div>
          <TableCard title="Row-by-row validation" icon="check"
            more={preview.truncated ? `first ${preview.rows.length} of ${preview.total} rows` : `${preview.rows.length} rows`}
            cols={['Row', 'Name', 'Phone', 'Result', 'Detail']}
            rows={preview.rows.map((r): Cell[] => [
              { mono: String(r.row_num) },
              r.name || '—', r.phone || '—',
              { b: r.status === 'valid' ? ['Valid', 'b-green'] : r.status === 'duplicate' ? ['Duplicate', 'b-amber'] : ['Error', 'b-rose'] },
              r.reason || '—',
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
                  <button className="btn" onClick={() => download(`/leads/import/${batch.id}/errors.csv`, 'import-errors.csv')}>
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

      {/* --------------------------- import history -------------------------- */}
      <TableCard title="Import History" icon="clock"
        cols={['File', 'Branch · Vertical', 'Campaign · Source', 'Rows', 'Created', 'Duplicate', 'Failed', 'By', 'When', 'Status']}
        rows={(history.data ?? []).map((b): Cell[] => [
          { node: <span className="nm">{b.file_name}</span> },
          `${b.branch_name ?? '—'} · ${b.vertical_name ?? '—'}`,
          `${b.campaign_name ?? '—'} · ${b.source_name ?? '—'}`,
          { mono: String(b.total_rows) },
          { mono: String(b.created_count) },
          { mono: String(b.duplicate_count) },
          { mono: String(b.failed_count) },
          b.created_by_name ?? '—',
          new Date(b.created_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
          { b: b.status === 'done' ? ['Done', 'b-green'] : b.status === 'failed' ? ['Failed', 'b-rose'] : ['Running', 'b-amber'] },
        ])}
        empty="No imports yet — upload a CSV above" />
    </>
  );
}
