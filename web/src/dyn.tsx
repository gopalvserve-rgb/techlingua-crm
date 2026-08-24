/**
 * Dynamic screens — prototype layouts fed by live API data.
 * Each component matches the corresponding prototype screen's blocks & columns 1:1.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, getToken } from './api';
import { useAuth } from './auth';
import { Ic, checkS } from './icons';
import {
  Avatar, BarsCard, Blocks, Cell, Funnel, HBars, Kpis, ListCard, TableCard, TempBadge, renderCell,
} from './renderer';
import { toast, useFetch, useRef_, selectableUsers } from './refdata';

/** Open an auth-guarded PDF: fetch with the bearer token, then open the blob (window.open can't set headers). */
async function openPdfAuthed(path: string) {
  try {
    const res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!res.ok) throw new Error(`Could not open the PDF (${res.status}).`);
    const url = URL.createObjectURL(await res.blob());
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e: any) { toast(e.message, true); }
}

import { AddModal, MasterQuickAdd, CampaignModal, need, EditSpec, parseStageRows, reconcilePipelineStages, StageRow, buildUserAssignments, parseIdCsv, parseVertCsv, AssignmentRow, COURSE_TYPES, COURSE_LEVELS, DELIVERY_MODES, levelsPayload, TASK_ENTITY_OPTS, TASK_ENTITY_KEY, TASK_STATUS_KEY, TASK_STATUS_LABEL } from './forms';
import { PhoneInput } from './phonefield';
import { AddMasterModal, MASTER_LABELS } from './mastermodal';
import { RoleModal } from './rolemodal';
import {
  ConfirmModal, DetailModal, IncInactiveChip, KV, RowMenu, RowMenuItem, Section, fmtFull, rowActions, toggleCell,
} from './rowactions';
import { UserPicker } from './userpicker';
import { useColumnVisibility, ColumnsButton } from './colprefs';
import { StudentDocuments, StudentPhotoUpload, VerticalLogoUpload, VerticalQrUpload, VerticalBanksEditor } from './documents';
import type { VertPayments } from './documents';
import { ImpactList, ImpactReport, useDelete } from './deletemodal';
import { APP } from './specs';
import { useScope } from './scope';
import { DateRange, presetRange, matchPreset, fmtDMYIST, fmtDateTimeIST } from './daterange';
import { FollowupFilter, FollowupValue, FU_PRESETS } from './followupfilter';
import { StageConfigurator } from './stageconfig';
import LeadImport from './leadimport';
import Channels from './channels';
import { NotificationEvents } from './notifevents';
import ApiModule from './apimodule';
import { LeadTransferModal, BulkTransferModal, BulkReassignModal, BulkPauseModal } from './leadtransfer';
import { ListActions, exportLeads, BulkDeleteModal, useTableSelect, useBulkDelete, BulkBar, downloadObjectsCsv } from './listtools';
import { RedFlagModal } from './leadsheet';
import { ConvertStudentModal, BulkConvertStudentsModal } from './convertstudent';
import { AdmissionsScreen } from './admissions';
import { CustomFieldsAdmin, fetchCfDefs, coerceCf, collectCf, type CfDef } from './customfields';
import StartCalling from './calling';
import { Calendar, Referrals, Scoring, Sla, WalkIns, dur } from './sprint3';
import {
  BulkWhatsApp, Journeys, Settings, SmsTemplates, Templates,
} from './sprint4';
import {
  CounsellorPerformance, FeeCollection, MonthlyTargets, Quotations, SaleClosure, CollectModal, ReceiptViewModal,
} from './sprint5';
import { fmtINR, enrolDiscount, previewSchedule, EnrolDiscountType } from './money';
import {
  ActivityReport, Announcements, CampaignRoiReport, FunnelReport, KnowledgeBase, Notes,
  ReportBuilder, SavedReports, ScheduledDelivery, TatReport, TeamChat,
} from './sprint6';
import { CONVERSION_LABEL_LEAD_WON } from './metrics';
import { SupportTickets } from './support';
import { CrossSell } from './crosssell';
import { FinanceSettings } from './financesettings';
import { DiscountMaster } from './discountmaster';
import { AttendanceScreen, TestsScreen, AssignmentsScreen, BatchRosterModal } from './academics';
import { StudyMaterialScreen, CertificatesScreen, ReportCardsScreen } from './learning';
import { CourseContentScreen, SyllabusScreen } from './academics-content';
import { PlacementsScreen, PlacementsTab } from './placements';
import { CatalogScreen, InventoryScreen, AssetsScreen, VendorsScreen, ProcurementScreen } from './operations';
import { InvoicesScreen, FinanceDashboard } from './invoices';
import { PaymentPlansScreen, FeeDuesScreen, PlanDetailModal } from './paymentplans';
import { PaymentsScreen } from './payments';
import { RefundsScreen } from './refunds';
import { RevenueScreen, CollectionReportsScreen } from './revenue';
import { EmployeeDirectoryScreen, StaffAttendanceScreen, LeavesScreen } from './hr';
import { QuestionBankScreen, QuestionCategoriesScreen, AssessmentTestsScreen, AssessmentTemplatesScreen, AssessmentEvaluationScreen, AssessmentResultsScreen, GradeSchemesScreen, AssessmentCertificatesScreen } from './assessments';
import { AiIntelligence, DashAiInsights } from './ai';
import { TrainingVideosScreen, ReleaseNotesScreen } from './supportextras';

export interface ScreenCtxT {
  // Aug 2026 — an optional 3rd arg carries list filter params (owner_id, temperature, won,
  // unassigned, created_from/to, sla_breached, …) so a KPI card opens its list pre-filtered.
  go: (m: string, s: string, params?: Record<string, string | number | undefined>) => void;
  openLead: (id: number, mode?: 'view' | 'edit') => void;
  openAdd: (formKey: string) => void;
  refreshTick: number;
  bump: () => void;
  // DEF-05 — the live location.search, fed by the Shell. URL-driven filter screens (Today's
  // Follow-ups, Leads) re-seed from it when an in-app re-navigation changes the query while the
  // screen is ALREADY mounted (e.g. the top-bar Upcoming/Due Today/New Leads shortcuts).
  search?: string;
}
export const ScreenCtx = createContext<ScreenCtxT>(null as unknown as ScreenCtxT);
const useScreen = () => useContext(ScreenCtx);

/**
 * DEF-05 — re-seed a URL-driven filter when an IN-APP re-navigation changes the query string while
 * the target screen is already mounted. Fires only when the search string actually CHANGES; a manual
 * filter edit never touches the URL, so the user's own changes are preserved. The initial mount is a
 * no-op (the useState seed already ran with the same value). When `search` is undefined (bare unit
 * tests with no Shell), the effect never fires and the on-mount seed is untouched.
 */
function useReseedOnSearch(search: string | undefined, reseed: (search?: string) => void) {
  const seeded = useRef(search);
  useEffect(() => {
    if (search === seeded.current) return;
    seeded.current = search;
    reseed(search);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Read the Today's-Follow-ups preset from a query string (defaults to Today, the screen's name). */
function seedTodayFollowup(search?: string): FollowupValue {
  const sp = new URLSearchParams(typeof search === 'string' ? search : (typeof window !== 'undefined' ? window.location.search : ''));
  const f = sp.get('followup');
  if (f) return { followup: f, fu_from: sp.get('fu_from') || undefined, fu_to: sp.get('fu_to') || undefined };
  return { followup: 'today' };
}

/** Append the active global scope (branch_id/vertical_id/...) to a fetch path as a query. */
function withScope(path: string, sp: Record<string, string>): string {
  const keys = Object.keys(sp);
  if (!keys.length) return path;
  const qs = new URLSearchParams(sp).toString();
  return path + (path.includes('?') ? '&' : '?') + qs;
}

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

const LEAD_COLS = ['Lead', 'Branch', 'Course', 'Vertical · Pipeline', 'Campaign', 'Source', 'Score', 'Lead Counsellor', 'Stage', 'Status', 'Next follow-up', 'Created on'];

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
    dn(l.branch_name, l.branch_deleted) || '—',
    l.course_name || '—',
    `${dn(l.vertical_name, l.vertical_deleted)} · ${dn(l.pipeline_name, l.pipeline_deleted)}`,
    dn(l.campaign_name, l.campaign_deleted) || '—',
    { b: [dn(l.source_name, l.source_deleted) || '—', 'b-indigo'] },
    { node: (
      <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
        <TempBadge temperature={l.temperature} score={l.score} />
        {/* Sprint 3 — a breached SLA / an escalated follow-up is visible in the LIST,
            not only in a report. This is the badge the client will look for. */}
        {l.sla_breached ? <span className="bdg b-rose" title="SLA breached">SLA</span> : null}
        {l.is_flagged && !l.sla_breached
          ? <span className="bdg b-amber" title={l.flag_reason || 'Flagged'}>!</span> : null}
        {l.is_red_flagged ? <span className="bdg b-red" title="Red flagged"><Ic k="flag" w={2} /></span> : null}
        {/* dev/95 item 1 — returning student (alumni) flag on the list. */}
        {l.is_existing_student ? <span className="bdg b-green" title={`Returning student${l.existing_student_name ? ' — ' + l.existing_student_name : ''}${l.existing_student_no ? ' (' + l.existing_student_no + ')' : ''}`}>Alumni</span> : null}
      </span>) },
    l.owner_name || 'Unassigned',
    { b: [l.stage_name || '—', l.stage_type === 'won' ? 'b-green' : l.stage_type === 'lost' ? 'b-rose' : 'b-cyan'] },
    // dev/84 item 9 — Lead Status (status master value) column, sortable + exported (names).
    { b: [l.status_name || '—', 'b-gray'] },
    { node: <span className="mono sub" style={overdue ? { color: 'var(--danger)' } : undefined}>{fmtDT(l.next_follow_up_at)}</span> },
    // dev/84 item 9 — Lead creation date (DD-MM-YYYY IST), sortable (Newest/Oldest) + exported.
    { node: <span className="mono sub">{fmtDateTimeIST(l.created_at)}</span> },
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

function fuRow(f: any, openLead: (id: number, mode?: 'view' | 'edit') => void): { row: Cell[]; leadId: number } {
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
  const { me } = useAuth();
  // Global scope (top-bar selector) narrows the dashboard within the caller's RBAC scope.
  // The /dashboard endpoint ANDs these ids on top of the ScopeResolver, so they can only
  // ever narrow — never widen — what the user is allowed to see.
  const { params: sp, key: scopeKey } = useScope();
  // SHARED date range (client, Aug 2026). Default = All time so the dashboard opens on the same
  // all-time numbers it always has; picking a preset narrows the LEAD COHORT by created date
  // (the endpoint ANDs created_at BETWEEN from/to on top of RBAC + global scope). It never widens.
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const rq = new URLSearchParams();
  if (range.from) rq.set('from', range.from);
  if (range.to) rq.set('to', range.to);
  const rqs = rq.toString();
  const rangeKey = `${range.from ?? ''}~${range.to ?? ''}`;
  const d = useFetch<Dash>(withScope('/dashboard' + (rqs ? `?${rqs}` : ''), sp), [refreshTick, scopeKey, rangeKey]);
  const today = useFetch<any[]>(withScope('/follow-ups?due=today&limit=5', sp), [refreshTick, scopeKey]);
  const mine = useFetch<any[]>('/follow-ups?mine=1&status=pending&limit=4', [refreshTick]);
  const recent = useFetch<{ total: number; rows: any[] }>(withScope('/leads?limit=5', sp), [refreshTick, scopeKey]);

  const data = d.data;
  const has = (w: string) => !!data?.widgets.includes(w);
  const k = data?.kpis;
  const fu = data?.follow_ups;
  const personal = data?.view === 'counsellor' || data?.view === 'team';

  // Aug 2026 (client) — EVERY meaningful KPI card opens the filtered list behind its number.
  // Cards go through go('leads','all', <filter>) (owner_id/won/temperature/created/sla/unassigned
  // are all honoured by the Leads list + API) or go('dash', <sub>) for task/walk-in lists.
  const myId = me?.user?.id != null ? Number(me.user.id) : undefined;
  const TODAY = new Date().toISOString().slice(0, 10);           // matches the server's CURRENT_DATE (UTC)
  const leadsTo = (filter: Record<string, string | number | undefined>) => () => go('leads', 'all', filter);

  // dev/125 — the leads KPI card must REFLECT the selected date filter, not be stuck on
  // "Today's leads". The count already tracks the range (server narrows the whole cohort, so
  // `kpis.total` is all-time when no preset is picked and the range-count once one is), and the
  // drill-through opens the leads list on the SAME created-date window; here we make the label
  // and value match the active preset resolved from the shared DateRange value.
  const leadsPreset = matchPreset(range);
  const LEADS_CARD_LABEL: Record<string, string> = {
    all: 'All-time Leads', today: "Today's Leads", yesterday: "Yesterday's Leads",
    week: "This Week's Leads", month: "This Month's Leads", custom: 'Leads (custom range)',
  };
  const leadsCardLabel = LEADS_CARD_LABEL[leadsPreset] ?? 'Leads';
  // `kpis.total` is the scope+range-narrowed lead count (all-time when no preset is active).
  const leadsCardVal = k?.total ?? 0;
  // The created-date window the card drills into: empty (all leads) for All time, else the range.
  const leadsRangeFilter = leadsPreset === 'all'
    ? {} : { created_from: range.from, created_to: range.to };

  // a counsellor's KPI strip is about THEIR work; a manager's is about the unit.
  const kpiItems = personal ? [
    { lab: 'My leads', val: String(k?.total ?? 0), ic: 'leads',
      onClick: leadsTo({ owner_id: myId }), navLabel: `My leads: ${k?.total ?? 0}. Open my Leads list` },
    { lab: 'My conversions', val: String(k?.won ?? 0), ic: 'check',
      onClick: leadsTo({ owner_id: myId, won: 1 }), navLabel: `My conversions: ${k?.won ?? 0}. Open my won Leads` },
    // #13(c) — the task SUMMARY tiles open the My Tasks list (this is the "Task Summary"
    // the client clicks). Card-header "View all ›" keeps working too.
    { lab: 'My open tasks', val: String(fu?.my_open ?? 0), ic: 'clock',
      delta: fu?.my_overdue ? `${fu.my_overdue} overdue` : undefined, tone: fu?.my_overdue ? 'down' as const : 'flat' as const,
      onClick: () => go('dash', 'mytasks'), navLabel: `My open tasks: ${fu?.my_open ?? 0}. Open My Tasks list` },
    { lab: 'Due today', val: String(fu?.my_due_today ?? 0), ic: 'cal',
      onClick: () => go('dash', 'mytasks'), navLabel: `Tasks due today: ${fu?.my_due_today ?? 0}. Open My Tasks list` },
    { lab: 'Hot leads', val: String(k?.hot ?? 0), ic: 'bolt',
      onClick: leadsTo({ owner_id: myId, temperature: 'hot' }), navLabel: `Hot leads: ${k?.hot ?? 0}. Open my Hot leads` },
    { lab: 'New today', val: String(k?.today ?? 0), ic: 'users',
      onClick: leadsTo({ owner_id: myId, created_from: TODAY, created_to: TODAY }), navLabel: `New today: ${k?.today ?? 0}. Open my leads created today` },
  ] : [
    { lab: leadsCardLabel, val: String(leadsCardVal), ic: 'leads',
      onClick: leadsTo(leadsRangeFilter), navLabel: `${leadsCardLabel}: ${leadsCardVal}. Open the leads behind this number` },
    { lab: 'Conversions', val: String(k?.won ?? 0), ic: 'check',
      onClick: leadsTo({ won: 1 }), navLabel: `Conversions: ${k?.won ?? 0}. Open won Leads` },
    { lab: 'Pending follow-ups', val: String(fu?.pending ?? 0), ic: 'clock',
      delta: fu?.overdue ? `${fu.overdue} overdue` : undefined, tone: fu?.overdue ? 'down' as const : 'flat' as const,
      // #13(c) — the manager's task-summary tile opens the My Tasks list (the follow-up module,
      // §4i). My Tasks is the actionable task/follow-up list; Today's Follow-ups is due=today only.
      onClick: () => go('dash', 'mytasks'), navLabel: `Pending follow-ups: ${fu?.pending ?? 0}. Open My Tasks list` },
    { lab: 'SLA breaches', val: String(data?.sla?.open_breaches ?? 0), ic: 'bolt',
      tone: (data?.sla?.open_breaches ?? 0) > 0 ? 'down' as const : 'flat' as const,
      onClick: leadsTo({ sla_breached: 1 }), navLabel: `SLA breaches: ${data?.sla?.open_breaches ?? 0}. Open breached Leads` },
    { lab: 'Walk-ins today', val: String(data?.walkins?.today ?? 0), ic: 'users',
      onClick: () => go('dash', 'walkins'), navLabel: `Walk-ins today: ${data?.walkins?.today ?? 0}. Open Walk-ins list` },
    { lab: 'Unassigned', val: String(k?.unassigned ?? 0), ic: 'target',
      onClick: leadsTo({ unassigned: 1 }), navLabel: `Unassigned: ${k?.unassigned ?? 0}. Open unassigned Leads` },
  ];

  return (
    <>
      <div className="filters" style={{ marginBottom: 12 }}>
        <span className="fchip on" style={{ cursor: 'default' }} data-view={data?.view ?? ''}>
          <Ic k="users" />{data ? VIEW_LABEL[data.view] : 'Loading…'}
        </span>
        {data?.view === 'admin' && <span className="fchip" style={{ cursor: 'default' }}>Org-wide</span>}
        {/* SHARED date range — narrows the lead cohort (created date) behind the KPIs,
            funnel and leaderboard. Default All time, so nothing is hidden on open. */}
        <DateRange value={range} onChange={setRange} idPrefix="dash-dr" style={{ marginLeft: 'auto' }} />
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
        <DashAiInsights go={go} />
      </div>

      {/* ASSESSMENTS block on the default admin Overview (docs/dev/64). Self-guards on
          assessment_attempt.read (hidden for anyone without it, so the lead dashboard for a
          counsellor is unchanged) and sources /assessment-reports/admin + /faculty: KPI cards
          (tests, attempts, pass rate, avg %, pending evaluation, certificates — each clickable
          through to its list), a grade distribution and the hardest questions. */}
      <AssessmentDashboardCards />

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

const ENTITY_LABEL_FROM_KEY: Record<string, string> = Object.fromEntries(
  Object.entries(TASK_ENTITY_KEY).map(([label, key]) => [key, label]));

export const taskEditSpec = (f: any, after: () => void): EditSpec => ({
  title: `Edit Task \u2014 ${f.lead_name}`,
  initialVals: {
    'Title': f.notes ?? '',
    'Task Type': f.type_name ?? '',
    'Related Lead': f.lead_name ?? '',
    // Client Aug 2026 (#2) — Branch/Vertical prefill on task edit.
    'Branch': f.branch_name ?? '',
    'Vertical': f.vertical_name ?? '',
    // MY TASK overhaul (dev/133) — Related-To + Task Status + completion prefill.
    'Related To': f.entity_type ? (ENTITY_LABEL_FROM_KEY[f.entity_type] ?? '') : '',
    'Related Record': f.entity_label ?? '',
    'Task Status': TASK_STATUS_LABEL[f.task_status] ?? 'In Progress',
    'Assigned To': f.owner_name ?? '',
    'Report To': f.report_to_name ?? '',
    'Due Date': dtLocal(f.scheduled_at),
    'Priority': capFirst(f.priority) ?? 'Medium',
    'Description': '',
    'Completion Remark': f.completion_note ?? '',
  },
  initialIds: {
    'Task Type': f.type_id == null ? undefined : Number(f.type_id),
    'Related Lead': f.lead_id == null ? undefined : Number(f.lead_id),
    'Branch': f.branch_id == null ? undefined : Number(f.branch_id),
    'Vertical': f.vertical_id == null ? undefined : Number(f.vertical_id),
    'Related Record': f.entity_id == null ? undefined : Number(f.entity_id),
    'Assigned To': f.owner_id == null ? undefined : Number(f.owner_id),
    'Report To': f.report_to_id == null ? undefined : Number(f.report_to_id),
  },
  lock: ['Related Lead'],
  submit: async (vals, ids) => {
    const relType = vals['Related To'] ? TASK_ENTITY_KEY[vals['Related To']] : null;
    await api.patch(`/follow-ups/${f.id}`, {
      type_id: ids['Task Type'] ?? null,
      owner_id: ids['Assigned To'] ?? undefined,
      report_to_id: ids['Report To'] ?? null,
      branch_id: ids['Branch'] ?? null,
      vertical_id: ids['Vertical'] ?? null,
      entity_type: relType,
      entity_id: relType ? (ids['Related Record'] ?? null) : null,
      task_status: TASK_STATUS_KEY[vals['Task Status']] || 'in_progress',
      completion_note: vals['Completion Remark'] || null,
      scheduled_at: need(vals['Due Date'], 'Due date is required'),
      priority: (vals['Priority'] || 'Medium').toLowerCase(),
      notes: [vals['Title'], vals['Description']].filter(Boolean).join(' \u2014 ') || undefined,
    });
    after();
    return 'Task updated';
  },
});

// MY TASK overhaul (dev/133) — display helpers for the task rows.
const ENTITY_TYPE_LABEL: Record<string, string> = Object.fromEntries(
  TASK_ENTITY_OPTS.map((lbl) => [TASK_ENTITY_KEY[lbl], lbl]));
function TaskStatusBadge({ s }: { s?: string }) {
  if (!s) return null;
  const tone: Record<string, string> = {
    in_progress: 'var(--primary)', on_hold: 'var(--warning, #b8860b)',
    completed: 'var(--success, #1a7f37)', overdue: 'var(--danger)',
  };
  return (
    <span data-testid="task-status-badge" style={{
      marginLeft: 6, fontSize: 10.5, fontWeight: 700, padding: '1px 7px', borderRadius: 10,
      color: '#fff', background: tone[s] || 'var(--text-dim)', verticalAlign: 'middle',
    }}>{TASK_STATUS_LABEL[s] || s}</span>
  );
}

function MyTaskCard({ rows, more, title = 'My Tasks', empty, onOpenList }: { rows: any[]; more?: string; title?: string; empty?: string; onOpenList?: () => void }) {
  const { bump, openLead } = useScreen();
  const { can } = useAuth();
  const canEdit = can('followup.update');
  const [edit, setEdit] = useState<any | null>(null);
  // #13(b) — a confirmation popup before marking a task done (no accidental one-click).
  const [confirmDone, setConfirmDone] = useState<any | null>(null);
  const [outcome, setOutcome] = useState('');
  const [busy, setBusy] = useState(false);
  const complete = async () => {
    if (!confirmDone) return;
    setBusy(true);
    // MY TASK overhaul (dev/133) — completing captures the outcome/remark + completed_by/at (server).
    try { await api.patch(`/follow-ups/${confirmDone.id}`, { complete: true, completion_note: outcome || null }); toast('Task marked done'); setConfirmDone(null); setOutcome(''); bump(); }
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
              <div className="t1">{f.type_name || 'Task'} — {f.lead_name}<TaskStatusBadge s={f.task_status_eff || f.task_status} /></div>
              <div className="t2">
                {f.notes ? <>{f.notes} · </> : null}
                <span data-testid="task-assignee">Assignee: {f.owner_name || '—'}</span>
                {f.entity_type ? <span data-testid="task-related"> · {ENTITY_TYPE_LABEL[f.entity_type] || f.entity_type}: {f.entity_label || '—'}</span> : null}
                {f.report_to_name ? <span style={{ color: 'var(--text-dim)' }}> · Reports to {f.report_to_name}</span> : null}
                {(f.task_status_eff === 'completed' || f.status === 'done') && f.completion_note
                  ? <span style={{ color: 'var(--text-dim)' }}> · Outcome: {f.completion_note}</span> : null}
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
          body={<div>
            <div style={{ marginBottom: 8 }}>{`\u201c${confirmDone.type_name || 'Task'} \u2014 ${confirmDone.lead_name}\u201d will be marked Completed.`}</div>
            <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>Completion outcome / remark (optional)</label>
            <textarea className="ainp" data-testid="task-completion-note" value={outcome}
              onChange={(e) => setOutcome(e.target.value)} placeholder="e.g. Spoke to lead, enrolment confirmed" />
          </div>}
          confirmLabel="Mark done" busy={busy}
          onConfirm={complete} onClose={() => { setConfirmDone(null); setOutcome(''); }} />
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
  const { params: sp, key: scopeKey } = useScope();
  const ref = useRef_();
  // client update #4 — two views: Assigned to Me (owner) | Created by Me (creator).
  // dev/133 — "Reported by Me" is renamed to "Created by Me" everywhere.
  const [view, setView] = useState<'assigned' | 'reported'>('assigned');
  // MY TASK overhaul (dev/133) — the 6 cards drive the list; 'open' is the default set.
  const [card, setCard] = useState<string>('open');
  // SHARED date range on the task DUE date (scheduled_at). Default All time — never hide open tasks.
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  // Task-specific filters (client item 5): Task Status, Related-To type, Assignee.
  const [tstatuses, setTstatuses] = useState<string[]>([]);
  const [entityType, setEntityType] = useState<string>('');
  const [owners, setOwners] = useState<number[]>([]);
  const rq = new URLSearchParams({ view, card, limit: '50' });
  if (range.from) rq.set('from', range.from);
  if (range.to) rq.set('to', range.to);
  for (const ts of tstatuses) rq.append('task_statuses', ts);
  if (entityType) rq.set('entity_type', entityType);
  for (const o of owners) rq.append('owner_ids', String(o));
  const fkey = [view, card, range.from ?? '', range.to ?? '', tstatuses.join(','), entityType, owners.join(',')].join('~');
  const sum = useFetch<any>('/follow-ups/summary', [refreshTick]);
  const list = useFetch<any[]>(withScope(`/follow-ups?${rq.toString()}`, sp), [fkey, refreshTick, scopeKey]);
  const s = sum.data ?? {};
  const pick = (a: string, b: string) => (view === 'assigned' ? s[a] : s[b]);
  // The 6 My-Tasks cards (client docx): each shows a live count for the current view and,
  // on click, filters the list to exactly that set (card→list, same predicate as the count).
  const CARDS: Array<{ id: string; lab: string; ic: string; val: number }> = [
    { id: 'open', lab: 'Open Tasks', ic: 'check', val: pick('my_open_all', 'reported_open_all') ?? 0 },
    { id: 'due_today', lab: 'Due Today', ic: 'clock', val: pick('my_due_today', 'reported_due_today') ?? 0 },
    { id: 'overdue', lab: 'Overdue', ic: 'clock', val: pick('my_overdue', 'reported_overdue') ?? 0 },
    { id: 'in_progress', lab: 'In Progress', ic: 'bolt', val: pick('my_in_progress', 'reported_in_progress') ?? 0 },
    { id: 'completed', lab: 'Completed', ic: 'check', val: pick('my_completed', 'reported_completed') ?? 0 },
    { id: 'next7', lab: 'Due Next 7D', ic: 'cal', val: pick('my_next7', 'reported_next7') ?? 0 },
  ];
  const TASK_STATUS_OPTS = [
    { id: 'in_progress', name: 'In Progress' }, { id: 'on_hold', name: 'On Hold' },
    { id: 'completed', name: 'Completed' }, { id: 'overdue', name: 'Overdue' },
  ];
  const openLabel = view === 'assigned' ? (s.my_open_all ?? 0) : (s.reported_open_all ?? 0);
  return (
    <>
      <div className="seltabs" style={{ marginBottom: 14 }}>
        <button className={view === 'assigned' ? 'on' : ''} onClick={() => setView('assigned')}>
          Assigned to Me{s.my_open_all != null ? ` (${s.my_open_all})` : ''}
        </button>
        <button className={view === 'reported' ? 'on' : ''} onClick={() => setView('reported')}>
          Created by Me{s.reported_open_all != null ? ` (${s.reported_open_all})` : ''}
        </button>
      </div>
      <div className="filters" style={{ marginBottom: 12, flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <DateRange value={range} onChange={setRange} idPrefix="mytasks-dr" />
        <EnumMulti label="Task Status" icon="check" value={tstatuses} options={TASK_STATUS_OPTS} onChange={setTstatuses} testid="fm-taskstatus" />
        <div className="fmulti" data-testid="fm-relatedto">
          <span className="fmulti-lbl"><Ic k="link" />Related To</span>
          <select className="ainp" style={{ minWidth: 140 }} value={entityType} onChange={(e) => setEntityType(e.target.value)}>
            <option value="">All types</option>
            {TASK_ENTITY_OPTS.map((lbl) => <option key={lbl} value={TASK_ENTITY_KEY[lbl]}>{lbl}</option>)}
          </select>
        </div>
        <FilterMulti label="Assignee" testid="fm-assignee" icon="users" value={owners} options={selectableUsers(ref.users)} onChange={setOwners} />
      </div>
      {/* MY TASK overhaul (dev/133) — 6 cards; the active card is highlighted; clicking filters the list. */}
      <Kpis cols={6} items={CARDS.map((c) => ({
        lab: c.lab, val: String(c.val), ic: c.ic,
        tone: (card === c.id ? 'up' : undefined) as any, delta: card === c.id ? 'showing' : undefined,
        onClick: () => setCard(c.id), navLabel: `${c.lab}: ${c.val}. Filter My Tasks to this set`,
      }))} />
      <MyTaskCard rows={list.data ?? []} more={`${openLabel} open`}
        title={view === 'assigned' ? 'Assigned to Me' : 'Created by Me'}
        empty={view === 'assigned' ? 'No tasks in this view' : 'No tasks you created in this view'} />
    </>
  );
}

function TodayFollowups() {
  const { refreshTick, bump, search } = useScreen();
  // Follow-up date filter (client #3). Seed the preset from the URL so the top-bar shortcuts
  // "Due Today" (followup=today) and "Upcoming" (followup=next7) land here pre-filtered;
  // default to Today, matching the screen's name. "No Followup" is hidden (this list IS
  // follow-ups). Switching the preset re-queries with the same IST windows used everywhere.
  const [fu, setFu] = useState<FollowupValue>(() => seedTodayFollowup(search));
  // DEF-05 — when a top-bar shortcut re-navigates here while this screen is already open
  // (Missed -> Upcoming/Due Today), the query param changes but the screen does not remount;
  // re-seed the preset from the new query so the chip + header follow the shortcut.
  useReseedOnSearch(search, (s) => { setFu(seedTodayFollowup(s)); setBucket(undefined); });
  // Client Aug 2026 — the KPI cards drive a bucket-scoped list (one of FOLLOWUP_BUCKETS). When a
  // card is active it overrides the preset filter; picking from the preset control clears it.
  const [bucket, setBucket] = useState<string | undefined>(undefined);
  const rq = new URLSearchParams({ limit: '100' });
  if (bucket) {
    rq.set('bucket', bucket);
  } else {
    if (fu.followup) rq.set('followup', fu.followup);
    if (fu.fu_from) rq.set('fu_from', fu.fu_from);
    if (fu.fu_to) rq.set('fu_to', fu.fu_to);
  }
  const fuKey = `${bucket ?? ''}~${fu.followup ?? ''}~${fu.fu_from ?? ''}~${fu.fu_to ?? ''}`;
  const fuLabel = bucket
    ? (FU_BUCKETS.find((b) => b.key === bucket)?.lab ?? 'Follow-ups')
    : (FU_PRESETS.find((p) => p.key === fu.followup)?.label
      ?? (fu.followup === 'custom' ? 'Custom range' : 'All follow-ups'));
  const stats = useFetch<any>('/follow-ups/stats', [refreshTick]);
  const list = useFetch<any[]>(`/follow-ups?${rq.toString()}`, [fuKey, refreshTick]);
  const st = stats.data ?? {};
  return (
    <>
      {/* Client Aug 2026 — 8 KPI stat cards; each shows its count + is clickable to open the
          matching filtered follow-up list (scope-respecting, IST) below. */}
      <Kpis cols={4} items={FU_BUCKETS.map((b) => ({
        lab: b.lab, val: String(st[b.key] ?? 0), ic: b.ic,
        tone: ((b.key === 'overdue' || b.key === 'unreachable') && Number(st[b.key] ?? 0) > 0 ? 'down' : 'flat') as 'down' | 'flat',
        onClick: () => { setBucket(b.key); setFu({}); },
        navLabel: `${b.lab}: ${st[b.key] ?? 0}. Open the ${b.lab} follow-up list`,
      }))} />
      <div className="filters" style={{ marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <FollowupFilter value={fu} onChange={(v) => { setFu(v); setBucket(undefined); }} allowNoFollowup={false} idPrefix="today-fu" variant="buttons" />
        {bucket && <button className="btn ghost" onClick={() => setBucket(undefined)}>Clear card filter</button>}
      </div>
      {/* #14 — actionable: open the lead, mark done (confirm), overdue highlighted red. */}
      <div className="card">
        <div className="card-head">
          <h3><Ic k="clock" />{fuLabel}</h3>
          <span className="more">{st.due_today ?? 0} due today · {st.overdue ?? 0} overdue</span>
        </div>
        <FollowupRows rows={list.data ?? []} onChanged={bump} empty={`No follow-ups for \u201c${fuLabel}\u201d`} />
      </div>
    </>
  );
}

/** The 8 Today's Follow-ups KPI cards (client Aug 2026). `key` matches the API bucket + the
 *  /follow-ups?bucket=\u2026 list filter, so each card opens exactly its own list. */
const FU_BUCKETS: Array<{ key: string; lab: string; ic: string }> = [
  { key: 'overdue', lab: 'Overdue', ic: 'clock' },
  { key: 'due_today', lab: 'Due Today', ic: 'clock' },
  { key: 'next7', lab: 'Next 7 Days', ic: 'cal' },
  { key: 'no_shows', lab: 'No-Shows', ic: 'bolt' },
  { key: 'done_today', lab: 'Done Today', ic: 'check' },
  { key: 'rescheduled', lab: 'Rescheduled', ic: 'cal' },
  { key: 'hot_leads', lab: 'Hot Leads', ic: 'leads' },
  { key: 'unreachable', lab: 'Unreachable', ic: 'bolt' },
];

/**
 * QUICK STATS — with the CUSTOM DATE RANGE the client asked for explicitly, now on the SHARED
 * DateRange control (daterange.tsx) so its presets match every other screen. Quick Stats is
 * inherently range-scoped, so it never shows "All time" (allowAllTime=false) and defaults to
 * This Month; the numbers are scoped exactly like the dashboard. The global scope narrows within.
 */
function QuickStats() {
  const { refreshTick, go } = useScreen();
  const { params: sp, key: scopeKey } = useScope();
  // both bounds always defined here (This Month by default); the quick-stats endpoint expects a range.
  const [range, setRange] = useState<{ from?: string; to?: string }>(() => presetRange('month'));
  const from = range.from ?? '';
  const to = range.to ?? '';
  const stats = useFetch<any>(withScope(`/dashboard/quick-stats?from=${from}&to=${to}`, sp), [from, to, refreshTick, scopeKey]);
  const s = stats.data;

  return (
    <>
      <div className="filters" style={{ marginBottom: 12, alignItems: 'center' }}>
        <DateRange value={range} onChange={setRange} allowAllTime={false} idPrefix="qs" />
      </div>

      <Kpis cols={4} items={[
        { lab: 'Leads', val: String(s?.leads ?? 0), ic: 'leads',
          onClick: () => go('leads', 'all', { created_from: range.from, created_to: range.to }),
          navLabel: `Leads: ${s?.leads ?? 0}. Open leads created in this range` },
        // Client UAT (Aug 2026): link EVERY card that has a sensible destination. Conversions ->
        // won Leads, Lost -> lost Leads (won/lost boolean filters on the Leads list, by current
        // stage_type). The Leads list filters by CREATED date, so pass the same range — the count
        // shown here (by WON/LOST activity date) may differ slightly from the filtered list.
        { lab: 'Conversions', val: String(s?.won ?? 0), ic: 'check',
          onClick: () => go('leads', 'all', { won: 1, created_from: range.from, created_to: range.to }),
          navLabel: `Conversions: ${s?.won ?? 0}. Open won Leads` },
        { lab: 'Lost', val: String(s?.lost ?? 0), ic: 'clock',
          onClick: () => go('leads', 'all', { lost: 1, created_from: range.from, created_to: range.to }),
          navLabel: `Lost: ${s?.lost ?? 0}. Open lost Leads` },
        // OBS-S16-05: named, not just 'Conversion rate' — the funnel report shows the
        // SAME number, and Counsellor Performance shows a different one. (Informational — no list.)
        { lab: CONVERSION_LABEL_LEAD_WON, val: s ? `${s.conversion_rate}%` : '—', ic: 'target' },
        { lab: 'Hot leads', val: String(s?.hot ?? 0), ic: 'bolt',
          onClick: () => go('leads', 'all', { temperature: 'hot', created_from: range.from, created_to: range.to }),
          navLabel: `Hot leads: ${s?.hot ?? 0}. Open Hot leads created in this range` },
        { lab: 'Duplicates', val: String(s?.duplicates ?? 0), ic: 'users',
          onClick: () => go('leads', 'all', { duplicate: 1, created_from: range.from, created_to: range.to }),
          navLabel: `Duplicates: ${s?.duplicates ?? 0}. Open duplicate leads created in this range` },
        // Follow-ups cards open the Follow-ups list. Done -> the Missed/completed view isn't a
        // list filter, so both land on the Follow-ups list (which now carries date + multi-select
        // filters, client UAT Aug 2026); scheduled seeds the "Next 7 Days" window.
        { lab: 'Follow-ups done', val: String(s?.followups_done ?? 0), ic: 'check',
          onClick: () => go('leads', 'followups', { fu_from: range.from, fu_to: range.to }),
          navLabel: `Follow-ups done: ${s?.followups_done ?? 0}. Open the Follow-ups list` },
        { lab: 'Follow-ups scheduled', val: String(s?.followups_scheduled ?? 0), ic: 'cal',
          onClick: () => go('leads', 'followups', { followup: 'next7' }),
          navLabel: `Follow-ups scheduled: ${s?.followups_scheduled ?? 0}. Open upcoming Follow-ups` },
      ]} />

      <TargetBars />
      <AssessmentDashboardCards />
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


/**
 * ASSESSMENTS on the dashboards (Batch D). A role-aware block: admin/faculty KPIs (assessments,
 * attempts, pass rate, average %, pending evaluations, certificates), a grade-distribution bar and
 * clickable stat cards that open the relevant Assessment lists. RBAC-scoped server-side, and the
 * whole block is hidden from anyone without assessment_attempt.read (no empty teaser).
 */
function AssessmentDashboardCards() {
  const { can } = useAuth();
  const { go } = useScreen();
  const admin = useFetch<any>(can('assessment_attempt.read') ? '/assessment-reports/admin' : null);
  const faculty = useFetch<any>(can('assessment_attempt.read') ? '/assessment-reports/faculty' : null);
  if (!can('assessment_attempt.read')) return null;
  const k = admin.data?.kpis; const fk = faculty.data?.kpis;
  const dist = admin.data?.grade_distribution ?? [];
  const max = Math.max(1, ...dist.map((d: any) => Number(d.n)));
  const bars = dist.map((d: any, i: number) => ({ label: d.grade, val: String(d.n), pct: (Number(d.n) * 100) / max, color: BAR_COLOURS[i % BAR_COLOURS.length] }));
  return (
    <div style={{ marginTop: 16 }}>
      <div className="filters" style={{ marginBottom: 12 }}>
        <span className="fchip on" style={{ cursor: 'default' }}><Ic k="doc" />Assessments</span>
      </div>
      <Kpis cols={6} items={[
        { lab: 'Tests / Exams', val: String(k?.assessments ?? 0), ic: 'doc',
          onClick: () => go('students', 'exams'), navLabel: `Tests: ${k?.assessments ?? 0}. Open Tests / Exams` },
        { lab: 'Attempts', val: String(k?.attempts ?? 0), ic: 'users',
          onClick: () => go('students', 'evaluation'), navLabel: `Attempts: ${k?.attempts ?? 0}. Open the Evaluation Queue` },
        { lab: 'Pass rate', val: k?.pass_rate != null ? `${k.pass_rate}%` : '—', ic: 'target',
          onClick: () => go('students', 'assessmentresults'), navLabel: 'Pass rate. Open Results' },
        { lab: 'Average %', val: k?.avg_pct != null ? `${k.avg_pct}%` : '—', ic: 'bolt',
          onClick: () => go('students', 'assessmentresults'), navLabel: 'Average score. Open Results' },
        { lab: 'Pending evaluation', val: String((fk?.pending_evaluations ?? 0) + (fk?.pending_submissions ?? 0)), ic: 'clock',
          onClick: () => go('students', 'evaluation'), navLabel: `Pending evaluations. Open the Evaluation Queue` },
        { lab: 'Certificates', val: String(k?.certificates_issued ?? 0), ic: 'shield',
          onClick: () => go('students', 'assessmentcerts'), navLabel: `Certificates issued. Open Certificates` },
      ]} />
      <div className="row2" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <HBars title="Grade distribution" rows={bars} empty="No evaluated attempts yet" />
        <TableCard title="Hardest questions (lowest accuracy)" icon="doc"
          cols={['Question', 'Type', 'Accuracy']}
          empty="No answered objective questions yet"
          rows={(admin.data?.hardest_questions ?? []).slice(0, 6).map((h: any): Cell[] => [
            { node: <span className="sub">{h.body}</span> },
            h.q_type,
            `${h.accuracy_pct}% (${h.correct}/${h.answered})`,
          ])} />
      </div>
    </div>
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

  // Client Aug 2026 (#1) — Quick Contact no longer shows the Campaign select + Contact Source
  // config block on the right. Instead we surface the chosen Branch › Vertical path and a
  // read-only Campaign overview (a summary of the campaign context, not config inputs).
  const branchName = ref.branches.find((b) => Number(b.id) === scope.branch)?.name;
  const verticalName = ref.verticals.find((v) => Number(v.id) === scope.vertical)?.name;
  const pipelineName = ref.pipelines.find((p) => Number(p.id) === scope.pipeline)?.name;
  const campaignName = ref.campaigns.find((c) => Number(c.id) === scope.campaign)?.name;

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
          {/* Client Aug 2026 — the "Custom Contact Property" columns (Training Mode / Category /
              Remarks / Course) were removed from Quick Contact; only the core contact fields
              stay here. Those attributes are captured on the full Add Lead form instead. */}
        </div>
        <div className="stack">
          {/* Client Aug 2026 (#1) — the Campaign select + Contact Source config block are removed.
              The right column now shows the chosen Branch › Vertical and a read-only Campaign
              overview (the campaign context summary, not config inputs). Campaign is still chosen
              in the Lead Details — Scope grid on the left, which drives this overview. */}
          <div className="card"><div className="card-head"><h3><Ic k="branch" />Branch › Vertical</h3></div>
            <div className="card-pad">
              {branchName ? (
                <div className="bvpath" data-testid="qc-bv-path" style={{ fontWeight: 600, fontSize: 15 }}>
                  {branchName}{verticalName ? <> <span style={{ opacity: .5 }}>›</span> {verticalName}</> : ''}
                </div>
              ) : (
                <div className="sub" data-testid="qc-bv-path">Select a Branch (and Vertical) in Lead Details — Scope.</div>
              )}
            </div></div>
          <div className="card"><div className="card-head"><h3><Ic k="bolt" />Campaign overview</h3></div>
            <div className="card-pad" data-testid="qc-campaign-overview">
              {scope.campaign ? (
                <table className="kv" style={{ width: '100%', fontSize: 13 }}><tbody>
                  <tr><td className="sub" style={{ paddingRight: 10 }}>Campaign</td><td style={{ fontWeight: 600 }}>{campaignName ?? '—'}</td></tr>
                  <tr><td className="sub" style={{ paddingRight: 10 }}>Pipeline</td><td>{pipelineName ?? '—'}</td></tr>
                  <tr><td className="sub" style={{ paddingRight: 10 }}>Vertical</td><td>{verticalName ?? '—'}</td></tr>
                  <tr><td className="sub" style={{ paddingRight: 10 }}>Branch</td><td>{branchName ?? '—'}</td></tr>
                </tbody></table>
              ) : (
                <div className="sub">Pick a Campaign in Lead Details — Scope to see its context summary here.</div>
              )}
            </div></div>
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginTop: 18 }}>
        <button className="btn primary" style={{ padding: '11px 44px' }} onClick={search} disabled={busy}>
          <Ic k="leads" />Search
        </button>
        {/* Client Aug 2026 — a prominent Add lead button on Quick Contact opens the full
            Add Lead flow directly (no need to search first). */}
        <button className="btn" data-testid="qc-add-lead" style={{ padding: '11px 44px' }} onClick={() => openAdd('dash.quickcontact')}>
          <Ic k="plus" />Add lead
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

/**
 * Aug 2026 — a KPI card opens the Leads list pre-filtered by carrying its filter in the URL
 * query (go('leads','all', {...})). LeadsAll seeds its filter state from those params ONCE on
 * mount. Read straight from window.location.search (not useSearchParams) so the component still
 * renders bare in unit tests, with no Router; an empty search yields exactly the old defaults.
 */
/**
 * Multi-select filter control (client, Aug 2026): every Leads-list filter now accepts MULTIPLE
 * values (OR within a filter; different filters still AND together). Reuses the SAME searchable
 * multi-select behind the campaign agent pool / user-access picker (UserPicker in generic
 * `options` mode) — no new control — with a small label and a constrained width so several sit
 * in the filter bar.
 */
export function FilterMulti({ label, icon, value, options, onChange, testid }: {
  label: string; icon: string; value: number[];
  options: Array<{ id: number | string; name: string }>;
  onChange: (ids: number[]) => void; testid?: string;
}) {
  const opts = useMemo(() => options.map((o) => ({ id: Number(o.id), name: o.name })), [options]);
  return (
    <div className="fmulti" data-testid={testid ?? `fm-${label.toLowerCase()}`}>
      <span className="fmulti-lbl"><Ic k={icon} />{label}</span>
      <UserPicker multiple value={value} onChange={onChange} options={opts} hideBranch
        placeholder={value.length ? '' : `All ${label.toLowerCase()}`} />
    </div>
  );
}

/* Multi-select STATUS filter for the students list — the 11 lifecycle codes (strings, so it
 * cannot reuse the numeric FilterMulti). A native <details> popover keeps it dependency-free. */
export function StatusMultiFilter({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const toggle = (code: string) => onChange(value.includes(code) ? value.filter((c) => c !== code) : [...value, code]);
  const label = value.length ? `${value.length} selected` : 'All statuses';
  return (
    <details className="fmulti" data-testid="fm-status" style={{ position: 'relative' }}>
      <summary className="fmulti-lbl" style={{ cursor: 'pointer', listStyle: 'none' }}><Ic k="check" />Status: {label}</summary>
      <div style={{ position: 'absolute', zIndex: 40, top: '100%', left: 0, marginTop: 6, minWidth: 200, maxHeight: 300, overflow: 'auto',
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 6, boxShadow: '0 8px 24px rgba(0,0,0,.18)' }}>
        {Object.entries(STUDENT_STATUS_META).map(([code, m]) => (
          <label key={code} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '5px 6px', fontSize: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={value.includes(code)} onChange={() => toggle(code)} data-testid={`fm-status-${code}`} />
            <span className={m.cls} style={{ padding: '1px 8px', borderRadius: 999 }}>{m.label}</span>
          </label>
        ))}
        {value.length ? <button className="btn ghost" style={{ width: '100%', marginTop: 4, fontSize: 12 }} onClick={() => onChange([])}>Clear</button> : null}
      </div>
    </details>
  );
}

/**
 * Multi-select for STRING-valued filters (status, type, sentiment, category, priority, action…)
 * (client, Aug 2026). FilterMulti/UserPicker are numeric-id only, so enum filters use this small
 * inline checkbox-chip control: click to toggle each value (OR within the filter; different
 * filters still AND). Renders with the SAME `.fmulti` wrapper so the list-audit test + styling
 * treat it as a multi-select filter control.
 */
export function EnumMulti({ label, icon, value, options, onChange, testid }: {
  label: string; icon: string; value: string[];
  options: Array<{ id: string; name: string }>;
  onChange: (vals: string[]) => void; testid?: string;
}) {
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <div className="fmulti fmulti-enum" data-testid={testid ?? `fm-${label.toLowerCase()}`}>
      <span className="fmulti-lbl"><Ic k={icon} />{label}</span>
      <div className="enum-chips" role="group" aria-label={label}>
        {options.map((o) => (
          <button key={o.id} type="button" aria-pressed={value.includes(o.id)}
            className={`enum-chip${value.includes(o.id) ? ' on' : ''}`} onClick={() => toggle(o.id)}>
            {o.name}
          </button>
        ))}
      </div>
    </div>
  );
}

function readLeadNavFilters(search?: string) {
  const sp = new URLSearchParams(typeof search === 'string' ? search : (typeof window !== 'undefined' ? window.location.search : ''));
  const b = (key: string) => sp.get(key) === '1' || sp.get(key) === 'true';
  // Multi-select: read the *_ids arrays (CSV or repeated keys) AND fold in any singular id (a KPI
  // card / top-bar shortcut still passes the singular, e.g. owner_id) — back-compat.
  const nums = (arrKey: string, singleKey: string) => {
    const out = new Set<number>();
    for (const raw of sp.getAll(arrKey)) for (const p of String(raw).split(',')) { const v = Number(p.trim()); if (Number.isFinite(v) && v > 0) out.add(v); }
    const one = Number(sp.get(singleKey)); if (Number.isFinite(one) && one > 0) out.add(one);
    return [...out];
  };
  const bands = () => {
    const out = new Set<string>();
    for (const raw of sp.getAll('bands')) for (const p of String(raw).split(',')) { const t = p.trim(); if (t === 'hot' || t === 'warm' || t === 'cold') out.add(t); }
    const t = sp.get('temperature'); if (t === 'hot' || t === 'warm' || t === 'cold') out.add(t);
    return [...out];
  };
  return {
    branches: nums('branch_ids', 'branch_id'), verticals: nums('vertical_ids', 'vertical_id'),
    pipelines: nums('pipeline_ids', 'pipeline_id'), campaigns: nums('campaign_ids', 'campaign_id'),
    sources: nums('source_ids', 'source_id'), statuses: nums('status_ids', 'status_id'),
    stages: nums('stage_ids', 'stage_id'),
    owners: nums('owner_ids', 'owner_id'), bands: bands(),
    from: sp.get('created_from') || undefined, to: sp.get('created_to') || undefined,
    followup: sp.get('followup') || undefined, fu_from: sp.get('fu_from') || undefined, fu_to: sp.get('fu_to') || undefined,
    sla: b('sla_breached'), dup: b('duplicate'), redflag: b('red_flagged'), won: b('won'), lost: b('lost'), unassigned: b('unassigned'),
    sort: sp.get('sort') || 'recent', q: sp.get('q') || '',
  };
}

function LeadsAll() {
  const { openLead, refreshTick, bump, search } = useScreen();
  const { can } = useAuth();
  // GLOBAL SCOPE seeds the hierarchy filters as a baseline; an explicit URL filter (a KPI card
  // link) still wins, and the user can narrow further with the in-panel chips. The component
  // remounts when the global scope changes (Shell keys Screen by the scope), so it re-seeds.
  const { scope: gScope } = useScope();
  // Seed the full filter set from the URL (a KPI card / top-bar shortcut), then fall back to the
  // global scope for any hierarchy level the URL does not pin. Reused on mount AND on in-app re-nav.
  const seedLeadFilters = (s?: string) => {
    const base = readLeadNavFilters(s);
    // Global scope is the BASELINE for any hierarchy level the URL does not pin; an explicit URL
    // filter (a KPI card link) still wins. Each level can now hold MULTIPLE selections.
    return {
      ...base,
      branches: base.branches.length ? base.branches : (gScope.branches),
      verticals: base.verticals.length ? base.verticals : (gScope.verticals),
      pipelines: base.pipelines.length ? base.pipelines : (gScope.pipelines),
      campaigns: base.campaigns.length ? base.campaigns : (gScope.campaigns),
    };
  };
  const canEditLead = can('lead.update');
  const canDeleteLead = can('lead.delete');
  const ref = useRef_();
  const [f, setF] = useState<{
    // Multi-select (client, Aug 2026): each hierarchy / owner / status / band filter holds an
    // ARRAY of selections (OR within the filter). The hierarchy dropdowns still cascade
    // Branch › Vertical › Pipeline › Campaign › Source, but each level can hold many values.
    branches: number[]; verticals: number[]; pipelines: number[]; campaigns: number[];
    sources: number[]; statuses: number[]; stages: number[]; owners: number[]; bands: string[];
    from?: string; to?: string;
    // Sprint 3 — SLA breaches are their own filter.
    sla?: boolean;
    // Follow-up date filter (client #3).
    followup?: string; fu_from?: string; fu_to?: string;
    // Client change (Jul 2026) — Duplicates; Aug 2026 dashboard card links — won / unassigned.
    dup?: boolean; won?: boolean; lost?: boolean; unassigned?: boolean;
    // Red flag filter (client, Aug 2026).
    redflag?: boolean;
    sort: string; q: string;
  }>(() => seedLeadFilters(search));
  // DEF-05 — a top-bar shortcut / card link (e.g. New Leads = created today) re-navigating to the
  // Leads list while it is ALREADY open changes the query but does not remount the screen; re-seed
  // the filter from the new query so the shortcut takes effect. Manual chip edits never touch the
  // URL, so they are preserved.
  useReseedOnSearch(search, (s) => setF(seedLeadFilters(s)));
  // Pagination (client Aug 2026): the Leads list pages server-side (50/page) with prev/next +
  // numbered pages and a "Showing X\u2013Y of N" count. Filters/scope/sort/date-range carry across
  // pages; changing any filter returns to page 1 (see the filterKey effect below).
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(0);
  const params = new URLSearchParams();
  // Multi-select -> CSV array params (owner_ids, status_ids, branch_ids, ...). OR within a filter,
  // AND across filters; the API also still accepts the old singular params for card links.
  const setCsv = (key: string, arr: number[]) => { if (arr.length) params.set(key, arr.join(',')); };
  setCsv('branch_ids', f.branches);
  setCsv('vertical_ids', f.verticals);
  setCsv('pipeline_ids', f.pipelines);
  setCsv('campaign_ids', f.campaigns);
  setCsv('source_ids', f.sources);
  setCsv('status_ids', f.statuses);
  setCsv('stage_ids', f.stages);
  setCsv('owner_ids', f.owners);
  if (f.bands.length) params.set('bands', f.bands.join(','));
  if (f.from) params.set('created_from', f.from);
  if (f.to) params.set('created_to', f.to);
  if (f.followup) params.set('followup', f.followup);
  if (f.fu_from) params.set('fu_from', f.fu_from);
  if (f.fu_to) params.set('fu_to', f.fu_to);
  if (f.sla) params.set('sla_breached', '1');
  if (f.dup) params.set('duplicate', '1');
  if (f.redflag) params.set('red_flagged', '1');
  if (f.won) params.set('won', '1');
  if (f.lost) params.set('lost', '1');
  if (f.unassigned) params.set('unassigned', '1');
  if (f.sort && f.sort !== 'recent') params.set('sort', f.sort);
  if (f.q.trim()) params.set('q', f.q.trim());
  // The filter signature WITHOUT paging — a change here resets to page 1; paging alone does not.
  const filterKey = params.toString();
  params.set('limit', String(PAGE_SIZE));
  params.set('offset', String(page * PAGE_SIZE));
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

  // Bulk actions (Jul 2026) — multi-select in the Classic list + a bulk-action toolbar.
  const canTransfer = can('lead.transfer');
  const canAssign = can('lead.assign');
  const canFlag = can('lead.flag');
  const [flagLead, setFlagLead] = useState<{ id: number; name?: string; flagged?: boolean } | null>(null);
  const canConvert = can('student.create');
  const [convertLead, setConvertLead] = useState<{ id: number; name?: string } | null>(null);
  const [journeyStud, setJourneyStud] = useState<{ id: number; full_name?: string } | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [bulk, setBulk] = useState<null | 'transfer' | 'reassign' | 'pause' | 'resume' | 'delete' | 'convert'>(null);
  const [transferLead, setTransferLead] = useState<{ id: number; name?: string } | null>(null);
  const [selCap, setSelCap] = useState<number | null>(null);
  // changing the filter (or a refresh) clears the selection — it can no longer be trusted to
  // still match what the user sees.
  useEffect(() => { setSel(new Set()); setSelCap(null); }, [params.toString(), refreshTick]);
  // A filter / scope / sort / date-range change (NOT a page change) returns to the first page.
  useEffect(() => { setPage(0); }, [filterKey, refreshTick]);
  const toggleOne = (id: number) => setSel((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allLoadedSelected = rows.length > 0 && rows.every((r: any) => sel.has(Number(r.id)));
  const toggleAllLoaded = () => setSel((p) => {
    if (rows.every((r: any) => p.has(Number(r.id))) && rows.length) return new Set<number>();
    const n = new Set(p); for (const r of rows) n.add(Number(r.id)); return n;
  });
  const selectAllMatching = async () => {
    try {
      const q = new URLSearchParams(params); q.delete('limit'); q.delete('offset');
      const r = await api.get<{ ids: number[]; total: number; capped: boolean }>(`/leads/select-ids?${q.toString()}`);
      setSel(new Set(r.ids)); setSelCap(r.capped ? r.ids.length : null);
    } catch (e: any) { toast(e.message, true); }
  };
  const selectedIds = [...sel];
  const clearSel = () => { setSel(new Set()); setSelCap(null); };

  // Multi-select cascade (client, Aug 2026): each level's options are limited to children of ANY
  // selected parent (branches -> verticals under any selected branch, and so on). When a parent
  // selection changes, descendant selections that fall out of scope are pruned.
  const vOpts = ref.verticals.filter((v) => !f.branches.length || f.branches.includes(Number(v.branch_id)));
  const pOpts = ref.pipelines.filter((pp) => !f.verticals.length || f.verticals.includes(Number(pp.vertical_id)));
  const cOpts = ref.campaigns.filter((c) => !f.pipelines.length || f.pipelines.includes(Number(c.pipeline_id)));
  const sOpts = ref.sources.filter((so) => !f.campaigns.length || f.campaigns.includes(Number(so.campaign_id)));
  // Stage (client, Aug 2026): a lead's stage belongs to a pipeline, so offer only the stages
  // of the selected Pipeline(s) (all stages when no pipeline is picked). Same-named stages
  // across pipelines are disambiguated with the pipeline name when >1 pipeline is in view.
  const stOpts = (ref.stages ?? [])
    .filter((st: any) => !f.pipelines.length || f.pipelines.includes(Number(st.pipeline_id)))
    .map((st: any) => ({ id: Number(st.id), name: f.pipelines.length === 1 ? st.name : `${st.name} \u00b7 ${st.pipeline_name}` }));
  const pruneHierarchy = (nf: typeof f): typeof f => {
    const vOk = new Set(ref.verticals.filter((v) => !nf.branches.length || nf.branches.includes(Number(v.branch_id))).map((v) => Number(v.id)));
    nf.verticals = nf.verticals.filter((id) => vOk.has(id));
    const pOk = new Set(ref.pipelines.filter((pp) => !nf.verticals.length || nf.verticals.includes(Number(pp.vertical_id))).map((pp) => Number(pp.id)));
    nf.pipelines = nf.pipelines.filter((id) => pOk.has(id));
    const cOk = new Set(ref.campaigns.filter((c) => !nf.pipelines.length || nf.pipelines.includes(Number(c.pipeline_id))).map((c) => Number(c.id)));
    nf.campaigns = nf.campaigns.filter((id) => cOk.has(id));
    const sOk = new Set(ref.sources.filter((so) => !nf.campaigns.length || nf.campaigns.includes(Number(so.campaign_id))).map((so) => Number(so.id)));
    nf.sources = nf.sources.filter((id) => sOk.has(id));
    const stOk = new Set(((ref.stages ?? []) as any[]).filter((st) => !nf.pipelines.length || nf.pipelines.includes(Number(st.pipeline_id))).map((st) => Number(st.id)));
    nf.stages = nf.stages.filter((id) => stOk.has(id));
    return nf;
  };

  const BANDS: Array<[string, string | undefined]> = [['All', undefined], ['Hot', 'hot'], ['Warm', 'warm'], ['Cold', 'cold']];
  const bandDot: Record<string, string> = { hot: 'var(--hot)', warm: 'var(--warm)', cold: 'var(--cold)' };
  return (
    <>
      {/* UAT-R2 #11 — SaaS-style quick band chips (drive the same temperature filter). */}
      <div className="qband">
        {BANDS.map(([lab, val]) => {
          const on = val ? f.bands.includes(val) : f.bands.length === 0;
          return (
            <button key={lab} type="button"
              className={`qb${on ? ` on ${val ?? ''}` : ''}`}
              onClick={() => setF((x) => ({ ...x, bands: val ? (x.bands.includes(val) ? x.bands.filter((z) => z !== val) : [...x.bands, val]) : [] }))}>
              {val ? <span className="d" style={{ background: bandDot[val] }} /> : null}{lab}
            </button>
          );
        })}
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
        <FilterMulti label="Branch" icon="branch" value={f.branches} options={ref.branches}
          onChange={(v) => setF((x) => pruneHierarchy({ ...x, branches: v }))} />
        <FilterMulti label="Vertical" icon="grid" value={f.verticals} options={vOpts}
          onChange={(v) => setF((x) => pruneHierarchy({ ...x, verticals: v }))} />
        <FilterMulti label="Pipeline" icon="list" value={f.pipelines} options={pOpts}
          onChange={(v) => setF((x) => pruneHierarchy({ ...x, pipelines: v }))} />
        <FilterMulti label="Campaign" icon="bolt" value={f.campaigns} options={cOpts}
          onChange={(v) => setF((x) => pruneHierarchy({ ...x, campaigns: v }))} />
        <FilterMulti label="Source" icon="leads" value={f.sources} options={sOpts}
          onChange={(v) => setF((x) => ({ ...x, sources: v }))} />
        <FilterMulti label="Status" icon="check" value={f.statuses} options={ref.statuses}
          onChange={(v) => setF((x) => ({ ...x, statuses: v }))} />
        {/* Pipeline STAGE (client, Aug 2026): the stage the lead currently sits in, narrowed
            to the selected Pipeline(s). Multi-select, ANDed with the other filters. */}
        <FilterMulti label="Stage" icon="list" value={f.stages} options={stOpts}
          onChange={(v) => setF((x) => ({ ...x, stages: v }))} />
        <FilterMulti label="Lead Counsellor" testid="fm-owner" icon="users" value={f.owners} options={selectableUsers(ref.users)}
          onChange={(v) => setF((x) => ({ ...x, owners: v }))} />
        {/* SHARED date-range control — filters the list by lead CREATED date (created_from/
            created_to). Default = All time so the list never hides existing leads. */}
        <DateRange value={{ from: f.from, to: f.to }} idPrefix="leads-dr"
          onChange={(v) => setF((x) => ({ ...x, from: v.from, to: v.to }))} />
        {/* Follow-up date filter (client #3): "next follow-up" as a lead attribute (No Followup /
            Missed / Today / Tomorrow / Next 7 / Next 30 / Custom), evaluated over the lead's
            pending follow-ups in IST — same windows as the follow-ups list. */}
        <FollowupFilter value={{ followup: f.followup, fu_from: f.fu_from, fu_to: f.fu_to }}
          onChange={(v) => setF((x) => ({ ...x, followup: v.followup, fu_from: v.fu_from, fu_to: v.fu_to }))}
          idPrefix="leads-fu" />
        <div className="fchip"><Ic k="search" /><input style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }} placeholder="Search name / phone / email…" value={f.q} onChange={(e) => setF((x) => ({ ...x, q: e.target.value }))} /></div>
        {/* Score BAND is multi-select via the Hot/Warm/Cold quick chips above (f.bands). */}
        {/* ...and SORTABLE. */}
        <div className="fchip" data-testid="sort-control">
          <Ic k="analytics" />Sort
          <select aria-label="Sort leads" value={f.sort}
            onChange={(e) => setF((x) => ({ ...x, sort: e.target.value }))}>
            <option value="recent">Newest first</option>
            <option value="score">Score: high to low</option>
            <option value="score_asc">Score: low to high</option>
            <option value="followup">Next follow-up</option>
            <option value="status">Status (A–Z)</option>
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
        {/* Red flag filter (client, Aug 2026) — leads currently red-flagged. */}
        <button className={`fchip${f.redflag ? ' on' : ''}`} data-testid="redflag-filter"
          onClick={() => setF((x) => ({ ...x, redflag: !x.redflag }))}
          style={f.redflag ? { color: 'var(--red)', borderColor: 'var(--red)' } : undefined}>
          <Ic k="flag" />Red flagged
        </button>
      </div>
      </div>
      {/* Bulk-action toolbar — appears when one or more leads are selected (Classic view). */}
      {sel.size > 0 && (
        <div className="card" data-testid="bulk-bar" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', marginBottom: 10, flexWrap: 'wrap' }}>
          <b>{sel.size} selected</b>
          {allLoadedSelected && (data.data?.total ?? 0) > rows.length && selCap == null && (
            <button className="fchip" onClick={selectAllMatching}>Select all {data.data?.total} matching</button>
          )}
          {selCap != null && <span className="empty-note" style={{ fontSize: 12 }}>All {selCap} matching selected (max {2000}).</span>}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {canTransfer && <button className="btn" onClick={() => setBulk('transfer')}><Ic k="swap" />Transfer</button>}
            {canAssign && <button className="btn" onClick={() => setBulk('reassign')}><Ic k="users" />Reassign</button>}
            {canEditLead && <button className="btn" onClick={() => setBulk('pause')}><Ic k="clock" />Pause</button>}
            {canEditLead && <button className="btn" onClick={() => setBulk('resume')}><Ic k="check" />Resume</button>}
            {canConvert && <button className="btn" data-testid="bulk-convert" onClick={() => setBulk('convert')}><Ic k="students" />Convert to students</button>}
            {canDeleteLead && <button className="btn" data-testid="bulk-delete" onClick={() => setBulk('delete')}
              style={{ background: 'var(--danger)', borderColor: 'var(--danger)', color: '#fff' }}><Ic k="trash" />Delete</button>}
            <button className="btn" onClick={clearSel}>Clear</button>
          </div>
        </div>
      )}
      {/* Classic view — the traditional dense data table (default), untouched from Batch E. */}
      {view === 'classic' && (
        <TableCard title="Leads" more={<span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
            <span className="sub" style={{ fontSize: 12 }}>{data.data?.total ?? 0} in scope</span>
            <ListActions onExport={() => exportLeads(params.toString())} onRefresh={() => data.reload()} />
          </span>} cols={[...LEAD_COLS, 'Actions']} sticky fill
          select={{
            checked: (i) => sel.has(Number(rows[i].id)),
            onToggle: (i) => toggleOne(Number(rows[i].id)),
            allChecked: allLoadedSelected,
            onToggleAll: toggleAllLoaded,
          }}
          rows={rows.map((l) => [...leadRow(l), rowActions({
            onView: () => openLead(Number(l.id), 'view'),
            onEdit: canEditLead ? () => openLead(Number(l.id), 'edit') : undefined,
            onDelete: canDeleteLead ? () => del.openDelete(Number(l.id), l.full_name) : undefined,
            extra: [
              ...(canTransfer ? [{ k: 'swap', title: 'Transfer', onClick: () => setTransferLead({ id: Number(l.id), name: l.full_name }) }] : []),
              ...(canFlag ? [{ k: 'flag', title: l.is_red_flagged ? 'Red flagged \u2014 add remark' : 'Red flag', onClick: () => setFlagLead({ id: Number(l.id), name: l.full_name, flagged: !!l.is_red_flagged }) }] : []),
              ...(canConvert ? [{ k: 'students', title: 'Convert to Student', onClick: () => setConvertLead({ id: Number(l.id), name: l.full_name }) }] : []),
            ],
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
      {(data.data?.total ?? 0) > 0 && (
        <LeadsPager page={page} pageSize={PAGE_SIZE} total={data.data?.total ?? 0}
          shown={rows.length} loading={data.loading} onPage={setPage} />
      )}
      {transferLead && <LeadTransferModal leadId={transferLead.id} leadName={transferLead.name}
        onDone={bump} onClose={() => setTransferLead(null)} />}
      {flagLead && <RedFlagModal leadId={flagLead.id} leadName={flagLead.name} flagged={flagLead.flagged}
        onDone={() => { setFlagLead(null); bump(); }} onClose={() => setFlagLead(null)} />}
      {convertLead && <ConvertStudentModal leadId={convertLead.id} leadName={convertLead.name}
        onDone={bump} onClose={() => setConvertLead(null)}
        onOpenJourney={(id, _no, name) => setJourneyStud({ id, full_name: name })} />}
      {journeyStud && <StudentDetailModal student={journeyStud} initialTab="admission"
        onClose={() => setJourneyStud(null)} onChanged={bump} />}
      {bulk === 'transfer' && <BulkTransferModal ids={selectedIds} onClose={() => setBulk(null)} onDone={() => { clearSel(); bump(); }} />}
      {bulk === 'reassign' && <BulkReassignModal ids={selectedIds} onClose={() => setBulk(null)} onDone={() => { clearSel(); bump(); }} />}
      {(bulk === 'pause' || bulk === 'resume') && <BulkPauseModal ids={selectedIds} action={bulk} onClose={() => setBulk(null)} onDone={() => { clearSel(); bump(); }} />}
      {bulk === 'convert' && <BulkConvertStudentsModal ids={selectedIds} onClose={() => setBulk(null)} onDone={() => { clearSel(); bump(); }} />}
      {bulk === 'delete' && <BulkDeleteModal entityLabel="Lead" ids={selectedIds} idKey="lead_ids"
        impactPath="/leads/bulk/delete-impact" deletePath="/leads/bulk/delete"
        onClose={() => setBulk(null)} onDone={() => { clearSel(); bump(); }} />}
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
  openLead: (id: number, mode?: 'view' | 'edit') => void;
  canEditLead: boolean;
  canDeleteLead: boolean;
  del: { openDelete: (id: number, name: string) => void };
};

const stageBadgeClass = (t?: string) => (t === 'won' ? 'b-green' : t === 'lost' ? 'b-rose' : 'b-cyan');

function LeadsPager({ page, pageSize, total, shown, onPage, loading }:
  { page: number; pageSize: number; total: number; shown: number; onPage: (p: number) => void; loading?: boolean }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = page * pageSize + shown;
  const lo = Math.max(0, page - 2), hi = Math.min(pages - 1, page + 2);
  const win: number[] = [];
  for (let i = lo; i <= hi; i++) win.push(i);
  return (
    <div className="card" data-testid="leads-pager"
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', flexWrap: 'wrap' }}>
      <span className="sub" style={{ fontSize: 12 }} data-testid="pg-range">
        Showing <b>{from}</b>{'\u2013'}<b>{to}</b> of <b>{total}</b> lead{total === 1 ? '' : 's'}
      </span>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn" data-testid="pg-prev" disabled={page <= 0 || loading} onClick={() => onPage(page - 1)}>
          <Ic k="chev" />Prev</button>
        {lo > 0 && (<><button className="fchip" onClick={() => onPage(0)}>1</button><span className="sub">{'\u2026'}</span></>)}
        {win.map((p) => (
          <button key={p} className={`fchip${p === page ? ' on' : ''}`} data-testid={`pg-${p + 1}`}
            aria-current={p === page ? 'page' : undefined} onClick={() => onPage(p)}>{p + 1}</button>
        ))}
        {hi < pages - 1 && (<><span className="sub">{'\u2026'}</span><button className="fchip" onClick={() => onPage(pages - 1)}>{pages}</button></>)}
        <button className="btn" data-testid="pg-next" disabled={page >= pages - 1 || loading} onClick={() => onPage(page + 1)}>
          Next<Ic k="chev" /></button>
      </div>
    </div>
  );
}

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
                <button className="ract" title="View" onClick={() => openLead(Number(l.id), 'view')}><Ic k="eye" w={2.1} /></button>
                {canEditLead && <button className="ract" title="Edit" onClick={() => openLead(Number(l.id), 'edit')}><Ic k="pencil" w={2.1} /></button>}
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
          <button className="btn primary" onClick={() => openLead(Number(lead.id), 'view')}><Ic k="eye" />Open full</button>
          {canEditLead && <button className="btn" onClick={() => openLead(Number(lead.id), 'edit')}><Ic k="pencil" />Edit</button>}
          {canDeleteLead && <button className="btn" style={{ color: 'var(--danger)' }} onClick={() => del.openDelete(Number(lead.id), lead.full_name)}><Ic k="trash" />Delete</button>}
        </div>
      </div>
      <div className="lv-inbox-dbody">
        <div className="sheet-sec">
          <h5>Details</h5>
          <KV rows={[
            ['Course', lead.course_name || '—'],
            ['Lead Counsellor', lead.owner_name || 'Unassigned'],
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
  const { openLead, refreshTick, bump, search } = useScreen();
  const { can } = useAuth();
  const ref = useRef_();
  const { scope: gScope, params: sp, key: scopeKey } = useScope();
  const canEdit = can('followup.update');
  const canDelete = can('followup.delete');
  const del = useDelete('Follow-up', '/follow-ups', () => bump());

  // FULL multi-select filter treatment (client UAT, Aug 2026) — the Follow-ups list now gets the
  // same filters as the Leads list: Branch › Vertical › Pipeline › Campaign (strict cascade,
  // seeded from the global top-bar scope), Owner, Follow-up Type, Disposition, Priority, Status,
  // a date range on the DUE date, and the follow-up preset window. OR within each filter, AND
  // across. The array params are ANDed on top of the RBAC scope on the server.
  const [f, setF] = useState(() => {
    const u = new URLSearchParams(typeof search === 'string' ? search : (typeof window !== 'undefined' ? window.location.search : ''));
    return {
      branches: gScope.branches, verticals: gScope.verticals, pipelines: gScope.pipelines, campaigns: gScope.campaigns,
      owners: [] as number[], types: [] as number[], dispositions: [] as number[],
      priorities: [] as string[], statuses: [] as string[],
      from: u.get('from') || undefined as string | undefined, to: u.get('to') || undefined as string | undefined,
      followup: u.get('followup') || undefined as string | undefined,
      fu_from: u.get('fu_from') || undefined as string | undefined, fu_to: u.get('fu_to') || undefined as string | undefined,
    };
  });
  // Cascade prune of the hierarchy selections when a parent changes.
  const setHier = (patch: Partial<typeof f>) => setF((x) => {
    const nf = { ...x, ...patch };
    const vOk = new Set(ref.verticals.filter((v) => !nf.branches.length || nf.branches.includes(Number((v as any).branch_id))).map((v) => Number(v.id)));
    nf.verticals = nf.verticals.filter((id) => vOk.has(id));
    const pOk = new Set(ref.pipelines.filter((pp) => !nf.verticals.length || nf.verticals.includes(Number((pp as any).vertical_id))).map((pp) => Number(pp.id)));
    nf.pipelines = nf.pipelines.filter((id) => pOk.has(id));
    const cOk = new Set(ref.campaigns.filter((c) => !nf.pipelines.length || nf.pipelines.includes(Number((c as any).pipeline_id))).map((c) => Number(c.id)));
    nf.campaigns = nf.campaigns.filter((id) => cOk.has(id));
    return nf;
  });
  const vOpts = ref.verticals.filter((v) => !f.branches.length || f.branches.includes(Number((v as any).branch_id)));
  const pOpts = ref.pipelines.filter((pp) => !f.verticals.length || f.verticals.includes(Number((pp as any).vertical_id)));
  const cOpts = ref.campaigns.filter((c) => !f.pipelines.length || f.pipelines.includes(Number((c as any).pipeline_id)));

  const q = new URLSearchParams({ limit: '200' });
  const csv = (k: string, v: number[]) => { if (v.length) q.set(k, v.join(',')); };
  csv('branch_ids', f.branches); csv('vertical_ids', f.verticals); csv('pipeline_ids', f.pipelines);
  csv('campaign_ids', f.campaigns); csv('owner_ids', f.owners); csv('type_ids', f.types); csv('disposition_ids', f.dispositions);
  if (f.priorities.length) q.set('priorities', f.priorities.join(','));
  if (f.statuses.length) q.set('statuses', f.statuses.join(','));
  if (f.from) q.set('from', f.from);
  if (f.to) q.set('to', f.to);
  if (f.followup) q.set('followup', f.followup);
  if (f.fu_from) q.set('fu_from', f.fu_from);
  if (f.fu_to) q.set('fu_to', f.fu_to);
  const fKey = q.toString();

  const sum = useFetch<any>('/follow-ups/summary', [refreshTick]);
  const list = useFetch<any[]>(withScope(`/follow-ups?${fKey}`, sp), [fKey, refreshTick, scopeKey]);
  const rows = (list.data ?? []).map((fx) => ({ leadId: fx.lead_id, id: Number(fx.id), name: `${fx.lead_name}${fx.lead_deleted ? ' (deleted)' : ''} · ${fmtDT(fx.scheduled_at)}`, row: [
    { node: <span className="nm">{dn(fx.lead_name, fx.lead_deleted)}</span> } as Cell,
    { b: [fx.type_name || 'Follow-up', fx.type_name === 'WhatsApp' ? 'b-green' : 'b-indigo'] } as Cell,
    { node: <PrioSelect id={Number(fx.id)} value={fx.priority} onChanged={bump} disabled={!canEdit} /> } as Cell,
    fx.owner_name || '—',
    { node: <span className="mono" style={fx.status === 'pending' && new Date(fx.scheduled_at) < new Date() ? { color: 'var(--danger)' } : undefined}>{fmtDT(fx.scheduled_at)}</span> } as Cell,
    { b: [fx.status === 'done' ? 'Done' : fx.status === 'cancelled' ? 'Cancelled' : (fx.status === 'pending' && new Date(fx.scheduled_at) < new Date() ? 'Missed' : 'Pending'),
        fx.status === 'done' ? 'b-green' : fx.status === 'cancelled' ? 'b-gray' : (fx.status === 'pending' && new Date(fx.scheduled_at) < new Date() ? 'b-rose' : 'b-indigo')] } as Cell,
    fx.disposition_name || (fx.status === 'done' ? 'Done' : '—'),
  ] }));
  const PRIOS = [{ id: 'high', name: 'High' }, { id: 'medium', name: 'Medium' }, { id: 'low', name: 'Low' }];
  const STATUSES = [{ id: 'pending', name: 'Pending' }, { id: 'done', name: 'Done' }, { id: 'missed', name: 'Missed' }, { id: 'cancelled', name: 'Cancelled' }];
  return (
    <>
      <Kpis items={[
        { lab: 'Due today', val: String(sum.data?.due_today ?? '0'), ic: 'clock' },
        { lab: 'Overdue', val: String(sum.data?.overdue ?? '0'), ic: 'clock', tone: sum.data?.overdue > 0 ? 'down' : 'flat' },
        { lab: 'This week', val: String(sum.data?.this_week ?? '0'), ic: 'cal' },
        { lab: 'Done (wk)', val: String(sum.data?.done_week ?? '0'), ic: 'check' },
      ]} />
      <div className="filters" style={{ flexWrap: 'wrap', gap: 8 }}>
        <FilterMulti label="Branch" icon="branch" value={f.branches} options={ref.branches}
          onChange={(v) => setHier({ branches: v })} />
        <FilterMulti label="Vertical" icon="grid" value={f.verticals} options={vOpts}
          onChange={(v) => setHier({ verticals: v })} />
        <FilterMulti label="Pipeline" icon="list" value={f.pipelines} options={pOpts}
          onChange={(v) => setHier({ pipelines: v })} />
        <FilterMulti label="Campaign" icon="bolt" value={f.campaigns} options={cOpts}
          onChange={(v) => setHier({ campaigns: v })} />
        <FilterMulti label="Lead Counsellor" testid="fm-owner" icon="users" value={f.owners} options={selectableUsers(ref.users)}
          onChange={(v) => setF((x) => ({ ...x, owners: v }))} />
        <FilterMulti label="Type" icon="cal" value={f.types} options={ref.followupTypes}
          onChange={(v) => setF((x) => ({ ...x, types: v }))} />
        <FilterMulti label="Disposition" icon="check" value={f.dispositions} options={ref.dispositions}
          onChange={(v) => setF((x) => ({ ...x, dispositions: v }))} />
        <EnumMulti label="Priority" icon="bolt" value={f.priorities} options={PRIOS}
          onChange={(v) => setF((x) => ({ ...x, priorities: v }))} />
        <EnumMulti label="Status" icon="check" value={f.statuses} options={STATUSES}
          onChange={(v) => setF((x) => ({ ...x, statuses: v }))} />
        <DateRange value={{ from: f.from, to: f.to }} idPrefix="fu-dr"
          onChange={(v) => setF((x) => ({ ...x, from: v.from, to: v.to }))} />
        {/* Client Aug 2026 — the Follow-up preset filter is now a single ROW OF BUTTONS
            (segmented toggle group) instead of a dropdown; same emitted params + logic. */}
        <FollowupFilter value={{ followup: f.followup, fu_from: f.fu_from, fu_to: f.fu_to }} allowNoFollowup={false}
          variant="buttons"
          onChange={(v) => setF((x) => ({ ...x, followup: v.followup, fu_from: v.fu_from, fu_to: v.fu_to }))}
          idPrefix="fu-preset" />
      </div>
      <TableCard fill title="Follow-ups" more={<ListActions onExport={() => downloadObjectsCsv('follow-ups.csv', list.data ?? [])} onRefresh={() => list.reload()} />} cols={['Lead', 'Type', 'Priority', 'Lead Counsellor', 'Due', 'Status', 'Disposition', 'Actions']}
        rows={rows.map((r) => [...r.row, rowActions({
          onView: () => openLead(r.leadId),
          onDelete: canDelete ? () => del.openDelete(r.id, r.name) : undefined,
        })])}
        empty="No follow-ups match these filters"
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
  const { scope: gScope, params: sp, key: scopeKey } = useScope();
  const [inc, setInc] = useState(false);
  // In-panel multi-select filters (client, Aug 2026) — Branch › Vertical › Pipeline › Campaign,
  // seeded from the global scope, ANDed on top of it + RBAC.
  const [fBranches, setFBranches] = useState<number[]>(gScope.branches);
  const [fVerticals, setFVerticals] = useState<number[]>(gScope.verticals);
  const [fPipelines, setFPipelines] = useState<number[]>(gScope.pipelines);
  const [fCampaigns, setFCampaigns] = useState<number[]>(gScope.campaigns);
  const sqs = new URLSearchParams();
  if (inc) sqs.set('include_inactive', '1');
  if (fBranches.length) sqs.set('branch_ids', fBranches.join(','));
  if (fVerticals.length) sqs.set('vertical_ids', fVerticals.join(','));
  if (fPipelines.length) sqs.set('pipeline_ids', fPipelines.join(','));
  if (fCampaigns.length) sqs.set('campaign_ids', fCampaigns.join(','));
  const list = useFetch<any[]>(withScope(`/sources${sqs.toString() ? `?${sqs}` : ''}`, sp), [refreshTick, scopeKey, sqs.toString()]);
  const rows = list.data ?? [];
  const [view, setView] = useState<any | null>(null);
  const [edit, setEdit] = useState<any | null>(null);
  const canEdit = can('source.update');
  const del = useDelete('Source', '/sources', () => { list.reload(); ref.reload(); bump(); });
  const _bdIds = (list.data ?? []).map((r: any) => Number(r.id));
  const _bdSel = useTableSelect(_bdIds);
  const _bd = useBulkDelete('Source', '/sources/bulk-delete/impact', '/sources/bulk-delete', () => { list.reload(); _bdSel.clear(); });
  const after = () => { list.reload(); ref.reload(); bump(); };
  const CAPTURE: Record<string, [string, string]> = {
    meta: ['Auto \u00b7 webhook', 'b-green'], google: ['Auto \u00b7 webhook', 'b-green'], justdial: ['Auto \u00b7 API', 'b-green'],
    indiamart: ['Auto \u00b7 API', 'b-green'], form: ['Auto', 'b-green'], webhook: ['Auto', 'b-green'],
    sheet: ['Manual / bulk', 'b-amber'], walkin: ['Manual', 'b-gray'], referral: ['Manual', 'b-gray'], manual: ['Manual', 'b-gray'],
  };
  return (
    <>
      <div className="filters">
        <FilterMulti label="Branch" icon="branch" value={fBranches} options={ref.branches}
          onChange={(v) => { setFBranches(v); setFVerticals([]); setFPipelines([]); setFCampaigns([]); }} />
        <FilterMulti label="Vertical" icon="grid" value={fVerticals}
          options={ref.verticals.filter((v) => !fBranches.length || fBranches.includes(Number(v.branch_id)))}
          onChange={(v) => { setFVerticals(v); setFPipelines([]); setFCampaigns([]); }} />
        <FilterMulti label="Pipeline" icon="list" value={fPipelines}
          options={ref.pipelines.filter((p) => !fVerticals.length || fVerticals.includes(Number(p.vertical_id)))}
          onChange={(v) => { setFPipelines(v); setFCampaigns([]); }} />
        <FilterMulti label="Campaign" icon="bolt" value={fCampaigns}
          options={ref.campaigns.filter((c) => !fPipelines.length || fPipelines.includes(Number(c.pipeline_id)))} onChange={setFCampaigns} />
        <IncInactiveChip on={inc} set={setInc} />
      </div>
      <BulkBar count={_bdSel.count} entityLabel="Source" onClear={_bdSel.clear} onDelete={() => _bd.openBulk(_bdSel.selected)} />
      <TableCard fill title="Lead Source Master" select={_bdSel.tableSelect} more={<ListActions onExport={() => downloadObjectsCsv('sources.csv', list.data ?? [])} onRefresh={() => list.reload()} />} cols={['Source', 'Campaign', 'Capture', 'This month', 'Cost/lead', 'Status', 'Actions']}
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
      {_bd.bulkModal}
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
            // Client (Aug 2026): the source's Branch > Vertical > Pipeline > Campaign are now
            // EDITABLE as the same strict cascade as Add Source, PREFILLED with the source's
            // current path. Choosing a new Campaign RE-PARENTS the source: the server re-derives
            // the whole denormalised path (branch/vertical/pipeline) from the target campaign
            // (HierarchyService.updateSource), RBAC-checking both the source and the target
            // campaign against the actor's scope. Existing leads keep their own captured path.
            initialVals: {
              'Branch': edit.branch_name ?? '', 'Vertical': edit.vertical_name ?? '',
              'Pipeline': edit.pipeline_name ?? '', 'Campaign': edit.campaign_name ?? '',
              'Source Name': edit.name ?? '',
              'Status': edit.is_active === false ? 'Inactive' : 'Active',
            },
            initialIds: {
              'Branch': edit.branch_id != null ? Number(edit.branch_id) : undefined,
              'Vertical': edit.vertical_id != null ? Number(edit.vertical_id) : undefined,
              'Pipeline': edit.pipeline_id != null ? Number(edit.pipeline_id) : undefined,
              'Campaign': edit.campaign_id != null ? Number(edit.campaign_id) : undefined,
            },
            // UAT-R2 #4 — Source Category + Cost per Lead removed; backend keeps existing values.
            // Only campaign_id is sent for the path — the source's Branch/Vertical/Pipeline are
            // re-derived server-side from the chosen Campaign.
            submit: async (vals, ids) => {
              await api.patch(`/sources/${edit.id}`, {
                campaign_id: need(ids['Campaign'], 'Pick a Campaign'),
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
  const { scope: gScope } = useScope();
  const [inc, setInc] = useState(false);
  // UAT-R3 #19 — Branch list filters: search on name/code (+ status via inc).
  // Client Aug 2026 — a Vertical multi-select rolls the branch list by vertical: a branch shows
  // only if it owns one of the picked verticals (a branch HAS verticals under it). Seeded from
  // the global top-bar scope so it lands pre-narrowed. Applied client-side over ref.verticals.
  const [q, setQ] = useState('');
  const [fVerticals, setFVerticals] = useState<number[]>(gScope.verticals);
  const bparams = new URLSearchParams();
  if (inc) bparams.set('include_inactive', '1');
  if (q.trim()) bparams.set('q', q.trim());
  const list = useFetch<any[]>(`/branches${bparams.toString() ? `?${bparams}` : ''}`, [refreshTick, bparams.toString()]);
  const vBranchIds = new Set(ref.verticals.filter((v) => fVerticals.includes(Number(v.id))).map((v) => Number(v.branch_id)));
  const rows = (list.data ?? []).filter((b: any) => !fVerticals.length || vBranchIds.has(Number(b.id)));
  const [view, setView] = useState<any | null>(null);
  const [edit, setEdit] = useState<any | null>(null);
  const canEdit = can('branch.update');
  const del = useDelete('Branch', '/branches', () => { list.reload(); ref.reload(); bump(); });
  const _bdIds = rows.map((r: any) => Number(r.id));
  const _bdSel = useTableSelect(_bdIds);
  const _bd = useBulkDelete('Branch', '/branches/bulk-delete/impact', '/branches/bulk-delete', () => { list.reload(); _bdSel.clear(); });
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
      <div className="filters" style={{ flexWrap: 'wrap', gap: 8 }}>
        <SearchChip q={q} setQ={setQ} ph="Search branch name / code\u2026" />
        <FilterMulti label="Vertical" icon="grid" value={fVerticals} options={ref.verticals} onChange={setFVerticals} />
        <IncInactiveChip on={inc} set={setInc} />
      </div>
      <BulkBar count={_bdSel.count} entityLabel="Branch" onClear={_bdSel.clear} onDelete={() => _bd.openBulk(_bdSel.selected)} />
      <TableCard fill title="Branches" select={_bdSel.tableSelect} more={<ListActions onExport={() => downloadObjectsCsv('branches.csv', rows)} onRefresh={() => list.reload()} />} cols={['Branch', 'Code', 'City', 'Verticals', 'Status', 'Actions']}
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
      {_bd.bulkModal}
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
              'Legal Name': edit.legal_name ?? '', 'GSTIN': edit.gstin ?? '', 'PAN': edit.pan ?? '',
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
                legal_name: vals['Legal Name'] || null,
                gstin: vals['GSTIN'] ? String(vals['GSTIN']).trim().toUpperCase() : null,
                pan: vals['PAN'] ? String(vals['PAN']).trim().toUpperCase() : null,
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
  const { scope: gScope } = useScope();
  const [inc, setInc] = useState(false);
  // UAT-R3 #19 — Vertical list filters: by Branch (+ search, status). Seeded by the global scope.
  const [q, setQ] = useState('');
  const [fBranches, setFBranches] = useState<number[]>(gScope.branches);
  const vparams = new URLSearchParams();
  if (inc) vparams.set('include_inactive', '1');
  if (fBranches.length) vparams.set('branch_ids', fBranches.join(','));
  if (q.trim()) vparams.set('q', q.trim());
  const list = useFetch<any[]>(`/verticals${vparams.toString() ? `?${vparams}` : ''}`, [refreshTick, vparams.toString()]);
  const rows = list.data ?? [];
  const [view, setView] = useState<any | null>(null);
  const [edit, setEdit] = useState<any | null>(null);
  // dev/132 ITEM B — the banks[]/UPI editor is a controlled `extra`; it writes its latest value
  // here so the edit submit can send it. Reset whenever a different vertical is opened for edit.
  const payRef = useRef<VertPayments>({ banks: [], upi_id: '' });
  const canEdit = can('vertical.update');
  useEffect(() => {
    if (edit) payRef.current = { banks: (edit.banks ?? []) as any[], upi_id: String(edit.upi_id ?? '') };
  }, [edit]);
  const del = useDelete('Vertical', '/verticals', () => { list.reload(); ref.reload(); bump(); });
  const _bdIds = (list.data ?? []).map((r: any) => Number(r.id));
  const _bdSel = useTableSelect(_bdIds);
  const _bd = useBulkDelete('Vertical', '/verticals/bulk-delete/impact', '/verticals/bulk-delete', () => { list.reload(); _bdSel.clear(); });
  const after = () => { list.reload(); ref.reload(); bump(); };
  return (
    <>
      <div className="filters">
        <FilterMulti label="Branch" icon="branch" value={fBranches} options={ref.branches} onChange={setFBranches} />
        <SearchChip q={q} setQ={setQ} ph="Search vertical name / code\u2026" />
        <IncInactiveChip on={inc} set={setInc} />
      </div>
      <BulkBar count={_bdSel.count} entityLabel="Vertical" onClear={_bdSel.clear} onDelete={() => _bd.openBulk(_bdSel.selected)} />
      <TableCard fill title="Verticals" select={_bdSel.tableSelect} more={<ListActions onExport={() => downloadObjectsCsv('verticals.csv', list.data ?? [])} onRefresh={() => list.reload()} />} cols={['Vertical', 'Branch', 'Head', 'SMTP Domain', 'Status', 'Actions']}
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
      {_bd.bulkModal}
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
          <Section title="Billing & Identity">
            <KV rows={[
              ['Display name', view.display_name ?? '\u2014'],
              ['GSTIN', <span className="mono">{view.gstin ?? '\u2014'}</span>],
              ['Billing address', view.billing_address ?? '\u2014'],
              ['Phone', <span className="mono">{view.phone ?? '\u2014'}</span>],
              ['Email', view.email ?? '\u2014'],
              ['Logo', view.logo_url ? renderCell({ node: <img src={view.logo_url} alt="logo" style={{ height: 32, maxWidth: 96, objectFit: 'contain' }} /> } as any) : '\u2014'],
            ]} />
          </Section>
          <Section title="Bank Accounts & Payments">
            <KV rows={[
              ...(((view.banks ?? []) as any[]).length
                ? ((view.banks ?? []) as any[]).map((b: any, i: number) => [
                    `Bank ${i + 1}${b.active ? ' (active)' : ''}`,
                    <span>{b.name || '\u2014'}{b.account_no ? ` \u00b7 A/c ${b.account_no}` : ''}{b.ifsc ? ` \u00b7 ${b.ifsc}` : ''}{b.branch ? ` \u00b7 ${b.branch}` : ''}{b.account_holder ? ` \u00b7 ${b.account_holder}` : ''}</span>,
                  ] as [string, any])
                : [['Bank', '\u2014'] as [string, any]]),
              ['UPI ID', <span className="mono">{view.upi_id ?? '\u2014'}</span>],
              ['Payment QR', view.qr_url ? renderCell({ node: <img src={view.qr_url} alt="Payment QR" style={{ height: 96, maxWidth: 96, objectFit: 'contain' }} /> } as any) : '\u2014'],
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
              // dev/88 — billing / document identity + bank details.
              'Display Name': edit.display_name ?? '', 'GST Number': edit.gstin ?? '',
              'Billing Address': edit.billing_address ?? '', 'Phone': edit.phone ?? '', 'Email': edit.email ?? '',
              'UPI ID': edit.upi_id ?? '',
              'Status': edit.is_active === false ? 'Inactive' : 'Active',
            },
            initialIds: { 'Vertical Head': edit.head_user_id ? Number(edit.head_user_id) : undefined },
            // only the parent link is immutable — the rest is editable (DEF-2)
            lock: ['Branch'],
            // dev/88 — the LOGO uploader (R2, presigned, live preview) lives in the edit form,
            // where the vertical id exists (upload targets /verticals/:id/logo).
            extra: (
              <>
                <div className="fld span2" style={{ marginTop: 4 }}>
                  <label>Logo <span className="fhint">image \u00b7 R2 \u00b7 shown on this vertical\u2019s documents</span></label>
                  <VerticalLogoUpload verticalId={Number(edit.id)} initialUrl={edit.logo_url ?? null} />
                </div>
                {/* dev/132 ITEM B \u2014 multiple bank accounts (one required/active) + UPI id + payment QR */}
                <VerticalBanksEditor initial={{ banks: (edit.banks ?? []) as any[], upi_id: String(edit.upi_id ?? '') }}
                  onChange={(v) => { payRef.current = v; }} />
                <div className="fld span2" style={{ marginTop: 4 }}>
                  <label>Payment QR <span className="fhint">UPI / payment QR image \u00b7 R2</span></label>
                  <VerticalQrUpload verticalId={Number(edit.id)} initialUrl={edit.qr_url ?? null} />
                </div>
              </>
            ),
            submit: async (vals, ids) => {
              await api.patch(`/verticals/${edit.id}`, {
                name: need(vals['Vertical Name'], 'Vertical name is required'),
                code: need(vals['Vertical Code'], 'Vertical code is required'),
                head_user_id: ids['Vertical Head'] ?? null,
                description: vals['Description'] || null,
                display_name: vals['Display Name'] || null,
                gstin: vals['GST Number'] ? String(vals['GST Number']).trim().toUpperCase() : null,
                billing_address: vals['Billing Address'] || null,
                phone: vals['Phone'] || null,
                email: vals['Email'] || null,
                // dev/132 ITEM B — the multi-bank editor + UPI value (payRef) is the source of truth.
                banks: payRef.current.banks,
                upi_id: payRef.current.upi_id || null,
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
  const { scope: gScope } = useScope();
  const [inc, setInc] = useState(false);
  // UAT-R3 #19 — Pipeline list filters follow Branch \u2192 Vertical (+ search); seeded by the global scope.
  const [q, setQ] = useState('');
  const [fBranches, setFBranches] = useState<number[]>(gScope.branches);
  const [fVerticals, setFVerticals] = useState<number[]>(gScope.verticals);
  const pparams = new URLSearchParams();
  if (inc) pparams.set('include_inactive', '1');
  if (fBranches.length) pparams.set('branch_ids', fBranches.join(','));
  if (fVerticals.length) pparams.set('vertical_ids', fVerticals.join(','));
  if (q.trim()) pparams.set('q', q.trim());
  const list = useFetch<any[]>(`/pipelines${pparams.toString() ? `?${pparams}` : ''}`, [refreshTick, pparams.toString()]);
  const rows = list.data ?? [];
  const [view, setView] = useState<any | null>(null);
  const [edit, setEdit] = useState<any | null>(null);
  const [config, setConfig] = useState<any | null>(null); // stage configurator (client mockup)
  const canEdit = can('pipeline.update');
  const del = useDelete('Pipeline', '/pipelines', () => { list.reload(); ref.reload(); bump(); });
  const _bdIds = (list.data ?? []).map((r: any) => Number(r.id));
  const _bdSel = useTableSelect(_bdIds);
  const _bd = useBulkDelete('Pipeline', '/pipelines/bulk-delete/impact', '/pipelines/bulk-delete', () => { list.reload(); _bdSel.clear(); });
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
        <FilterMulti label="Branch" icon="branch" value={fBranches} options={ref.branches}
          onChange={(v) => { setFBranches(v); setFVerticals([]); }} />
        <FilterMulti label="Vertical" icon="grid" value={fVerticals}
          options={ref.verticals.filter((v) => !fBranches.length || fBranches.includes(Number(v.branch_id)))} onChange={setFVerticals} />
        <SearchChip q={q} setQ={setQ} ph="Search pipeline name / code\u2026" />
        <IncInactiveChip on={inc} set={setInc} />
      </div>
      {/* UAT-R2 #7 — the list reads in hierarchy order Branch \u203a Vertical \u203a Pipeline
          (columns and row order); the api sorts by branch, vertical, then pipeline name. */}
      <BulkBar count={_bdSel.count} entityLabel="Pipeline" onClear={_bdSel.clear} onDelete={() => _bd.openBulk(_bdSel.selected)} />
      <TableCard fill title="Pipelines" select={_bdSel.tableSelect} more={<ListActions onExport={() => downloadObjectsCsv('pipelines.csv', list.data ?? [])} onRefresh={() => list.reload()} />} cols={['Branch', 'Vertical', 'Pipeline', 'Stages', 'Status', 'Actions']}
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
      {_bd.bulkModal}
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
  const { refreshTick, bump, go } = useScreen();
  const { can } = useAuth();
  const ref = useRef_();
  // dev/131 (task #213 item 3) — the summary drives the rolled-up cards (Won/Lost/Revenue/Active/Closed),
  // narrowed by the Lead Counsellor filter when set.
  const [inc, setInc] = useState(false);
  // UAT-R3 #19 — Campaign list filters follow Branch \u2192 Vertical \u2192 Pipeline (+ search, status);
  // each child resets when its parent changes and the API honours the params.
  const { scope: gScope } = useScope();
  const [q, setQ] = useState('');
  const [fBranches, setFBranches] = useState<number[]>(gScope.branches);
  const [fVerticals, setFVerticals] = useState<number[]>(gScope.verticals);
  const [fPipelines, setFPipelines] = useState<number[]>(gScope.pipelines);
  // dev/131 (task #213 item 2) — Lead Counsellor (owner) filter: narrows the rolled-up KPI cards,
  // the per-campaign lead counts, and the campaign_id link opened into the Leads list.
  const [fOwners, setFOwners] = useState<number[]>([]);
  const cparams = new URLSearchParams();
  if (inc) cparams.set('include_inactive', '1');
  if (fBranches.length) cparams.set('branch_ids', fBranches.join(','));
  if (fVerticals.length) cparams.set('vertical_ids', fVerticals.join(','));
  if (fPipelines.length) cparams.set('pipeline_ids', fPipelines.join(','));
  if (q.trim()) cparams.set('q', q.trim());
  const sumParams = new URLSearchParams();
  if (fOwners.length) sumParams.set('owner_ids', fOwners.join(','));
  const sum = useFetch<any>(`/leads/summary${sumParams.toString() ? `?${sumParams}` : ''}`, [refreshTick, sumParams.toString()]);
  const list = useFetch<any[]>(`/campaigns${cparams.toString() ? `?${cparams}` : ''}`, [refreshTick, cparams.toString()]);
  const rows = list.data ?? [];
  const [view, setView] = useState<any | null>(null);
  const [edit, setEdit] = useState<any | null>(null);
  const canEdit = can('campaign.update');
  const del = useDelete('Campaign', '/campaigns', () => { list.reload(); ref.reload(); bump(); });
  const _bdIds = (list.data ?? []).map((r: any) => Number(r.id));
  const _bdSel = useTableSelect(_bdIds);
  const _bd = useBulkDelete('Campaign', '/campaigns/bulk-delete/impact', '/campaigns/bulk-delete', () => { list.reload(); _bdSel.clear(); });
  const after = () => { list.reload(); ref.reload(); bump(); };
  const [counts, setCounts] = useState<Record<number, number>>({});
  useEffect(() => {
    let dead = false;
    const ownerQs = fOwners.length ? `&owner_ids=${fOwners.join(',')}` : '';
    Promise.all(rows.map((c) =>
      api.get<{ total: number }>(`/leads?campaign_id=${c.id}&limit=1${ownerQs}`)
        .then((r) => [Number(c.id), r.total] as const).catch(() => [Number(c.id), 0] as const),
    )).then((pairs) => { if (!dead) setCounts(Object.fromEntries(pairs)); });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data, refreshTick, fOwners.join(',')]);
  const k = sum.data?.kpis;
  // Carry the Lead Counsellor narrow into every card / count link so the Leads list opens pre-filtered.
  const ownerNav: Record<string, string> = fOwners.length ? { owner_ids: fOwners.join(',') } : {};
  return (
    <>
      {/* dev/131 (task #213 item 3) — rolled-up cards across the current scope (+ Lead Counsellor filter):
          Active campaigns · Leads MTD · Won · Lost · Revenue · Active leads · Closed. Won/Lost open the
          filtered Leads list; Revenue comes from collected fee receipts (the Finance dashboard source). */}
      <Kpis cols={4} items={[
        { lab: 'Active campaigns', val: String(rows.filter((c) => c.is_active !== false).length), ic: 'bolt' },
        { lab: 'Leads (MTD)', val: String(k?.mtd ?? '0'), ic: 'leads',
          onClick: () => go('leads', 'all', { created_from: `${new Date().toISOString().slice(0, 7)}-01`, ...ownerNav }),
          navLabel: `Leads this month: ${k?.mtd ?? 0}. Open leads created month-to-date` },
        { lab: 'Won', val: String(k?.won ?? 0), ic: 'check',
          onClick: () => go('leads', 'all', { won: 1, ...ownerNav }), navLabel: `Won leads: ${k?.won ?? 0}. Open the won leads` },
        { lab: 'Lost', val: String(k?.lost ?? 0), ic: 'x',
          onClick: () => go('leads', 'all', { lost: 1, ...ownerNav }), navLabel: `Lost leads: ${k?.lost ?? 0}. Open the lost leads` },
        { lab: 'Revenue', val: fmtINR(Number(k?.revenue_minor ?? 0)), ic: 'rupee' },
        { lab: 'Active leads', val: String(k?.active ?? 0), ic: 'leads' },
        { lab: 'Closed', val: String(k?.closed ?? 0), ic: 'archive' },
      ]} />
      <div className="filters">
        <FilterMulti label="Branch" icon="branch" value={fBranches} options={ref.branches}
          onChange={(v) => { setFBranches(v); setFVerticals([]); setFPipelines([]); }} />
        <FilterMulti label="Vertical" icon="grid" value={fVerticals}
          options={ref.verticals.filter((v) => !fBranches.length || fBranches.includes(Number(v.branch_id)))}
          onChange={(v) => { setFVerticals(v); setFPipelines([]); }} />
        <FilterMulti label="Pipeline" icon="list" value={fPipelines}
          options={ref.pipelines.filter((p) => !fVerticals.length || fVerticals.includes(Number(p.vertical_id)))} onChange={setFPipelines} />
        <FilterMulti label="Lead Counsellor" testid="fm-owner" icon="users" value={fOwners} options={selectableUsers(ref.users)} onChange={setFOwners} />
        <SearchChip q={q} setQ={setQ} ph="Search campaign name\u2026" />
        <IncInactiveChip on={inc} set={setInc} />
      </div>
      <BulkBar count={_bdSel.count} entityLabel="Campaign" onClear={_bdSel.clear} onDelete={() => _bd.openBulk(_bdSel.selected)} />
      <TableCard fill title="Campaigns" select={_bdSel.tableSelect} more={<ListActions onExport={() => downloadObjectsCsv('campaigns.csv', list.data ?? [])} onRefresh={() => list.reload()} />} cols={['Campaign', 'Branch', 'Vertical', 'Pipeline', 'Source', 'UTM', 'Spend', 'Leads', 'CPL', 'Assign rule', 'Status', 'Actions']}
        rowClass={(i) => (rows[i].is_active === false ? 'row-inactive' : undefined)}
        rows={rows.map((c) => {
          const src = ref.sources.find((x) => Number(x.campaign_id) === Number(c.id));
          const utm = (c.utm as any)?.utm_campaign ?? (c.utm as any)?.utm_source ?? '\u2014';
          const leads = counts[Number(c.id)] ?? 0;
          const cost = Number(c.cost ?? 0);
          return [
            { node: <span className="nm">{c.name}</span> } as Cell,
            String(c.branch_name ?? '\u2014'),
            String(c.vertical_name ?? '\u2014'),
            String(c.pipeline_name ?? '\u2014'),
            src ? ({ b: [src.name, 'b-indigo'] } as Cell) : '\u2014',
            { mono: utm === '\u2014' ? '\u2014' : `utm=${utm}`, dim: true } as Cell,
            cost ? `\u20b9${cost.toLocaleString('en-IN')}` : '\u2014',
            // dev/131 (task #213 item 1) — the LEADS count links to the Leads list pre-filtered to this
            // campaign (reusing the campaign_ids query param the dashboard KPI links use), + owner narrow.
            { node: <a className="mlink" data-testid={`camp-leads-${c.id}`} style={{ cursor: 'pointer' }} onClick={() => go('leads', 'all', { campaign_ids: c.id, ...ownerNav })}>{leads}</a> } as Cell,
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
      {_bd.bulkModal}
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
  // Course levels (enrollment re-model, batch 1) — the id the Levels editor fetches its rows for.
  levelsCourseId: Number(edit.id),
  // DEF-2: nothing is locked — every Add Course field is editable and prefilled.
  initialVals: {
    'Course Name': edit.name ?? '', 'Course Code': edit.code ?? '',
    'Training Mode': (edit.meta as any)?.mode ?? '', 'Duration': (edit.meta as any)?.duration ?? '',
    'Standard Fee': (edit.meta as any)?.fee ?? '',
    'Eligibility Criteria': (edit.meta as any)?.eligibility ?? '',
    // Course descriptors (client feedback #13) — prefill so an Edit reopens fully. The single
    // "Course Level" descriptor is superseded by the per-level Levels editor (loaded by course id).
    'Course Type': (edit.meta as any)?.course_type ?? '',
    // dev/100 (client): Delivery Mode removed from the course UI (meta.delivery_mode kept in DB).
    'Description': (edit.meta as any)?.description ?? '',
    'Status': edit.is_active === false ? 'Inactive' : 'Active',
  },
  initialIds: {
    // dev/100 (client): the ERP course form walks Branch > Vertical only. Campaign/Pipeline are
    // CRM-only concepts and were removed from this form (any legacy meta value is left untouched).
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
        // dev/100 (client): Campaign/Pipeline removed from the ERP course form (CRM-only). The meta
        // spread above preserves any legacy pipeline_id/campaign_id value (non-breaking).
        eligibility: vals['Eligibility Criteria'] || undefined,
        // Course descriptors (client feedback #13) — persisted in meta; override the spread above. The
        // single "Course Level" descriptor is superseded by the per-level Levels editor (course_level).
        course_type: vals['Course Type'] || undefined,
        // dev/100 (client): delivery_mode dropped from the course UI (meta value preserved by the spread).
        description: vals['Description'] || undefined,
      },
      is_active: vals['Status'] !== 'Inactive',
    });
    // Course LEVELS (enrollment re-model, batch 1) — replace-all sync the per-level fees. Empty →
    // the course has no levels and keeps its single Standard Fee (meta.fee).
    await api.put(`/courses/${edit.id}/levels`, { levels: levelsPayload(vals['Levels']) });
    return 'Course updated';
  },
});

function Courses() {
  const { refreshTick, bump } = useScreen();
  const { can } = useAuth();
  const ref = useRef_();
  const [inc, setInc] = useState(false);
  // Course master list filters (client, Aug 2026): Branch/Vertical (cascade, multi-select) + name search.
  const [fBranches, setFBranches] = useState<number[]>([]);
  const [fVerticals, setFVerticals] = useState<number[]>([]);
  const [fCourses, setFCourses] = useState<number[]>([]);
  const [fStatuses, setFStatuses] = useState<string[]>([]);
  const [fTypes, setFTypes] = useState<string[]>([]);
  // dev/100 (client): Delivery Mode filter removed from the course list (field dropped from the UI).
  const [q, setQ] = useState('');
  const vOpts = ref.verticals.filter((vt) => !fBranches.length || fBranches.includes(Number(vt.branch_id)));
  // Course filter options cascade off Branch/Vertical (a course's meta carries branch_id/vertical_id).
  const cCourseOpts = ref.courses.filter((c: any) =>
    (!fBranches.length || fBranches.includes(Number((c.meta as any)?.branch_id))) &&
    (!fVerticals.length || fVerticals.includes(Number((c.meta as any)?.vertical_id))));
  // Course Type / Delivery Mode filter options come from the seeded catalogs (RefData →
  // GET /courses/*-catalog); fall back to the bundled constants offline / in unit tests.
  const typeFilterOpts = (ref.courseTypes.length ? ref.courseTypes : COURSE_TYPES.map((t) => ({ id: t, name: t }))).map((o: any) => ({ id: String(o.id ?? o.name), name: String(o.name) }));
  const cparams = new URLSearchParams();
  // Status filter (client, Aug 2026): active/inactive. include-inactive chip OR an 'inactive' pick
  // must surface inactive rows, so pass all=1 whenever inactive could be in the result set.
  if (inc || fStatuses.includes('inactive')) cparams.set('all', '1');
  if (fBranches.length) cparams.set('branch_ids', fBranches.join(','));
  if (fVerticals.length) cparams.set('vertical_ids', fVerticals.join(','));
  if (fCourses.length) cparams.set('course_ids', fCourses.join(','));
  if (fStatuses.length) cparams.set('statuses', fStatuses.join(','));
  if (fTypes.length) cparams.set('course_types', fTypes.join(','));
  if (q.trim()) cparams.set('q', q.trim());
  const list = useFetch<any[]>(`/masters/course?${cparams.toString()}`, [refreshTick, cparams.toString()]);
  const rows = list.data ?? [];
  const [view, setView] = useState<any | null>(null);
  const [edit, setEdit] = useState<any | null>(null);
  const canEdit = can('master.update');
  const del = useDelete('Course', '/masters/course', () => { list.reload(); ref.reload(); bump(); });
  const _bdIds = (list.data ?? []).map((r: any) => Number(r.id));
  const _bdSel = useTableSelect(_bdIds);
  const _bd = useBulkDelete('Course', '/masters/course/bulk-delete/impact', '/masters/course/bulk-delete', () => { list.reload(); _bdSel.clear(); });
  const after = () => { list.reload(); ref.reload(); bump(); };
  return (
    <>
      <div className="filters">
        {/* Course master filters (client, Aug 2026): Branch > Vertical > Course, Status, Course Type
            (all multi-select) + name search. Each genuinely narrows the server query. dev/100 (client):
            the Delivery Mode filter was removed (the course Delivery Mode field was dropped from the UI). */}
        <FilterMulti label="Branch" icon="branch" value={fBranches} options={ref.branches}
          onChange={(v) => { setFBranches(v); setFVerticals((cur) => cur.filter((id) => ref.verticals.some((vt) => Number(vt.id) === id && v.includes(Number(vt.branch_id))))); setFCourses((cur) => cur.filter((id) => ref.courses.some((c: any) => Number(c.id) === id && v.includes(Number((c.meta as any)?.branch_id))))); }} />
        <FilterMulti label="Vertical" icon="grid" value={fVerticals} options={vOpts}
          onChange={(v) => { setFVerticals(v); setFCourses((cur) => cur.filter((id) => !v.length || ref.courses.some((c: any) => Number(c.id) === id && v.includes(Number((c.meta as any)?.vertical_id))))); }} />
        <FilterMulti label="Course" icon="book" value={fCourses} options={cCourseOpts} onChange={setFCourses} />
        <EnumMulti label="Status" icon="check" value={fStatuses}
          options={[{ id: 'active', name: 'Active' }, { id: 'inactive', name: 'Inactive' }]} onChange={setFStatuses} />
        <EnumMulti label="Course Type" icon="award" value={fTypes} options={typeFilterOpts} onChange={setFTypes} />
        <div className="fchip"><Ic k="search" /><input style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }} placeholder="Search course name / code\u2026" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <IncInactiveChip on={inc} set={setInc} />
      </div>
      <BulkBar count={_bdSel.count} entityLabel="Course" onClear={_bdSel.clear} onDelete={() => _bd.openBulk(_bdSel.selected)} />
      <TableCard fill title="Course master" select={_bdSel.tableSelect} more={<ListActions onExport={() => downloadObjectsCsv('courses.csv', list.data ?? [])} onRefresh={() => list.reload()} />} cols={['Code', 'Course', 'Vertical', 'Type', 'Level', 'Mode', 'Duration', 'Fee', 'Branches', 'Status', 'Actions']}
        rowClass={(i) => (rows[i].is_active === false ? 'row-inactive' : undefined)}
        rows={rows.map((c) => [
          { mono: String(c.code ?? '\u2014') } as Cell,
          { node: <span className="nm">{c.name}</span> } as Cell,
          String(nameOf(ref.verticals, (c.meta as any)?.vertical_id) ?? (c.meta as any)?.vertical ?? '\u2014'),
          String((c.meta as any)?.course_type ?? '\u2014'),
          String((c.meta as any)?.level ?? '\u2014'),
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
      {_bd.bulkModal}
      {del.deleteModal}
      {view && (
        <DetailModal title={`Course \u2014 ${view.name}`} icon="book" onClose={() => setView(null)}>
          <Section title="Details">
            <KV rows={[
              ['Name', view.name],
              ['Code', <span className="mono">{view.code ?? '\u2014'}</span>],
              ['Branch', nameOf(ref.branches, (view.meta as any)?.branch_id) ?? '\u2014'],
              ['Vertical', nameOf(ref.verticals, (view.meta as any)?.vertical_id) ?? '\u2014'],
              ['Course type', String((view.meta as any)?.course_type ?? '\u2014')],
              ['Course level', String((view.meta as any)?.level ?? '\u2014')],
              ['Training mode', String((view.meta as any)?.mode ?? '\u2014')],
              ['Duration', String((view.meta as any)?.duration ?? '\u2014')],
              ['Standard fee', String((view.meta as any)?.fee ?? '\u2014')],
              ['Description', String((view.meta as any)?.description ?? '\u2014')],
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
              ['Reports to', d.report_to_name || '\u2014'],
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
  const [fRoles, setFRoles] = useState<number[]>([]);
  const [fUserBranches, setFUserBranches] = useState<number[]>([]);
  const [fStatus, setFStatus] = useState<string | undefined>(undefined);
  const [fq, setFq] = useState('');
  const params = new URLSearchParams();
  if (fRoles.length) params.set('role_ids', fRoles.join(','));
  if (fUserBranches.length) params.set('branch_ids', fUserBranches.join(','));
  if (fStatus) params.set('status', fStatus);
  if (fq.trim()) params.set('q', fq.trim());
  const qs = params.toString();
  const list = useFetch<any[]>(`/users${qs ? `?${qs}` : ''}`, [refreshTick, qs]);
  const rows = list.data ?? [];
  const [view, setView] = useState<any | null>(null);
  const [edit, setEdit] = useState<any | null>(null);
  const canEdit = can('user.update');
  const { me } = useAuth();
  const del = useDelete('User', '/users', () => { list.reload(); ref.reload(); bump(); });
  const _bdIds = (list.data ?? []).map((r: any) => Number(r.id));
  const _bdSel = useTableSelect(_bdIds);
  const _bd = useBulkDelete('User', '/users/bulk-delete/impact', '/users/bulk-delete', () => { list.reload(); _bdSel.clear(); });
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
        : <>Deactivate <b>{u.name}</b>? They can no longer sign in and are skipped by every Lead Counsellor picker. Existing leads are untouched.</>,
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

  return (
    <>
      <div className="filters">
        <FilterMulti label="Role" icon="shield" value={fRoles} options={roles.data ?? []} onChange={setFRoles} />
        <FilterMulti label="Branch" icon="branch" value={fUserBranches} options={ref.branches} onChange={setFUserBranches} />
        <div className="fchip"><Ic k="users" />Status
          <select value={fStatus ?? ''} onChange={(e) => setFStatus(e.target.value || undefined)}>
            <option value="">All</option><option value="active">Active</option><option value="disabled">Inactive</option>
          </select>
        </div>
        <div className="fchip"><Ic k="search" /><input style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }} placeholder="Search name / email\u2026" value={fq} onChange={(e) => setFq(e.target.value)} /></div>
        <div className="fchip" style={{ marginLeft: 'auto' }}><Ic k="users" /><b>{rows.length}</b> users</div>
      </div>
      <BulkBar count={_bdSel.count} entityLabel="User" onClear={_bdSel.clear} onDelete={() => _bd.openBulk(_bdSel.selected)} />
      <TableCard fill title="Users" select={_bdSel.tableSelect} more={<ListActions onExport={() => downloadObjectsCsv('users.csv', list.data ?? [])} onRefresh={() => list.reload()} />} cols={['User', 'Role', 'Reports to', 'Scope (Branch/Vertical/Pipeline)', 'SSO', 'Status', 'Actions']}
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
            u.report_to_name || '\u2014',
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
      {_bd.bulkModal}
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
                'Reports To': edit.report_to_name ?? '',
                'Status': edit.status === 'disabled' ? 'Deactivated' : 'Active',
              },
              initialIds: {
                'System Role': roleId ? Number(roleId) : undefined,
                'Reports To': edit.report_to_id == null ? undefined : Number(edit.report_to_id),
              },
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
                  // Reporting manager (client, Aug 2026) — null clears it.
                  report_to_id: ids['Reports To'] ?? null,
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
      <TableCard fill title="Roles" more={<ListActions onExport={() => downloadObjectsCsv('roles.csv', roles.data ?? [])} onRefresh={() => roles.reload()} />} cols={['Role', 'Type', 'Permissions', 'Users', 'Status', 'Actions']}
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
  // SHARED date range on when the action occurred. Default All time.
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const aq = new URLSearchParams({ limit: '100' });
  if (range.from) aq.set('from', range.from);
  if (range.to) aq.set('to', range.to);
  const rangeKey = `${range.from ?? ''}~${range.to ?? ''}`;
  const logs = useFetch<any[]>(`/audit-logs?${aq.toString()}`, [refreshTick, rangeKey]);
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
      <div className="filters" style={{ marginBottom: 12 }}>
        <DateRange value={range} onChange={setRange} idPrefix="audit-dr" />
      </div>
      <TableCard fill title="Activity log \u2014 all users" more={<ListActions onExport={() => downloadObjectsCsv('audit-log.csv', logs.data ?? [])} onRefresh={() => logs.reload()} />} cols={['Time', 'User', 'Module', 'Activity', 'Detail', 'Actions']}
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
        {/* SHARED date range (standardised from the old two date inputs) — filters by event time. */}
        <DateRange value={{ from: f.from, to: f.to }} idPrefix="errlog-dr"
          onChange={(v) => setF((x) => ({ ...x, from: v.from, to: v.to }))} />
        <div className="fchip"><Ic k="search" /><input style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }} placeholder="Search message / path…" value={f.q} onChange={(e) => setF((x) => ({ ...x, q: e.target.value }))} /></div>
        <button className="fchip" style={{ marginLeft: 'auto', cursor: 'pointer', color: grouped ? 'var(--primary)' : 'var(--text-muted)', borderColor: grouped ? 'var(--primary)' : undefined }}
          onClick={() => setGrouped((g) => !g)}>
          <Ic k={grouped ? 'grid' : 'list'} />{grouped ? 'Grouped' : 'All events'}
        </button>
      </div>
      <TableCard fill title={grouped ? 'Error groups' : 'Error events'} icon="shield"
        more={<span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <span className="sub" style={{ fontSize: 12 }}>{`${data.data?.total ?? 0} ${grouped ? 'groups' : 'events'}`}</span>
          <ListActions onExport={() => downloadObjectsCsv('error-log.csv', data.data?.rows ?? [])} onRefresh={() => data.reload()} />
        </span>}
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

function MastersAdmin({ initialType = 'course' }: { initialType?: string } = {}) {
  const { refreshTick, bump } = useScreen();
  const { can } = useAuth();
  const ref = useRef_();
  const types = useFetch<Array<{ type: string; label: string; parent: string | null }>>('/masters', []);
  const [type, setType] = useState(initialType);
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
  const _bdIds = rows.map((r: any) => Number(r.id));
  const _bdSel = useTableSelect(_bdIds);
  const _bd = useBulkDelete(label.replace(/s$/, ''), `/masters/${type}/bulk-delete/impact`, `/masters/${type}/bulk-delete`, () => { list.reload(); _bdSel.clear(); });
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
      <BulkBar count={_bdSel.count} entityLabel={label.replace(/s$/, '')} onClear={_bdSel.clear} onDelete={() => _bd.openBulk(_bdSel.selected)} />
      <TableCard title={`${label} master`} icon="cfg" select={_bdSel.tableSelect}
        more={<span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <ListActions onExport={() => downloadObjectsCsv(`${type}.csv`, list.data ?? [])} onRefresh={() => list.reload()} />
          {can('master.create')
            ? <a className="mlink" style={{ cursor: 'pointer' }} onClick={() => setAdd(true)}>＋ Add {label.replace(/s$/, '')}</a>
            : null}
        </span>}
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
      {_bd.bulkModal}
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

/**
 * FEATURES / WHAT'S NEW (client #4) — a REAL in-app feature list + changelog, the destination
 * for the top-bar "Features" shortcut. Not a dead button: it renders a genuine list of the
 * modules the CRM ships and the most recent updates. Items that map to a screen are clickable
 * and navigate via go() (so it also doubles as a quick launcher). A static-but-real list, per
 * the client's ask; the authoritative changelog lives in docs/devops/01-deploy-log.md.
 */
const WHATS_NEW: Array<{ t: string; d: string }> = [
  { t: 'Follow-up date filter', d: 'Filter My Tasks, Today’s Follow-ups and Leads by No Followup · Missed · Today · Tomorrow · Next 7 / 30 Days · Custom (all in IST).' },
  { t: 'Top-bar shortcuts', d: 'Quick access to New Leads, Due Today, Upcoming follow-ups and this Features panel from anywhere.' },
  { t: 'Global scope selector', d: 'A Branch › Vertical › Pipeline › Campaign selector in the top bar filters the whole app to one unit.' },
  { t: 'Shared date-range picker', d: 'Today / Yesterday / This Week / This Month / Custom on every list, report and the dashboard (IST).' },
  { t: 'Dashboard cards open filtered lists', d: 'Every KPI card is a button that opens the exact list behind its number.' },
  { t: 'Import Leads + Import History', d: 'CSV import with a per-row preview, soft course matching, and an Import History tab with downloadable failed rows.' },
  { t: 'Lead transfer & bulk actions', d: 'Move a lead across Branch/Vertical/Campaign; bulk transfer, reassign, pause and resume over a filtered set.' },
];
const FEATURE_MODULES: Array<{ t: string; d: string; mod?: string; sub?: string }> = [
  { t: 'Leads', d: 'Capture, three list views, filters, scoring, SLA, transfer & bulk actions.', mod: 'leads', sub: 'all' },
  { t: 'My Tasks & Follow-ups', d: 'Assigned/Created tasks, reminders, the new follow-up date filter.', mod: 'dash', sub: 'mytasks' },
  { t: 'Dashboard & Quick Stats', d: 'Role-aware KPIs, funnel, sparklines — all date-range aware.', mod: 'dash', sub: 'overview' },
  { t: 'Campaigns & Masters', d: 'Branch › Vertical › Pipeline › Campaign › Source hierarchy + course masters.', mod: 'leads', sub: 'campaigns' },
  { t: 'Analytics & Reports', d: 'Funnel, TAT, Activity, Campaign ROI + a custom Report Builder.', mod: 'analytics', sub: 'funnel' },
  { t: 'Engagement & Journeys', d: 'Templates, bulk WhatsApp / SMS / Email and automation journeys.', mod: 'engage', sub: 'journeys' },
  { t: 'Enrolment & Fees (lite)', d: 'Quotations, sale closure, monthly targets, counsellor performance, fee receipts.', mod: 'perf', sub: 'closure' },
  { t: 'Administration', d: 'Users, custom roles (RBAC), integrations, audit log, API access.', mod: 'admin', sub: 'users' },
];
function FeaturesPanel() {
  const { go } = useScreen();
  // MERGED (Batch 7): the What's New card is now backed by the release_note data (release_note.view,
  // granted to all staff). When an admin has published release notes they drive this list; until
  // then it falls back to the seeded static highlights so the panel is never empty.
  const feed = useFetch<any[]>(`/release-notes/feed?limit=12`, []);
  const notes = feed.data ?? [];
  const catBadge: Record<string, string> = { feature: 'b-green', improvement: 'b-green', fix: 'b-amber' };
  return (
    <>
      <div className="card">
        <div className="card-head"><h3><Ic k="bolt" />What’s New</h3><span className="more">Recent updates {notes.length ? '· Release Notes' : ''}</span></div>
        <div className="list">
          {notes.length ? notes.map((n) => (
            <div className="lrow" key={n.id}>
              <div className="ic"><Ic k="check" /></div>
              <div className="tx">
                <div className="t1">{n.title}
                  {n.version ? <span className="mono" style={{ marginLeft: 6, opacity: .7 }}>{n.version}</span> : null}
                  <span className={`badge ${catBadge[n.category] ?? 'b-gray'}`} style={{ marginLeft: 8 }}>{n.category}</span>
                </div>
                <div className="t2">{n.notes || ''}{n.release_date ? `  — ${String(n.release_date).slice(0, 10).split('-').reverse().join('-')}` : ''}</div>
              </div>
            </div>
          )) : WHATS_NEW.map((f, i) => (
            <div className="lrow" key={i}>
              <div className="ic"><Ic k="check" /></div>
              <div className="tx"><div className="t1">{f.t}</div><div className="t2">{f.d}</div></div>
            </div>
          ))}
        </div>
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head"><h3><Ic k="grid" />Feature Modules</h3><span className="more">Click to open</span></div>
        <div className="list">
          {FEATURE_MODULES.map((m, i) => (
            <div className="lrow" key={i} role={m.mod ? 'button' : undefined} tabIndex={m.mod ? 0 : undefined}
              style={m.mod ? { cursor: 'pointer' } : undefined}
              onClick={() => m.mod && go(m.mod, m.sub!)}
              onKeyDown={(e) => { if (m.mod && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); go(m.mod, m.sub!); } }}>
              <div className="ic"><Ic k="grid" /></div>
              <div className="tx"><div className="t1">{m.t}</div><div className="t2">{m.d}</div></div>
              {m.mod ? <div className="rt"><Ic k="chev" /></div> : null}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/* ==================================================================== */
/*  STUDENTS & ACADEMICS (Phase 2 — CRM level)                          */
/*  Convert a won lead -> a student; the students directory + dashboard; */
/*  batches bound to Branch -> Vertical -> Course.                       */
/* ==================================================================== */

const BAR_COLOURS = ['var(--primary)', 'var(--accent)', '#6366f1', '#0ea5e9', '#22c55e', '#f59e0b', '#ec4899', '#14b8a6'];

/* STUDENT LIFECYCLE STATUS (migration 073) — the 11-status catalog mirrored client-side for
 * colour-coded badges + the LMS-access hint. The API's student_status_def is the source of
 * truth; this map is for display + the Change-Status form. */
type LmsAccess = 'full' | 'limited' | 'none' | 'alumni' | 'depends';
const STUDENT_STATUS_META: Record<string, { label: string; cls: string; lms: LmsAccess }> = {
  active:        { label: 'Active',         cls: 'b-green',  lms: 'full' },
  on_hold:       { label: 'On Hold',        cls: 'b-amber',  lms: 'limited' },
  inactive:      { label: 'Inactive',       cls: 'b-gray',   lms: 'limited' },
  suspended:     { label: 'Suspended',      cls: 'b-rose',   lms: 'none' },
  withdrawn:     { label: 'Withdrawn',      cls: 'b-rose',   lms: 'none' },
  dropped_out:   { label: 'Dropped Out',    cls: 'b-red',    lms: 'none' },
  transferred:   { label: 'Transferred',    cls: 'b-cyan',   lms: 'depends' },
  completed:     { label: 'Completed',      cls: 'b-indigo', lms: 'alumni' },
  cancelled:     { label: 'Cancelled',      cls: 'b-red',    lms: 'none' },
  failed:        { label: 'Failed',         cls: 'b-red',    lms: 'none' },
  course_expired:{ label: 'Course Expired', cls: 'b-gray',   lms: 'none' },
};
const SENSITIVE_STATUS = new Set(['on_hold', 'suspended', 'withdrawn', 'dropped_out', 'cancelled']);
const LMS_HINT: Record<LmsAccess, string> = {
  full: 'Full LMS access', limited: 'Limited LMS — view material, no new tests',
  none: 'No LMS access', alumni: 'Alumni — view material only', depends: 'LMS access per transfer',
};
const statusMeta = (status: string) => STUDENT_STATUS_META[status] ?? { label: status || '—', cls: 'b-gray', lms: 'full' as LmsAccess };
const studentStatusCell = (status: string): Cell => { const m = statusMeta(status); return { b: [m.label, m.cls] }; };
/* BATCH STATUS LIFECYCLE (migration 080) — 7 codes with colour-coded badges + meanings.
 * upcoming/active/expired are date-derived (IST); completed/cancelled/suspended/archived are
 * MANUAL (set by a user, stick over the date logic). batch_status_def is the source of truth. */
const BATCH_STATUS_META: Record<string, { label: string; cls: string; meaning: string; manual: boolean }> = {
  upcoming:  { label: 'Upcoming',  cls: 'b-cyan',   meaning: 'Batch is confirmed but classes have not started',         manual: false },
  active:    { label: 'Active',    cls: 'b-green',  meaning: 'Classes are currently running',                          manual: false },
  suspended: { label: 'Suspended', cls: 'b-amber',  meaning: 'Batch temporarily paused',                              manual: true  },
  completed: { label: 'Completed', cls: 'b-indigo', meaning: 'All scheduled classes/course activities completed',      manual: true  },
  cancelled: { label: 'Cancelled', cls: 'b-red',    meaning: 'Batch cancelled before or after starting',              manual: true  },
  expired:   { label: 'Expired',   cls: 'b-rose',   meaning: 'Batch end date passed without formal completion/closure', manual: false },
  archived:  { label: 'Archived',  cls: 'b-gray',   meaning: 'Historical batch retained for records/reporting',        manual: true  },
};
const BATCH_STATUS_ORDER = ['upcoming', 'active', 'suspended', 'completed', 'cancelled', 'expired', 'archived'];
/** The 9 batch-type codes + labels (matches batch_type_def / migration 081) — powers the Batch
 *  Type list filter (EnumMulti). id == the stored code; name == the human label. */
const BATCH_TYPE_OPTS: Array<{ id: string; name: string }> = [
  { id: 'regular', name: 'Regular' }, { id: 'fast_track', name: 'Fast Track' },
  { id: 'weekend', name: 'Weekend' }, { id: 'weekday', name: 'Weekday' },
  { id: 'intensive', name: 'Intensive' }, { id: 'crash_course', name: 'Crash Course' },
  { id: 'online', name: 'Online' }, { id: 'corporate', name: 'Corporate' },
  { id: 'customized', name: 'Customized' },
];
const batchStatusMeta = (status: string) => BATCH_STATUS_META[status] ?? { label: status || '\u2014', cls: 'b-gray', meaning: '', manual: false };
const batchStatusCell = (status: string): Cell => { const m = batchStatusMeta(status); return { b: [m.label, m.cls] }; };

/* Multi-select STATUS filter for the Batches list — the 7 lifecycle codes (string-valued, so a
 * native <details> popover like the students' StatusMultiFilter). */
function BatchStatusMultiFilter({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const toggle = (code: string) => onChange(value.includes(code) ? value.filter((c) => c !== code) : [...value, code]);
  const label = value.length ? `${value.length} selected` : 'All statuses';
  return (
    <details className="fmulti" data-testid="fm-batch-status" style={{ position: 'relative' }}>
      <summary className="fmulti-lbl" style={{ cursor: 'pointer', listStyle: 'none' }}><Ic k="check" />Status: {label}</summary>
      <div style={{ position: 'absolute', zIndex: 40, top: '100%', left: 0, marginTop: 6, minWidth: 210, maxHeight: 320, overflow: 'auto',
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 6, boxShadow: '0 8px 24px rgba(0,0,0,.18)' }}>
        {BATCH_STATUS_ORDER.map((code) => { const m = BATCH_STATUS_META[code]; return (
          <label key={code} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '5px 6px', fontSize: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={value.includes(code)} onChange={() => toggle(code)} data-testid={`fm-batch-status-${code}`} />
            <span className={m.cls} style={{ padding: '1px 8px', borderRadius: 999 }}>{m.label}</span>
          </label>
        ); })}
        {value.length ? <button className="btn ghost" style={{ width: '100%', marginTop: 4, fontSize: 12 }} onClick={() => onChange([])}>Clear</button> : null}
      </div>
    </details>
  );
}

/** THE STUDENT DASHBOARD — real numbers from students/enrolments/fees, RBAC- + scope- +
 *  date-aware. Every KPI card opens the filtered student list (docs/dev/22 pattern). */
function StudentDashboard() {
  const { go } = useScreen();
  const { params: sp, key: scopeKey } = useScope();
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const rq = new URLSearchParams();
  if (range.from) rq.set('from', range.from);
  if (range.to) rq.set('to', range.to);
  const qs = rq.toString();
  const rangeKey = `${range.from ?? ''}~${range.to ?? ''}`;
  const { data, reload } = useFetch<any>(withScope('/students/summary' + (qs ? `?${qs}` : ''), sp), [scopeKey, rangeKey]);
  const k = data?.kpis;
  const toList = (filter?: Record<string, string | number | undefined>) => () => go('students', 'all', filter);

  const barsFrom = (arr: any[]) => {
    const max = Math.max(1, ...(arr ?? []).map((r) => Number(r.value)));
    return (arr ?? []).map((r, i) => ({ label: r.label, val: String(r.value), pct: (Number(r.value) * 100) / max, color: BAR_COLOURS[i % BAR_COLOURS.length] }));
  };

  const kpiItems = [
    { lab: 'Total students', val: String(k?.total ?? 0), ic: 'students',
      onClick: toList(), navLabel: `Total students: ${k?.total ?? 0}. Open the students list` },
    { lab: 'Active', val: String(k?.active ?? 0), ic: 'check',
      onClick: toList({ status: 'active' }), navLabel: `Active students: ${k?.active ?? 0}. Open active students` },
    { lab: 'Inactive', val: String(k?.inactive ?? 0), ic: 'clock',
      onClick: toList({ status: 'inactive' }), navLabel: `Inactive students: ${k?.inactive ?? 0}. Open inactive students` },
    { lab: range.from || range.to ? 'New (in range)' : 'New (MTD)', val: String(k?.new_in_range ?? 0), ic: 'plus',
      onClick: toList(), navLabel: `New students: ${k?.new_in_range ?? 0}. Open the students list` },
    { lab: 'Assigned to a batch', val: String(k?.in_batch ?? 0), ic: 'grid',
      onClick: () => go('students', 'batches'), navLabel: `Students in a batch: ${k?.in_batch ?? 0}. Open Batches` },
    { lab: 'Fees collected', val: data ? fmtINR(data.fees?.collected_minor ?? 0) : '—', ic: 'rupee',
      onClick: () => go('perf', 'collection'), navLabel: 'Fees collected. Open Fee Collection' },
  ];

  return (
    <>
      <div className="filters" style={{ marginBottom: 12 }}>
        <span className="fchip on" style={{ cursor: 'default' }}><Ic k="students" />Students overview</span>
        <DateRange value={range} onChange={setRange} idPrefix="stu-dr" style={{ marginLeft: 'auto' }} />
      </div>
      <Kpis cols={6} items={kpiItems} />
      <div className="row2" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <HBars title="Students by branch" rows={barsFrom(data?.by_branch)} empty="No students yet" />
        <HBars title="Students by vertical" rows={barsFrom(data?.by_vertical)} empty="No students yet" />
      </div>
      <div className="row2" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <HBars title="Students by course" rows={barsFrom(data?.by_course)} empty="No students yet" />
        <TableCard title="Recent conversions" icon="students"
          more={<ListActions onExport={() => downloadObjectsCsv('recent-students.csv', data?.recent ?? [])} onRefresh={() => reload()} />}
          cols={['Student', 'ID', 'Course', 'Branch', 'Converted']}
          empty="No lead has been converted to a student yet"
          rows={(data?.recent ?? []).map((s: any): Cell[] => [
            { node: <b className="nm">{s.full_name}</b> },
            { mono: s.customer_no ?? s.student_no ?? '—' },
            s.course_name ?? '—',
            s.branch_name ?? '—',
            fmtFull(s.created_at),
          ])} />
      </div>
      <AssessmentDashboardCards />
    </>
  );
}

/** STUDENT MANAGEMENT — the real students directory (the Phase-2 shell, made live). */
function StudentsList() {
  const { refreshTick, bump, search } = useScreen();
  const { can } = useAuth();
  const ref = useRef_();
  const { scope: gScope, params: gsp, key: scopeKey } = useScope();

  const seed = () => {
    const spx = new URLSearchParams(typeof search === 'string' ? search : '');
    const nums = (arrKey: string, singleKey: string) => {
      const out = new Set<number>();
      for (const raw of spx.getAll(arrKey)) for (const p of String(raw).split(',')) { const v = Number(p.trim()); if (Number.isFinite(v) && v > 0) out.add(v); }
      const one = Number(spx.get(singleKey)); if (Number.isFinite(one) && one > 0) out.add(one);
      return [...out];
    };
    return {
      branches: nums('branch_ids', 'branch_id').length ? nums('branch_ids', 'branch_id') : (gScope.branches),
      verticals: nums('vertical_ids', 'vertical_id').length ? nums('vertical_ids', 'vertical_id') : (gScope.verticals),
      courses: nums('course_ids', 'course_id'),
      owners: nums('owner_ids', 'owner_id'),
      statuses: (spx.get('status') || '').split(',').map((x) => x.trim()).filter(Boolean),
      q: spx.get('q') || '',
    };
  };
  const s0 = useMemo(seed, [search, scopeKey]);
  const [fBranches, setFBranches] = useState<number[]>(s0.branches);
  const [fVerticals, setFVerticals] = useState<number[]>(s0.verticals);
  const [fCourses, setFCourses] = useState<number[]>(s0.courses);
  const [fOwners, setFOwners] = useState<number[]>(s0.owners);
  const [fStatuses, setFStatuses] = useState<string[]>(s0.statuses);
  const [q, setQ] = useState<string>(s0.q);
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  useEffect(() => {
    setFBranches(s0.branches); setFVerticals(s0.verticals); setFCourses(s0.courses);
    setFOwners(s0.owners); setFStatuses(s0.statuses); setQ(s0.q);
  }, [s0]);

  const vOpts = ref.verticals.filter((vt) => !fBranches.length || fBranches.includes(Number(vt.branch_id)));
  const cOpts = ref.courses.filter((c: any) =>
    (!fBranches.length || fBranches.includes(Number(c.meta?.branch_id)))
    && (!fVerticals.length || fVerticals.includes(Number(c.meta?.vertical_id))));

  const params = new URLSearchParams();
  if (fBranches.length) params.set('branch_id', fBranches.join(','));
  if (fVerticals.length) params.set('vertical_id', fVerticals.join(','));
  if (fCourses.length) params.set('course_id', fCourses.join(','));
  if (fOwners.length) params.set('owner_id', fOwners.join(','));
  if (fStatuses.length) params.set('status', fStatuses.join(','));
  if (q.trim()) params.set('q', q.trim());
  if (range.from) params.set('from', range.from);
  if (range.to) params.set('to', range.to);
  const list = useFetch<any[]>(`/students?${params.toString()}`, [refreshTick, params.toString()]);
  const rows = list.data ?? [];
  const [view, setView] = useState<any | null>(null);
  const [xfer, setXfer] = useState<any | null>(null);
  const canDelete = can('student.delete');
  const canCreate = can('student.create');
  const canEdit = can('student.update');
  const [add, setAdd] = useState(false);
  const [edit, setEdit] = useState<any | null>(null);
  const del = useDelete('Student', '/students', () => { list.reload(); bump(); });
  // OBS-2 — full-list treatment: bulk-select + bulk-delete (export / multi-filter / column
  // chooser / refresh are already present), consistent with every other ERP list.
  const _bdIds = (list.data ?? []).map((r: any) => Number(r.id));
  const _bdSel = useTableSelect(_bdIds);
  const _bd = useBulkDelete('Student', '/students/bulk-delete/impact', '/students/bulk-delete', () => { list.reload(); bump(); _bdSel.clear(); });
  const after = () => { list.reload(); bump(); };
  // Edit opens on the FULL profile (the row carries only the summary columns).
  const openEdit = async (st: any) => {
    try { setEdit(await api.get<any>(`/students/${st.id}`)); }
    catch { setEdit(st); }
  };

  return (
    <>
      {canCreate && (
        <div className="page-actions">
          <button className="btn primary" onClick={() => setAdd(true)}><Ic k="plus" />New student</button>
        </div>
      )}
      <div className="filters">
        <FilterMulti label="Branch" icon="branch" value={fBranches} options={ref.branches}
          onChange={(v) => { setFBranches(v); setFVerticals((cur) => cur.filter((id) => ref.verticals.some((vt) => Number(vt.id) === id && v.includes(Number(vt.branch_id))))); }} />
        <FilterMulti label="Vertical" icon="grid" value={fVerticals} options={vOpts} onChange={setFVerticals} />
        <FilterMulti label="Course" icon="book" value={fCourses} options={cOpts} onChange={setFCourses} />
        <FilterMulti label="Owner" icon="users" value={fOwners} options={selectableUsers(ref.users)} onChange={setFOwners} />
        <StatusMultiFilter value={fStatuses} onChange={setFStatuses} />
        <div className="fchip"><Ic k="search" /><input style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }} placeholder="Search name / phone / ID…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <DateRange value={range} onChange={setRange} idPrefix="stu-list-dr" style={{ marginLeft: 'auto' }} />
      </div>
      {canDelete && <BulkBar count={_bdSel.count} entityLabel="Student" onClear={_bdSel.clear} onDelete={() => _bd.openBulk(_bdSel.selected)} />}
      <TableCard fill title="Student directory" icon="students"
        select={canDelete ? _bdSel.tableSelect : undefined}
        more={<span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <span className="sub" style={{ fontSize: 12 }}>{rows.length} shown</span>
          <ListActions onExport={() => downloadObjectsCsv('students.csv', rows)} onRefresh={() => list.reload()} />
        </span>}
        cols={['Student', 'Phone', 'Course', 'Branch · Vertical', 'Owner', 'Batch', 'Status', 'Created', 'Actions']}
        empty="No students yet — convert a won lead from the Leads list (⋮ → Convert to Student)."
        onRowClick={(i) => setView(rows[i])}
        rows={rows.map((st) => [
          { node: <div><b className="nm">{st.full_name}</b><div className="sub mono" data-testid={`stu-row-id-${st.id}`}>{st.customer_no ?? st.student_no ?? '—'}</div></div> } as Cell,
          { mono: st.phone ?? '—' } as Cell,
          // Item 7 (client feedback): show the CONVERTED course(s) — every enrolment course
          // (single OR multiple, across verticals) — not the stale lead course. `courses` is the
          // comma-joined names from the API; fall back to the legacy single course_name.
          { node: (st.courses || st.course_name)
            ? <span title={st.courses || st.course_name}>{st.courses || st.course_name}</span>
            : <span>—</span> } as Cell,
          { node: <span>{st.branch_name ?? '—'}<div className="sub">{st.vertical_name ?? '—'}</div></span> } as Cell,
          st.owner_name ?? '—',
          st.batch_name ?? '—',
          studentStatusCell(st.status),
          fmtFull(st.created_at),
          rowActions({
            onView: () => setView(st),
            onEdit: canEdit ? () => openEdit(st) : undefined,
            onDelete: canDelete ? () => del.openDelete(Number(st.id), st.full_name) : undefined,
            extra: canEdit ? [{ k: 'swap', title: 'Transfer to another branch', onClick: () => setXfer(st) }] : undefined,
          }),
        ])} />
      {del.deleteModal}
      {_bd.bulkModal}
      {view && <StudentDetailModal student={view} onClose={() => setView(null)} onEdit={canEdit ? openEdit : undefined} onChanged={after} />}
      {xfer && <TransferStudentModal student={xfer} onClose={() => setXfer(null)} onDone={() => { setXfer(null); after(); }} />}
      {add && <StudentModal onClose={() => setAdd(false)} onSaved={after} />}
      {edit && <StudentModal initial={edit} onClose={() => setEdit(null)} onSaved={after} />}
    </>
  );
}

/** GENDER / RELATION / ID-PROOF / QUALIFICATION option sets the Admission form offers. */
const GENDER_OPTS = ['Male', 'Female', 'Other'];
const RELATION_OPTS = ['Father', 'Mother', 'Brother', 'Sister', 'Uncle', 'Other'];
const IDPROOF_OPTS = ['Aadhaar', 'PAN', 'Passport', 'Voter ID', 'Driving Licence', 'Other'];

/**
 * ADD / EDIT STUDENT — the full Admission form (client, Aug 2026), sectioned into
 * Identity / Contact / Guardian / Address / ID Proofs / Education. Student ID is minted by
 * the numbering series (read-only here); Enrollment No is auto OR manual (an editable box,
 * blank = auto on save). Phones use the international PhoneInput; State → City cascades;
 * "Same as Permanent" copies Permanent → Current and disables Current.
 *
 * Every rendered field maps to the request body (qa/09 matrix) — this is a large form, the
 * exact phantom-field risk class, so the payload is built field-by-field from `f`.
 */
export function StudentModal({ initial, onClose, onSaved }: { initial?: any; onClose?: () => void; onSaved?: () => void }) {
  const ref = useRef_();
  const isEdit = !!initial?.id;
  const d10 = (v: any) => (v ? String(v).slice(0, 10) : '');
  const [f, setF] = useState<any>(() => ({
    enrollment_no: initial?.enrollment_no ?? '',
    full_name: initial?.full_name ?? '',
    dob: d10(initial?.dob), gender: initial?.gender ?? '', nationality: initial?.nationality ?? (isEdit ? '' : 'Indian'),
    registration_date: d10(initial?.registration_date), admission_date: d10(initial?.admission_date),
    phone: initial?.phone ?? '', whatsapp_phone: initial?.whatsapp_phone ?? '', alt_phone: initial?.alt_phone ?? '', email: initial?.email ?? '',
    father_name: initial?.father_name ?? '', father_mobile: initial?.father_mobile ?? '',
    guardian_name: initial?.guardian_name ?? '', guardian_mobile: initial?.guardian_mobile ?? '',
    guardian_email: initial?.guardian_email ?? '', guardian_relation: initial?.guardian_relation ?? '',
    address_line1: initial?.address_line1 ?? '', address_line2: initial?.address_line2 ?? '', landmark: initial?.landmark ?? '',
    country: initial?.country ?? (isEdit ? '' : 'India'),
    state_id: String(initial?.state_id ?? ''), city_id: String(initial?.city_id ?? ''),
    district: initial?.district ?? '', pincode: initial?.pincode ?? '',
    permanent_address: initial?.permanent_address ?? '', current_address: initial?.current_address ?? '',
    id_proof_type: initial?.id_proof_type ?? '', id_proof_number: initial?.id_proof_number ?? '',
    aadhaar: initial?.aadhaar ?? '', pan: initial?.pan ?? '', passport: initial?.passport ?? '',
    qualification: initial?.qualification ?? '', institution: initial?.institution ?? '',
    board_university: initial?.board_university ?? '', passing_year: initial?.passing_year ? String(initial.passing_year) : '',
    previous_institution: initial?.previous_institution ?? '',
    branch_id: String(initial?.branch_id ?? ''), vertical_id: String(initial?.vertical_id ?? ''),
    course_id: String(initial?.course_id ?? ''), owner_id: String(initial?.owner_id ?? ''),
    placement_course_type: initial?.placement_course_type ?? '',
  }));
  // "Same as Permanent" starts on only when an existing record already mirrors them.
  const [same, setSame] = useState<boolean>(!!initial && !!initial.permanent_address && initial.permanent_address === initial.current_address);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const up = (k: string, v: any) => setF((s: any) => ({ ...s, [k]: v }));

  // Custom fields (client, Aug 2026) — admin-defined student fields (entity='student') render
  // here and persist into student.custom_fields, mirroring the lead Add form. Saved values are
  // rehydrated from initial.custom_fields so they show on reopen. Non-throwing fetch → [] = none.
  const [cfDefs, setCfDefs] = useState<CfDef[]>([]);
  const [cfVals, setCfVals] = useState<Record<string, string>>(() => {
    const src = (initial?.custom_fields && typeof initial.custom_fields === 'object') ? initial.custom_fields as Record<string, unknown> : {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(src)) out[k] = Array.isArray(v) ? (v as unknown[]).join(', ') : (v == null ? '' : String(v));
    return out;
  });
  useEffect(() => {
    let live = true;
    fetchCfDefs('student').then((d) => { if (live) setCfDefs(d); });
    return () => { live = false; };
  }, []);
  const upCf = (key: string, v: string) => setCfVals((s) => ({ ...s, [key]: v }));

  const vOpts = ref.verticals.filter((vt) => !f.branch_id || Number(vt.branch_id) === Number(f.branch_id));
  const cOpts = ref.courses.filter((c: any) =>
    (!f.branch_id || Number(c.meta?.branch_id) === Number(f.branch_id))
    && (!f.vertical_id || Number(c.meta?.vertical_id) === Number(f.vertical_id)));
  const cityOpts = ref.cities.filter((ci) => !f.state_id || Number(ci.parent_id) === Number(f.state_id));
  const effectiveCurrent = same ? f.permanent_address : f.current_address;

  const save = async () => {
    setErr('');
    if (!f.full_name.trim()) return setErr('Student Full Name is required.');
    if (!f.branch_id) return setErr('Choose a branch.');
    if (!f.vertical_id) return setErr('Choose a vertical.');
    // Custom fields: enforce required ones before we submit (matches the lead Add form).
    for (const d of cfDefs) {
      const raw = cfVals[d.field_key];
      const missing = d.data_type === 'bool' ? !(raw === '1' || raw === 'true') : (raw === undefined || String(raw).trim() === '');
      if (d.required && missing) return setErr(`${d.label} is required.`);
    }
    setBusy(true);
    const num = (v: any) => (v === '' || v == null ? null : Number(v));
    const body: any = {
      enrollment_no: f.enrollment_no.trim() || null,
      full_name: f.full_name.trim(),
      dob: f.dob || null, gender: f.gender || null, nationality: f.nationality || null,
      registration_date: f.registration_date || null, admission_date: f.admission_date || null,
      phone: f.phone || null, whatsapp_phone: f.whatsapp_phone || null, alt_phone: f.alt_phone || null, email: f.email || null,
      father_name: f.father_name || null, father_mobile: f.father_mobile || null,
      guardian_name: f.guardian_name || null, guardian_mobile: f.guardian_mobile || null,
      guardian_email: f.guardian_email || null, guardian_relation: f.guardian_relation || null,
      address_line1: f.address_line1 || null, address_line2: f.address_line2 || null, landmark: f.landmark || null,
      country: f.country || null, state_id: num(f.state_id), city_id: num(f.city_id),
      district: f.district || null, pincode: f.pincode || null,
      permanent_address: f.permanent_address || null, current_address: effectiveCurrent || null,
      id_proof_type: f.id_proof_type || null, id_proof_number: f.id_proof_number || null,
      aadhaar: f.aadhaar || null, pan: f.pan || null, passport: f.passport || null,
      qualification: f.qualification || null, institution: f.institution || null,
      board_university: f.board_university || null, passing_year: f.passing_year || null, previous_institution: f.previous_institution || null,
      branch_id: num(f.branch_id), vertical_id: num(f.vertical_id), course_id: num(f.course_id), owner_id: num(f.owner_id),
      placement_course_type: f.placement_course_type ?? '',
      custom_fields: collectCf(cfDefs, (key) => cfVals[key]),
    };
    try {
      if (isEdit) await api.patch(`/students/${initial.id}`, body);
      else await api.post('/students', body);
      toast(isEdit ? 'Student updated' : 'Student added');
      onSaved?.(); onClose?.();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const Txt = (label: string, k: string, opts: { req?: boolean; type?: string; ph?: string } = {}) => (
    <div className="fld">
      <label htmlFor={`st-${k}`}>{label}{opts.req ? <span className="star"> *</span> : null}</label>
      <input id={`st-${k}`} className="ainp" type={opts.type ?? 'text'} value={f[k]} placeholder={opts.ph}
        onChange={(e) => up(k, e.target.value)} />
    </div>
  );
  const Phone = (label: string, k: string) => (
    <div className="fld">
      <label htmlFor={`st-${k}`}>{label}</label>
      <PhoneInput value={f[k]} onChange={(v) => up(k, v)} placeholder={label} />
    </div>
  );
  const Sel = (label: string, k: string, options: string[], ph = '— Select —') => (
    <div className="fld">
      <label htmlFor={`st-${k}`}>{label}</label>
      <select id={`st-${k}`} className="ainp" value={f[k]} onChange={(e) => up(k, e.target.value)}>
        <option value="">{ph}</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 760 }}>
        <div className="ah">
          <h3><Ic k="students" />{isEdit ? 'Edit student' : 'New student'}</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          {/* -------------------------------- Identity -------------------------------- */}
          <div className="sec-title">Identity</div>
          <div className="form-grid">
            <div className="fld">
              <label>Student ID</label>
              <input className="ainp" value={isEdit ? (initial?.customer_no ?? initial?.student_no ?? '') : ''} placeholder="Auto — assigned on save" readOnly disabled />
            </div>
            {Txt('Enrollment No.', 'enrollment_no', { ph: 'Auto if left blank' })}
            {Txt('Student Full Name', 'full_name', { req: true, ph: 'Full name' })}
            {Txt('Date of Birth', 'dob', { type: 'date' })}
            {Sel('Gender', 'gender', GENDER_OPTS)}
            {Txt('Nationality', 'nationality', { ph: 'Indian' })}
            {Txt('Registration Date', 'registration_date', { type: 'date' })}
            {Txt('Admission Date', 'admission_date', { type: 'date' })}
          </div>
          {/* --------------------- Branch / Vertical / Course / Owner ------------------ */}
          <div className="sec-title">Placement</div>
          <div className="form-grid">
            <div className="fld">
              <label htmlFor="st-branch">Branch<span className="star"> *</span></label>
              <select id="st-branch" className="ainp" value={f.branch_id}
                onChange={(e) => setF((s: any) => ({ ...s, branch_id: e.target.value, vertical_id: '', course_id: '' }))}>
                <option value="">— Select branch —</option>
                {ref.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="st-vertical">Vertical<span className="star"> *</span></label>
              <select id="st-vertical" className="ainp" value={f.vertical_id} disabled={!f.branch_id}
                onChange={(e) => setF((s: any) => ({ ...s, vertical_id: e.target.value, course_id: '' }))}>
                <option value="">{f.branch_id ? '— Select vertical —' : 'Choose a branch first'}</option>
                {vOpts.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="st-course">Course</label><MasterQuickAdd type="course" onAdded={(row) => up('course_id', String(row.id))} />
              <select id="st-course" className="ainp" value={f.course_id} disabled={!f.vertical_id}
                onChange={(e) => up('course_id', e.target.value)}>
                <option value="">{f.vertical_id ? '— Select course —' : 'Choose a vertical first'}</option>
                {cOpts.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="st-course-type">Course Type</label><MasterQuickAdd type="course_type" onAdded={(row) => up('placement_course_type', row.name)} />
              <select id="st-course-type" className="ainp" value={f.placement_course_type} onChange={(e) => up('placement_course_type', e.target.value)}>
                <option value="">— Select course type —</option>
                {(ref.courseTypes ?? []).map((ct: any) => <option key={ct.id} value={ct.name}>{ct.name}</option>)}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="st-owner">Owner</label>
              <select id="st-owner" className="ainp" value={f.owner_id} onChange={(e) => up('owner_id', e.target.value)}>
                <option value="">— Unassigned —</option>
                {selectableUsers(ref.users, f.owner_id).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
          </div>
          {/* -------------------------------- Contact --------------------------------- */}
          <div className="sec-title">Contact</div>
          <div className="form-grid">
            {Phone('Primary Mobile', 'phone')}
            {Phone('WhatsApp Number', 'whatsapp_phone')}
            {Phone('Alternate Mobile', 'alt_phone')}
            {Txt('Email', 'email', { type: 'email', ph: 'name@example.com' })}
          </div>
          {/* ---------------------------- Family / Guardian --------------------------- */}
          <div className="sec-title">Family / Guardian</div>
          <div className="form-grid">
            {Txt('Father Name', 'father_name')}
            {Phone('Father Mobile', 'father_mobile')}
            {Txt('Guardian Name', 'guardian_name')}
            {Phone('Guardian Mobile', 'guardian_mobile')}
            {Txt('Guardian Email', 'guardian_email', { type: 'email' })}
            {Sel('Guardian Relation', 'guardian_relation', RELATION_OPTS)}
          </div>
          {/* -------------------------------- Address --------------------------------- */}
          <div className="sec-title">Address</div>
          <div className="form-grid">
            {Txt('Address Line 1', 'address_line1')}
            {Txt('Address Line 2', 'address_line2')}
            {Txt('Landmark', 'landmark')}
            {Txt('Country', 'country', { ph: 'India' })}
            <div className="fld">
              <label htmlFor="st-state">State</label><MasterQuickAdd type="state" onAdded={(row) => up('state_id', String(row.id))} />
              <select id="st-state" className="ainp" value={f.state_id}
                onChange={(e) => setF((s: any) => ({ ...s, state_id: e.target.value, city_id: '' }))}>
                <option value="">— Select state —</option>
                {ref.states.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="st-city">City</label><MasterQuickAdd type="city" onAdded={(row) => up('city_id', String(row.id))} />
              <select id="st-city" className="ainp" value={f.city_id} disabled={!f.state_id}
                onChange={(e) => up('city_id', e.target.value)}>
                <option value="">{f.state_id ? '— Select city —' : 'Choose a state first'}</option>
                {cityOpts.map((ci) => <option key={ci.id} value={ci.id}>{ci.name}</option>)}
              </select>
            </div>
            {Txt('District', 'district')}
            {Txt('Pincode', 'pincode', { ph: '6 digits' })}
          </div>
          <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
            <div className="fld">
              <label htmlFor="st-perm">Permanent Address</label>
              <textarea id="st-perm" className="ainp" rows={2} value={f.permanent_address} onChange={(e) => up('permanent_address', e.target.value)} />
            </div>
            <div className="fld">
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={same} onChange={(e) => setSame(e.target.checked)} />
                Same as Permanent
              </label>
            </div>
            <div className="fld">
              <label htmlFor="st-curr">Current Address</label>
              <textarea id="st-curr" className="ainp" rows={2} value={effectiveCurrent} disabled={same}
                onChange={(e) => up('current_address', e.target.value)} />
            </div>
          </div>
          {/* -------------------------------- ID Proofs ------------------------------- */}
          <div className="sec-title">ID Proofs</div>
          <div className="form-grid">
            {Sel('ID Proof Type', 'id_proof_type', IDPROOF_OPTS)}
            {Txt('ID Proof Number', 'id_proof_number')}
            {Txt('Aadhaar Number', 'aadhaar', { ph: '12 digits' })}
            {Txt('PAN Number', 'pan', { ph: 'ABCDE1234F' })}
            {Txt('Passport Number', 'passport')}
          </div>
          {/* -------------------------------- Education ------------------------------- */}
          <div className="sec-title">Education</div>
          <div className="form-grid">
            {Txt('Highest Qualification', 'qualification')}
            {Txt('Institution Name', 'institution')}
            {Txt('Board/University', 'board_university')}
            {Txt('Passing Year', 'passing_year', { type: 'number', ph: 'e.g. 2022' })}
            {Txt('Previous Institution', 'previous_institution')}
          </div>
          {/* --------------------- Custom Fields (admin-defined, entity=student) ------- */}
          {cfDefs.length > 0 && (<>
            <div className="sec-title">Custom Fields</div>
            <div className="form-grid">
              {cfDefs.map((d) => {
                const val = cfVals[d.field_key] ?? '';
                if (d.data_type === 'bool') {
                  return (
                    <div className="fld" key={d.field_key}>
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <input type="checkbox" checked={val === '1' || val === 'true'} onChange={(e) => upCf(d.field_key, e.target.checked ? '1' : '')} />
                        {d.label}{d.required ? <span className="star"> *</span> : null}
                      </label>
                    </div>
                  );
                }
                if (d.data_type === 'select' || d.data_type === 'multiselect') {
                  return (
                    <div className="fld" key={d.field_key}>
                      <label htmlFor={`st-cf-${d.field_key}`}>{d.label}{d.required ? <span className="star"> *</span> : null}</label>
                      <select id={`st-cf-${d.field_key}`} className="ainp" value={val} onChange={(e) => upCf(d.field_key, e.target.value)}>
                        <option value="">— Select —</option>
                        {(d.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    </div>
                  );
                }
                const type = d.data_type === 'number' ? 'number' : d.data_type === 'date' ? 'date' : 'text';
                return (
                  <div className="fld" key={d.field_key}>
                    <label htmlFor={`st-cf-${d.field_key}`}>{d.label}{d.required ? <span className="star"> *</span> : null}</label>
                    <input id={`st-cf-${d.field_key}`} className="ainp" type={type} value={val} onChange={(e) => upCf(d.field_key, e.target.value)} />
                  </div>
                );
              })}
            </div>
          </>)}
          {err && <div className="form-err" style={{ marginTop: 8 }}>{err}</div>}
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={save}><Ic k="check" />{busy ? 'Saving…' : (isEdit ? 'Save student' : 'Add student')}</button>
        </div>
      </div>
    </div>
  );
}

/** Student detail — profile + status toggle + assign-to-batch (batches in the same branch/vertical). */
/** SIBLINGS — the family members of a student (ERP Batch 3). Discoverable from either student
 *  via a shared family group; link by searching the directory, unlink from the group. RBAC:
 *  read via student.read, link/unlink via student.update. */
function SiblingsSection({ studentId, branchId, verticalId, canEdit }: { studentId: number; branchId?: number; verticalId?: number; canEdit: boolean }) {
  const [rows, setRows] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const [matches, setMatches] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const load = async () => { try { setRows(await api.get<any[]>(`/students/${studentId}/siblings`)); } catch { /* keep */ } };
  useEffect(() => { load(); }, [studentId]);
  const search = async (term: string) => {
    setQ(term);
    if (term.trim().length < 2) { setMatches([]); return; }
    try {
      const p = new URLSearchParams(); p.set('q', term.trim()); p.set('limit', '8');
      const r = await api.get<any[]>(`/students?${p.toString()}`);
      const have = new Set([studentId, ...rows.map((x) => Number(x.id))]);
      setMatches((r ?? []).filter((x: any) => !have.has(Number(x.id))));
    } catch { setMatches([]); }
  };
  const link = async (sid: number) => {
    setBusy(true);
    try { await api.post(`/students/${studentId}/siblings`, { sibling_id: sid }); toast('Sibling linked'); setQ(''); setMatches([]); await load(); }
    catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  const unlink = async () => {
    setBusy(true);
    try { await api.del(`/students/${studentId}/siblings`); toast('Removed from family group'); await load(); }
    catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <Section title="Family / Siblings">
      {rows.length === 0 ? <div className="empty-note">No siblings linked yet.</div> : (
        <div>
          {rows.map((sb) => (
            <div className="lrow" key={sb.id}>
              <div className="gr"><div className="t1"><b>{sb.full_name}</b> <span className="sub mono">{sb.student_no ?? ''}</span></div>
                <div className="t2 sub">{[sb.branch_name, sb.vertical_name, sb.course_name].filter(Boolean).join(' › ') || ''}</div></div>
            </div>
          ))}
          {canEdit && <div style={{ marginTop: 6 }}><button className="btn sm danger" onClick={unlink} disabled={busy}><Ic k="x" />Remove this student from the family group</button></div>}
        </div>
      )}
      {canEdit && (
        <div style={{ marginTop: 10 }}>
          <label className="sub">Link a sibling</label>
          <input className="ainp" placeholder="Search students by name / phone / ID…" value={q}
            data-testid="sibling-search" onChange={(e) => search(e.target.value)} />
          {matches.length > 0 && (
            <div className="card" style={{ marginTop: 4, padding: 4 }}>
              {matches.map((m) => (
                <button key={m.id} className="subitem" style={{ display: 'block', width: '100%', textAlign: 'left' }}
                  onClick={() => link(Number(m.id))} disabled={busy}>
                  <b>{m.full_name}</b> <span className="sub mono">{m.student_no ?? ''}</span> <span className="sub">{m.phone ?? ''}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

// dev/109 — CHOOSABLE COLUMNS for the profile's Course Enrollment + Fee Receipt Records lists.
// These two lists live inside StudentDetailModal (not standalone list screens), so they reuse the
// shared column chooser (colprefs) directly: a "Columns" button + per-user/per-list persistence.
// The 11 client-requested columns lead the set (Roll Number · Enrolment Number · Branch · Vertical ·
// Course · Level · Total Fee · Net Fee · Fee Plan · Due Fee · Status), matching the Fee Management
// dues list; a few list-specific extras (Batch, Enrolled, LMS, Amount, Mode, Received, Actions) follow.
const ENROL_COL_LABELS = ['Roll Number', 'Enrolment Number', 'Branch', 'Vertical', 'Course', 'Level', 'Total Fee', 'Net Fee', 'Fee Plan', 'Due Fee', 'Status', 'Batch', 'Enrolled', 'LMS', 'Actions'];
const RECEIPT_COL_LABELS = ['Receipt', 'Roll Number', 'Enrolment No', 'Branch', 'Vertical', 'Course', 'Level', 'Total Fee', 'Net Fee', 'Fee Plan', 'Due Fee', 'Status', 'Amount', 'Mode', 'Received', 'Actions'];

export function StudentDetailModal({ student, onClose, onChanged, onEdit, initialTab }: { student: any; onClose: () => void; onChanged: () => void; onEdit?: (s: any) => void; initialTab?: string }) {
  const { can } = useAuth();
  const canEdit = can('student.update');
  // dev/109 — column-visibility state for the two profile lists (persisted per user, per list).
  const enrolCols = useColumnVisibility('student-course-enrollment', ENROL_COL_LABELS);
  const receiptCols = useColumnVisibility('student-fee-receipts', RECEIPT_COL_LABELS);
  const [prof, setProf] = useState<any>(null);
  const [full, setFull] = useState<any>(student);
  const [batches, setBatches] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<string>(initialTab ?? 'fees');
  const [showTransfer, setShowTransfer] = useState(false);
  const [showStatus, setShowStatus] = useState(false);
  const [addEnrol, setAddEnrol] = useState(false);
  const [enrolStatusFor, setEnrolStatusFor] = useState<any | null>(null);
  const [enrolHistFor, setEnrolHistFor] = useState<any | null>(null);
  const [enrolXferFor, setEnrolXferFor] = useState<any | null>(null);
  const [enrolEditFor, setEnrolEditFor] = useState<any | null>(null); // client feedback item 6 — Edit enrolment
  const [enrolViewFor, setEnrolViewFor] = useState<any | null>(null); // client Aug 2026 (#4a) — read-only View enrolment
  const [enrolLevelFor, setEnrolLevelFor] = useState<any | null>(null); // batch 2 — Add level (upgrade) to an enrolment
  // client refinement (dev/80) — Fee Management actions on the profile Fees tab (reuse standalone components)
  const [feePlanFor, setFeePlanFor] = useState<number | null>(null);        // fee setup -> PlanCreateModal
  const [feePlanEditFor, setFeePlanEditFor] = useState<number | null>(null); // edit -> PlanDetailModal
  const [feeCollectFor, setFeeCollectFor] = useState<number | null>(null);   // collect -> CollectModal
  const [feeReceiptView, setFeeReceiptView] = useState<any | null>(null);    // view -> ReceiptViewModal
  const canStatusManage = can('student.status_manage');
  const canApproveAdm = can('admission.approve');
  const journeyData = useFetch<any>(tab === 'admission' ? `/students/${student.id}/admission-journey` : null, [student.id, tab]);
  // dev/108 #2 — the originating lead's record + journey (activity timeline / follow-ups).
  const leadJourney = useFetch<any>(tab === 'leadjourney' ? `/students/${student.id}/lead-journey` : null, [student.id, tab]);
  const [admActionFor, setAdmActionFor] = useState<{ enrolment: any; action: string } | null>(null);
  const reloadJourney = () => { journeyData.reload(); loadProfile(); onChanged(); };
  const enrolData = useFetch<any>(tab === 'enrollments' ? `/students/${student.id}/enrolments` : null, [student.id, tab]);
  const learnData = useFetch<any>(tab === 'learning' ? `/students/${student.id}/learning` : null, [student.id, tab]);
  const [idCardVert, setIdCardVert] = useState<number | null>(null);
  const vidData = useFetch<any>(tab === 'idcard' ? `/students/${student.id}/vertical-ids` : null, [student.id, tab]);
  const idCardUrlPath = `/students/${student.id}/id-card/url`;
  const idCardData = useFetch<any>(
    tab === 'idcard' ? (idCardVert != null ? `${idCardUrlPath}?vertical_id=${idCardVert}` : idCardUrlPath) : null,
    [student.id, tab, idCardVert]);
  useEffect(() => {
    const vs = (vidData.data?.verticals ?? []) as any[];
    if (tab === 'idcard' && vs.length && idCardVert == null) setIdCardVert(Number(vs[0].vertical_id));
    if (tab !== 'idcard' && idCardVert != null) setIdCardVert(null);
  }, [vidData.data, tab]);
  const reloadEnrol = () => { enrolData.reload(); loadProfile(); onChanged(); };
  const statusHist = useFetch<any[]>(tab === 'status' ? `/students/${student.id}/status-history` : null, [student.id, tab]);
  const [lms, setLms] = useState<any>(null);
  const [lmsErr, setLmsErr] = useState<string>('');
  useEffect(() => {
    if (tab !== 'status') { setLms(null); setLmsErr(''); return; }
    setLms(null); setLmsErr('');
    api.get<any>(`/students/${student.id}/lms`).then(setLms).catch((e) => setLmsErr((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, student.id]);

  const loadProfile = async () => {
    try {
      const d = await api.get<any>(`/students/${student.id}/profile`);
      setProf(d); setFull(d.student);
      if (can('batch.read')) {
        try { setBatches(await api.get<any[]>(`/batches?branch_id=${d.student.branch_id}&vertical_id=${d.student.vertical_id}&status=active`) ?? []); } catch { /* keep */ }
      }
    } catch { /* keep the row data */ }
  };
  useEffect(() => { loadProfile(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [student.id]);

  const patch = async (body: any, msg: string) => {
    setBusy(true);
    try { await api.patch(`/students/${student.id}`, body); toast(msg); setFull((f: any) => ({ ...f, ...body })); onChanged(); loadProfile(); }
    catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };

  const dash = (v: any) => (v == null || v === '' ? '—' : v);
  const dmy = (v: any) => fmtDMYIST(v);
  // client (dev/113): timestamps in the student profile show date AND time (IST) — enrolled,
  // status-changed, receipts, lead/admission journey, transfers, history. Pure DATE fields
  // (DOB, admission/registration/effective/due/session/issue dates) stay date-only via `dmy`.
  const dt = (v: any) => fmtDateTimeIST(v);
  const money = (minor: any) => fmtINR(Number(minor ?? 0), { symbol: true });
  // Fee Management row actions — same endpoints as the standalone Fee Management screen (dev/76).
  const canFeeCollect = can('fee.collect');
  const canPlanCreate = can('payment_plan.create');
  const feeRemind = async (enrolmentId: number) => {
    try {
      const res = await api.post<any>('/fee-dues/remind', { enrolment_id: enrolmentId });
      if (res?.already) toast('A reminder was already sent to this student today.');
      else if (res?.skipped === 'no_outstanding') toast('Nothing outstanding — no reminder sent.');
      else if (res?.sent) toast(`Reminder queued on ${(res.channels ?? []).join(', ').toUpperCase()}.`);
      else toast('Reminder recorded — no reachable channel is configured yet.');
    } catch (e) { toast((e as Error).message, true); }
  };
  const feeDownloadReceipt = async (enrolmentId: number) => {
    try {
      const recs = await api.get<any[]>(`/fees/receipts?enrolment_id=${enrolmentId}`);
      const latest = (recs ?? [])[0];
      if (!latest) { toast('No receipt yet for this enrolment.', true); return; }
      openPdfAuthed(`/fees/receipts/${latest.id}/pdf`);
    } catch (e) { toast((e as Error).message, true); }
  };

  const ac = prof?.academics;
  const att = ac?.attendance;
  const fees = prof?.fees;
  const TABS: Array<[string, string, string]> = [
    ['fees', 'Fee Management', 'rupee'], ['overview', 'Overview', 'eye'], ['contact', 'Contact', 'phone'],
    ['family', 'Family', 'users'], ['address', 'Address', 'note'], ['ids', 'ID & Documents', 'doc'], ['idcard', 'ID Card', 'award'],
    ['education', 'Education', 'book'], ['academics', 'Academics', 'grid'], ['attendance', 'Attendance', 'check'],
    ['status', 'Status & LMS', 'flag'], ['enrollments', 'Course Enrollment', 'grid'], ['learning', 'Syllabus', 'book'],
    ['placements', 'Placements', 'target'],
    ['leadjourney', 'Lead Journey', 'target'],
    ['admission', 'Admission Journey', 'check'],
    ['certs', 'Certificates', 'award'], ['reportcards', 'Report Cards', 'list'],
  ];
  const activeCourses: string[] = Array.from(new Set(((prof?.fees?.enrolments ?? []) as any[])
    .filter((e: any) => !['cancelled', 'withdrawn', 'dropped_out'].includes(String(e.course_status ?? '')))
    .map((e: any) => String(e.course_name ?? '').trim()).filter(Boolean)));
  if (!activeCourses.length && full.course_name) activeCourses.push(String(full.course_name));
  const openIdCard = async (vid?: number | null) => {
    try {
      const idCardApi = `/api/students/${student.id}/id-card`;
      const res = await fetch(vid != null ? `${idCardApi}?vertical_id=${vid}` : idCardApi, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) {
        let msg = 'Could not open the ID card';
        try { const j = await res.json(); if (j?.message) msg = String(j.message); } catch { /* non-JSON */ }
        toast(msg, true); return;
      }
      const url = URL.createObjectURL(await res.blob());
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch { toast('Could not open the ID card', true); }
  };
  const photo = prof?.photo_url as string | undefined;
  const initials = String(full.full_name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w: string) => w[0]?.toUpperCase() ?? '').join('') || '?';
  const attPct = att?.summary?.present_pct;
  const chip = (label: string, val: ReactNode, cls = '') => (
    <div className={`fbp-chip ${cls}`}><span className="fbp-chip-v">{val}</span><span className="fbp-chip-l">{label}</span></div>
  );

  const Empty = ({ t }: { t: string }) => <div className="empty-note">{t}</div>;

  return (
    <DetailModal title={`Student — ${full.full_name}`} icon="students" onClose={onClose} width={1160} className="add-modal--xl fbp-modal">
      <div className="fbp">
        <div className="fbp-cover" />
        <div className="fbp-head">
          <div className="fbp-id">
            <h2 className="fbp-name">{full.full_name}</h2>
            <div className="fbp-sub">
              <span className="mono" title="Student ID" data-testid="stu-customer-no">{full.customer_no ?? full.student_no ?? '—'}</span>
              {full.customer_no && full.student_no ? <span className="sub mono" style={{ fontSize: 11 }} title="Internal record no.">· {full.student_no}</span> : null}
              <span>{renderCell(studentStatusCell(full.status))}</span>
              <span className="sub" style={{ fontSize: 11 }}>· {LMS_HINT[statusMeta(full.status).lms]}</span>
            </div>
            {/* dev/108 #1 — header shows the ADMISSION (converted) Branch › Vertical derived from
                the student's enrolment(s), not the originating lead's stale branch/vertical. */}
            <div className="fbp-path" data-testid="stu-admission-path">
              {(() => {
                // client (dev/113): show ALL verticals the student is admitted/enrolled across —
                // no "+N more" truncation. `prof.vertical_ids` is the DISTINCT Branch/Vertical set
                // (one per vertical). Group by branch for a compact "Branch › V1, V2" render, and
                // list every branch when a student spans multiple branches.
                const verts = (prof?.vertical_ids ?? []) as any[];
                if (verts.length) {
                  const byBranch = new Map<string, string[]>();
                  for (const v of verts) {
                    const b = String(v.branch_name ?? '').trim();
                    const vn = String(v.vertical_name ?? '').trim();
                    if (!vn) continue;
                    const arr = byBranch.get(b) ?? [];
                    if (!arr.includes(vn)) arr.push(vn);
                    byBranch.set(b, arr);
                  }
                  const parts = Array.from(byBranch.entries())
                    .map(([b, vs]) => [b, vs.join(', ')].filter(Boolean).join(' › '));
                  if (parts.length) return parts.join('   ·   ');
                }
                // Fallback (profile not loaded yet / no enrolments): the primary admission path.
                return [full.admission_branch_name ?? full.branch_name, full.admission_vertical_name ?? full.vertical_name].filter(Boolean).join(' › ') || '—';
              })()}
            </div>
            <div className="fbp-tags">
              <span className="fbp-tag"><Ic k="book" />{activeCourses.length ? activeCourses.join(', ') : 'No course'}</span>
              <span className="fbp-tag"><Ic k="grid" />{ac?.current_batch?.name ?? full.batch_name ?? 'No batch'}</span>
              <span className="fbp-tag"><Ic k="cal" />Admitted {dmy(full.admission_date)}</span>
            </div>
            <div className="fbp-btns">
              <button className="btn" onClick={() => { const vids = (prof?.vertical_ids ?? []) as any[]; if (vids.length > 1) { setTab('idcard'); } else { openIdCard(vids[0]?.vertical_id ?? null); } }} data-testid="stu-id-card"><Ic k="award" />Student ID Card</button>
              {canEdit && <button className="btn" onClick={() => setShowStatus(true)} data-testid="stu-change-status"><Ic k="flag" />Change status</button>}
              {canEdit && <button className="btn" onClick={() => setShowTransfer(true)}><Ic k="swap" />Transfer student</button>}
              {onEdit && <button className="btn" onClick={() => { onEdit(full); onClose(); }}><Ic k="pencil" />Edit full profile</button>}
            </div>
          </div>
          <div className="fbp-avatar" aria-hidden={false} title={full.full_name}>
            {photo ? <img src={photo} alt={full.full_name} /> : <span>{initials}</span>}
            {canEdit && <StudentPhotoUpload studentId={Number(student.id)} onDone={() => { loadProfile(); onChanged(); }} />}
          </div>
        </div>
        <div className="fbp-stats">
          {chip('Attendance', attPct != null ? `${attPct}%` : '—', 'ok')}
          {chip('Fees Paid', money(fees?.summary?.collected_minor), 'ok')}
          {chip('Outstanding', money(fees?.summary?.balance_minor), Number(fees?.summary?.balance_minor ?? 0) > 0 ? 'warn' : '')}
          {chip('Current Batch', ac?.current_batch?.name ?? full.batch_name ?? 'Not assigned')}
        </div>
        <div className="fbp-body">
          <nav className="fbp-rail" aria-label="Student sections">
            {TABS.map(([k, label, ic]) => (
              <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)} data-testid={`fbp-tab-${k}`}>
                <Ic k={ic} /><span>{label}</span>
              </button>
            ))}
          </nav>
          <div className="fbp-main">

      {tab === 'overview' && (
        <Section title="Identity">
          <KV rows={[
            ['Student ID', <span className="mono" data-testid="stu-identity-customer-no">{full.customer_no ?? full.student_no ?? '—'}</span>],
            ['Roll Number(s)', <span className="mono">{((prof?.vertical_ids ?? []) as any[]).map((v) => v.student_vertical_no).filter(Boolean).join(', ') || '—'}</span>],
            ['Internal record no.', <span className="mono">{dash(full.student_no)}</span>],
            ['Name', full.full_name],
            ['Date of Birth', dmy(full.dob)],
            ['Gender', dash(full.gender)],
            ['Nationality', dash(full.nationality)],
            ['Registration Date', dmy(full.registration_date)],
            ['Admission Date', dmy(full.admission_date)],
            ['Status', renderCell(studentStatusCell(full.status))],
            ['Branch', dash(full.branch_name)],
            ['Vertical', dash(full.vertical_name)],
            ['Course', dash(full.course_name)],
            ['Owner', dash(full.owner_name)],
          ]} />
        </Section>
      )}

      {tab === 'contact' && (
        <Section title="Contact">
          <KV rows={[
            ['Primary Mobile', <span className="mono">{dash(full.phone)}</span>],
            ['WhatsApp', <span className="mono">{dash(full.whatsapp_phone)}</span>],
            ['Alternate Mobile', <span className="mono">{dash(full.alt_phone)}</span>],
            ['Email', dash(full.email)],
          ]} />
        </Section>
      )}

      {tab === 'family' && (
        <>
          <Section title="Family / Guardian">
            <KV rows={[
              ['Father Name', dash(full.father_name)],
              ['Father Mobile', <span className="mono">{dash(full.father_mobile)}</span>],
              ['Guardian Name', dash(full.guardian_name)],
              ['Guardian Mobile', <span className="mono">{dash(full.guardian_mobile)}</span>],
              ['Guardian Email', dash(full.guardian_email)],
              ['Guardian Relation', dash(full.guardian_relation)],
            ]} />
          </Section>
          <SiblingsSection studentId={Number(student.id)} branchId={full.branch_id} verticalId={full.vertical_id} canEdit={canEdit} />
        </>
      )}

      {tab === 'address' && (
        <Section title="Address">
          <KV rows={[
            ['Address Line 1', dash(full.address_line1)],
            ['Address Line 2', dash(full.address_line2)],
            ['Landmark', dash(full.landmark)],
            ['City / State', `${dash(full.city_name)} / ${dash(full.state_name)}`],
            ['District', dash(full.district)],
            ['Country', dash(full.country)],
            ['Pincode', dash(full.pincode)],
            ['Permanent Address', dash(full.permanent_address)],
            ['Current Address', dash(full.current_address)],
          ]} />
        </Section>
      )}

      {tab === 'ids' && (
        <>
          <Section title="ID & Documents">
            <KV rows={[
              ['ID Proof', `${dash(full.id_proof_type)} ${full.id_proof_number ? '· ' + full.id_proof_number : ''}`.trim()],
              ['Aadhaar', <span className="mono">{dash(full.aadhaar)}</span>],
              ['PAN', <span className="mono">{dash(full.pan)}</span>],
              ['Passport', <span className="mono">{dash(full.passport)}</span>],
            ]} />
          </Section>
          <Section title="Uploaded documents">
            <StudentDocuments studentId={Number(student.id)} canManage={canEdit} />
          </Section>
        </>
      )}

      {tab === 'idcard' && (() => {
        const verts = (vidData.data?.verticals ?? []) as any[];
        const multi = verts.length > 1;
        const selected = verts.find((v: any) => Number(v.vertical_id) === Number(idCardVert)) ?? verts[0];
        return (
        <Section title="Student ID Card">
          <div className="notice" style={{ marginBottom: 10 }}>
            <Ic k="award" /><div>A printable identity card with the student photo, the <b>Student ID</b> and the vertical's <b>Roll Number</b>, the course(s) enrolled <b>in that vertical</b> and Branch › Vertical. {multi ? 'This student is enrolled across multiple verticals — pick a vertical to produce its own card (a distinct Roll Number per vertical).' : 'Upload a photo from the header to have it appear on the card.'}</div>
          </div>
          {verts.length ? (
            <div className="min-row" style={{ marginBottom: 12, gap: 8, flexWrap: 'wrap' }} data-testid="idcard-vert-picker">
              {verts.map((v: any) => (
                <button key={v.vertical_id} className={`btn${Number(idCardVert) === Number(v.vertical_id) ? ' primary' : ''}`}
                  onClick={() => setIdCardVert(Number(v.vertical_id))} data-testid={`idcard-vert-${v.vertical_id}`}>
                  <Ic k="grid" />{[v.branch_name, v.vertical_name].filter(Boolean).join(' › ')}
                  <span className="sub mono" style={{ marginLeft: 6 }}>{v.student_vertical_no ?? '—'}</span>
                </button>
              ))}
            </div>
          ) : null}
          {selected ? (
            <div className="sub" style={{ marginBottom: 8 }}>
              Card for <b>{[selected.branch_name, selected.vertical_name].filter(Boolean).join(' › ')}</b> — Roll Number <b className="mono">{selected.student_vertical_no ?? '—'}</b>
              {selected.courses?.length ? <> · Courses: {selected.courses.join(', ')}</> : null}
            </div>
          ) : null}
          <div className="fbp-btns" style={{ marginBottom: 12 }}>
            <button className="btn primary" onClick={() => openIdCard(idCardVert)} data-testid="idcard-open"><Ic k="award" />Preview / Download PDF</button>
            <button className="btn" onClick={() => idCardData.reload()}><Ic k="refresh" />Regenerate</button>
          </div>
          {idCardData.data?.url ? (
            <iframe title="Student ID Card" src={idCardData.data.url} style={{ width: '100%', height: 620, border: '1px solid var(--border)', borderRadius: 8 }} />
          ) : (
            <div className="empty-note">Click <b>Preview / Download PDF</b> to open the ID card, or Regenerate to build a fresh preview here.</div>
          )}
        </Section>
        );
      })()}

      {tab === 'education' && (
        <Section title="Education">
          <KV rows={[
            ['Qualification', dash(full.qualification)],
            ['Institution', dash(full.institution)],
            ['Board / University', dash(full.board_university)],
            ['Passing Year', dash(full.passing_year)],
            ['Previous Institution', dash(full.previous_institution)],
          ]} />
        </Section>
      )}

      {tab === 'academics' && (
        <>
          <Section title="Batch">
            <KV rows={[
              ['Current Batch', ac?.current_batch?.name ?? full.batch_name ?? 'Not assigned'],
              ['Transfers', String(ac?.transfers?.length ?? 0)],
              ['Waitlist (waiting)', String(ac?.waitlist?.length ?? 0)],
            ]} />
            {ac?.transfers?.length ? (
              <table className="minitbl"><thead><tr><th>When</th><th>From</th><th>To</th><th>Reason</th></tr></thead>
                <tbody>{ac.transfers.map((t: any) => (
                  <tr key={t.id}><td>{dt(t.created_at)}</td><td>{t.from_batch_name ?? '—'}</td><td>{t.to_batch_name ?? '—'}</td><td>{t.reason ?? '—'}</td></tr>
                ))}</tbody></table>
            ) : null}
          </Section>
          <Section title="Branch Transfers">
            {ac?.branch_transfers?.length ? (
              <table className="minitbl"><thead><tr><th>When</th><th>From</th><th>To</th><th>Batch</th><th>By</th><th>Reason</th></tr></thead>
                <tbody>{ac.branch_transfers.map((t: any) => (
                  <tr key={t.id}>
                    <td>{dt(t.created_at)}</td>
                    <td>{[t.from_branch_name, t.from_vertical_name].filter(Boolean).join(' › ') || '—'}</td>
                    <td>{[t.to_branch_name, t.to_vertical_name].filter(Boolean).join(' › ') || '—'}</td>
                    <td>{t.to_batch_name ?? '—'}</td>
                    <td>{t.transferred_by_name ?? '—'}</td>
                    <td>{t.reason ?? '—'}</td>
                  </tr>
                ))}</tbody></table>
            ) : <Empty t="No branch transfers yet." />}
          </Section>
          <Section title="Tests & Scores">
            {ac?.tests?.length ? (
              <table className="minitbl"><thead><tr><th>Test</th><th>Type</th><th>Date</th><th>Score</th><th>Grade</th></tr></thead>
                <tbody>{ac.tests.map((t: any) => (
                  <tr key={t.id}><td>{t.test_name}</td><td>{t.test_type}</td><td>{dmy(t.test_date)}</td>
                    <td>{t.marks_obtained != null ? `${t.marks_obtained} / ${t.max_marks}` : '—'}</td><td>{t.grade ?? '—'}</td></tr>
                ))}</tbody></table>
            ) : <Empty t="No test scores yet." />}
          </Section>
          <Section title="Assignments">
            {ac?.assignments?.length ? (
              <table className="minitbl"><thead><tr><th>Assignment</th><th>Due</th><th>Status</th><th>Marks</th></tr></thead>
                <tbody>{ac.assignments.map((a: any) => (
                  <tr key={a.id}><td>{a.title}</td><td>{dmy(a.due_date)}</td><td>{a.status}</td>
                    <td>{a.marks != null ? `${a.marks}${a.max_marks ? ' / ' + a.max_marks : ''}` : '—'}</td></tr>
                ))}</tbody></table>
            ) : <Empty t="No assignments yet." />}
          </Section>
          {canEdit && (
            <Section title="Manage">
              <div className="form-grid">
                <div className="fld">
                  <label htmlFor="stu-batch">Batch</label>
                  <select id="stu-batch" className="ainp" value={full.batch_id ?? ''} disabled={busy}
                    onChange={(e) => patch({ batch_id: e.target.value ? Number(e.target.value) : null }, 'Batch updated')}>
                    <option value="">— Not assigned —</option>
                    {batches.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.batch_code})</option>)}
                    {full.batch_id && !batches.some((b) => Number(b.id) === Number(full.batch_id))
                      ? <option value={full.batch_id}>{full.batch_name}</option> : null}
                  </select>
                </div>
                <div className="fld">
                  <label htmlFor="stu-status">Status</label>
                  <select id="stu-status" className="ainp" value={full.status} disabled={busy}
                    onChange={(e) => patch({ status: e.target.value }, `Marked ${e.target.value}`)}>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </div>
              </div>
            </Section>
          )}
        </>
      )}

      {tab === 'attendance' && (
        <>
          <Section title="Attendance Summary">
            <KV rows={[
              ['Present %', att?.summary?.present_pct != null ? `${att.summary.present_pct}%` : '—'],
              ['Present', String(att?.summary?.present ?? 0)],
              ['Absent', String(att?.summary?.absent ?? 0)],
              ['Half-day', String(att?.summary?.half_day ?? 0)],
              ['Late', String(att?.summary?.late ?? 0)],
              ['Excused', String(att?.summary?.excused ?? 0)],
              ['Total Sessions', String(att?.summary?.total ?? 0)],
            ]} />
          </Section>
          <Section title="Attendance Records">
            {att?.records?.length ? (
              <table className="minitbl"><thead><tr><th>Date</th><th>Batch</th><th>Status</th><th>Mode</th></tr></thead>
                <tbody>{att.records.map((r: any) => (
                  <tr key={r.id}><td>{dmy(r.session_date)}</td><td>{r.batch_name ?? '—'}</td>
                    <td>{renderCell({ b: [r.status, r.status === 'present' ? 'b-green' : r.status === 'absent' ? 'b-red' : 'b-amber'] } as Cell)}</td>
                    <td>{r.mode ?? '—'}</td></tr>
                ))}</tbody></table>
            ) : <Empty t="No attendance records yet." />}
          </Section>
        </>
      )}

      {tab === 'certs' && (
        <Section title="Certificates">
          {prof?.certificates?.length ? (
            <table className="minitbl"><thead><tr><th>Serial</th><th>Type</th><th>Title</th><th>Issued</th><th>Status</th></tr></thead>
              <tbody>{prof.certificates.map((c: any) => (
                <tr key={c.id}><td className="mono">{c.serial_no}</td><td>{c.cert_type}</td><td>{c.title}</td><td>{dmy(c.issue_date)}</td>
                  <td>{renderCell({ b: [c.status, c.status === 'issued' ? 'b-green' : 'b-gray'] } as Cell)}</td></tr>
              ))}</tbody></table>
          ) : <Empty t="No certificates issued yet." />}
        </Section>
      )}

      {tab === 'reportcards' && (
        <Section title="Report Cards">
          {prof?.report_cards?.length ? (
            <table className="minitbl"><thead><tr><th>Term</th><th>Attendance</th><th>Tests</th><th>Overall</th><th>Grade</th><th>Status</th></tr></thead>
              <tbody>{prof.report_cards.map((r: any) => (
                <tr key={r.id}><td>{r.term}</td><td>{r.attendance_pct != null ? `${r.attendance_pct}%` : '—'}</td>
                  <td>{r.test_avg_pct != null ? `${r.test_avg_pct}%` : '—'}</td><td>{r.overall_pct != null ? `${r.overall_pct}%` : '—'}</td>
                  <td>{r.overall_grade ?? '—'}</td><td>{renderCell({ b: [r.status, r.status === 'published' ? 'b-green' : 'b-gray'] } as Cell)}</td></tr>
              ))}</tbody></table>
          ) : <Empty t="No report cards yet." />}
        </Section>
      )}

      {tab === 'status' && (
        <>
          <Section title="Current Status">
            <KV rows={[
              ['Status', <span>{renderCell(studentStatusCell(full.status))} <span className="sub" style={{ fontSize: 11 }}>· {LMS_HINT[statusMeta(full.status).lms]}</span></span>],
              ['Reason', dash(full.status_reason)],
              ['Last Attendance', full.status_last_attendance_date ? dmy(full.status_last_attendance_date) : '—'],
              ['Effective Date', full.status_effective_date ? dmy(full.status_effective_date) : '—'],
              ['Outstanding (snapshot)', full.status_outstanding_minor != null ? money(full.status_outstanding_minor) : '—'],
              ['Approved By', dash(full.status_approved_by_name)],
              ['Changed By', dash(full.status_changed_by_name)],
              ['Changed At', full.status_changed_at ? dt(full.status_changed_at) : '—'],
            ]} />
            {canEdit && <button className="btn primary" style={{ marginTop: 8 }} onClick={() => setShowStatus(true)}><Ic k="flag" />Change status</button>}
          </Section>
          <Section title="LMS Access">
            {lmsErr ? <div className="notice warn"><Ic k="lock" /><div>{lmsErr}</div></div>
              : lms ? (
                <KV rows={[
                  ['Access level', <b>{String(lms.lms_access).toUpperCase()}</b>],
                  ['Can start tests', lms.can_attempt ? 'Yes' : 'No'],
                  ['Can view material', lms.can_view_material ? 'Yes' : 'No'],
                  ['Published material', String((lms.material ?? []).length)],
                  ['Course content', String((lms.course_content ?? []).length)],
                  ['Syllabus', String((lms.syllabus ?? []).length)],
                ]} />
              ) : <Empty t="Loading LMS access…" />}
          </Section>
          <Section title="Status History">
            {(statusHist.data ?? []).length ? (
              <table className="minitbl"><thead><tr><th>When</th><th>From</th><th>To</th><th>Reason</th><th>Outstanding</th><th>Approved By</th><th>By</th></tr></thead>
                <tbody>{(statusHist.data ?? []).map((h: any) => (
                  <tr key={h.id}><td>{dt(h.changed_at)}</td><td>{h.from_label ?? h.from_status ?? '—'}</td>
                    <td>{renderCell(studentStatusCell(h.to_status))}</td><td>{dash(h.reason)}</td>
                    <td>{h.outstanding_minor != null ? money(h.outstanding_minor) : '—'}</td>
                    <td>{dash(h.approved_by_name)}</td><td>{dash(h.changed_by_name)}</td></tr>
                ))}</tbody></table>
            ) : <Empty t="No status changes yet." />}
          </Section>
        </>
      )}

      {tab === 'enrollments' && (
        <Section title="Course Enrollment">
          <div className="notice" style={{ marginBottom: 10 }}>
            <Ic k="grid" /><div>Overall student status: <b>{statusMeta(full.status).label}</b>. Each course enrollment carries its <b>own</b> status — completing or cancelling one course does <b>not</b> change the others or the overall student status. The <b>Roll Number is per vertical</b> (vertical-code format) and each enrolment carries its own <b>Enrolment Number</b> (course-code format), alongside its <b>Branch › Vertical › Course</b>.</div>
          </div>
          {(enrolData.data?.vertical_ids ?? []).length ? (
            <div className="min-row" style={{ marginBottom: 10, gap: 8, flexWrap: 'wrap' }} data-testid="enrol-vertical-ids">
              {(enrolData.data.vertical_ids as any[]).map((v: any) => (
                <span key={v.vertical_id} className="bdg b-indigo">
                  {[v.branch_name, v.vertical_name].filter(Boolean).join(' › ')}: <b className="mono">{v.student_vertical_no ?? '—'}</b>
                </span>
              ))}
            </div>
          ) : null}
          {canEdit && <button className="btn primary" style={{ marginBottom: 10 }} onClick={() => setAddEnrol(true)} data-testid="enrol-add"><Ic k="plus" />Enroll in another course</button>}
          {(enrolData.data?.enrolments ?? []).length ? (
            <>
              {/* dev/109 — choosable columns (show/hide), persisted per user, per list. */}
              <div className="min-row" style={{ justifyContent: 'flex-end', marginBottom: 8 }}>
                <ColumnsButton cols={ENROL_COL_LABELS} ids={enrolCols.ids} hidden={enrolCols.hidden} onToggle={enrolCols.toggle} onReset={enrolCols.reset} />
              </div>
              <table className="minitbl"><thead><tr>{enrolCols.visibleIdx.map((ci) => <th key={ci}>{ENROL_COL_LABELS[ci]}</th>)}</tr></thead>
                <tbody>{(enrolData.data.enrolments as any[]).map((e: any) => {
                  const disc = Number(e.discount_amount_minor ?? e.discount_minor ?? 0);
                  // Cells aligned 1:1 with ENROL_COL_LABELS — only the chosen columns are rendered.
                  const cells: ReactNode[] = [
                    <b className="mono" data-testid={`enrol-vid-${e.id}`}>{e.student_vertical_no ?? '—'}</b>,
                    <span className="mono" data-testid={`enrol-enrolno-${e.id}`}>{e.enrolment_no ?? '—'}</span>,
                    e.branch_name ?? '—',
                    e.vertical_name ?? '—',
                    <><b className="nm">{e.course_name ?? '—'}</b><div className="sub" data-testid={`enrol-path-${e.id}`}>{e.path || [e.branch_name, e.vertical_name, e.course_name].filter(Boolean).join(' › ')}</div></>,
                    e.level_summary ? <b data-testid={`enrol-levels-${e.id}`}>{e.level_summary}</b> : <span className="sub" data-testid={`enrol-levels-${e.id}`}>—</span>,
                    <><b>{money(e.total_fee_minor ?? e.gross_fee_minor ?? e.fee_minor)}</b>{disc > 0 && <div className="sub" style={{ fontSize: 10 }}>− {money(disc)}{e.discount_type === 'percent' ? ` (${Number(e.discount_value)}%)` : ''}</div>}</>,
                    <b>{money(e.net_fee_minor)}</b>,
                    e.payment_plan ?? '—',
                    // dev/100 (client): Balance / Due Fee = net fee - fees paid (from the API's outstanding_minor).
                    <><b style={{ color: Number(e.outstanding_minor ?? 0) > 0 ? '#b91c1c' : '#15803d' }} data-testid={`enrol-balance-${e.id}`}>{money(e.outstanding_minor ?? 0)}</b>{Number(e.paid_minor ?? 0) > 0 && <div className="sub" style={{ fontSize: 10 }}>paid {money(e.paid_minor)}</div>}</>,
                    <>{renderCell(studentStatusCell(e.course_status))}{e.status === 'cancelled' && e.course_status !== 'cancelled' ? <div className="sub" style={{ fontSize: 10 }}>revenue excl.</div> : null}</>,
                    e.batch_name ?? '—',
                    e.start_date ? dt(e.start_date) : dt(e.created_at),
                    <span className="sub">{String(e.effective_lms_access ?? '').toUpperCase()}</span>,
                    <span style={{ whiteSpace: 'nowrap' }}>
                      {/* Client Aug 2026 (#4a) — read-only View, visible to everyone (incl. users
                          without edit permission) so they can still see the full enrolment details. */}
                      <button className="btn" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => setEnrolViewFor(e)} data-testid={`enrol-view-${e.id}`}><Ic k="eye" />View</button>
                      {canEdit && <>{' '}<button className="btn" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => setEnrolEditFor(e)} data-testid={`enrol-edit-${e.id}`}><Ic k="pencil" />Edit</button></>}
                      {canEdit && e.status !== 'cancelled' && <>{' '}<button className="btn" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => setEnrolLevelFor(e)} data-testid={`enrol-addlevel-${e.id}`}><Ic k="plus" />Add level</button></>}
                      {canEdit && <>{' '}<button className="btn" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => setEnrolStatusFor(e)} data-testid={`enrol-status-${e.id}`}><Ic k="flag" />Status</button></>}
                      {canEdit && <>{' '}<button className="btn" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => setEnrolXferFor(e)} data-testid={`enrol-xfer-${e.id}`}><Ic k="swap" />Transfer course</button></>}
                      {' '}<button className="btn" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => setEnrolHistFor(e)}><Ic k="list" />History</button>
                    </span>,
                  ];
                  return <tr key={e.id} data-testid={`enrol-row-${e.id}`}>{enrolCols.visibleIdx.map((ci) => <td key={ci}>{cells[ci]}</td>)}</tr>;
                })}</tbody></table>
            </>
          ) : <Empty t="No course enrollments yet — use the Enroll in another course button." />}
        </Section>
      )}

      {tab === 'placements' && (
        <PlacementsTab studentId={student.id} canApply={can('student.update')} />
      )}

      {tab === 'learning' && (
        <Section title="My Syllabus & Course Content">
          <div className="notice" style={{ marginBottom: 10 }}><Ic k="book" /><div>Published syllabus &amp; course content for the course(s) you are enrolled in. Access follows your LMS status — a cancelled / withdrawn / dropped-out course is locked.</div></div>
          {(learnData.data?.courses ?? []).length ? (learnData.data.courses as any[]).map((c: any) => (
            <div key={c.enrolment_id} style={{ padding: 12, marginBottom: 10, border: '1px solid var(--border)', borderRadius: 8 }} data-testid={`learn-course-${c.enrolment_id}`}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <b>{c.course_name ?? '—'}</b>
                <span>{renderCell(studentStatusCell(c.course_status))} <span className="sub">{String(c.effective_lms_access ?? '').toUpperCase()}</span></span>
              </div>
              {c.blocked ? <div className="notice warn" style={{ marginTop: 8 }}><Ic k="lock" /><div>Content locked for this course (no LMS access for its current status).</div></div> : (
                <>
                  <div className="sub" style={{ marginTop: 8, fontWeight: 600 }}>Syllabus</div>
                  {(c.syllabus ?? []).length ? <ul>{(c.syllabus as any[]).map((x: any) => <li key={x.id}>{x.title} <span className="sub">v{x.version}</span></li>)}</ul> : <div className="sub">No published syllabus.</div>}
                  <div className="sub" style={{ marginTop: 8, fontWeight: 600 }}>Course Content</div>
                  {(c.course_content ?? []).length ? <ul>{(c.course_content as any[]).map((x: any) => <li key={x.id}>{x.module_no != null ? `${x.module_no}. ` : ''}{x.title}</li>)}</ul> : <div className="sub">No published content.</div>}
                  <div className="sub" style={{ marginTop: 8, fontWeight: 600 }}>Study Material</div>
                  {(c.material ?? []).length ? <ul>{(c.material as any[]).map((x: any) => <li key={x.id}>{x.title} <span className="sub">{x.material_type}</span></li>)}</ul> : <div className="sub">No published material.</div>}
                </>
              )}
            </div>
          )) : <Empty t="No enrolled courses with published content yet." />}
        </Section>
      )}

      {tab === 'leadjourney' && (
        <Section title="Lead Journey">
          {leadJourney.loading ? <div className="sub">Loading…</div> : (() => {
            const lj = leadJourney.data;
            const lead = lj?.lead;
            if (!lead) return <Empty t="No originating lead — student created directly." />;
            const acts = (lj?.activities ?? []) as any[];
            const fus = (lj?.follow_ups ?? []) as any[];
            // lead_activity.from_value/to_value are jsonb — render a safe string, never an object.
            const sval = (v: any) => v == null ? '—' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
            return (
              <div data-testid="lead-journey">
                <div className="notice" style={{ marginBottom: 10 }}>
                  <Ic k="target" /><div>The originating lead this student was converted from — its record and full activity journey. This is the "leads record" carried over on conversion.</div>
                </div>
                <KV rows={[
                  ['Lead', <span>{lead.full_name ?? '—'} <span className="sub mono">· #{lead.id}</span></span>],
                  ['Phone', dash(lead.phone)],
                  ['Email', dash(lead.email)],
                  ['Path', dash(lead.path)],
                  ['Source', dash(lead.source_name)],
                  ['Campaign', dash(lead.campaign_name)],
                  ['Stage', dash(lead.stage_name)],
                  ['Status', dash(lead.status_name)],
                  ['Course (as lead)', dash(lead.course_name)],
                  ['Lead Counsellor', dash(lead.owner_name)],
                  ['Created', dt(lead.created_at)],
                  ['Last activity', lead.last_activity_at ? dt(lead.last_activity_at) : '—'],
                ]} />
                <div className="sub" style={{ marginTop: 14, fontWeight: 600 }}>Activity Timeline</div>
                {acts.length ? (
                  <ul className="timeline" style={{ marginTop: 6 }}>
                    {acts.map((a: any) => (
                      <li key={a.id} style={{ marginBottom: 6 }} data-testid={`lj-act-${a.id}`}>
                        <span className="bdg b-slate" style={{ marginRight: 6 }}>{a.type}</span>
                        {a.note ? <span>{String(a.note)}</span> : (a.from_value != null || a.to_value != null ? <span className="sub">{sval(a.from_value)} → {sval(a.to_value)}</span> : null)}
                        <span className="sub mono" style={{ marginLeft: 8 }}>{dt(a.occurred_at)}{a.actor_name ? ` · ${a.actor_name}` : ''}</span>
                      </li>
                    ))}
                  </ul>
                ) : <div className="sub" style={{ marginTop: 6 }}>No activity recorded on the lead.</div>}
                <div className="sub" style={{ marginTop: 14, fontWeight: 600 }}>Follow-ups</div>
                {fus.length ? (
                  <table className="minitbl" style={{ marginTop: 6 }}><thead><tr>
                    <th>Scheduled</th><th>Type</th><th>Disposition</th><th>Status</th><th>Lead Counsellor</th><th>Notes</th>
                  </tr></thead>
                    <tbody>{fus.map((f: any) => (
                      <tr key={f.id}>
                        <td>{dt(f.scheduled_at)}</td>
                        <td>{dash(f.type_name)}</td>
                        <td>{dash(f.disposition_name)}</td>
                        <td>{dash(f.status)}</td>
                        <td>{dash(f.owner_name)}</td>
                        <td>{dash(f.notes)}</td>
                      </tr>
                    ))}</tbody></table>
                ) : <div className="sub" style={{ marginTop: 6 }}>No follow-ups on the lead.</div>}
              </div>
            );
          })()}
        </Section>
      )}

      {tab === 'admission' && (
        <Section title="Admission Journey">
          <div className="notice" style={{ marginBottom: 10 }}>
            <Ic k="check" /><div>The admission funnel: <b>Lead → Course → Payment → Invoice/Receipt → Approved</b> (authorized person only) <b>→ Student Confirmation → Admitted</b>. Approval &amp; student confirmation are enforced gates.</div>
          </div>
          {(journeyData.data?.enrolments ?? []).length ? (journeyData.data.enrolments as any[]).map((j: any) => {
            const clr = (st: string) => st === 'done' ? '#16a34a' : st === 'current' ? '#2563eb' : st === 'blocked' ? '#dc2626' : '#cbd5e1';
            const ic = (st: string) => st === 'done' ? 'check' : st === 'current' ? 'flag' : st === 'blocked' ? 'x' : 'clock';
            return (
              <div key={j.enrolment_id} style={{ padding: 12, marginBottom: 12, border: '1px solid var(--border)', borderRadius: 8 }} data-testid={`admj-enrol-${j.enrolment_id}`}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div><b>{j.course_name ?? '—'}</b> <span className="sub mono">· {j.enrolment_no}</span></div>
                  <span className="pill" style={{ background: j.is_rejected ? '#fee2e2' : j.is_admitted ? '#dcfce7' : '#dbeafe', color: j.is_rejected ? '#b91c1c' : j.is_admitted ? '#15803d' : '#1d4ed8', padding: '2px 10px', borderRadius: 999, fontSize: 11, fontWeight: 700 }} data-testid={`admj-current-${j.enrolment_id}`}>
                    {j.is_rejected ? 'Rejected' : j.is_admitted ? 'Admitted' : `Current: ${(j.stages.find((x: any) => x.stage === j.current_stage)?.label) ?? j.current_stage}`}
                  </span>
                </div>
                {j.is_rejected && j.rejected && (
                  <div className="notice warn" style={{ marginBottom: 8 }}><Ic k="x" /><div>Rejected — {j.rejected.reason}{j.rejected.by ? ` · by ${j.rejected.by}` : ''}{j.rejected.at ? ` · ${dt(j.rejected.at)}` : ''}</div></div>
                )}
                <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {j.stages.map((s: any, i: number) => (
                    <li key={s.stage} style={{ display: 'flex', gap: 10, paddingBottom: i === j.stages.length - 1 ? 0 : 14, position: 'relative' }} data-testid={`admj-step-${j.enrolment_id}-${s.stage}`} data-status={s.status}>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                        <span style={{ width: 24, height: 24, borderRadius: 999, background: clr(s.status), color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Ic k={ic(s.status)} /></span>
                        {i < j.stages.length - 1 && <span style={{ flex: 1, width: 2, background: s.status === 'done' ? '#16a34a' : 'var(--border)', marginTop: 2, minHeight: 14 }} />}
                      </div>
                      <div style={{ flex: 1, paddingTop: 1 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                          <b style={{ color: s.status === 'pending' ? 'var(--muted, #94a3b8)' : 'inherit', fontWeight: s.status === 'current' ? 800 : 600 }}>{s.label}</b>
                          {s.at && <span className="sub" style={{ fontSize: 11 }}>{dt(s.at)}</span>}
                        </div>
                        {s.detail && <div className="sub" style={{ fontSize: 12 }}>{s.detail}</div>}
                        {s.by && <div className="sub" style={{ fontSize: 11 }}>by {s.by}</div>}
                      </div>
                    </li>
                  ))}
                </ol>
                {!j.is_rejected && !j.is_admitted && (
                  <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    {j.next?.action === 'approve' && canApproveAdm && j.next.can && (
                      <button className="btn primary" onClick={() => setAdmActionFor({ enrolment: j, action: 'approve' })} data-testid={`admj-approve-${j.enrolment_id}`}><Ic k="check" />Approve admission &amp; payment</button>
                    )}
                    {j.next?.action === 'confirm' && canEdit && j.next.can && (
                      <button className="btn primary" onClick={() => setAdmActionFor({ enrolment: j, action: 'confirm' })} data-testid={`admj-confirm-${j.enrolment_id}`}><Ic k="flag" />Record student confirmation</button>
                    )}
                    {j.next?.action === 'admit' && canEdit && j.next.can && (
                      <button className="btn primary" onClick={() => setAdmActionFor({ enrolment: j, action: 'admit' })} data-testid={`admj-admit-${j.enrolment_id}`}><Ic k="award" />Convert to admission</button>
                    )}
                    {canApproveAdm && (
                      <button className="btn" style={{ color: '#b91c1c', borderColor: '#fca5a5' }} onClick={() => setAdmActionFor({ enrolment: j, action: 'reject' })} data-testid={`admj-reject-${j.enrolment_id}`}><Ic k="x" />Reject</button>
                    )}
                    {j.next?.action && !j.next.can && j.next.reason && <span className="sub" style={{ fontSize: 12 }}>{j.next.reason}</span>}
                  </div>
                )}
              </div>
            );
          }) : <Empty t="No enrolments to show an admission journey for yet." />}
        </Section>
      )}

      {tab === 'fees' && (
        <>
          <Section title="Collection Summary">
            <KV rows={[
              ['Net Fee', money(fees?.summary?.net_fee_minor)],
              ['Collected', money(fees?.summary?.collected_minor)],
              ['Balance', money(fees?.summary?.balance_minor)],
              ['Receipts', String(fees?.summary?.receipt_count ?? 0)],
            ]} />
          </Section>
          {/* dev/80 — Fee Management: Branch > Vertical + Actions (fee setup / edit / reminder /
              collect / download receipt), reusing the standalone Fee Management components (dev/76). */}
          <Section title="Fee Management">
            {fees?.enrolments?.length ? (
              <table className="minitbl"><thead><tr>
                {/* Client Aug 2026 (#4b) — the SAME columns as the Course Enrollment list:
                    Roll No, Enrolment No, Branch, Vertical, Course, Level, Total, Net, Fee Plan,
                    Due, Status (+ Actions). Aligns the fee view with dev/109/115. */}
                <th>Roll Number</th><th>Enrolment Number</th><th>Branch</th><th>Vertical</th><th>Course</th><th>Level</th><th>Total Fee</th><th>Net Fee</th><th>Fee Plan</th><th>Due Fee</th><th>Status</th><th>Actions</th>
              </tr></thead>
                <tbody>{fees.enrolments.map((e: any) => (
                  <tr key={e.id} data-testid={`fee-enrol-row-${e.id}`}>
                    <td className="mono" data-testid={`fee-roll-no-${e.id}`}>{e.student_vertical_no ?? '—'}</td>
                    <td className="mono">{e.enrolment_no ?? '—'}</td>
                    <td>{e.branch_name ?? '—'}</td>
                    <td>{e.vertical_name ?? '—'}</td>
                    <td>{e.course_name ?? '—'}</td>
                    <td>{e.level_summary ? <b>{e.level_summary}</b> : <span className="sub">{'—'}</span>}</td>
                    <td>{money(e.total_fee_minor ?? e.gross_fee_minor ?? e.fee_minor)}</td>
                    <td><b>{money(e.net_fee_minor)}</b></td>
                    <td>{e.payment_plan ?? '—'}</td>
                    <td><b style={{ color: Number(e.outstanding_minor ?? 0) > 0 ? '#b91c1c' : '#15803d' }} data-testid={`fee-due-${e.id}`}>{money(e.outstanding_minor ?? 0)}</b></td>
                    <td>{e.course_status ? renderCell(studentStatusCell(e.course_status)) : (e.status ?? '—')}</td>
                    <td><div className="rowacts">
                      {canPlanCreate && <button className="icon-btn sm" title="Fee setup (payment plan)" onClick={() => setFeePlanFor(Number(e.id))}><Ic k="cfg" /></button>}
                      {e.plan_id ? <button className="icon-btn sm" title="View schedule" onClick={() => setFeePlanEditFor(Number(e.plan_id))}><Ic k="eye" /></button> : null}
                      <button className="icon-btn sm" title="Send fee reminder" onClick={() => void feeRemind(Number(e.id))}><Ic k="bell" /></button>
                      {canFeeCollect && <button className="icon-btn sm" title="Collect fee" onClick={() => setFeeCollectFor(Number(e.id))}><Ic k="rupee" /></button>}
                      <button className="icon-btn sm" title="Download latest receipt" onClick={() => void feeDownloadReceipt(Number(e.id))}><Ic k="doc" /></button>
                    </div></td>
                  </tr>
                ))}</tbody></table>
            ) : <Empty t="Not linked to an enrolment yet." />}
          </Section>
          {/* dev/80 — Fee Receipt Records: Branch > Vertical > Course + Actions (view / download),
              reusing ReceiptViewModal + the receipt-PDF endpoint from the standalone screen. */}
          <Section title="Fee Receipt Records">
            {fees?.receipts?.length ? (
              <>
                {/* dev/109 — choosable columns (show/hide) incl. Roll No / Enrolment No / Level and
                    the enrolment's Total/Net/Due fee, Fee Plan & Status; persisted per user, per list. */}
                <div className="min-row" style={{ justifyContent: 'flex-end', marginBottom: 8 }}>
                  <ColumnsButton cols={RECEIPT_COL_LABELS} ids={receiptCols.ids} hidden={receiptCols.hidden} onToggle={receiptCols.toggle} onReset={receiptCols.reset} />
                </div>
                <table className="minitbl"><thead><tr>{receiptCols.visibleIdx.map((ci) => <th key={ci}>{RECEIPT_COL_LABELS[ci]}</th>)}</tr></thead>
                  <tbody>{fees.receipts.map((r: any) => {
                    // Cells aligned 1:1 with RECEIPT_COL_LABELS — only the chosen columns render.
                    const cells: ReactNode[] = [
                      <span className="mono">{r.receipt_no}</span>,
                      // Roll Number (vertical-code id) for the enrolment this receipt belongs to.
                      <span className="mono" data-testid={`receipt-roll-no-${r.id}`}>{r.student_vertical_no ?? '—'}</span>,
                      // dev/108 #3 — the course-code enrolment number this receipt belongs to.
                      <span className="mono" data-testid={`receipt-enrol-no-${r.id}`}>{r.enrolment_no ?? '—'}</span>,
                      r.branch_name ?? '—',
                      r.vertical_name ?? '—',
                      r.course_name ?? '—',
                      r.level_summary ? <b data-testid={`receipt-levels-${r.id}`}>{r.level_summary}</b> : <span className="sub" data-testid={`receipt-levels-${r.id}`}>{'—'}</span>,
                      money(r.total_fee_minor),
                      money(r.net_fee_minor),
                      r.payment_plan ?? '—',
                      <b style={{ color: Number(r.outstanding_minor ?? 0) > 0 ? '#b91c1c' : '#15803d' }}>{money(r.outstanding_minor ?? 0)}</b>,
                      r.course_status ? renderCell(studentStatusCell(r.course_status)) : '—',
                      <b>{money(r.amount_minor)}</b>,
                      r.mode,
                      dt(r.received_at),
                      <div className="rowacts">
                        <button className="icon-btn sm" title="View receipt" onClick={() => setFeeReceiptView({ ...r, lead_name: r.lead_name ?? full.full_name })}><Ic k="eye" /></button>
                        <button className="icon-btn sm" title="Download receipt PDF" onClick={() => openPdfAuthed(`/fees/receipts/${r.id}/pdf`)}><Ic k="doc" /></button>
                      </div>,
                    ];
                    return <tr key={r.id} data-testid={`receipt-row-${r.id}`}>{receiptCols.visibleIdx.map((ci) => <td key={ci}>{cells[ci]}</td>)}</tr>;
                  })}</tbody></table>
              </>
            ) : <Empty t="No fee receipts yet." />}
          </Section>
        </>
      )}
          </div>
        </div>
      </div>
      {showTransfer && (
        <TransferStudentModal student={full}
          onClose={() => setShowTransfer(false)}
          onDone={() => { setShowTransfer(false); loadProfile(); onChanged(); }} />
      )}
      {showStatus && (
        <ChangeStatusModal student={full} outstandingMinor={fees?.summary?.balance_minor}
          canManageSensitive={canStatusManage}
          onClose={() => setShowStatus(false)}
          onDone={() => { setShowStatus(false); loadProfile(); onChanged(); }} />
      )}
      {addEnrol && (
        <AddEnrolmentModal student={full}
          onClose={() => setAddEnrol(false)}
          onDone={() => { setAddEnrol(false); reloadEnrol(); }} />
      )}
      {/* dev/80 — Fee Management actions on the Fees tab reuse the standalone modals + endpoints. */}
      {feePlanFor != null && <EnrolmentFeeSetupModal enrolmentId={feePlanFor} onClose={() => setFeePlanFor(null)} onSaved={() => { setFeePlanFor(null); loadProfile(); }} />}
      {feePlanEditFor != null && <PlanDetailModal id={feePlanEditFor} onClose={() => setFeePlanEditFor(null)} onChanged={loadProfile} />}
      {feeCollectFor != null && <CollectModal enrolmentId={feeCollectFor} onClose={() => setFeeCollectFor(null)} onSaved={() => { setFeeCollectFor(null); loadProfile(); }} />}
      {feeReceiptView && <ReceiptViewModal r={feeReceiptView} onClose={() => setFeeReceiptView(null)} />}
      {enrolStatusFor && (
        <ChangeEnrolmentStatusModal student={full} enrolment={enrolStatusFor} canManageSensitive={canStatusManage}
          onClose={() => setEnrolStatusFor(null)}
          onDone={() => { setEnrolStatusFor(null); reloadEnrol(); }} />
      )}
      {enrolEditFor && (
        <EditEnrolmentModal student={full} enrolment={enrolEditFor} canManageSensitive={canStatusManage}
          onClose={() => setEnrolEditFor(null)}
          onDone={() => { setEnrolEditFor(null); reloadEnrol(); loadProfile(); }} />
      )}
      {enrolViewFor && (
        <ViewEnrolmentModal enrolment={enrolViewFor} onClose={() => setEnrolViewFor(null)} />
      )}
      {enrolXferFor && (
        <TransferEnrolmentCourseModal student={full} enrolment={enrolXferFor}
          onClose={() => setEnrolXferFor(null)}
          onDone={() => { setEnrolXferFor(null); reloadEnrol(); loadProfile(); }} />
      )}
      {enrolLevelFor && (
        <AddEnrolmentLevelModal student={full} enrolment={enrolLevelFor}
          onClose={() => setEnrolLevelFor(null)}
          onDone={() => { setEnrolLevelFor(null); reloadEnrol(); loadProfile(); }} />
      )}
      {enrolHistFor && (
        <EnrolmentHistoryModal student={full} enrolment={enrolHistFor} onClose={() => setEnrolHistFor(null)} />
      )}
      {admActionFor && (
        <AdmissionActionModal enrolment={admActionFor.enrolment} action={admActionFor.action}
          onClose={() => setAdmActionFor(null)}
          onDone={() => { setAdmActionFor(null); reloadJourney(); }} />
      )}
    </DetailModal>
  );
}

/**
 * ADMISSION ACTION — the approve / reject / confirm / admit modal for the Admission Journey
 * (migration 075). POSTs to the scope-enforced /enrolments/:id/admission/* endpoints; the API is
 * the real gate (approve requires admission.approve + a payment & invoice; confirm needs a
 * method; admit only from student_confirmed; reject needs remarks).
 */
export function AdmissionActionModal({ enrolment, action, onClose, onDone }:
  { enrolment: any; action: string; onClose: () => void; onDone: () => void }) {
  const [remarks, setRemarks] = useState('');
  const [via, setVia] = useState('in_person');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const eid = enrolment.enrolment_id;
  const titles: Record<string, string> = { approve: 'Approve admission & payment', reject: 'Reject admission', confirm: 'Record student confirmation', admit: 'Convert to admission' };
  const ctas: Record<string, string> = { approve: 'Approve', reject: 'Reject', confirm: 'Save confirmation', admit: 'Admit' };

  const submit = async () => {
    if (action === 'reject' && !remarks.trim()) { toast('Remarks are required to reject.', true); return; }
    if (action === 'confirm' && via === 'manual' && !note.trim()) { toast('A reason is required for a manual confirmation.', true); return; }
    setBusy(true);
    try {
      if (action === 'approve') await api.post(`/enrolments/${eid}/admission/approve`, { remarks: remarks.trim() || null });
      else if (action === 'reject') await api.post(`/enrolments/${eid}/admission/reject`, { remarks: remarks.trim() });
      else if (action === 'confirm') await api.post(`/enrolments/${eid}/admission/confirm`, { student_confirmed_via: via, note: note.trim() || null });
      else if (action === 'admit') await api.post(`/enrolments/${eid}/admission/admit`, { note: note.trim() || null });
      toast(action === 'admit' ? 'Converted to admission.' : action === 'approve' ? 'Admission & payment approved.' : action === 'confirm' ? 'Student confirmation recorded.' : 'Admission rejected.');
      onDone();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };

  return (
    <DetailModal title={`${titles[action]} — ${enrolment.enrolment_no}`} icon="check" onClose={onClose} width={480}
      footer={<button className={`btn ${action === 'reject' ? '' : 'primary'}`} onClick={submit} disabled={busy} data-testid="admj-action-save">{ctas[action]}</button>}>
      <div className="notice" style={{ marginBottom: 10 }}><Ic k="check" /><div>{enrolment.course_name ?? 'Course'} · <span className="mono">{enrolment.enrolment_no}</span></div></div>
      {action === 'confirm' && (
        <div className="fld"><label htmlFor="adm-via">Confirmation method <span className="star">*</span></label>
          <select id="adm-via" className="ainp" value={via} disabled={busy} onChange={(e) => setVia(e.target.value)} data-testid="admj-via">
            <option value="in_person">In person</option>
            <option value="phone">Phone</option>
            <option value="email">Email</option>
            <option value="signed_form">Signed form</option>
            {/* dev/84 item 5 — manual override when the student\u2019s confirmation cannot be captured (technical issue). */}
            <option value="manual">Manual confirmation (technical issue)</option>
          </select>
          <div className="sub" style={{ fontSize: 11, marginTop: 4 }}>{via === 'manual'
            ? 'Manual override \u2014 record a reason below; it is stamped with your name as the person who confirmed.'
            : 'OTP / e-sign capture can be added later \u2014 this records the confirmation event.'}</div>
        </div>
      )}
      {(action === 'confirm' || action === 'admit') && (
        <div className="fld"><label htmlFor="adm-note">{action === 'confirm' && via === 'manual' ? <>Reason <span className="star">*</span></> : 'Note'}</label>
          <input id="adm-note" className="ainp" value={note} disabled={busy}
            placeholder={action === 'confirm' && via === 'manual' ? 'e.g. Confirmed manually \u2014 OTP/e-sign channel down' : 'Optional note'}
            onChange={(e) => setNote(e.target.value)} data-testid="admj-note" />
        </div>
      )}
      {(action === 'approve' || action === 'reject') && (
        <div className="fld"><label htmlFor="adm-rem">Remarks {action === 'reject' ? <span className="star">*</span> : '(optional)'}</label>
          <textarea id="adm-rem" className="ainp" rows={3} value={remarks} disabled={busy}
            placeholder={action === 'reject' ? 'Why is this admission rejected?' : 'Any note for the approval'} onChange={(e) => setRemarks(e.target.value)} data-testid="admj-remarks" />
        </div>
      )}
    </DetailModal>
  );
}

/**
 * TRANSFER STUDENT — move a student to another Branch (strict cascade Branch -> Vertical ->
 * optional Batch) with a reason. Posts to POST /students/:id/transfer; the API re-parents the
 * student, clears/sets the batch, and writes a branch-transfer history row (scoped both ends).
 */
export function TransferStudentModal({ student, onClose, onDone }: { student: any; onClose: () => void; onDone: () => void }) {
  const ref = useRef_();
  const [branchId, setBranchId] = useState<string>('');
  const [verticalId, setVerticalId] = useState<string>('');
  const [batchId, setBatchId] = useState<string>('');
  const [reason, setReason] = useState<string>('');
  const [busy, setBusy] = useState(false);

  const vOpts = ref.verticals.filter((vt: any) => String(vt.branch_id) === branchId);
  const batches = useFetch<any[]>(
    branchId && verticalId ? `/batches?branch_id=${branchId}&vertical_id=${verticalId}&status=active` : null,
    [branchId, verticalId]);

  const save = async () => {
    if (!branchId) { toast('Choose a target branch.', true); return; }
    if (!verticalId) { toast('Choose a target vertical.', true); return; }
    setBusy(true);
    try {
      const res = await api.post<any>(`/students/${student.id}/transfer`, {
        to_branch_id: Number(branchId), to_vertical_id: Number(verticalId),
        to_batch_id: batchId ? Number(batchId) : null, reason: reason.trim() || null,
      });
      toast(res?.waitlisted ? 'Transferred — target batch full, student waitlisted.' : 'Student transferred.');
      onDone();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };

  return (
    <DetailModal title={`Transfer — ${student.full_name}`} icon="swap" onClose={onClose} width={520}
      footer={<button className="btn primary" onClick={save} disabled={busy} data-testid="stu-transfer-save"><Ic k="swap" />Transfer</button>}>
      <div className="notice" style={{ marginBottom: 10 }}>
        <Ic k="branch" />
        <div>Currently in <b>{[student.branch_name, student.vertical_name].filter(Boolean).join(' › ') || '—'}</b>
          {student.batch_name ? <> · batch <b>{student.batch_name}</b></> : null}.</div>
      </div>
      <div className="form-grid">
        <div className="fld">
          <label htmlFor="tr-branch">Target Branch <span className="star">*</span></label>
          <select id="tr-branch" className="ainp" value={branchId} disabled={busy}
            onChange={(e) => { setBranchId(e.target.value); setVerticalId(''); setBatchId(''); }}>
            <option value="">— Choose branch —</option>
            {ref.branches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
        <div className="fld">
          <label htmlFor="tr-vertical">Target Vertical <span className="star">*</span></label>
          <select id="tr-vertical" className="ainp" value={verticalId} disabled={busy || !branchId}
            onChange={(e) => { setVerticalId(e.target.value); setBatchId(''); }}>
            <option value="">— Choose vertical —</option>
            {vOpts.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </div>
        <div className="fld">
          <label htmlFor="tr-batch">Target Batch (optional)</label>
          <select id="tr-batch" className="ainp" value={batchId} disabled={busy || !verticalId}
            onChange={(e) => setBatchId(e.target.value)}>
            <option value="">— No batch —</option>
            {(batches.data ?? []).map((b: any) => <option key={b.id} value={b.id}>{b.name} ({b.batch_code})</option>)}
          </select>
        </div>
        <div className="fld" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="tr-reason">Reason</label>
          <input id="tr-reason" className="ainp" value={reason} disabled={busy}
            placeholder="Why is the student moving?" onChange={(e) => setReason(e.target.value)} />
        </div>
      </div>
    </DetailModal>
  );
}

/**
 * CHANGE STATUS — the lifecycle transition modal (migration 073). Selecting a status reveals
 * exactly the fields that status needs: SENSITIVE statuses (On Hold / Suspended / Withdrawn /
 * Dropped Out / Cancelled — catalog requires_approval) require a Reason, Last Attendance Date,
 * an effective date (Hold Start / Dropout) and an Approved-By user, and show the outstanding-fee
 * snapshot (prefilled read-only from dues). Validation mirrors the API; the API is the real gate.
 * Sensitive options + the Approved-By picker are hidden from users lacking student.status_manage.
 */
export function ChangeStatusModal({ student, outstandingMinor, canManageSensitive, onClose, onDone }:
  { student: any; outstandingMinor?: number; canManageSensitive: boolean; onClose: () => void; onDone: () => void }) {
  const ref = useRef_();
  const catalog = useFetch<any[]>(`/students/status-catalog`, []);
  const [toStatus, setToStatus] = useState<string>('');
  const [reason, setReason] = useState('');
  const [lastAtt, setLastAtt] = useState(student.status_last_attendance_date ? String(student.status_last_attendance_date).slice(0, 10) : '');
  const [effective, setEffective] = useState('');
  const [approvedBy, setApprovedBy] = useState<string>('');
  const [busy, setBusy] = useState(false);

  const all = catalog.data ?? [];
  const opts = all.filter((o) => canManageSensitive || !o.requires_approval);
  const def = all.find((o) => o.code === toStatus);
  const sensitive = !!def?.requires_approval;
  const effLabel = toStatus === 'on_hold' ? 'Hold Start Date' : 'Dropout Date';
  const money = (minor: any) => fmtINR(Number(minor ?? 0), { symbol: true });

  const save = async () => {
    if (!toStatus) { toast('Choose a status.', true); return; }
    if (sensitive) {
      if (!reason.trim()) { toast('Reason is required for this status.', true); return; }
      if (!lastAtt) { toast('Last Attendance Date is required.', true); return; }
      if (!effective) { toast(`${effLabel} is required.`, true); return; }
      if (!approvedBy) { toast('Approved By is required.', true); return; }
    }
    setBusy(true);
    try {
      const res = await api.post<any>(`/students/${student.id}/status`, {
        to_status: toStatus,
        reason: reason.trim() || null,
        last_attendance_date: lastAtt || null,
        effective_date: effective || null,
        approved_by: sensitive && approvedBy ? Number(approvedBy) : null,
      });
      toast(res?.unchanged ? 'Status unchanged.' : `Status set to ${def?.label ?? toStatus}.`);
      onDone();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };

  return (
    <DetailModal title={`Change status — ${student.full_name}`} icon="flag" onClose={onClose} width={560}
      footer={<button className="btn primary" onClick={save} disabled={busy || !toStatus} data-testid="stu-status-save"><Ic k="flag" />Update status</button>}>
      <div className="notice" style={{ marginBottom: 10 }}>
        <Ic k="flag" /><div>Currently <b>{statusMeta(student.status).label}</b> · {LMS_HINT[statusMeta(student.status).lms]}</div>
      </div>
      <div className="form-grid">
        <div className="fld" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="cs-status">New Status <span className="star">*</span></label>
          <select id="cs-status" className="ainp" value={toStatus} disabled={busy}
            onChange={(e) => setToStatus(e.target.value)} data-testid="stu-status-select">
            <option value="">— Choose status —</option>
            {opts.map((o) => <option key={o.code} value={o.code}>{o.label} — {String(o.lms_access).toUpperCase()} LMS</option>)}
          </select>
          {def ? <div className="sub" style={{ marginTop: 4, fontSize: 11 }}>{def.meaning} · {LMS_HINT[statusMeta(def.code).lms]}</div> : null}
        </div>
        {(sensitive || (def && def.requires_reason)) && (
          <div className="fld" style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="cs-reason">Reason {sensitive ? <span className="star">*</span> : null}</label>
            <input id="cs-reason" className="ainp" value={reason} disabled={busy}
              placeholder={toStatus === 'on_hold' ? 'Hold reason' : toStatus === 'suspended' ? 'Suspension reason' : toStatus === 'dropped_out' ? 'Dropout reason' : 'Reason'}
              onChange={(e) => setReason(e.target.value)} />
          </div>
        )}
        {sensitive && (
          <>
            <div className="fld">
              <label htmlFor="cs-lastatt">Last Attendance Date <span className="star">*</span></label>
              <input id="cs-lastatt" type="date" className="ainp" value={lastAtt} disabled={busy} onChange={(e) => setLastAtt(e.target.value)} />
            </div>
            <div className="fld">
              <label htmlFor="cs-eff">{effLabel} <span className="star">*</span></label>
              <input id="cs-eff" type="date" className="ainp" value={effective} disabled={busy} onChange={(e) => setEffective(e.target.value)} />
            </div>
            <div className="fld">
              <label htmlFor="cs-out">Outstanding Fee (snapshot)</label>
              <input id="cs-out" className="ainp" value={money(outstandingMinor)} readOnly disabled title="Snapshotted at the moment of change" />
            </div>
            <div className="fld">
              <label htmlFor="cs-appr">Approved By <span className="star">*</span></label>
              <select id="cs-appr" className="ainp" value={approvedBy} disabled={busy} onChange={(e) => setApprovedBy(e.target.value)}>
                <option value="">— Choose approver —</option>
                {selectableUsers(ref.users).map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
          </>
        )}
      </div>
    </DetailModal>
  );
}

/**
 * SHARED FEE CONFIGURATION (client feedback items 6 & 7) — the ONE discount + payment-plan
 * control used identically by (a) Enroll-in-another-course, (b) Fee Management → Fee setup,
 * and (c) Edit enrollment. Discount by amount ₹ / percentage %, live Gross · Discount · Net,
 * payment plan Full / Installments / Custom + down payment, and a schedule preview that sums
 * to the net. Owning the state in a hook keeps the three surfaces byte-for-byte the same.
 */
type FeePlanKind = 'full' | 'installment' | 'custom';
export interface FeeConfig {
  fee: string; setFee: (v: string) => void;
  discType: EnrolDiscountType; setDiscType: (v: EnrolDiscountType) => void;
  discValue: string; setDiscValue: (v: string) => void;
  plan: FeePlanKind; setPlan: (v: FeePlanKind) => void;
  count: string; setCount: (v: string) => void;
  down: string; setDown: (v: string) => void;
  rows: Array<{ amount: string; date: string }>; setRows: React.Dispatch<React.SetStateAction<Array<{ amount: string; date: string }>>>;
  start: string; setStart: (v: string) => void;
  grossMinor: number; dv: number; discount_minor: number; net_minor: number;
  downMinor: number; customAmounts: number[]; customDates: string[];
  sched: ReturnType<typeof previewSchedule>; planIntent: string;
}
export function useFeeConfig(init?: {
  fee?: string; discType?: EnrolDiscountType; discValue?: string; plan?: FeePlanKind;
  count?: string; down?: string; start?: string;
}): FeeConfig {
  const [fee, setFee] = useState(init?.fee ?? '');
  const [discType, setDiscType] = useState<EnrolDiscountType>(init?.discType ?? 'none');
  const [discValue, setDiscValue] = useState(init?.discValue ?? '');
  const [plan, setPlan] = useState<FeePlanKind>(init?.plan ?? 'full');
  const [count, setCount] = useState(init?.count ?? '3');
  const [down, setDown] = useState(init?.down ?? '');
  const [rows, setRows] = useState<Array<{ amount: string; date: string }>>([{ amount: '', date: '' }]);
  const [start, setStart] = useState(init?.start ?? '');
  const grossMinor = Math.round(Number(fee || 0) * 100);
  const dv = discType === 'percent' ? Number(discValue || 0) : Math.round(Number(discValue || 0) * 100);
  const { discount_minor, net_minor } = enrolDiscount(grossMinor, discType, dv);
  const downMinor = Math.round(Number(down || 0) * 100);
  const customAmounts = rows.map((r) => Math.round(Number(r.amount || 0) * 100));
  const customDates = rows.map((r) => r.date).filter(Boolean);
  const sched = previewSchedule({
    plan_type: plan, net_minor, down_minor: downMinor,
    num_installments: Math.max(1, Number(count) || 1), start_date: start || undefined,
    custom_amounts_minor: plan === 'custom' ? customAmounts : undefined,
    custom_dates: plan === 'custom' && customDates.length === rows.length ? rows.map((r) => r.date) : undefined,
  });
  const planIntent = plan === 'full' ? 'full'
    : plan === 'installment' ? (Number(count) === 3 ? 'emi_3' : Number(count) === 6 ? 'emi_6' : 'custom')
    : 'custom';
  return { fee, setFee, discType, setDiscType, discValue, setDiscValue, plan, setPlan, count, setCount,
    down, setDown, rows, setRows, start, setStart, grossMinor, dv, discount_minor, net_minor, downMinor,
    customAmounts, customDates, sched, planIntent };
}
/** Build the POST /payment-plans body from a FeeConfig (shared by all three surfaces). */
export function feePlanBody(cfg: FeeConfig, enrolmentId: number) {
  return {
    enrolment_id: enrolmentId, plan_type: cfg.plan, frequency: cfg.plan === 'full' ? 'once' : 'monthly',
    down_payment_minor: cfg.downMinor,
    num_installments: cfg.plan === 'installment' ? Math.max(1, Number(cfg.count) || 1) : undefined,
    custom_amounts_minor: cfg.plan === 'custom' ? cfg.customAmounts : undefined,
    custom_dates: cfg.plan === 'custom' && cfg.customDates.length === cfg.rows.length ? cfg.rows.map((r) => r.date) : undefined,
    start_date: cfg.start || null,
  };
}
/** The discount + payment-plan + net + schedule preview fields. `showFee` renders the editable
 *  gross-fee input (Enroll + Edit); Fee setup on the dues list shows the fee read-only above). */
export function FeeConfigFields({ cfg, disabled, showFee = true, hideDiscount = false, capCtx }: { cfg: FeeConfig; disabled?: boolean; showFee?: boolean; hideDiscount?: boolean; capCtx?: { branch_id?: number | null; vertical_id?: number | null; course_id?: number | null } }) {
  const setRow = (i: number, patch: Partial<{ amount: string; date: string }>) =>
    cfg.setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  // dev/103 — the DISCOUNT MASTER cap hint. When a scope (branch/vertical/course) is known,
  // resolve the applicable cap and warn when the entered discount EXCEEDS it: the over-cap
  // portion needs an authorized user's approval (Academic Admin / Org / Super Admin).
  const [cap, setCap] = useState<{ cap: { max_percent: number | null; max_amount_minor: number | null } | null; cap_minor: number | null } | null>(null);
  const capKey = capCtx ? `${capCtx.branch_id ?? ''}|${capCtx.vertical_id ?? ''}|${capCtx.course_id ?? ''}|${cfg.grossMinor}` : '';
  useEffect(() => {
    if (!capCtx || !cfg.grossMinor) { setCap(null); return; }
    const p = new URLSearchParams();
    if (capCtx.branch_id) p.set('branch_id', String(capCtx.branch_id));
    if (capCtx.vertical_id) p.set('vertical_id', String(capCtx.vertical_id));
    if (capCtx.course_id) p.set('course_id', String(capCtx.course_id));
    p.set('base', String(cfg.grossMinor));
    let dead = false;
    api.get<any>(`/discounts/effective?${p.toString()}`).then((r) => { if (!dead) setCap(r); }).catch(() => { if (!dead) setCap(null); });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capKey]);
  const capMinor = cap?.cap_minor ?? null;
  const overCap = !hideDiscount && capMinor != null && cfg.discount_minor > capMinor;
  const capLabel = cap?.cap
    ? [cap.cap.max_percent != null ? `${cap.cap.max_percent}%` : null, cap.cap.max_amount_minor != null ? fmtINR(cap.cap.max_amount_minor) : null].filter(Boolean).join(' / ')
    : '';
  return (
    <>
      {showFee && (
        <div className="fld"><label htmlFor="ae-fee">Course fee (₹) — from master</label>
          <input id="ae-fee" className="ainp" type="number" value={cfg.fee} disabled={disabled} onChange={(e) => cfg.setFee(e.target.value)} placeholder="e.g. 20000" data-testid="enrol-fee" /></div>
      )}
      {/* DISCOUNT — amount OR percent (hidden when the discount is entered per level above) */}
      {!hideDiscount && (
        <div className="fld"><label htmlFor="ae-dtype">Discount</label>
          <select id="ae-dtype" className="ainp" value={cfg.discType} disabled={disabled} onChange={(e) => { cfg.setDiscType(e.target.value as EnrolDiscountType); cfg.setDiscValue(''); }} data-testid="enrol-disc-type">
            <option value="none">No discount</option>
            <option value="amount">By amount (₹)</option>
            <option value="percent">By percentage (%)</option>
          </select>
        </div>
      )}
      {!hideDiscount && (
        <div className="fld"><label htmlFor="ae-dval">{cfg.discType === 'percent' ? 'Discount %' : 'Discount ₹'}</label>
          <input id="ae-dval" className="ainp" type="number" value={cfg.discValue} disabled={disabled || cfg.discType === 'none'}
            onChange={(e) => cfg.setDiscValue(e.target.value)} placeholder={cfg.discType === 'percent' ? 'e.g. 10' : 'e.g. 2000'} data-testid="enrol-disc-value" /></div>
      )}
      {/* GROSS / DISCOUNT / NET */}
      <div className="fld" style={{ gridColumn: '1 / -1' }}>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', padding: '8px 10px', background: 'var(--surface-2, #f8fafc)', borderRadius: 8, fontSize: 13 }}>
          <div>Gross fee: <b data-testid="enrol-gross">{fmtINR(cfg.grossMinor)}</b></div>
          <div>Discount: <b style={{ color: 'var(--red, #b91c1c)' }} data-testid="enrol-discamt">− {fmtINR(cfg.discount_minor)}</b></div>
          <div>Net fee after discount: <b style={{ color: 'var(--green, #15803d)' }} data-testid="enrol-net">{fmtINR(cfg.net_minor)}</b></div>
        </div>
      </div>
      {/* dev/103 — Discount Master cap hint + over-cap warning */}
      {!hideDiscount && capCtx && capMinor != null && (
        <div className="fld" style={{ gridColumn: '1 / -1' }} data-testid="enrol-cap-hint">
          {overCap ? (
            <div className="notice warn" style={{ marginTop: 0 }}><Ic k="bolt" /><div>
              This discount <b>exceeds the discount cap</b>{capLabel ? ` (${capLabel})` : ''} — max {fmtINR(capMinor)} on this fee.
              Only up to the cap will apply now; the <b>excess needs approval</b> from an authorized user
              (Academic Admin / Org / Super Admin) before it takes effect.
            </div></div>
          ) : (
            <div className="sub" style={{ marginTop: 2 }}>Discount cap{capLabel ? ` (${capLabel})` : ''}: up to <b>{fmtINR(capMinor)}</b> on this fee.</div>
          )}
        </div>
      )}
      {/* PAYMENT PLAN */}
      <div className="fld"><label htmlFor="ae-plan">Payment plan</label>
        <select id="ae-plan" className="ainp" value={cfg.plan} disabled={disabled} onChange={(e) => cfg.setPlan(e.target.value as FeePlanKind)} data-testid="enrol-plan">
          <option value="full">Full payment</option>
          <option value="installment">Installments (fixed count)</option>
          <option value="custom">Custom (own amounts)</option>
        </select>
      </div>
      {cfg.plan === 'installment' && (
        <div className="fld"><label htmlFor="ae-count">Number of installments</label>
          <input id="ae-count" className="ainp" type="number" min={1} value={cfg.count} disabled={disabled} onChange={(e) => cfg.setCount(e.target.value)} data-testid="enrol-count" /></div>
      )}
      {cfg.plan !== 'full' && (
        <div className="fld"><label htmlFor="ae-down">Down payment (₹, optional)</label>
          <input id="ae-down" className="ainp" type="number" value={cfg.down} disabled={disabled} onChange={(e) => cfg.setDown(e.target.value)} placeholder="0" data-testid="enrol-down" /></div>
      )}
      <div className="fld"><label htmlFor="ae-start">Start / first due date</label>
        <input id="ae-start" className="ainp" type="date" value={cfg.start} disabled={disabled} onChange={(e) => cfg.setStart(e.target.value)} /></div>
      {cfg.plan === 'custom' && (
        <div className="fld" style={{ gridColumn: '1 / -1' }}>
          <label>Custom installments (amounts + due dates must total the payable after down payment)</label>
          <table className="minitbl" style={{ width: '100%' }}>
            <thead><tr><th>#</th><th>Amount (₹)</th><th>Due date</th><th /></tr></thead>
            <tbody>{cfg.rows.map((r, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td><input className="ainp" type="number" style={{ width: 110 }} value={r.amount} onChange={(e) => setRow(i, { amount: e.target.value })} data-testid={`enrol-crow-amt-${i}`} /></td>
                <td><input className="ainp" type="date" value={r.date} onChange={(e) => setRow(i, { date: e.target.value })} /></td>
                <td>{cfg.rows.length > 1 && <button className="ax" title="Remove" onClick={() => cfg.setRows((rs) => rs.filter((_, idx) => idx !== i))}><Ic k="x" /></button>}</td>
              </tr>
            ))}</tbody>
          </table>
          <button className="btn" style={{ marginTop: 6 }} onClick={() => cfg.setRows((rs) => [...rs, { amount: '', date: '' }])}><Ic k="plus" />Add installment</button>
        </div>
      )}
      {cfg.plan !== 'full' && (
        <div className="fld" style={{ gridColumn: '1 / -1' }}>
          <label>Schedule preview</label>
          <table className="minitbl" style={{ width: '100%' }} data-testid="enrol-schedule">
            <thead><tr><th>#</th><th>Due</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
            <tbody>{cfg.sched.rows.map((r) => (
              <tr key={r.seq_no}><td>{r.label}</td><td>{r.due_date}</td><td style={{ textAlign: 'right' }}>{fmtINR(r.amount_minor)}</td></tr>
            ))}</tbody>
            <tfoot><tr>
              <td colSpan={2} style={{ fontWeight: 700 }}>Total</td>
              <td style={{ textAlign: 'right', fontWeight: 700, color: cfg.sched.balances ? 'var(--green,#15803d)' : 'var(--red,#b91c1c)' }} data-testid="enrol-sched-total">{fmtINR(cfg.sched.sum_minor)}</td>
            </tr></tfoot>
          </table>
          {!cfg.sched.balances && <div className="form-err" style={{ marginTop: 4 }}>{cfg.sched.error || `The schedule must total the net fee ${fmtINR(cfg.net_minor)}.`}</div>}
        </div>
      )}
    </>
  );
}

/** The payload the level picker reports up to its host modal. Per-level discount carries a type
 *  toggle (% / ₹) + value in the user's natural unit — the SERVER computes the paise amount. */
export type LevelDiscType = 'amount' | 'percent';
export interface LevelSelection {
  hasLevels: boolean; totalMinor: number; netMinor: number; discountMinor: number; scope: 'overall' | 'level';
  levels: Array<{ course_level_id: number; code: string; fee_minor: number; discount_type?: LevelDiscType; discount_value?: number; discount_minor?: number }>;
}
/** Optional seed so the SAME picker reopens a saved enrolment (Edit) with its levels pre-selected
 *  and their per-level discount pre-filled. */
export interface LevelSeed { courseId: string | number; scope: 'overall' | 'level'; levels: Array<{ code: string; discount_minor?: number }>; }

/** Per-level discount amount (paise) from a type + natural value, clamped to the level fee. */
function perLevelDiscMinor(feeMinor: number, type: LevelDiscType, rawValue: string | number): number {
  const v = Number(rawValue || 0);
  if (!Number.isFinite(v) || v <= 0) return 0;
  const dm = type === 'percent' ? Math.round((feeMinor * Math.min(v, 100)) / 100) : Math.round(v * 100);
  return Math.max(0, Math.min(dm, feeMinor));
}
/**
 * ENROLLMENT LEVEL PICKER (batch 2 + dev/110 per-level discount) — when the chosen course has
 * Levels, pick one or MORE; the fee AUTO-SUMS (Total = Σ level fees). The discount can be OVERALL
 * (the Discount control below) or LEVEL-wise — each selected level gets its own discount with a
 * type toggle (% / ₹) and a live per-level net; the picker shows Gross / Discount / Net totals.
 * A student can take the next level a year later at a DIFFERENT discount, so discounts are tracked
 * per level. Renders nothing for a course with no levels (the classic single-Standard-Fee path).
 */
export function EnrolLevelPicker({ courseId, disabled, onChange, seed }:
  { courseId: string; disabled?: boolean; onChange: (p: LevelSelection) => void; seed?: LevelSeed }) {
  const [levels, setLevels] = useState<any[]>([]);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [scope, setScope] = useState<'overall' | 'level'>('overall');
  const [disc, setDisc] = useState<Record<string, string>>({});
  const [discType, setDiscType] = useState<Record<string, LevelDiscType>>({});
  const seededFor = useRef<string>('');
  useEffect(() => {
    setSel({}); setDisc({}); setDiscType({}); setScope('overall'); setLevels([]); seededFor.current = '';
    if (!courseId) return;
    api.get<any[]>(`/courses/${courseId}/levels`).then((rows) => setLevels(rows ?? [])).catch(() => setLevels([]));
  }, [courseId]);
  // Seed once, after the master levels load, when editing THIS enrolment's course.
  useEffect(() => {
    if (!seed || !levels.length) return;
    if (String(seed.courseId) !== String(courseId)) return;
    if (seededFor.current === String(courseId)) return;
    seededFor.current = String(courseId);
    const s: Record<string, boolean> = {}; const dv: Record<string, string> = {}; const dt: Record<string, LevelDiscType> = {};
    for (const sl of seed.levels) {
      const code = String(sl.code); s[code] = true; dt[code] = 'amount';
      if (Number(sl.discount_minor || 0) > 0) dv[code] = String(Number(sl.discount_minor) / 100);
    }
    setSel(s); setDisc(dv); setDiscType(dt); setScope(seed.scope === 'level' ? 'level' : 'overall');
  }, [levels, seed, courseId]);
  const chosen = levels.filter((l) => sel[String(l.code)]);
  const totalMinor = chosen.reduce((s, l) => s + Number(l.fee_minor || 0), 0);
  const perDiscMinor = (l: any) => perLevelDiscMinor(Number(l.fee_minor || 0), discType[String(l.code)] || 'amount', disc[String(l.code)] || '');
  const discountMinor = scope === 'level' ? chosen.reduce((s, l) => s + perDiscMinor(l), 0) : 0;
  const netMinor = totalMinor - discountMinor;
  useEffect(() => {
    onChange({
      hasLevels: levels.length > 0, totalMinor, netMinor, discountMinor, scope,
      levels: chosen.map((l) => ({ course_level_id: Number(l.id), code: String(l.code), fee_minor: Number(l.fee_minor || 0),
        ...(scope === 'level' ? { discount_type: (discType[String(l.code)] || 'amount'), discount_value: Number(disc[String(l.code)] || 0), discount_minor: perDiscMinor(l) } : {}) })),
    });
  }, [levels, sel, scope, disc, discType]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!courseId || !levels.length) return null;
  return (
    <div className="fld" style={{ gridColumn: '1 / -1' }}>
      <label>Levels <span className="star">*</span> <span className="sub" style={{ fontWeight: 400 }}>— select one or more; the fee auto-sums</span></label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 8px', background: 'var(--surface-2,#f8fafc)', borderRadius: 8 }} data-testid="enrol-levels">
        {levels.map((l) => {
          const code = String(l.code); const fee = Number(l.fee_minor || 0);
          const on = !!sel[code]; const lvlNet = fee - perDiscMinor(l);
          return (
            <label key={code} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }} data-testid={`enrol-level-${code}`}>
              <input type="checkbox" disabled={disabled} checked={on} onChange={(e) => setSel((s) => ({ ...s, [code]: e.target.checked }))} data-testid={`enrol-level-cb-${code}`} />
              <b>{code}</b>{l.label && l.label !== code ? <span className="sub">{l.label}</span> : null}
              <span style={{ marginLeft: 'auto' }}>{fmtINR(fee)}</span>
              {scope === 'level' && on && (
                <>
                  <select className="ainp" style={{ width: 60 }} disabled={disabled} value={discType[code] || 'amount'}
                    onChange={(e) => setDiscType((d) => ({ ...d, [code]: e.target.value as LevelDiscType }))} data-testid={`enrol-level-disctype-${code}`}>
                    <option value="amount">₹</option>
                    <option value="percent">%</option>
                  </select>
                  <input className="ainp" style={{ width: 84 }} type="number" placeholder={(discType[code] || 'amount') === 'percent' ? 'e.g. 10' : 'disc ₹'} value={disc[code] || ''}
                    disabled={disabled} onChange={(e) => setDisc((d) => ({ ...d, [code]: e.target.value }))} data-testid={`enrol-level-disc-${code}`} />
                  <span className="sub" data-testid={`enrol-level-net-${code}`} style={{ minWidth: 90, textAlign: 'right' }}>Net {fmtINR(lvlNet)}</span>
                </>
              )}
            </label>
          );
        })}
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
        <input type="checkbox" checked={scope === 'level'} disabled={disabled} onChange={(e) => setScope(e.target.checked ? 'level' : 'overall')} data-testid="enrol-level-scope" />
        <span className="sub">Apply discount per level (otherwise one overall discount below)</span>
      </label>
      <div style={{ marginTop: 6, fontSize: 13, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <span>Total (gross): <b data-testid="enrol-level-total">{fmtINR(totalMinor)}</b></span>
        {scope === 'level' && <>
          <span>Discount: <b style={{ color: 'var(--red,#b91c1c)' }} data-testid="enrol-level-disctotal">− {fmtINR(discountMinor)}</b></span>
          <span>Net: <b style={{ color: 'var(--green,#15803d)' }} data-testid="enrol-level-net">{fmtINR(netMinor)}</b></span>
        </>}
      </div>
    </div>
  );
}

/**
 * ADD ENROLMENT — enrol an existing student into ANOTHER course (course / batch / fee picker).
 * POSTs /students/:id/enrolments; the new enrolment starts active / course_status active. This
 * is what lets a student hold MULTIPLE course enrollments from the Course Enrollment section.
 * A course WITH levels: pick levels (fee auto-sums), ONE enrolment covers them. Without levels:
 * the single Standard Fee path (unchanged).
 */
export function AddEnrolmentModal({ student, onClose, onDone }: { student: any; onClose: () => void; onDone: () => void }) {
  const ref = useRef_();
  const [courseId, setCourseId] = useState('');
  const [branchId, setBranchId] = useState(String(student.branch_id ?? ''));
  const [vertId, setVertId] = useState(String(student.vertical_id ?? ''));
  const [batchId, setBatchId] = useState('');
  const cfg = useFeeConfig();                               // shared discount + payment-plan + net config
  const [batches, setBatches] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [lvl, setLvl] = useState<LevelSelection | null>(null);   // level selection (batch 2), when the course has levels
  // When a level-course is picked, the fee is driven by the summed levels (Total, or Net for a
  // level-wise discount) — feed it into the shared fee config so net/plan/schedule stay correct.
  const onLevels = (p: LevelSelection) => {
    setLvl(p);
    if (p.hasLevels) {
      cfg.setFee(String((p.scope === 'level' ? p.netMinor : p.totalMinor) / 100));
      if (p.scope === 'level') cfg.setDiscType('none');
    }
  };

  // BRANCH -> VERTICAL -> COURSE cascade: a student already has ONE branch + vertical, so we
  // filter the Course list to that vertical (the app models course-under-vertical via meta).
  const coursesAll = (ref.courses ?? []) as any[];
  const courses = coursesAll.filter((c: any) =>
    String((c.meta as any)?.vertical_id ?? '') === String(vertId ?? '') ||
    !((c.meta as any)?.vertical_id));   // courses not scoped to a vertical stay selectable
  // BRANCH -> VERTICAL cascade: the enroll target DEFAULTS to the student's own branch/vertical
  // (the common case is one click) but EITHER can be changed to enrol into another branch/vertical.
  const branches = (ref.branches ?? []) as any[];
  const branchVerticals = ((ref.verticals ?? []) as any[]).filter((v: any) => Number(v.branch_id) === Number(branchId));
  // Changing the Branch clears the downstream Vertical/Course/Batch/fee (a stale vertical from
  // another branch must never be submitted); defaults to that branch's sole vertical if unique.
  const chooseBranch = (bid: string) => {
    setBranchId(bid); setCourseId(''); setBatchId(''); cfg.setFee('');
    const vs = ((ref.verticals ?? []) as any[]).filter((v: any) => Number(v.branch_id) === Number(bid));
    setVertId(vs.length === 1 ? String(vs[0].id) : '');
  };

  useEffect(() => {
    if (!courseId) { setBatches([]); return; }
    api.get<any[]>(`/batches?vertical_id=${vertId}&status=active`)
      .then((bs) => setBatches((bs ?? []).filter((b: any) => Number(b.course_id) === Number(courseId))))
      .catch(() => setBatches([]));
  }, [courseId, vertId]);

  // Choosing a course auto-fills the fee from the Course master (editable).
  const chooseCourse = (cid: string) => {
    setCourseId(cid); setBatchId('');
    const c = coursesAll.find((x: any) => Number(x.id) === Number(cid));
    cfg.setFee(c ? String((c.meta as any)?.fee ?? '') : '');
  };

  const save = async () => {
    if (!branchId) { toast('Choose a branch.', true); return; }
    if (!vertId) { toast('Choose a vertical.', true); return; }
    if (!courseId) { toast('Choose a course.', true); return; }
    if (lvl?.hasLevels && !lvl.levels.length) { toast('Select at least one level for this course.', true); return; }
    if (cfg.plan !== 'full' && !cfg.sched.balances) { toast(cfg.sched.error || 'The installments must sum to the net fee.', true); return; }
    setBusy(true);
    try {
      // 1) create the enrolment (discount computed + capped server-side; net is authoritative).
      //    A level-course sends its selected levels[] + discount_scope; ONE enrolment covers them,
      //    Total = Σ level fees. A no-level course sends its single fee (unchanged).
      const enr = await api.post<any>(`/students/${student.id}/enrolments`, {
        course_id: Number(courseId), batch_id: batchId ? Number(batchId) : null,
        vertical_id: vertId ? Number(vertId) : undefined, branch_id: branchId ? Number(branchId) : undefined,
        fee_minor: cfg.grossMinor, discount_type: cfg.discType, discount_value: cfg.dv,
        payment_plan: cfg.planIntent, start_date: cfg.start || null,
        ...(lvl?.hasLevels ? { levels: lvl.levels, discount_scope: lvl.scope } : {}),
      });
      // 2) build the payment plan as part of enrollment (Full / Installments / Custom + down
      //    payment). A missing payment_plan.create permission never fails the enrollment.
      if (enr?.id) {
        try { await api.post('/payment-plans', feePlanBody(cfg, Number(enr.id))); }
        catch (pe) { toast(`Enrollment added; payment plan not created — ${(pe as Error).message}`, true); }
      }
      toast('Course enrollment added.'); onDone();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };

  return (
    <DetailModal title={`Enroll in another course — ${student.full_name}`} icon="grid" onClose={onClose} width={620}
      footer={<button className="btn primary" onClick={save} disabled={busy || !courseId} data-testid="enrol-add-save"><Ic k="plus" />Add enrollment</button>}>
      <div className="form-grid">
        {/* BRANCH -> VERTICAL -> COURSE cascade — all selectable; defaults to the student's own */}
        <div className="fld"><label htmlFor="ae-branch">Branch <span className="star">*</span></label>
          <select id="ae-branch" className="ainp" value={branchId} disabled={busy}
            onChange={(e) => chooseBranch(e.target.value)} data-testid="enrol-branch">
            <option value="">— Choose branch —</option>
            {branches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
        <div className="fld"><label htmlFor="ae-vert">Vertical <span className="star">*</span></label>
          <select id="ae-vert" className="ainp" value={vertId} disabled={busy || !branchId}
            onChange={(e) => { setVertId(e.target.value); setCourseId(''); setBatchId(''); cfg.setFee(''); }} data-testid="enrol-vertical">
            <option value="">{branchId ? '— Choose vertical —' : '— Choose branch first —'}</option>
            {branchVerticals.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
          <div className="sub" style={{ fontSize: 11 }}>The Roll Number is generated per vertical — enrolling in another vertical mints its own vertical-code Roll Number; the enrolment gets its own course-code Enrolment Number.</div>
        </div>
        <div className="fld" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="ae-course">Course <span className="star">*</span></label><MasterQuickAdd type="course" onAdded={(row) => chooseCourse(String(row.id))} />
          <select id="ae-course" className="ainp" value={courseId} disabled={busy} onChange={(e) => chooseCourse(e.target.value)} data-testid="enrol-course">
            <option value="">— Choose course —</option>
            {courses.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="fld">
          <label htmlFor="ae-batch">Batch</label>
          <select id="ae-batch" className="ainp" value={batchId} disabled={busy} onChange={(e) => setBatchId(e.target.value)}>
            <option value="">— Optional —</option>
            {batches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
        {/* LEVELS (batch 2) — only shown for a course that has levels; fee auto-sums from them */}
        <EnrolLevelPicker courseId={courseId} disabled={busy} onChange={onLevels} />
        {/* DISCOUNT · NET · PAYMENT PLAN · SCHEDULE — shared with Fee setup + Edit enrollment.
            For a level-course the fee comes from the levels, so hide the editable fee input; a
            level-wise discount hides the overall discount (it is entered per level above). */}
        <FeeConfigFields cfg={cfg} disabled={busy} showFee={!lvl?.hasLevels} hideDiscount={lvl?.hasLevels && lvl.scope === 'level'}
          capCtx={{ branch_id: Number(branchId) || null, vertical_id: Number(vertId) || null, course_id: Number(courseId) || null }} />
      </div>
    </DetailModal>
  );
}

/**
 * ADD LEVEL / UPGRADE (batch 2) — add another Level to an EXISTING course-enrolment (e.g. A1 →
 * add A2). NOT a second enrolment: the SAME enrolment's Total/Net grow and its installment plan
 * reconciles server-side. Only levels not already on the enrolment are offered. POSTs
 * /students/:id/enrolments/:eid/levels.
 */
export function AddEnrolmentLevelModal({ student, enrolment, onClose, onDone }:
  { student: any; enrolment: any; onClose: () => void; onDone: () => void }) {
  const [levels, setLevels] = useState<any[]>([]);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [disc, setDisc] = useState<Record<string, string>>({});
  const [discType, setDiscType] = useState<Record<string, LevelDiscType>>({});
  const [busy, setBusy] = useState(false);
  // A level-scoped enrolment carries a discount PER LEVEL, so the level being ADDED can get its own
  // discount (the client's "next level a year later at a different discount" case).
  const levelScope = String(enrolment.discount_scope ?? 'overall') === 'level';
  const already = new Set<string>((enrolment.levels ?? []).map((l: any) => String(l.code).toLowerCase())
    .concat(String(enrolment.level_summary ?? '').split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean)));
  useEffect(() => {
    const cid = enrolment.course_id;
    if (!cid) { setLevels([]); return; }
    api.get<any[]>(`/courses/${cid}/levels`)
      .then((rows) => setLevels((rows ?? []).filter((l: any) => !already.has(String(l.code).toLowerCase()))))
      .catch(() => setLevels([]));
  }, [enrolment.course_id]);   // eslint-disable-line react-hooks/exhaustive-deps
  const chosen = levels.filter((l) => sel[String(l.code)]);
  const addFeeMinor = chosen.reduce((s, l) => s + Number(l.fee_minor || 0), 0);
  const addDiscMinor = levelScope ? chosen.reduce((s, l) => s + perLevelDiscMinor(Number(l.fee_minor || 0), discType[String(l.code)] || 'amount', disc[String(l.code)] || ''), 0) : 0;
  const save = async () => {
    if (!chosen.length) { toast('Select at least one level to add.', true); return; }
    setBusy(true);
    try {
      await api.post(`/students/${student.id}/enrolments/${enrolment.id}/levels`, {
        levels: chosen.map((l) => ({ course_level_id: Number(l.id), code: String(l.code), fee_minor: Number(l.fee_minor || 0),
          ...(levelScope ? { discount_type: (discType[String(l.code)] || 'amount'), discount_value: Number(disc[String(l.code)] || 0) } : {}) })),
      });
      toast('Level added — the enrolment fee and plan were updated.'); onDone();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  return (
    <DetailModal title={`Add level — ${enrolment.course_name ?? enrolment.enrolment_no}`} icon="plus" onClose={onClose} width={540}
      footer={<button className="btn primary" onClick={save} disabled={busy || !chosen.length} data-testid="enrol-addlevel-save"><Ic k="plus" />Add to this enrolment</button>}>
      <div className="form-grid">
        <div className="fld" style={{ gridColumn: '1 / -1' }}>
          <div className="sub" style={{ marginBottom: 6 }}>Current levels: <b>{enrolment.level_summary || '—'}</b>. Adding a level increases the Total &amp; Net of this same enrolment; future installments cover the extra.{levelScope ? ' This enrolment tracks discounts per level, so the new level can take its own discount.' : ''}</div>
          {levels.length ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 8px', background: 'var(--surface-2,#f8fafc)', borderRadius: 8 }} data-testid="addlevel-list">
              {levels.map((l) => {
                const code = String(l.code); const on = !!sel[code];
                return (
                  <label key={code} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }} data-testid={`addlevel-${code}`}>
                    <input type="checkbox" disabled={busy} checked={on} onChange={(e) => setSel((s) => ({ ...s, [code]: e.target.checked }))} data-testid={`addlevel-cb-${code}`} />
                    <b>{code}</b>{l.label && l.label !== code ? <span className="sub">{l.label}</span> : null}
                    <span style={{ marginLeft: 'auto' }}>{fmtINR(Number(l.fee_minor || 0))}</span>
                    {levelScope && on && (
                      <>
                        <select className="ainp" style={{ width: 60 }} disabled={busy} value={discType[code] || 'amount'}
                          onChange={(e) => setDiscType((d) => ({ ...d, [code]: e.target.value as LevelDiscType }))} data-testid={`addlevel-disctype-${code}`}>
                          <option value="amount">₹</option>
                          <option value="percent">%</option>
                        </select>
                        <input className="ainp" style={{ width: 84 }} type="number" placeholder={(discType[code] || 'amount') === 'percent' ? 'e.g. 10' : 'disc ₹'} value={disc[code] || ''}
                          disabled={busy} onChange={(e) => setDisc((d) => ({ ...d, [code]: e.target.value }))} data-testid={`addlevel-disc-${code}`} />
                      </>
                    )}
                  </label>
                );
              })}
            </div>
          ) : <div className="empty-note">No further levels available to add for this course.</div>}
          {chosen.length > 0 && <div style={{ marginTop: 8, fontSize: 13 }}>Adds <b data-testid="addlevel-total">{fmtINR(addFeeMinor)}</b> gross{levelScope && addDiscMinor > 0 ? <> · discount <b style={{ color: 'var(--red,#b91c1c)' }}>− {fmtINR(addDiscMinor)}</b> · net <b style={{ color: 'var(--green,#15803d)' }}>{fmtINR(addFeeMinor - addDiscMinor)}</b></> : null} to the enrolment.</div>}
        </div>
      </div>
    </DetailModal>
  );
}

/**
 * FEE SETUP (client feedback item 7) — the Fee Management → Fee setup action. Opens the SAME
 * fee configuration as Enroll-in-another-course (discount amount/% + net + payment plan
 * Full/Installments/Custom + down payment + schedule preview) bound to an EXISTING enrolment.
 * On save it PATCHes the enrolment's discount/fee (net recomputed + capped server-side) and
 * (re)builds the payment plan — replacing an existing plan when it has no payments applied.
 */
export function EnrolmentFeeSetupModal({ enrolmentId, onClose, onSaved }: { enrolmentId: number; onClose: () => void; onSaved: () => void }) {
  const enr = useFetch<any>(`/enrolments/${enrolmentId}`, [enrolmentId]);
  const planFetch = useFetch<any[]>(`/payment-plans?enrolment_id=${enrolmentId}`, [enrolmentId]);
  const e = enr.data;
  const existingPlan = (planFetch.data ?? []).find((p: any) => p.status === 'active');
  const cfg = useFeeConfig();
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  if (e && !loaded) {
    const dtp = (e.discount_type ?? 'none') as EnrolDiscountType;
    cfg.setFee(String(Number(e.gross_fee_minor ?? e.fee_minor ?? 0) / 100));
    cfg.setDiscType(dtp);
    cfg.setDiscValue(dtp === 'percent' ? String(Number(e.discount_value ?? 0))
      : dtp === 'amount' ? String(Number(e.discount_amount_minor ?? e.discount_minor ?? 0) / 100) : '');
    if (e.start_date) cfg.setStart(String(e.start_date).slice(0, 10));
    setLoaded(true);
  }
  const save = async () => {
    if (cfg.plan !== 'full' && !cfg.sched.balances) { toast(cfg.sched.error || 'The installments must sum to the net fee.', true); return; }
    setBusy(true);
    try {
      // 1) persist the discount/fee on the enrolment (net recomputed + finance-capped server-side)
      await api.patch(`/enrolments/${enrolmentId}`, {
        fee_minor: cfg.grossMinor, discount_type: cfg.discType, discount_value: cfg.dv,
        payment_plan: cfg.planIntent, start_date: cfg.start || undefined,
      });
      // 2) (re)build the payment plan. A plan with money applied cannot be replaced — the
      //    discount still saves and we say so; else swap it for the freshly configured schedule.
      if (existingPlan) {
        try { await api.del(`/payment-plans/${existingPlan.id}`); }
        catch (de) { toast(`Fee saved. The existing plan was kept — ${(de as Error).message}`, true); onSaved(); return; }
      }
      try { await api.post('/payment-plans', feePlanBody(cfg, enrolmentId)); }
      catch (pe) { toast(`Fee saved; payment plan not created — ${(pe as Error).message}`, true); onSaved(); return; }
      toast('Fee setup saved.'); onSaved();
    } catch (err) { toast((err as Error).message, true); } finally { setBusy(false); }
  };
  return (
    <DetailModal title={`Fee setup — ${e?.enrolment_no ?? ''}`} icon="rupee" onClose={onClose} width={620}
      footer={<button className="btn primary" onClick={save} disabled={busy || !e} data-testid="feesetup-save"><Ic k="check" />Save fee setup</button>}>
      {!e ? <div className="fhint">Loading…</div> : (
        <>
          <div className="notice" style={{ marginBottom: 10 }}>
            <Ic k="rupee" /><div>{e.course_name ?? 'Course'} · <span className="mono">{e.enrolment_no}</span> · {[e.branch_name, e.vertical_name].filter(Boolean).join(' › ') || '—'}. Configure the payment plan &amp; discount — same as an enrollment.</div>
          </div>
          <div className="form-grid">
            <FeeConfigFields cfg={cfg} disabled={busy}
              capCtx={{ branch_id: e.branch_id ?? null, vertical_id: e.vertical_id ?? null, course_id: e.course_id ?? null }} />
          </div>
        </>
      )}
    </DetailModal>
  );
}

/**
 * VIEW ENROLMENT (client Aug 2026 #4a) — a READ-ONLY version of the Edit enrolment details, so a
 * user WITHOUT update permission can still see everything the Edit modal edits: course, levels,
 * fee, discount, net, plan, status and dates. No inputs, no save — pure display, built from the
 * enrolment row the Course Enrollment list already has (same shape used by the Edit modal).
 */
export function ViewEnrolmentModal({ enrolment: e, onClose }: { enrolment: any; onClose: () => void }) {
  const money = (minor: any) => fmtINR(Number(minor ?? 0), { symbol: true });
  const dt = (v: any) => fmtDateTimeIST(v);
  const disc = Number(e.discount_amount_minor ?? e.discount_minor ?? 0);
  const discLabel = disc > 0
    ? `${money(disc)}${e.discount_type === 'percent' ? ` (${Number(e.discount_value)}%)` : ''}`
    : '—';
  const path = e.path || [e.branch_name, e.vertical_name, e.course_name].filter(Boolean).join(' › ');
  return (
    <DetailModal title={`View enrollment — ${e.course_name ?? e.enrolment_no ?? ''}`} icon="eye" onClose={onClose} width={640}
      footer={<button className="btn" onClick={onClose} data-testid="enrol-view-close"><Ic k="x" />Close</button>}>
      <div className="notice" style={{ marginBottom: 10 }}>
        <Ic k="eye" /><div>Read-only view of this enrollment. {path || '—'}</div>
      </div>
      <div data-testid="enrol-view-body">
        <KV rows={[
          ['Roll Number', <span className="mono">{e.student_vertical_no ?? '—'}</span>],
          ['Enrolment Number', <span className="mono">{e.enrolment_no ?? '—'}</span>],
          ['Branch', e.branch_name ?? '—'],
          ['Vertical', e.vertical_name ?? '—'],
          ['Course', e.course_name ?? '—'],
          ['Level(s)', e.level_summary ? <b>{e.level_summary}</b> : '—'],
          ['Total Fee', money(e.total_fee_minor ?? e.gross_fee_minor ?? e.fee_minor)],
          ['Discount', discLabel],
          ['Net Fee', <b>{money(e.net_fee_minor)}</b>],
          ['Fee Plan', e.payment_plan ?? '—'],
          ['Paid', money(e.paid_minor ?? 0)],
          ['Due Fee', <b style={{ color: Number(e.outstanding_minor ?? 0) > 0 ? '#b91c1c' : '#15803d' }}>{money(e.outstanding_minor ?? 0)}</b>],
          ['Status', e.course_status ? renderCell(studentStatusCell(e.course_status)) : '—'],
          ['Batch', e.batch_name ?? '—'],
          ['Start / Created', e.start_date ? dt(e.start_date) : dt(e.created_at)],
          ['LMS Access', <span className="sub">{String(e.effective_lms_access ?? '').toUpperCase() || '—'}</span>],
        ]} />
      </div>
    </DetailModal>
  );
}

/**
 * EDIT ENROLMENT (client feedback item 6) — the Edit action on a Course Enrollment row. Opens
 * an edit modal for that enrolment: course (within its Branch › Vertical), fee, discount
 * amount/%, payment plan (Full/Installments/Custom + down), and per-course status. Fee/course/
 * discount/plan persist via PATCH /enrolments/:id (+ plan reconcile); a changed status routes
 * through the dedicated per-enrolment status endpoint (which enforces its own approval rules).
 */
export function EditEnrolmentModal({ student, enrolment, canManageSensitive, onClose, onDone }:
  { student: any; enrolment: any; canManageSensitive: boolean; onClose: () => void; onDone: () => void }) {
  const ref = useRef_();
  const statusCat = useFetch<any[]>(`/students/enrolment-status-catalog`, []);
  const planFetch = useFetch<any[]>(`/payment-plans?enrolment_id=${enrolment.id}`, [enrolment.id]);
  const existingPlan = (planFetch.data ?? []).find((p: any) => p.status === 'active');
  const [courseId, setCourseId] = useState(String(enrolment.course_id ?? ''));
  const [status, setStatus] = useState(String(enrolment.course_status ?? ''));
  const cfg = useFeeConfig({
    fee: String(Number(enrolment.gross_fee_minor ?? enrolment.fee_minor ?? 0) / 100),
    discType: (enrolment.discount_type ?? 'none') as EnrolDiscountType,
    discValue: (enrolment.discount_type === 'percent') ? String(Number(enrolment.discount_value ?? 0))
      : (enrolment.discount_type === 'amount') ? String(Number(enrolment.discount_amount_minor ?? enrolment.discount_minor ?? 0) / 100) : '',
    start: enrolment.start_date ? String(enrolment.start_date).slice(0, 10) : '',
  });
  const [busy, setBusy] = useState(false);
  // LEVEL-WISE EDIT (dev/110) — a level-course enrolment shows its Level line-items with an editable
  // per-level discount + add/remove (same picker as Enroll), seeded from the saved levels. The fee
  // then comes from the levels, not the free-text fee input. A no-level enrolment keeps the classic
  // single-fee edit. Only the ORIGINAL course's levels are seeded (changing course resets them).
  const [lvl, setLvl] = useState<LevelSelection | null>(null);
  const hasLevels = ((enrolment.levels ?? []).length > 0) && String(courseId) === String(enrolment.course_id ?? '');
  const levelSeed: LevelSeed | undefined = (enrolment.levels ?? []).length > 0
    ? { courseId: enrolment.course_id, scope: String(enrolment.discount_scope ?? 'overall') === 'level' ? 'level' : 'overall',
        levels: (enrolment.levels ?? []).map((l: any) => ({ code: String(l.code), discount_minor: Number(l.discount_minor ?? 0) })) }
    : undefined;
  const onLevels = (p: LevelSelection) => {
    setLvl(p);
    if (p.hasLevels) {
      cfg.setFee(String((p.scope === 'level' ? p.netMinor : p.totalMinor) / 100));
      if (p.scope === 'level') cfg.setDiscType('none');
    }
  };
  const levelScope = (lvl?.scope ?? (String(enrolment.discount_scope ?? 'overall') === 'level' ? 'level' : 'overall'));
  // Course list stays within the enrolment's OWN vertical (a vertical/branch move is a Course
  // Transfer, which mints a new vertical-wise ID — kept as its own dedicated action).
  const courses = (ref.courses ?? []).filter((c: any) =>
    String((c.meta as any)?.vertical_id ?? '') === String(enrolment.vertical_id ?? '') ||
    Number(c.id) === Number(enrolment.course_id));
  const chooseCourse = (cid: string) => {
    setCourseId(cid);
    const c = (ref.courses ?? []).find((x: any) => Number(x.id) === Number(cid));
    if (c && (c.meta as any)?.fee != null) cfg.setFee(String((c.meta as any).fee));
  };
  const statusOpts = (statusCat.data ?? []).filter((o: any) => canManageSensitive || !o.requires_approval);
  const save = async () => {
    if (!courseId) { toast('Choose a course.', true); return; }
    if (hasLevels && lvl?.hasLevels && !lvl.levels.length) { toast('Keep at least one level on this enrolment.', true); return; }
    if (cfg.plan !== 'full' && !cfg.sched.balances) { toast(cfg.sched.error || 'The installments must sum to the net fee.', true); return; }
    setBusy(true);
    try {
      // 1) course / fee / discount / plan intent — via the student-scoped enrolment-update route
      //    (dev/104 DEF-2: lead-less enrolments 404'd on PATCH /enrolments/:id; DEF-4: this path
      //    runs the Discount Master over-cap decision — net recomputed + capped server-side).
      //    A level-course enrolment sends its edited levels[] + discount_scope (dev/110): the server
      //    re-syncs the level line-items (add/remove + per-level discount) and recomputes Total/Net.
      await api.patch(`/students/${student.id}/enrolments/${enrolment.id}`, {
        course_id: Number(courseId),
        fee_minor: cfg.grossMinor, discount_type: cfg.discType, discount_value: cfg.dv,
        payment_plan: cfg.planIntent, start_date: cfg.start || undefined,
        ...(hasLevels && lvl?.hasLevels ? { levels: lvl.levels, discount_scope: lvl.scope } : {}),
      });
      // 2) reconcile the payment plan (replace when it carries no payments)
      if (existingPlan) {
        try { await api.del(`/payment-plans/${existingPlan.id}`); await api.post('/payment-plans', feePlanBody(cfg, Number(enrolment.id))); }
        catch (pe) { toast(`Saved. Payment plan unchanged — ${(pe as Error).message}`, true); }
      } else {
        try { await api.post('/payment-plans', feePlanBody(cfg, Number(enrolment.id))); }
        catch (pe) { toast(`Saved; payment plan not created — ${(pe as Error).message}`, true); }
      }
      // 3) per-course status — only if the user changed it; the endpoint enforces approval rules
      if (status && status !== String(enrolment.course_status ?? '')) {
        try { await api.post(`/students/${student.id}/enrolments/${enrolment.id}/status`, { to_status: status, reason: null, last_attendance_date: null, effective_date: null, approved_by: null }); }
        catch (se) { toast(`Enrollment saved; status not changed — ${(se as Error).message}. Use the Status action for approvals.`, true); }
      }
      toast('Enrollment updated.'); onDone();
    } catch (err) { toast((err as Error).message, true); } finally { setBusy(false); }
  };
  return (
    <DetailModal title={`Edit enrollment — ${enrolment.course_name ?? enrolment.enrolment_no}`} icon="pencil" onClose={onClose} width={640}
      footer={<button className="btn primary" onClick={save} disabled={busy} data-testid="enrol-edit-save"><Ic k="check" />Save changes</button>}>
      <div className="notice" style={{ marginBottom: 10 }}>
        <Ic k="pencil" /><div>{[enrolment.branch_name, enrolment.vertical_name].filter(Boolean).join(' › ') || '—'} · <span className="mono">{enrolment.enrolment_no}</span>. Editing the course stays within this vertical — to move branch/vertical use Transfer course.</div>
      </div>
      <div className="form-grid">
        <div className="fld" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="ee-course">Course <span className="star">*</span></label>
          <select id="ee-course" className="ainp" value={courseId} disabled={busy} onChange={(e) => chooseCourse(e.target.value)} data-testid="enrol-edit-course">
            <option value="">— Choose course —</option>
            {courses.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="fld"><label htmlFor="ee-status">Course status</label>
          <select id="ee-status" className="ainp" value={status} disabled={busy} onChange={(e) => setStatus(e.target.value)} data-testid="enrol-edit-status">
            {statusOpts.map((o: any) => <option key={o.code} value={o.code}>{o.label}</option>)}
          </select>
          <div className="sub" style={{ fontSize: 11 }}>Statuses needing approval (On Hold / Withdrawn / …) are set via the dedicated Status action.</div>
        </div>
        {/* LEVELS (dev/110) — a level-course enrolment shows its Level line-items with an editable
            per-level discount + add/remove; the fee then auto-sums from the levels. Seeded from the
            saved levels; only shown while the course is unchanged (a course change resets levels). */}
        {hasLevels && <EnrolLevelPicker courseId={courseId} disabled={busy} onChange={onLevels} seed={levelSeed} />}
        <FeeConfigFields cfg={cfg} disabled={busy}
          showFee={!hasLevels} hideDiscount={hasLevels && levelScope === 'level'}
          capCtx={{ branch_id: enrolment.branch_id ?? null, vertical_id: enrolment.vertical_id ?? null, course_id: Number(courseId) || (enrolment.course_id ?? null) }} />
      </div>
    </DetailModal>
  );
}

/**
 * CHANGE ENROLMENT STATUS — the per-course transition, mirroring the student Change-Status modal
 * but on ONE enrolment. SENSITIVE statuses (On Hold / Withdrawn / Dropped Out / Cancelled) reveal
 * Reason + Last Attendance + effective date + a REQUIRED Approved-By (the fix), gated by
 * student.status_manage. Setting a completed/failed status leaves the other enrolments + the
 * overall student status untouched. The API is the real gate.
 */
export function ChangeEnrolmentStatusModal({ student, enrolment, canManageSensitive, onClose, onDone }:
  { student: any; enrolment: any; canManageSensitive: boolean; onClose: () => void; onDone: () => void }) {
  const ref = useRef_();
  const catalog = useFetch<any[]>(`/students/enrolment-status-catalog`, []);
  const [toStatus, setToStatus] = useState('');
  const [reason, setReason] = useState('');
  const [lastAtt, setLastAtt] = useState('');
  const [effective, setEffective] = useState('');
  const [approvedBy, setApprovedBy] = useState('');
  const [busy, setBusy] = useState(false);
  const all = catalog.data ?? [];
  const opts = all.filter((o) => canManageSensitive || !o.requires_approval);
  const def = all.find((o) => o.code === toStatus);
  const sensitive = !!def?.requires_approval;
  const effLabel = toStatus === 'on_hold' ? 'Hold Start Date' : 'Effective Date';
  const save = async () => {
    if (!toStatus) { toast('Choose a status.', true); return; }
    if (sensitive) {
      if (!reason.trim()) { toast('Reason is required for this status.', true); return; }
      if (!lastAtt) { toast('Last Attendance Date is required.', true); return; }
      if (!effective) { toast(`${effLabel} is required.`, true); return; }
      if (!approvedBy) { toast('Approved By is required.', true); return; }
    }
    setBusy(true);
    try {
      const res = await api.post<any>(`/students/${student.id}/enrolments/${enrolment.id}/status`, {
        to_status: toStatus, reason: reason.trim() || null,
        last_attendance_date: lastAtt || null, effective_date: effective || null,
        approved_by: sensitive && approvedBy ? Number(approvedBy) : null,
      });
      toast(res?.unchanged ? 'Status unchanged.' : `Enrollment set to ${def?.label ?? toStatus}.`);
      onDone();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  return (
    <DetailModal title={`Change enrollment status — ${enrolment.course_name ?? enrolment.enrolment_no}`} icon="flag" onClose={onClose} width={560}
      footer={<button className="btn primary" onClick={save} disabled={busy || !toStatus} data-testid="enrol-status-save"><Ic k="flag" />Update status</button>}>
      <div className="notice" style={{ marginBottom: 10 }}>
        <Ic k="flag" /><div>Currently <b>{statusMeta(enrolment.course_status).label}</b> · this course only — the overall student status is unaffected.</div>
      </div>
      <div className="form-grid">
        <div className="fld" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="ces-status">New Status <span className="star">*</span></label>
          <select id="ces-status" className="ainp" value={toStatus} disabled={busy} onChange={(e) => setToStatus(e.target.value)} data-testid="enrol-status-select">
            <option value="">— Choose status —</option>
            {opts.map((o) => <option key={o.code} value={o.code}>{o.label} — {String(o.lms_access).toUpperCase()} LMS</option>)}
          </select>
          {def ? <div className="sub" style={{ marginTop: 4, fontSize: 11 }}>{def.meaning}</div> : null}
        </div>
        {(sensitive || (def && def.requires_reason)) && (
          <div className="fld" style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="ces-reason">Reason {sensitive ? <span className="star">*</span> : null}</label>
            <input id="ces-reason" className="ainp" value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)} />
          </div>
        )}
        {sensitive && (
          <>
            <div className="fld"><label htmlFor="ces-lastatt">Last Attendance Date <span className="star">*</span></label><input id="ces-lastatt" type="date" className="ainp" value={lastAtt} disabled={busy} onChange={(e) => setLastAtt(e.target.value)} /></div>
            <div className="fld"><label htmlFor="ces-eff">{effLabel} <span className="star">*</span></label><input id="ces-eff" type="date" className="ainp" value={effective} disabled={busy} onChange={(e) => setEffective(e.target.value)} /></div>
            <div className="fld" style={{ gridColumn: '1 / -1' }}>
              <label htmlFor="ces-appr">Approved By <span className="star">*</span></label>
              <select id="ces-appr" className="ainp" value={approvedBy} disabled={busy} onChange={(e) => setApprovedBy(e.target.value)}>
                <option value="">— Choose approver —</option>
                {selectableUsers(ref.users).map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
          </>
        )}
      </div>
    </DetailModal>
  );
}

/** The per-enrolment status transition trail. */
/** COURSE TRANSFER (client feedback #8) — move ONE enrolment to another course via a
 *  Branch -> Vertical -> Course cascade (defaults to the enrolment's own branch/vertical).
 *  The gross fee auto-fills from the target Course master (editable); the server carries the
 *  existing discount, preserves payments and recomputes the outstanding. Shows the transfer
 *  history for this enrolment. Gated (parent) by student.update. */
export function TransferEnrolmentCourseModal({ student, enrolment, onClose, onDone }: { student: any; enrolment: any; onClose: () => void; onDone: () => void }) {
  const ref = useRef_();
  const [branchId, setBranchId] = useState(String(enrolment.branch_id ?? student.branch_id ?? ''));
  const [vertId, setVertId] = useState(String(enrolment.vertical_id ?? student.vertical_id ?? ''));
  const [courseId, setCourseId] = useState('');
  const [fee, setFee] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const hist = useFetch<any[]>(`/students/${student.id}/enrolments/${enrolment.id}/course-transfer-history`, [enrolment.id]);

  const branches = (ref.branches ?? []) as any[];
  const branchVerticals = ((ref.verticals ?? []) as any[]).filter((v: any) => Number(v.branch_id) === Number(branchId));
  const coursesAll = (ref.courses ?? []) as any[];
  // BRANCH -> VERTICAL -> COURSE cascade; the current course is excluded (nothing to transfer to itself).
  const courses = coursesAll.filter((c: any) =>
    (String((c.meta as any)?.vertical_id ?? '') === String(vertId ?? '') || !((c.meta as any)?.vertical_id))
    && Number(c.id) !== Number(enrolment.course_id));

  const chooseBranch = (bid: string) => {
    setBranchId(bid); setCourseId(''); setFee('');
    const vs = ((ref.verticals ?? []) as any[]).filter((v: any) => Number(v.branch_id) === Number(bid));
    setVertId(vs.length === 1 ? String(vs[0].id) : '');
  };
  const chooseCourse = (cid: string) => {
    setCourseId(cid);
    const c = coursesAll.find((x: any) => Number(x.id) === Number(cid));
    setFee(c ? String((c.meta as any)?.fee ?? '') : '');
  };
  const grossMinor = Math.round(Number(fee || 0) * 100);

  const save = async () => {
    if (!branchId) { toast('Choose a target branch.', true); return; }
    if (!vertId) { toast('Choose a target vertical.', true); return; }
    if (!courseId) { toast('Choose a target course.', true); return; }
    setBusy(true);
    try {
      const res = await api.post<any>(`/students/${student.id}/enrolments/${enrolment.id}/course-transfer`, {
        to_course_id: Number(courseId), to_branch_id: Number(branchId), to_vertical_id: Number(vertId),
        fee_minor: grossMinor, reason: reason.trim() || null,
      });
      toast(`Course transferred to ${res?.to_course_name ?? 'the new course'}.`);
      onDone();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };

  const rows = hist.data ?? [];
  return (
    <DetailModal title={`Transfer course — ${enrolment.course_name ?? enrolment.enrolment_no}`} icon="swap" onClose={onClose} width={640}
      footer={<button className="btn primary" onClick={save} disabled={busy || !courseId} data-testid="enrol-xfer-save"><Ic k="swap" />Transfer course</button>}>
      <div className="notice" style={{ marginBottom: 10 }}>
        <Ic k="grid" />
        <div>Currently on <b>{enrolment.course_name ?? '—'}</b> ({[enrolment.branch_name, enrolment.vertical_name].filter(Boolean).join(' › ') || '—'}).
          The gross fee auto-fills from the target course master (editable); the current discount carries over, payments already made are kept and the outstanding recomputes. The batch is cleared on transfer — re-assign one afterwards.</div>
      </div>
      <div className="form-grid">
        <div className="fld"><label htmlFor="ex-branch">Target Branch <span className="star">*</span></label>
          <select id="ex-branch" className="ainp" value={branchId} disabled={busy}
            onChange={(e) => chooseBranch(e.target.value)} data-testid="enrol-xfer-branch">
            <option value="">— Choose branch —</option>
            {branches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
        <div className="fld"><label htmlFor="ex-vert">Target Vertical <span className="star">*</span></label>
          <select id="ex-vert" className="ainp" value={vertId} disabled={busy || !branchId}
            onChange={(e) => { setVertId(e.target.value); setCourseId(''); setFee(''); }} data-testid="enrol-xfer-vertical">
            <option value="">{branchId ? '— Choose vertical —' : '— Choose branch first —'}</option>
            {branchVerticals.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </div>
        <div className="fld" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="ex-course">Target Course <span className="star">*</span></label>
          <select id="ex-course" className="ainp" value={courseId} disabled={busy || !vertId} onChange={(e) => chooseCourse(e.target.value)} data-testid="enrol-xfer-course">
            <option value="">{vertId ? '— Choose course —' : '— Choose vertical first —'}</option>
            {courses.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="fld"><label htmlFor="ex-fee">Gross fee (₹, from master — editable)</label>
          <input id="ex-fee" className="ainp" type="number" min={0} value={fee} disabled={busy}
            onChange={(e) => setFee(e.target.value)} data-testid="enrol-xfer-fee" />
        </div>
        <div className="fld"><label htmlFor="ex-reason">Reason</label>
          <input id="ex-reason" className="ainp" value={reason} disabled={busy}
            placeholder="Why is the course changing?" onChange={(e) => setReason(e.target.value)} />
        </div>
      </div>
      <div style={{ marginTop: 14 }}>
        <div className="sub" style={{ fontWeight: 600, marginBottom: 6 }}>Course transfer history</div>
        {rows.length ? (
          <table className="minitbl" data-testid="enrol-xfer-hist"><thead><tr><th>When</th><th>From</th><th>To</th><th>Net fee</th><th>Reason</th><th>By</th></tr></thead>
            <tbody>{rows.map((h: any) => (
              <tr key={h.id}>
                <td>{fmtFull(h.created_at)}</td>
                <td>{h.from_course_name ?? '—'}</td>
                <td><b>{h.to_course_name ?? '—'}</b>{h.to_vertical_name ? <div className="sub">{[h.to_branch_name, h.to_vertical_name].filter(Boolean).join(' › ')}</div> : null}</td>
                <td>{h.to_net_fee_minor != null ? fmtINR(Number(h.to_net_fee_minor), { symbol: true }) : '—'}</td>
                <td>{h.reason ?? '—'}</td>
                <td>{h.transferred_by_name ?? '—'}</td>
              </tr>
            ))}</tbody></table>
        ) : <div className="sub">No course transfers yet.</div>}
      </div>
    </DetailModal>
  );
}

export function EnrolmentHistoryModal({ student, enrolment, onClose }: { student: any; enrolment: any; onClose: () => void }) {
  const hist = useFetch<any[]>(`/students/${student.id}/enrolments/${enrolment.id}/status-history`, [enrolment.id]);
  const rows = hist.data ?? [];
  return (
    <DetailModal title={`Status history — ${enrolment.course_name ?? enrolment.enrolment_no}`} icon="list" onClose={onClose} width={680}>
      {rows.length ? (
        <table className="minitbl"><thead><tr><th>When</th><th>From</th><th>To</th><th>Reason</th><th>Outstanding</th><th>Approved By</th><th>By</th></tr></thead>
          <tbody>{rows.map((h: any) => (
            <tr key={h.id}><td>{fmtFull(h.changed_at)}</td><td>{h.from_label ?? h.from_status ?? '—'}</td>
              <td>{renderCell(studentStatusCell(h.to_status))}</td><td>{h.reason ?? '—'}</td>
              <td>{h.outstanding_minor != null ? fmtINR(Number(h.outstanding_minor), { symbol: true }) : '—'}</td>
              <td>{h.approved_by_name ?? '—'}</td><td>{h.changed_by_name ?? '—'}</td></tr>
          ))}</tbody></table>
      ) : <div className="empty-note">No status changes yet.</div>}
    </DetailModal>
  );
}

/** BATCHES — a class bound to Branch -> Vertical -> Course (the module-audit fix). */
function BatchesList() {
  const { refreshTick, bump } = useScreen();
  const { can } = useAuth();
  const ref = useRef_();
  const { scope: gScope, key: scopeKey } = useScope();
  const [fBranches, setFBranches] = useState<number[]>(gScope.branches);
  const [fVerticals, setFVerticals] = useState<number[]>(gScope.verticals);
  const [fCourses, setFCourses] = useState<number[]>([]);
  const [fTrainers, setFTrainers] = useState<number[]>([]);
  const [fOwners, setFOwners] = useState<number[]>([]);
  const [fTypes, setFTypes] = useState<string[]>([]);
  const [fModes, setFModes] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [fStatus, setFStatus] = useState<string[]>([]);
  useEffect(() => {
    setFBranches(gScope.branches);
    setFVerticals(gScope.verticals);
  }, [scopeKey]);
  const vOpts = ref.verticals.filter((vt) => !fBranches.length || fBranches.includes(Number(vt.branch_id)));
  // Course options cascade off Branch/Vertical (a course's meta carries branch_id/vertical_id).
  const cCourseOpts = ref.courses.filter((c: any) =>
    (!fBranches.length || fBranches.includes(Number((c.meta as any)?.branch_id))) &&
    (!fVerticals.length || fVerticals.includes(Number((c.meta as any)?.vertical_id))));
  // Trainer filter offers ONLY Trainer-role users (dev/81) — the scoped /users list carries
  // role_names (comma-joined). Falls back to all selectable users if role data is absent.
  const trainerOpts = (() => {
    const trs = selectableUsers(ref.users).filter((u: any) =>
      String((u as any).role_names ?? '').split(',').map((r) => r.trim().toLowerCase()).includes('trainer'));
    return trs.length ? trs : selectableUsers(ref.users);
  })();
  // Batch Type + Delivery Mode enum options (client feedback #10). The Batch Type options are
  // sourced from the server catalog (/batches/type-catalog = all 9 codes) so the filter can never
  // drift from the seeded set; the hardcoded 9 are the fallback if the fetch is empty.
  const typeCat = useFetch<any[]>(`/batches/type-catalog`, []);
  const typeOpts = (typeCat.data && typeCat.data.length)
    ? typeCat.data.map((t: any) => ({ id: String(t.code), name: String(t.label ?? t.code) }))
    : BATCH_TYPE_OPTS;
  const modeOpts = (ref.deliveryModes?.length ? ref.deliveryModes.map((m: any) => ({ id: String(m.id ?? m.name), name: String(m.name) })) : DELIVERY_MODES.map((m) => ({ id: m, name: m })));
  const params = new URLSearchParams();
  if (fBranches.length) params.set('branch_id', fBranches.join(','));
  if (fVerticals.length) params.set('vertical_id', fVerticals.join(','));
  if (fCourses.length) params.set('course_id', fCourses.join(','));
  if (fTrainers.length) params.set('trainer_id', fTrainers.join(','));
  if (fOwners.length) params.set('owner_id', fOwners.join(','));
  if (fTypes.length) params.set('batch_type', fTypes.join(','));
  if (fModes.length) params.set('delivery_mode', fModes.join(','));
  if (fStatus.length) params.set('status', fStatus.join(','));
  if (q.trim()) params.set('q', q.trim());
  const list = useFetch<any[]>(`/batches?${params.toString()}`, [refreshTick, params.toString()]);
  const rows = list.data ?? [];
  const [modal, setModal] = useState(false);
  const [edit, setEdit] = useState<any | null>(null);
  const canCreate = can('batch.create');
  const canEdit = can('batch.update');
  const del = useDelete('Batch', '/batches', () => { list.reload(); bump(); });
  const [roster, setRoster] = useState<any | null>(null);
  const [statusFor, setStatusFor] = useState<any | null>(null);
  const [historyFor, setHistoryFor] = useState<any | null>(null);
  const [msgFor, setMsgFor] = useState<any | null>(null);
  const [bulkMsgOpen, setBulkMsgOpen] = useState(false);
  const after = () => { list.reload(); bump(); };
  // Select-batch: per-row + select-all checkboxes drive a bulk action bar (bulk STATUS change +
  // bulk delete), reusing the app's useTableSelect + useBulkDelete pattern. Individual row actions
  // are unchanged. Selection is pruned automatically as the filtered rows change.
  const _ids = rows.map((b: any) => Number(b.id));
  const _sel = useTableSelect(_ids);
  const _bd = useBulkDelete('Batch', '/batches/bulk-delete/impact', '/batches/bulk-delete',
    () => { list.reload(); bump(); _sel.clear(); });
  const [bulkStatusOpen, setBulkStatusOpen] = useState(false);

  return (
    <>
      {canCreate && (
        <div className="page-actions">
          <button className="btn primary" onClick={() => setModal(true)}><Ic k="plus" />New batch</button>
        </div>
      )}
      <div className="filters">
        {/* Batch list filters (client feedback #10): Branch > Vertical > Course > Trainer > Status
            > Owner > Batch Type > Delivery Mode (all multi-select). Each genuinely narrows the query. */}
        <FilterMulti label="Branch" icon="branch" value={fBranches} options={ref.branches}
          onChange={(v) => { setFBranches(v); setFVerticals((cur) => cur.filter((id) => ref.verticals.some((vt) => Number(vt.id) === id && v.includes(Number(vt.branch_id))))); setFCourses((cur) => cur.filter((id) => ref.courses.some((c: any) => Number(c.id) === id && v.includes(Number((c.meta as any)?.branch_id))))); }} />
        <FilterMulti label="Vertical" icon="grid" value={fVerticals}
          onChange={(v) => { setFVerticals(v); setFCourses((cur) => cur.filter((id) => !v.length || ref.courses.some((c: any) => Number(c.id) === id && v.includes(Number((c.meta as any)?.vertical_id))))); }} options={vOpts} />
        <FilterMulti label="Course" icon="book" value={fCourses} options={cCourseOpts} onChange={setFCourses} />
        <FilterMulti label="Trainer" icon="users" value={fTrainers} options={trainerOpts} onChange={setFTrainers} />
        <BatchStatusMultiFilter value={fStatus} onChange={setFStatus} />
        <FilterMulti label="Owner" icon="users" value={fOwners} options={selectableUsers(ref.users)} onChange={setFOwners} />
        <EnumMulti label="Batch Type" icon="grid" value={fTypes} options={typeOpts} onChange={setFTypes} />
        <EnumMulti label="Delivery Mode" icon="grid" value={fModes} options={modeOpts} onChange={setFModes} />
        <div className="fchip"><Ic k="search" /><input style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }} placeholder="Search batch name / code…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      </div>
      {_sel.count > 0 && (canEdit || can('batch.delete')) && (
        <div className="card" data-testid="bulk-bar" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', marginBottom: 10, flexWrap: 'wrap' }}>
          <b>{_sel.count} selected</b>
          <button className="btn" type="button" onClick={_sel.clear}>Clear</button>
          <span style={{ flex: 1 }} />
          {canEdit && <button className="btn" type="button" onClick={() => setBulkStatusOpen(true)} data-testid="bulk-batch-status"><Ic k="flag" />Change status</button>}
          {canEdit && <button className="btn" type="button" onClick={() => setBulkMsgOpen(true)} data-testid="bulk-batch-message"><Ic k="send" />Send message</button>}
          {can('batch.delete') && <button className="btn" type="button" onClick={() => _bd.openBulk(_sel.selected)} data-testid="bulk-delete"
            style={{ background: 'var(--danger)', borderColor: 'var(--danger)', color: '#fff' }}><Ic k="trash" />Delete batches</button>}
        </div>
      )}
      <TableCard fill title="Batches" icon="grid"
        select={(canEdit || can('batch.delete')) ? _sel.tableSelect : undefined}
        more={<ListActions onExport={() => downloadObjectsCsv('batches.csv', rows)} onRefresh={() => list.reload()} />}
        cols={['Batch', 'Course', 'Branch · Vertical', 'Trainer', 'Type', 'Delivery', 'Schedule', 'Capacity', 'Enrolled', 'Owner', 'Status', 'Actions']}
        empty="No batches yet — create one bound to a Branch → Vertical → Course."
        rows={rows.map((b) => [
          { node: <div><b className="nm">{b.name}</b><div className="sub mono">{b.batch_code ?? '—'}</div></div> } as Cell,
          b.course_name ?? '—',
          { node: <span>{b.branch_name ?? '—'}<div className="sub">{b.vertical_name ?? '—'}</div></span> } as Cell,
          b.trainer_name ?? '—',
          b.batch_type_label ?? b.batch_type ?? '—',
          b.delivery_mode ?? '—',
          b.schedule ?? '—',
          String(b.capacity ?? 0),
          String(b.enrolled ?? 0),
          b.owner_name ?? '—',
          batchStatusCell(b.status),
          rowActions({
            onView: () => setEdit(b),
            onEdit: canEdit ? () => setEdit(b) : undefined,
            onDelete: can('batch.delete') ? () => del.openDelete(Number(b.id), b.name) : undefined,
            extra: [
              { k: 'grid', title: 'Roster / Transfer / Waitlist', onClick: () => setRoster(b) },
              ...(canEdit ? [{ k: 'send', title: 'Send message to students', onClick: () => setMsgFor(b) }] : []),
              ...(canEdit ? [{ k: 'flag', title: 'Change status', onClick: () => setStatusFor(b) }] : []),
              { k: 'list', title: 'Status history', onClick: () => setHistoryFor(b) },
            ],
          }),
        ])} />
      {del.deleteModal}
      {_bd.bulkModal}
      {bulkStatusOpen && <BatchBulkStatusModal ids={_sel.selected}
        onClose={() => setBulkStatusOpen(false)}
        onDone={() => { setBulkStatusOpen(false); list.reload(); bump(); _sel.clear(); }} />}
      {roster && <BatchRosterModal batch={roster} onClose={() => setRoster(null)} onChanged={after} />}
      {msgFor && <BatchMessageModal batch={msgFor} onClose={() => setMsgFor(null)} />}
      {bulkMsgOpen && <BatchMessageModal batchIds={_sel.selected} onClose={() => setBulkMsgOpen(false)} onDone={() => _sel.clear()} />}
      {statusFor && <BatchStatusModal batch={statusFor} onClose={() => setStatusFor(null)} onDone={() => { setStatusFor(null); after(); }} />}
      {historyFor && <BatchStatusHistoryModal batch={historyFor} onClose={() => setHistoryFor(null)} />}
      {modal && <BatchModal onClose={() => setModal(false)} onSaved={after} />}
      {edit && <BatchModal initial={edit} onClose={() => setEdit(null)} onSaved={after} />}
    </>
  );
}

/** ADD / EDIT BATCH — captures Branch + Vertical (strict cascade) + Course + the batch fields. */
export function BatchModal({ initial, onClose, onSaved }: { initial?: any; onClose?: () => void; onSaved?: () => void }) {
  const ref = useRef_();
  const [branchId, setBranchId] = useState<string>(String(initial?.branch_id ?? ''));
  const [verticalId, setVerticalId] = useState<string>(String(initial?.vertical_id ?? ''));
  const [courseId, setCourseId] = useState<string>(String(initial?.course_id ?? ''));
  const [name, setName] = useState<string>(initial?.name ?? '');
  const [code, setCode] = useState<string>(initial?.batch_code ?? '');
  const [trainerId, setTrainerId] = useState<string>(String(initial?.trainer_id ?? ''));
  const [capacity, setCapacity] = useState<string>(String(initial?.capacity ?? ''));
  const [room, setRoom] = useState<string>(initial?.room ?? '');
  const [schedule, setSchedule] = useState<string>(initial?.schedule ?? '');
  const [startDate, setStartDate] = useState<string>(initial?.start_date ? String(initial.start_date).slice(0, 10) : '');
  const [endDate, setEndDate] = useState<string>(initial?.end_date ? String(initial.end_date).slice(0, 10) : '');
  const [status, setStatus] = useState<string>(initial?.status ? String(initial.status) : '');
  // Batch Type + Frequency + Class Days (081, client feedback). Frequency DERIVES class_days
  // (Daily→all · Weekdays→Mon–Fri · Weekends→Sat–Sun · Custom→pick days). The checkboxes are
  // locked to the derived set unless the frequency is Custom.
  const typeCatalog = useFetch<any[]>(`/batches/type-catalog`, []);
  // dev/93 — the Trainer picker must offer ONLY Trainer-role users (client feedback: it was
  // listing every user). Source it from the server-filtered /users?role=Trainer endpoint so it
  // is correct AND branch/vertical-scope-enforced (the same endpoint the Batches list filter uses).
  const trainerFetch = useFetch<any[]>(`/users?role=Trainer`, []);
  const [batchType, setBatchType] = useState<string>(initial?.batch_type ? String(initial.batch_type) : 'regular');
  const [frequency, setFrequency] = useState<string>(initial?.frequency ? String(initial.frequency) : 'custom');
  const [classDays, setClassDays] = useState<number[]>(
    Array.isArray(initial?.class_days) ? initial.class_days.map(Number).filter((n: number) => n >= 1 && n <= 7) : []);
  // Delivery Mode + Description (083, client feedback). Delivery mode reuses the course catalog
  // (Offline / Online / Hybrid); both persist on create AND edit.
  const [deliveryMode, setDeliveryMode] = useState<string>(initial?.delivery_mode ? String(initial.delivery_mode) : 'Offline');
  const [description, setDescription] = useState<string>(initial?.description ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const WEEKDAYS: Array<{ n: number; lab: string }> = [
    { n: 1, lab: 'Mon' }, { n: 2, lab: 'Tue' }, { n: 3, lab: 'Wed' }, { n: 4, lab: 'Thu' },
    { n: 5, lab: 'Fri' }, { n: 6, lab: 'Sat' }, { n: 7, lab: 'Sun' },
  ];
  // The 9 seeded batch types — used as a fallback if the /batches/type-catalog fetch is empty
  // (offline/test), so the dropdown always offers the full choice and never silently degrades.
  const BATCH_TYPE_FALLBACK: Array<{ code: string; label: string }> = [
    { code: 'regular', label: 'Regular' }, { code: 'fast_track', label: 'Fast Track' },
    { code: 'weekend', label: 'Weekend' }, { code: 'weekday', label: 'Weekday' },
    { code: 'intensive', label: 'Intensive' }, { code: 'crash_course', label: 'Crash Course' },
    { code: 'online', label: 'Online' }, { code: 'corporate', label: 'Corporate' },
    { code: 'customized', label: 'Customized' },
  ];
  const deriveDays = (f: string): number[] =>
    f === 'daily' ? [1, 2, 3, 4, 5, 6, 7] : f === 'weekdays' ? [1, 2, 3, 4, 5] : f === 'weekends' ? [6, 7] : classDays;
  const onFrequency = (f: string) => { setFrequency(f); if (f !== 'custom') setClassDays(deriveDays(f)); };
  const toggleDay = (n: number) => {
    if (frequency !== 'custom') return;                 // locked unless Custom
    setClassDays((prev) => prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n].sort((a, b) => a - b));
  };
  const daysLocked = frequency !== 'custom';

  const vOpts = ref.verticals.filter((vt) => !branchId || Number(vt.branch_id) === Number(branchId));
  const cOpts = ref.courses.filter((c: any) =>
    (!branchId || Number(c.meta?.branch_id) === Number(branchId))
    && (!verticalId || Number(c.meta?.vertical_id) === Number(verticalId)));
  // Trainer options = Trainer-role users only (from /users?role=Trainer). Legacy passthrough:
  // an already-assigned trainer (edit prefill) is kept even if they no longer hold the Trainer
  // role, so an existing batch's assigned trainer never silently drops out of the dropdown.
  const trainerOptions = (() => {
    const base = selectableUsers(trainerFetch.data ?? [], trainerId);
    if (trainerId && !base.some((u: any) => String(u.id) === String(trainerId))) {
      const legacy = (ref.users as any[]).find((u: any) => String(u.id) === String(trainerId));
      if (legacy) return [legacy, ...base];
    }
    return base;
  })();

  const save = async () => {
    setErr('');
    if (!branchId) return setErr('Choose a branch.');
    if (!verticalId) return setErr('Choose a vertical.');
    if (!courseId) return setErr('Choose a course.');
    if (!name.trim()) return setErr('Give the batch a name.');
    setBusy(true);
    const body: any = {
      branch_id: Number(branchId), vertical_id: Number(verticalId), course_id: Number(courseId),
      name: name.trim(), batch_code: code.trim() || undefined,
      trainer_id: trainerId ? Number(trainerId) : null,
      capacity: capacity === '' ? 0 : Number(capacity),
      room: room || null, schedule: schedule || null,
      start_date: startDate || null, end_date: endDate || null,
      // Batch Type + Frequency + Class Days (081) — persisted on BOTH create and edit. The
      // server re-derives class_days from a non-custom frequency, so it is authoritative.
      batch_type: batchType || 'regular',
      frequency: frequency || 'custom',
      class_days: classDays,
      // Delivery Mode + Description (083) — sent on BOTH create and edit.
      delivery_mode: deliveryMode || 'Offline',
      description: description.trim() || null,
    };
    // Status is only set on CREATE (an explicit manual status pins it; otherwise the server
    // DERIVES upcoming/active/expired from the dates). On EDIT the status is changed via the
    // dedicated Change-status action (manual-sticky + history), never a plain save.
    if (!initial?.id && status) body.status = status;
    try {
      if (initial?.id) await api.patch(`/batches/${initial.id}`, body);
      else await api.post('/batches', body);
      toast(initial?.id ? 'Batch updated' : 'Batch created');
      onSaved?.(); onClose?.();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 640 }}>
        <div className="ah">
          <h3><Ic k="grid" />{initial?.id ? 'Edit batch' : 'New batch'}</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          <div className="form-grid">
            <div className="fld">
              <label htmlFor="b-branch">Branch <span className="star">*</span></label>
              <select id="b-branch" className="ainp" value={branchId}
                onChange={(e) => { setBranchId(e.target.value); setVerticalId(''); setCourseId(''); }}>
                <option value="">— Select branch —</option>
                {ref.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="b-vertical">Vertical <span className="star">*</span></label>
              <select id="b-vertical" className="ainp" value={verticalId} disabled={!branchId}
                onChange={(e) => { setVerticalId(e.target.value); setCourseId(''); }}>
                <option value="">{branchId ? '— Select vertical —' : 'Choose a branch first'}</option>
                {vOpts.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="b-course">Course <span className="star">*</span></label><MasterQuickAdd type="course" onAdded={(row) => setCourseId(String(row.id))} />
              <select id="b-course" className="ainp" value={courseId} disabled={!verticalId}
                onChange={(e) => setCourseId(e.target.value)}>
                <option value="">{verticalId ? '— Select course —' : 'Choose a vertical first'}</option>
                {cOpts.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="b-name">Batch name <span className="star">*</span></label>
              <input id="b-name" className="ainp" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. IELTS Morning A" />
            </div>
            <div className="fld">
              <label htmlFor="b-code">Batch code</label>
              <input id="b-code" className="ainp" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Auto if blank" />
            </div>
            <div className="fld">
              <label htmlFor="b-trainer">Trainer</label>
              <select id="b-trainer" className="ainp" value={trainerId} onChange={(e) => setTrainerId(e.target.value)}>
                <option value="">— Unassigned —</option>
                {trainerOptions.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="b-cap">Capacity</label>
              <input id="b-cap" className="ainp" type="number" min={0} value={capacity} onChange={(e) => setCapacity(e.target.value)} placeholder="0" />
            </div>
            <div className="fld">
              <label htmlFor="b-room">Room</label>
              <input id="b-room" className="ainp" value={room} onChange={(e) => setRoom(e.target.value)} placeholder="e.g. Room 3" />
            </div>
            <div className="fld">
              <label htmlFor="b-sched">Schedule</label>
              <input id="b-sched" className="ainp" value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="e.g. Mon-Fri 9–11am" />
            </div>
            <div className="fld">
              <label htmlFor="b-type">Batch type</label>
              <select id="b-type" className="ainp" value={batchType} onChange={(e) => setBatchType(e.target.value)}>
                {(typeCatalog.data?.length ? typeCatalog.data : BATCH_TYPE_FALLBACK).map((t: any) => (
                  <option key={t.code} value={t.code}>{t.label}</option>
                ))}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="b-delivery">Delivery mode</label>
              <select id="b-delivery" className="ainp" value={deliveryMode} onChange={(e) => setDeliveryMode(e.target.value)}>
                {((ref.deliveryModes?.length ? ref.deliveryModes.map((m: any) => String(m.name)) : DELIVERY_MODES)).map((m: string) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="b-freq">Frequency</label>
              <select id="b-freq" className="ainp" value={frequency} onChange={(e) => onFrequency(e.target.value)}>
                <option value="daily">Daily</option>
                <option value="weekdays">Weekdays (Mon–Fri)</option>
                <option value="weekends">Weekends (Sat–Sun)</option>
                <option value="custom">Custom</option>
              </select>
            </div>
            <div className="fld" style={{ gridColumn: '1 / -1' }}>
              <label>Class days</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} role="group" aria-label="Class days">
                {WEEKDAYS.map((d) => {
                  const on = classDays.includes(d.n);
                  return (
                    <label key={d.n} className={`chip${on ? ' on' : ''}`} data-testid={`b-day-${d.n}`}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 999,
                        border: '1px solid var(--line)', cursor: daysLocked ? 'not-allowed' : 'pointer',
                        opacity: daysLocked ? 0.75 : 1, background: on ? 'var(--accent-soft, rgba(99,102,241,.15))' : 'transparent' }}>
                      <input type="checkbox" checked={on} disabled={daysLocked} onChange={() => toggleDay(d.n)}
                        style={{ margin: 0 }} />
                      {d.lab}
                    </label>
                  );
                })}
              </div>
              <div className="sub" style={{ marginTop: 4, fontSize: 11 }}>
                {daysLocked
                  ? 'Set by the frequency — choose Custom to edit individual days.'
                  : 'Student attendance can be marked only on these days (leave all unticked for no restriction).'}
              </div>
            </div>
            <div className="fld">
              <label htmlFor="b-start">Start date</label>
              <input id="b-start" className="ainp" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div className="fld">
              <label htmlFor="b-end">End date</label>
              <input id="b-end" className="ainp" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
            <div className="fld" style={{ gridColumn: '1 / -1' }}>
              <label htmlFor="b-desc">Description</label>
              <textarea id="b-desc" className="ainp" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Notes about this batch (optional)" />
            </div>
            <div className="fld" style={{ gridColumn: '1 / -1' }}>
              <label htmlFor="b-status">Status</label>
              {initial?.id ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className={batchStatusMeta(String(initial.status)).cls} style={{ padding: '2px 10px', borderRadius: 999 }}>{batchStatusMeta(String(initial.status)).label}</span>
                  <span className="sub" style={{ fontSize: 11 }}>Use the <b>Change status</b> action on the list to move a batch through its lifecycle.</span>
                </div>
              ) : (
                <>
                  <select id="b-status" className="ainp" value={status} onChange={(e) => setStatus(e.target.value)}>
                    <option value="">Auto — derive from dates (Upcoming / Active / Expired)</option>
                    <option value="upcoming">Upcoming</option>
                    <option value="active">Active</option>
                    <option value="suspended">Suspended</option>
                    <option value="completed">Completed</option>
                    <option value="cancelled">Cancelled</option>
                    <option value="archived">Archived</option>
                  </select>
                  <div className="sub" style={{ marginTop: 4, fontSize: 11 }}>
                    {status ? batchStatusMeta(status).meaning : 'Before start → Upcoming · within start–end → Active · after end → Expired (IST).'}
                  </div>
                </>
              )}
            </div>
          </div>
          {err && <div className="form-err" style={{ marginTop: 8 }}>{err}</div>}
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={save}><Ic k="check" />{busy ? 'Saving…' : (initial?.id ? 'Save batch' : 'Create batch')}</button>
        </div>
      </div>
    </div>
  );
}


/** CHANGE BATCH STATUS — the lifecycle transition (migration 080). Choosing a MANUAL status
 *  (Completed / Cancelled / Suspended / Archived) pins it (it sticks over the date logic);
 *  choosing an AUTO status (Upcoming / Active / Expired) — i.e. RESUMING a suspended batch —
 *  clears the pin and re-derives from the dates. Guarded server-side by batch.update. */
export function BatchStatusModal({ batch, onClose, onDone }: { batch: any; onClose: () => void; onDone: () => void }) {
  const catalog = useFetch<any[]>(`/batches/status-catalog`, []);
  const all = catalog.data ?? [];
  const cur = batchStatusMeta(String(batch.status));
  const [toStatus, setToStatus] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const def = all.find((o) => o.code === toStatus);
  const post = async (code: string) => {
    if (!code) { toast('Choose a status.', true); return; }
    setBusy(true);
    try {
      const res = await api.post<any>(`/batches/${batch.id}/status`, { to_status: code, reason: reason.trim() || null });
      toast(res?.unchanged ? 'Status unchanged.' : (res?.resumed ? `Batch resumed → ${batchStatusMeta(res?.status).label}.` : `Batch set to ${batchStatusMeta(res?.to_status ?? code).label}.`));
      onDone();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const isSuspended = String(batch.status) === 'suspended';
  return (
    <DetailModal title={`Change status — ${batch.name}`} icon="flag" onClose={onClose} width={560}
      footer={<button className="btn primary" onClick={() => post(toStatus)} disabled={busy || !toStatus} data-testid="batch-status-save"><Ic k="flag" />Update status</button>}>
      <div className="notice" style={{ marginBottom: 10 }}>
        <Ic k="flag" /><div>Currently <span className={cur.cls} style={{ padding: '1px 8px', borderRadius: 999 }}>{cur.label}</span>{batch.status_is_manual ? ' · manually set (sticks over dates)' : ' · auto (derived from dates, IST)'}.</div>
      </div>
      <div className="form-grid">
        <div className="fld" style={{ gridColumn: '1 / -1' }}>
          <label>Quick actions</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {isSuspended && <button className="btn" disabled={busy} onClick={() => post('active')} data-testid="batch-status-resume">Resume</button>}
            <button className="btn" disabled={busy} onClick={() => post('suspended')}>Suspend</button>
            <button className="btn" disabled={busy} onClick={() => post('completed')}>Complete</button>
            <button className="btn" disabled={busy} onClick={() => post('cancelled')}>Cancel</button>
            <button className="btn" disabled={busy} onClick={() => post('archived')}>Archive</button>
          </div>
        </div>
        <div className="fld" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="bs-status">Or pick a status</label>
          <select id="bs-status" className="ainp" value={toStatus} disabled={busy} onChange={(e) => setToStatus(e.target.value)} data-testid="batch-status-select">
            <option value="">— Choose status —</option>
            {(all.length ? all : BATCH_STATUS_ORDER.map((c) => ({ code: c, ...BATCH_STATUS_META[c] }))).map((o: any) => (
              <option key={o.code} value={o.code}>{o.label}{o.is_manual || BATCH_STATUS_META[o.code]?.manual ? ' (manual)' : ' (auto)'}</option>
            ))}
          </select>
          {def ? <div className="sub" style={{ marginTop: 4, fontSize: 11 }}>{def.meaning}</div> : (toStatus ? <div className="sub" style={{ marginTop: 4, fontSize: 11 }}>{batchStatusMeta(toStatus).meaning}</div> : null)}
        </div>
        <div className="fld" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="bs-reason">Reason (optional)</label>
          <input id="bs-reason" className="ainp" value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Trainer on leave — paused for 2 weeks" />
        </div>
      </div>
    </DetailModal>
  );
}

/** BULK change status for the selected batches — one target status applied to all (each row
 *  keeps the per-batch manual-sticky / auto-resume rule server-side). */
function BatchBulkStatusModal({ ids, onClose, onDone }: { ids: number[]; onClose: () => void; onDone: () => void }) {
  const catalog = useFetch<any[]>(`/batches/status-catalog`, []);
  const all = catalog.data ?? [];
  const [toStatus, setToStatus] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!toStatus) { toast('Choose a status.', true); return; }
    setBusy(true);
    try {
      const res = await api.post<any>(`/batches/bulk-status`, { ids, to_status: toStatus, reason: reason.trim() || null });
      const skipped = res && res.requested > res.in_scope ? res.requested - res.in_scope : 0;
      toast(`${res?.changed ?? 0} batch${(res?.changed ?? 0) === 1 ? '' : 'es'} set to ${batchStatusMeta(toStatus).label}${skipped ? ` — ${skipped} skipped (out of scope)` : ''}.`);
      onDone();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  return (
    <DetailModal title={`Change status — ${ids.length} batch${ids.length === 1 ? '' : 'es'}`} icon="flag" onClose={onClose} width={520}
      footer={<button className="btn primary" onClick={submit} disabled={busy || !toStatus} data-testid="batch-bulk-status-save"><Ic k="flag" />Apply to {ids.length}</button>}>
      <div className="notice" style={{ marginBottom: 10 }}><Ic k="flag" /><div>Applies to the {ids.length} selected batch{ids.length === 1 ? '' : 'es'}. Manual statuses (Completed / Cancelled / Suspended / Archived) stick; auto statuses re-derive from each batch's own dates.</div></div>
      <div className="form-grid">
        <div className="fld" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="bbs-status">Status</label>
          <select id="bbs-status" className="ainp" value={toStatus} disabled={busy} onChange={(e) => setToStatus(e.target.value)} data-testid="batch-bulk-status-select">
            <option value="">— Choose status —</option>
            {(all.length ? all : BATCH_STATUS_ORDER.map((c) => ({ code: c, ...BATCH_STATUS_META[c] }))).map((o: any) => (
              <option key={o.code} value={o.code}>{o.label}{o.is_manual || BATCH_STATUS_META[o.code]?.manual ? ' (manual)' : ' (auto)'}</option>
            ))}
          </select>
        </div>
        <div className="fld" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="bbs-reason">Reason (optional)</label>
          <input id="bbs-reason" className="ainp" value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Term ended — archiving cohort" />
        </div>
      </div>
    </DetailModal>
  );
}

/** The batch status transition trail. */
export function BatchStatusHistoryModal({ batch, onClose }: { batch: any; onClose: () => void }) {
  const hist = useFetch<any[]>(`/batches/${batch.id}/status-history`, [batch.id]);
  const rows = hist.data ?? [];
  return (
    <DetailModal title={`Status history — ${batch.name}`} icon="list" onClose={onClose} width={640}>
      {rows.length ? (
        <table className="minitbl"><thead><tr><th>When</th><th>From</th><th>To</th><th>Set</th><th>Reason</th><th>By</th></tr></thead>
          <tbody>{rows.map((h: any) => (
            <tr key={h.id}><td>{fmtFull(h.changed_at)}</td><td>{h.from_label ?? h.from_status ?? '—'}</td>
              <td>{renderCell(batchStatusCell(h.to_status))}</td><td>{h.is_manual ? 'Manual' : 'Auto'}</td>
              <td>{h.reason ?? '—'}</td><td>{h.changed_by_name ?? '—'}</td></tr>
          ))}</tbody></table>
      ) : <div className="empty-note">No status changes yet.</div>}
    </DetailModal>
  );
}

/**
 * SEND MESSAGE to a batch's students (client feedback item 9) — bulk or individual.
 *
 * Single batch (`batch`): lists the batch's students with checkboxes (all ticked by default);
 * the user writes a message, picks a channel, and sends to ALL (student_ids omitted) or a
 * SELECTED subset. Bulk (`batchIds`): messages every student across the selected batches (all).
 * Uses the same channel-agnostic notifier the fee reminder does — an unconfigured channel is a
 * logged attempt, not an error, and the result shows sent / skipped. Guarded by batch.update.
 */
export function BatchMessageModal({ batch, batchIds, onClose, onDone }:
  { batch?: any; batchIds?: number[]; onClose: () => void; onDone?: () => void }) {
  const single = !!batch;
  const ids = single ? [Number(batch.id)] : (batchIds ?? []);
  const students = useFetch<any[]>(single ? `/batches/${batch.id}/students` : null, [single ? batch.id : 0]);
  const roster = students.data ?? [];
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (single && !seeded && roster.length) { setSel(new Set(roster.map((s: any) => Number(s.id)))); setSeeded(true); }
  }, [roster, single, seeded]);
  const [message, setMessage] = useState('');
  const [channel, setChannel] = useState('auto');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ sent: number; skipped: number } | null>(null);
  const toggle = (id: number) => setSel((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allOn = single && roster.length > 0 && sel.size === roster.length;
  const setAll = (on: boolean) => setSel(on ? new Set(roster.map((s: any) => Number(s.id))) : new Set());

  const send = async () => {
    if (!message.trim()) { toast('Type a message to send.', true); return; }
    if (single && sel.size === 0) { toast('Pick at least one student.', true); return; }
    setBusy(true);
    try {
      let sent = 0; let skipped = 0;
      for (const bid of ids) {
        // Single: send only the selected students (omit student_ids when ALL are ticked → "all").
        const body: any = { message: message.trim(), channel };
        if (single && !allOn) body.student_ids = [...sel];
        const res = await api.post<any>(`/batches/${bid}/message`, body);
        sent += Number(res?.sent ?? 0); skipped += Number(res?.skipped ?? 0);
      }
      setResult({ sent, skipped });
      toast(`Message queued — ${sent} sent, ${skipped} skipped.`);
      onDone?.();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };

  const title = single ? `Send message — ${batch.name}` : `Send message — ${ids.length} batch${ids.length === 1 ? '' : 'es'}`;
  return (
    <DetailModal title={title} icon="send" onClose={onClose} width={620}
      footer={<button className="btn primary" onClick={send} disabled={busy || !message.trim()} data-testid="batch-message-send"><Ic k="send" />{busy ? 'Sending…' : (single ? `Send to ${allOn ? 'all' : sel.size}` : `Send to all in ${ids.length}`)}</button>}>
      <div className="notice" style={{ marginBottom: 10 }}><Ic k="send" /><div>
        {single ? 'Compose an update for this batch. All students are selected by default — untick anyone to send to a subset or a single student.'
          : `The message goes to every student across the ${ids.length} selected batch${ids.length === 1 ? '' : 'es'}.`}
        {' '}Delivery uses the configured WhatsApp / SMS / Email channel; an unconfigured channel is logged and skipped (never an error).
      </div></div>
      <div className="form-grid">
        <div className="fld" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="bm-msg">Message</label>
          <textarea id="bm-msg" className="ainp" rows={4} value={message} disabled={busy}
            onChange={(e) => setMessage(e.target.value)} data-testid="batch-message-text"
            placeholder="e.g. Reminder: tomorrow's class starts at 6 PM. You can use {name} to greet each student." />
        </div>
        <div className="fld">
          <label htmlFor="bm-ch">Channel</label>
          <select id="bm-ch" className="ainp" value={channel} disabled={busy} onChange={(e) => setChannel(e.target.value)} data-testid="batch-message-channel">
            <option value="auto">Auto (best available)</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="sms">SMS</option>
            <option value="email">Email</option>
          </select>
        </div>
      </div>
      {single && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <b>Recipients</b><span className="sub">{sel.size} of {roster.length} selected</span>
            <span style={{ flex: 1 }} />
            <label className="sub" style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input type="checkbox" checked={allOn} onChange={(e) => setAll(e.target.checked)} data-testid="batch-message-all" /> Select all
            </label>
          </div>
          <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 8 }}>
            {students.loading ? <div className="empty-note">Loading roster…</div>
              : roster.length === 0 ? <div className="empty-note">This batch has no enrolled students.</div>
                : roster.map((s: any) => {
                  const reach = s.has_phone || s.has_email;
                  return (
                    <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--line)', cursor: 'pointer', opacity: reach ? 1 : 0.6 }}>
                      <input type="checkbox" checked={sel.has(Number(s.id))} onChange={() => toggle(Number(s.id))} data-testid={`batch-msg-stu-${s.id}`} />
                      <span style={{ flex: 1 }}><b className="nm">{s.full_name}</b> <span className="sub mono">{s.student_no ?? '—'}</span></span>
                      <span className="sub">{s.has_phone ? (s.phone ?? 'phone') : ''}{s.has_phone && s.has_email ? ' · ' : ''}{s.has_email ? (s.email ?? 'email') : ''}{!reach ? 'no contact' : ''}</span>
                    </label>
                  );
                })}
          </div>
        </div>
      )}
      {result && (
        <div className="notice" style={{ marginTop: 10 }} data-testid="batch-message-result">
          <Ic k="check" /><div><b>{result.sent}</b> message{result.sent === 1 ? '' : 's'} queued, <b>{result.skipped}</b> skipped (no contact / opted out / unconfigured channel). Each attempt is written to the message log.</div>
        </div>
      )}
    </DetailModal>
  );
}


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
  smsTemplates: SmsTemplates,
  journeys: Journeys,
  notificationEvents: NotificationEvents,
  bulkWhatsApp: BulkWhatsApp,
  settings: Settings,
  financeSettings: FinanceSettings,
  discountMaster: DiscountMaster,
  // Phase 3 Batch 1 — GST tax invoices + finance dashboard
  invoicesList: InvoicesScreen,
  financeDashboard: FinanceDashboard,
  // Phase 3 Batch 2 — payment plans + fee dues & ageing + auto reminders
  paymentPlans: PaymentPlansScreen,
  feeDues: FeeDuesScreen,
  // Phase 3 Batch 3 — Razorpay online collection (per vertical)
  onlinePayments: PaymentsScreen,
  // Phase 3 Batch 4 — refunds (approval hierarchy), revenue (collection vs accrual), collection reports + Tally
  refundsList: RefundsScreen,
  revenueView: RevenueScreen,
  collectionReports: CollectionReportsScreen,
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
  // Marketing › Lead Status — the SAME Masters admin, opened straight on the Lead Status master
  // so it is reachable from the Leads area (client couldn't find it under Administration).
  leadStatusMaster: () => <MastersAdmin initialType="status" />,
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
  aiIntelligence: AiIntelligence,
  studentDashboard: StudentDashboard,
  studentsList: StudentsList,
  batchesList: BatchesList,
  attendanceScreen: AttendanceScreen,
  testsScreen: TestsScreen,
  assignmentsScreen: AssignmentsScreen,
  studyMaterial: StudyMaterialScreen,
  courseContent: CourseContentScreen,
  syllabus: SyllabusScreen,
  placements: PlacementsScreen,
  admissionsList: AdmissionsScreen,
  certificates: CertificatesScreen,
  reportCards: ReportCardsScreen,
  catalogList: CatalogScreen,
  inventoryList: InventoryScreen,
  assetsList: AssetsScreen,
  vendorsList: VendorsScreen,
  procurementList: ProcurementScreen,
  hrDirectory: EmployeeDirectoryScreen,
  hrAttendance: StaffAttendanceScreen,
  hrLeaves: LeavesScreen,
  customFields: CustomFieldsAdmin,
  sitemap: Sitemap,
  // Assessment / Test Module — Batch A: Question Bank + Categories
  questionBank: QuestionBankScreen,
  questionCategories: QuestionCategoriesScreen,
  tests: AssessmentTestsScreen,
  testTemplates: AssessmentTemplatesScreen,
  assessmentEvaluation: AssessmentEvaluationScreen,
  assessmentResults: AssessmentResultsScreen,
  gradeSchemes: GradeSchemesScreen,
  assessmentCertificates: AssessmentCertificatesScreen,
  trainingVideos: TrainingVideosScreen,
  releaseNotes: ReleaseNotesScreen,
  featuresPanel: FeaturesPanel,
};

export { checkS };
