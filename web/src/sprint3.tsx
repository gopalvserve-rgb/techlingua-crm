/**
 * Sprint-3 screens — Lead Scoring (admin-configurable rules) · SLA & TAT ·
 * Calendar · Walk-ins · Referrals.
 *
 * All five use only existing design-system blocks (kpi-strip, card, tbl, filters, badges,
 * add-modal shell), so they are parity-safe: no new visual language, no new nav items.
 */
import { useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, HBars, Kpis, TableCard, TempBadge, renderCell } from './renderer';
import { toast, useFetch, useRef_ } from './refdata';
import { ConfirmModal, DetailModal, KV, Section, fmtFull, rowActions } from './rowactions';
import { AddModal, EditSpec, need } from './forms';
import { AddMasterModal } from './mastermodal';
import { ScreenCtx } from './dyn';

const useScreen = () => useContext(ScreenCtx);

const fmtDT = (s?: string | null) => (s ? new Date(s).toLocaleString('en-IN', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
}) : '—');

/** Seconds -> "2h 14m" / "3d 4h" — the language a TAT report speaks. */
export const dur = (sec?: number | null) => {
  const s = Number(sec ?? 0);
  if (!s) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
};

/* ======================================================================== */
/*  LEAD SCORING — the rules are DATA. The admin edits them here.           */
/* ======================================================================== */

interface Rule {
  id: number; name: string; rule_type: string; config: Record<string, unknown>;
  points: number; sort_order: number; is_active: boolean;
}
interface RuleType { type: string; label: string; hint: string; fields: string[] }
interface ScoreSummary {
  hot: number; warm: number; cold: number; unscored: number; total: number; avg_score: number;
  config: { bands: { hot: number; warm: number }; min: number; max: number };
}

