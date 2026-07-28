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
import { toast, useFetch, useRef_, selectableUsers } from './refdata';
import { AddModal, CampaignModal, need, EditSpec, parseStageRows, reconcilePipelineStages, StageRow, buildUserAssignments, parseIdCsv, parseVertCsv, AssignmentRow } from './forms';
import { PhoneInput } from './phonefield';
import { AddMasterModal, MASTER_LABELS } from './mastermodal';
import { RoleModal } from './rolemodal';
import {
  ConfirmModal, DetailModal, IncInactiveChip, KV, RowMenu, RowMenuItem, Section, fmtFull, rowActions, toggleCell,
} from './rowactions';
import { UserPicker } from './userpicker';
import { ImpactList, ImpactReport, useDelete } from './deletemodal';
import { APP } from './specs';
import { StageConfigurator } from './stageconfig';
import LeadImport from './leadimport';
import Channels from './channels';
import ApiModule from './apimodule';
import StartCalling from './calling';
import { Calendar, Referrals, Scoring, Sla, WalkIns, dur } from './sprint3';
import {
  BulkSms, BulkWhatsApp, EmailCampaigns, Journeys, Settings, Templates,
} from './sprint4';
import {
  CounsellorPerformance, FeeCollection, MonthlyTargets, Quotations, SaleClosure,
} from './sprint5';
import { fmtINR } from './money';
import {
  ActivityReport, Announcements, CampaignRoiReport, FunnelReport, KnowledgeBase, Notes,
  ReportBuilder, SavedReports, ScheduledDelivery, TatReport, TeamChat,
} from './sprint6';
import { CONVERSION_LABEL_LEAD_WON } from './metrics';
import { SupportTickets } from './support';
import { CrossSell } from './crosssell';

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

/** A plain DATE column (campaign start/end) — no time, no timezone drift. */
const fmtDate = (v?: string | null) => {
  if (!v) return '\u2014';
  const d = new Date(String(v).slice(0, 10) + 'T00:00:00');
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

const LEAD_COLS = ['Lead', 'Course', 'Vertical · Pipeline', 'Source', 'Score', 'Owner', 'Stage', 'Next follow-up'];

/* Client update #4 — task/follow-up priority (colour-coded like lead priority). */
const PRIO_CLASS: Record<string, string> = { high: 'b-rose', medium: 'b-amber', low: 'b-cyan' };
const PRIO_LABEL: Record<string, string> = { high: 'High', medium: 'Medium', low: 'Low' };

// UAT-R3 #19 — shared filter controls for the hierarchy list screens (Branch/Vertical/
// Pipeline/Campaign). Cascading dropdowns + a free-text search chip, styled like the Leads
// filter bar. Each list builds a query string from these and the API honours the params.
function HChip({ label, icon, value, list, onChange, disabled }:
  { label: string; icon: string; value?: number; list: Array<{ id: number; name: string }>;
    onChange: (v?: number) => void; disabled?: boolean }) {
  return (
    <div className="fchip">
      <Ic k={icon} />{label}
      <select aria-label={`Filter by ${label}`} value={value ?? ''} disabled={disabled}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}>
        <option value="">All</option>
        {list.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </div>
  );
}
function SearchChip({ q, setQ, ph }: { q: string; setQ: (v: string) => void; ph?: string }) {
  return (
    <div className="fchip"><Ic k="search" />
      <input aria-label="Search" style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }}
        placeholder={ph ?? 'Search\u2026'} value={q} onChange={(e) => setQ(e.target.value)} /></div>
  );
}

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
    { node: (
      <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
        <TempBadge temperature={l.temperature} score={l.score} />
        {/* Sprint 3 — a breached SLA / an escalated follow-up is visible in the LIST,
            not only in a report. This is the badge the client will look for. */}
        {l.sla_breached ? <span className="bdg b-rose" title="SLA breached">SLA</span> : null}
        {l.is_flagged && !l.sla_breached
          ? <span className="bdg b-amber" title={l.flag_reason || 'Flagged'}>!</span> : null}
      </span>) },
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

/**
 * THE ROLE-BASED DASHBOARD (client decision, 14 Jul 2026).
 *
 * The server returns `view` (counsellor | team | branch | vertical | admin) and the
 * `widgets` list for that view. The view is DERIVED FROM THE RBAC SCOPE, not from a role
 * name, and every number in the payload is already scope-filtered — so a counsellor
 * literally cannot receive branch figures. This component just renders what it is given.
 */
interface Dash {
  view: 'counsellor' | 'team' | 'branch' | 'vertical' | 'admin';
  widgets: string[];
  range: { from: string; to: string };
  kpis: { total: number; today: number; in_range: number; won: number; won_in_range: number;
    lost: number; hot: number; warm: number; cold: number; flagged: number; unassigned: number };
  follow_ups: { pending: number; due_today: number; overdue: number; done_today: number;
    escalated: number; my_open: number; my_due_today: number; my_overdue: number };
  by_stage: Array<{ stage_id: number; name: string; stage_type: string; sort_order: number; ct: number }>;
  series: Array<{ day: string; leads: number; won: number }>;
  leaderboard: Array<{ user_id: number; name: string; leads: number; won: number; new_in_range: number }>;
  sla: { open_breaches: number; breaches_today: number; avg_response_seconds: number } | null;
  walkins: { total: number; today: number; converted: number };
  referrals: { total: number; mtd: number; converted: number; rewardable: number };
}

const VIEW_LABEL: Record<Dash['view'], string> = {
  counsellor: 'My work', team: 'My team', branch: 'My branch', vertical: 'My vertical', admin: 'Organisation',
};

function DashOverview() {
  const { openLead, refreshTick, go, bump } = useScreen();
  const d = useFetch<Dash>('/dashboard', [refreshTick]);
  const today = useFetch<any[]>('/follow-ups?due=today&limit=5', [refreshTick]);
  const mine = useFetch<any[]>('/follow-ups?mine=1&status=pending&limit=4', [refreshTick]);
  const recent = useFetch<{ total: number; rows: any[] }>('/leads?limit=5', [refreshTick]);

  const data = d.data;
  const has = (w: string) => !!data?.widgets.includes(w);
  const k = data?.kpis;
  const fu = data?.follow_ups;
  const personal = data?.view === 'counsellor' || data?.view === 'team';

  // a counsellor's KPI strip is about THEIR work; a manager's is about the unit.
  const kpiItems = personal ? [
    { lab: 'My leads', val: String(k?.total ?? 0), ic: 'leads' },
    { lab: 'My conversions', val: String(k?.won ?? 0), ic: 'check' },
    // #13(c) — the task SUMMARY tiles open the My Tasks list (this is the "Task Summary"
    // the client clicks). Card-header "View all ›" keeps working too.
    { lab: 'My open tasks', val: String(fu?.my_open ?? 0), ic: 'clock',
      delta: fu?.my_overdue ? `${fu.my_overdue} overdue` : undefined, tone: fu?.my_overdue ? 'down' as const : 'flat' as const,
      onClick: () => go('dash', 'mytasks'), navLabel: `My open tasks: ${fu?.my_open ?? 0}. Open My Tasks list` },
    { lab: 'Due today', val: String(fu?.my_due_today ?? 0), ic: 'cal',
      onClick: () => go('dash', 'mytasks'), navLabel: `Tasks due today: ${fu?.my_due_today ?? 0}. Open My Tasks list` },
    { lab: 'Hot leads', val: String(k?.hot ?? 0), ic: 'bolt' },
    { lab: 'New today', val: String(k?.today ?? 0), ic: 'users' },
  ] : [
    { lab: "Today's leads", val: String(k?.today ?? 0), ic: 'leads' },
    { lab: 'Conversions', val: String(k?.won ?? 0), ic: 'check' },
    { lab: 'Pending follow-ups', val: String(fu?.pending ?? 0), ic: 'clock',
      delta: fu?.overdue ? `${fu.overdue} overdue` : undefined, tone: fu?.overdue ? 'down' as const : 'flat' as const,
      // #13(c) — the manager's task-summary tile opens the My Tasks list (the follow-up module,
      // §4i). My Tasks is the actionable task/follow-up list; Today's Follow-ups is due=today only.
      onClick: () => go('dash', 'mytasks'), navLabel: `Pending follow-ups: ${fu?.pending ?? 0}. Open My Tasks list` },
    { lab: 'SLA breaches', val: String(data?.sla?.open_breaches ?? 0), ic: 'bolt',
      tone: (data?.sla?.open_breaches ?? 0) > 0 ? 'down' as const : 'flat' as const },
    { lab: 'Walk-ins today', val: String(data?.walkins?.today ?? 0), ic: 'users' },
    { lab: 'Unassigned', val: String(k?.unassigned ?? 0), ic: 'target' },
  ];

  return (
    <>
      <div className="filters" style={{ marginBottom: 12 }}>
        <span className="fchip on" style={{ cursor: 'default' }} data-view={data?.view ?? ''}>
          <Ic k="users" />{data ? VIEW_LABEL[data.view] : 'Loading…'}
        </span>
        {data?.view === 'admin' && <span className="fchip" style={{ cursor: 'default' }}>Org-wide</span>}
      </div>

      <Kpis cols={6} items={kpiItems} />

      <div className="row2" style={{ gridTemplateColumns: '1.55fr 1fr' }}>
        <BarsCard title="Lead inflow & conversions — last 14 days"
          series={(data?.series ?? []).map((x) => ({ day: String(x.day), leads: Number(x.leads), won: Number(x.won) }))} />
        <Funnel title="Conversion funnel" rows={data ? funnelRows(data.by_stage as any) : []} />
      </div>

      <div className="row2" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
        {/* #14 — a REAL, actionable Today's Follow-ups widget: open the lead, mark done
            (with the #13 confirm), overdue highlighted. Click the header to open the list. */}
        <TodayFollowupCard rows={today.data ?? []} count={fu?.due_today ?? 0} onChanged={bump}
          onOpenList={() => go('dash', 'todayfollowups')} />
        {/* #13(c) — the My Tasks summary card opens the full My Tasks list on click. */}
        <MyTaskCard rows={mine.data ?? []} more={`${fu?.my_open ?? 0} open`}
          onOpenList={() => go('dash', 'mytasks')} />
        <div className="card" style={{ background: 'linear-gradient(150deg,var(--primary-soft),var(--accent-soft))' }}>
          <div className="card-head"><h3><Ic k="intel" />AI Insights</h3><span className="bdg b-indigo">Gemini</span></div>
          <div className="empty-note">AI insights switch on once the Gemini key is configured (Phase 2).</div>
        </div>
      </div>

      {/* ---- manager-only widgets. The server does not even compute these for a
              counsellor, and `widgets` is what decides — not a client-side role guess. ---- */}
      {has('team_leaderboard') && (
        <TableCard title="Team performance" icon="users"
          cols={['Counsellor', 'Leads', 'Converted', 'New in range', 'Conversion']}
          rows={(data?.leaderboard ?? []).map((u) => [
            { node: <span className="nm">{u.name}</span> } as Cell,
            String(u.leads), String(u.won), String(u.new_in_range),
            { b: [`${u.leads ? Math.round((u.won / u.leads) * 100) : 0}%`, u.won > 0 ? 'b-green' : 'b-gray'] } as Cell,
          ])}
          empty="No leads assigned in this unit yet" />
      )}

      {has('sla') && data?.sla && (
        <div className="row2" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
          <div className="card bignum">
            <div className="l">Open SLA breaches</div>
            <div className="v">{data.sla.open_breaches}</div>
            <div className="s">
              <span className={`bdg ${data.sla.open_breaches > 0 ? 'b-rose' : 'b-green'}`}>
                {data.sla.open_breaches > 0 ? 'Needs attention' : 'All within target'}
              </span>
            </div>
          </div>
          <div className="card bignum">
            <div className="l">Avg first response</div>
            <div className="v">{dur(data.sla.avg_response_seconds)}</div>
            <div className="s"><span className="bdg b-indigo">{data.sla.breaches_today} breached today</span></div>
          </div>
          <div className="card bignum">
            <div className="l">Referrals (MTD)</div>
            <div className="v">{data.referrals?.mtd ?? 0}</div>
            <div className="s"><span className="bdg b-green">{data.referrals?.converted ?? 0} converted</span></div>
          </div>
        </div>
      )}

      <TableCard title={personal ? 'My recent leads' : 'Recent leads'} more="View pipeline" cols={LEAD_COLS}
        rows={(recent.data?.rows ?? []).map(leadRow)}
        empty="No leads yet — add your first lead or connect a source"
        onRowClick={(i) => openLead(Number(recent.data!.rows[i].id))} />
    </>
  );
}

