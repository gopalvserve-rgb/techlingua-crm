/**
 * Administration › API — the Developer / API module.
 *
 * Four things the client asked for, in three tabs:
 *   (a) API Keys        — generate (shown ONCE), enable/disable, revoke.
 *   (b) Documentation   — the endpoints a key can call, with examples.
 *   (c) Request Log      — every inbound key-authed call, accepted or rejected.
 *   (d) Enable/Disable   — the toggle on each key row.
 *
 * Admin-only (api.read / api.manage). The keys authenticate the public
 * /api/public-api/* endpoints; create-lead there flows through the same
 * ingestion pipeline as every capture channel.
 */
import { useMemo, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, TableCard } from './renderer';
import { toast, useFetch, useRef_ } from './refdata';

interface ApiKey {
  id: number; name: string; key_masked: string; key_prefix: string;
  scopes: string[]; record_scope: string;
  default_campaign_id: number | null; default_source_id: number | null;
  default_campaign_name: string | null; default_source_name: string | null;
  is_active: boolean; revoked: boolean; status: 'active' | 'disabled' | 'revoked';
  last_used_at: string | null; created_at: string;
  calls_total?: number; calls_failed?: number;
}
interface ApiLog {
  id: number; method: string; endpoint: string; status_code: number; outcome: string;
  reason?: string | null; ip?: string | null; lead_id?: number | null; duration_ms?: number | null;
  created_at: string; key_prefix?: string | null; key_name?: string | null;
}
interface DocParam { name: string; required: boolean; note: string }
interface DocEndpoint {
  method: string; path: string; summary: string; description: string;
  headers: string[]; params?: DocParam[]; exampleRequest?: unknown; exampleResponse: unknown;
}
interface ApiDocs { base_url: string; auth: string; rate_limit: string; endpoints: DocEndpoint[] }

const STATUS_BADGE: Record<string, [string, string]> = {
  active: ['Enabled', 'b-green'],
  disabled: ['Disabled', 'b-gray'],
  revoked: ['Revoked', 'b-rose'],
};

const fmt = (s?: string | null) =>
  !s ? '—' : new Date(s).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function copy(text: string, what: string) {
  const nav = (navigator as Navigator & { clipboard?: { writeText(t: string): Promise<void> } });
  if (nav.clipboard?.writeText) { void nav.clipboard.writeText(text).then(() => toast(`${what} copied`), () => toast('Copy failed', true)); return; }
  toast(`${what} copied`);
}

/* ------------------------------------------------------------ generate modal */

function GenerateModal({ onClose, onGenerated }: { onClose: () => void; onGenerated: (k: ApiKey & { plaintext: string }) => void }) {
  const ref = useRef_();
  const [name, setName] = useState('');
  const [campaign, setCampaign] = useState<number | undefined>();
  const [source, setSource] = useState<number | undefined>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const sources = ref.sources.filter((s) => !campaign || Number(s.campaign_id) === campaign);

  const save = async () => {
    setErr(''); setBusy(true);
    try {
      const k = await api.post<ApiKey & { plaintext: string }>('/api-keys', {
        name, default_campaign_id: campaign, default_source_id: source,
      });
      onGenerated(k);
      onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ width: 600 }}>
        <div className="ah">
          <h3><Ic k="shield" />Generate API key</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          <div className="notice">
            <Ic k="bolt" />
            <div>The full key is shown <b>once</b>, right after you create it — copy it then. We store only a hash and can never show it again. A key can create and read leads through the public API.</div>
          </div>
          {err && <div className="form-err" role="alert">{err}</div>}
          <div className="form-grid">
            <div className="fld span2">
              <label>Key name <span className="star">*</span></label>
              <input className="ainp" aria-label="Key name" placeholder="e.g. Partner website integration"
                value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="fld">
              <label>Default campaign</label>
              <select className="ainp" aria-label="Default campaign" value={campaign ?? ''}
                onChange={(e) => { setCampaign(e.target.value ? Number(e.target.value) : undefined); setSource(undefined); }}>
                <option value="">— none (caller must send campaign_id) —</option>
                {ref.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="fld">
              <label>Default source</label>
              <select className="ainp" aria-label="Default source" value={source ?? ''} disabled={!campaign}
                onChange={(e) => setSource(e.target.value ? Number(e.target.value) : undefined)}>
                <option value="">— none —</option>
                {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          </div>
          <span className="fhint" style={{ display: 'block', marginTop: 6 }}>
            A default campaign + source lets callers omit them when creating a lead. Leave blank to require them on every request.
          </span>
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !name.trim()} onClick={save}>
            {busy ? 'Generating…' : 'Generate key'}<Ic k="check" />
          </button>
        </div>
      </div>
    </div>
  );
}