/** The rule form. Its inputs are GENERATED from the rule type's declared config fields. */
export function RuleModal({ initial, types, onClose, onSaved }: {
  initial?: Rule | null; types: RuleType[]; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [ruleType, setRuleType] = useState(initial?.rule_type ?? 'source_channel');
  const [points, setPoints] = useState(String(initial?.points ?? 10));
  const [active, setActive] = useState(initial?.is_active !== false);
  const [cfg, setCfg] = useState<Record<string, string>>(() => {
    const c = initial?.config ?? {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(c)) out[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
    return out;
  });
  const [busy, setBusy] = useState(false);
  const spec = types.find((t) => t.type === ruleType);

  const setC = (k: string, v: string) => setCfg((x) => ({ ...x, [k]: v }));

  /** Turn the form's text back into the typed config the engine expects. */
  const buildConfig = () => {
    const out: Record<string, unknown> = {};
    for (const f of spec?.fields ?? []) {
      const raw = (cfg[f] ?? '').trim();
      if (!raw) continue;
      if (f.endsWith('_ids')) out[f] = raw.split(',').map((x) => Number(x.trim())).filter(Boolean);
      else if (f === 'channels' || f === 'values' || f === 'types') out[f] = raw.split(',').map((x) => x.trim()).filter(Boolean);
      else if (['min', 'max', 'days', 'points_each'].includes(f)) out[f] = Number(raw);
      else out[f] = raw;
    }
    return out;
  };

  const save = async () => {
    if (!name.trim()) return toast('Rule name is required', true);
    if (!Number.isFinite(Number(points))) return toast('Points must be a number', true);
    setBusy(true);
    try {
      const body = {
        name: name.trim(), rule_type: ruleType, points: Number(points),
        config: buildConfig(), is_active: active,
      };
      if (initial) await api.patch(`/scoring/rules/${initial.id}`, body);
      else await api.post('/scoring/rules', body);
      toast(initial ? 'Rule updated — every lead re-scored' : 'Rule added — every lead re-scored');
      onSaved(); onClose();
    } catch (e: any) { toast(e.message, true); }
    finally { setBusy(false); }
  };

  const HINT: Record<string, string> = {
    channels: 'Comma-separated: meta, google, form, sheet, walkin, referral, manual',
    values: 'Comma-separated: low, med, high',
    types: 'Comma-separated: open, won, lost',
    source_ids: 'Comma-separated Lead Source ids',
    campaign_ids: 'Comma-separated Campaign ids',
    course_ids: 'Comma-separated Course ids',
    budget_ids: 'Comma-separated Budget-master ids',
    min: 'Minimum amount (needs a Fee/amount on the Budget master)',
    days: 'Number of days',
    points_each: 'Points per completed follow-up',
    max: 'Cap for the total points from this rule',
  };

  return (
    <div className="add-scrim">
      <div className="add-modal">
        <div className="ah">
          <h3><Ic k={initial ? 'pencil' : 'plus'} />{initial ? `Edit rule — ${initial.name}` : 'Add scoring rule'}</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          <div className="form-grid">
            <div className="fld span2">
              <label htmlFor="rule-name">Rule Name <span className="star">*</span></label>
              <input id="rule-name" className="ainp" value={name} onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Paid social source (Meta)" />
            </div>
            <div className="fld">
              <label htmlFor="rule-type">Rule Type <span className="star">*</span></label>
              <select id="rule-type" className="ainp" value={ruleType}
                onChange={(e) => { setRuleType(e.target.value); setCfg({}); }}>
                {types.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
              </select>
              {spec ? <div className="fhint">{spec.hint}</div> : null}
            </div>
            <div className="fld">
              <label htmlFor="rule-points">Points <span className="star">*</span></label>
              <input id="rule-points" className="ainp" type="number" value={points}
                onChange={(e) => setPoints(e.target.value)} />
              <div className="fhint">Negative values are penalties (e.g. &minus;15 for no response)</div>
            </div>
            {(spec?.fields ?? []).map((f) => (
              <div className="fld span2" key={f}>
                <label htmlFor={`cfg-${f}`}>{f.replace(/_/g, ' ').replace(/\bids\b/, 'IDs')}</label>
                <input id={`cfg-${f}`} className="ainp" value={cfg[f] ?? ''} onChange={(e) => setC(f, e.target.value)}
                  placeholder={HINT[f] || ''} />
                {HINT[f] ? <div className="fhint">{HINT[f]}</div> : null}
              </div>
            ))}
            <div className="fld">
              <label htmlFor="rule-status">Status</label>
              <select id="rule-status" className="ainp" value={active ? 'Active' : 'Inactive'}
                onChange={(e) => setActive(e.target.value === 'Active')}>
                <option>Active</option><option>Inactive</option>
              </select>
            </div>
          </div>
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={save}>
            {busy ? 'Saving…' : initial ? 'Save changes' : 'Add rule'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Band thresholds — one row, editable, no deploy. */
export function BandModal({ cfg, onClose, onSaved }: {
  cfg: ScoreSummary['config']; onClose: () => void; onSaved: () => void;
}) {
  const [hot, setHot] = useState(String(cfg.bands.hot));
  const [warm, setWarm] = useState(String(cfg.bands.warm));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.patch<{ rescored: number }>('/scoring/config', { hot: Number(hot), warm: Number(warm) });
      toast(`Bands saved — ${r.rescored} lead${r.rescored === 1 ? '' : 's'} re-banded`);
      onSaved(); onClose();
    } catch (e: any) { toast(e.message, true); }
    finally { setBusy(false); }
  };
  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 460 }}>
        <div className="ah">
          <h3><Ic k="cfg" />Band thresholds</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          <div className="form-grid">
            <div className="fld">
              <label htmlFor="band-hot">Hot at or above <span className="star">*</span></label>
              <input id="band-hot" className="ainp" type="number" value={hot} onChange={(e) => setHot(e.target.value)} />
            </div>
            <div className="fld">
              <label htmlFor="band-warm">Warm at or above <span className="star">*</span></label>
              <input id="band-warm" className="ainp" type="number" value={warm} onChange={(e) => setWarm(e.target.value)} />
            </div>
          </div>
          <div className="notice" style={{ marginTop: 12 }}>
            <Ic k="bolt" />
            <div>Anything below the Warm threshold is <b>Cold</b>. Saving re-bands every existing lead immediately.</div>
          </div>
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</button>
        </div>
      </div>
    </div>
  );
}

export function Scoring() {
  const { refreshTick, bump } = useScreen();
  const { can } = useAuth();
  const canManage = can('score.manage');
  const sum = useFetch<ScoreSummary>('/scoring/summary', [refreshTick]);
  const rules = useFetch<Rule[]>('/scoring/rules?include_inactive=1', [refreshTick]);
  const types = useFetch<RuleType[]>('/scoring/rule-types', []);
  const [edit, setEdit] = useState<Rule | null | undefined>(undefined);   // undefined = closed, null = add
  const [bands, setBands] = useState(false);
  const [del, setDel] = useState<Rule | null>(null);

  const s = sum.data;
  const cfg = s?.config ?? { bands: { hot: 70, warm: 40 }, min: 0, max: 100 };
  const scored = (s?.hot ?? 0) + (s?.warm ?? 0) + (s?.cold ?? 0);
  const pct = (n: number) => (scored > 0 ? Math.round((n / scored) * 100) : 0);
  const after = () => { sum.reload(); rules.reload(); bump(); };

  const doDelete = async () => {
    if (!del) return;
    try { await api.del(`/scoring/rules/${del.id}`); toast('Rule deleted — every lead re-scored'); after(); }
    catch (e: any) { toast(e.message, true); }
    finally { setDel(null); }
  };

  return (
    <>
      <Kpis items={[
        { lab: 'Hot leads', val: String(s?.hot ?? 0), ic: 'bolt' },
        { lab: 'Warm leads', val: String(s?.warm ?? 0), ic: 'target' },
        { lab: 'Cold leads', val: String(s?.cold ?? 0), ic: 'clock' },
        { lab: 'Average score', val: String(s?.avg_score ?? 0), ic: 'analytics' },
      ]} />

      <HBars title="Current band distribution"
        empty="Band distribution appears as leads are scored"
        rows={scored === 0 ? [] : [
          { label: `Hot (${cfg.bands.hot}–${cfg.max})`, val: `${s!.hot} leads`, pct: pct(s!.hot), color: 'var(--hot)' },
          { label: `Warm (${cfg.bands.warm}–${cfg.bands.hot - 1})`, val: `${s!.warm} leads`, pct: pct(s!.warm), color: 'var(--warm)' },
          { label: `Cold (${cfg.min}–${cfg.bands.warm - 1})`, val: `${s!.cold} leads`, pct: pct(s!.cold), color: 'var(--cold)' },
        ]} />

      <TableCard
        title="Scoring rules"
        icon="cfg"
        more={canManage ? (
          <span style={{ display: 'flex', gap: 12 }}>
            <a onClick={() => setBands(true)} style={{ cursor: 'pointer', color: 'var(--primary)' }}>Band thresholds</a>
            <a onClick={() => setEdit(null)} style={{ cursor: 'pointer', color: 'var(--primary)' }}>+ Add rule</a>
          </span>
        ) : undefined}
        cols={['Rule', 'Type', 'Condition', 'Points', 'Status', 'Actions']}
        rowClass={(i) => ((rules.data ?? [])[i].is_active === false ? 'row-inactive' : undefined)}
        rows={(rules.data ?? []).map((r) => {
          const cond = Object.entries(r.config ?? {})
            .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`).join(' · ');
          return [
            { node: <span className="nm">{r.name}</span> } as Cell,
            { mono: r.rule_type } as Cell,
            cond || '—',
            { b: [`${r.points > 0 ? '+' : ''}${r.points}`, r.points >= 0 ? 'b-green' : 'b-rose'] } as Cell,
            { b: [r.is_active ? 'Active' : 'Inactive', r.is_active ? 'b-green' : 'b-gray'] } as Cell,
            rowActions({
              onEdit: canManage ? () => setEdit(r) : undefined,
              onDelete: canManage ? () => setDel(r) : undefined,
            }),
          ];
        })}
        empty="No scoring rules yet — add one and every lead is scored immediately" />

      <div className="notice">
        <Ic k="bolt" />
        <div>
          Scores recompute <b>on every lead event</b> (create, stage change, follow-up completed,
          walk-in/referral capture) and an ageing sweep re-scores idle leads, so the
          &ldquo;no response&rdquo; penalties fire on their own. Editing a rule or a band
          re-scores every lead at once.
        </div>
      </div>

      {edit !== undefined && (
        <RuleModal initial={edit} types={types.data ?? []} onClose={() => setEdit(undefined)} onSaved={after} />
      )}
      {bands && <BandModal cfg={cfg} onClose={() => setBands(false)} onSaved={after} />}
      {del && (
        <ConfirmModal title="Delete scoring rule" danger confirmLabel="Delete rule"
          onClose={() => setDel(null)} onConfirm={doDelete}
          body={<p>Delete <b>{del.name}</b>? Every lead will be re-scored without it.</p>} />
      )}
    </>
  );
}

/* ======================================================================== */
/*  SLA & TAT                                                               */
/* ======================================================================== */

interface Policy {
  id: number; name: string; metric: 'first_response' | 'stage_duration';
  pipeline_id: number | null; stage_id: number | null; pipeline_name?: string | null; stage_name?: string | null;
  threshold_minutes: number; escalate_after_minutes: number; notify_manager: boolean; is_active: boolean;
}
interface SlaSummary {
  kpis: {
    open_breaches: number; breaches_today: number; escalated_today: number;
    responded: number; avg_response_seconds: number; met_on_time: number;
  };
  tat: Array<{ stage_name: string; moves: number; avg_seconds: number }>;
}

export function PolicyModal({ initial, onClose, onSaved }: { initial?: Policy | null; onClose: () => void; onSaved: () => void }) {
  const ref = useRef_();
  const [name, setName] = useState(initial?.name ?? '');
  const [metric, setMetric] = useState<Policy['metric']>(initial?.metric ?? 'first_response');
  const [pipeline, setPipeline] = useState(initial?.pipeline_id ? String(initial.pipeline_id) : '');
  const [stage, setStage] = useState(initial?.stage_id ? String(initial.stage_id) : '');
  const [threshold, setThreshold] = useState(String(initial?.threshold_minutes ?? 60));
  const [escalate, setEscalate] = useState(String(initial?.escalate_after_minutes ?? 0));
  const [notify, setNotify] = useState(initial?.notify_manager !== false);
  const [active, setActive] = useState(initial?.is_active !== false);
  const [stages, setStages] = useState<Array<{ id: number; name: string }>>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!pipeline) { setStages([]); return; }
    api.get<Array<{ id: number; name: string }>>(`/pipelines/${pipeline}/stages`)
      .then(setStages).catch(() => setStages([]));
  }, [pipeline]);

  const save = async () => {
    if (!name.trim()) return toast('Policy name is required', true);
    if (metric === 'stage_duration' && !stage) return toast('A stage-duration policy must name a stage', true);
    setBusy(true);
    try {
      const body = {
        name: name.trim(), metric,
        pipeline_id: pipeline ? Number(pipeline) : null,
        stage_id: stage ? Number(stage) : null,
        threshold_minutes: Number(threshold),
        escalate_after_minutes: Number(escalate) || 0,
        notify_manager: notify, is_active: active,
      };
      if (initial) await api.patch(`/sla/policies/${initial.id}`, body);
      else await api.post('/sla/policies', body);
      toast(initial ? 'SLA policy updated' : 'SLA policy added');
      onSaved(); onClose();
    } catch (e: any) { toast(e.message, true); }
    finally { setBusy(false); }
  };

  return (
    <div className="add-scrim">
      <div className="add-modal">
        <div className="ah">
          <h3><Ic k={initial ? 'pencil' : 'plus'} />{initial ? `Edit SLA — ${initial.name}` : 'Add SLA policy'}</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          <div className="form-grid">
            <div className="fld span2">
              <label htmlFor="sla-name">Policy Name <span className="star">*</span></label>
              <input id="sla-name" className="ainp" value={name} onChange={(e) => setName(e.target.value)}
                placeholder="e.g. First response within 30 minutes" />
            </div>
            <div className="fld">
              <label htmlFor="sla-metric">Metric <span className="star">*</span></label>
              <select id="sla-metric" className="ainp" value={metric}
                onChange={(e) => setMetric(e.target.value as Policy['metric'])}>
                <option value="first_response">First response</option>
                <option value="stage_duration">Stage duration</option>
              </select>
              <div className="fhint">
                {metric === 'first_response'
                  ? 'Clock runs from lead creation to the first human touch'
                  : 'Clock runs while the lead sits in the chosen stage'}
              </div>
            </div>
            <div className="fld">
              <label htmlFor="sla-threshold">Target (minutes) <span className="star">*</span></label>
              <input id="sla-threshold" className="ainp" type="number" value={threshold}
                onChange={(e) => setThreshold(e.target.value)} />
            </div>
            <div className="fld">
              <label htmlFor="sla-pipeline">Pipeline</label>
              <select id="sla-pipeline" className="ainp" value={pipeline}
                onChange={(e) => { setPipeline(e.target.value); setStage(''); }}>
                <option value="">All pipelines</option>
                {ref.pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <div className="fhint">A pipeline-specific policy beats the org-wide one</div>
            </div>
            <div className="fld">
              <label htmlFor="sla-stage">Stage</label>
              <select id="sla-stage" className="ainp" value={stage} onChange={(e) => setStage(e.target.value)}
                disabled={!pipeline}>
                <option value="">{pipeline ? 'Any stage' : 'Pick a pipeline first'}</option>
                {stages.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
              </select>
              <div className="fhint">A stage-specific policy beats a pipeline one</div>
            </div>
            <div className="fld">
              <label htmlFor="sla-escalate">Escalate after breach (minutes)</label>
              <input id="sla-escalate" className="ainp" type="number" value={escalate}
                onChange={(e) => setEscalate(e.target.value)} />
              <div className="fhint">0 = notify the moment it breaches</div>
            </div>
            <div className="fld">
              <label htmlFor="sla-notify">Notify manager on breach</label>
              <select id="sla-notify" className="ainp" value={notify ? 'Yes' : 'No'}
                onChange={(e) => setNotify(e.target.value === 'Yes')}>
                <option>Yes</option><option>No</option>
              </select>
            </div>
            <div className="fld">
              <label htmlFor="sla-status">Status</label>
              <select id="sla-status" className="ainp" value={active ? 'Active' : 'Inactive'}
                onChange={(e) => setActive(e.target.value === 'Active')}>
                <option>Active</option><option>Inactive</option>
              </select>
            </div>
          </div>
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={save}>
            {busy ? 'Saving…' : initial ? 'Save changes' : 'Add policy'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Sla() {
  const { refreshTick, bump, openLead } = useScreen();
  const { can } = useAuth();
  const canManage = can('sla.manage');
  const sum = useFetch<SlaSummary>('/sla/summary', [refreshTick]);
  const breaches = useFetch<any[]>('/sla/breaches?limit=100', [refreshTick]);
  const policies = useFetch<Policy[]>('/sla/policies?include_inactive=1', [refreshTick]);
  const [edit, setEdit] = useState<Policy | null | undefined>(undefined);
  const [del, setDel] = useState<Policy | null>(null);

  const k = sum.data?.kpis;
  const after = () => { sum.reload(); breaches.reload(); policies.reload(); bump(); };
  const rows = breaches.data ?? [];

  const doDelete = async () => {
    if (!del) return;
    try { await api.del(`/sla/policies/${del.id}`); toast('SLA policy deleted'); after(); }
    catch (e: any) { toast(e.message, true); }
    finally { setDel(null); }
  };

  return (
    <>
      <Kpis items={[
        { lab: 'Open breaches', val: String(k?.open_breaches ?? 0), ic: 'clock',
          tone: (k?.open_breaches ?? 0) > 0 ? 'down' : 'flat',
          delta: (k?.open_breaches ?? 0) > 0 ? 'needs attention' : undefined },
        { lab: 'Breached today', val: String(k?.breaches_today ?? 0), ic: 'bolt' },
        { lab: 'Avg first response', val: dur(k?.avg_response_seconds), ic: 'check' },
        { lab: 'Met on time', val: String(k?.met_on_time ?? 0), ic: 'target' },
      ]} />

      <TableCard
        title="SLA breaches — manager view"
        icon="clock"
        cols={['Lead', 'Owner', 'Policy', 'Stage', 'Target', 'Overdue by', 'Score']}
        rows={rows.map((b) => [
          { node: <span className="nm">{b.lead_name}</span> } as Cell,
          b.owner_name || 'Unassigned',
          b.policy_name,
          b.stage_name || '—',
          `${b.threshold_minutes}m`,
          { node: <span className="mono" style={{ color: 'var(--danger)' }}>{dur(b.overdue_seconds)}</span> } as Cell,
          { node: <TempBadge temperature={b.temperature} score={b.score} /> } as Cell,
        ])}
        onRowClick={(i) => openLead(Number(rows[i].lead_id))}
        empty="No SLA breaches — every lead is being answered inside its target" />

      <TableCard
        title="Turnaround time (TAT) by stage"
        icon="analytics"
        cols={['Stage', 'Completed moves', 'Average time in stage']}
        rows={(sum.data?.tat ?? []).map((t) => [
          t.stage_name,
          String(t.moves),
          { mono: dur(t.avg_seconds) } as Cell,
        ])}
        empty="TAT fills as leads move between stages — it feeds the TAT reports in Sprint 6" />

      <TableCard
        title="SLA policies"
        icon="cfg"
        more={canManage
          ? <a onClick={() => setEdit(null)} style={{ cursor: 'pointer', color: 'var(--primary)' }}>+ Add policy</a>
          : undefined}
        cols={['Policy', 'Metric', 'Applies to', 'Target', 'Escalate after', 'Notify manager', 'Status', 'Actions']}
        rowClass={(i) => ((policies.data ?? [])[i].is_active === false ? 'row-inactive' : undefined)}
        rows={(policies.data ?? []).map((p) => [
          { node: <span className="nm">{p.name}</span> } as Cell,
          { b: [p.metric === 'first_response' ? 'First response' : 'Stage duration',
            p.metric === 'first_response' ? 'b-indigo' : 'b-cyan'] } as Cell,
          p.stage_name ? `${p.pipeline_name} › ${p.stage_name}` : p.pipeline_name || 'All pipelines',
          { mono: `${p.threshold_minutes}m` } as Cell,
          p.escalate_after_minutes ? `${p.escalate_after_minutes}m` : 'Immediately',
          { b: [p.notify_manager ? 'Yes' : 'No', p.notify_manager ? 'b-green' : 'b-gray'] } as Cell,
          { b: [p.is_active ? 'Active' : 'Inactive', p.is_active ? 'b-green' : 'b-gray'] } as Cell,
          rowActions({
            onEdit: canManage ? () => setEdit(p) : undefined,
            onDelete: canManage ? () => setDel(p) : undefined,
          }),
        ])}
        empty="No SLA policies yet — add one to start measuring first response and stage time" />

      {edit !== undefined && <PolicyModal initial={edit} onClose={() => setEdit(undefined)} onSaved={after} />}
      {del && (
        <ConfirmModal title="Delete SLA policy" danger confirmLabel="Delete policy"
          onClose={() => setDel(null)} onConfirm={doDelete}
          body={<p>Delete <b>{del.name}</b>? Leads will stop being measured against it.</p>} />
      )}
    </>
  );
}

/* ======================================================================== */
/*  CALENDAR — follow-ups + demos + meetings. Google/Outlook sync is        */
/*  CREDENTIAL-BLOCKED and degrades to a clean "Not configured" state.      */
/* ======================================================================== */

interface CalEvent {
  id: number; title: string; type: string; starts_at: string; ends_at?: string | null;
  lead_id?: number | null; lead_name?: string | null; owner_name?: string | null;
  location?: string | null; notes?: string | null;
}
interface CalFeed {
  range: { from: string; to: string };
  events: CalEvent[];
  follow_ups: Array<{
    id: number; lead_id: number; lead_name: string; scheduled_at: string; status: string;
    type_name?: string | null; overdue: boolean; owner_name?: string | null; notes?: string | null;
  }>;
  sync: { provider: string | null; configured: boolean; missing: string[]; note: string };
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function EventModal({ onClose, onSaved, initial }: {
  onClose: () => void; onSaved: () => void; initial?: CalEvent | null;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [type, setType] = useState(initial?.type ?? 'meeting');
  const [starts, setStarts] = useState(initial?.starts_at ? initial.starts_at.slice(0, 16) : '');
  const [ends, setEnds] = useState(initial?.ends_at ? initial.ends_at.slice(0, 16) : '');
  const [location, setLocation] = useState(initial?.location ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!title.trim()) return toast('Title is required', true);
    if (!starts) return toast('Start date & time is required', true);
    setBusy(true);
    try {
      const body = {
        title: title.trim(), type,
        starts_at: new Date(starts).toISOString(),
        ends_at: ends ? new Date(ends).toISOString() : null,
        location: location || null, notes: notes || null,
      };
      if (initial) await api.patch(`/calendar/${initial.id}`, body);
      else await api.post('/calendar', body);
      toast(initial ? 'Event updated' : 'Event added');
      onSaved(); onClose();
    } catch (e: any) { toast(e.message, true); }
    finally { setBusy(false); }
  };

  return (
    <div className="add-scrim">
      <div className="add-modal">
        <div className="ah">
          <h3><Ic k={initial ? 'pencil' : 'plus'} />{initial ? `Edit event — ${initial.title}` : 'Add event'}</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          <div className="form-grid">
            <div className="fld span2">
              <label htmlFor="ev-title">Title <span className="star">*</span></label>
              <input id="ev-title" className="ainp" value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. IELTS demo class — Priya" />
            </div>
            <div className="fld">
              <label htmlFor="ev-type">Type</label>
              <select id="ev-type" className="ainp" value={type} onChange={(e) => setType(e.target.value)}>
                <option value="meeting">Meeting</option>
                <option value="demo">Demo</option>
                <option value="visit">Visit</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div className="fld">
              <label htmlFor="ev-start">Starts <span className="star">*</span></label>
              <input id="ev-start" className="ainp" type="datetime-local" value={starts}
                onChange={(e) => setStarts(e.target.value)} />
            </div>
            <div className="fld">
              <label htmlFor="ev-end">Ends</label>
              <input id="ev-end" className="ainp" type="datetime-local" value={ends}
                onChange={(e) => setEnds(e.target.value)} />
            </div>
            <div className="fld">
              <label htmlFor="ev-loc">Location</label>
              <input id="ev-loc" className="ainp" value={location} onChange={(e) => setLocation(e.target.value)} />
            </div>
            <div className="fld span2">
              <label htmlFor="ev-notes">Notes</label>
              <textarea id="ev-notes" className="ainp" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={save}>
            {busy ? 'Saving…' : initial ? 'Save changes' : 'Add event'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Calendar() {
  const { openLead, refreshTick, bump } = useScreen();
  const { can } = useAuth();
  const [cursor, setCursor] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [add, setAdd] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const last = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
  const feed = useFetch<CalFeed>(`/calendar?from=${ymd(first)}&to=${ymd(last)}`, [cursor.getTime(), refreshTick]);

  /** day (yyyy-mm-dd) -> the things happening that day */
  const byDay = useMemo(() => {
    const m = new Map<string, Array<{ kind: 'fu' | 'ev'; label: string; overdue?: boolean; type?: string; leadId?: number }>>();
    const push = (iso: string, item: any) => {
      const key = ymd(new Date(iso));
      m.set(key, [...(m.get(key) ?? []), item]);
    };
    for (const f of feed.data?.follow_ups ?? []) {
      push(f.scheduled_at, {
        kind: 'fu', leadId: f.lead_id, overdue: f.overdue && f.status === 'pending',
        label: `${f.type_name || 'Follow-up'} · ${f.lead_name}`,
      });
    }
    for (const e of feed.data?.events ?? []) {
      push(e.starts_at, { kind: 'ev', type: e.type, leadId: e.lead_id ?? undefined, label: e.title });
    }
    return m;
  }, [feed.data]);

  // a 6x7 grid starting on the Sunday on or before the 1st
  const cells = useMemo(() => {
    const start = new Date(first);
    start.setDate(start.getDate() - start.getDay());
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [first.getTime()]);

  const sync = feed.data?.sync;
  const todayKey = ymd(new Date());

  const doSync = async () => {
    setSyncing(true);
    try { await api.post('/calendar/sync'); toast('Calendar synced'); feed.reload(); }
    catch (e: any) { toast(e.message, true); }   // 503 "Not configured — still needed: …"
    finally { setSyncing(false); }
  };

  return (
    <>
      {sync && !sync.configured && (
        <div className="notice">
          <Ic k="bolt" />
          <div>
            <b>Google / Outlook sync — not configured.</b> {sync.note}{' '}
            Still needed: <b>{sync.missing.join(', ')}</b>. Add them under Settings › Integrations —
            no deploy, it starts syncing straight away.
          </div>
        </div>
      )}

      <div className="cal-head">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn" aria-label="Previous month"
            onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}>
            <Ic k="chev" />
          </button>
          <h3 style={{ margin: 0, fontFamily: 'var(--f-display)', fontSize: 15 }}>
            {cursor.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}
          </h3>
          <button className="btn" aria-label="Next month"
            onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}>
            <Ic k="chev" />
          </button>
          <button className="btn" onClick={() => { const d = new Date(); setCursor(new Date(d.getFullYear(), d.getMonth(), 1)); }}>
            Today
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" disabled={syncing} onClick={doSync}>
            <Ic k="bolt" />{syncing ? 'Syncing…' : 'Sync now'}
          </button>
          {can('calendar.create') && (
            <button className="btn primary" onClick={() => setAdd(true)}><Ic k="plus" />Add event</button>
          )}
        </div>
      </div>

      <div className="card"><div className="card-pad" style={{ paddingTop: 12 }}>
        <div className="cal-grid">
          {DOW.map((d) => <div className="cal-dow" key={d}>{d}</div>)}
          {cells.map((d, i) => {
            const key = ymd(d);
            const items = byDay.get(key) ?? [];
            const outside = d.getMonth() !== cursor.getMonth();
            return (
              <div className={`cal-cell${outside ? ' out' : ''}${key === todayKey ? ' today' : ''}`} key={i}
                data-day={key}>
                <div className="cal-num">{d.getDate()}</div>
                {items.slice(0, 3).map((it, j) => (
                  <div key={j}
                    className={`cal-ev ${it.kind === 'fu' ? 'fu' : ''}${it.overdue ? ' overdue' : ''}${it.type === 'demo' ? ' demo' : ''}`}
                    title={it.label}
                    onClick={() => it.leadId && openLead(it.leadId)}>
                    {it.label}
                  </div>
                ))}
                {items.length > 3 && <div className="cal-more">+{items.length - 3} more</div>}
              </div>
            );
          })}
        </div>
      </div></div>

      <TableCard title="This month" icon="cal"
        cols={['When', 'What', 'Lead', 'Owner', 'Type']}
        rows={[
          ...(feed.data?.follow_ups ?? []).map((f) => [
            { mono: fmtDT(f.scheduled_at), dim: false } as Cell,
            f.type_name || 'Follow-up',
            { node: <span className="nm" style={{ cursor: 'pointer' }} onClick={() => openLead(f.lead_id)}>{f.lead_name}</span> } as Cell,
            f.owner_name || '—',
            { b: [f.overdue && f.status === 'pending' ? 'Overdue' : 'Follow-up',
              f.overdue && f.status === 'pending' ? 'b-rose' : 'b-indigo'] } as Cell,
          ]),
          ...(feed.data?.events ?? []).map((e) => [
            { mono: fmtDT(e.starts_at) } as Cell,
            e.title,
            e.lead_name || '—',
            e.owner_name || '—',
            { b: [e.type.charAt(0).toUpperCase() + e.type.slice(1), 'b-cyan'] } as Cell,
          ]),
        ]}
        empty="Nothing scheduled this month" />

      {add && <EventModal onClose={() => setAdd(false)} onSaved={() => { feed.reload(); bump(); }} />}
    </>
  );
}

/* ======================================================================== */
/*  WALK-INS — assign on add                                                */
/* ======================================================================== */

/**
 * DEF-S34-03 — WALK-IN & REFERRAL EDIT.
 *
 * Before this, "Edit" on a walk-in opened the LEAD (so no walk-in field could ever be
 * corrected) and a referral had NO Edit action at all — View only. This is the DEF-2
 * family the client hit on day one ("Edit branch is not editable"), on two screens a
 * receptionist uses every day.
 *
 * Both reuse the SAME spec form as Add, so the two can never drift: every field the Add
 * form renders is here, prefilled and editable. The only locked fields are the
 * HIERARCHY PATH (Branch › Vertical › Pipeline › Campaign › Lead Source) — that is the
 * lead's immutable parent link, which is exactly and only what qa/09 permits `lock` for.
 */
const PATH_LOCK = ['Branch', 'Vertical', 'Pipeline', 'Campaign', 'Lead Source'];

/** a `datetime-local` input needs `YYYY-MM-DDTHH:mm` in LOCAL time, not an ISO Z string */
const toLocalDT = (iso?: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const num = (v: unknown): number | undefined => (v == null || v === '' ? undefined : Number(v));

export const walkInEditSpec = (w: any, after: () => void): EditSpec => ({
  title: `Edit Walk-in \u2014 ${w.visitor_name}`,
  initialVals: {
    'Name': w.visitor_name ?? '',
    'Mobile Number': w.phone ?? '',
    'Alternate Number': w.alt_phone ?? '',
    'WhatsApp Number': w.whatsapp_phone ?? '',
    'Email ID': w.email ?? '',
    'Branch': w.branch_name ?? '',
    'Vertical': w.vertical_name ?? '',
    'Pipeline': w.pipeline_name ?? '',
    'Campaign': w.campaign_name ?? '',
    'Lead Source': w.source_name ?? '',
    'Date & Time of Visit': toLocalDT(w.visited_at),
    'Purpose of Visit': w.purpose ?? '',
    'Course Interested': w.course_name ?? '',
    'Course Fee': w.course_fee != null ? String(Number(w.course_fee)) : '',
    'How did you hear about us?': w.heard_about_name ?? '',
    'Counsellor Assigned': w.counsellor_name ?? '',
    'Convert to Lead': w.lead_id || w.convert_to_lead ? '1' : '',
    'Remarks': w.remarks ?? '',
  },
  initialIds: {
    'Branch': num(w.branch_id), 'Vertical': num(w.vertical_id), 'Pipeline': num(w.pipeline_id),
    'Campaign': num(w.campaign_id), 'Lead Source': num(w.source_id),
    'Course Interested': num(w.course_id),
    'How did you hear about us?': num(w.heard_about_source_id),
    'Counsellor Assigned': num(w.counsellor_id),
  },
  lock: PATH_LOCK,
  submit: async (vals, ids) => {
    // EVERY editable field the form renders is in this body (the qa/09 rule, pinned by
    // the generic matrix test — a phantom field cannot survive here any more).
    await api.patch(`/walk-ins/${w.id}`, {
      visitor_name: need(vals['Name'], 'Name is required'),
      phone: need(vals['Mobile Number'], 'Mobile Number is required'),
      alt_phone: vals['Alternate Number'] || null,
      whatsapp_phone: vals['WhatsApp Number'] || null,
      email: vals['Email ID'] || null,
      visited_at: vals['Date & Time of Visit'] || undefined,
      purpose: vals['Purpose of Visit'] || null,
      course_id: ids['Course Interested'] ?? null,
      course_fee: vals['Course Fee'] === '' ? null : vals['Course Fee'],
      heard_about_source_id: ids['How did you hear about us?'] ?? null,
      counsellor_id: need(ids['Counsellor Assigned'], 'A walk-in must have a counsellor'),
      convert_to_lead: vals['Convert to Lead'] === '1',
      remarks: vals['Remarks'] || null,
    });
    after();
    return vals['Convert to Lead'] === '1' && !w.lead_id ? 'Walk-in updated and converted to a lead' : 'Walk-in updated';
  },
});

export const referralEditSpec = (r: any, after: () => void): EditSpec => ({
  title: `Edit Referral \u2014 ${r.referrer_name}`,
  initialVals: {
    'Referrer Type': r.referrer_type ?? '',
    'Referrer Name': r.referrer_name ?? '',
    'Referrer Contact Number': r.referrer_phone ?? '',
    'Referred Person Name': r.referred_name ?? '',
    'Referred Person Contact Number': r.referred_phone ?? '',
    'Referred Person WhatsApp Number': r.referred_whatsapp ?? '',
    'Referred Person Email': r.referred_email ?? '',
    'Relationship to Referrer': r.relationship ?? '',
    'Branch': r.branch_name ?? '',
    'Vertical': r.vertical_name ?? '',
    'Pipeline': r.pipeline_name ?? '',
    'Campaign': r.campaign_name ?? '',
    'Lead Source': r.source_name ?? '',
    'Course Interested': r.course_name ?? '',
    'Incentive / Reward Applicable': r.incentive ?? '',
    // #20 — prefill the Assigned Counsellor (label for display; id below drives it)
    'Assigned Counsellor': r.owner_name ?? '',
    'Referral Status': REF_STATUS[String(r.status)]?.[0] ?? 'Pending',
  },
  initialIds: {
    'Branch': num(r.branch_id), 'Vertical': num(r.vertical_id), 'Pipeline': num(r.pipeline_id),
    'Campaign': num(r.campaign_id), 'Lead Source': num(r.source_id),
    'Course Interested': num(r.course_id),
    // assigned_counsellor_id when set, else the lead's current owner (legacy referrals)
    'Assigned Counsellor': num(r.assigned_counsellor_id ?? r.owner_id),
  },
  lock: PATH_LOCK,
  submit: async (vals, ids) => {
    await api.patch(`/referrals/${r.id}`, {
      referrer_type: need(vals['Referrer Type'], 'Pick a referrer type'),
      referrer_name: need(vals['Referrer Name'], 'Referrer name is required'),
      referrer_phone: vals['Referrer Contact Number'] || null,
      referred_name: need(vals['Referred Person Name'], 'Referred person name is required'),
      referred_phone: need(vals['Referred Person Contact Number'], 'Referred person contact number is required'),
      referred_whatsapp: vals['Referred Person WhatsApp Number'] || null,
      referred_email: vals['Referred Person Email'] || null,
      relationship: vals['Relationship to Referrer'] || null,
      course_id: ids['Course Interested'] ?? null,
      incentive: vals['Incentive / Reward Applicable'] || null,
      owner_id: ids['Assigned Counsellor'] ?? null,   // #20 — re-assigns the referral's lead
      status: (vals['Referral Status'] || 'Pending').toLowerCase(),
    });
    after();
    return 'Referral updated';
  },
});

// #19 (UAT-R2) — the walk-in status LIST is now the m_walkin_status MASTER (RefData.walkinStatuses).
// This map survives only as a COLOUR + label fallback for the seeded codes (badges look the same);
// a client-added status renders with a neutral badge.
const WALKIN_STATUS: Record<string, [string, string]> = {
  waiting: ['Waiting', 'b-amber'], in_progress: ['In progress', 'b-indigo'],
  converted: ['Converted', 'b-green'], closed: ['Closed', 'b-gray'],
};
/** label + badge-colour for a walk-in status code, master name first, colour-map second. */
const walkInStatusCell = (code: string, master: Array<{ name: string; code?: string }>): [string, string] => {
  const m = master.find((x) => x.code === code);
  const label = m?.name ?? WALKIN_STATUS[code]?.[0] ?? code;
  const colour = WALKIN_STATUS[code]?.[1] ?? 'b-gray';
  return [label, colour];
};

export function WalkIns() {
  const { openLead, refreshTick, bump, openAdd } = useScreen();
  const { can } = useAuth();
  const ref = useRef_();
  const [addStatus, setAddStatus] = useState(false);
  const [today, setToday] = useState(true);
  const sum = useFetch<any>('/walk-ins/summary', [refreshTick]);
  const list = useFetch<any[]>(`/walk-ins?limit=100${today ? '&today=1' : ''}`, [today, refreshTick]);
  const [view, setView] = useState<any | null>(null);
  const [edit, setEdit] = useState<any | null>(null);
  // #19 — Delete action for walk-in records (soft-delete, RBAC-gated, confirm).
  const [del, setDel] = useState<any | null>(null);
  const [delBusy, setDelBusy] = useState(false);
  const rows = list.data ?? [];
  const after = () => { list.reload(); sum.reload(); bump(); };

  const setStatus = async (id: number, status: string) => {
    try { await api.patch(`/walk-ins/${id}`, { status }); toast('Walk-in updated'); after(); }
    catch (e: any) { toast(e.message, true); }
  };

  return (
    <>
      <Kpis items={[
        { lab: 'Walk-ins today', val: String(sum.data?.today ?? 0), ic: 'users' },
        { lab: 'Converted', val: String(sum.data?.converted ?? 0), ic: 'check' },
        { lab: 'Waiting', val: String(sum.data?.waiting ?? 0), ic: 'clock' },
        { lab: 'Avg wait', val: sum.data?.avg_wait ? `${sum.data.avg_wait}m` : '—', ic: 'clock' },
      ]} />

      <div className="filters">
        <button className={`fchip${today ? ' on' : ''}`} onClick={() => setToday(true)}>Today</button>
        <button className={`fchip${!today ? ' on' : ''}`} onClick={() => setToday(false)}>All walk-ins</button>
      </div>

      <TableCard
        title={today ? "Today's walk-ins" : 'All walk-ins'}
        icon="users"
        more={can('walkin.create')
          ? <a onClick={() => openAdd('dash.walkins')} style={{ cursor: 'pointer', color: 'var(--primary)' }}>+ Add walk-in</a>
          : undefined}
        cols={['Visitor', 'Interest', 'Assigned to', 'Branch', 'Visited', 'Score', 'Status', 'Actions']}
        rows={rows.map((w) => [
          { node: <span className="nm">{w.visitor_name}</span> } as Cell,
          w.course_name || w.purpose || '—',
          w.counsellor_name || '—',
          w.branch_name || '—',
          { mono: fmtDT(w.visited_at) } as Cell,
          { node: <TempBadge temperature={w.temperature} score={w.score} /> } as Cell,
          { node: (
            <select className="ainp" style={{ padding: '3px 6px', fontSize: 11.5, width: 118 }}
              aria-label={`Status for ${w.visitor_name}`}
              value={w.status} disabled={!can('walkin.update')}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => { if (e.target.value === '__add__') { setAddStatus(true); return; } setStatus(Number(w.id), e.target.value); }}>
              {((ref.walkinStatuses ?? []).length ? ref.walkinStatuses : Object.keys(WALKIN_STATUS).map((k) => ({ id: k, name: WALKIN_STATUS[k][0], code: k })))
                .map((o: any) => <option key={o.id} value={o.code ?? o.id}>{o.name}</option>)}
              {can('master.create') && <option value="__add__">＋ Add status…</option>}
            </select>
          ) } as Cell,
          // DEF-S34-03: Edit opens the WALK-IN, not the lead it created. (The lead is still
          // one click away — from the View modal, and from the visitor's name.)
          rowActions({
            onView: () => setView(w),
            onEdit: can('walkin.update') ? () => setEdit(w) : undefined,
            onDelete: can('walkin.delete') ? () => setDel(w) : undefined,
          }),
        ])}
        empty="No walk-ins recorded yet — add one and it becomes an assigned lead immediately" />

      <div className="notice">
        <Ic k="bolt" />
        <div>
          A walk-in <b>creates a lead and assigns it to the chosen counsellor immediately</b> —
          it never waits for round-robin. Walk-ins score <b>+25</b> by default (editable under Lead Scoring).
        </div>
      </div>

      {view && (
        <DetailModal title={`Walk-in — ${view.visitor_name}`} icon="users" onClose={() => setView(null)}>
          <Section title="Visitor">
            <KV rows={[
              ['Name', view.visitor_name],
              ['Phone', <span className="mono">{view.phone}</span>],
              ['Alternate', <span className="mono">{view.alt_phone || '—'}</span>],
              ['WhatsApp', <span className="mono">{view.whatsapp_phone || '—'}</span>],
              ['Email', view.email || '—'],
              ['Purpose', view.purpose || '—'],
              ['Course', view.course_name || '—'],
              ['Course fee', view.course_fee != null ? `\u20b9${Number(view.course_fee)}` : '—'],
              ['Heard about us', view.heard_about_name || '—'],
            ]} />
          </Section>
          <Section title="Visit">
            <KV rows={[
              ['Visited', fmtFull(view.visited_at)],
              ['Branch', view.branch_name || '—'],
              ['Vertical', view.vertical_name || '—'],
              ['Assigned to', view.counsellor_name || '—'],
              ['Status', renderCell({ b: walkInStatusCell(view.status, (ref.walkinStatuses ?? []) as any) })],
              ['Lead', view.lead_id
                ? <a style={{ cursor: 'pointer', color: 'var(--primary)' }}
                    onClick={() => { setView(null); openLead(Number(view.lead_id)); }}>Open lead #{view.lead_id}</a>
                : '—'],
              ['Remarks', view.remarks || '—'],
            ]} />
          </Section>
        </DetailModal>
      )}

      {edit && (
        <AddModal formKey="dash.walkins" onClose={() => setEdit(null)}
          edit={walkInEditSpec(edit, after)} />
      )}
      {/* #19 — Delete a walk-in record (soft-delete; the lead it created is kept). */}
      {del && (
        <ConfirmModal title="Delete walk-in" danger busy={delBusy} confirmLabel="Delete"
          body={<>Delete the walk-in for <b>{del.visitor_name}</b>? This removes the walk-in record.{del.lead_id ? ' The lead it created is kept.' : ''}</>}
          onConfirm={async () => {
            setDelBusy(true);
            try { await api.del(`/walk-ins/${del.id}`); toast('Walk-in deleted'); setDel(null); after(); }
            catch (e: any) { toast(e.message, true); }
            finally { setDelBusy(false); }
          }}
          onClose={() => setDel(null)} />
      )}
      {/* #19 — quick-add a Walk-in Status value without leaving the list. */}
      {addStatus && (
        <AddMasterModal type="walkin_status" onClose={() => setAddStatus(false)}
          onCreated={() => { ref.reload(); after(); }} />
      )}
    </>
  );
}

/* ======================================================================== */
/*  REFERRALS                                                               */
/* ======================================================================== */

const REF_STATUS: Record<string, [string, string]> = {
  pending: ['Pending', 'b-amber'], converted: ['Converted', 'b-green'],
  rewarded: ['Rewarded', 'b-indigo'], rejected: ['Rejected', 'b-gray'],
};

export function Referrals() {
  const { openLead, refreshTick, bump, openAdd } = useScreen();
  const { can } = useAuth();
  const sum = useFetch<any>('/referrals/summary', [refreshTick]);
  const list = useFetch<any[]>('/referrals?limit=100', [refreshTick]);
  const [view, setView] = useState<any | null>(null);
  const [edit, setEdit] = useState<any | null>(null);
  const rows = list.data ?? [];
  const after = () => { list.reload(); sum.reload(); bump(); };

  const setStatus = async (id: number, status: string) => {
    try { await api.patch(`/referrals/${id}`, { status }); toast('Referral updated'); after(); }
    catch (e: any) { toast(e.message, true); }
  };

  return (
    <>
      <Kpis cols={3} items={[
        { lab: 'Referrals (MTD)', val: String(sum.data?.mtd ?? 0), ic: 'users' },
        { lab: 'Converted', val: String(sum.data?.converted ?? 0), ic: 'check' },
        { lab: 'Rewards due', val: String(sum.data?.rewards_due ?? 0), ic: 'rupee' },
      ]} />

      <TableCard
        title="Referral tracker"
        icon="users"
        more={can('referral.create')
          ? <a onClick={() => openAdd('dash.referrals')} style={{ cursor: 'pointer', color: 'var(--primary)' }}>+ Add referral</a>
          : undefined}
        cols={['Referrer', 'Type', 'New lead', 'Owner', 'Score', 'Reward', 'Status', 'Actions']}
        rows={rows.map((r) => [
          { node: <span className="nm">{r.referrer_name}</span> } as Cell,
          r.referrer_type,
          { node: r.lead_id
            ? <span className="nm" style={{ cursor: 'pointer' }} onClick={() => openLead(Number(r.lead_id))}>{r.referred_name}</span>
            : <span>{r.referred_name}</span> } as Cell,
          r.owner_name || '—',
          { node: <TempBadge temperature={r.temperature} score={r.score} /> } as Cell,
          r.incentive || '—',
          { node: (
            <select className="ainp" style={{ padding: '3px 6px', fontSize: 11.5, width: 118 }}
              aria-label={`Status for ${r.referrer_name}`}
              value={r.status} disabled={!can('referral.update')}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setStatus(Number(r.id), e.target.value)}>
              {Object.keys(REF_STATUS).map((k) => <option key={k} value={k}>{REF_STATUS[k][0]}</option>)}
            </select>
          ) } as Cell,
          // DEF-S34-03: a referral had NO Edit action at all, so a wrong Referrer Name /
          // Relationship / Incentive could never be corrected.
          rowActions({
            onView: () => setView(r),
            onEdit: can('referral.update') ? () => setEdit(r) : undefined,
          }),
        ])}
        empty="No referrals recorded yet — capture one and the referred person becomes a lead" />

      {view && (
        <DetailModal title={`Referral — ${view.referrer_name}`} icon="users" onClose={() => setView(null)}>
          <Section title="Referrer">
            <KV rows={[
              ['Name', view.referrer_name],
              ['Type', view.referrer_type],
              ['Contact', <span className="mono">{view.referrer_phone || '—'}</span>],
              ['Relationship', view.relationship || '—'],
            ]} />
          </Section>
          <Section title="Referred person">
            <KV rows={[
              ['Name', view.referred_name],
              ['Contact', <span className="mono">{view.referred_phone}</span>],
              ['WhatsApp', <span className="mono">{view.referred_whatsapp || '—'}</span>],
              ['Email', view.referred_email || '—'],
              ['Course', view.course_name || '—'],
              ['Owner', view.owner_name || '—'],
              ['Lead', view.lead_id
                ? <a style={{ cursor: 'pointer', color: 'var(--primary)' }}
                    onClick={() => { setView(null); openLead(Number(view.lead_id)); }}>Open lead #{view.lead_id}</a>
                : '—'],
            ]} />
          </Section>
          <Section title="Reward">
            <KV rows={[
              ['Incentive', view.incentive || '—'],
              ['Status', renderCell({ b: REF_STATUS[view.status] ?? ['—', 'b-gray'] })],
              ['Captured', fmtFull(view.created_at)],
            ]} />
          </Section>
        </DetailModal>
      )}

      {edit && (
        <AddModal formKey="dash.referrals" onClose={() => setEdit(null)}
          edit={referralEditSpec(edit, after)} />
      )}
    </>
  );
}
