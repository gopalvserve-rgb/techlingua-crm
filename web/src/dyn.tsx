/**
 * Dynamic screens — prototype layouts fed by live API data.
 * Each component matches the corresponding prototype screen's blocks & columns 1:1.
 */
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic, checkS } from './icons';
import {
  Avatar, BarsCard, Blocks, Cell, Funnel, HBars, Kpis, ListCard, TableCard, TempBadge, renderCell,
} from './renderer';
import { toast, useFetch, useRef_ } from './refdata';
import { APP } from './specs';

export interface ScreenCtxT {
  go: (m: string, s: string) => void;
  openLead: (id: number) => void;
  openAdd: (formKey: string) => void;
  refreshTick: number;
  bump: () => void;
}
export const ScreenCtx = createContext<ScreenCtxT>(null as unknown as ScreenCtxT);
const useScreen = () => useContext(ScreenCtx);

/* ------------------------------ helpers ------------------------------ */

const fmtDT = (s?: string | null) => {
  if (!s) return '—';
  const d = new Date(s);
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  return same ? `Today ${time}` : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + ` ${time}`;
};

const LEAD_COLS = ['Lead', 'Course', 'Vertical · Pipeline', 'Source', 'Score', 'Owner', 'Stage', 'Next follow-up'];

function leadRow(l: any): Cell[] {
  const overdue = l.next_follow_up_at && new Date(l.next_follow_up_at) < new Date();
  return [
    { node: (
      <div className="cell-u">
        <Avatar name={l.full_name} />
        <div><div className="nm">{l.full_name}</div><div className="sub mono">{l.phone}</div></div>
      </div>) },
    l.course_name || '—',
    `${l.vertical_name} · ${l.pipeline_name}`,
    { b: [l.source_name || '—', 'b-indigo'] },
    { node: <TempBadge temperature={l.temperature} score={l.score} /> },
    l.owner_name || 'Unassigned',
    { b: [l.stage_name || '—', l.stage_type === 'won' ? 'b-green' : l.stage_type === 'lost' ? 'b-rose' : 'b-cyan'] },
    { node: <span className="mono sub" style={overdue ? { color: 'var(--danger)' } : undefined}>{fmtDT(l.next_follow_up_at)}</span> },
  ];
}

interface Summary {
  kpis: { total: number; today: number; mtd: number; won: number; won_today: number; hot: number; warm: number; cold: number; walkins: number };
  by_stage: Array<{ stage_id: number; name: string; stage_type: string; sort_order: number; pipeline_id: number; ct: number }>;
  series: Array<{ day: string; leads: number; won: number }>;
  follow_ups: { due_today: number; overdue: number; pending: number; done_today: number; done_week: number; my_open: number };
}

const FUNNEL_COLORS = [
  'linear-gradient(90deg,var(--primary),var(--primary-2))', 'linear-gradient(90deg,#6d72f0,#5b5fe0)',
  'linear-gradient(90deg,#37b6d6,#1f9fc0)', 'linear-gradient(90deg,#2bc7c0,#19a8a2)',
  'linear-gradient(90deg,var(--success),#2bb583)', 'linear-gradient(90deg,var(--danger),#d13d75)',
];

function funnelRows(byStage: Summary['by_stage']) {
  // aggregate stages by name (same default stage names across pipelines)
  const agg = new Map<string, { ct: number; sort: number }>();
  byStage.forEach((s) => {
    const cur = agg.get(s.name) ?? { ct: 0, sort: s.sort_order };
    agg.set(s.name, { ct: cur.ct + s.ct, sort: Math.min(cur.sort, s.sort_order) });
  });
  const rows = [...agg.entries()].sort((a, b) => a[1].sort - b[1].sort);
  const max = Math.max(1, ...rows.map(([, v]) => v.ct));
  return rows.map(([name, v], i) => ({
    label: name, val: String(v.ct), sub: '', pct: Math.round((v.ct / max) * 100), color: FUNNEL_COLORS[i % FUNNEL_COLORS.length],
  }));
}

function fuRow(f: any, openLead: (id: number) => void): { row: Cell[]; leadId: number } {
  const overdue = f.status === 'pending' && new Date(f.scheduled_at) < new Date();
  return { leadId: f.lead_id, row: [
    { node: <span className="nm">{f.lead_name}</span> },
    f.course_name || '—',
    { b: [f.type_name || 'Follow-up', f.type_name === 'WhatsApp' ? 'b-green' : f.type_name === 'Visit' ? 'b-cyan' : 'b-indigo'] },
    f.owner_name || '—',
    { node: <span className="mono" style={overdue ? { color: 'var(--danger)' } : undefined}>{fmtDT(f.scheduled_at)}{overdue ? ' · overdue' : ''}</span> },
    { node: <TempBadge temperature={f.temperature} score={f.score} /> },
  ] };
}

/* ------------------------------ screens ------------------------------ */