/* ---- UAT-R2 #13 — a task/follow-up Edit prefill. Reuses the Add Task form; the related
   lead is locked (a task belongs to its lead, §4i) and the PATCH hits /follow-ups/:id. ---- */
const dtLocal = (isoStr?: string | null): string => {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const capFirst = (x?: string) => (x ? x[0].toUpperCase() + x.slice(1) : x);

export const taskEditSpec = (f: any, after: () => void): EditSpec => ({
  title: `Edit Task \u2014 ${f.lead_name}`,
  initialVals: {
    'Title': f.notes ?? '',
    'Task Type': f.type_name ?? '',
    'Related Lead': f.lead_name ?? '',
    'Assigned To': f.owner_name ?? '',
    'Report To': f.report_to_name ?? '',
    'Due Date': dtLocal(f.scheduled_at),
    'Priority': capFirst(f.priority) ?? 'Medium',
    'Description': '',
  },
  initialIds: {
    'Task Type': f.type_id == null ? undefined : Number(f.type_id),
    'Related Lead': f.lead_id == null ? undefined : Number(f.lead_id),
    'Assigned To': f.owner_id == null ? undefined : Number(f.owner_id),
    'Report To': f.report_to_id == null ? undefined : Number(f.report_to_id),
  },
  lock: ['Related Lead'],
  submit: async (vals, ids) => {
    await api.patch(`/follow-ups/${f.id}`, {
      type_id: ids['Task Type'] ?? null,
      owner_id: ids['Assigned To'] ?? undefined,
      report_to_id: ids['Report To'] ?? null,
      scheduled_at: need(vals['Due Date'], 'Due date is required'),
      priority: (vals['Priority'] || 'Medium').toLowerCase(),
      notes: [vals['Title'], vals['Description']].filter(Boolean).join(' \u2014 ') || undefined,
    });
    after();
    return 'Task updated';
  },
});

function MyTaskCard({ rows, more, title = 'My Tasks', empty, onOpenList }: { rows: any[]; more?: string; title?: string; empty?: string; onOpenList?: () => void }) {
  const { bump, openLead } = useScreen();
  const { can } = useAuth();
  const canEdit = can('followup.update');
  const [edit, setEdit] = useState<any | null>(null);
  // #13(b) — a confirmation popup before marking a task done (no accidental one-click).
  const [confirmDone, setConfirmDone] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const complete = async () => {
    if (!confirmDone) return;
    setBusy(true);
    try { await api.patch(`/follow-ups/${confirmDone.id}`, { complete: true }); toast('Task marked done'); setConfirmDone(null); bump(); }
    catch (e: any) { toast(e.message, true); }
    finally { setBusy(false); }
  };
  return (
    <div className="card">
      <div className="card-head">
        <h3><Ic k="check" />{title}</h3>
        {/* #13(c) — the summary card opens the full My Tasks list when wired (dashboard). */}
        {onOpenList
          ? <span className="more" role="button" title="Open My Tasks" style={{ cursor: 'pointer', color: 'var(--primary)' }}
              onClick={onOpenList}>{`${more || 'View all'} \u203a`}</span>
          : <span className="more">{more || ''}</span>}
      </div>
      {rows.length === 0 ? <div className="lrow empty">{empty || 'No open tasks — follow-ups you own appear here'}</div> :
        rows.map((f) => (
          <div className="lrow" key={f.id}>
            <div className="chk" onClick={() => setConfirmDone(f)} title="Mark done" />
            <div className="gr" style={{ cursor: 'pointer' }} onClick={() => openLead(f.lead_id)}>
              <div className="t1">{f.type_name || 'Follow-up'} — {f.lead_name}</div>
              <div className="t2">
                {f.notes || `${f.course_name || ''}`}
                {f.report_to_name ? <span style={{ color: 'var(--text-dim)' }}> · Reports to {f.report_to_name}</span> : null}
              </div>
            </div>
            <PrioSelect id={Number(f.id)} value={f.priority} onChanged={bump} disabled={!canEdit} />
            {/* #13(a) — Edit action on each task row */}
            {canEdit ? (
              <button className="lrow-act" title="Edit task" aria-label="Edit task"
                onClick={(e) => { e.stopPropagation(); setEdit(f); }}><Ic k="pencil" /></button>
            ) : null}
            <span className="rt">{fmtDT(f.scheduled_at)}</span>
          </div>
        ))}
      {edit && (
        <AddModal formKey="dash.mytasks" onClose={() => setEdit(null)}
          onSaved={() => { setEdit(null); bump(); }} edit={taskEditSpec(edit, () => {})} />
      )}
      {confirmDone && (
        <ConfirmModal title="Mark task as done?"
          body={`\u201c${confirmDone.type_name || 'Follow-up'} \u2014 ${confirmDone.lead_name}\u201d will be marked done.`}
          confirmLabel="Mark done" busy={busy}
          onConfirm={complete} onClose={() => setConfirmDone(null)} />
      )}
    </div>
  );
}

/**
 * UAT-R2 #14 — Today's Follow-ups as a REAL, actionable widget (no fake data).
 * Each row: opens the lead, marks done (with the #13 confirm), and OVERDUE is highlighted.
 * Shared by the dashboard card and the standalone Today's Follow-ups screen — same rows,
 * same scope (the API already scope-filters `/follow-ups?due=today`).
 */
function FollowupRows({ rows, onChanged, empty }: { rows: any[]; onChanged: () => void; empty?: string }) {
  const { openLead } = useScreen();
  const { can } = useAuth();
  const canEdit = can('followup.update');
  const [confirmDone, setConfirmDone] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const complete = async () => {
    if (!confirmDone) return;
    setBusy(true);
    try { await api.patch(`/follow-ups/${confirmDone.id}`, { complete: true }); toast('Follow-up marked done'); setConfirmDone(null); onChanged(); }
    catch (e: any) { toast(e.message, true); }
    finally { setBusy(false); }
  };
  if (rows.length === 0) return <div className="lrow empty">{empty || 'No follow-ups due today'}</div>;
  return (
    <>
      {rows.map((f) => {
        const overdue = f.status === 'pending' && new Date(f.scheduled_at) < new Date();
        return (
          <div className={`lrow${overdue ? ' row-err' : ''}`} key={f.id}>
            <div className="chk" onClick={() => canEdit && setConfirmDone(f)} title={canEdit ? 'Mark done' : 'Read-only'} />
            <div className="gr" style={{ cursor: 'pointer' }} onClick={() => openLead(f.lead_id)}>
              <div className="t1">{f.type_name || 'Follow-up'} — {f.lead_name}</div>
              <div className="t2">
                {f.course_name || '—'}
                {f.temperature ? ` · ${capFirst(f.temperature)}` : ''}
                {overdue ? <span style={{ color: 'var(--danger)', fontWeight: 600 }}> · overdue</span> : ''}
              </div>
            </div>
            <TempBadge temperature={f.temperature} score={f.score} />
            <span className="rt" style={overdue ? { color: 'var(--danger)' } : undefined}>{fmtDT(f.scheduled_at)}</span>
          </div>
        );
      })}
      {confirmDone && (
        <ConfirmModal title="Mark follow-up as done?"
          body={`\u201c${confirmDone.type_name || 'Follow-up'} \u2014 ${confirmDone.lead_name}\u201d will be marked done.`}
          confirmLabel="Mark done" busy={busy}
          onConfirm={complete} onClose={() => setConfirmDone(null)} />
      )}
    </>
  );
}

function TodayFollowupCard({ rows, count, onChanged, onOpenList }: { rows: any[]; count: number; onChanged: () => void; onOpenList?: () => void }) {
  return (
    <div className="card">
      <div className="card-head">
        <h3><Ic k="clock" />Today's Follow-ups</h3>
        {onOpenList
          ? <span className="more" role="button" title="Open Today's Follow-ups" style={{ cursor: 'pointer', color: 'var(--primary)' }}
              onClick={onOpenList}>{`${count} due \u203a`}</span>
          : <span className="more">{count} due</span>}
      </div>
      <FollowupRows rows={rows} onChanged={onChanged} empty="No follow-ups due today" />
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
  const { refreshTick, bump } = useScreen();
  const sum = useFetch<any>('/follow-ups/summary', [refreshTick]);
  const list = useFetch<any[]>('/follow-ups?due=today&limit=100', [refreshTick]);
  return (
    <>
      <Kpis items={[
        { lab: 'Due today', val: String(sum.data?.due_today ?? '0'), ic: 'clock' },
        { lab: 'Overdue', val: String(sum.data?.overdue ?? '0'), ic: 'clock', tone: sum.data?.overdue > 0 ? 'down' : 'flat' },
        { lab: 'Done today', val: String(sum.data?.done_today ?? '0'), ic: 'check' },
        { lab: 'No-shows', val: '0', ic: 'bolt' },
      ]} />
      {/* #14 — actionable: open the lead, mark done (confirm), overdue highlighted red. */}
      <div className="card">
        <div className="card-head">
          <h3><Ic k="clock" />{`Today \u2014 ${new Date().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}`}</h3>
          <span className="more">{sum.data?.due_today ?? 0} due · {sum.data?.overdue ?? 0} overdue</span>
        </div>
        <FollowupRows rows={list.data ?? []} onChanged={bump} empty="No follow-ups due today" />
      </div>
    </>
  );
}

/**
 * QUICK STATS — with the CUSTOM DATE RANGE the client asked for explicitly.
 * Presets plus a real from/to picker; the numbers are scoped exactly like the dashboard.
 */
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const PRESETS: Array<[string, () => { from: string; to: string }]> = [
  ['Today', () => ({ from: iso(new Date()), to: iso(new Date()) })],
  ['This week', () => {
    const n = new Date(); const s = new Date(n); s.setDate(n.getDate() - n.getDay());
    return { from: iso(s), to: iso(n) };
  }],
  ['This month', () => {
    const n = new Date();
    return { from: iso(new Date(n.getFullYear(), n.getMonth(), 1)), to: iso(n) };
  }],
  ['Last 90 days', () => {
    const n = new Date(); const s = new Date(n); s.setDate(n.getDate() - 89);
    return { from: iso(s), to: iso(n) };
  }],
];

function QuickStats() {
  const { refreshTick } = useScreen();
  const [preset, setPreset] = useState('This month');
  const [range, setRange] = useState(() => PRESETS[2][1]());
  const stats = useFetch<any>(`/dashboard/quick-stats?from=${range.from}&to=${range.to}`, [range.from, range.to, refreshTick]);
  const s = stats.data;

  const setPre = (name: string) => {
    const p = PRESETS.find(([n]) => n === name);
    if (!p) return;
    setPreset(name);
    setRange(p[1]());
  };
  const setCustom = (k: 'from' | 'to', v: string) => {
    setPreset('Custom');
    setRange((r) => ({ ...r, [k]: v }));
  };

  return (
    <>
      <div className="filters" style={{ marginBottom: 12, alignItems: 'center' }}>
        {PRESETS.map(([name]) => (
          <button key={name} className={`fchip${preset === name ? ' on' : ''}`} onClick={() => setPre(name)}>{name}</button>
        ))}
        <span className={`fchip${preset === 'Custom' ? ' on' : ''}`} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <label htmlFor="qs-from" style={{ fontSize: 11 }}>From</label>
          <input id="qs-from" type="date" className="ainp" style={{ padding: '2px 6px', fontSize: 11.5, width: 130 }}
            value={range.from} onChange={(e) => setCustom('from', e.target.value)} />
          <label htmlFor="qs-to" style={{ fontSize: 11 }}>To</label>
          <input id="qs-to" type="date" className="ainp" style={{ padding: '2px 6px', fontSize: 11.5, width: 130 }}
            value={range.to} onChange={(e) => setCustom('to', e.target.value)} />
        </span>
      </div>

      <Kpis cols={4} items={[
        { lab: 'Leads', val: String(s?.leads ?? 0), ic: 'leads' },
        { lab: 'Conversions', val: String(s?.won ?? 0), ic: 'check' },
        { lab: 'Lost', val: String(s?.lost ?? 0), ic: 'clock' },
        // OBS-S16-05: named, not just 'Conversion rate' — the funnel report shows the
        // SAME number, and Counsellor Performance shows a different one.
        { lab: CONVERSION_LABEL_LEAD_WON, val: s ? `${s.conversion_rate}%` : '—', ic: 'target' },
        { lab: 'Hot leads', val: String(s?.hot ?? 0), ic: 'bolt' },
        { lab: 'Duplicates', val: String(s?.duplicates ?? 0), ic: 'users' },
        { lab: 'Follow-ups done', val: String(s?.followups_done ?? 0), ic: 'check' },
        { lab: 'Follow-ups scheduled', val: String(s?.followups_scheduled ?? 0), ic: 'cal' },
      ]} />

      <TargetBars />
    </>
  );
}

/**
 * "THIS MONTH VS TARGET" — the Sprint-3 widget's empty state, now wired (Sprint 5).
 *
 * PER ROLE, and per role it means something different, which is the whole point:
 * a counsellor sees HIS OWN target; anyone else sees every target in their scope. That
 * split is decided server-side by the ScopeResolver (`/performance/targets/dashboard`),
 * never by a role name here — custom roles are first-class.
 *
 * With no targets set it renders EXACTLY the empty state it rendered before, pointing at
 * the screen that fixes it. No targets is not an error, and it is never a fake bar.
 */
function TargetBars() {
  const { can } = useAuth();
  const { data } = useFetch<Array<{
    label: string; scope_type: string;
    enrolments: { actual: number; target: number; pct: number };
    revenue: { actual_minor: number; target_minor: number; pct: number };
  }>>(can('target.read') ? '/performance/targets/dashboard' : null);

  // no permission = no widget at all, not an empty one that hints at data he cannot have
  if (!can('target.read')) return null;

  const rows = (data ?? []).flatMap((t) => {
    const out: Array<{ label: string; val: string; pct: number; color: string }> = [];
    const colour = (p: number) => (p >= 100 ? 'var(--green)' : p >= 60 ? 'var(--indigo)' : p >= 30 ? 'var(--amber)' : 'var(--rose)');
    if (t.enrolments.target > 0) {
      out.push({
        label: `${t.label} — admissions ${t.enrolments.actual}/${t.enrolments.target}`,
        val: `${t.enrolments.pct}%`,
        pct: Math.min(100, t.enrolments.pct),
        color: colour(t.enrolments.pct),
      });
    }
    if (t.revenue.target_minor > 0) {
      out.push({
        label: `${t.label} — revenue ${fmtINR(t.revenue.actual_minor)}/${fmtINR(t.revenue.target_minor)}`,
        val: `${t.revenue.pct}%`,
        pct: Math.min(100, t.revenue.pct),
        color: colour(t.revenue.pct),
      });
    }
    return out;
  });

  return (
    <HBars title="This month vs target" rows={rows}
      empty="Targets are set under Performance › Monthly Targets — progress bars appear once targets exist" />
  );
}

function QuickContact() {
  const { openLead, openAdd } = useScreen();
  const ref = useRef_();
  const [scope, setScope] = useState<{ branch?: number; vertical?: number; pipeline?: number; campaign?: number }>({});
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  // #10 — Alternate Mobile Number + WhatsApp Number, using the international PhoneInput
  // like the main mobile field. Searchable here; and carried on the Add Lead form.
  const [altPhone, setAltPhone] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [email, setEmail] = useState('');
  const [results, setResults] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);

  const verticals = ref.verticals.filter((v) => !scope.branch || Number(v.branch_id) === scope.branch);
  const pipelines = ref.pipelines.filter((p) => !scope.vertical || Number(p.vertical_id) === scope.vertical);
  const campaigns = ref.campaigns.filter((c) => !scope.pipeline || Number(c.pipeline_id) === scope.pipeline);

  const search = async () => {
    const q = (phone || altPhone || whatsapp || name).trim();
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
                <button className="verify" style={{ position: 'static', flex: '0 0 auto' }} title="Verify" onClick={() => toast('Numbers are format-checked automatically as you type (country code + length).')}><Ic k="check" w={2.6} /></button>
              </div></div>
            <div className="fld"><label>Alternate Mobile Number</label>
              <PhoneInput value={altPhone} onChange={setAltPhone} placeholder="Alternate Mobile Number" /></div>
            <div className="fld"><label>WhatsApp Number</label>
              <PhoneInput value={whatsapp} onChange={setWhatsapp} placeholder="WhatsApp Number" /></div>
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
              {/* UAT-R2 #3 — Quick Contact showed ALL org campaigns here. Constrain to the
                  chosen Branch › Vertical › Pipeline path (same `campaigns` list as the scope
                  select above); disabled with a hint until a Pipeline is picked. */}
              <select className="ainp" disabled={!scope.pipeline}
                value={scope.campaign ?? ''} onChange={(e) => setScope((s) => ({ ...s, campaign: e.target.value ? Number(e.target.value) : undefined }))}>
                <option value="">{scope.pipeline ? 'Select Campaigns' : 'Select a Pipeline first…'}</option>
                {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
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
  const [f, setF] = useState<{
    branch?: number; vertical?: number; pipeline?: number; campaign?: number;
    // UAT-R2 #26/#14 — Source, Status, Owner and a created-date range are filterable too,
    // and the hierarchy dropdowns follow Branch › Vertical › Pipeline › Campaign › Source.
    source?: number; status?: number; owner?: number; from?: string; to?: string;
    // Sprint 3 — the score BAND is filterable, and SLA breaches are their own filter
    temperature?: string; sla?: boolean;
    // Client change (Jul 2026) — the Duplicates filter (leads marked is_duplicate)
    dup?: boolean;
    sort: string; q: string;
  }>({ q: '', sort: 'recent' });
  const params = new URLSearchParams();
  if (f.branch) params.set('branch_id', String(f.branch));
  if (f.vertical) params.set('vertical_id', String(f.vertical));
  if (f.pipeline) params.set('pipeline_id', String(f.pipeline));
  if (f.campaign) params.set('campaign_id', String(f.campaign));
  if (f.source) params.set('source_id', String(f.source));
  if (f.status) params.set('status_id', String(f.status));
  if (f.owner) params.set('owner_id', String(f.owner));
  if (f.from) params.set('created_from', f.from);
  if (f.to) params.set('created_to', f.to);
  if (f.temperature) params.set('temperature', f.temperature);
  if (f.sla) params.set('sla_breached', '1');
  if (f.dup) params.set('duplicate', '1');
  if (f.sort && f.sort !== 'recent') params.set('sort', f.sort);
  if (f.q.trim()) params.set('q', f.q.trim());
  params.set('limit', '100');
  const data = useFetch<{ total: number; rows: any[] }>(`/leads?${params.toString()}`, [refreshTick, params.toString()]);
  const del = useDelete('Lead', '/leads', () => bump());

  // UAT-R3b #11 — three switchable Leads views (Classic / Modern / Inbox), ported from the
  // SaaS tenant (public/tenant/leadsV2.js segment toggle). The choice is remembered per user
  // like the theme is (localStorage 'tl_leads_view'); guarded for jsdom. ALL three views share
  // the SAME data fetch, filters, RBAC scope and row actions below — only the results region
  // changes, so nothing about filtering/scoping/pagination/actions can regress between views.
  const [view, setView] = useState<'classic' | 'modern' | 'inbox'>(() => {
    try {
      const v = localStorage.getItem('tl_leads_view');
      if (v === 'modern' || v === 'inbox' || v === 'classic') return v;
    } catch { /* jsdom: no localStorage */ }
    return 'classic';
  });
  const pickView = (v: 'classic' | 'modern' | 'inbox') => {
    setView(v);
    try { localStorage.setItem('tl_leads_view', v); } catch { /* jsdom */ }
  };
  const rows = data.data?.rows ?? [];

  const chip = (label: string, icon: string, value: number | undefined, list: Array<{ id: number; name: string }>, set: (v?: number) => void) => (
    <div className="fchip" key={label}>
      <Ic k={icon} />{label}
      <select value={value ?? ''} onChange={(e) => set(e.target.value ? Number(e.target.value) : undefined)}>
        <option value="">All</option>
        {list.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </div>
  );

  const BANDS: Array<[string, string | undefined]> = [['All', undefined], ['Hot', 'hot'], ['Warm', 'warm'], ['Cold', 'cold']];
  const bandDot: Record<string, string> = { hot: 'var(--hot)', warm: 'var(--warm)', cold: 'var(--cold)' };
  return (
    <>
      {/* UAT-R2 #11 — SaaS-style quick band chips (drive the same temperature filter). */}
      <div className="qband">
        {BANDS.map(([lab, val]) => (
          <button key={lab} type="button"
            className={`qb${(f.temperature ?? undefined) === val ? ` on ${val ?? ''}` : ''}`}
            onClick={() => setF((x) => ({ ...x, temperature: val }))}>
            {val ? <span className="d" style={{ background: bandDot[val] }} /> : null}{lab}
          </button>
        ))}
        {/* UAT-R3b #11 — segmented view switcher (Classic / Modern / Inbox), SaaS-tenant parity. */}
        <div className="lv-seg" role="tablist" aria-label="Leads view" style={{ marginLeft: 'auto' }}>
          {([['classic', 'Classic', 'list'], ['modern', 'Modern', 'grid'], ['inbox', 'Inbox', 'mail']] as const).map(([k, lab, ic]) => (
            <button key={k} type="button" role="tab" aria-selected={view === k}
              className={`lv-seg-b${view === k ? ' on' : ''}`} onClick={() => pickView(k)}>
              <Ic k={ic} />{lab}
            </button>
          ))}
        </div>
      </div>
      <div className="toolbar-surface">
      <div className="filters">
        {/* UAT-R2 #14/#26 — filters follow Branch › Vertical › Pipeline › Campaign › Source;
            each dropdown is filtered by its parent and every descendant filter resets when a
            parent changes, so a stale (now out-of-scope) filter can never stay applied. */}
        {chip('Branch', 'branch', f.branch, ref.branches, (v) => setF((x) => ({ ...x, branch: v, vertical: undefined, pipeline: undefined, campaign: undefined, source: undefined })))}
        {chip('Vertical', 'grid', f.vertical, ref.verticals.filter((v) => !f.branch || Number(v.branch_id) === f.branch), (v) => setF((x) => ({ ...x, vertical: v, pipeline: undefined, campaign: undefined, source: undefined })))}
        {chip('Pipeline', 'list', f.pipeline, ref.pipelines.filter((p) => !f.vertical || Number(p.vertical_id) === f.vertical), (v) => setF((x) => ({ ...x, pipeline: v, campaign: undefined, source: undefined })))}
        {chip('Campaign', 'bolt', f.campaign, ref.campaigns.filter((c) => !f.pipeline || Number(c.pipeline_id) === f.pipeline), (v) => setF((x) => ({ ...x, campaign: v, source: undefined })))}
        {chip('Source', 'leads', f.source, ref.sources.filter((so) => !f.campaign || Number(so.campaign_id) === f.campaign), (v) => setF((x) => ({ ...x, source: v })))}
        {chip('Status', 'check', f.status, ref.statuses, (v) => setF((x) => ({ ...x, status: v })))}
        {chip('Owner', 'users', f.owner, selectableUsers(ref.users), (v) => setF((x) => ({ ...x, owner: v })))}
        <div className="fchip" data-testid="date-from"><Ic k="clock" />From
          <input type="date" aria-label="Created from" value={f.from ?? ''}
            onChange={(e) => setF((x) => ({ ...x, from: e.target.value || undefined }))} /></div>
        <div className="fchip" data-testid="date-to"><Ic k="clock" />To
          <input type="date" aria-label="Created to" value={f.to ?? ''}
            onChange={(e) => setF((x) => ({ ...x, to: e.target.value || undefined }))} /></div>
        <div className="fchip"><Ic k="search" /><input style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }} placeholder="Search name / phone / email…" value={f.q} onChange={(e) => setF((x) => ({ ...x, q: e.target.value }))} /></div>
        {/* Sprint 3 — the band is FILTERABLE (client requirement). These chips are real. */}
        <div className="fchip" data-testid="band-filter">
          <Ic k="bolt" />Band
          <select aria-label="Filter by score band" value={f.temperature ?? ''}
            onChange={(e) => setF((x) => ({ ...x, temperature: e.target.value || undefined }))}>
            <option value="">All</option>
            <option value="hot">Hot</option>
            <option value="warm">Warm</option>
            <option value="cold">Cold</option>
          </select>
        </div>
        {/* ...and SORTABLE. */}
        <div className="fchip" data-testid="sort-control">
          <Ic k="analytics" />Sort
          <select aria-label="Sort leads" value={f.sort}
            onChange={(e) => setF((x) => ({ ...x, sort: e.target.value }))}>
            <option value="recent">Newest first</option>
            <option value="score">Score: high to low</option>
            <option value="score_asc">Score: low to high</option>
            <option value="followup">Next follow-up</option>
            <option value="name">Name (A–Z)</option>
            <option value="oldest">Oldest first</option>
          </select>
        </div>
        <button className={`fchip${f.sla ? ' on' : ''}`} style={{ marginLeft: 'auto' }}
          onClick={() => setF((x) => ({ ...x, sla: !x.sla }))}>
          <Ic k="clock" />SLA breached
        </button>
        {/* Client change (Jul 2026) — surface all duplicate-type leads (the `flag`
            action, and any is_duplicate lead) in one click. */}
        <button className={`fchip${f.dup ? ' on' : ''}`} data-testid="dup-filter"
          onClick={() => setF((x) => ({ ...x, dup: !x.dup }))}>
          <Ic k="refresh" />Duplicates
        </button>
      </div>
      </div>
      {/* Classic view — the traditional dense data table (default), untouched from Batch E. */}
      {view === 'classic' && (
        <TableCard title="Leads" more={`${data.data?.total ?? 0} in scope`} cols={[...LEAD_COLS, 'Actions']} sticky
          rows={rows.map((l) => [...leadRow(l), rowActions({
            onView: () => openLead(Number(l.id)),
            onEdit: canEditLead ? () => openLead(Number(l.id)) : undefined,
            onDelete: canDeleteLead ? () => del.openDelete(Number(l.id), l.full_name) : undefined,
          })])}
          empty="No leads in scope yet — add a lead or connect a source"
          onRowClick={(i) => openLead(Number(rows[i].id))} />
      )}
      {/* Modern view — the SaaS "A3" rich-row/card layout on this app's tokens. */}
      {view === 'modern' && (
        <ModernLeads rows={rows} total={data.data?.total ?? 0} openLead={openLead}
          canEditLead={canEditLead} canDeleteLead={canDeleteLead} del={del} />
      )}
      {/* Inbox view — the SaaS "C3" split list + reading pane. */}
      {view === 'inbox' && (
        <InboxLeads rows={rows} openLead={openLead}
          canEditLead={canEditLead} canDeleteLead={canDeleteLead} del={del} />
      )}
      {del.deleteModal}
    </>
  );
}

/* ==========================================================================
 * UAT-R3b #11 — Modern + Inbox Leads views (SaaS tenant parity, app tokens).
 * Both consume the SAME rows the Classic table does (one /leads fetch, one set
 * of filters + RBAC scope) and expose the SAME row actions (open / edit / delete;
 * reassign lives inside the lead sheet that "open" launches). The Inbox reading
 * pane reuses the lead-detail endpoint (/leads/:id) and the lead sheet's activity
 * feed — no parallel data path.
 * ======================================================================== */
type LeadsViewProps = {
  rows: any[];
  openLead: (id: number) => void;
  canEditLead: boolean;
  canDeleteLead: boolean;
  del: { openDelete: (id: number, name: string) => void };
};

const stageBadgeClass = (t?: string) => (t === 'won' ? 'b-green' : t === 'lost' ? 'b-rose' : 'b-cyan');

function ModernLeads({ rows, total, openLead, canEditLead, canDeleteLead, del }: LeadsViewProps & { total: number }) {
  return (
    <div className="card lv-modern" data-testid="leads-modern">
      <div className="card-head"><h3><Ic k="grid" />Leads</h3><span className="more">{total} in scope</span></div>
      <div className="lv-cards">
        {rows.length === 0 && <div className="empty-note" style={{ padding: 24 }}>No leads in scope yet — add a lead or connect a source</div>}
        {rows.map((l) => {
          const overdue = l.next_follow_up_at && new Date(l.next_follow_up_at) < new Date();
          const bucket = l.temperature === 'hot' ? 'hot' : l.temperature === 'warm' ? 'warm' : l.temperature === 'cold' ? 'cold' : '';
          return (
            <div key={l.id} className={`lv-card${bucket ? ` b-${bucket}` : ''}`} onClick={() => openLead(Number(l.id))}>
              <Avatar name={l.full_name} size="lg" />
              <div className="main">
                <div className="r1">
                  <span className="nm">{l.full_name}</span>
                  <TempBadge temperature={l.temperature} score={l.score} />
                  {l.sla_breached ? <span className="bdg b-rose" title="SLA breached">SLA</span> : null}
                  {l.is_flagged && !l.sla_breached ? <span className="bdg b-amber" title={l.flag_reason || 'Flagged'}>!</span> : null}
                  <span className={`bdg ${stageBadgeClass(l.stage_type)}`} style={{ marginLeft: 'auto' }}>{l.stage_name || '—'}</span>
                </div>
                <div className="r2 mono sub">{l.phone}{l.email ? ` · ${l.email}` : ''}</div>
                <div className="r3">
                  <span className="kv"><Ic k="leads" />{l.course_name || '—'}</span>
                  <span className="kv"><Ic k="grid" />{dn(l.vertical_name, l.vertical_deleted)} · {dn(l.pipeline_name, l.pipeline_deleted)}</span>
                  <span className="kv"><span className="bdg b-indigo">{dn(l.source_name, l.source_deleted) || '—'}</span></span>
                  <span className="kv"><Ic k="users" />{l.owner_name || 'Unassigned'}</span>
                  <span className="kv" style={overdue ? { color: 'var(--danger)' } : undefined}><Ic k="clock" />{fmtDT(l.next_follow_up_at)}</span>
                </div>
              </div>
              <div className="lv-card-act" onClick={(e) => e.stopPropagation()}>
                <button className="ract" title="View" onClick={() => openLead(Number(l.id))}><Ic k="eye" w={2.1} /></button>
                {canEditLead && <button className="ract" title="Edit" onClick={() => openLead(Number(l.id))}><Ic k="pencil" w={2.1} /></button>}
                {canDeleteLead && <button className="ract" title="Delete" style={{ color: 'var(--danger)' }} onClick={() => del.openDelete(Number(l.id), l.full_name)}><Ic k="trash" w={2.1} /></button>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function InboxLeads({ rows, openLead, canEditLead, canDeleteLead, del }: LeadsViewProps) {
  const [sel, setSel] = useState<number | null>(null);
  // Keep the selection valid as the (filtered) rows change; the right pane reuses /leads/:id.
  useEffect(() => {
    if (sel != null && !rows.some((r) => Number(r.id) === sel)) setSel(null);
  }, [rows, sel]);
  const detail = useFetch<any>(sel != null ? `/leads/${sel}` : null, [sel]);
  return (
    <div className="card lv-inbox" data-testid="leads-inbox">
      <div className="lv-inbox-list">
        <div className="lv-inbox-head"><Ic k="leads" />Leads<span className="c">{rows.length}</span></div>
        <div className="lv-inbox-rows">
          {rows.length === 0 && <div className="empty-note" style={{ padding: 20 }}>No leads in scope yet</div>}
          {rows.map((l) => {
            const overdue = l.next_follow_up_at && new Date(l.next_follow_up_at) < new Date();
            return (
              <button key={l.id} type="button"
                className={`lv-inbox-row${sel === Number(l.id) ? ' on' : ''}`}
                aria-label={`Open ${l.full_name} in the reading pane`}
                onClick={() => setSel(Number(l.id))}>
                <div className="top">
                  <Avatar name={l.full_name} />
                  <span className="nm">{l.full_name}</span>
                  <span className="when mono sub" style={overdue ? { color: 'var(--danger)' } : undefined}>{fmtDT(l.next_follow_up_at)}</span>
                </div>
                <div className="meta">
                  <span className={`bdg ${stageBadgeClass(l.stage_type)}`}>{l.stage_name || 'New'}</span>
                  <span className="sub">{l.owner_name || 'Unassigned'}{l.source_name ? ` · ${l.source_name}` : ''}</span>
                </div>
                <div className="prev">
                  <TempBadge temperature={l.temperature} score={l.score} />
                  {l.sla_breached ? <span className="bdg b-rose" title="SLA breached">SLA</span> : null}
                </div>
              </button>
            );
          })}
        </div>
      </div>
      <div className="lv-inbox-detail">
        {sel == null ? (
          <div className="lv-inbox-empty"><Ic k="leads" /><div>Select a lead to see its details</div></div>
        ) : detail.loading || !detail.data ? (
          <div className="empty-note" style={{ marginTop: '28vh' }}>Loading lead…</div>
        ) : (
          <InboxDetail lead={detail.data} openLead={openLead}
            canEditLead={canEditLead} canDeleteLead={canDeleteLead} del={del} />
        )}
      </div>
    </div>
  );
}

function InboxDetail({ lead, openLead, canEditLead, canDeleteLead, del }: { lead: any } & Omit<LeadsViewProps, 'rows'>) {
  const acts = (lead.activities as any[]) || [];
  return (
    <>
      <div className="lv-inbox-dhead">
        <Avatar name={lead.full_name} size="lg" />
        <div className="grow">
          <div className="nm">{lead.full_name}</div>
          <div className="sub mono">{lead.phone}{lead.email ? ` · ${lead.email}` : ''}{lead.source_name ? ` · ${lead.source_name}` : ''}</div>
          <div className="chips">
            <TempBadge temperature={lead.temperature} score={lead.score} />
            <span className="bdg b-indigo">{dn(lead.vertical_name, lead.vertical_deleted)} · {dn(lead.pipeline_name, lead.pipeline_deleted)}</span>
            {lead.sla_breached ? <span className="bdg b-rose" title="SLA breached">SLA breached</span> : null}
          </div>
        </div>
        <div className="acts">
          <button className="btn primary" onClick={() => openLead(Number(lead.id))}><Ic k="eye" />Open full</button>
          {canEditLead && <button className="btn" onClick={() => openLead(Number(lead.id))}><Ic k="pencil" />Edit</button>}
          {canDeleteLead && <button className="btn" style={{ color: 'var(--danger)' }} onClick={() => del.openDelete(Number(lead.id), lead.full_name)}><Ic k="trash" />Delete</button>}
        </div>
      </div>
      <div className="lv-inbox-dbody">
        <div className="sheet-sec">
          <h5>Details</h5>
          <KV rows={[
            ['Course', lead.course_name || '—'],
            ['Owner', lead.owner_name || 'Unassigned'],
            ['Stage', lead.stage_name || '—'],
            ['Next follow-up', fmtDT(lead.next_follow_up_at)],
          ]} />
        </div>
        <div className="sheet-sec">
          <h5>Recent activity</h5>
          <div className="lv-timeline">
            {acts.length === 0 && <div className="empty-note">No activity yet</div>}
            {acts.slice(0, 12).map((a) => (
              <div className="lv-tl" key={a.id}>
                <span className="dot" />
                <div className="body">
                  <div className="t1">{a.note || a.type}</div>
                  <div className="t2 sub">{a.actor_name ? `${a.actor_name} · ` : ''}{fmtFull(a.occurred_at)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
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
                    {l.sla_breached ? <span className="bdg b-rose" title="SLA breached">SLA</span> : null}
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
              'Status': edit.is_active === false ? 'Inactive' : 'Active',
            },
            // only the parent link is immutable (DEF-2)
            lock: ['Campaign'],
            // UAT-R2 #4 — Source Category + Cost per Lead removed; backend keeps existing values.
            submit: async (vals) => {
              await api.patch(`/sources/${edit.id}`, {
                name: need(vals['Source Name'], 'Source name is required'),
                is_active: vals['Status'] !== 'Inactive',
              });
              return 'Source updated';
            },
          }} />
      )}
    </>
  );
}

/** DB enum -> the prototype's Branch Type labels (and back, in HierarchyService.branchType). */
const BRANCH_TYPE_LABEL: Record<string, string> = { company: 'Company Branch', franchise: 'Franchise Branch' };

function Branches() {
  const { refreshTick, bump } = useScreen();
  const { can } = useAuth();
  const ref = useRef_();
  const [inc, setInc] = useState(false);
  // UAT-R3 #19 — Branch list filters: search on name/code (+ status via inc).
  const [q, setQ] = useState('');
  const bparams = new URLSearchParams();
  if (inc) bparams.set('include_inactive', '1');
  if (q.trim()) bparams.set('q', q.trim());
  const list = useFetch<any[]>(`/branches${bparams.toString() ? `?${bparams}` : ''}`, [refreshTick, bparams.toString()]);
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
        // UAT-R2 #21 — show the Pipeline level so the tree reads Branch → Vertical → Pipeline.
        children: ref.pipelines.filter((p) => Number(p.vertical_id) === Number(v.id)).map((p) => ({
          label: p.name, icon: 'list', tag: p.code ? String(p.code) : undefined,
        })),
      })),
    })),
  }];
  return (
    <>
      <Blocks blocks={[{ type: 'tree', title: 'Hierarchy', nodes }]} />
      <div className="filters">
        <SearchChip q={q} setQ={setQ} ph="Search branch name / code\u2026" />
        <IncInactiveChip on={inc} set={setInc} />
      </div>
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
  // UAT-R3 #19 — Vertical list filters: by Branch (+ search, status).
  const [q, setQ] = useState('');
  const [fBranch, setFBranch] = useState<number | undefined>(undefined);
  const vparams = new URLSearchParams();
  if (inc) vparams.set('include_inactive', '1');
  if (fBranch) vparams.set('branch_id', String(fBranch));
  if (q.trim()) vparams.set('q', q.trim());
  const list = useFetch<any[]>(`/verticals${vparams.toString() ? `?${vparams}` : ''}`, [refreshTick, vparams.toString()]);
  const rows = list.data ?? [];
  const [view, setView] = useState<any | null>(null);
  const [edit, setEdit] = useState<any | null>(null);
  const canEdit = can('vertical.update');
  const del = useDelete('Vertical', '/verticals', () => { list.reload(); ref.reload(); bump(); });
  const after = () => { list.reload(); ref.reload(); bump(); };
  return (
    <>
      <div className="filters">
        <HChip label="Branch" icon="branch" value={fBranch} list={ref.branches} onChange={setFBranch} />
        <SearchChip q={q} setQ={setQ} ph="Search vertical name / code\u2026" />
        <IncInactiveChip on={inc} set={setInc} />
      </div>
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
  // UAT-R3 #19 — Pipeline list filters follow Branch \u2192 Vertical (+ search); child resets on parent change.
  const [q, setQ] = useState('');
  const [fBranch, setFBranch] = useState<number | undefined>(undefined);
  const [fVertical, setFVertical] = useState<number | undefined>(undefined);
  const pparams = new URLSearchParams();
  if (inc) pparams.set('include_inactive', '1');
  if (fBranch) pparams.set('branch_id', String(fBranch));
  if (fVertical) pparams.set('vertical_id', String(fVertical));
  if (q.trim()) pparams.set('q', q.trim());
  const list = useFetch<any[]>(`/pipelines${pparams.toString() ? `?${pparams}` : ''}`, [refreshTick, pparams.toString()]);
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
      <div className="filters">
        <HChip label="Branch" icon="branch" value={fBranch} list={ref.branches}
          onChange={(v) => { setFBranch(v); setFVertical(undefined); }} />
        <HChip label="Vertical" icon="grid" value={fVertical} disabled={!fBranch}
          list={ref.verticals.filter((v) => !fBranch || Number(v.branch_id) === fBranch)} onChange={setFVertical} />
        <SearchChip q={q} setQ={setQ} ph="Search pipeline name / code\u2026" />
        <IncInactiveChip on={inc} set={setInc} />
      </div>
      {/* UAT-R2 #7 — the list reads in hierarchy order Branch \u203a Vertical \u203a Pipeline
          (columns and row order); the api sorts by branch, vertical, then pipeline name. */}
      <TableCard title="Pipelines" cols={['Branch', 'Vertical', 'Pipeline', 'Stages', 'Status', 'Actions']}
        rowClass={(i) => (rows[i].is_active === false ? 'row-inactive' : undefined)}
        rows={rows.map((pl) => [
          String(pl.branch_name ?? '\u2014'),
          String(pl.vertical_name ?? '\u2014'),
          { node: <span className="nm">{pl.name}</span> } as Cell,
          stagesBy[Number(pl.id)] ?? '\u2026',
          toggleCell({
            active: pl.is_active !== false, name: pl.name, entity: 'Pipeline', canToggle: canEdit,
            onToggle: async (next) => { await api.patch(`/pipelines/${pl.id}`, { is_active: next }); after(); },
          }),
          rowActions({
            onView: () => setView(pl), onEdit: canEdit ? async () => {
              // UAT-R2 #9 — load the live stages so the Edit form's stage editor prefills them.
              const st = await api.get<any[]>(`/pipelines/${pl.id}/stages`).catch(() => []);
              setEdit({ ...pl, _stages: st });
            } : undefined,
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
              // UAT-R3 #22 — Branch/Vertical are SELECTS now (prefilled via initialIds), not locked text.
              'Branch': edit.branch_name ?? '', 'Vertical': edit.vertical_name ?? '',
              'Pipeline Owner': edit.owner_name ?? '',
              // UAT-R2 #9 — the live stages prefill the editor (add / edit / reorder / delete persist on save).
              'Pipeline Stages': JSON.stringify((edit._stages ?? []).map((st: any) => ({
                id: Number(st.id), name: st.name, stage_type: st.stage_type,
                is_default: st.is_default === true, is_active: st.is_active !== false,
              }))),
              'Status': edit.is_active === false ? 'Inactive' : 'Active',
            },
            initialIds: {
              'Pipeline Owner': edit.owner_user_id ? Number(edit.owner_user_id) : undefined,
              // UAT-R3 #22 — prefill Branch + Vertical as ids so the Edit form reopens cascading
              // and both are EDITABLE (changing Branch resets Vertical; changing Vertical
              // re-parents the pipeline and re-denormalises its campaigns/sources/leads).
              'Branch': edit.branch_id ? Number(edit.branch_id) : undefined,
              'Vertical': edit.vertical_id ? Number(edit.vertical_id) : undefined,
            },
            submit: async (vals, ids) => {
              await api.patch(`/pipelines/${edit.id}`, {
                name: need(vals['Pipeline Name'], 'Pipeline name is required'),
                code: need(vals['Pipeline Code'], 'Pipeline code is required'),
                // #22 — vertical_id drives the re-parent; branch is derived from it server-side.
                vertical_id: need(ids['Vertical'], 'Pick a Vertical (filtered by the Branch)'),
                branch_id: ids['Branch'],
                owner_user_id: ids['Pipeline Owner'] ?? null,
                is_active: vals['Status'] !== 'Inactive',
              });
              const original: StageRow[] = (edit._stages ?? []).map((st: any) => ({
                id: Number(st.id), name: st.name, stage_type: st.stage_type,
                is_default: st.is_default === true, is_active: st.is_active !== false,
              }));
              return reconcilePipelineStages(Number(edit.id), original, parseStageRows(vals['Pipeline Stages']));
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
const DUP_SCOPE_LABEL: Record<string, string> = { this_campaign: 'Within this campaign', this_vertical: 'Within this vertical', this_branch: 'Within this branch', global: 'All / global', this_pipeline: 'Within this campaign' };
const DUP_ACTION_LABEL: Record<string, string> = {
  ignore: 'Ignore duplicate', merge: 'Merge duplicate', create: 'Create duplicate leads', merge_and_reopen: 'Merge & reopen closed leads — assign to round-robin user', flag: 'Flag all these types of leads',
};
const PRIORITY_LABEL: Record<string, string> = { low: 'Low', med: 'Medium', high: 'High' };

const OP_LABEL: Record<string, string> = { equals: '=', not_equals: '≠', contains: 'contains', in: 'in' };

export function CampaignView({ campaign, leadCount, onClose, onChanged }: { campaign: any; leadCount: number; onClose: () => void; onChanged?: () => void }) {
  const ref = useRef_();
  const { can } = useAuth();
  const canEdit = can('campaign.update');
  const dist = (campaign.distribution_config as any) ?? {};
  const userName = (id: number) => nameOf(ref.users, id) ?? `User #${id}`;
  // #24 — per-agent pause/resume, applied against campaign_agent_pause.
  const [paused, setPaused] = useState<Set<number>>(() => new Set(((campaign.paused_agent_user_ids ?? []) as number[]).map(Number)));
  const [pauseBusy, setPauseBusy] = useState<number | null>(null);
  // UAT-R3b #24 — the dedicated Agents / Managed toggle lives in its own section below.
  const [amTab, setAmTab] = useState<'agents' | 'managed'>('agents');
  const togglePause = async (uid: number) => {
    const next = !paused.has(uid);
    setPauseBusy(uid);
    try {
      await api.patch(`/campaigns/${campaign.id}/agents/${uid}/pause`, { paused: next });
      setPaused((prev) => { const n = new Set(prev); if (next) n.add(uid); else n.delete(uid); return n; });
      toast(next ? 'Agent paused — new leads will skip them' : 'Agent resumed');
      onChanged?.();
    } catch (e: any) { toast(e.message, true); } finally { setPauseBusy(null); }
  };
  const managerIds: number[] = Array.isArray(campaign.manager_user_ids) ? (campaign.manager_user_ids as number[]).map(Number) : [];
  const agentIds: number[] = Array.isArray(dist.agent_user_ids) ? (dist.agent_user_ids as number[]).map(Number) : [];
  const activeCount = agentIds.filter((id) => !paused.has(id)).length;
  const agentsNode = agentIds.length
    ? <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {agentIds.map((id) => (
          <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="mapchip" style={paused.has(id) ? { opacity: 0.55, textDecoration: 'line-through' } : undefined}>{userName(id)}</span>
            {paused.has(id) && <span className="bdg b-amber" style={{ fontSize: 10 }}>Paused</span>}
          </div>
        ))}
      </div>
    : (dist.mode === 'on_demand' ? 'Anyone in scope (self-assign)' : 'None selected');
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
          ['Campaign Type', campaign.campaign_type || '\u2014'],
          ['Marketing Channel', campaign.marketing_channel || '\u2014'],
          ['Runs', campaign.start_date
            ? `${fmtDate(campaign.start_date)}${campaign.end_date ? ` \u2192 ${fmtDate(campaign.end_date)}` : ' \u2192 open-ended'}`
            : '\u2014'],
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
          ['Agents', agentsNode],
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
      {/* UAT-R3b #24 — a dedicated Agents / Managed toggle: pause/resume individual agents
          (lead assignment continues on the active ones) and see the visibility-only managers. */}
      <Section title="Agents / Managed">
        <div className="seg" style={{ marginBottom: 12 }}>
          <button className={amTab === 'agents' ? 'on' : ''} onClick={() => setAmTab('agents')}>Agents ({agentIds.length})</button>
          <button className={amTab === 'managed' ? 'on' : ''} onClick={() => setAmTab('managed')}>Managed ({managerIds.length})</button>
        </div>
        {amTab === 'agents' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="sub" style={{ fontSize: 11.5 }}>
              {dist.mode === 'on_demand'
                ? 'On Demand — agents self-assign via Start Calling; a paused agent is not handed leads and resumes when un-paused.'
                : `Lead assignment rotates across the ${activeCount} active agent${activeCount === 1 ? '' : 's'}; a paused agent is skipped by the distribution engine and resumes the instant you un-pause them.`}
            </div>
            {agentIds.length === 0
              ? <div className="lrow empty">No agents in this campaign's distribution pool.</div>
              : agentIds.map((id) => (
                <div key={id} className="am-agent" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="mapchip" style={paused.has(id) ? { opacity: 0.55, textDecoration: 'line-through' } : undefined}>{userName(id)}</span>
                  <span className={`bdg ${paused.has(id) ? 'b-amber' : 'b-green'}`} style={{ fontSize: 10 }}>{paused.has(id) ? 'Paused' : 'Active'}</span>
                  <span style={{ flex: 1 }} />
                  {canEdit && <button className="btn" style={{ padding: '3px 12px', fontSize: 11.5 }} disabled={pauseBusy === id} onClick={() => togglePause(id)}>{paused.has(id) ? 'Resume' : 'Pause'}</button>}
                </div>
              ))}
          </div>
        )}
        {amTab === 'managed' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="sub" style={{ fontSize: 11.5 }}>
              Managers are a <b>visibility-only</b> role: they monitor this campaign but are NOT in
              the auto-assignment pool, so they receive no round-robin leads — there is nothing to
              pause here. Pause / Resume affects agents only (the Agents tab).
            </div>
            {managerIds.length === 0
              ? <div className="lrow empty">No managers assigned to this campaign.</div>
              : managerIds.map((id) => (
                <div key={id} className="am-manager" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="mapchip">{userName(id)}</span>
                  <span className="bdg b-indigo" style={{ fontSize: 10 }}>Manager · visibility</span>
                </div>
              ))}
          </div>
        )}
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
  // UAT-R3 #19 — Campaign list filters follow Branch \u2192 Vertical \u2192 Pipeline (+ search, status);
  // each child resets when its parent changes and the API honours the params.
  const [q, setQ] = useState('');
  const [fBranch, setFBranch] = useState<number | undefined>(undefined);
  const [fVertical, setFVertical] = useState<number | undefined>(undefined);
  const [fPipeline, setFPipeline] = useState<number | undefined>(undefined);
  const cparams = new URLSearchParams();
  if (inc) cparams.set('include_inactive', '1');
  if (fBranch) cparams.set('branch_id', String(fBranch));
  if (fVertical) cparams.set('vertical_id', String(fVertical));
  if (fPipeline) cparams.set('pipeline_id', String(fPipeline));
  if (q.trim()) cparams.set('q', q.trim());
  const list = useFetch<any[]>(`/campaigns${cparams.toString() ? `?${cparams}` : ''}`, [refreshTick, cparams.toString()]);
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
      <div className="filters">
        <HChip label="Branch" icon="branch" value={fBranch} list={ref.branches}
          onChange={(v) => { setFBranch(v); setFVertical(undefined); setFPipeline(undefined); }} />
        <HChip label="Vertical" icon="grid" value={fVertical} disabled={!fBranch}
          list={ref.verticals.filter((v) => !fBranch || Number(v.branch_id) === fBranch)}
          onChange={(v) => { setFVertical(v); setFPipeline(undefined); }} />
        <HChip label="Pipeline" icon="list" value={fPipeline} disabled={!fVertical}
          list={ref.pipelines.filter((p) => !fVertical || Number(p.vertical_id) === fVertical)} onChange={setFPipeline} />
        <SearchChip q={q} setQ={setQ} ph="Search campaign name\u2026" />
        <IncInactiveChip on={inc} set={setInc} />
      </div>
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
      {view && <CampaignView campaign={view} leadCount={counts[Number(view.id)] ?? 0} onClose={() => setView(null)} onChanged={() => list.reload()} />}
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
    // Branch › Vertical — prefill both so the Configure Course form reopens cascading.
    'Branch': (edit.meta as any)?.branch_id ? Number((edit.meta as any).branch_id) : undefined,
    'Vertical': (edit.meta as any)?.vertical_id ? Number((edit.meta as any).vertical_id) : undefined,
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
        branch_id: need(ids['Branch'], 'Pick a Branch'),
        vertical_id: need(ids['Vertical'], 'Pick a Vertical (filtered by the Branch)'),
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
          String(nameOf(ref.verticals, (c.meta as any)?.vertical_id) ?? (c.meta as any)?.vertical ?? '\u2014'),
          String((c.meta as any)?.mode ?? '\u2014'),
          String((c.meta as any)?.duration ?? '\u2014'),
          String((c.meta as any)?.fee ?? '\u2014'),
          String(nameOf(ref.branches, (c.meta as any)?.branch_id) ?? '\u2014'),
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
              ['Branch', nameOf(ref.branches, (view.meta as any)?.branch_id) ?? '\u2014'],
              ['Vertical', nameOf(ref.verticals, (view.meta as any)?.vertical_id) ?? '\u2014'],
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

/* ------------------------- Users row-action modals ---------------------- */

/** Row action #9 — admin sets a new password (strength-validated; plaintext never logged). */
export function ChangePasswordModal({ user, onClose }: { user: any; onClose: () => void }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const strong = pw.length >= 8 && /[A-Za-z]/.test(pw) && /[0-9]/.test(pw);
  const match = pw === pw2;
  const go = async () => {
    if (!strong || !match) return;
    setBusy(true);
    try {
      await api.patch(`/users/${user.id}/password`, { password: pw });
      toast(`Password updated for ${user.name}`);
      onClose();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <div className="add-scrim" style={{ zIndex: 300 }}>
      <div className="add-modal" style={{ width: 430 }}>
        <div className="ah"><h3><Ic k="key" />Change password — {user.name}</h3><button className="ax" onClick={onClose}><Ic k="x" /></button></div>
        <div className="abody">
          <div className="fld"><label>New password</label>
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Min 8 chars, a letter and a number" autoComplete="new-password" /></div>
          <div className="fld"><label>Confirm password</label>
            <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" /></div>
          <div className="empty-note" style={{ fontSize: 11.5, padding: '6px 2px', textAlign: 'left' }}>
            {pw && !strong ? 'Weak — needs 8+ characters including a letter and a number.'
              : pw2 && !match ? 'Passwords do not match.'
              : 'The user can sign in with this password immediately. It is never shown again.'}
          </div>
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !strong || !match} onClick={go}><Ic k="check" />Set password</button>
        </div>
      </div>
    </div>
  );
}

/** Row action #7 — bulk hand-off: move ALL of this user's leads to another active user. */
export function ReassignLeadsModal({ user, onDone, onClose }: { user: any; onDone: () => void; onClose: () => void }) {
  const [to, setTo] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const target = to[0];
  const go = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const res = await api.post<{ moved: number }>(`/leads/reassign-all`, { from_user_id: Number(user.id), to_user_id: Number(target) });
      toast(res.moved > 0 ? `Reassigned ${res.moved} lead${res.moved === 1 ? '' : 's'} from ${user.name}` : `${user.name} had no leads to reassign`);
      onDone();
      onClose();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <div className="add-scrim" style={{ zIndex: 300 }}>
      <div className="add-modal" style={{ width: 460 }}>
        <div className="ah"><h3><Ic k="swap" />Reassign leads — {user.name}</h3><button className="ax" onClick={onClose}><Ic k="x" /></button></div>
        <div className="abody">
          <div className="empty-note" style={{ fontSize: 12, padding: '2px 2px 10px', textAlign: 'left' }}>
            Moves <b>every</b> lead currently owned by <b>{user.name}</b> to the user you pick below. Only active, in-scope users are offered.
          </div>
          <div className="fld"><label>Reassign to</label>
            <UserPicker value={to} onChange={setTo} multiple={false} placeholder="Search a user…" />
          </div>
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !target} onClick={go}><Ic k="check" />Reassign all</button>
        </div>
      </div>
    </div>
  );
}

/** Rows #3/#4/#5 — View Branch / Vertical / Campaign the user is assigned to (one endpoint). */
function UserScopeModal({ user, kind, onClose }: { user: any; kind: 'branch' | 'vertical' | 'campaign'; onClose: () => void }) {
  const [d, setD] = useState<{ branches: any[]; verticals: any[]; campaigns: any[] } | null>(null);
  useEffect(() => {
    api.get<any>(`/users/${user.id}/access`).then(setD).catch((e) => { toast(e.message, true); onClose(); });
  }, [user.id, onClose]);
  const cfg = {
    branch: { title: 'Branches', icon: 'branch', rows: d?.branches ?? [], empty: 'Not assigned to any branch' },
    vertical: { title: 'Verticals', icon: 'grid', rows: d?.verticals ?? [], empty: 'Not assigned to any vertical' },
    campaign: { title: 'Campaigns', icon: 'target', rows: d?.campaigns ?? [], empty: 'Not on any campaign' },
  }[kind];
  return (
    <DetailModal title={`${cfg.title} — ${user.name}`} icon={cfg.icon} width={480} onClose={onClose}>
      {!d ? <div className="empty-note">Loading…</div>
        : cfg.rows.length === 0 ? <div className="empty-note">{cfg.empty}</div>
        : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {cfg.rows.map((r: any) => (
              <div key={r.id} className="fchip" style={{ justifyContent: 'flex-start' }}>
                <Ic k={cfg.icon} />{r.name}
              </div>
            ))}
          </div>
        )}
    </DetailModal>
  );
}

/** Row action #6 — View Lead: the leads this user owns (scoped, read-only list). */
function UserLeadsModal({ user, onClose }: { user: any; onClose: () => void }) {
  const [d, setD] = useState<{ total: number; rows: any[] } | null>(null);
  useEffect(() => {
    api.get<any>(`/leads?owner_id=${user.id}&limit=200`).then(setD).catch((e) => { toast(e.message, true); onClose(); });
  }, [user.id, onClose]);
  return (
    <DetailModal title={`Leads owned by ${user.name}`} icon="leads" width={640} onClose={onClose}>
      {!d ? <div className="empty-note">Loading…</div>
        : d.rows.length === 0 ? <div className="empty-note">This user owns no leads in your scope</div>
        : (
          <>
            <div className="empty-note" style={{ textAlign: 'left', padding: '0 2px 10px', fontSize: 12 }}>
              <b>{d.total}</b> lead{d.total === 1 ? '' : 's'} owned by {user.name} (showing {d.rows.length}).
            </div>
            <TableCard cols={['Lead', 'Stage', 'Temp', 'Created']}
              rows={d.rows.map((l: any) => [
                { node: <div><div className="nm">{l.full_name || l.name || '—'}</div><div className="sub mono">{l.phone}</div></div> } as Cell,
                l.stage_name || '—',
                l.temperature ? renderCell({ b: [l.temperature, l.temperature === 'hot' ? 'b-red' : l.temperature === 'warm' ? 'b-amber' : 'b-gray'] }) : '—',
                fmtFull(l.created_at),
              ])} empty="No leads" />
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

  // Row-action modal state (each menu item opens a REAL wired action)
  const [pwUser, setPwUser] = useState<any | null>(null);
  const [reassignUser, setReassignUser] = useState<any | null>(null);
  const [scopeModal, setScopeModal] = useState<{ user: any; kind: 'branch' | 'vertical' | 'campaign' } | null>(null);
  const [leadsUser, setLeadsUser] = useState<any | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; body: any; confirmLabel: string; danger?: boolean; onConfirm: () => Promise<void> } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const runConfirm = async () => {
    if (!confirm) return;
    setConfirmBusy(true);
    try { await confirm.onConfirm(); setConfirm(null); } catch (e: any) { toast(e.message, true); } finally { setConfirmBusy(false); }
  };
  const toggleStatus = (u: any) => {
    const next = u.status === 'disabled' ? 'active' : 'disabled';
    setConfirm({
      title: next === 'active' ? 'Activate user' : 'Deactivate user',
      danger: next === 'disabled', confirmLabel: next === 'active' ? 'Activate' : 'Deactivate',
      body: next === 'active'
        ? <>Reactivate <b>{u.name}</b>? They can sign in again immediately.</>
        : <>Deactivate <b>{u.name}</b>? They can no longer sign in and are skipped by every owner picker. Existing leads are untouched.</>,
      onConfirm: async () => { await api.patch(`/users/${u.id}/status`, { status: next }); toast(`${u.name} ${next === 'active' ? 'activated' : 'deactivated'}`); after(); },
    });
  };
  const toggleLeadAssign = (u: any, enabled: boolean) => {
    const next = !enabled;
    setConfirm({
      title: next ? 'Enable lead assignment' : 'Disable lead assignment',
      danger: !next, confirmLabel: next ? 'Enable' : 'Disable',
      body: next
        ? <>Resume automatic lead assignment for <b>{u.name}</b>? The distribution engine will include them in round-robin and conditional hand-out again.</>
        : <>Stop assigning NEW leads to <b>{u.name}</b>? The distribution engine skips them everywhere. They keep their existing leads and can still sign in. Re-enable any time.</>,
      onConfirm: async () => { await api.patch(`/users/${u.id}/lead-assignment`, { enabled: next }); toast(`Lead assignment ${next ? 'enabled' : 'disabled'} for ${u.name}`); after(); },
    });
  };

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
            { node: (() => {
              const isSelf = Number(u.id) === Number(me?.user.id);
              const laEnabled = u.lead_assignment_enabled !== false;
              const items: Array<RowMenuItem | false | null | undefined> = [
                // 1 — Edit (multi-branch, role, etc.)
                canEdit && { label: 'Edit', icon: 'pencil', onClick: () => setEdit(u) },
                // 2 — Activate / Deactivate the account
                can('user.deactivate') && { label: u.status === 'disabled' ? 'Activate' : 'Deactivate', icon: 'power', danger: u.status !== 'disabled', onClick: () => toggleStatus(u) },
                'divider',
                // 3/4/5 — View Branch / Vertical / Campaign
                { label: 'View branches', icon: 'branch', onClick: () => setScopeModal({ user: u, kind: 'branch' }) },
                { label: 'View verticals', icon: 'grid', onClick: () => setScopeModal({ user: u, kind: 'vertical' }) },
                { label: 'View campaigns', icon: 'target', onClick: () => setScopeModal({ user: u, kind: 'campaign' }) },
                // 6 — View Lead (leads owned by this user)
                can('lead.read') && { label: 'View leads', icon: 'leads', onClick: () => setLeadsUser(u) },
                'divider',
                // 7 — Reassign Lead (bulk hand-off of ALL their leads)
                can('lead.assign') && { label: 'Reassign leads', icon: 'swap', onClick: () => setReassignUser(u) },
                // 8 — Enable / Disable Lead Assignment (global per-user switch)
                canEdit && { label: laEnabled ? 'Disable lead assignment' : 'Enable lead assignment', icon: 'bolt', danger: laEnabled, onClick: () => toggleLeadAssign(u, laEnabled) },
                // 9 — Change Password
                canEdit && { label: 'Change password', icon: 'key', onClick: () => setPwUser(u) },
                // 10 — Delete (soft delete; self-delete is refused by the API)
                (can('user.delete') && !isSelf) && { label: 'Delete', icon: 'trash', danger: true, onClick: () => del.openDelete(Number(u.id), u.name) },
              ];
              return <RowMenu items={items} />;
            })() } as Cell,
          ];
        })} empty="No users match the current filters" />
      {del.deleteModal}
      {view && <UserView user={view} onClose={() => setView(null)} />}
      {pwUser && <ChangePasswordModal user={pwUser} onClose={() => setPwUser(null)} />}
      {reassignUser && <ReassignLeadsModal user={reassignUser} onDone={after} onClose={() => setReassignUser(null)} />}
      {scopeModal && <UserScopeModal user={scopeModal.user} kind={scopeModal.kind} onClose={() => setScopeModal(null)} />}
      {leadsUser && <UserLeadsModal user={leadsUser} onClose={() => setLeadsUser(null)} />}
      {confirm && (
        <ConfirmModal title={confirm.title} body={confirm.body} confirmLabel={confirm.confirmLabel}
          danger={confirm.danger} busy={confirmBusy} onConfirm={runConfirm} onClose={() => setConfirm(null)} />
      )}
      {edit && (() => {
        // MULTI-BRANCH: prefill EVERY branch/vertical the user currently holds from the
        // already-fetched detail (details[id].assignments). Rows scoped to a pipeline/
        // campaign/team are NOT managed by this form — carry them through untouched (`extra`).
        const ed = details[Number(edit.id)];
        const eas: any[] = ed?.assignments ?? [];
        const isPlain = (a: any) => a.pipeline_id == null && a.campaign_id == null && a.team_id == null;
        const plain = eas.filter(isPlain);
        const extra: AssignmentRow[] = eas.filter((a) => !isPlain(a)).map((a) => ({
          role_id: Number(a.role_id),
          branch_id: a.branch_id != null ? Number(a.branch_id) : null,
          vertical_id: a.vertical_id != null ? Number(a.vertical_id) : null,
          pipeline_id: a.pipeline_id != null ? Number(a.pipeline_id) : null,
          campaign_id: a.campaign_id != null ? Number(a.campaign_id) : null,
          team_id: a.team_id != null ? Number(a.team_id) : null,
        }));
        const branchCsv = [...new Set(plain.filter((a) => a.branch_id != null).map((a) => Number(a.branch_id)))].join(',');
        const vertCsv = plain.filter((a) => a.vertical_id != null).map((a) => {
          const b = a.branch_id != null ? Number(a.branch_id)
            : Number(ref.verticals.find((v) => Number(v.id) === Number(a.vertical_id))?.branch_id);
          return `${Number(a.vertical_id)}:${b || ''}`;
        }).join(',');
        const roleId = plain[0]?.role_id ?? eas[0]?.role_id;
        return (
          <AddModal formKey="admin.users" onClose={() => setEdit(null)} onSaved={after}
            edit={{
              title: `Edit User — ${edit.name}`,
              // Email ID / System Role / Branch + Vertical Access are editable and prefilled.
              initialVals: {
                'Full Name': edit.name ?? '', 'Email ID': edit.email ?? '', 'Mobile Number': edit.phone ?? '',
                'System Role': edit.role_names ?? '',
                'Branch Access': branchCsv,
                'Vertical Access': vertCsv,
                'Status': edit.status === 'disabled' ? 'Deactivated' : 'Active',
              },
              initialIds: { 'System Role': roleId ? Number(roleId) : undefined },
              // password is only set when the admin types a new one
              optional: ['Password / Login Method'],
              submit: async (vals, ids) => {
                const role = ids['System Role'];
                await api.patch(`/users/${edit.id}`, {
                  name: need(vals['Full Name'], 'Name is required'),
                  email: vals['Email ID'] || null,
                  phone: vals['Mobile Number'] || null,
                  ...(vals['Password / Login Method'] ? { password: vals['Password / Login Method'] } : {}),
                  // Reconcile: send the FULL desired set. The API deactivates old assignments and
                  // re-inserts these, so ticking/un-ticking a branch adds/removes it; `extra`
                  // preserves the user's pipeline/campaign/team grants.
                  ...(role ? { assignments: buildUserAssignments(role, parseIdCsv(vals['Branch Access']), parseVertCsv(vals['Vertical Access']), extra) } : {}),
                  status: vals['Status'] === 'Active' ? 'active' : 'disabled',
                });
                return 'User updated';
              },
            }} />
        );
      })()}
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

/*
 * ActivityReports and FunnelAnalytics USED TO LIVE HERE, and Sprint 6 deleted them.
 *
 * They fetched `/audit-logs?limit=500` and `/leads/summary` and did the aggregation IN
 * THE BROWSER — which meant the "user activity" table was built from whatever 500 audit
 * rows happened to come back, and one of its columns was called "Calls" with an em-dash
 * in it. The real ones (reports/standard.service.ts) aggregate server-side, over the
 * whole window, through the ScopeResolver, and say out loud why there is no Calls column.
 *
 * They are DELETED rather than left unused: a dead component that still renders is one
 * `dyn` registry typo away from being live again, and it would look right.
 */

/**
 * WORKSPACE > TASKS. It reads `/follow-ups` — the SAME endpoint, table, statuses and
 * priorities as My Tasks, because the doc says "same fields & statuses as lead
 * follow-ups" and a second task store with the same fields is the fork that forbids.
 * See docs/dev/08 §5 for what that costs (a task must belong to a lead) and why the
 * alternative was not worth risking on a live database in the last week of Phase 1.
 */
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
            WhatsApp Live Chat (two-way inbox) is planned for Phase 2.<br />
            Outbound WhatsApp — templates, bulk sends and automation — is live now under Engagement & Workflow.
          </div>
        </div>
        <div className="wa-comp">
          <button className="tplbtn"><Ic k="doc" /></button>
          <input placeholder="Type a message…" disabled />
          <button className="send" onClick={() => toast('The two-way WhatsApp inbox is planned for Phase 2. Outbound WhatsApp is live under Engagement & Workflow.')}><Ic k="send" /></button>
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
  walkIns: WalkIns,
  referrals: Referrals,
  leadsAll: LeadsAll,
  leadImport: LeadImport,
  followups: Followups,
  kanban: Kanban,
  scoring: Scoring,
  sources: Sources,
  captureChannels: Channels,
  startCalling: StartCalling,
  sla: Sla,
  // Sprint 4 — engagement & automation
  templates: Templates,
  journeys: Journeys,
  bulkWhatsApp: BulkWhatsApp,
  bulkSms: BulkSms,
  emailCampaigns: EmailCampaigns,
  settings: Settings,
  // Sprint 5 — conversion & money-lite
  quotations: Quotations,
  saleClosure: SaleClosure,
  monthlyTargets: MonthlyTargets,
  counsellorPerformance: CounsellorPerformance,
  feeCollection: FeeCollection,
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
  apiModule: ApiModule,
  deletedItems: DeletedItems,
  // Sprint 6 — Analytics & Reports (the old browser-side ActivityReports and
  // FunnelAnalytics are replaced by the real, server-scoped ones in sprint6.tsx)
  reportBuilder: ReportBuilder,
  savedReports: SavedReports,
  scheduledDelivery: ScheduledDelivery,
  funnelAnalytics: FunnelReport,
  tatReport: TatReport,
  activityReports: ActivityReport,
  campaignRoi: CampaignRoiReport,
  // Sprint 6 — Workspace. `workTasks` is UNCHANGED and still reads /follow-ups: the
  // Workspace task IS the follow-up task (docs/dev/08 §5).
  teamChat: TeamChat,
  workNotes: Notes,
  knowledgeBase: KnowledgeBase,
  announcements: Announcements,
  workTasks: WorkTasks,
  waChat: WaChat,
  supportTickets: SupportTickets,
  crossSell: CrossSell,
  sitemap: Sitemap,
};

export { checkS };
