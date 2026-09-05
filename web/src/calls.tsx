/**
 * CALLS — the real call pipeline UI (Call-Tracking Blueprint, client Sep 2026).
 *
 * Replaces the old "telephony out of scope — design reference only" Calls screens with
 * live data from the /api/calls endpoints:
 *   · Call Logs   — every call (authoritative call-log import + live dial events), RBAC-scoped,
 *                   with duration, SIM, source badge, recording playback and a disposition log.
 *   · Recordings  — the synced OEM call recordings, playable inline.
 *   · Call Settings — per-user: tracking on/off, SIM slots, recording folder, sync intervals,
 *                   plus a tap-to-dial tester and the mobile-app explainer.
 *   · LeadCallsTab — embeddable call history + a Call button (tap-to-dial) for the lead detail.
 *
 * Live phone-state rows are a fast preview; the phone's own call log is the source of truth
 * (src badge: Live / Call log / Repaired). live-dup rows are hidden server-side.
 * Follows the existing design system (kpi strip / filters / TableCard / add-modal).
 */
import { useEffect, useMemo, useState } from 'react';
import { api, getToken } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, Kpis, TableCard } from './renderer';
import { toast, useFetch } from './refdata';
import { deviceSyncNow } from './callsync';

const dttime = (v: unknown) => v
  ? new Date(String(v)).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '—';
const fmtDur = (s: unknown) => {
  const n = Math.max(0, Math.round(Number(s) || 0));
  if (!n) return '—';
  const m = Math.floor(n / 60), r = n % 60;
  return m ? `${m}m ${r}s` : `${r}s`;
};
const dirBadge = (d: string): Cell => {
  const map: Record<string, [string, string]> = {
    in: ['Incoming', 'b-green'], out: ['Outgoing', 'b-indigo'],
    missed: ['Missed', 'b-rose'], unknown: ['—', 'b-gray'],
  };
  const [l, c] = map[d] ?? [d, 'b-gray']; return { b: [l, c] };
};
const srcBadge = (s: string | null): Cell => {
  if (s === 'calllog') return { b: ['Call log', 'b-green'] };
  if (s === 'calllog-fix') return { b: ['Repaired', 'b-amber'] };
  if (s == null) return { b: ['Live', 'b-gray'] };
  return { b: [s, 'b-gray'] };
};

/* ------------------------------------------------------------- recording player */