function DashOverview() {
  const { openLead, refreshTick } = useScreen();
  const sum = useFetch<Summary>('/leads/summary', [refreshTick]);
  const today = useFetch<any[]>('/follow-ups?due=today&limit=5', [refreshTick]);
  const mine = useFetch<any[]>('/follow-ups?mine=1&status=pending&limit=4', [refreshTick]);
  const recent = useFetch<{ total: number; rows: any[] }>('/leads?limit=5', [refreshTick]);
  const k = sum.data?.kpis; const fu = sum.data?.follow_ups;
  return (
    <>
      <Kpis cols={6} items={[
        { lab: "Today's Leads", val: String(k?.today ?? '0'), ic: 'leads' },
        { lab: 'Conversions', val: String(k?.won ?? '0'), ic: 'check' },
        { lab: "Today's Collection", val: '—', ic: 'rupee' },
        { lab: 'Pending Follow-ups', val: String(fu?.pending ?? '0'), ic: 'clock', delta: fu?.overdue ? `${fu.overdue} overdue` : undefined, tone: fu?.overdue ? 'down' : 'flat' },
        { lab: 'Walk-ins', val: String(k?.walkins ?? '0'), ic: 'users' },
        { lab: 'Active Students', val: '—', ic: 'students' },
      ]} />
      <div className="row2" style={{ gridTemplateColumns: '1.55fr 1fr' }}>
        <BarsCard title="Lead inflow & conversions — last 14 days" series={sum.data?.series?.map((s) => ({ day: String(s.day), leads: Number(s.leads), won: Number(s.won) })) ?? []} />
        <Funnel title="Conversion funnel" rows={sum.data ? funnelRows(sum.data.by_stage) : []} />
      </div>
      <div className="row2" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
        <ListCard title="Today's Follow-ups" icon="clock" more={String(fu?.due_today ?? 0)}
          empty="No follow-ups due today"
          rows={(today.data ?? []).map((f) => ({
            ic: f.type_name === 'WhatsApp' ? 'wa' : f.type_name === 'Visit' ? 'users' : f.type_name === 'Email' ? 'mail' : 'calls',
            tone: f.temperature === 'hot' ? 'b-hot' : f.temperature === 'warm' ? 'b-amber' : 'b-cold',
            t1: <span style={{ cursor: 'pointer' }} onClick={() => openLead(f.lead_id)}>{f.type_name || 'Follow-up'} {f.lead_name}</span>,
            t2: `${f.course_name || '—'} · ${f.temperature ? f.temperature[0].toUpperCase() + f.temperature.slice(1) : ''}`,
            rt: new Date(f.scheduled_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
          }))} />
        <MyTaskCard rows={mine.data ?? []} more={`${fu?.my_open ?? 0} open`} />
        <div className="card" style={{ background: 'linear-gradient(150deg,var(--primary-soft),var(--accent-soft))' }}>
          <div className="card-head"><h3><Ic k="intel" />AI Insights</h3><span className="bdg b-indigo">Gemini</span></div>
          <div className="empty-note">AI insights switch on once the Gemini key is configured (Sprint 3).</div>
        </div>
      </div>
      <TableCard title="Recent leads" more="View pipeline" cols={LEAD_COLS}
        rows={(recent.data?.rows ?? []).map(leadRow)}
        empty="No leads yet — add your first lead or connect a source"
        onRowClick={(i) => openLead(Number(recent.data!.rows[i].id))} />
    </>
  );
}

function MyTaskCard({ rows, more }: { rows: any[]; more?: string }) {
  const { bump, openLead } = useScreen();
  const complete = async (id: number) => {
    try { await api.patch(`/follow-ups/${id}`, { complete: true }); toast('Task marked done'); bump(); }
    catch (e: any) { toast(e.message, true); }
  };
  return (
    <div className="card">
      <div className="card-head"><h3><Ic k="check" />My Tasks</h3><span className="more">{more || ''}</span></div>
      {rows.length === 0 ? <div className="lrow empty">No open tasks — follow-ups you own appear here</div> :
        rows.map((f) => (
          <div className="lrow" key={f.id}>
            <div className="chk" onClick={() => complete(f.id)} title="Mark done" />
            <div className="gr" style={{ cursor: 'pointer' }} onClick={() => openLead(f.lead_id)}>
              <div className="t1">{f.type_name || 'Follow-up'} — {f.lead_name}</div>
              <div className="t2">{f.notes || `${f.course_name || ''}`}</div>
            </div>
            <span className="rt">{fmtDT(f.scheduled_at)}</span>
          </div>
        ))}
    </div>
  );
}

function MyTasks() {
  const { refreshTick } = useScreen();
  const sum = useFetch<any>('/follow-ups/summary', [refreshTick]);
  const mine = useFetch<any[]>('/follow-ups?mine=1&status=pending&limit=50', [refreshTick]);
  return (
    <>
      <Kpis items={[
        { lab: 'Open tasks', val: String(sum.data?.my_open ?? '0'), ic: 'check' },
        { lab: 'Due today', val: String(sum.data?.my_due_today ?? '0'), ic: 'clock' },
        { lab: 'Overdue', val: String(sum.data?.my_overdue ?? '0'), ic: 'clock', tone: 'down', delta: sum.data?.my_overdue > 0 ? 'needs attention' : undefined },
        { lab: 'Done this week', val: String(sum.data?.my_done_week ?? '0'), ic: 'check' },
      ]} />
      <MyTaskCard rows={mine.data ?? []} more={`${sum.data?.my_open ?? 0} open`} />
    </>
  );
}

function TodayFollowups() {
  const { openLead, refreshTick } = useScreen();
  const sum = useFetch<any>('/follow-ups/summary', [refreshTick]);
  const list = useFetch<any[]>('/follow-ups?due=today&limit=100', [refreshTick]);
  const rows = (list.data ?? []).map((f) => fuRow(f, openLead));
  return (
    <>
      <Kpis items={[
        { lab: 'Due today', val: String(sum.data?.due_today ?? '0'), ic: 'clock' },
        { lab: 'Overdue', val: String(sum.data?.overdue ?? '0'), ic: 'clock', tone: sum.data?.overdue > 0 ? 'down' : 'flat' },
        { lab: 'Done today', val: String(sum.data?.done_today ?? '0'), ic: 'check' },
        { lab: 'No-shows', val: '0', ic: 'bolt' },
      ]} />
      <TableCard title={`Today — ${new Date().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}`}
        cols={['Lead', 'Course', 'Type', 'Owner', 'Due', 'Score']}
        rows={rows.map((r) => r.row)} empty="No follow-ups due today"
        onRowClick={(i) => openLead(rows[i].leadId)} />
    </>
  );
}

function QuickStats() {
  const { refreshTick } = useScreen();
  const sum = useFetch<Summary>('/leads/summary', [refreshTick]);
  const k = sum.data?.kpis; const fu = sum.data?.follow_ups;
  const conv = k && k.total > 0 ? `${Math.round((k.won / k.total) * 100)}%` : '—';
  return (
    <>
      <Kpis cols={4} items={[
        { lab: 'Leads', val: String(k?.total ?? '0'), ic: 'leads' },
        { lab: 'Conversions', val: String(k?.won ?? '0'), ic: 'check' },
        { lab: 'Revenue', val: '—', ic: 'rupee' },
        { lab: 'Collection', val: '—', ic: 'rupee' },
        { lab: 'Walk-ins', val: String(k?.walkins ?? '0'), ic: 'users' },
        { lab: 'Follow-ups done', val: String(fu?.done_week ?? '0'), ic: 'clock' },
        { lab: 'Avg CPL', val: '—', ic: 'bolt' },
        { lab: 'Conv rate', val: conv, ic: 'target' },
      ]} />
      <HBars title="This month vs target" rows={[]} empty="Targets are set under Performance › Monthly Targets — progress bars appear once targets exist" />
    </>
  );
}

function Calendar() {
  const { openLead, refreshTick } = useScreen();
  const today = useFetch<any[]>('/follow-ups?due=today&limit=20', [refreshTick]);
  return (
    <>
      <Blocks blocks={[{ type: 'caps', title: 'Calendar shows', items: [
        { t: 'Follow-ups & demos', d: 'Pulled from lead next-follow-up date' },
        { t: 'Batch sessions', d: 'From academics schedule (Sprint 3)' },
        { t: 'Holidays & staff leaves', d: 'From HR calendar (Phase 2)' },
        { t: 'Meetings', d: 'Add internal meetings' },
        { t: 'Two-way sync', d: 'Google Calendar / Outlook' }] }]} />
      <ListCard title={`Today — ${new Date().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}`}
        icon="cal" empty="Nothing scheduled today"
        rows={(today.data ?? []).map((f) => ({
          ic: 'clock', tone: f.temperature === 'hot' ? 'b-hot' : 'b-indigo',
          t1: <span style={{ cursor: 'pointer' }} onClick={() => openLead(f.lead_id)}>{f.type_name || 'Follow-up'} {f.lead_name} · {f.course_name || ''}</span>,
          t2: f.notes || f.stage_name || '',
          rt: new Date(f.scheduled_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
        }))} />
    </>
  );
}

function QuickContact() {
  const { openLead, openAdd } = useScreen();
  const ref = useRef_();
  const [scope, setScope] = useState<{ branch?: number; vertical?: number; pipeline?: number; campaign?: number }>({});
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [results, setResults] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);

  const verticals = ref.verticals.filter((v) => !scope.branch || Number(v.branch_id) === scope.branch);
  const pipelines = ref.pipelines.filter((p) => !scope.vertical || Number(p.vertical_id) === scope.vertical);
  const campaigns = ref.campaigns.filter((c) => !scope.pipeline || Number(c.pipeline_id) === scope.pipeline);

  const search = async () => {
    const q = (phone || name).trim();
    setBusy(true);
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (scope.branch) params.set('branch_id', String(scope.branch));
      if (scope.vertical) params.set('vertical_id', String(scope.vertical));
      if (scope.pipeline) params.set('pipeline_id', String(scope.pipeline));
      if (scope.campaign) params.set('campaign_id', String(scope.campaign));
      params.set('limit', '20');
      const r = await api.get<{ total: number; rows: any[] }>(`/leads?${params.toString()}`);
      setResults(r.rows);
      if (!r.rows.length) toast('No matching contacts — use Add Lead to create one');
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };

  const scopeSel = (label: string, value: number | undefined, list: Array<{ id: number; name: string }>, set: (v?: number) => void) => (
    <div className="fld" key={label}>
      <label>{label}</label>
      <select className="ainp" value={value ?? ''} onChange={(e) => set(e.target.value ? Number(e.target.value) : undefined)}>
        <option value="">All {label}s</option>
        {list.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </div>
  );

  return (
    <>
      <div className="row2" style={{ gridTemplateColumns: '1.7fr 1fr' }}>
        <div className="card card-pad">
          <div className="sechead" style={{ marginTop: 0 }}>Lead Details — Scope</div>
          <div className="form-grid" style={{ padding: 0 }}>
            {scopeSel('Branch', scope.branch, ref.branches, (v) => setScope({ branch: v }))}
            {scopeSel('Vertical', scope.vertical, verticals, (v) => setScope((s) => ({ branch: s.branch, vertical: v })))}
            {scopeSel('Pipeline', scope.pipeline, pipelines, (v) => setScope((s) => ({ ...s, pipeline: v, campaign: undefined })))}
            {scopeSel('Campaign', scope.campaign, campaigns, (v) => setScope((s) => ({ ...s, campaign: v })))}
          </div>
          <div className="sechead">Basic Details</div>
          <div className="form-grid" style={{ padding: 0 }}>
            <div className="fld"><label>Contact Name</label><input className="ainp" placeholder="Contact Name" value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="fld"><label>Contact Number</label>
              <div className="inpwrap">
                <input className="ainp" type="tel" placeholder="Contact Number" value={phone} onChange={(e) => setPhone(e.target.value)} />
                <button className="verify" title="Verify" onClick={() => toast('Number verification lands with the messaging integration (Sprint 3)')}><Ic k="check" w={2.6} /></button>
              </div></div>
            <div className="fld span2"><label>Email</label><input className="ainp" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          </div>
          <div className="sechead">Custom Contact Property</div>
          <div className="form-grid" style={{ padding: 0 }}>
            <div className="fld"><label>Training Mode <span className="star">*</span></label>
              <select className="ainp"><option value="">Select…</option><option>Online</option><option>Offline</option><option>Hybrid</option><option>Bootcamp</option></select></div>
            <div className="fld"><label>Category</label><input className="ainp" placeholder="category" /></div>
            <div className="fld"><label>Remarks</label><input className="ainp" placeholder="Remarks" /></div>
            <div className="fld"><label>Course</label><input className="ainp" placeholder="course" /></div>
          </div>
        </div>
        <div className="stack">
          <div className="card"><div className="card-head"><h3><Ic k="bolt" />Campaigns</h3></div>
            <div className="card-pad">
              <select className="ainp" value={scope.campaign ?? ''} onChange={(e) => setScope((s) => ({ ...s, campaign: e.target.value ? Number(e.target.value) : undefined }))}>
                <option value="">Select Campaigns</option>
                {ref.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div></div>
          <div className="card"><div className="card-head"><h3><Ic k="leads" />Contact Source</h3></div>
            <div className="card-pad">
              {['FILE_UPLOAD', 'WALK_IN_LEAD', 'INCOMING_IVR', 'WORKFLOW', 'GOOGLE_SHEET'].map((nm) => (
                <label className="qc-src" key={nm}><input type="checkbox" />{nm}</label>
              ))}
              <a className="mlink" style={{ marginLeft: 4, display: 'inline-block', marginTop: 6 }}
                onClick={() => toast('More sources connect under Marketing › Lead Sources')}>View More…</a>
            </div></div>
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'center', marginTop: 18 }}>
        <button className="btn primary" style={{ padding: '11px 44px' }} onClick={search} disabled={busy}>
          <Ic k="leads" />Search
        </button>
      </div>
      {results !== null && (
        <div style={{ marginTop: 18 }}>
          <TableCard title="Matching contacts" cols={LEAD_COLS} rows={results.map(leadRow)}
            empty="No matching contacts — Add Lead to create one"
            more={<a onClick={() => openAdd('dash.quickcontact')} style={{ cursor: 'pointer', color: 'var(--primary)' }}>+ Add Lead</a>}
            onRowClick={(i) => openLead(Number(results[i].id))} />
        </div>
      )}
    </>
  );
}

function LeadsAll() {
  const { openLead, refreshTick } = useScreen();
  const ref = useRef_();
  const [f, setF] = useState<{ branch?: number; vertical?: number; pipeline?: number; campaign?: number; q: string }>({ q: '' });
  const params = new URLSearchParams();
  if (f.branch) params.set('branch_id', String(f.branch));
  if (f.vertical) params.set('vertical_id', String(f.vertical));
  if (f.pipeline) params.set('pipeline_id', String(f.pipeline));
  if (f.campaign) params.set('campaign_id', String(f.campaign));
  if (f.q.trim()) params.set('q', f.q.trim());
  params.set('limit', '100');
  const data = useFetch<{ total: number; rows: any[] }>(`/leads?${params.toString()}`, [refreshTick]);

  const chip = (label: string, icon: string, value: number | undefined, list: Array<{ id: number; name: string }>, set: (v?: number) => void) => (
    <div className="fchip" key={label}>
      <Ic k={icon} />{label}
      <select value={value ?? ''} onChange={(e) => set(e.target.value ? Number(e.target.value) : undefined)}>
        <option value="">All</option>
        {list.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </div>
  );

  return (
    <>
      <div className="filters">
        {chip('Branch', 'branch', f.branch, ref.branches, (v) => setF((x) => ({ ...x, branch: v, vertical: undefined, pipeline: undefined, campaign: undefined })))}
        {chip('Vertical', 'grid', f.vertical, ref.verticals.filter((v) => !f.branch || Number(v.branch_id) === f.branch), (v) => setF((x) => ({ ...x, vertical: v, pipeline: undefined, campaign: undefined })))}
        {chip('Pipeline', 'list', f.pipeline, ref.pipelines.filter((p) => !f.vertical || Number(p.vertical_id) === f.vertical), (v) => setF((x) => ({ ...x, pipeline: v, campaign: undefined })))}
        {chip('Campaign', 'bolt', f.campaign, ref.campaigns.filter((c) => !f.pipeline || Number(c.pipeline_id) === f.pipeline), (v) => setF((x) => ({ ...x, campaign: v })))}
        <div className="fchip"><Ic k="search" /><input style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }} placeholder="Search name / phone…" value={f.q} onChange={(e) => setF((x) => ({ ...x, q: e.target.value }))} /></div>
        <div className="fchip" style={{ marginLeft: 'auto', color: 'var(--primary)', borderColor: 'var(--primary)' }}><Ic k="intel" />AI sort: Hot first</div>
      </div>
      <TableCard title="Leads" more={`${data.data?.total ?? 0} in scope`} cols={LEAD_COLS}
        rows={(data.data?.rows ?? []).map(leadRow)}
        empty="No leads in scope yet — add a lead or connect a source"
        onRowClick={(i) => openLead(Number(data.data!.rows[i].id))} />
    </>
  );
}