/** The one-time reveal of a freshly generated key. */
function RevealCard({ apiKey, onDone }: { apiKey: ApiKey & { plaintext: string }; onDone: () => void }) {
  return (
    <div className="card" style={{ borderColor: 'var(--accent)' }}>
      <div className="card-head"><h3><Ic k="check" />Key “{apiKey.name}” created</h3></div>
      <div className="card-pad">
        <div className="notice" style={{ marginBottom: 10 }}>
          <Ic k="shield" />
          <div><b>Copy this now.</b> This is the only time the full key is shown. When you leave this screen it is gone for good — we store only a hash.</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="ainp mono" readOnly value={apiKey.plaintext} aria-label="API key"
            data-testid="new-api-key" style={{ flex: 1 }} onFocus={(e) => e.currentTarget.select()} />
          <button className="btn primary" type="button" onClick={() => copy(apiKey.plaintext, 'API key')}><Ic k="doc" />Copy</button>
          <button className="btn" type="button" onClick={onDone}>Done</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- keys tab */

function KeysTab({ canManage }: { canManage: boolean }) {
  const [tick, setTick] = useState(0);
  const [open, setOpen] = useState(false);
  const [reveal, setReveal] = useState<(ApiKey & { plaintext: string }) | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const keys = useFetch<ApiKey[]>('/api-keys', [tick]);
  const list = keys.data ?? [];
  const bump = () => setTick((t) => t + 1);

  const toggle = async (k: ApiKey) => {
    setBusyId(k.id);
    try {
      await api.patch(`/api-keys/${k.id}`, { is_active: !k.is_active });
      toast(k.is_active ? 'Key disabled' : 'Key enabled');
    } catch (e) { toast((e as Error).message, true); } finally { setBusyId(null); bump(); }
  };
  const revoke = async (k: ApiKey) => {
    if (!confirm(`Revoke “${k.name}”? Any integration using it stops working immediately and it cannot be re-enabled.`)) return;
    setBusyId(k.id);
    try { await api.del(`/api-keys/${k.id}`); toast('Key revoked'); }
    catch (e) { toast((e as Error).message, true); } finally { setBusyId(null); bump(); }
  };

  return (
    <>
      {canManage && (
        <div className="card">
          <div className="card-head">
            <h3><Ic k="shield" />API keys</h3>
            <button className="btn primary" onClick={() => setOpen(true)}><Ic k="plus" />Generate API key</button>
          </div>
          <div className="card-pad">
            <span className="fhint">Each key authenticates requests to the public API as <b>Authorization: Bearer &lt;key&gt;</b> (or <b>X-API-Key</b>). Disabled and revoked keys are rejected with 401.</span>
          </div>
        </div>
      )}

      {reveal && <RevealCard apiKey={reveal} onDone={() => setReveal(null)} />}

      <TableCard title="Keys" icon="shield" more={`${list.length} key(s)`}
        cols={['Name', 'Key', 'Scope', 'Leads land in', 'Status', 'Last used', 'Calls', '']}
        empty={canManage ? 'No API keys yet — generate one above' : 'No API keys yet'}
        rows={list.map((k): Cell[] => [
          { node: <div><span className="nm">{k.name}</span><div className="sub" style={{ fontSize: 11 }}>Created {fmt(k.created_at)}</div></div> },
          { mono: k.key_masked, dim: true },
          { node: <span className="sub" style={{ fontSize: 11.5 }}>{(k.scopes || []).join(', ') || '—'}</span> },
          { node: <span className="sub" style={{ fontSize: 11.5 }}>{k.default_campaign_name ? `${k.default_campaign_name} › ${k.default_source_name ?? '—'}` : 'caller must specify'}</span> },
          { b: STATUS_BADGE[k.status] ?? [k.status, 'b-gray'] },
          fmt(k.last_used_at),
          { mono: `${k.calls_total ?? 0}${k.calls_failed ? ` (${k.calls_failed} failed)` : ''}` },
          { node: (
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              {canManage && !k.revoked && (
                <button className="btn" disabled={busyId === k.id} onClick={() => toggle(k)}>
                  {k.is_active ? 'Disable' : 'Enable'}
                </button>
              )}
              {canManage && !k.revoked && (
                <button className="btn" disabled={busyId === k.id} onClick={() => revoke(k)}><Ic k="trash" />Revoke</button>
              )}
            </div>
          ) },
        ])} />

      {open && <GenerateModal onClose={() => setOpen(false)} onGenerated={(k) => { setReveal(k); bump(); }} />}
    </>
  );
}

/* -------------------------------------------------------------- docs tab */

function Json({ value }: { value: unknown }) {
  const text = JSON.stringify(value, null, 2);
  return (
    <div style={{ position: 'relative' }}>
      <button className="btn" type="button" style={{ position: 'absolute', top: 6, right: 6 }}
        onClick={() => copy(text, 'Example')}><Ic k="doc" />Copy</button>
      <pre className="mono" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 9,
        padding: 12, fontSize: 11.5, overflowX: 'auto', lineHeight: 1.6, whiteSpace: 'pre' }}>{text}</pre>
    </div>
  );
}