export function RecordingPlayer({ id }: { id: number }) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true);
    try {
      const r = await api.get<{ url: string | null; mode: string }>(`/calls/recording/${id}/url`);
      if (r.url) { setUrl(r.url); return; }
      // DB fallback — fetch the bytes with auth, wrap in a blob URL
      const res = await fetch(`/api/calls/recording/${id}/stream`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new Error('Playback unavailable');
      setUrl(URL.createObjectURL(await res.blob()));
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  if (url) return <audio src={url} controls style={{ height: 32, maxWidth: 240 }} />;
  return (
    <button className="btn-mini" disabled={busy} onClick={load}>
      <Ic k="send" /> {busy ? 'Loading…' : 'Play'}
    </button>
  );
}

/* ------------------------------------------------------------- disposition modal */

function DispositionModal({ callId, onClose, onDone }: { callId: number; onClose: () => void; onDone: () => void }) {
  const { data } = useFetch<{ dispositions: Array<{ id: number; name: string }> }>('/calls/meta', []);
  const [dispId, setDispId] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/calls/${callId}/disposition`, { disposition_id: dispId ? Number(dispId) : null, note: note.trim() || null });
      toast('Disposition logged'); onDone(); onClose();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 460 }}>
        <div className="ahead"><h3><Ic k="calls" /> Log call disposition</h3><button className="x" onClick={onClose}><Ic k="x" /></button></div>
        <div className="abody">
          <label className="fld"><span>Disposition</span>
            <select value={dispId} onChange={(e) => setDispId(e.target.value)}>
              <option value="">— select —</option>
              {(data?.dispositions ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
          <label className="fld"><span>Note</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="Optional remark for this call" />
          </label>
        </div>
        <div className="afoot">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={busy || (!dispId && !note.trim())} onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- shared list hook */

interface CallRow {
  id: number; lead_id: number | null; lead_name: string | null; phone_number: string; phone_raw: string | null;
  direction: string; event: string; duration_s: number; call_start_at: string | null; created_at: string;
  sim_label: string | null; src: string | null; recording_id: number | null;
  disposition_id: number | null; disposition_name: string | null; user_name: string | null;
}

function useCalls(query: string) {
  return useFetch<{ rows: CallRow[] }>('/calls' + query, [query]);
}

/* ------------------------------------------------------------------ Call Logs */

export default function CallLogs() {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [dir, setDir] = useState('');
  const [hasRec, setHasRec] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [disp, setDisp] = useState<number | null>(null);
  const sumF = useFetch<{ calls_today: number; connected: number; avg_duration: number; recordings: number }>('/calls/summary', []);
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (q.trim()) p.set('q', q.trim());
    if (dir) p.set('direction', dir);
    if (hasRec) p.set('has_recording', 'true');
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    const s = p.toString(); return s ? `?${s}` : '';
  }, [q, dir, hasRec, from, to]);
  const { data, loading, reload } = useCalls(qs);
  const rows = data?.rows ?? [];
  const s = sumF.data;

  const cols = ['Time', 'Lead / Contact', 'Phone', 'Direction', 'Duration', 'SIM', 'Counsellor', 'Disposition', 'Source', 'Recording', 'Action'];
  const body: Cell[][] = rows.map((r) => [
    dttime(r.call_start_at || r.created_at),
    r.lead_name ? { node: <a className="lnk" href={`/m/leads/leadsAll?id=${r.lead_id}`}>{r.lead_name}</a> } : { mono: '—', dim: true },
    { mono: r.phone_raw || r.phone_number || '—' },
    dirBadge(r.direction),
    fmtDur(r.duration_s),
    r.sim_label || '—',
    r.user_name || '—',
    r.disposition_name ? { b: [r.disposition_name, 'b-indigo'] } : ('—' as Cell),
    srcBadge(r.src),
    r.recording_id ? { node: <RecordingPlayer id={r.recording_id} /> } : ('—' as Cell),
    { node: can('calls.act') ? <button className="btn-mini" onClick={() => setDisp(r.id)}><Ic k="pencil" /> Disposition</button> : <>—</> },
  ]);

  return (
    <div className="main main--list">
      <div className="card toolbar-surface">
        <div className="filter-row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input className="inp" placeholder="Search name / phone" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 180 }} />
          <select className="inp" value={dir} onChange={(e) => setDir(e.target.value)}>
            <option value="">All directions</option>
            <option value="in">Incoming</option><option value="out">Outgoing</option><option value="missed">Missed</option>
          </select>
          <label className="chk" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={hasRec} onChange={(e) => setHasRec(e.target.checked)} /> With recording
          </label>
          <input className="inp" type="date" value={from} onChange={(e) => setFrom(e.target.value)} title="From" />
          <input className="inp" type="date" value={to} onChange={(e) => setTo(e.target.value)} title="To" />
          <button className="btn ghost" onClick={reload}><Ic k="refresh" /> Refresh</button>
        </div>
      </div>
      <Kpis cols={4} items={[
        { lab: "Calls today", val: String(s?.calls_today ?? 0), ic: 'calls' },
        { lab: 'Connected', val: String(s?.connected ?? 0), ic: 'check' },
        { lab: 'Avg duration', val: fmtDur(s?.avg_duration ?? 0), ic: 'clock' },
        { lab: 'Recordings', val: String(s?.recordings ?? 0), ic: 'calls' },
      ]} />
      <TableCard title={loading ? 'Call logs — loading…' : `Call logs (${rows.length})`} icon="calls"
        cols={cols} rows={body} fill listKey="callLogs"
        empty="No calls yet. Calls sync automatically from the mobile app's call log." />
      {disp != null && <DispositionModal callId={disp} onClose={() => setDisp(null)} onDone={reload} />}
    </div>
  );
}

/* ------------------------------------------------------------------ Recordings */

export function Recordings() {
  const { data, loading, reload } = useCalls('?has_recording=true&limit=500');
  const rows = data?.rows ?? [];
  const cols = ['Time', 'Lead / Contact', 'Phone', 'Direction', 'Duration', 'Counsellor', 'Recording'];
  const body: Cell[][] = rows.map((r) => [
    dttime(r.call_start_at || r.created_at),
    r.lead_name || '—',
    { mono: r.phone_raw || r.phone_number || '—' },
    dirBadge(r.direction),
    fmtDur(r.duration_s),
    r.user_name || '—',
    r.recording_id ? { node: <RecordingPlayer id={r.recording_id} /> } : ('—' as Cell),
  ]);
  return (
    <div className="main main--list">
      <div className="card toolbar-surface" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <p className="muted" style={{ margin: 0 }}>Call recordings synced from the phone's own dialer. Playable inline; access is RBAC-scoped.</p>
        <button className="btn ghost" onClick={reload}><Ic k="refresh" /> Refresh</button>
      </div>
      <TableCard title={loading ? 'Recordings — loading…' : `Recordings (${rows.length})`} icon="calls"
        cols={cols} rows={body} fill listKey="callRecordings"
        empty="No recordings yet. They sync from the phone's recording folder once configured on the device." />
    </div>
  );
}

/* ------------------------------------------------------------------ Call Settings */

export function CallSettings() {
  const [s, setS] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [testNo, setTestNo] = useState('');
  useEffect(() => { api.get('/calls/settings').then(setS).catch((e) => toast((e as Error).message, true)); }, []);
  const save = async () => {
    setBusy(true);
    try {
      const saved = await api.put('/calls/settings', {
        tracking_enabled: s.tracking_enabled,
        sim_slots: Array.isArray(s.sim_slots) ? s.sim_slots : [],
        recording_folder: s.recording_folder || null,
        log_sync_minutes: Number(s.log_sync_minutes) || 60,
        rec_sync_minutes: Number(s.rec_sync_minutes) || 15,
      });
      setS(saved); toast('Call settings saved');
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const testDial = async () => {
    try {
      const r = await api.post<{ tel: string }>('/calls/dial', { phone: testNo });
      toast('Dial recorded — opening dialer');
      if (r.tel) window.location.href = r.tel;
    } catch (e) { toast((e as Error).message, true); }
  };
  const syncNow = async () => {
    try { const r = await deviceSyncNow(); toast(r.message, !r.ok); }
    catch (e) { toast((e as Error).message, true); }
  };
  const cap = () => (window as any).Capacitor?.Plugins?.CallPlugin;
  const tl = () => (window as any).TLNative;
  const grantPerms = async () => { try { if (cap()?.requestCallPermissions) await cap().requestCallPermissions(); else if (tl()?.requestAllPermissions) tl().requestAllPermissions(); toast('Permission request sent — approve on the phone'); } catch (e) { toast((e as Error).message, true); } };
  const pickFolder = async () => { try { if (cap()?.pickRecordingFolder) await cap().pickRecordingFolder(); else if (tl()?.pickRecordingFolder) tl().pickRecordingFolder(); else toast('Open this in the Android app', true); } catch (e) { toast((e as Error).message, true); } };
  const openOverlay = () => { try { if (cap()?.openOverlaySettings) cap().openOverlaySettings(); else if (tl()?.openOverlaySettings) tl().openOverlaySettings(); else toast('Open this in the Android app', true); } catch { /* noop */ } };
  const openAppInfo = () => { try { if (tl()?.openAppSettings) tl().openAppSettings(); else toast('Open this in the Android app', true); } catch { /* noop */ } };
  if (!s) return <div className="main"><p className="muted">Loading…</p></div>;
  const slotOn = (n: number) => Array.isArray(s.sim_slots) && s.sim_slots.includes(n);
  const toggleSlot = (n: number) => setS((p: any) => {
    const cur: number[] = Array.isArray(p.sim_slots) ? p.sim_slots : [];
    return { ...p, sim_slots: cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n] };
  });
  return (
    <div className="main">
      <div className="card" style={{ maxWidth: 640 }}>
        <div className="card-head"><h3><Ic k="calls" /> Call tracking settings</h3></div>
        <div style={{ padding: 16, display: 'grid', gap: 14 }}>
          <label className="chk" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={!!s.tracking_enabled} onChange={(e) => setS({ ...s, tracking_enabled: e.target.checked })} />
            <span><b>Enable call tracking</b> — import this phone's call log and recordings into leads</span>
          </label>
          <div className="fld"><span>SIM slots to track</span>
            <div style={{ display: 'flex', gap: 12 }}>
              <label className="chk"><input type="checkbox" checked={slotOn(0)} onChange={() => toggleSlot(0)} /> SIM 1</label>
              <label className="chk"><input type="checkbox" checked={slotOn(1)} onChange={() => toggleSlot(1)} /> SIM 2</label>
              <span className="muted">Leave both off to track all SIMs.</span>
            </div>
          </div>
          <label className="fld"><span>Recording folder (device path / SAF)</span>
            <input className="inp" value={s.recording_folder || ''} onChange={(e) => setS({ ...s, recording_folder: e.target.value })}
              placeholder="e.g. Recordings/Call — set on the phone via 'Pick folder'" />
          </label>
          <div style={{ display: 'flex', gap: 12 }}>
            <label className="fld" style={{ flex: 1 }}><span>Call-log sync (minutes)</span>
              <input className="inp" type="number" min={15} value={s.log_sync_minutes} onChange={(e) => setS({ ...s, log_sync_minutes: e.target.value })} />
            </label>
            <label className="fld" style={{ flex: 1 }}><span>Recording sync (minutes)</span>
              <input className="inp" type="number" min={15} value={s.rec_sync_minutes} onChange={(e) => setS({ ...s, rec_sync_minutes: e.target.value })} />
            </label>
          </div>
          <div style={{ display: 'flex', gap: 8 }}><button className="btn" disabled={busy} onClick={save}>Save settings</button><button className="btn ghost" onClick={syncNow}><Ic k="refresh" /> Sync now (this device)</button></div>
        </div>
      </div>

      <div className="card" style={{ maxWidth: 640, marginTop: 16 }}>
        <div className="card-head"><h3><Ic k="phone" /> Tap-to-dial test</h3></div>
        <div style={{ padding: 16, display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <label className="fld" style={{ flex: 1 }}><span>Phone number</span>
            <input className="inp" value={testNo} onChange={(e) => setTestNo(e.target.value)} placeholder="e.g. 9876543210" />
          </label>
          <button className="btn" disabled={!testNo.trim()} onClick={testDial}><Ic k="phone" /> Dial</button>
        </div>
        <p className="muted" style={{ padding: '0 16px 16px' }}>
          Records a dial event and opens the phone dialer (on the mobile app). The call's real outcome and
          duration are filled in automatically when the call-log sync runs.
        </p>
      </div>

      <div className="card" style={{ maxWidth: 640, marginTop: 16 }}>
        <div className="card-head"><h3><Ic k="cfg" /> Device permissions & access (Android app)</h3></div>
        <div style={{ padding: 16, display: 'grid', gap: 10 }}>
          <p className="muted" style={{ margin: 0 }}>These open the phone's system screens to grant access. They work inside the installed Android app; in a desktop browser they do nothing.</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" onClick={grantPerms}><Ic k="check" /> Grant call permissions</button>
            <button className="btn ghost" onClick={pickFolder}><Ic k="calls" /> Pick recording folder</button>
            <button className="btn ghost" onClick={openOverlay}>Draw over apps</button>
            <button className="btn ghost" onClick={openAppInfo}>Open app settings</button>
          </div>
        </div>
      </div>

      <div className="card" style={{ maxWidth: 640, marginTop: 16 }}>
        <div className="card-head"><h3><Ic k="help" /> How it works</h3></div>
        <div style={{ padding: 16 }} className="muted">
          <p>Call tracking runs on the <b>Android app</b> only. The phone's own call log is the source of truth —
          live "dialing" events appear instantly and are corrected when the hourly sync imports the authoritative
          call-log entry. Recordings sync from the phone's own dialer folder (the app cannot record calls itself).</p>
          <p style={{ marginBottom: 0 }}>Grant the app the call-log and recording-folder permissions when prompted; iOS cannot support call tracking.</p>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Lead tab */

export function LeadCallsTab({ leadId, phone }: { leadId: number; phone?: string | null }) {
  const { can } = useAuth();
  const { data, loading, reload } = useFetch<{ rows: CallRow[] }>(`/calls/lead/${leadId}`, [leadId]);
  const [disp, setDisp] = useState<number | null>(null);
  const rows = data?.rows ?? [];
  const dial = async () => {
    try {
      const r = await api.post<{ tel: string }>('/calls/dial', { lead_id: leadId, phone });
      toast('Dial recorded'); reload();
      if (r.tel) window.location.href = r.tel;
    } catch (e) { toast((e as Error).message, true); }
  };
  const cols = ['Time', 'Direction', 'Duration', 'SIM', 'Disposition', 'Source', 'Recording'];
  const body: Cell[][] = rows.map((r) => [
    dttime(r.call_start_at || r.created_at), dirBadge(r.direction), fmtDur(r.duration_s),
    r.sim_label || '—',
    { node: <span>{r.disposition_name || '—'} {can('calls.act') && <button className="btn-mini" onClick={() => setDisp(r.id)}>Log</button>}</span> },
    srcBadge(r.src),
    r.recording_id ? { node: <RecordingPlayer id={r.recording_id} /> } : ('—' as Cell),
  ]);
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <h4 style={{ margin: 0 }}>Call history</h4>
        <div style={{ display: 'flex', gap: 8 }}>
          {can('calls.act') && phone && <button className="btn" onClick={dial}><Ic k="phone" /> Call</button>}
          <button className="btn ghost" onClick={reload}><Ic k="refresh" /> Refresh</button>
        </div>
      </div>
      <TableCard cols={cols} rows={body} icon="calls"
        empty={loading ? 'Loading…' : 'No calls logged for this lead yet.'} />
      {disp != null && <DispositionModal callId={disp} onClose={() => setDisp(null)} onDone={reload} />}
    </div>
  );
}

/* ------------------------------------------------------------------ Call Activity Report */

const fmtHM = (s: unknown) => {
  const n = Math.max(0, Math.round(Number(s) || 0));
  const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  const sec = n % 60; return m ? `${m}m ${sec}s` : `${sec}s`;
};
const dnum = (v: unknown) => Number(v || 0);
const dayLabel = (v: unknown) => v
  ? new Date(String(v)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';

interface RepResp {
  totals: Record<string, unknown>;
  dayWise: Record<string, unknown>[]; userWise: Record<string, unknown>[];
  managerWise: Record<string, unknown>[]; hourly: Record<string, unknown>[];
}

export function CallReport() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    const s = p.toString(); return s ? `?${s}` : '';
  }, [from, to]);
  const { data, loading, reload } = useFetch<RepResp>('/calls/report' + qs, [qs]);
  const t = data?.totals || {};
  const hourly = data?.hourly || [];
  const maxHour = Math.max(1, ...hourly.map((h) => dnum(h.calls)));

  const dayCols = ['Date', 'Calls', 'Connected', 'Missed', 'Talk time', 'Avg duration'];
  const dayBody: Cell[][] = (data?.dayWise || []).map((r) => [
    dayLabel(r.day), String(dnum(r.calls)), String(dnum(r.connected)), String(dnum(r.missed)),
    fmtHM(r.talk_time_s), fmtDur(r.avg_duration_s),
  ]);

  const userCols = ['Counsellor', 'Manager', 'Calls', 'Connected', 'Missed', 'Talk time', 'Avg call', 'Avg gap', 'Active hrs', 'Recordings', 'First call', 'Last call'];
  const userBody: Cell[][] = (data?.userWise || []).map((r) => [
    (r.user_name as string) || '—', (r.manager_name as string) || '—',
    String(dnum(r.calls)), String(dnum(r.connected)), String(dnum(r.missed)),
    fmtHM(r.talk_time_s), fmtDur(r.avg_duration_s), fmtDur(r.avg_gap_s),
    String(dnum(r.active_hours)), String(dnum(r.recordings)),
    dttime(r.first_call), dttime(r.last_call),
  ]);

  const mgrCols = ['Manager', 'Team size', 'Calls', 'Connected', 'Talk time', 'Avg call'];
  const mgrBody: Cell[][] = (data?.managerWise || []).map((r) => [
    (r.manager_name as string) || '—', String(dnum(r.reps)), String(dnum(r.calls)),
    String(dnum(r.connected)), fmtHM(r.talk_time_s), fmtDur(r.avg_duration_s),
  ]);

  return (
    <div className="main main--list">
      <div className="card toolbar-surface">
        <div className="filter-row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="muted">Date range:</span>
          <input className="inp" type="date" value={from} onChange={(e) => setFrom(e.target.value)} title="From" />
          <input className="inp" type="date" value={to} onChange={(e) => setTo(e.target.value)} title="To" />
          <button className="btn ghost" onClick={reload}><Ic k="refresh" /> Refresh</button>
          <span className="muted" style={{ marginLeft: 'auto' }}>{loading ? 'Loading…' : (from || to ? 'Custom range' : 'Default: last 30 days')}</span>
        </div>
      </div>

      <Kpis cols={4} items={[
        { lab: 'Total calls', val: String(dnum(t.total_calls)), ic: 'calls' },
        { lab: 'Connected', val: String(dnum(t.connected)), ic: 'check' },
        { lab: 'Missed', val: String(dnum(t.missed)), ic: 'calls' },
        { lab: 'Total talk time', val: fmtHM(t.talk_time_s), ic: 'clock' },
        { lab: 'Avg call duration', val: fmtDur(t.avg_duration_s), ic: 'clock' },
        { lab: 'Avg gap between calls', val: fmtDur(t.avg_gap_s), ic: 'clock' },
        { lab: 'Unique leads called', val: String(dnum(t.unique_leads)), ic: 'list' },
        { lab: 'Active counsellors', val: String(dnum(t.users_active)), ic: 'list' },
      ]} />

      <TableCard title={`User-wise activity (${(data?.userWise || []).length})`} icon="calls"
        cols={userCols} rows={userBody} fill listKey="callReportUsers"
        empty="No call activity in this range." />

      <TableCard title={`Manager-wise rollup (${(data?.managerWise || []).length})`} icon="calls"
        cols={mgrCols} rows={mgrBody} fill listKey="callReportMgrs" empty="No data in this range." />

      <div className="card" style={{ padding: 12 }}>
        <div style={{ fontWeight: 700, marginBottom: 8, display: 'flex', gap: 6, alignItems: 'center' }}>
          <Ic k="clock" /> Hourly productivity — calls by hour of day (IST)
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 130 }}>
          {Array.from({ length: 24 }, (_, h) => {
            const row = hourly.find((x) => dnum(x.hour) === h);
            const c = row ? dnum(row.calls) : 0;
            return (
              <div key={h} title={`${h}:00 — ${c} calls`}
                style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                <span style={{ fontSize: 9, color: '#6b7280' }}>{c || ''}</span>
                <div style={{ width: '100%', background: c ? '#7c3aed' : '#e5e7eb',
                  height: `${Math.round((c / maxHour) * 90) + 2}px`, borderRadius: 3 }} />
                <span style={{ fontSize: 9, color: '#6b7280' }}>{h}</span>
              </div>
            );
          })}
        </div>
      </div>

      <TableCard title={`Day-wise activity (${(data?.dayWise || []).length})`} icon="calls"
        cols={dayCols} rows={dayBody} fill listKey="callReportDays" empty="No data in this range." />
    </div>
  );
}
