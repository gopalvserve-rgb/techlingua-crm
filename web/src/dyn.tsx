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
import { AddModal, CampaignModal, need, EditSpec } from './forms';
import { PhoneInput } from './phonefield';
import { AddMasterModal, MASTER_LABELS } from './mastermodal';
import { RoleModal } from './rolemodal';
import {
  ConfirmModal, DetailModal, IncInactiveChip, KV, Section, fmtFull, rowActions, toggleCell,
} from './rowactions';
import { ImpactList, ImpactReport, useDelete } from './deletemodal';
import { APP } from './specs';
import { StageConfigurator } from './stageconfig';
import LeadImport from './leadimport';
import Channels from './channels';

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

/* Client update #4 — task/follow-up priority (colour-coded like lead priority). */
const PRIO_CLASS: Record<string, string> = { high: 'b-rose', medium: 'b-amber', low: 'b-cyan' };
const PRIO_LABEL: Record<string, string> = { high: 'High', medium: 'Medium', low: 'Low' };

function PrioBadge({ value }: { value?: string }) {
  const p = value || 'medium';
  return <span className={`bdg ${PRIO_CLASS[p] ?? 'b-gray'}`}>{PRIO_LABEL[p] ?? p}</span>;
}

/** Inline-editable priority: badge-coloured select, PATCHes the follow-up. */
function PrioSelect({ id, value, onChanged, disabled }: { id: number; value?: string; onChanged?: () => void; disabled?: boolean }) {
  const p = value || 'medium';
  if (disabled) return <PrioBadge value={p} />;
  return (
    <select className={`bdg ${PRIO_CLASS[p] ?? 'b-gray'}`}
      style={{ border: 'none', cursor: 'pointer', appearance: 'none', fontFamily: 'inherit' }}
      value={p} title="Set priority"
      onClick={(e) => e.stopPropagation()}
      onChange={async (e) => {
        e.stopPropagation();
        try { await api.patch(`/follow-ups/${id}`, { priority: e.target.value }); toast('Priority updated'); onChanged?.(); }
        catch (err: any) { toast(err.message, true); }
      }}>
      {(['low', 'medium', 'high'] as const).map((x) => <option key={x} value={x}>{PRIO_LABEL[x]}</option>)}
    </select>
  );
}

function leadRow(l: any): Cell[] {
  const overdue = l.next_follow_up_at && new Date(l.next_follow_up_at) < new Date();
  return [
    { node: (
      <div className="cell-u">
        <Avatar name={l.full_name} />
        <div><div className="nm">{l.full_name}</div><div className="sub mono">{l.phone}</div></div>
      </div>) },
    l.course_name || '—',
    `${dn(l.vertical_name, l.vertical_deleted)} · ${dn(l.pipeline_name, l.pipeline_deleted)}`,
    { b: [dn(l.source_name, l.source_deleted) || '—', 'b-indigo'] },
    { node: <TempBadge temperature={l.temperature} score={l.score} /> },
    l.owner_name || 'Unassigned',
    { b: [l.stage_name || '—', l.stage_type === 'won' ? 'b-green' : l.stage_type === 'lost' ? 'b-rose' : 'b-cyan'] },
    { node: <span className="mono sub" style={overdue ? { color: 'var(--danger)' } : undefined}>{fmtDT(l.next_follow_up_at)}</span> },
  ];
}

/** Soft delete: display joins keep deleted ancestors; suffix them "(deleted)". */
const dn = (name: string | null | undefined, deleted?: boolean) =>
  (name ? `${name}${deleted ? ' (deleted)' : ''}` : name ?? '—');

const nameOf = (list: Array<{ id: number; name: string }>, id: unknown) =>
  (id == null ? null : list.find((x) => Number(x.id) === Number(id))?.name ?? null);

const statusBadge = (active: boolean): Cell => ({ b: [active ? 'Active' : 'Inactive', active ? 'b-green' : 'b-gray'] });

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

function MyTaskCard({ rows, more, title = 'My Tasks', empty }: { rows: any[]; more?: string; title?: string; empty?: string }) {
  const { bump, openLead } = useScreen();
  const { can } = useAuth();
  const canEdit = can('followup.update');
  const complete = async (id: number) => {
    try { await api.patch(`/follow-ups/${id}`, { complete: true }); toast('Task marked done'); bump(); }
    catch (e: any) { toast(e.message, true); }
  };
  return (
    <div className="card">
      <div className="card-head"><h3><Ic k="check" />{title}</h3><span className="more">{more || ''}</span></div>
      {rows.length === 0 ? <div className="lrow empty">{empty || 'No open tasks — follow-ups you own appear here'}</div> :
        rows.map((f) => (
          <div className="lrow" key={f.id}>
            <div className="chk" onClick={() => complete(f.id)} title="Mark done" />
            <div className="gr" style={{ cursor: 'pointer' }} onClick={() => openLead(f.lead_id)}>
              <div className="t1">{f.type_name || 'Follow-up'} — {f.lead_name}</div>
              <div className="t2">
                {f.notes || `${f.course_name || ''}`}
                {f.report_to_name ? <span style={{ color: 'var(--text-dim)' }}> · Reports to {f.report_to_name}</span> : null}
              </div>
            </div>
            <PrioSelect id={Number(f.id)} value={f.priority} onChanged={bump} disabled={!canEdit} />
            <span className="rt">{fmtDT(f.scheduled_at)}</span>
          </div>
        ))}
    </div>
  );
}

function MyTasks() {
  const { refreshTick } = useScreen();
  // client update #4 — two views: Assigned to Me (owner) | Reported by Me (creator)
  const [view, setView] = useState<'assigned' | 'reported'>('assigned');
  const sum = useFetch<any>('/follow-ups/summary', [refreshTick]);
  const list = useFetch<any[]>(`/follow-ups?view=${view}&status=pending&limit=50`, [view, refreshTick]);
  const s = sum.data ?? {};
  const k = view === 'assigned'
    ? { open: s.my_open, due: s.my_due_today, over: s.my_overdue, done: s.my_done_week }
    : { open: s.reported_open, due: s.reported_due_today, over: s.reported_overdue, done: s.reported_done_week };
  return (
    <>
      <div className="seltabs" style={{ marginBottom: 14 }}>
        <button className={view === 'assigned' ? 'on' : ''} onClick={() => setView('assigned')}>
          Assigned to Me{s.my_open != null ? ` (${s.my_open})` : ''}
        </button>
        <button className={view === 'reported' ? 'on' : ''} onClick={() => setView('reported')}>
          Reported by Me{s.reported_open != null ? ` (${s.reported_open})` : ''}
        </button>
      </div>
      <Kpis items={[
        { lab: 'Open tasks', val: String(k.open ?? '0'), ic: 'check' },
        { lab: 'Due today', val: String(k.due ?? '0'), ic: 'clock' },
        { lab: 'Overdue', val: String(k.over ?? '0'), ic: 'clock', tone: 'down', delta: k.over > 0 ? 'needs attention' : undefined },
        { lab: 'Done this week', val: String(k.done ?? '0'), ic: 'check' },
      ]} />
      <MyTaskCard rows={list.data ?? []} more={`${k.open ?? 0} open`}
        title={view === 'assigned' ? 'Assigned to Me' : 'Reported by Me'}
        empty={view === 'assigned' ? 'No open tasks assigned to you' : 'No open tasks reported by you'} />
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
    // phone values carry "+<dial><national>" — search by digits, country-agnostic
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
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <div style={{ flex: 1, minWidth: 0 }}><PhoneInput value={phone} onChange={setPhone} placeholder="Contact Number" /></div>
                <button className="verify" style={{ position: 'static', flex: '0 0 auto' }} title="Verify" onClick={() => toast('Number verification lands with the messaging integration (Sprint 3)')}><Ic k="check" w={2.6} /></button>
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
  const { openLead, refreshTick, bump } = useScreen();
  const { can } = useAuth();
  const canEditLead = can('lead.update');
  const canDeleteLead = can('lead.delete');
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
  const del = useDelete('Lead', '/leads', () => bump());

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
        <div className="fchip"><Ic k="search" /><input style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }} placeholder="Search name / phone / email…" value={f.q} onChange={(e) => setF((x) => ({ ...x, q: e.target.value }))} /></div>
        <div className="fchip" style={{ marginLeft: 'auto', color: 'var(--primary)', borderColor: 'var(--primary)' }}><Ic k="intel" />AI sort: Hot first</div>
      </div>
      <TableCard title="Leads" more={`${data.data?.total ?? 0} in scope`} cols={[...LEAD_COLS, 'Actions']}
        rows={(data.data?.rows ?? []).map((l) => [...leadRow(l), rowActions({
          onView: () => openLead(Number(l.id)),
          onEdit: canEditLead ? () => openLead(Number(l.id)) : undefined,
          onDelete: canDeleteLead ? () => del.openDelete(Number(l.id), l.full_name) : undefined,
        })])}
        empty="No leads in scope yet — add a lead or connect a source"
        onRowClick={(i) => openLead(Number(data.data!.rows[i].id))} />
      {del.deleteModal}
    </>
  );
}