function Followups() {
  const { openLead, refreshTick } = useScreen();
  const sum = useFetch<any>('/follow-ups/summary', [refreshTick]);
  const list = useFetch<any[]>('/follow-ups?limit=100', [refreshTick]);
  const rows = (list.data ?? []).map((fx) => ({ leadId: fx.lead_id, row: [
    { node: <span className="nm">{fx.lead_name}</span> } as Cell,
    { b: [fx.type_name || 'Follow-up', fx.type_name === 'WhatsApp' ? 'b-green' : 'b-indigo'] } as Cell,
    fx.owner_name || '—',
    { node: <span className="mono" style={fx.status === 'pending' && new Date(fx.scheduled_at) < new Date() ? { color: 'var(--danger)' } : undefined}>{fmtDT(fx.scheduled_at)}</span> } as Cell,
    fx.disposition_name || (fx.status === 'done' ? 'Done' : '—'),
  ] }));
  return (
    <>
      <Kpis items={[
        { lab: 'Due today', val: String(sum.data?.due_today ?? '0'), ic: 'clock' },
        { lab: 'Overdue', val: String(sum.data?.overdue ?? '0'), ic: 'clock', tone: sum.data?.overdue > 0 ? 'down' : 'flat' },
        { lab: 'This week', val: String(sum.data?.this_week ?? '0'), ic: 'cal' },
        { lab: 'Done (wk)', val: String(sum.data?.done_week ?? '0'), ic: 'check' },
      ]} />
      <TableCard title="Upcoming follow-ups" cols={['Lead', 'Type', 'Owner', 'Due', 'Disposition']}
        rows={rows.map((r) => r.row)} empty="No follow-ups scheduled yet"
        onRowClick={(i) => openLead(rows[i].leadId)} />
    </>
  );
}