function DocsTab() {
  const docs = useFetch<ApiDocs>('/api-keys/docs');
  const d = docs.data;
  if (!d) return <div className="card"><div className="empty-note">Loading documentation…</div></div>;
  const origin = typeof location !== 'undefined' ? location.origin : '';
  return (
    <>
      <div className="card">
        <div className="card-head"><h3><Ic k="doc" />API documentation</h3></div>
        <div className="card-pad">
          <p style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.7 }}>{d.auth}</p>
          <div className="form-grid" style={{ marginTop: 8 }}>
            <div className="fld"><label>Base URL</label><input className="ainp mono" readOnly value={`${origin}${d.base_url}`} onFocus={(e) => e.currentTarget.select()} /></div>
            <div className="fld"><label>Rate limit</label><input className="ainp" readOnly value={d.rate_limit} /></div>
          </div>
        </div>
      </div>

      {d.endpoints.map((e) => (
        <div className="card" key={`${e.method} ${e.path}`}>
          <div className="card-head">
            <h3><span className={`bdg ${e.method === 'POST' ? 'b-amber' : 'b-green'}`} style={{ marginRight: 8 }}>{e.method}</span>
              <span className="mono">{e.path}</span></h3>
            <span className="more">{e.summary}</span>
          </div>
          <div className="card-pad">
            <p style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.7 }}>{e.description}</p>
            <h4 style={{ fontSize: 12, margin: '12px 0 6px' }}>Headers</h4>
            <pre className="mono" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 9, padding: 10, fontSize: 11.5, whiteSpace: 'pre-wrap' }}>{e.headers.join('\n')}</pre>
            {!!e.params?.length && (
              <>
                <h4 style={{ fontSize: 12, margin: '12px 0 6px' }}>Parameters</h4>
                <table className="mini-table"><tbody>
                  {e.params.map((p) => (
                    <tr key={p.name}>
                      <td className="mono" style={{ paddingRight: 12 }}>{p.name}{p.required ? <span className="star"> *</span> : null}</td>
                      <td style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{p.note}</td>
                    </tr>
                  ))}
                </tbody></table>
              </>
            )}
            {e.exampleRequest !== undefined && (<><h4 style={{ fontSize: 12, margin: '12px 0 6px' }}>Example request body</h4><Json value={e.exampleRequest} /></>)}
            <h4 style={{ fontSize: 12, margin: '12px 0 6px' }}>Example response</h4>
            <Json value={e.exampleResponse} />
            {e.method === 'POST' && (
              <>
                <h4 style={{ fontSize: 12, margin: '12px 0 6px' }}>curl</h4>
                <Json value={`curl -X POST ${origin}${e.path} \\\n  -H "Authorization: Bearer tlk_live_xxxxxxxx" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(e.exampleRequest ?? {})}'`} />
              </>
            )}
          </div>
        </div>
      ))}
    </>
  );
}