function Followups() {
  const { openLead, refreshTick, bump } = useScreen();
  const { can } = useAuth();
  const canEdit = can('followup.update');
  const canDelete = can('followup.delete');
  const del = useDelete('Follow-up', '/follow-ups', () => bump());
  const [prio, setPrio] = useState<string>('');
  const sum = useFetch<any>('/follow-ups/summary', [refreshTick]);
  const list = useFetch<any[]>(`/follow-ups?limit=100${prio ? `&priority=${prio}` : ''}`, [prio, refreshTick]);
  const rows = (list.data ?? []).map((fx) => ({ leadId: fx.lead_id, id: Number(fx.id), name: `${fx.lead_name}${fx.lead_deleted ? ' (deleted)' : ''} · ${fmtDT(fx.scheduled_at)}`, row: [
    { node: <span className="nm">{dn(fx.lead_name, fx.lead_deleted)}</span> } as Cell,
    { b: [fx.type_name || 'Follow-up', fx.type_name === 'WhatsApp' ? 'b-green' : 'b-indigo'] } as Cell,
    { node: <PrioSelect id={Number(fx.id)} value={fx.priority} onChanged={bump} disabled={!canEdit} /> } as Cell,
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
      <div className="filters">
        <div className="fchip"><Ic k="bolt" />Priority
          <select value={prio} onChange={(e) => setPrio(e.target.value)}>
            <option value="">All</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
          </select>
        </div>
      </div>
      <TableCard title="Upcoming follow-ups" cols={['Lead', 'Type', 'Priority', 'Owner', 'Due', 'Disposition', 'Actions']}
        rows={rows.map((r) => [...r.row, rowActions({
          onView: () => openLead(r.leadId),
          onDelete: canDelete ? () => del.openDelete(r.id, r.name) : undefined,
        })])}
        empty="No follow-ups scheduled yet"
        onRowClick={(i) => openLead(rows[i].leadId)} />
      {del.deleteModal}
    </>
  );
}

const KANBAN_COLORS = ['var(--success)', 'var(--accent)', 'var(--primary)', '#22c7c0', 'var(--amber)', 'var(--success)', 'var(--danger)'];

function Kanban() {
  const { openLead, refreshTick } = useScreen();
  const ref = useRef_();
  const [pipelineId, setPipelineId] = useState<number>();
  const pid = pipelineId ?? (ref.pipelines[0] ? Number(ref.pipelines[0].id) : undefined);
  const stages = useFetch<any[]>(pid ? `/pipelines/${pid}/stages` : null, [pid, refreshTick]);
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
  const { refreshTick, bump } = useScreen();
  const { can } = useAuth();
  const ref = useRef_();
  const [inc, setInc] = useState(false);
  const list = useFetch<any[]>(`/sources${inc ? '?include_inactive=1' : ''}`, [refreshTick]);
  const rows = list.data ?? [];
  const [view, setView] = useState<any | null>(null);
  const [edit, setEdit] = useState<any | null>(null);
  const canEdit = can('source.update');
  const del = useDelete('Source', '/sources', () => { list.reload(); ref.reload(); bump(); });
  const after = () => { list.reload(); ref.reload(); bump(); };
  const CAPTURE: Record<string, [string, string]> = {
    meta: ['Auto \u00b7 webhook', 'b-green'], google: ['Auto \u00b7 webhook', 'b-green'], justdial: ['Auto \u00b7 API', 'b-green'],
    indiamart: ['Auto \u00b7 API', 'b-green'], form: ['Auto', 'b-green'], webhook: ['Auto', 'b-green'],
    sheet: ['Manual / bulk', 'b-amber'], walkin: ['Manual', 'b-gray'], referral: ['Manual', 'b-gray'], manual: ['Manual', 'b-gray'],
  };
  return (
    <>
      <div className="filters"><IncInactiveChip on={inc} set={setInc} /></div>
      <TableCard title="Connected sources" cols={['Source', 'Campaign', 'Capture', 'This month', 'Cost/lead', 'Status', 'Actions']}
        rowClass={(i) => (rows[i].is_active === false ? 'row-inactive' : undefined)}
        rows={rows.map((so) => {
          const cap = CAPTURE[so.channel as string] ?? ['Manual', 'b-gray'];
          return [
            { node: <span className="nm">{so.name}</span> } as Cell,
            String(so.campaign_name ?? '\u2014'),
            { b: cap } as Cell,
            '\u2014',
            '\u2014',
            toggleCell({
              active: so.is_active !== false, name: so.name, entity: 'Source', canToggle: canEdit,
              onToggle: async (next) => { await api.patch(`/sources/${so.id}`, { is_active: next }); after(); },
            }),
            rowActions({
              onView: () => setView(so), onEdit: canEdit ? () => setEdit(so) : undefined,
              onDelete: can('source.delete') ? () => del.openDelete(Number(so.id), so.name) : undefined,
            }),
          ];
        })} empty="No sources connected yet \u2014 add one per campaign" />
      {del.deleteModal}
      {view && (
        <DetailModal title={`Source \u2014 ${view.name}`} icon="leads" onClose={() => setView(null)}>
          <Section title="Details">
            <KV rows={[
              ['Name', view.name],
              ['Campaign', view.campaign_name ?? '\u2014'],
              ['Channel', <span className="mono">{view.channel ?? 'manual'}</span>],
              ['Status', renderCell(statusBadge(view.is_active !== false))],
              ['Webhook', view.webhook_token
                ? <>{renderCell({ b: ['Live', 'b-green'] })} <span className="mono sub" style={{ fontSize: 11 }}>{view.webhook_token}</span></>
                : renderCell({ b: ['Manual capture', 'b-gray'] })],
            ]} />
          </Section>
          <Section title="Record">
            <KV rows={[
              ['Created', fmtFull(view.created_at)],
              ['Created by', nameOf(ref.users, view.created_by) ?? '\u2014'],
              ['Updated', fmtFull(view.updated_at)],
            ]} />
          </Section>
        </DetailModal>
      )}
      {edit && (
        <AddModal formKey="leads.sources" onClose={() => setEdit(null)} onSaved={after}
          edit={{
            title: `Edit Source \u2014 ${edit.name}`,
            initialVals: {
              'Source Name': edit.name ?? '', 'Campaign': edit.campaign_name ?? '',
              'Source Category': edit.channel ?? 'manual',
              'Cost per Lead (if fixed/paid)': edit.cost_per_lead != null && Number(edit.cost_per_lead) !== 0
                ? String(Number(edit.cost_per_lead)) : '',
              'Status': edit.is_active === false ? 'Inactive' : 'Active',
            },
            // only the parent link is immutable (DEF-2)
            lock: ['Campaign'],
            submit: async (vals) => {
              await api.patch(`/sources/${edit.id}`, {
                name: need(vals['Source Name'], 'Source name is required'),
                channel: vals['Source Category'] || 'manual',
                cost_per_lead: vals['Cost per Lead (if fixed/paid)'] || 0,
                is_active: vals['Status'] !== 'Inactive',
              });
              return 'Source updated';
            },
          }} />
      )}
    </>
  );
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

/** DB enum -> the prototype's Branch Type labels (and back, in HierarchyService.branchType). */
const BRANCH_TYPE_LABEL: Record<string, string> = { company: 'Company Branch', franchise: 'Franchise Branch' };

function Branches() {
  const { refreshTick, bump } = useScreen();
  const { can } = useAuth();
  const ref = useRef_();
  const [inc, setInc] = useState(false);
  const list = useFetch<any[]>(`/branches${inc ? '?include_inactive=1' : ''}`, [refreshTick]);
  const rows = list.data ?? [];
  const [view, setView] = useState<any | null>(null);
  const [edit, setEdit] = useState<any | null>(null);
  const canEdit = can('branch.update');
  const del = useDelete('Branch', '/branches', () => { list.reload(); ref.reload(); bump(); });
  const after = () => { list.reload(); ref.reload(); bump(); };

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
      <div className="filters"><IncInactiveChip on={inc} set={setInc} /></div>
      <TableCard title="Branches" cols={['Branch', 'Code', 'City', 'Verticals', 'Status', 'Actions']}
        rowClass={(i) => (rows[i].is_active === false ? 'row-inactive' : undefined)}
        rows={rows.map((b) => [
          { node: <span className="nm">{b.name}</span> } as Cell,
          { mono: String(b.code ?? '\u2014') } as Cell,
          String(b.city_name ?? '\u2014'),
          String(b.vertical_count ?? 0),
          toggleCell({
            active: b.is_active !== false, name: b.name, entity: 'Branch', canToggle: canEdit,
            onToggle: async (next) => { await api.patch(`/branches/${b.id}`, { is_active: next }); after(); },
          }),
          rowActions({
            onView: () => setView(b), onEdit: canEdit ? () => setEdit(b) : undefined,
            onDelete: can('branch.delete') ? () => del.openDelete(Number(b.id), b.name) : undefined,
          }),
        ])} empty="No branches yet" />
      {del.deleteModal}
      {view && (
        <DetailModal title={`Branch \u2014 ${view.name}`} icon="branch" onClose={() => setView(null)}>
          <Section title="Details">
            <KV rows={[
              ['Name', view.name],
              ['Code', <span className="mono">{view.code ?? '\u2014'}</span>],
              ['Type', BRANCH_TYPE_LABEL[String(view.branch_type ?? '')] ?? '\u2014'],
              ['Status', renderCell(statusBadge(view.is_active !== false))],
              ['City', view.city_name ?? '\u2014'],
              ['State', view.state_name ?? '\u2014'],
              ['Address', view.address || '\u2014'],
              ['Contact Number', view.contact_number || '\u2014'],
              ['Branch Email', view.email || '\u2014'],
              ['Branch Head', view.head_name || '\u2014'],
              ['Verticals', String(view.vertical_count ?? 0)],
            ]} />
          </Section>
          <Section title="Record">
            <KV rows={[
              ['Created', fmtFull(view.created_at)],
              ['Created by', nameOf(ref.users, view.created_by) ?? '\u2014'],
              ['Updated', fmtFull(view.updated_at)],
            ]} />
          </Section>
        </DetailModal>
      )}
      {edit && (
        <AddModal formKey="admin.branches" onClose={() => setEdit(null)} onSaved={after}
          edit={{
            title: `Edit Branch \u2014 ${edit.name}`,
            // DEF-2: every field the Add Branch form shows is editable here and prefilled.
            initialVals: {
              'Branch Name': edit.name ?? '', 'Branch Code': edit.code ?? '',
              'Branch Type': BRANCH_TYPE_LABEL[String(edit.branch_type ?? '')] ?? '',
              'Address': edit.address ?? '',
              'State': edit.state_name ?? '', 'City': edit.city_name ?? '',
              'Contact Number': edit.contact_number ?? '', 'Branch Email': edit.email ?? '',
              'Branch Head': edit.head_name ?? '',
              'Status': edit.is_active === false ? 'Inactive' : 'Active',
            },
            initialIds: {
              'State': edit.state_id ? Number(edit.state_id) : undefined,
              'City': edit.city_id ? Number(edit.city_id) : undefined,
              'Branch Head': edit.head_user_id ? Number(edit.head_user_id) : undefined,
            },
            submit: async (vals, ids) => {
              await api.patch(`/branches/${edit.id}`, {
                name: need(vals['Branch Name'], 'Branch name is required'),
                code: need(vals['Branch Code'], 'Branch code is required'),
                branch_type: vals['Branch Type'] || null,
                address: vals['Address'] || null,
                state_id: ids['State'] ?? null,
                city_id: ids['City'] ?? null,
                contact_number: vals['Contact Number'] || null,
                email: vals['Branch Email'] || null,
                head_user_id: ids['Branch Head'] ?? null,
                is_active: vals['Status'] !== 'Inactive',
              });
              return 'Branch updated';
            },
          }} />
      )}
    </>
  );
}

function Verticals() {
  const { refreshTick, bump } = useScreen();
  const { can } = useAuth();
  const ref = useRef_();
  const [inc, setInc] = useState(false);
  const list = useFetch<any[]>(`/verticals${inc ? '?include_inactive=1' : ''}`, [refreshTick]);
  const rows = list.data ?? [];
  const [view, setView] = useState<any | null>(null);
  const [edit, setEdit] = useState<any | null>(null);
  const canEdit = can('vertical.update');
  const del = useDelete('Vertical', '/verticals', () => { list.reload(); ref.reload(); bump(); });
  const after = () => { list.reload(); ref.reload(); bump(); };
  return (
    <>
      <div className="filters"><IncInactiveChip on={inc} set={setInc} /></div>
      <TableCard title="Verticals" cols={['Vertical', 'Branch', 'Head', 'SMTP Domain', 'Status', 'Actions']}
        rowClass={(i) => (rows[i].is_active === false ? 'row-inactive' : undefined)}
        rows={rows.map((v) => [
          { node: <span className="nm">{v.name}</span> } as Cell,
          String(v.branch_name ?? '\u2014'),
          '\u2014',
          { mono: String((v.smtp_config as any)?.domain ?? (v.smtp_config as any)?.host ?? '\u2014') } as Cell,
          toggleCell({
            active: v.is_active !== false, name: v.name, entity: 'Vertical', canToggle: canEdit,
            onToggle: async (next) => { await api.patch(`/verticals/${v.id}`, { is_active: next }); after(); },
          }),
          rowActions({
            onView: () => setView(v), onEdit: canEdit ? () => setEdit(v) : undefined,
            onDelete: can('vertical.delete') ? () => del.openDelete(Number(v.id), v.name) : undefined,
          }),
        ])} empty="No verticals yet" />
      {del.deleteModal}
      {view && (
        <DetailModal title={`Vertical \u2014 ${view.name}`} icon="grid" onClose={() => setView(null)}>
          <Section title="Details">
            <KV rows={[
              ['Name', view.name],
              ['Code', <span className="mono">{view.code ?? '\u2014'}</span>],
              ['Branch', view.branch_name ?? '\u2014'],
              ['Status', renderCell(statusBadge(view.is_active !== false))],
              ['Pipelines', String(view.pipeline_count ?? 0)],
              ['SMTP Domain', <span className="mono">{String((view.smtp_config as any)?.domain ?? (view.smtp_config as any)?.host ?? '\u2014')}</span>],
              ['Gateway', Object.keys((view.gateway_config as any) ?? {}).length ? 'Configured' : 'Not configured'],
            ]} />
          </Section>
          <Section title="Record">
            <KV rows={[
              ['Created', fmtFull(view.created_at)],
              ['Created by', nameOf(ref.users, view.created_by) ?? '\u2014'],
              ['Updated', fmtFull(view.updated_at)],
            ]} />
          </Section>
        </DetailModal>
      )}
      {edit && (
        <AddModal formKey="admin.verticals" onClose={() => setEdit(null)} onSaved={after}
          edit={{
            title: `Edit Vertical \u2014 ${edit.name}`,
            initialVals: {
              'Vertical Name': edit.name ?? '', 'Vertical Code': edit.code ?? '',
              'Branch': edit.branch_name ?? '', 'Vertical Head': edit.head_name ?? '',
              'Description': edit.description ?? '',
              'Status': edit.is_active === false ? 'Inactive' : 'Active',
            },
            initialIds: { 'Vertical Head': edit.head_user_id ? Number(edit.head_user_id) : undefined },
            // only the parent link is immutable — the rest is editable (DEF-2)
            lock: ['Branch'],
            submit: async (vals, ids) => {
              await api.patch(`/verticals/${edit.id}`, {
                name: need(vals['Vertical Name'], 'Vertical name is required'),
                code: need(vals['Vertical Code'], 'Vertical code is required'),
                head_user_id: ids['Vertical Head'] ?? null,
                description: vals['Description'] || null,
                is_active: vals['Status'] !== 'Inactive',
              });
              return 'Vertical updated';
            },
          }} />
      )}
    </>
  );
}

const STAGE_TYPES: Array<[string, string]> = [['open', 'Open'], ['won', 'Won'], ['lost', 'Lost']];
const stageTypeBadge = (t: string): Cell =>
  ({ b: [STAGE_TYPES.find(([k]) => k === t)?.[1] ?? t, t === 'won' ? 'b-green' : t === 'lost' ? 'b-rose' : 'b-cyan'] });

function StageEditModal({ stage, onClose, onSaved }: { stage: any; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(stage.name ?? '');
  const [type, setType] = useState(stage.stage_type ?? 'open');
  const [active, setActive] = useState(stage.is_active !== false);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!name.trim()) return toast('Stage name is required', true);
    setBusy(true);
    try {
      await api.patch(`/stages/${stage.id}`, { name: name.trim(), stage_type: type, is_active: active });
      toast(`Stage "${name.trim()}" updated`);
      onSaved(); onClose();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <div className="add-scrim" style={{ zIndex: 280 }}>
      <div className="add-modal" style={{ width: 420 }}>
        <div className="ah"><h3><Ic k="pencil" />Edit Stage \u2014 {stage.name}</h3><button className="ax" onClick={onClose}><Ic k="x" /></button></div>
        <div className="abody">
          <div className="form-grid" style={{ gridTemplateColumns: '1fr', padding: 0 }}>
            <div className="fld"><label>Stage Name <span className="star">*</span></label>
              <input className="ainp" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="fld"><label>Stage Type</label>
              <select className="ainp" value={type} onChange={(e) => setType(e.target.value)}>
                {STAGE_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select></div>
            <div className="fld"><label>Status</label>
              <select className="ainp" value={active ? 'Active' : 'Inactive'} onChange={(e) => setActive(e.target.value === 'Active')}>
                <option>Active</option><option>Inactive</option>
              </select></div>
          </div>
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy}><Ic k="check" />Save changes</button>
        </div>
      </div>
    </div>
  );
}

function PipelineView({ pipeline, onClose, onChanged, onConfigure }: {
  pipeline: any; onClose: () => void; onChanged: () => void; onConfigure?: () => void;
}) {
  const { can } = useAuth();
  const ref = useRef_();
  const [tick, setTick] = useState(0);
  const stages = useFetch<any[]>(`/pipelines/${pipeline.id}/stages`, [tick]);
  const [editStage, setEditStage] = useState<any | null>(null);
  const canEdit = can('pipeline.update');
  const bumped = () => { setTick((t) => t + 1); onChanged(); };
  return (
    <DetailModal title={`Pipeline \u2014 ${pipeline.name}`} icon="list" width={640} onClose={onClose}
      footer={onConfigure
        ? <button className="btn primary" onClick={onConfigure}><Ic k="cfg" />Stage Configurator</button>
        : undefined}>
      <Section title="Details">
        <KV rows={[
          ['Name', pipeline.name],
          ['Code', <span className="mono">{pipeline.code ?? '\u2014'}</span>],
          ['Branch', pipeline.branch_name ?? '\u2014'],
          ['Vertical', pipeline.vertical_name ?? '\u2014'],
          ['Status', renderCell(statusBadge(pipeline.is_active !== false))],
        ]} />
      </Section>
      <Section title={`Stages (${(stages.data ?? []).length})`}>
        <TableCard cols={canEdit ? ['#', 'Stage', 'Type', 'Status', 'Actions'] : ['#', 'Stage', 'Type', 'Status']}
          rows={(stages.data ?? []).map((st, i) => {
            const cells: Cell[] = [
              { mono: String(i + 1), dim: true },
              { node: <span className="nm">{st.name}</span> },
              stageTypeBadge(st.stage_type),
              statusBadge(st.is_active !== false),
            ];
            if (canEdit) cells.push(rowActions({ onEdit: () => setEditStage(st) }));
            return cells;
          })} empty="No stages yet" />
      </Section>
      <Section title="Record">
        <KV rows={[
          ['Created', fmtFull(pipeline.created_at)],
          ['Created by', nameOf(ref.users, pipeline.created_by) ?? '\u2014'],
          ['Updated', fmtFull(pipeline.updated_at)],
        ]} />
      </Section>
      {editStage && <StageEditModal stage={editStage} onClose={() => setEditStage(null)} onSaved={bumped} />}
    </DetailModal>
  );
}

function Pipelines() {
  const { refreshTick, bump } = useScreen();
  const { can } = useAuth();
  const ref = useRef_();
  const [inc, setInc] = useState(false);
  const list = useFetch<any[]>(`/pipelines${inc ? '?include_inactive=1' : ''}`, [refreshTick]);
  const rows = list.data ?? [];
  const [view, setView] = useState<any | null>(null);
  const [edit, setEdit] = useState<any | null>(null);
  const [config, setConfig] = useState<any | null>(null); // stage configurator (client mockup)
  const canEdit = can('pipeline.update');
  const del = useDelete('Pipeline', '/pipelines', () => { list.reload(); ref.reload(); bump(); });
  const after = () => { list.reload(); ref.reload(); bump(); };
  const [stagesBy, setStagesBy] = useState<Record<number, string>>({});
  useEffect(() => {
    let dead = false;
    Promise.all(rows.map((p) =>
      api.get<any[]>(`/pipelines/${p.id}/stages`)
        .then((st) => [Number(p.id), st.filter((x) => x.is_active !== false).map((x) => x.name).join(' \u2192 ')] as const)
        .catch(() => [Number(p.id), '\u2014'] as const),
    )).then((pairs) => { if (!dead) setStagesBy(Object.fromEntries(pairs)); });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data]);
  if (config) {
    return <StageConfigurator pipeline={config} onBack={() => { setConfig(null); after(); }} afterChange={after} />;
  }
  return (
    <>
      <div className="filters"><IncInactiveChip on={inc} set={setInc} /></div>
      <TableCard title="Pipelines" cols={['Pipeline', 'Branch', 'Vertical', 'Stages', 'Status', 'Actions']}
        rowClass={(i) => (rows[i].is_active === false ? 'row-inactive' : undefined)}
        rows={rows.map((pl) => [
          { node: <span className="nm">{pl.name}</span> } as Cell,
          String(pl.branch_name ?? '\u2014'),
          String(pl.vertical_name ?? '\u2014'),
          stagesBy[Number(pl.id)] ?? '\u2026',
          toggleCell({
            active: pl.is_active !== false, name: pl.name, entity: 'Pipeline', canToggle: canEdit,
            onToggle: async (next) => { await api.patch(`/pipelines/${pl.id}`, { is_active: next }); after(); },
          }),
          rowActions({
            onView: () => setView(pl), onEdit: canEdit ? () => setEdit(pl) : undefined,
            onDelete: can('pipeline.delete') ? () => del.openDelete(Number(pl.id), pl.name) : undefined,
            extra: [{ k: 'cfg', title: 'Stages (configurator)', onClick: () => setConfig(pl) }],
          }),
        ])} empty="No pipelines yet" />
      {del.deleteModal}
      {view && <PipelineView pipeline={view} onClose={() => setView(null)} onChanged={after}
        onConfigure={() => { setConfig(view); setView(null); }} />}
      {edit && (
        <AddModal formKey="leads.pipelinemaster" onClose={() => setEdit(null)} onSaved={after}
          edit={{
            title: `Edit Pipeline \u2014 ${edit.name}`,
            initialVals: {
              'Pipeline Name': edit.name ?? '', 'Pipeline Code': edit.code ?? '',
              'Branch': edit.branch_name ?? '', 'Vertical': edit.vertical_name ?? '',
              'Pipeline Owner': edit.owner_name ?? '',
              'Pipeline Stages': 'Use the Stages action on the row to configure',
              'Status': edit.is_active === false ? 'Inactive' : 'Active',
            },
            initialIds: { 'Pipeline Owner': edit.owner_user_id ? Number(edit.owner_user_id) : undefined },
            // parent links + the stage set (edited in the Stage Configurator) stay locked (DEF-2)
            lock: ['Branch', 'Vertical', 'Pipeline Stages'],
            submit: async (vals, ids) => {
              await api.patch(`/pipelines/${edit.id}`, {
                name: need(vals['Pipeline Name'], 'Pipeline name is required'),
                code: need(vals['Pipeline Code'], 'Pipeline code is required'),
                owner_user_id: ids['Pipeline Owner'] ?? null,
                is_active: vals['Status'] !== 'Inactive',
              });
              return 'Pipeline updated';
            },
          }} />
      )}
    </>
  );
}

const DIST_LABEL: Record<string, string> = { on_demand: 'On Demand', equal: 'Equal', conditional: 'Conditional' };
const DIST_DESC: Record<string, string> = {
  on_demand: 'Leads stay unassigned until an agent picks them up (Start Calling assigns ten at a time).',
  equal: 'Distributes leads equally among all agents in the campaign.',
  conditional: 'Assigns leads to agents based on configured conditions.',
};
const DUP_SCOPE_LABEL: Record<string, string> = { this_campaign: 'Within this campaign', this_pipeline: 'Within this pipeline', global: 'All campaigns (global)' };
const DUP_ACTION_LABEL: Record<string, string> = {
  ignore: 'Ignore duplicate', merge: 'Merge duplicate', create: 'Create duplicate leads', merge_and_reopen: 'Merge & reopen closed leads',
};
const PRIORITY_LABEL: Record<string, string> = { low: 'Low', med: 'Medium', high: 'High' };

const OP_LABEL: Record<string, string> = { equals: '=', not_equals: '≠', contains: 'contains', in: 'in' };

function CampaignView({ campaign, leadCount, onClose }: { campaign: any; leadCount: number; onClose: () => void }) {
  const ref = useRef_();
  const dist = (campaign.distribution_config as any) ?? {};
  const userName = (id: number) => nameOf(ref.users, id) ?? `User #${id}`;
  const agentChips = (ids: unknown) => (Array.isArray(ids) && ids.length
    ? <span className="mapchips">{ids.map((id: number) => <span className="mapchip" key={id}>{userName(Number(id))}</span>)}</span>
    : null);
  const dup = (campaign.duplicacy_config as any) ?? {};
  const utm = (campaign.utm as any) ?? {};
  const utmPairs = Object.entries(utm).filter(([, v]) => v != null && v !== '');
  const cost = Number(campaign.cost ?? 0);
  const srcs = ref.sources.filter((x) => Number(x.campaign_id) === Number(campaign.id));
  return (
    <DetailModal title={`Campaign \u2014 ${campaign.name}`} icon="bolt" width={660} onClose={onClose}>
      <Section title="Overview">
        <KV rows={[
          ['Name', campaign.name],
          ['Path', `${campaign.branch_name ?? '\u2014'} \u203a ${campaign.vertical_name ?? '\u2014'} \u203a ${campaign.pipeline_name ?? '\u2014'}`],
          ['Status', renderCell(statusBadge(campaign.is_active !== false))],
          ['Priority', PRIORITY_LABEL[campaign.priority] ?? campaign.priority ?? '\u2014'],
          ['Spend', cost ? `\u20b9${cost.toLocaleString('en-IN')}` : '\u2014'],
          ['Leads', String(leadCount)],
          ['Cost / lead', cost && leadCount ? `\u20b9${Math.round(cost / leadCount).toLocaleString('en-IN')}` : '\u2014'],
          ['Sources', srcs.length ? srcs.map((x) => x.name).join(', ') : 'None connected'],
          ['UTM', utmPairs.length ? <span className="mono" style={{ fontSize: 11.5 }}>{utmPairs.map(([k, v]) => `${k}=${v}`).join(' \u00b7 ')}</span> : '\u2014'],
        ]} />
      </Section>
      <Section title="Lead distribution (NeoDove)">
        <KV rows={[
          ['Mode', <>{renderCell({ b: [DIST_LABEL[dist.mode] ?? dist.mode ?? '\u2014', 'b-indigo'] })}<div className="sub" style={{ marginTop: 4, fontSize: 11.5 }}>{DIST_DESC[dist.mode] ?? ''}</div></>],
          ['Batch size', String(dist.batch_size ?? '\u2014')],
          ['Agents', agentChips(dist.agent_user_ids)
            ?? (dist.mode === 'on_demand' ? 'Anyone in scope (self-assign)' : 'None selected')],
          ['Round robin', dist.round_robin_scope ?? '\u2014'],
          ['Conditions', Array.isArray(dist.conditions) && dist.conditions.length
            ? <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>{dist.conditions.map((c: any, i: number) => (
              <div key={i} style={{ fontSize: 12 }}>
                <span className="mono" style={{ fontSize: 11.5 }}>{c.field} {OP_LABEL[c.op] ?? c.op} {Array.isArray(c.value) ? c.value.join(', ') : String(c.value)}</span>
                {' \u2192 '}{agentChips(c.assign_to_user_ids) ?? '\u2014'}
              </div>))}</div>
            : 'None'],
        ]} />
      </Section>
      <Section title="Duplicacy rules (NeoDove)">
        <KV rows={[
          ['Check scope', DUP_SCOPE_LABEL[dup.check_scope] ?? dup.check_scope ?? '\u2014'],
          ['Match key', <span className="mono">{dup.match_key ?? 'phone'}</span>],
          ['On duplicate', DUP_ACTION_LABEL[dup.on_duplicate] ?? dup.on_duplicate ?? '\u2014'],
          ['Open lead \u2192 same user', dup.open_reassign_same_user ? 'Yes' : 'No'],
        ]} />
      </Section>
      <Section title="Record">
        <KV rows={[
          ['Created', fmtFull(campaign.created_at)],
          ['Created by', nameOf(ref.users, campaign.created_by) ?? '\u2014'],
          ['Updated', fmtFull(campaign.updated_at)],
        ]} />
      </Section>
    </DetailModal>
  );
}

function Campaigns() {
  const { refreshTick, bump } = useScreen();
  const { can } = useAuth();
  const ref = useRef_();
  const sum = useFetch<Summary>('/leads/summary', [refreshTick]);
  const [inc, setInc] = useState(false);
  const list = useFetch<any[]>(`/campaigns${inc ? '?include_inactive=1' : ''}`, [refreshTick]);
  const rows = list.data ?? [];
  const [view, setView] = useState<any | null>(null);
  const [edit, setEdit] = useState<any | null>(null);
  const canEdit = can('campaign.update');
  const del = useDelete('Campaign', '/campaigns', () => { list.reload(); ref.reload(); bump(); });
  const after = () => { list.reload(); ref.reload(); bump(); };
  const [counts, setCounts] = useState<Record<number, number>>({});
  useEffect(() => {
    let dead = false;
    Promise.all(rows.map((c) =>
      api.get<{ total: number }>(`/leads?campaign_id=${c.id}&limit=1`)
        .then((r) => [Number(c.id), r.total] as const).catch(() => [Number(c.id), 0] as const),
    )).then((pairs) => { if (!dead) setCounts(Object.fromEntries(pairs)); });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data, refreshTick]);
  return (
    <>
      <Kpis items={[
        { lab: 'Active campaigns', val: String(rows.filter((c) => c.is_active !== false).length), ic: 'bolt' },
        { lab: 'Leads (MTD)', val: String(sum.data?.kpis.mtd ?? '0'), ic: 'leads' },
        { lab: 'Avg CPL', val: '\u2014', ic: 'rupee' },
        { lab: 'Best conv%', val: '\u2014', ic: 'target' },
      ]} />
      <div className="filters"><IncInactiveChip on={inc} set={setInc} /></div>
      <TableCard title="Campaigns" cols={['Campaign', 'Pipeline', 'Source', 'UTM', 'Spend', 'Leads', 'CPL', 'Assign rule', 'Status', 'Actions']}
        rowClass={(i) => (rows[i].is_active === false ? 'row-inactive' : undefined)}
        rows={rows.map((c) => {
          const src = ref.sources.find((x) => Number(x.campaign_id) === Number(c.id));
          const utm = (c.utm as any)?.utm_campaign ?? (c.utm as any)?.utm_source ?? '\u2014';
          const leads = counts[Number(c.id)] ?? 0;
          const cost = Number(c.cost ?? 0);
          return [
            { node: <span className="nm">{c.name}</span> } as Cell,
            String(c.pipeline_name ?? '\u2014'),
            src ? ({ b: [src.name, 'b-indigo'] } as Cell) : '\u2014',
            { mono: utm === '\u2014' ? '\u2014' : `utm=${utm}`, dim: true } as Cell,
            cost ? `\u20b9${cost.toLocaleString('en-IN')}` : '\u2014',
            String(leads),
            cost && leads ? ({ mono: `\u20b9${Math.round(cost / leads)}` } as Cell) : '\u2014',
            DIST_LABEL[(c.distribution_config as any)?.mode] ?? '\u2014',
            toggleCell({
              active: c.is_active !== false, name: c.name, entity: 'Campaign', canToggle: canEdit,
              onToggle: async (next) => { await api.patch(`/campaigns/${c.id}`, { is_active: next }); after(); },
            }),
            rowActions({
              onView: () => setView(c), onEdit: canEdit ? () => setEdit(c) : undefined,
              onDelete: can('campaign.delete') ? () => del.openDelete(Number(c.id), c.name) : undefined,
            }),
          ];
        })} empty="No campaigns yet \u2014 create one to start pulling leads" />
      {del.deleteModal}
      {view && <CampaignView campaign={view} leadCount={counts[Number(view.id)] ?? 0} onClose={() => setView(null)} />}
      {edit && <CampaignModal initial={edit} onClose={() => setEdit(null)} onSaved={after} />}
    </>
  );
}

/** Edit spec for a course row — the full Configure Course form, shared by the
 *  Courses screen and Administration › Masters so Course always edits with all fields. */
const courseEditSpec = (edit: any): EditSpec => ({
  title: `Edit Course \u2014 ${edit.name}`,
  // DEF-2: nothing is locked — every Add Course field is editable and prefilled.
  initialVals: {
    'Course Name': edit.name ?? '', 'Course Code': edit.code ?? '',
    'Training Mode': (edit.meta as any)?.mode ?? '', 'Duration': (edit.meta as any)?.duration ?? '',
    'Standard Fee': (edit.meta as any)?.fee ?? '',
    'Eligibility Criteria': (edit.meta as any)?.eligibility ?? '',
    'Status': edit.is_active === false ? 'Inactive' : 'Active',
  },
  initialIds: {
    'Vertical': (edit.meta as any)?.vertical_id ? Number((edit.meta as any).vertical_id) : undefined,
    'Applicable Branch(es)': (edit.meta as any)?.branch_id ? Number((edit.meta as any).branch_id) : undefined,
  },
  submit: async (vals, ids) => {
    await api.patch(`/masters/course/${edit.id}`, {
      name: need(vals['Course Name'], 'Course name is required'),
      code: need(vals['Course Code'], 'Course code is required'),
      meta: {
        ...(edit.meta as any ?? {}),
        mode: vals['Training Mode'] || undefined,
        duration: vals['Duration'] || undefined,
        fee: vals['Standard Fee'] || undefined,
        vertical_id: ids['Vertical'] ?? undefined,
        branch_id: ids['Applicable Branch(es)'] ?? undefined,
        eligibility: vals['Eligibility Criteria'] || undefined,
      },
      is_active: vals['Status'] !== 'Inactive',
    });
    return 'Course updated';
  },
});

function Courses() {
  const { refreshTick, bump } = useScreen();
  const { can } = useAuth();
  const ref = useRef_();
  const [inc, setInc] = useState(false);
  const list = useFetch<any[]>(`/masters/course${inc ? '?all=1' : ''}`, [refreshTick]);
  const rows = list.data ?? [];
  const [view, setView] = useState<any | null>(null);
  const [edit, setEdit] = useState<any | null>(null);
  const canEdit = can('master.update');
  const del = useDelete('Course', '/masters/course', () => { list.reload(); ref.reload(); bump(); });
  const after = () => { list.reload(); ref.reload(); bump(); };
  return (
    <>
      <div className="filters"><IncInactiveChip on={inc} set={setInc} /></div>
      <TableCard title="Course master" cols={['Code', 'Course', 'Vertical', 'Mode', 'Duration', 'Fee', 'Branches', 'Status', 'Actions']}
        rowClass={(i) => (rows[i].is_active === false ? 'row-inactive' : undefined)}
        rows={rows.map((c) => [
          { mono: String(c.code ?? '\u2014') } as Cell,
          { node: <span className="nm">{c.name}</span> } as Cell,
          String((c.meta as any)?.vertical ?? 'All'),
          String((c.meta as any)?.mode ?? '\u2014'),
          String((c.meta as any)?.duration ?? '\u2014'),
          String((c.meta as any)?.fee ?? '\u2014'),
          'All',
          toggleCell({
            active: c.is_active !== false, name: c.name, entity: 'Course', canToggle: canEdit,
            onToggle: async (next) => { await api.patch(`/masters/course/${c.id}`, { is_active: next }); after(); },
          }),
          rowActions({
            onView: () => setView(c), onEdit: canEdit ? () => setEdit(c) : undefined,
            onDelete: can('master.delete') ? () => del.openDelete(Number(c.id), c.name) : undefined,
          }),
        ])} empty="No courses in the master yet" />
      {del.deleteModal}
      {view && (
        <DetailModal title={`Course \u2014 ${view.name}`} icon="book" onClose={() => setView(null)}>
          <Section title="Details">
            <KV rows={[
              ['Name', view.name],
              ['Code', <span className="mono">{view.code ?? '\u2014'}</span>],
              ['Training mode', String((view.meta as any)?.mode ?? '\u2014')],
              ['Duration', String((view.meta as any)?.duration ?? '\u2014')],
              ['Standard fee', String((view.meta as any)?.fee ?? '\u2014')],
              ['Status', renderCell(statusBadge(view.is_active !== false))],
            ]} />
          </Section>
          <Section title="Record">
            <KV rows={[
              ['Created', fmtFull(view.created_at)],
              ['Created by', nameOf(ref.users, view.created_by) ?? '\u2014'],
              ['Updated', fmtFull(view.updated_at)],
            ]} />
          </Section>
        </DetailModal>
      )}
      {edit && (
        <AddModal formKey="students.courses" onClose={() => setEdit(null)} onSaved={after}
          edit={courseEditSpec(edit)} />
      )}
    </>
  );
}

function UserView({ user, onClose }: { user: any; onClose: () => void }) {
  const ref = useRef_();
  const [d, setD] = useState<any>(null);
  useEffect(() => {
    api.get<any>(`/users/${user.id}`).then(setD).catch((e) => { toast(e.message, true); onClose(); });
  }, [user.id, onClose]);
  const scopeOf = (a: any) => {
    const bits = [nameOf(ref.branches, a.branch_id), nameOf(ref.verticals, a.vertical_id),
      nameOf(ref.pipelines, a.pipeline_id), nameOf(ref.campaigns, a.campaign_id)].filter(Boolean);
    return bits.length ? bits.join(' \u203a ') : 'Org-wide';
  };
  return (
    <DetailModal title={`User \u2014 ${user.name}`} icon="users" width={620} onClose={onClose}>
      {!d ? <div className="empty-note">Loading\u2026</div> : (
        <>
          <Section title="Profile">
            <KV rows={[
              ['Name', d.name],
              ['Email', <span className="mono">{d.email}</span>],
              ['Phone', d.phone ? <span className="mono">{d.phone}</span> : '\u2014'],
              ['Status', renderCell(statusBadge(d.status !== 'disabled'))],
              ['MFA', d.mfa_enabled ? 'Enabled' : 'Off'],
            ]} />
          </Section>
          <Section title={`Assignments (${(d.assignments ?? []).length})`}>
            <TableCard cols={['Role', 'Scope']}
              rows={(d.assignments ?? []).map((a: any) => [
                { b: [a.role_name, 'b-indigo'] } as Cell,
                scopeOf(a),
              ])} empty="No role assignments" />
          </Section>
          <Section title={`Teams (${(d.teams ?? []).length})`}>
            {(d.teams ?? []).length === 0 ? <div className="empty-note">Not part of any team</div> : (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {(d.teams ?? []).map((t: any) => (
                  <span key={t.id} className={`bdg ${t.is_leader ? 'b-green' : 'b-cyan'}`}>{t.name}{t.is_leader ? ' \u00b7 leader' : ''}</span>
                ))}
              </div>
            )}
          </Section>
          <Section title="Record">
            <KV rows={[['Created', fmtFull(d.created_at)]]} />
          </Section>
        </>
      )}
    </DetailModal>
  );
}

function Users() {
  const { refreshTick, bump } = useScreen();
  const { can } = useAuth();
  const ref = useRef_();
  const roles = useFetch<any[]>(can('role.read') ? '/roles' : null, []);
  const [f, setF] = useState<{ role?: number; branch?: number; status?: string; q: string }>({ q: '' });
  const params = new URLSearchParams();
  if (f.role) params.set('role_id', String(f.role));
  if (f.branch) params.set('branch_id', String(f.branch));
  if (f.status) params.set('status', f.status);
  if (f.q.trim()) params.set('q', f.q.trim());
  const qs = params.toString();
  const list = useFetch<any[]>(`/users${qs ? `?${qs}` : ''}`, [refreshTick]);
  const rows = list.data ?? [];
  const [view, setView] = useState<any | null>(null);
  const [edit, setEdit] = useState<any | null>(null);
  const canEdit = can('user.update');
  const { me } = useAuth();
  const del = useDelete('User', '/users', () => { list.reload(); ref.reload(); bump(); });
  const after = () => { list.reload(); ref.reload(); bump(); };

  const [details, setDetails] = useState<Record<number, any>>({});
  useEffect(() => {
    let dead = false;
    Promise.all(rows.map((u) =>
      api.get<any>(`/users/${u.id}`).then((d) => [Number(u.id), d] as const).catch(() => [Number(u.id), null] as const),
    )).then((pairs) => { if (!dead) setDetails(Object.fromEntries(pairs)); });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data, refreshTick]);

  const chip = (label: string, icon: string, value: number | undefined, opts: Array<{ id: number; name: string }>, set: (v?: number) => void) => (
    <div className="fchip" key={label}>
      <Ic k={icon} />{label}
      <select value={value ?? ''} onChange={(e) => set(e.target.value ? Number(e.target.value) : undefined)}>
        <option value="">All</option>
        {opts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </div>
  );

  return (
    <>
      <div className="filters">
        {chip('Role', 'shield', f.role, roles.data ?? [], (v) => setF((x) => ({ ...x, role: v })))}
        {chip('Branch', 'branch', f.branch, ref.branches, (v) => setF((x) => ({ ...x, branch: v })))}
        <div className="fchip"><Ic k="users" />Status
          <select value={f.status ?? ''} onChange={(e) => setF((x) => ({ ...x, status: e.target.value || undefined }))}>
            <option value="">All</option><option value="active">Active</option><option value="disabled">Inactive</option>
          </select>
        </div>
        <div className="fchip"><Ic k="search" /><input style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }} placeholder="Search name / email\u2026" value={f.q} onChange={(e) => setF((x) => ({ ...x, q: e.target.value }))} /></div>
        <div className="fchip" style={{ marginLeft: 'auto' }}><Ic k="users" /><b>{rows.length}</b> users</div>
      </div>
      <TableCard title="Users" cols={['User', 'Role', 'Scope (Branch/Vertical/Pipeline)', 'SSO', 'Status', 'Actions']}
        rowClass={(i) => (rows[i].status === 'disabled' ? 'row-inactive' : undefined)}
        rows={rows.map((u) => {
          const d = details[Number(u.id)];
          const a = d?.assignments?.[0];
          const scopeBits = a ? [nameOf(ref.branches, a.branch_id), nameOf(ref.verticals, a.vertical_id), nameOf(ref.pipelines, a.pipeline_id)].filter(Boolean) : [];
          return [
            { node: (
              <div className="cell-u"><Avatar name={u.name} />
                <div><div className="nm">{u.name}</div><div className="sub">{u.email}</div></div>
              </div>) } as Cell,
            u.role_names || (d ? '\u2014' : '\u2026'),
            scopeBits.length ? scopeBits.join(' \u00b7 ') : a ? 'Org-wide' : '\u2014',
            '\u2014',
            toggleCell({
              active: u.status !== 'disabled', name: u.name, entity: 'User', canToggle: canEdit,
              onToggle: async (next) => { await api.patch(`/users/${u.id}`, { status: next ? 'active' : 'disabled' }); after(); },
            }),
            rowActions({
              onView: () => setView(u), onEdit: canEdit ? () => setEdit(u) : undefined,
              // self-delete is refused by the API (400); hide the button for yourself
              onDelete: can('user.delete') && Number(u.id) !== Number(me?.user.id) ? () => del.openDelete(Number(u.id), u.name) : undefined,
            }),
          ];
        })} empty="No users match the current filters" />
      {del.deleteModal}
      {view && <UserView user={view} onClose={() => setView(null)} />}
      {edit && (
        <AddModal formKey="admin.users" onClose={() => setEdit(null)} onSaved={after}
          edit={{
            title: `Edit User \u2014 ${edit.name}`,
            // DEF-2: Email ID / System Role / Branch + Vertical Access are editable and prefilled.
            initialVals: {
              'Full Name': edit.name ?? '', 'Email ID': edit.email ?? '', 'Mobile Number': edit.phone ?? '',
              'System Role': edit.role_names ?? '',
              'Branch Access': edit.branch_names ?? '',
              'Status': edit.status === 'disabled' ? 'Deactivated' : 'Active',
            },
            initialIds: {
              'System Role': edit.role_id ? Number(edit.role_id) : undefined,
              'Branch Access': edit.branch_id ? Number(edit.branch_id) : undefined,
              'Vertical Access': edit.vertical_id ? Number(edit.vertical_id) : undefined,
            },
            // password is only set when the admin types a new one
            optional: ['Password / Login Method'],
            submit: async (vals, ids) => {
              await api.patch(`/users/${edit.id}`, {
                name: need(vals['Full Name'], 'Name is required'),
                email: vals['Email ID'] || null,
                phone: vals['Mobile Number'] || null,
                ...(vals['Password / Login Method'] ? { password: vals['Password / Login Method'] } : {}),
                ...(ids['System Role'] ? {
                  assignments: [{
                    role_id: ids['System Role'],
                    branch_id: ids['Branch Access'] ?? null,
                    vertical_id: ids['Vertical Access'] ?? null,
                  }],
                } : {}),
                status: vals['Status'] === 'Active' ? 'active' : 'disabled',
              });
              return 'User updated';
            },
          }} />
      )}
    </>
  );
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
  const { refreshTick, bump } = useScreen();
  const { can } = useAuth();
  const roles = useFetch<any[]>('/roles', [refreshTick]);
  const [grants, setGrants] = useState<Record<string, any[]>>({});
  const [modal, setModal] = useState<{ roleId?: number; readOnly?: boolean } | null>(null);
  const canEdit = can('role.update');
  const del = useDelete('Role', '/roles', () => { roles.reload(); bump(); });
  const after = () => { roles.reload(); bump(); };
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
    <td key={i}><span className={`pm ${v}`}>{v === 'y' ? '\u2713' : v === 'p' ? '\u25d0' : '\u2013'}</span></td>
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
            <span className="li"><span className="pm y">\u2713</span> Full</span>
            <span className="li"><span className="pm p">\u25d0</span> Partial / scoped</span>
            <span className="li"><span className="pm n">\u2013</span> No access</span>
          </div>
        </div>
      </div>
      <TableCard title="Roles" cols={['Role', 'Type', 'Permissions', 'Users', 'Status', 'Actions']}
        rowClass={(i) => ((roles.data ?? [])[i]?.is_active === false ? 'row-inactive' : undefined)}
        rows={(roles.data ?? []).map((r) => [
          { node: <span className="nm">{r.name}</span> } as Cell,
          { b: [r.is_system ? 'System' : 'Custom', r.is_system ? 'b-indigo' : 'b-cyan'] } as Cell,
          String(r.permission_count ?? 0),
          String(r.user_count ?? 0),
          toggleCell({
            active: r.is_active !== false, name: r.name, entity: 'Role',
            canToggle: canEdit && !r.is_system,
            onToggle: async (next) => { await api.patch(`/roles/${r.id}`, { is_active: next }); after(); },
          }),
          rowActions({
            onView: () => setModal({ roleId: Number(r.id), readOnly: true }),
            onEdit: canEdit && !r.is_system ? () => setModal({ roleId: Number(r.id) }) : undefined,
            // system roles are not deletable (API 400) — no button on them
            onDelete: can('role.delete') && !r.is_system ? () => del.openDelete(Number(r.id), r.name) : undefined,
          }),
        ])} empty="No roles" />
      {del.deleteModal}
      <Blocks blocks={[{ type: 'caps', title: 'Permission depth', items: [
        { t: 'Module-level', d: 'View/create/edit/delete/export' }, { t: 'Field-level', d: 'Hide sensitive fields' },
        { t: 'Record-level', d: 'Scoped by Branch/Pipeline/Campaign' }, { t: 'Manager partial', d: 'Live-monitor, view-only or edit' }] }]} />
      {modal && (
        <RoleModal roleId={modal.roleId} readOnly={modal.readOnly}
          onClose={() => setModal(null)} onSaved={after} />
      )}
    </>
  );
}

function Audit() {
  const { refreshTick } = useScreen();
  const logs = useFetch<any[]>('/audit-logs?limit=100', [refreshTick]);
  const rows = logs.data ?? [];
  const [sel, setSel] = useState<any | null>(null);
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
      <TableCard title="Activity log \u2014 all users" cols={['Time', 'User', 'Module', 'Activity', 'Detail', 'Actions']}
        rows={rows.map((r) => [
          { mono: new Date(r.occurred_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }), dim: true } as Cell,
          r.actor_name ?? 'System',
          String(r.entity_type ?? '\u2014'),
          { b: ACT[r.action] ?? [r.action, 'b-gray'] } as Cell,
          r.entity_id ? `#${r.entity_id}` : '\u2014',
          rowActions({ onView: () => setSel(r) }),
        ])} empty="No audit entries yet"
        onRowClick={(i) => setSel(rows[i])} />
      {sel && (
        <DetailModal title={`Audit \u2014 ${sel.action} ${sel.entity_type ?? ''} ${sel.entity_id ? `#${sel.entity_id}` : ''}`} icon="shield" width={640} onClose={() => setSel(null)}>
          <Section title="Event">
            <KV rows={[
              ['When', fmtFull(sel.occurred_at)],
              ['Actor', sel.actor_name ?? 'System'],
              ['Action', renderCell({ b: ACT[sel.action] ?? [sel.action, 'b-gray'] })],
              ['Module', String(sel.entity_type ?? '\u2014')],
              ['Record', sel.entity_id ? `#${sel.entity_id}` : '\u2014'],
              ['IP', sel.ip ? <span className="mono">{sel.ip}</span> : '\u2014'],
              ['Agent', sel.user_agent ? <span style={{ fontSize: 11.5 }}>{sel.user_agent}</span> : '\u2014'],
            ]} />
          </Section>
          {sel.before ? (
            <Section title="Before">
              <pre className="stack-pre" style={{ maxHeight: 160 }}>{JSON.stringify(sel.before, null, 2)}</pre>
            </Section>
          ) : null}
          {sel.after ? (
            <Section title="After">
              <pre className="stack-pre" style={{ maxHeight: 160 }}>{JSON.stringify(sel.after, null, 2)}</pre>
            </Section>
          ) : null}
        </DetailModal>
      )}
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

/* --------------------------- masters admin ----------------------------- */
/* Administration › Masters — sanctioned client-approved addition (UAT item 6:
   "edit option for Course master AND all masters"). One screen manages every
   generic master list (add / edit / view / activate-deactivate). */

function MastersAdmin() {
  const { refreshTick, bump } = useScreen();
  const { can } = useAuth();
  const ref = useRef_();
  const types = useFetch<Array<{ type: string; label: string; parent: string | null }>>('/masters', []);
  const [type, setType] = useState('course');
  const [inc, setInc] = useState(false);
  const list = useFetch<any[]>(`/masters/${type}${inc ? '?all=1' : ''}`, [refreshTick]);
  const rows = list.data ?? [];
  const [add, setAdd] = useState(false);
  const [edit, setEdit] = useState<any | null>(null);
  const [view, setView] = useState<any | null>(null);
  const canEdit = can('master.update');
  const label = MASTER_LABELS[type] ?? types.data?.find((t) => t.type === type)?.label ?? type;
  const hasParent = !!types.data?.find((t) => t.type === type)?.parent;
  const after = () => { list.reload(); ref.reload(); bump(); };
  const del = useDelete(label.replace(/s$/, ''), `/masters/${type}`, after);
  const cols = ['Name', 'Code', ...(hasParent ? ['Parent'] : []), 'Sort', 'Status', 'Actions'];
  return (
    <>
      <div className="filters">
        <div className="fchip"><Ic k="cfg" />Master
          <select value={type} onChange={(e) => { setType(e.target.value); }}>
            {(types.data ?? []).map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
          </select>
        </div>
        <IncInactiveChip on={inc} set={setInc} />
        <div className="fchip" style={{ marginLeft: 'auto' }}><Ic k="list" /><b>{rows.length}</b> values</div>
      </div>
      <TableCard title={`${label} master`} icon="cfg"
        more={can('master.create')
          ? <a className="mlink" style={{ cursor: 'pointer' }} onClick={() => setAdd(true)}>＋ Add {label.replace(/s$/, '')}</a>
          : undefined}
        cols={cols}
        rowClass={(i) => (rows[i].is_active === false ? 'row-inactive' : undefined)}
        rows={rows.map((m) => {
          const cells: Cell[] = [
            { node: <span className="nm">{m.name}</span> },
            { mono: String(m.code ?? '\u2014') },
          ];
          if (hasParent) cells.push(String(m.parent_name ?? '\u2014'));
          cells.push(
            { mono: String(m.sort_order ?? 0), dim: true },
            toggleCell({
              active: m.is_active !== false, name: m.name, entity: label.replace(/s$/, ''), canToggle: canEdit,
              onToggle: async (next) => { await api.patch(`/masters/${type}/${m.id}`, { is_active: next }); after(); },
            }),
            rowActions({
              onView: () => setView(m), onEdit: canEdit ? () => setEdit(m) : undefined,
              onDelete: can('master.delete') ? () => del.openDelete(Number(m.id), m.name) : undefined,
            }),
          );
          return cells;
        })} empty={`No ${label.toLowerCase()} yet`} />
      {del.deleteModal}
      {add && (type === 'course'
        ? <AddModal formKey="students.courses" onClose={() => setAdd(false)} onSaved={after} />
        : <AddMasterModal type={type} onClose={() => setAdd(false)} onCreated={after} />)}
      {edit && (type === 'course'
        ? <AddModal formKey="students.courses" onClose={() => setEdit(null)} onSaved={after} edit={courseEditSpec(edit)} />
        : <AddMasterModal type={type} initial={edit} onClose={() => setEdit(null)} onCreated={after} />)}
      {view && (
        <DetailModal title={`${label.replace(/s$/, '')} \u2014 ${view.name}`} icon="cfg" onClose={() => setView(null)}>
          <Section title="Details">
            <KV rows={[
              ['Name', view.name],
              ['Code', <span className="mono">{view.code ?? '\u2014'}</span>],
              hasParent ? ['Parent', String(view.parent_name ?? '\u2014')] : null,
              ['Sort order', String(view.sort_order ?? 0)],
              ['Status', renderCell(statusBadge(view.is_active !== false))],
              Object.keys((view.meta as any) ?? {}).length
                ? ['Meta', <pre className="stack-pre" style={{ maxHeight: 120 }}>{JSON.stringify(view.meta, null, 2)}</pre>]
                : null,
            ]} />
          </Section>
          <Section title="Record">
            <KV rows={[
              ['Created', fmtFull(view.created_at)],
              ['Created by', nameOf(ref.users, view.created_by) ?? '\u2014'],
              ['Updated', fmtFull(view.updated_at)],
            ]} />
          </Section>
        </DetailModal>
      )}
    </>
  );
}

/* --------------------------- deleted items ----------------------------- */
/* Administration › Deleted Items — sanctioned addition (soft-delete client
   request; noted in the parity spec). Per-entity tabs, restore with confirm;
   a 409 (deleted ancestor) is surfaced verbatim. */

function DeletedItems() {
  const { refreshTick, bump } = useScreen();
  const { can } = useAuth();
  const allowed = can('deleted.manage');
  const entities = useFetch<Array<{ key: string; label: string }>>(allowed ? '/deleted-items/entities' : null, []);
  const [entity, setEntity] = useState('branch');
  const [tick, setTick] = useState(0);
  const list = useFetch<{ entity: string; label: string; rows: any[] }>(
    allowed ? `/deleted-items?entity=${encodeURIComponent(entity)}` : null, [entity, tick, refreshTick]);
  const rows = list.data?.rows ?? [];
  const [confirmRow, setConfirmRow] = useState<any | null>(null);
  const [impactRow, setImpactRow] = useState<any | null>(null);
  const [impact, setImpact] = useState<ImpactReport | null>(null);
  const [busy, setBusy] = useState(false);

  const label = list.data?.label ?? entities.data?.find((e) => e.key === entity)?.label ?? entity;
  const pathFor = (id: number) => (entity.startsWith('master:')
    ? `/masters/${entity.slice(7)}/${id}` : {
      branch: `/branches/${id}`, vertical: `/verticals/${id}`, pipeline: `/pipelines/${id}`,
      campaign: `/campaigns/${id}`, source: `/sources/${id}`, lead: `/leads/${id}`,
      follow_up: `/follow-ups/${id}`, user: `/users/${id}`, team: `/teams/${id}`, role: `/roles/${id}`,
    }[entity] ?? `/${entity}s/${id}`);

  useEffect(() => {
    if (!impactRow) { setImpact(null); return; }
    setImpact(null);
    api.get<ImpactReport>(`${pathFor(Number(impactRow.id))}/impact`).then(setImpact).catch((e) => { toast(e.message, true); setImpactRow(null); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [impactRow]);

  const restore = async (row: any) => {
    setBusy(true);
    try {
      await api.post(`${pathFor(Number(row.id))}/restore`);
      toast(`${label} "${row.name}" restored`);
      setConfirmRow(null); setTick((t) => t + 1); bump();
    } catch (e: any) {
      // 409 = an ancestor in the path is still deleted — surface the message clearly
      toast(e.message, true);
    } finally { setBusy(false); }
  };

  if (!allowed) {
    return <div className="notice"><Ic k="shield" /><div>Deleted Items needs the <b>Deleted Items · manage</b> permission (Super Admin / Org Admin).</div></div>;
  }
  return (
    <>
      <div className="filters">
        <div className="fchip"><Ic k="trash" />Entity
          <select value={entity} onChange={(e) => setEntity(e.target.value)}>
            {(entities.data ?? [{ key: 'branch', label: 'Branch' }]).map((e) => <option key={e.key} value={e.key}>{e.label}</option>)}
          </select>
        </div>
        <div className="fchip" style={{ marginLeft: 'auto' }}><Ic k="list" /><b>{rows.length}</b> deleted</div>
      </div>
      <TableCard title={`Deleted ${label.toLowerCase()}s`} icon="trash"
        cols={['Name', 'Deleted at', 'Deleted by', 'Actions']}
        rows={rows.map((r) => [
          { node: <span className="nm">{r.name}</span> } as Cell,
          { mono: fmtFull(r.deleted_at), dim: true } as Cell,
          r.deleted_by_name ?? '—',
          rowActions({
            onView: () => setImpactRow(r),
            extra: [{ k: 'restore', title: 'Restore', onClick: () => setConfirmRow(r) }],
          }),
        ])}
        empty={`No deleted ${label.toLowerCase()}s — everything is live`} />
      {impactRow && (
        <DetailModal title={`Impact — ${impactRow.name}`} icon="trash" width={560} onClose={() => setImpactRow(null)}>
          {!impact ? <div className="empty-note">Loading impact…</div> : (
            <>
              <div className="page-sub" style={{ marginBottom: 10 }}>
                {impact.total_associations} association{impact.total_associations === 1 ? '' : 's'} — all kept intact when this {label.toLowerCase()} was deleted.
              </div>
              <ImpactList report={impact} />
            </>
          )}
        </DetailModal>
      )}
      {confirmRow && (
        <ConfirmModal title={`Restore ${label.toLowerCase()}`} confirmLabel="Restore" busy={busy}
          body={<>Restore {label.toLowerCase()} <b>{confirmRow.name}</b>? It returns to lists, dropdowns and reports immediately. If a parent in its path is still deleted, the restore is refused until the parent is restored first.</>}
          onConfirm={() => restore(confirmRow)} onClose={() => setConfirmRow(null)} />
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
  leadImport: LeadImport,
  followups: Followups,
  kanban: Kanban,
  scoring: Scoring,
  sources: Sources,
  captureChannels: Channels,
  sla: Sla,
  branches: Branches,
  verticals: Verticals,
  pipelines: Pipelines,
  campaigns: Campaigns,
  courses: Courses,
  mastersAdmin: MastersAdmin,
  users: Users,
  roles: Roles,
  audit: Audit,
  errorLogs: ErrorLogs,
  deletedItems: DeletedItems,
  activityReports: ActivityReports,
  funnelAnalytics: FunnelAnalytics,
  workTasks: WorkTasks,
  waChat: WaChat,
  sitemap: Sitemap,
};

export { checkS };