const KANBAN_COLORS = ['var(--success)', 'var(--accent)', 'var(--primary)', '#22c7c0', 'var(--amber)', 'var(--success)', 'var(--danger)'];

function Kanban() {
  const { openLead, refreshTick } = useScreen();
  const ref = useRef_();
  const [pipelineId, setPipelineId] = useState<number>();
  const pid = pipelineId ?? (ref.pipelines[0] ? Number(ref.pipelines[0].id) : undefined);
  const stages = useFetch<any[]>(pid ? `/pipelines/${pid}/stages` : null, [pid]);
  const leads = useFetch<{ total: number; rows: any[] }>(pid ? `/leads?pipeline_id=${pid}&limit=300` : '/leads?limit=300', [pid, refreshTick]);

  // group leads by stage (falls back to stage names on rows when stages can't be listed)
  const cols = useMemo(() => {
    const rows = leads.data?.rows ?? [];
    if (stages.data?.length) {
      return stages.data.filter((s: any) => s.is_active !== false).map((s: any) => ({
        id: Number(s.id), name: s.name, leads: rows.filter((l) => Number(l.stage_id) === Number(s.id)),
      }));
    }
    const names = new Map<string, any[]>();
    rows.forEach((l) => {
      const k = l.stage_name || 'Unstaged';
      names.set(k, [...(names.get(k) ?? []), l]);
    });
    return [...names.entries()].map(([name, ls], i) => ({ id: i, name, leads: ls }));
  }, [stages.data, leads.data]);

  return (
    <>
      <div className="filters">
        <div className="fchip"><Ic k="list" />Pipeline
          <select value={pid ?? ''} onChange={(e) => setPipelineId(e.target.value ? Number(e.target.value) : undefined)}>
            {ref.pipelines.length === 0 && <option value="">My leads</option>}
            {ref.pipelines.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.vertical_name}</option>)}
          </select>
        </div>
        <div className="fchip"><Ic k="leads" /><b>{leads.data?.total ?? 0}</b> leads in scope</div>
      </div>
      <div className="kanban">
        {cols.length === 0 && <div className="empty-note" style={{ width: '100%' }}>Stages appear once a pipeline is selected</div>}
        {cols.map((c, ci) => (
          <div className="kcol" key={c.id}>
            <div className="kcol-head">
              <span className="dot" style={{ background: KANBAN_COLORS[ci % KANBAN_COLORS.length] }} />
              <span className="t">{c.name}</span><span className="ct">{c.leads.length}</span>
            </div>
            <div className="kcol-body">
              {c.leads.length === 0 && <div className="empty-note" style={{ padding: '14px 6px' }}>No leads</div>}
              {c.leads.map((l: any) => (
                <div className="lead-card" key={l.id} onClick={() => openLead(Number(l.id))}>
                  <div className="lc-top">
                    <div className="who">
                      <Avatar name={l.full_name} />
                      <div><div className="nm">{l.full_name}</div><div className="sub mono" style={{ fontSize: 10 }}>{l.phone}</div></div>
                    </div>
                    {l.temperature ? <span className={`bdg b-${l.temperature === 'hot' ? 'hot' : l.temperature === 'warm' ? 'warm' : 'cold'}`}>{l.score > 0 ? l.score : l.temperature}</span> : null}
                  </div>
                  <div className="meta">
                    <span className="ttag">{l.course_name || 'Course TBD'}</span>
                    <span className="ttag">{l.vertical_name} · {l.pipeline_name}</span>
                  </div>
                  <div className="foot">
                    <div className="src"><Ic k="search" />{l.source_name}</div>
                    <TempBadge temperature={l.temperature} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function Scoring() {
  const { refreshTick } = useScreen();
  const sum = useFetch<Summary>('/leads/summary', [refreshTick]);
  const k = sum.data?.kpis;
  const total = Math.max(1, (k?.hot ?? 0) + (k?.warm ?? 0) + (k?.cold ?? 0));
  const rows = k && (k.hot || k.warm || k.cold) ? [
    { label: '🔥 Hot (80–100)', val: `${k.hot} leads`, pct: Math.round((k.hot / total) * 100), color: 'var(--hot)' },
    { label: '🌤 Warm (50–79)', val: `${k.warm} leads`, pct: Math.round((k.warm / total) * 100), color: 'var(--warm)' },
    { label: '❄️ Cold (0–49)', val: `${k.cold} leads`, pct: Math.round((k.cold / total) * 100), color: 'var(--cold)' },
  ] : [];
  return (
    <>
      <Blocks blocks={[{ type: 'cfg', title: 'Scoring criteria & weights', rows: [
        { ic: 'leads', k: 'Source quality', s: 'Paid sources weighted higher', v: '25%', toggle: true },
        { ic: 'rupee', k: 'Budget', s: 'Declared budget vs course fee', v: '20%', toggle: true },
        { ic: 'book', k: 'Course interest', s: 'High-ticket courses score up', v: '15%', toggle: true },
        { ic: 'bolt', k: 'Engagement', s: 'Calls answered, WA replies, opens', v: '25%', toggle: true },
        { ic: 'clock', k: 'Recency', s: 'Time since last activity', v: '15%', toggle: true }] }]} />
      <HBars title="Current band distribution" rows={rows} empty="Band distribution appears as leads are scored" />
    </>
  );
}

function Sources() {
  const ref = useRef_();
  const CAPTURE: Record<string, [string, string]> = {
    meta: ['Auto · webhook', 'b-green'], google: ['Auto · webhook', 'b-green'], justdial: ['Auto · API', 'b-green'],
    indiamart: ['Auto · API', 'b-green'], form: ['Auto', 'b-green'], webhook: ['Auto', 'b-green'],
    sheet: ['Manual / bulk', 'b-amber'], walkin: ['Manual', 'b-gray'], referral: ['Manual', 'b-gray'], manual: ['Manual', 'b-gray'],
  };
  const rows: Cell[][] = ref.sources.map((s) => {
    const cap = CAPTURE[s.channel as string] ?? ['Manual', 'b-gray'];
    return [
      { node: <span className="nm">{s.name}</span> },
      { b: cap },
      '—',
      '—',
      { b: s.webhook_token ? ['Live', 'b-green'] : ['Manual', 'b-gray'] },
    ];
  });
  return <TableCard title="Connected sources" cols={['Source', 'Capture', 'This month', 'Cost/lead', 'Status']}
    rows={rows} empty="No sources connected yet — add one per campaign" />;
}

function Sla() {
  return (
    <Blocks blocks={[
      { type: 'kpis', items: [
        { lab: 'Target first response', val: '5m', ic: 'clock' }, { lab: 'Avg actual', val: '—', ic: 'check' },
        { lab: 'Breaches today', val: '0', ic: 'clock' }, { lab: 'Escalated', val: '0', ic: 'bolt' }] },
      { type: 'cfg', title: 'Escalation ladder', rows: [
        { ic: 'clock', k: 'First response SLA', s: 'Counsellor must respond', v: '5 min', toggle: true },
        { ic: 'bolt', k: 'Breach → Team Leader', s: 'Notify + reassign option', v: '+10 min', toggle: true },
        { ic: 'users', k: 'Repeat breach → Manager', s: 'Escalation alert', v: '+30 min', toggle: true }] },
    ]} />
  );
}

function Branches() {
  const ref = useRef_();
  const nodes = [{
    label: 'Tech Lingua LLP', tag: 'Org', icon: 'branch',
    children: ref.branches.map((b) => ({
      label: b.name, tag: `${b.vertical_count ?? ref.verticals.filter((v) => Number(v.branch_id) === Number(b.id)).length} verticals`, icon: 'branch',
      children: ref.verticals.filter((v) => Number(v.branch_id) === Number(b.id)).map((v) => ({
        label: v.name, icon: 'grid',
        tag: `${ref.pipelines.filter((p) => Number(p.vertical_id) === Number(v.id)).length} pipelines`,
      })),
    })),
  }];
  return (
    <>
      <Blocks blocks={[{ type: 'tree', title: 'Hierarchy', nodes }]} />
      <TableCard title="Branches" cols={['Branch', 'Code', 'City', 'Verticals', 'Status']}
        rows={ref.branches.map((b) => [
          { node: <span className="nm">{b.name}</span> } as Cell,
          { mono: String(b.code ?? '—') } as Cell,
          String(b.city_name ?? '—'),
          String(b.vertical_count ?? ref.verticals.filter((v) => Number(v.branch_id) === Number(b.id)).length),
          { b: [b.is_active === false ? 'Inactive' : 'Active', b.is_active === false ? 'b-gray' : 'b-green'] } as Cell,
        ])} empty="No branches yet" />
    </>
  );
}

function Verticals() {
  const ref = useRef_();
  return <TableCard title="Verticals" cols={['Vertical', 'Branch', 'Head', 'SMTP Domain', 'Status']}
    rows={ref.verticals.map((v) => [
      { node: <span className="nm">{v.name}</span> } as Cell,
      String(v.branch_name ?? '—'),
      '—',
      { mono: String((v.smtp_config as any)?.domain ?? (v.smtp_config as any)?.host ?? '—') } as Cell,
      { b: [v.is_active === false ? 'Inactive' : 'Active', v.is_active === false ? 'b-gray' : 'b-green'] } as Cell,
    ])} empty="No verticals yet" />;
}

function Pipelines() {
  const ref = useRef_();
  const [stagesBy, setStagesBy] = useState<Record<number, string>>({});
  useEffect(() => {
    let dead = false;
    Promise.all(ref.pipelines.map((p) =>
      api.get<any[]>(`/pipelines/${p.id}/stages`)
        .then((st) => [Number(p.id), st.filter((s) => s.is_active !== false).map((s) => s.name).join(' → ')] as const)
        .catch(() => [Number(p.id), '—'] as const),
    )).then((pairs) => { if (!dead) setStagesBy(Object.fromEntries(pairs)); });
    return () => { dead = true; };
  }, [ref.pipelines]);
  return <TableCard title="Pipelines" cols={['Pipeline', 'Branch', 'Vertical', 'Stages', 'Status']}
    rows={ref.pipelines.map((p) => [
      { node: <span className="nm">{p.name}</span> } as Cell,
      String(p.branch_name ?? '—'),
      String(p.vertical_name ?? '—'),
      stagesBy[Number(p.id)] ?? '…',
      { b: [p.is_active === false ? 'Inactive' : 'Active', p.is_active === false ? 'b-gray' : 'b-green'] } as Cell,
    ])} empty="No pipelines yet" />;
}

function Campaigns() {
  const { refreshTick } = useScreen();
  const ref = useRef_();
  const sum = useFetch<Summary>('/leads/summary', [refreshTick]);
  const [counts, setCounts] = useState<Record<number, number>>({});
  useEffect(() => {
    let dead = false;
    Promise.all(ref.campaigns.map((c) =>
      api.get<{ total: number }>(`/leads?campaign_id=${c.id}&limit=1`)
        .then((r) => [Number(c.id), r.total] as const).catch(() => [Number(c.id), 0] as const),
    )).then((pairs) => { if (!dead) setCounts(Object.fromEntries(pairs)); });
    return () => { dead = true; };
  }, [ref.campaigns, refreshTick]);
  const DIST: Record<string, string> = { on_demand: 'On demand', equal: 'Equal', conditional: 'Conditional' };
  return (
    <>
      <Kpis items={[
        { lab: 'Active campaigns', val: String(ref.campaigns.filter((c) => c.is_active !== false).length), ic: 'bolt' },
        { lab: 'Leads (MTD)', val: String(sum.data?.kpis.mtd ?? '0'), ic: 'leads' },
        { lab: 'Avg CPL', val: '—', ic: 'rupee' },
        { lab: 'Best conv%', val: '—', ic: 'target' },
      ]} />
      <TableCard title="Campaigns" cols={['Campaign', 'Pipeline', 'Source', 'UTM', 'Spend', 'Leads', 'CPL', 'Conv%', 'Assign rule']}
        rows={ref.campaigns.map((c) => {
          const src = ref.sources.find((s) => Number(s.campaign_id) === Number(c.id));
          const utm = (c.utm as any)?.utm_campaign ?? (c.utm as any)?.utm_source ?? '—';
          const leads = counts[Number(c.id)] ?? 0;
          const cost = Number(c.cost ?? 0);
          return [
            { node: <span className="nm">{c.name}</span> } as Cell,
            String(c.pipeline_name ?? '—'),
            src ? ({ b: [src.name, 'b-indigo'] } as Cell) : '—',
            { mono: utm === '—' ? '—' : `utm=${utm}`, dim: true } as Cell,
            cost ? `₹${cost.toLocaleString('en-IN')}` : '—',
            String(leads),
            cost && leads ? ({ mono: `₹${Math.round(cost / leads)}` } as Cell) : '—',
            '—',
            DIST[(c.distribution_config as any)?.mode] ?? '—',
          ];
        })} empty="No campaigns yet — create one to start pulling leads" />
    </>
  );
}

function Courses() {
  const ref = useRef_();
  return <TableCard title="Course master" cols={['Code', 'Course', 'Vertical', 'Mode', 'Duration', 'Fee', 'Branches']}
    rows={ref.courses.map((c) => [
      { mono: String(c.code ?? '—') } as Cell,
      { node: <span className="nm">{c.name}</span> } as Cell,
      String((c.meta as any)?.vertical ?? 'All'),
      String((c.meta as any)?.mode ?? '—'),
      String((c.meta as any)?.duration ?? '—'),
      String((c.meta as any)?.fee ?? '—'),
      'All',
    ])} empty="No courses in the master yet" />;
}

function Users() {
  const { refreshTick } = useScreen();
  const ref = useRef_();
  const [details, setDetails] = useState<Record<number, any>>({});
  useEffect(() => {
    let dead = false;
    Promise.all(ref.users.map((u) =>
      api.get<any>(`/users/${u.id}`).then((d) => [Number(u.id), d] as const).catch(() => [Number(u.id), null] as const),
    )).then((pairs) => { if (!dead) setDetails(Object.fromEntries(pairs)); });
    return () => { dead = true; };
  }, [ref.users, refreshTick]);
  const nameOf = (list: Array<{ id: number; name: string }>, id: unknown) =>
    id == null ? null : list.find((x) => Number(x.id) === Number(id))?.name ?? null;
  return <TableCard title="Users" cols={['User', 'Role', 'Scope (Branch/Vertical/Pipeline)', 'SSO', 'Status']}
    rows={ref.users.map((u) => {
      const d = details[Number(u.id)];
      const a = d?.assignments?.[0];
      const scopeBits = a ? [nameOf(ref.branches, a.branch_id), nameOf(ref.verticals, a.vertical_id), nameOf(ref.pipelines, a.pipeline_id)].filter(Boolean) : [];
      return [
        { node: (
          <div className="cell-u"><Avatar name={u.name} />
            <div><div className="nm">{u.name}</div><div className="sub">{u.email}</div></div>
          </div>) } as Cell,
        a?.role_name ?? (d ? '—' : '…'),
        scopeBits.length ? scopeBits.join(' · ') : a ? 'Org-wide' : '—',
        '—',
        { b: [u.status === 'disabled' ? 'Disabled' : 'Active', u.status === 'disabled' ? 'b-gray' : 'b-green'] } as Cell,
      ];
    })} empty="No users visible in your scope" />;
}

const MATRIX_ROWS: Array<[string, string[]]> = [
  ['Leads', ['lead', 'followup']],
  ['Finance', ['finance']],
  ['Students', ['student']],
  ['Reports', ['report']],
  ['Administration', ['user', 'role', 'branch', 'vertical', 'pipeline', 'settings', 'master']],
];
const MATRIX_ROLES = ['Super Admin', 'Branch Manager', 'Counsellor', 'Accountant', 'Trainer'];

function Roles() {
  const { refreshTick } = useScreen();
  const roles = useFetch<any[]>('/roles', [refreshTick]);
  const [grants, setGrants] = useState<Record<string, any[]>>({});
  useEffect(() => {
    if (!roles.data) return;
    let dead = false;
    const wanted = roles.data.filter((r) => MATRIX_ROLES.includes(r.name));
    Promise.all(wanted.map((r) =>
      api.get<any>(`/roles/${r.id}`).then((d) => [r.name, d.grants ?? []] as const).catch(() => [r.name, []] as const),
    )).then((pairs) => { if (!dead) setGrants(Object.fromEntries(pairs)); });
    return () => { dead = true; };
  }, [roles.data]);

  const mark = (roleName: string, modules: string[]) => {
    const g = (grants[roleName] ?? []).filter((x) => modules.includes(x.module));
    if (!g.length) return 'n';
    return g.some((x) => x.record_scope === 'all') ? 'y' : 'p';
  };
  const pm = (v: string, i: number) => (
    <td key={i}><span className={`pm ${v}`}>{v === 'y' ? '✓' : v === 'p' ? '◐' : '–'}</span></td>
  );

  return (
    <>
      <div className="card">
        <div className="card-head"><h3><Ic k="shield" />Permission matrix (module-level)</h3></div>
        <div className="card-pad scroll-x">
          <table className="matrix">
            <thead><tr><th>Module</th>{MATRIX_ROLES.map((r) => <th key={r}>{r === 'Branch Manager' ? 'Branch Mgr' : r}</th>)}</tr></thead>
            <tbody>
              {MATRIX_ROWS.map(([label, mods]) => (
                <tr key={label}><td>{label}</td>{MATRIX_ROLES.map((r, i) => pm(mark(r, mods), i))}</tr>
              ))}
            </tbody>
          </table>
          <div className="legend" style={{ marginTop: 14 }}>
            <span className="li"><span className="pm y">✓</span> Full</span>
            <span className="li"><span className="pm p">◐</span> Partial / scoped</span>
            <span className="li"><span className="pm n">–</span> No access</span>
          </div>
        </div>
      </div>
      <TableCard title="Roles" cols={['Role', 'Type', 'Permissions', 'Users', 'Status']}
        rows={(roles.data ?? []).map((r) => [
          { node: <span className="nm">{r.name}</span> } as Cell,
          { b: [r.is_system ? 'System' : 'Custom', r.is_system ? 'b-indigo' : 'b-cyan'] } as Cell,
          String(r.permission_count ?? 0),
          String(r.user_count ?? 0),
          { b: [r.is_active === false ? 'Inactive' : 'Active', r.is_active === false ? 'b-gray' : 'b-green'] } as Cell,
        ])} empty="No roles" />
      <Blocks blocks={[{ type: 'caps', title: 'Permission depth', items: [
        { t: 'Module-level', d: 'View/create/edit/delete/export' }, { t: 'Field-level', d: 'Hide sensitive fields' },
        { t: 'Record-level', d: 'Scoped by Branch/Pipeline/Campaign' }, { t: 'Manager partial', d: 'Live-monitor, view-only or edit' }] }]} />
    </>
  );
}

function Audit() {
  const { refreshTick } = useScreen();
  const logs = useFetch<any[]>('/audit-logs?limit=100', [refreshTick]);
  const rows = logs.data ?? [];
  const todays = rows.filter((r) => new Date(r.occurred_at).toDateString() === new Date().toDateString());
  const ACT: Record<string, [string, string]> = {
    create: ['Create', 'b-green'], update: ['Update', 'b-cyan'], delete: ['Delete', 'b-rose'],
    login: ['Login', 'b-indigo'], permission_change: ['Permissions', 'b-amber'],
  };
  return (
    <>
      <Kpis items={[
        { lab: 'Activities today', val: String(todays.length), ic: 'bolt' },
        { lab: 'Edits', val: String(todays.filter((r) => r.action === 'update').length), ic: 'note' },
        { lab: 'Messages sent', val: '\u2014', ic: 'wa' },
        { lab: 'Calls logged', val: '\u2014', ic: 'phone' },
      ]} />
      <TableCard title="Activity log — all users" cols={['Time', 'User', 'Module', 'Activity', 'Detail']}
        rows={rows.map((r) => [
          { mono: new Date(r.occurred_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }), dim: true } as Cell,
          r.actor_name ?? 'System',
          String(r.entity_type ?? '—'),
          { b: ACT[r.action] ?? [r.action, 'b-gray'] } as Cell,
          r.entity_id ? `#${r.entity_id}` : '—',
        ])} empty="No audit entries yet" />
    </>
  );
}

function ActivityReports() {
  const { refreshTick } = useScreen();
  const logs = useFetch<any[]>('/audit-logs?limit=500', [refreshTick]);
  const rows = logs.data ?? [];
  const todays = rows.filter((r) => new Date(r.occurred_at).toDateString() === new Date().toDateString());
  const byUser = new Map<string, { logins: number; followups: number; edits: number }>();
  rows.forEach((r) => {
    const nm = r.actor_name ?? 'System';
    const u = byUser.get(nm) ?? { logins: 0, followups: 0, edits: 0 };
    if (r.action === 'login') u.logins++;
    else if (String(r.entity_type).includes('follow-ups')) u.followups++;
    else if (r.action === 'update' || r.action === 'create') u.edits++;
    byUser.set(nm, u);
  });
  return (
    <>
      <Kpis items={[
        { lab: 'Activities today', val: String(todays.length), ic: 'bolt' },
        { lab: 'Calls', val: '—', ic: 'calls' },
        { lab: 'WhatsApp', val: '—', ic: 'wa' },
        { lab: 'Edits logged', val: String(rows.filter((r) => r.action === 'update').length), ic: 'note' },
      ]} />
      <TableCard title="User activity" cols={['User', 'Logins', 'Calls', 'Follow-ups', 'Edits']}
        rows={[...byUser.entries()].map(([nm, u]) => [
          { node: <span className="nm">{nm}</span> } as Cell, String(u.logins), '\u2014', String(u.followups), String(u.edits),
        ])} empty="Activity accumulates as the team works" />
    </>
  );
}

function FunnelAnalytics() {
  const { refreshTick } = useScreen();
  const sum = useFetch<Summary>('/leads/summary', [refreshTick]);
  return <Funnel title="Conversion funnel" rows={sum.data ? funnelRows(sum.data.by_stage) : []}
    empty="The funnel fills as leads move through stages" />;
}

function WorkTasks() {
  const { refreshTick } = useScreen();
  const mine = useFetch<any[]>('/follow-ups?mine=1&status=pending&limit=50', [refreshTick]);
  return <MyTaskCard rows={mine.data ?? []} more={`${mine.data?.length ?? 0} open`} />;
}

function WaChat() {
  return (
    <div className="wa-wrap">
      <div className="wa-list">
        <div className="wa-list-head"><Ic k="wa" />Conversations</div>
        <div className="empty-note" style={{ marginTop: 30 }}>No conversations yet</div>
      </div>
      <div className="wa-thread">
        <div className="wa-msgs">
          <div className="empty-note" style={{ margin: 'auto' }}>
            WhatsApp Live Chat connects through the Meta Cloud API integration (Sprint 3).<br />
            Bot auto-replies, qualification flows and hand-over land with it.
          </div>
        </div>
        <div className="wa-comp">
          <button className="tplbtn"><Ic k="doc" /></button>
          <input placeholder="Type a message…" disabled />
          <button className="send" onClick={() => toast('Messaging connects in Sprint 3')}><Ic k="send" /></button>
        </div>
      </div>
    </div>
  );
}

function Sitemap() {
  const { go } = useScreen();
  const mods = APP.filter((m) => m.id !== 'map');
  const total = mods.reduce((a, m) => a + m.subs.length, 0);
  return (
    <>
      <div className="page-sub" style={{ marginBottom: 14 }}>
        All {mods.length} departments &amp; {total} sub-menus. Tap any item to open its screen. Amber = Phase 2. On phone, tap ☰ top-left for the menu.
      </div>
      <div className="mapgrid">
        {mods.map((m) => (
          <div className="card mapcard" key={m.id}>
            <div className="maphead"><Ic k={m.icon} /><span>{m.label}</span><b>{m.subs.length}</b>{m.phase ? <em>{m.phase}</em> : null}</div>
            <div className="mapchips">
              {m.subs.map((s) => (
                <button className={`mapchip ${s.spec.tag === 'p2' ? 'p2' : ''}`} key={s.id} onClick={() => go(m.id, s.id)}>
                  {s.label}{s.spec.tag === 'p2' ? <i>P2</i> : null}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/* ----------------------------- error logs ----------------------------- */
/* Administration › Error Logs — sanctioned client-approved addition ("show all
   errors, issues and highlight bugs"). Grouped by fingerprint by default;
   open errors row-tinted red, warnings amber, resolved muted. */

interface ErrSummary {
  errors_today: number; warnings_today: number; open_count: number; open_errors: number;
  resolved_week: number; top_path_7d: { path: string; count: number } | null;
  trend: Array<{ day: string; errors: number; warnings: number }>;
}

const errLevelBadge = (level: string): Cell =>
  ({ b: level === 'error' ? ['Error', 'b-hot'] : ['Warning', 'b-amber'] });
const errStatusBadge = (open: boolean): Cell =>
  ({ b: open ? ['Open', 'b-rose'] : ['Resolved', 'b-green'] });
const errRowClass = (level: string, open: boolean) =>
  !open ? 'row-res' : level === 'error' ? 'row-err' : 'row-warn';

function ErrTrendCard({ trend }: { trend: Array<{ day: string; errors: number; warnings: number }> }) {
  const max = Math.max(1, ...trend.map((t) => Math.max(Number(t.errors), Number(t.warnings))));
  const quiet = trend.every((t) => !Number(t.errors) && !Number(t.warnings));
  return (
    <div className="card">
      <div className="card-head">
        <h3><Ic k="analytics" />Errors &amp; warnings — last 14 days</h3>
        <div className="legend">
          <span className="li"><span className="sw" style={{ background: 'var(--danger)' }} />Errors</span>
          <span className="li"><span className="sw" style={{ background: 'var(--amber)' }} />Warnings</span>
        </div>
      </div>
      <div className="card-pad">
        {quiet ? <div className="empty-note">No errors or warnings in the last 14 days — the system is healthy</div> : (
          <>
            <div className="bars">
              {trend.map((t, i) => (
                <div className="col" key={i}>
                  <div className="bar" style={{ height: `${(Number(t.errors) / max) * 130}px`, background: 'var(--danger)' }} title={`${t.errors} errors`} />
                  <div className="bar alt" style={{ height: `${(Number(t.warnings) / max) * 130}px`, background: 'var(--amber)' }} title={`${t.warnings} warnings`} />
                </div>
              ))}
            </div>
            <div className="bars-x">{trend.map((t, i) => <span key={i}>{new Date(t.day).getDate()}</span>)}</div>
          </>
        )}
      </div>
    </div>
  );
}

function ErrorDetailModal({ row, grouped, onClose, onChanged }: {
  row: any; grouped: boolean; onClose: () => void; onChanged: () => void;
}) {
  const { can } = useAuth();
  const manage = can('errorlog.manage');
  const id = Number(grouped ? row.last_id : row.id);
  const [detail, setDetail] = useState<any>(null);
  const [occ, setOcc] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<any>(`/error-logs/${id}`).then(setDetail).catch((e) => { toast(e.message, true); onClose(); });
    api.get<{ rows: any[] }>(`/error-logs?fingerprint=${encodeURIComponent(row.fingerprint)}&limit=20`)
      .then((r) => setOcc(r.rows ?? [])).catch(() => setOcc([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try { await fn(); toast(msg); onChanged(); onClose(); }
    catch (e: any) { toast(e.message, true); }
    finally { setBusy(false); }
  };
  const setOne = (status: string) =>
    act(() => api.patch(`/error-logs/${id}`, { status }), status === 'resolved' ? 'Marked resolved' : 'Reopened');
  const setGroup = (status: string) =>
    act(() => api.patch('/error-logs/resolve-group', { fingerprint: row.fingerprint, status }),
      status === 'resolved' ? 'Group resolved' : 'Group reopened');

  const d = detail;
  const openNow = d?.status === 'open';
  const groupOpen = occ.some((o) => o.status === 'open');
  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ width: 760 }}>
        <div className="ah">
          <h3><Ic k="shield" />{d ? (d.level === 'error' ? 'Error' : 'Warning') : 'Loading…'} detail</h3>
          <button className="ax" onClick={onClose}><Ic k="x" /></button>
        </div>
        <div className="abody">
          {!d ? <div className="empty-note">Loading…</div> : (
            <>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
                {renderCell(errLevelBadge(d.level))}
                {renderCell(errStatusBadge(openNow))}
                {d.status_code ? <span className="bdg b-gray mono">{d.status_code}</span> : null}
                <span className="bdg b-indigo">{d.source === 'web' ? 'Web' : 'API'}</span>
                {grouped ? <span className="bdg b-cyan">{row.count} occurrence{Number(row.count) === 1 ? '' : 's'}</span> : null}
              </div>
              <div className="sheet-sec">
                <h5>Message</h5>
                <div style={{ fontSize: 13.5, fontWeight: 600, wordBreak: 'break-word' }}>{d.message}</div>
              </div>
              <div className="sheet-sec">
                <h5>Request context</h5>
                <div className="errctx">
                  <span className="k">When</span><span className="v mono">{new Date(d.occurred_at).toLocaleString('en-IN')}</span>
                  <span className="k">Endpoint</span><span className="v mono">{d.method ? `${d.method} ` : ''}{d.path || '—'}</span>
                  <span className="k">User</span><span className="v">{d.user_name || 'Anonymous / system'}</span>
                  <span className="k">IP</span><span className="v mono">{d.ip || '—'}</span>
                  <span className="k">Agent</span><span className="v" style={{ fontSize: 11.5 }}>{d.user_agent || '—'}</span>
                  <span className="k">Fingerprint</span><span className="v mono" style={{ fontSize: 11 }}>{d.fingerprint}</span>
                  {d.status === 'resolved' ? (<>
                    <span className="k">Resolved</span>
                    <span className="v">{d.resolved_by_name || '—'} · {d.resolved_at ? new Date(d.resolved_at).toLocaleString('en-IN') : ''}</span>
                  </>) : null}
                </div>
              </div>
              {d.stack ? (
                <div className="sheet-sec">
                  <h5>Stack trace</h5>
                  <pre className="stack-pre">{d.stack}</pre>
                </div>
              ) : null}
              {d.meta ? (
                <div className="sheet-sec">
                  <h5>Meta (redacted)</h5>
                  <pre className="stack-pre" style={{ maxHeight: 140 }}>{JSON.stringify(d.meta, null, 2)}</pre>
                </div>
              ) : null}
              <div className="sheet-sec">
                <h5>Occurrences ({occ.length}{occ.length === 20 ? '+' : ''})</h5>
                <TableCard cols={['Time', 'Code', 'User', 'Status']}
                  rows={occ.map((o) => [
                    { mono: fmtDT(o.occurred_at), dim: true } as Cell,
                    o.status_code ? { mono: String(o.status_code) } as Cell : '—',
                    o.user_name || '—',
                    errStatusBadge(o.status === 'open'),
                  ])} empty="No occurrences" />
              </div>
            </>
          )}
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Close</button>
          {manage && d && grouped && Number(row.count) > 1 ? (
            groupOpen
              ? <button className="btn" disabled={busy} onClick={() => setGroup('resolved')}><Ic k="check" />Resolve all ({occ.filter((o) => o.status === 'open').length || row.open_count})</button>
              : <button className="btn" disabled={busy} onClick={() => setGroup('open')}><Ic k="refresh" />Reopen group</button>
          ) : null}
          {manage && d ? (
            openNow
              ? <button className="btn primary" disabled={busy} onClick={() => setOne('resolved')}><Ic k="check" />Mark resolved</button>
              : <button className="btn primary" disabled={busy} onClick={() => setOne('open')}><Ic k="refresh" />Reopen</button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ErrorLogs() {
  const { refreshTick } = useScreen();
  const [grouped, setGrouped] = useState(true);
  const [f, setF] = useState<{ level?: string; source?: string; status?: string; from?: string; to?: string; q: string }>({ q: '' });
  const [tick, setTick] = useState(0);
  const [sel, setSel] = useState<any | null>(null);

  const params = new URLSearchParams();
  if (f.level) params.set('level', f.level);
  if (f.source) params.set('source', f.source);
  if (f.status) params.set('status', f.status);
  if (f.from) params.set('from', f.from);
  if (f.to) params.set('to', f.to);
  if (f.q.trim()) params.set('q', f.q.trim());
  if (grouped) params.set('grouped', 'true');
  params.set('limit', '100');

  const sum = useFetch<ErrSummary>('/error-logs/summary', [refreshTick, tick]);
  const data = useFetch<{ total: number; rows: any[] }>(`/error-logs?${params.toString()}`, [refreshTick, tick]);
  const rows = data.data?.rows ?? [];
  const bump = () => setTick((t) => t + 1);

  const chip = (label: string, icon: string, value: string | undefined, opts: Array<[string, string]>, set: (v?: string) => void) => (
    <div className="fchip" key={label}>
      <Ic k={icon} />{label}
      <select value={value ?? ''} onChange={(e) => set(e.target.value || undefined)}>
        <option value="">All</option>
        {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );
  const dateInp = (label: string, value: string | undefined, set: (v?: string) => void) => (
    <div className="fchip" key={label}>
      <Ic k="cal" />{label}
      <input type="date" value={value ?? ''} onChange={(e) => set(e.target.value || undefined)}
        style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }} />
    </div>
  );

  const cols = grouped
    ? ['Severity', 'Count', 'Message', 'Path', 'Source', 'Code', 'Last seen', 'Status', 'User']
    : ['Severity', 'Message', 'Path', 'Source', 'Code', 'Time', 'Status', 'User'];
  const rowCells = (r: any): Cell[] => {
    const open = grouped ? Number(r.open_count) > 0 : r.status === 'open';
    const cells: Cell[] = [errLevelBadge(r.level)];
    if (grouped) cells.push({ node: <b>{r.count}</b> });
    cells.push(
      { node: <span className="nm" style={{ fontSize: 12.5, wordBreak: 'break-word' }}>{String(r.message ?? '').slice(0, 120)}</span> },
      { mono: r.path || '—', dim: true },
      { b: [r.source === 'web' ? 'Web' : 'API', 'b-indigo'] },
      r.status_code ? { mono: String(r.status_code) } as Cell : '—',
      { mono: fmtDT(grouped ? r.last_seen : r.occurred_at), dim: true },
      errStatusBadge(open),
      r.user_name || '—',
    );
    return cells;
  };

  const k = sum.data;
  return (
    <>
      <Kpis items={[
        { lab: 'Errors today', val: String(k?.errors_today ?? 0), ic: 'clock' },
        { lab: 'Open issues', val: String(k?.open_count ?? 0), ic: 'shield', delta: k?.open_errors ? `${k.open_errors} bugs open` : undefined, tone: k?.open_errors ? 'down' : 'flat' },
        { lab: 'Warnings today', val: String(k?.warnings_today ?? 0), ic: 'rupee' },
        { lab: 'Resolved this week', val: String(k?.resolved_week ?? 0), ic: 'check' },
      ]} />
      <ErrTrendCard trend={k?.trend ?? []} />
      <div className="filters">
        {chip('Level', 'bolt', f.level, [['error', 'Error'], ['warning', 'Warning']], (v) => setF((x) => ({ ...x, level: v })))}
        {chip('Source', 'grid', f.source, [['api', 'API'], ['web', 'Web']], (v) => setF((x) => ({ ...x, source: v })))}
        {chip('Status', 'shield', f.status, [['open', 'Open'], ['resolved', 'Resolved']], (v) => setF((x) => ({ ...x, status: v })))}
        {dateInp('From', f.from, (v) => setF((x) => ({ ...x, from: v })))}
        {dateInp('To', f.to, (v) => setF((x) => ({ ...x, to: v })))}
        <div className="fchip"><Ic k="search" /><input style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }} placeholder="Search message / path…" value={f.q} onChange={(e) => setF((x) => ({ ...x, q: e.target.value }))} /></div>
        <button className="fchip" style={{ marginLeft: 'auto', cursor: 'pointer', color: grouped ? 'var(--primary)' : 'var(--text-muted)', borderColor: grouped ? 'var(--primary)' : undefined }}
          onClick={() => setGrouped((g) => !g)}>
          <Ic k={grouped ? 'grid' : 'list'} />{grouped ? 'Grouped' : 'All events'}
        </button>
      </div>
      <TableCard title={grouped ? 'Error groups' : 'Error events'} icon="shield"
        more={`${data.data?.total ?? 0} ${grouped ? 'groups' : 'events'}`}
        cols={cols} rows={rows.map(rowCells)}
        rowClass={(i) => errRowClass(rows[i].level, grouped ? Number(rows[i].open_count) > 0 : rows[i].status === 'open')}
        empty="No errors captured — the system is healthy"
        onRowClick={(i) => setSel(rows[i])} />
      {sel && (
        <ErrorDetailModal row={sel} grouped={grouped} onClose={() => setSel(null)} onChanged={bump} />
      )}
    </>
  );
}

/* ------------------------------ registry ------------------------------ */

export const DYN: Record<string, () => JSX.Element> = {
  dashOverview: DashOverview,
  quickContact: QuickContact,
  myTasks: MyTasks,
  todayFollowups: TodayFollowups,
  quickStats: QuickStats,
  calendar: Calendar,
  leadsAll: LeadsAll,
  followups: Followups,
  kanban: Kanban,
  scoring: Scoring,
  sources: Sources,
  sla: Sla,
  branches: Branches,
  verticals: Verticals,
  pipelines: Pipelines,
  campaigns: Campaigns,
  courses: Courses,
  users: Users,
  roles: Roles,
  audit: Audit,
  errorLogs: ErrorLogs,
  activityReports: ActivityReports,
  funnelAnalytics: FunnelAnalytics,
  workTasks: WorkTasks,
  waChat: WaChat,
  sitemap: Sitemap,
};

export { checkS };