/* -------------------------------------------------------------- logs tab */

const LOG_BADGE: Record<string, [string, string]> = {
  ok: ['Success', 'b-green'],
  duplicate: ['Duplicate', 'b-cyan'],
  skipped: ['Skipped', 'b-gray'],
  rejected: ['Rejected', 'b-rose'],
  failed: ['Failed', 'b-rose'],
};

function LogsTab() {
  const [status, setStatus] = useState<'' | 'ok' | 'failed'>('');
  const [since, setSince] = useState('');
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (status) p.set('status', status);
    if (since) p.set('since', since);
    p.set('limit', '200');
    return p.toString();
  }, [status, since]);
  const logs = useFetch<ApiLog[]>(`/api-keys/logs?${qs}`, [qs]);
  const rows = logs.data ?? [];

  return (
    <>
      <div className="card">
        <div className="card-head"><h3><Ic k="clock" />Request log</h3><span className="more">every inbound API call — accepted or rejected</span></div>
        <div className="card-pad">
          <div className="form-grid">
            <div className="fld">
              <label>Status</label>
              <select className="ainp" aria-label="Status filter" value={status} onChange={(e) => setStatus(e.target.value as '' | 'ok' | 'failed')}>
                <option value="">All</option>
                <option value="ok">Success (2xx/3xx)</option>
                <option value="failed">Failed / rejected (4xx/5xx)</option>
              </select>
            </div>
            <div className="fld">
              <label>Since</label>
              <input className="ainp" type="date" aria-label="Since date" value={since} onChange={(e) => setSince(e.target.value)} />
            </div>
          </div>
        </div>
      </div>

      <TableCard title="Requests" icon="clock" more={`${rows.length} shown`}
        cols={['When', 'Key', 'Method', 'Endpoint', 'Status', 'Result', 'Detail']}
        empty="No API requests yet — the first key-authed call will appear here"
        rows={rows.map((l): Cell[] => [
          fmt(l.created_at),
          { node: <span className="sub" style={{ fontSize: 11.5 }}>{l.key_name ?? (l.key_prefix ? `${l.key_prefix}…` : '—')}</span> },
          { mono: l.method },
          { mono: l.endpoint, dim: true },
          { node: <span className={`bdg ${l.status_code >= 400 ? 'b-rose' : 'b-green'}`}>{l.status_code}</span> },
          { b: LOG_BADGE[l.outcome] ?? [l.outcome, 'b-gray'] },
          { node: <span className="sub" style={{ fontSize: 11.5 }}>{l.lead_id ? `Lead #${l.lead_id} · ` : ''}{l.reason || '—'}</span> },
        ])} />
    </>
  );
}

/* --------------------------------------------------------------- screen */

const TABS: Array<[string, string]> = [['keys', 'API Keys'], ['docs', 'Documentation'], ['logs', 'Request Log']];

export default function ApiModule() {
  const { can } = useAuth();
  const [tab, setTab] = useState<'keys' | 'docs' | 'logs'>('keys');
  const canRead = can('api.read');
  const canManage = can('api.manage');

  if (!canRead) {
    return <div className="card"><div className="empty-note">You do not have permission to view API access. This module is Super Admin / Organization Admin only.</div></div>;
  }

  return (
    <>
      <div className="notice">
        <Ic k="bolt" />
        <div>
          Give another system an <b>API key</b> to push and read leads over HTTP. A key-authed
          <b> create-lead</b> flows through the <b>same ingestion pipeline</b> as every capture channel —
          dedup, distribution and audit are inherited. Every call is logged below, and a key can be
          <b> disabled or revoked</b> instantly.
        </div>
      </div>

      <div className="seg" style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {TABS.map(([id, label]) => (
          <button key={id} className={`btn ${tab === id ? 'primary' : ''}`} onClick={() => setTab(id as 'keys' | 'docs' | 'logs')}>{label}</button>
        ))}
      </div>

      {tab === 'keys' && <KeysTab canManage={canManage} />}
      {tab === 'docs' && <DocsTab />}
      {tab === 'logs' && <LogsTab />}
    </>
  );
}
