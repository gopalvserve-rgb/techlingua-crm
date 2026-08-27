/**
 * TARGET & INCENTIVE (dev/134) — Performance & Conversion › Target & Incentive.
 *
 * Two tabs, one page, reusing the prototype's existing blocks (card, kpi-strip,
 * table, add-modal, form-grid) — no new visual language:
 *   · Targets       — named targets with a Target-For (Individual / Team / Branch
 *                     / Vertical / Course), a Period preset and six metric targets,
 *                     each with live actual / % and a progress dashboard.
 *   · Incentive Plans — the master: editable achievement SLABS that compute an
 *                     earned incentive for a given achievement %.
 */
import { useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, TableCard } from './renderer';
import { toast, useFetch, useRef_, selectableUsers } from './refdata';
import { fmtINR, minorToInput } from './money';

type Named = { id: number | string; name: string; status?: string };

const money = (m: number) => fmtINR(m);
const barClass = (p: number) => (p >= 100 ? 'b-green' : p >= 80 ? 'b-indigo' : p >= 50 ? 'b-amber' : 'b-rose');
const barColor = (p: number) => (p >= 100 ? 'var(--green)' : p >= 80 ? 'var(--indigo)' : p >= 50 ? 'var(--amber)' : 'var(--rose)');

const TARGET_FOR: Array<[string, string]> = [
  ['user', 'Individual Employee'], ['team', 'Team'], ['branch', 'Branch'],
  ['vertical', 'Vertical'], ['course', 'Course'],
];
const PERIODS: Array<[string, string]> = [
  ['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['half_yearly', 'Half-Yearly'],
  ['yearly', 'Yearly'], ['custom', 'Custom'],
];
const METRICS: Array<[string, string]> = [
  ['admissions', 'Admissions'], ['revenue', 'Revenue'], ['collection', 'Net Collected Amount'],
  ['leads', 'Leads'], ['walkin', 'Walk-in'], ['meeting', 'Meeting'],
];

/* ==================================================================== */
/*  PAGE                                                                 */
/* ==================================================================== */
export function TargetIncentive() {
  const [tab, setTab] = useState<'targets' | 'plans' | 'teams'>('targets');
  return (
    <>
      <div className="seg" style={{ marginBottom: 12 }}>
        <button className={`seg-btn${tab === 'targets' ? ' on' : ''}`} onClick={() => setTab('targets')}>
          <Ic k="target" />Targets
        </button>
        <button className={`seg-btn${tab === 'plans' ? ' on' : ''}`} onClick={() => setTab('plans')}>
          <Ic k="rupee" />Incentive Plans
        </button>
        <button className={`seg-btn${tab === 'teams' ? ' on' : ''}`} onClick={() => setTab('teams')}>
          <Ic k="users" />Teams
        </button>
      </div>
      {tab === 'targets' ? <Targets /> : tab === 'plans' ? <IncentivePlans /> : <Teams />}
    </>
  );
}

/* ==================================================================== */
/*  TARGETS                                                             */
/* ==================================================================== */
function Targets() {
  const { can } = useAuth();
  const { data, reload } = useFetch<any[]>('/performance/target-defs', []);
  const [modal, setModal] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const [dash, setDash] = useState<any>(null);
  const rows = data ?? [];

  const del = async (t: any) => {
    if (!confirm(`Delete the target "${t.name}"?`)) return;
    try { await api.del(`/performance/target-defs/${t.id}`); toast('Target deleted'); reload(); }
    catch (e) { toast((e as Error).message); }
  };

  const forLabel = (t: string) => TARGET_FOR.find(([k]) => k === t)?.[1] ?? t;
  const periodLabel = (t: any) => {
    const p = PERIODS.find(([k]) => k === t.period_type)?.[1] ?? t.period_type;
    return `${p} · ${String(t.period_start).slice(0, 10)} → ${String(t.period_end).slice(0, 10)}`;
  };

  return (
    <>
      <div className="page-actions">
        {can('target.manage') && (
          <button className="btn primary" onClick={() => setModal(true)}><Ic k="plus" />New target</button>
        )}
      </div>
      <TableCard
        title="Targets" icon="target"
        cols={['Name', 'Target for', 'Period', 'Admissions', 'Revenue', 'Collection', '']}
        empty="No targets yet — create one to track progress against admissions, revenue, collection, leads, walk-ins & meetings"
        rows={rows.map((t): Cell[] => [
          { node: <b>{t.name}</b> },
          `${forLabel(t.target_for)} · ${t.label}`,
          periodLabel(t),
          { b: [`${t.actuals.admissions}/${t.targets.admissions} · ${t.pct.admissions}%`, barClass(t.pct.admissions)] },
          { mono: `${money(t.actuals.revenue_minor)} / ${money(t.targets.revenue_minor)}` },
          { mono: `${money(t.actuals.collection_minor)} / ${money(t.targets.collection_minor)}` },
          {
            node: (
              <div className="rowacts">
                <button className="icon-btn sm" title="Progress dashboard" onClick={(e) => { e.stopPropagation(); setDash(t); }}><Ic k="perf" /></button>
                {can('target.manage') && <button className="icon-btn sm" title="Edit" onClick={(e) => { e.stopPropagation(); setEdit(t); }}><Ic k="pencil" /></button>}
                {can('target.manage') && <button className="icon-btn sm" title="Delete" onClick={(e) => { e.stopPropagation(); void del(t); }}><Ic k="trash" /></button>}
              </div>
            ),
          },
        ])}
      />
      {(modal || edit) && <TargetModal initial={edit} onClose={() => { setModal(false); setEdit(null); }} onSaved={reload} />}
      {dash && <TargetDashboardModal target={dash} onClose={() => setDash(null)} />}
    </>
  );
}

/* -------- the 6 progress cards for one target -------- */
function TargetDashboardModal({ target, onClose }: { target: any; onClose: () => void }) {
  const { data } = useFetch<any>(`/performance/target-defs/${target.id}/dashboard`, [target.id]);
  const d = data ?? target;
  const a = d.actuals ?? {}; const t = d.targets ?? {}; const pc = d.pct ?? {};
  const cards: Array<[string, string, string, number, string]> = [
    ['Admissions', String(a.admissions ?? 0), String(t.admissions ?? 0), pc.admissions ?? 0, 'check'],
    ['Revenue (net)', money(a.revenue_minor ?? 0), money(t.revenue_minor ?? 0), pc.revenue ?? 0, 'rupee'],
    ['Collection', money(a.collection_minor ?? 0), money(t.collection_minor ?? 0), pc.collection ?? 0, 'rupee'],
    ['Leads', String(a.leads ?? 0), String(t.leads ?? 0), pc.leads ?? 0, 'leads'],
    ['Walk-ins', String(a.walkins ?? 0), String(t.walkins ?? 0), pc.walkins ?? 0, 'users'],
    ['Meetings', String(a.meetings ?? 0), String(t.meetings ?? 0), pc.meetings ?? 0, 'clock'],
  ];
  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 820 }}>
        <div className="ah"><h3><Ic k="perf" />{d.name} — progress</h3><button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button></div>
        <div className="abody">
          <div className="kpi-strip" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
            {cards.map(([lab, act, tgt, pct, ic]) => (
              <div className="card kpi" key={lab}>
                <div className={`ic ${pct >= 100 ? 'green' : pct >= 50 ? 'indigo' : 'amber'}`}><Ic k={ic} /></div>
                <div className="lab">{lab}</div>
                <div className="val">{act} <span style={{ color: 'var(--muted)', fontSize: 13 }}>/ {tgt}</span></div>
                <div className="delta flat" style={{ color: barColor(pct) }}>{pct}%</div>
                <div style={{ height: 6, borderRadius: 4, background: 'var(--line)', marginTop: 6, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${Math.min(100, pct)}%`, background: barColor(pct) }} />
                </div>
              </div>
            ))}
          </div>
          {d.incentive && (
            <div className="card" style={{ marginTop: 12 }}>
              <div className="card-pad">
                <div className="sub" style={{ marginTop: 0 }}>
                  <b>Incentive — {d.incentive.plan_name}</b> (on {METRICS.find(([k]) => k === d.incentive.metric)?.[1] ?? d.incentive.metric})
                  <div style={{ marginTop: 6, fontSize: 20, fontWeight: 700 }}>
                    {d.incentive.slab?.emoji ? `${d.incentive.slab.emoji} ` : ''}{money(d.incentive.amount_minor)}
                    <span style={{ marginLeft: 8, fontSize: 13, color: 'var(--muted)', fontWeight: 500 }}>
                      {d.incentive.slab?.label ?? 'No band'} · {d.incentive.achievement_pct}% achieved
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="af"><button className="btn" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

/* -------- create / edit a target -------- */
function TargetModal({ initial, onClose, onSaved }: { initial?: any; onClose: () => void; onSaved?: () => void }) {
  const ref = useRef_();
  const teams = useFetch<Named[]>('/teams', []);
  const plans = useFetch<any[]>('/performance/incentive-plans', []);
  const now = new Date();
  const [name, setName] = useState<string>(initial?.name ?? '');
  const [targetFor, setTargetFor] = useState<string>(initial?.target_for ?? 'user');
  const [entity, setEntity] = useState<string>(String(
    initial?.user_id ?? initial?.team_id ?? initial?.branch_id ?? initial?.vertical_id ?? initial?.course_id ?? '',
  ));
  const [periodType, setPeriodType] = useState<string>(initial?.period_type ?? 'monthly');
  const [anchor, setAnchor] = useState<string>(
    initial?.period_start ? String(initial.period_start).slice(0, 7) : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
  );
  const [from, setFrom] = useState<string>(initial?.period_type === 'custom' ? String(initial.period_start).slice(0, 10) : '');
  const [to, setTo] = useState<string>(initial?.period_type === 'custom' ? String(initial.period_end).slice(0, 10) : '');
  const [leads, setLeads] = useState<string>(String(initial?.targets?.leads ?? ''));
  const [walkins, setWalkins] = useState<string>(String(initial?.targets?.walkins ?? ''));
  const [admissions, setAdmissions] = useState<string>(String(initial?.targets?.admissions ?? ''));
  const [revenue, setRevenue] = useState<string>(minorToInput(initial?.targets?.revenue_minor));
  const [collection, setCollection] = useState<string>(minorToInput(initial?.targets?.collection_minor));
  const [meetings, setMeetings] = useState<string>(String(initial?.targets?.meetings ?? ''));
  const [planId, setPlanId] = useState<string>(String(initial?.incentive_plan_id ?? ''));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const entities: Named[] = targetFor === 'user' ? selectableUsers(ref.users)
    : targetFor === 'team' ? (teams.data ?? [])
    : targetFor === 'branch' ? ref.branches
    : targetFor === 'vertical' ? ref.verticals
    : ref.courses;
  const entityLabel = TARGET_FOR.find(([k]) => k === targetFor)?.[1] ?? 'Entity';

  const save = async () => {
    setErr(''); setBusy(true);
    try {
      const payload: any = {
        id: initial?.id, name, target_for: targetFor,
        user_id: targetFor === 'user' ? Number(entity) || null : null,
        team_id: targetFor === 'team' ? Number(entity) || null : null,
        branch_id: targetFor === 'branch' ? Number(entity) || null : null,
        vertical_id: targetFor === 'vertical' ? Number(entity) || null : null,
        course_id: targetFor === 'course' ? Number(entity) || null : null,
        period_type: periodType,
        leads_target: Number(leads || 0), walkins_target: Number(walkins || 0),
        admissions_target: Number(admissions || 0),
        revenue_target: revenue || '0', collection_target: collection || '0',
        meetings_target: Number(meetings || 0),
        incentive_plan_id: planId ? Number(planId) : null,
      };
      if (periodType === 'custom') { payload.period_start = from; payload.period_end = to; }
      else { payload.period_anchor = anchor; }
      await api.post('/performance/target-defs', payload);
      toast('Target saved'); onSaved?.(); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 720 }}>
        <div className="ah"><h3><Ic k="target" />{initial ? 'Edit target' : 'New target'}</h3><button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button></div>
        <div className="abody">
          <div className="form-grid">
            <div className="fld span2">
              <label htmlFor="ti-name">Target name <span className="star">*</span></label>
              <input id="ti-name" className="ainp" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Q3 Delhi admissions" />
            </div>
            <div className="fld">
              <label htmlFor="ti-for">Target for <span className="star">*</span></label>
              <select id="ti-for" className="ainp" value={targetFor} onChange={(e) => { setTargetFor(e.target.value); setEntity(''); }}>
                {TARGET_FOR.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="ti-entity">{entityLabel} <span className="star">*</span></label>
              <select id="ti-entity" className="ainp" value={entity} onChange={(e) => setEntity(e.target.value)}>
                <option value="">—</option>
                {entities.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </div>
            <div className="fld span2">
              <label>Period <span className="star">*</span></label>
              <div className="seg" style={{ flexWrap: 'wrap' }}>
                {PERIODS.map(([k, l]) => (
                  <button type="button" key={k} className={`seg-btn${periodType === k ? ' on' : ''}`} onClick={() => setPeriodType(k)}>{l}</button>
                ))}
              </div>
            </div>
            {periodType === 'custom' ? (
              <>
                <div className="fld"><label htmlFor="ti-from">From <span className="star">*</span></label><input id="ti-from" className="ainp" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
                <div className="fld"><label htmlFor="ti-to">To <span className="star">*</span></label><input id="ti-to" className="ainp" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
              </>
            ) : (
              <div className="fld"><label htmlFor="ti-anchor">Within month</label>
                <input id="ti-anchor" className="ainp" type="month" value={anchor} onChange={(e) => setAnchor(e.target.value)} />
                <div className="fhint">The {PERIODS.find(([k]) => k === periodType)?.[1].toLowerCase()} span containing this month is measured.</div>
              </div>
            )}
            <div className="fld"><label htmlFor="ti-leads">Leads</label><input id="ti-leads" className="ainp" type="number" min={0} value={leads} onChange={(e) => setLeads(e.target.value)} placeholder="0" /></div>
            <div className="fld"><label htmlFor="ti-walk">Walk-ins</label><input id="ti-walk" className="ainp" type="number" min={0} value={walkins} onChange={(e) => setWalkins(e.target.value)} placeholder="0" /></div>
            <div className="fld"><label htmlFor="ti-adm">Admissions</label><input id="ti-adm" className="ainp" type="number" min={0} value={admissions} onChange={(e) => setAdmissions(e.target.value)} placeholder="0" /></div>
            <div className="fld"><label htmlFor="ti-rev">Revenue (₹, net before tax)</label><input id="ti-rev" className="ainp" value={revenue} onChange={(e) => setRevenue(e.target.value)} placeholder="0.00" /></div>
            <div className="fld"><label htmlFor="ti-col">Collection (₹)</label><input id="ti-col" className="ainp" value={collection} onChange={(e) => setCollection(e.target.value)} placeholder="0.00" /></div>
            <div className="fld"><label htmlFor="ti-meet">Meetings</label><input id="ti-meet" className="ainp" type="number" min={0} value={meetings} onChange={(e) => setMeetings(e.target.value)} placeholder="0" /></div>
            <div className="fld span2">
              <label htmlFor="ti-plan">Incentive plan</label>
              <select id="ti-plan" className="ainp" value={planId} onChange={(e) => setPlanId(e.target.value)}>
                <option value="">— none —</option>
                {(plans.data ?? []).filter((p) => p.status === 'active').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <div className="fhint">The plan resolves an earned incentive from the achievement % of its own metric.</div>
            </div>
          </div>
          {err ? <div className="notice err" style={{ marginTop: 10 }}><Ic k="bolt" /><div>{err}</div></div> : null}
        </div>
        <div className="af"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}><Ic k="check" />{busy ? 'Saving…' : 'Save target'}</button></div>
      </div>
    </div>
  );
}

/* ==================================================================== */
/*  INCENTIVE PLANS (master)                                            */
/* ==================================================================== */
function IncentivePlans() {
  const { can } = useAuth();
  const { data, reload } = useFetch<any[]>('/performance/incentive-plans', []);
  const [modal, setModal] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const rows = data ?? [];

  const del = async (p: any) => {
    if (!confirm(`Delete the incentive plan "${p.name}"?`)) return;
    try { await api.del(`/performance/incentive-plans/${p.id}`); toast('Plan deleted'); reload(); }
    catch (e) { toast((e as Error).message); }
  };
  const metricLabel = (m: string) => METRICS.find(([k]) => k === m)?.[1] ?? m;
  const applLabel = (a: string) => ({ user: 'Counsellor', branch: 'Branch', vertical: 'Vertical' } as Record<string, string>)[a] ?? a;

  return (
    <>
      <div className="page-actions">
        {can('target.manage') && <button className="btn primary" onClick={() => setModal(true)}><Ic k="plus" />New plan</button>}
      </div>
      <TableCard
        title="Incentive plans" icon="rupee"
        cols={['Plan', 'Applicable to', 'Metric', 'Slabs', 'Status', 'Linked', '']}
        empty="No incentive plans yet — a seeded example plan appears here once the server is migrated"
        rows={rows.map((p): Cell[] => [
          { node: <b>{p.name}</b> },
          applLabel(p.applicable_to),
          metricLabel(p.metric),
          String(p.slabs?.length ?? 0),
          { b: p.status === 'active' ? ['Active', 'b-green'] : ['Inactive', 'b-gray'] },
          String(p.targets_linked ?? 0),
          {
            node: (
              <div className="rowacts">
                {can('target.manage') && <button className="icon-btn sm" title="Edit" onClick={(e) => { e.stopPropagation(); setEdit(p); }}><Ic k="pencil" /></button>}
                {can('target.manage') && <button className="icon-btn sm" title="Delete" onClick={(e) => { e.stopPropagation(); void del(p); }}><Ic k="trash" /></button>}
              </div>
            ),
          },
        ])}
      />
      {(modal || edit) && <PlanModal initial={edit} onClose={() => { setModal(false); setEdit(null); }} onSaved={reload} />}
    </>
  );
}

const DEFAULT_SLABS = () => ([
  { min_pct: 0, max_pct: 49.99, tier: 'critical', emoji: '🔴', label: 'Critical', amount: '0' },
  { min_pct: 50, max_pct: 69.99, tier: 'below', emoji: '🟠', label: 'Below Target', amount: '0' },
  { min_pct: 70, max_pct: 79.99, tier: 'near', emoji: '🟡', label: 'Near Target', amount: '0' },
  { min_pct: 80, max_pct: 89.99, tier: 'good', emoji: '🟢', label: 'Good', amount: '2000' },
  { min_pct: 90, max_pct: 99.99, tier: 'strong', emoji: '🟢', label: 'Strong', amount: '4000' },
  { min_pct: 100, max_pct: 109.99, tier: 'achieved', emoji: '🔵', label: 'Target Achieved', amount: '7000' },
  { min_pct: 110, max_pct: 124.99, tier: 'excellent', emoji: '🟣', label: 'Excellent', amount: '10000' },
  { min_pct: 125, max_pct: null, tier: 'exceptional', emoji: '🏆', label: 'Exceptional', amount: '15000' },
]);

function PlanModal({ initial, onClose, onSaved }: { initial?: any; onClose: () => void; onSaved?: () => void }) {
  const [name, setName] = useState<string>(initial?.name ?? '');
  const [applicableTo, setApplicableTo] = useState<string>(initial?.applicable_to ?? 'user');
  const [metric, setMetric] = useState<string>(initial?.metric ?? 'admissions');
  const [status, setStatus] = useState<string>(initial?.status ?? 'active');
  const [slabs, setSlabs] = useState<any[]>(
    initial?.slabs?.length
      ? initial.slabs.map((s: any) => ({ ...s, amount: minorToInput(s.amount_minor), max_pct: s.max_pct }))
      : DEFAULT_SLABS(),
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // Live check of the achievement->incentive resolver via the API (edit mode only —
  // a saved plan has an id to compute against). Also proves the compute route is wired.
  const [testPct, setTestPct] = useState<string>('100');
  const [preview, setPreview] = useState<any>(null);
  const runPreview = async () => {
    if (!initial?.id) { toast('Save the plan first, then preview an achievement %.'); return; }
    try {
      const r = await api.get<any>(`/performance/incentive-plans/${initial.id}/compute?pct=${encodeURIComponent(testPct || '0')}`);
      setPreview(r);
    } catch (e) { toast((e as Error).message); }
  };

  const upd = (i: number, k: string, v: any) => setSlabs((arr) => arr.map((s, j) => (j === i ? { ...s, [k]: v } : s)));
  const addSlab = () => setSlabs((arr) => [...arr, { min_pct: 0, max_pct: null, tier: 'good', emoji: '', label: 'New band', amount: '0' }]);
  const rmSlab = (i: number) => setSlabs((arr) => arr.filter((_, j) => j !== i));

  const save = async () => {
    setErr(''); setBusy(true);
    try {
      await api.post('/performance/incentive-plans', {
        id: initial?.id, name, applicable_to: applicableTo, metric, status,
        slabs: slabs.map((s) => ({
          min_pct: Number(s.min_pct), max_pct: s.max_pct === null || s.max_pct === '' ? null : Number(s.max_pct),
          tier: s.tier, emoji: s.emoji || null, label: s.label, amount: s.amount || '0',
        })),
      });
      toast('Plan saved'); onSaved?.(); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 860 }}>
        <div className="ah"><h3><Ic k="rupee" />{initial ? 'Edit incentive plan' : 'New incentive plan'}</h3><button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button></div>
        <div className="abody">
          <div className="form-grid">
            <div className="fld span2"><label htmlFor="ip-name">Plan name <span className="star">*</span></label><input id="ip-name" className="ainp" value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="fld">
              <label htmlFor="ip-app">Applicable to</label>
              <select id="ip-app" className="ainp" value={applicableTo} onChange={(e) => setApplicableTo(e.target.value)}>
                <option value="user">Counsellor</option><option value="branch">Branch</option><option value="vertical">Vertical</option>
              </select>
            </div>
            <div className="fld">
              <label htmlFor="ip-metric">Metric</label>
              <select id="ip-metric" className="ainp" value={metric} onChange={(e) => setMetric(e.target.value)}>
                {METRICS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="ip-status">Status</label>
              <select id="ip-status" className="ainp" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="active">Active</option><option value="inactive">Inactive</option>
              </select>
            </div>
          </div>
          <div className="sub" style={{ marginTop: 14, marginBottom: 6 }}><b>Achievement slabs</b> — the earned incentive is the band the achievement % falls in (from % inclusive).</div>
          <table className="tbl" style={{ width: '100%' }}>
            <thead><tr><th>From %</th><th>To %</th><th>Emoji</th><th>Label</th><th>Amount (₹)</th><th></th></tr></thead>
            <tbody>
              {slabs.map((s, i) => (
                <tr key={i}>
                  <td><input className="ainp" style={{ width: 74 }} type="number" value={s.min_pct} onChange={(e) => upd(i, 'min_pct', e.target.value)} /></td>
                  <td><input className="ainp" style={{ width: 74 }} type="number" value={s.max_pct ?? ''} placeholder="∞" onChange={(e) => upd(i, 'max_pct', e.target.value)} /></td>
                  <td><input className="ainp" style={{ width: 56 }} value={s.emoji ?? ''} onChange={(e) => upd(i, 'emoji', e.target.value)} /></td>
                  <td><input className="ainp" value={s.label} onChange={(e) => upd(i, 'label', e.target.value)} /></td>
                  <td><input className="ainp" style={{ width: 110 }} value={s.amount} onChange={(e) => upd(i, 'amount', e.target.value)} /></td>
                  <td><button className="icon-btn sm" title="Remove" onClick={() => rmSlab(i)}><Ic k="trash" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="btn" style={{ marginTop: 8 }} onClick={addSlab}><Ic k="plus" />Add slab</button>
          <div className="sub" style={{ marginTop: 14 }}>
            <b>Preview earned incentive</b> — resolve the slabs against an achievement %.
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
              <input className="ainp" style={{ width: 110 }} type="number" value={testPct}
                onChange={(e) => setTestPct(e.target.value)} placeholder="Achievement %" aria-label="Achievement %" />
              <button className="btn" onClick={runPreview}><Ic k="perf" />Compute</button>
              {preview && (
                <span style={{ fontWeight: 600 }}>
                  {preview.slab?.emoji ? `${preview.slab.emoji} ` : ''}{money(preview.amount_minor)}
                  <span style={{ marginLeft: 6, fontSize: 12, color: 'var(--muted)', fontWeight: 500 }}>
                    {preview.slab?.label ?? 'No band'} @ {preview.achievement_pct}%
                  </span>
                </span>
              )}
            </div>
          </div>
          {err ? <div className="notice err" style={{ marginTop: 10 }}><Ic k="bolt" /><div>{err}</div></div> : null}
        </div>
        <div className="af"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}><Ic k="check" />{busy ? 'Saving…' : 'Save plan'}</button></div>
      </div>
    </div>
  );
}


/* ==================================================================== */
/*  TEAMS (27aug Batch C item 7)                                         */
/*  Proper team creation: name a team + add multiple counsellors/members */
/*  (multi-select), edit membership. Target "Target For = Team" uses it.  */
/* ==================================================================== */
function Teams() {
  const { can } = useAuth();
  const teams = useFetch<any[]>('/teams', []);
  const [edit, setEdit] = useState<any | null>(null);
  const [adding, setAdding] = useState(false);
  const canManage = can('team.create') || can('team.update');
  return (
    <>
      <TableCard title="Teams" icon="users"
        more={can('team.create') ? <button className="btn primary" onClick={() => setAdding(true)} data-testid="team-add"><Ic k="plus" />New team</button> : null}
        cols={['Team', 'Branch', 'Vertical', 'Leader', 'Members', canManage ? 'Actions' : '']}
        empty="No teams yet — create one and add counsellors as members."
        rows={(teams.data ?? []).map((t: any): Cell[] => [
          <b>{t.name}</b>,
          t.branch_name ?? '—',
          t.vertical_name ?? '—',
          t.leader_name ?? '—',
          <span className="b-indigo" style={{ padding: '1px 8px', borderRadius: 999 }} data-testid={`team-members-${t.id}`}>{t.member_count ?? 0}</span>,
          canManage ? { node: <button className="btn" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => setEdit(t)} data-testid={`team-edit-${t.id}`}><Ic k="pencil" />Edit</button> } as Cell : '\u2014',
        ])} />
      {(adding || edit) && (
        <TeamModal team={edit} onClose={() => { setAdding(false); setEdit(null); }}
          onSaved={() => { setAdding(false); setEdit(null); teams.reload(); }} />
      )}
    </>
  );
}

function TeamModal({ team, onClose, onSaved }: { team?: any | null; onClose: () => void; onSaved: () => void }) {
  const ref = useRef_();
  const detail = useFetch<any>(team?.id ? `/teams/${team.id}` : null, [team?.id]);
  const [name, setName] = useState<string>(team?.name ?? '');
  const [branchId, setBranchId] = useState<string>(String(team?.branch_id ?? ''));
  const [verticalId, setVerticalId] = useState<string>(String(team?.vertical_id ?? ''));
  const [leaderId, setLeaderId] = useState<string>(String(team?.leader_id ?? ''));
  const [members, setMembers] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [seeded, setSeeded] = useState(false);
  if (!seeded && detail.data?.members) { setMembers((detail.data.members as any[]).map((m: any) => Number(m.id))); setSeeded(true); }
  const vOpts = ref.verticals.filter((vt: any) => !branchId || Number(vt.branch_id) === Number(branchId));
  const userOpts = selectableUsers(ref.users as any[], '');
  const toggle = (id: number) => setMembers((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  const save = async () => {
    if (!name.trim()) { toast('Give the team a name.', true); return; }
    setBusy(true);
    try {
      const body: any = {
        name: name.trim(),
        branch_id: branchId ? Number(branchId) : null,
        vertical_id: verticalId ? Number(verticalId) : null,
        leader_id: leaderId ? Number(leaderId) : null,
        member_ids: members,
      };
      if (team?.id) await api.patch(`/teams/${team.id}`, body);
      else await api.post('/teams', body);
      toast(team?.id ? 'Team updated' : 'Team created'); onSaved();
    } catch (e) { toast((e as Error).message, true); setBusy(false); }
  };
  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 620 }}>
        <div className="ah"><h3><Ic k="users" />{team?.id ? `Edit team — ${team.name}` : 'New team'}</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button></div>
        <div className="abody">
          <div className="form-grid">
            <div className="fld span2"><label htmlFor="tm-name">Team name <span className="star">*</span></label>
              <input id="tm-name" className="ainp" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. North Counsellors" data-testid="team-name" /></div>
            <div className="fld"><label htmlFor="tm-branch">Branch</label>
              <select id="tm-branch" className="ainp" value={branchId} onChange={(e) => { setBranchId(e.target.value); setVerticalId(''); }}>
                <option value="">— Any —</option>{ref.branches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
            <div className="fld"><label htmlFor="tm-vertical">Vertical</label>
              <select id="tm-vertical" className="ainp" value={verticalId} onChange={(e) => setVerticalId(e.target.value)} disabled={!branchId}>
                <option value="">— Any —</option>{vOpts.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></div>
            <div className="fld span2"><label htmlFor="tm-leader">Team leader</label>
              <select id="tm-leader" className="ainp" value={leaderId} onChange={(e) => setLeaderId(e.target.value)}>
                <option value="">— None —</option>{userOpts.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
            <div className="fld span2">
              <label>Members <span className="sub" style={{ fontWeight: 400 }}>(add multiple counsellors)</span></label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 240, overflow: 'auto', padding: '6px 8px', background: 'var(--surface-2,#f8fafc)', borderRadius: 8 }} data-testid="team-members-list">
                {userOpts.map((u: any) => (
                  <label key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 4px', fontSize: 13, cursor: 'pointer' }}>
                    <input type="checkbox" checked={members.includes(Number(u.id))} onChange={() => toggle(Number(u.id))} data-testid={`team-member-${u.id}`} />
                    {u.name}
                  </label>
                ))}
              </div>
              <div className="sub" style={{ marginTop: 4, fontSize: 11 }}>{members.length} member(s) selected.</div>
            </div>
          </div>
        </div>
        <div className="afoot">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy} data-testid="team-save"><Ic k="check" />{team?.id ? 'Save team' : 'Create team'}</button>
        </div>
      </div>
    </div>
  );
}
