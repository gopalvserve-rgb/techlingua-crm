/**
 * CROSS-SELL — Student & Academic Administration › Cross-Sell (client 12 Nov 2026, as per the mockup).
 *
 *   Dashboard        KPI cards (additional revenue, opportunities, converted, conversion rate, average
 *                    value, pipeline value — each vs the previous period), filters, revenue split by
 *                    type, monthly trend, top recommendations with Notify, the 8-stage pipeline strip,
 *                    recent opportunities and upcoming follow-ups.
 *   Opportunities    every opportunity with its stage, type, value, owner and next follow-up; move it
 *                    along, book a follow-up, convert it through Sale Closure, or mark it lost.
 *   Recommendations  contacts × courses they don't hold, with an explainable match % and type.
 *   Campaigns        an offer to a group of contacts: an opportunity each + a WhatsApp / SMS / email
 *                    template through the normal guarded message queue.
 *   Reports          by counsellor, course, type, branch, campaign and lost reason.
 *   Settings         the rule map (with type and match strength) and the suggestion action log.
 *
 * Opportunities, attempts and recommendations are separate records; admissions, students and fees
 * are untouched — "Converted" comes from a real enrolment made in Sale Closure.
 */
import { useContext, useMemo, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, TableCard } from './renderer';
import { toast, useFetch, useRef_, selectableUsers } from './refdata';
import { FilterMulti, EnumMulti, ScreenCtx } from './dyn';
import { ListActions, downloadObjectsCsv } from './listtools';
import { LeadLookup } from './forms';
import { askConfirm } from './askdialog';
import { fmtINR } from './money';
import { DonutChart, HBarChart, LineChart } from './charts';
import { EnrolmentModal } from './sprint5';

/* ------------------------------------------------------------------ shared */

const STAGES: Array<[string, string]> = [
  ['new', 'New Opportunity'], ['assigned', 'Assigned'], ['contacted', 'Contacted'], ['interested', 'Interested'],
  ['quotation_sent', 'Quotation Sent'], ['negotiation', 'Negotiation'], ['converted', 'Converted'], ['lost', 'Lost'],
];
const STAGE_LABEL = Object.fromEntries(STAGES) as Record<string, string>;
const STAGE_BADGE: Record<string, string> = {
  new: 'b-indigo', assigned: 'b-cyan', contacted: 'b-green', interested: 'b-indigo', quotation_sent: 'b-amber',
  negotiation: 'b-amber', converted: 'b-green', lost: 'b-gray',
};
const TYPES: Array<[string, string]> = [['cross_sell', 'Cross-Sell'], ['upsell', 'Upsell'], ['downsell', 'Downsell'], ['cross_vertical', 'Cross-Vertical']];
const TYPE_LABEL = Object.fromEntries(TYPES) as Record<string, string>;
const TYPE_BADGE: Record<string, string> = { cross_sell: 'b-indigo', upsell: 'b-green', downsell: 'b-amber', cross_vertical: 'b-cyan' };
const PERIODS: Array<[string, string]> = [['this_month', 'This Month'], ['last_month', 'Last Month'], ['last_30', 'Last 30 days'],
  ['this_quarter', 'This Quarter'], ['this_year', 'This Year'], ['all', 'All time']];

const dt = (v: unknown) => (v ? new Date(String(v)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const dtt = (v: unknown) => (v ? new Date(String(v)).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const typeBadge = (t: string): Cell => ({ b: [TYPE_LABEL[t] ?? t, TYPE_BADGE[t] ?? 'b-gray'] });
const stageBadge = (s: string): Cell => ({ b: [STAGE_LABEL[s] ?? s, STAGE_BADGE[s] ?? 'b-gray'] });
const inr = (m: number) => fmtINR(Number(m ?? 0));
/** ₹4.8L / ₹12,650 — compact rupees for a KPI card (paise in). */
const inrShort = (minor: number) => {
  const r = Number(minor ?? 0) / 100;
  if (r >= 1e7) return `₹${(r / 1e7).toFixed(r >= 1e8 ? 0 : 1)}Cr`;
  if (r >= 1e5) return `₹${(r / 1e5).toFixed(1)}L`;
  return `₹${Math.round(r).toLocaleString('en-IN')}`;
};
const actionBadge = (a: string): Cell => {
  const map: Record<string, [string, string]> = { followup: ['Follow-up', 'b-amber'], lead: ['New lead', 'b-green'], dismissed: ['Dismissed', 'b-gray'] };
  const [l, c] = map[a] ?? [a, 'b-gray'];
  return { b: [l, c] };
};

interface Flt { period: string; branch: number[]; vertical: number[]; course: number[]; customer: string; stage: string[]; type: string[]; owner: number[] }
const qsOf = (f: Partial<Flt>, extra: Record<string, string | undefined> = {}) => {
  const p = new URLSearchParams();
  if (f.period) p.set('period', f.period);
  if (f.branch?.length) p.set('branch_ids', f.branch.join(','));
  if (f.vertical?.length) p.set('vertical_ids', f.vertical.join(','));
  if (f.course?.length) p.set('course_ids', f.course.join(','));
  if (f.owner?.length) p.set('owner_ids', f.owner.join(','));
  if (f.customer) p.set('customer_type', f.customer);
  if (f.stage?.length) p.set('stage', f.stage.join(','));
  if (f.type?.length) p.set('sale_type', f.type.join(','));
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  return p.toString();
};

/** The match % with its reasons on hover (the score is never magic). */
const MatchPct = ({ pct, parts }: { pct: number; parts?: Array<[string, number]> }) => (
  <span className={`bdg ${pct >= 85 ? 'b-green' : pct >= 70 ? 'b-indigo' : 'b-gray'}`} style={{ cursor: 'help' }}
    title={parts?.length ? `${parts.map(([k, v]) => `${k} +${v}`).join('\n')}\n= ${pct}%` : `${pct}%`}>{pct}%</span>
);

/* ------------------------------------------------------- opportunity modal */

function OppModal({ init, onClose, onSaved }: { init?: any; onClose: () => void; onSaved: () => void }) {
  const ref = useRef_();
  const [leadId, setLeadId] = useState<number | undefined>(init?.lead_id);
  const [leadLabel, setLeadLabel] = useState<string>(init?.full_name ?? '');
  const [courseId, setCourseId] = useState<string>(String(init?.course_id ?? ''));
  const [fromCourseId, setFromCourseId] = useState<string>(String(init?.from_course_id ?? ''));
  const [type, setType] = useState<string>(init?.sale_type ?? '');
  const [value, setValue] = useState<string>(init?.value_minor ? String(Number(init.value_minor) / 100) : '');
  const [owner, setOwner] = useState<string>(String(init?.owner_id ?? ''));
  const [when, setWhen] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const courses = (ref.courses as any[]).filter((c) => c.is_active !== false);
  const pickCourse = (id: string) => {
    setCourseId(id);
    const c = courses.find((x) => String(x.id) === id);
    if (c && !value && Number(c.meta?.fee ?? 0) > 0) setValue(String(c.meta.fee));
  };
  const save = async () => {
    if (!leadId) { toast('Pick the contact (student or lead)', true); return; }
    if (!courseId) { toast('Pick the course to offer', true); return; }
    setBusy(true);
    try {
      const r = await api.post<any>('/cross-sell/opportunities', {
        lead_id: leadId, course_id: Number(courseId), from_course_id: fromCourseId ? Number(fromCourseId) : undefined,
        sale_type: type || undefined, value: value || undefined, owner_id: owner ? Number(owner) : undefined,
        next_follow_up_at: when || undefined, note: note || undefined, match_pct: init?.match_pct,
        from_recommendation: !!init?.match_pct,
      });
      toast(`Opportunity created — ${TYPE_LABEL[r.sale_type] ?? 'Cross-Sell'}, ${inr(r.value_minor)}`);
      onSaved(); onClose();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 640 }} data-testid="cs-opp-modal">
        <div className="ah"><h3><Ic k="target" />Create opportunity</h3><button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button></div>
        <div className="abody">
          <div className="form-grid">
            <div className="fld span2"><label htmlFor="cs-lead">Student / contact <span className="star">*</span></label>
              {init?.lead_id ? <input className="ainp" value={leadLabel} readOnly disabled />
                : <LeadLookup inputId="cs-lead" value={leadLabel} onPick={(id, label) => { setLeadId(id); setLeadLabel(label); }} />}</div>
            <div className="fld"><label>Recommended course <span className="star">*</span></label>
              <select className="ainp" value={courseId} onChange={(e) => pickCourse(e.target.value)} data-testid="cs-course">
                <option value="">Select a course</option>{courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></div>
            <div className="fld"><label>Current course</label>
              <select className="ainp" value={fromCourseId} onChange={(e) => setFromCourseId(e.target.value)}>
                <option value="">Their latest enrolled course</option>{courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></div>
            <div className="fld"><label>Type</label>
              <select className="ainp" value={type} onChange={(e) => setType(e.target.value)}>
                <option value="">Work it out (vertical / course family / fee)</option>{TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select></div>
            <div className="fld"><label>Expected value (₹)</label>
              <input className="ainp" type="number" min={0} value={value} onChange={(e) => setValue(e.target.value)} placeholder="Course fee" data-testid="cs-value" /></div>
            <div className="fld"><label>Owner</label>
              <select className="ainp" value={owner} onChange={(e) => setOwner(e.target.value)}>
                <option value="">The contact's counsellor</option>{selectableUsers(ref.users).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select></div>
            <div className="fld"><label>Next follow-up</label>
              <input className="ainp" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></div>
            <div className="fld span2"><label>Note</label>
              <textarea className="ainp" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. asked about weekend batches" /></div>
          </div>
        </div>
        <div className="af"><button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={save} data-testid="cs-opp-save"><Ic k="check" />{busy ? 'Saving…' : 'Create opportunity'}</button></div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------ opportunity detail */

function OppDetail({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const { can } = useAuth();
  const ref = useRef_();
  const screen = useContext(ScreenCtx);
  const [tick, setTick] = useState(0);
  const d = useFetch<any>(`/cross-sell/opportunities/${id}`, [id, tick]);
  const o = d.data;
  const [busy, setBusy] = useState(false);
  const [when, setWhen] = useState('');
  const [fuNote, setFuNote] = useState('');
  const [lost, setLost] = useState('');
  const [showLost, setShowLost] = useState(false);
  const [convert, setConvert] = useState(false);
  const patch = async (body: any, msg: string) => {
    setBusy(true);
    try { await api.patch(`/cross-sell/opportunities/${id}`, body); toast(msg); setTick((t) => t + 1); onChanged(); }
    catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  if (!o) return null;
  const closed = o.stage === 'converted' || o.stage === 'lost';
  const open = STAGES.filter(([k]) => k !== 'converted' && k !== 'lost');
  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 760 }} data-testid="cs-opp-detail">
        <div className="ah"><h3><Ic k="target" />{o.full_name} — {o.course_name}</h3><button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button></div>
        <div className="abody">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
            <span className={`bdg ${STAGE_BADGE[o.stage]}`}>{STAGE_LABEL[o.stage]}</span>
            <span className={`bdg ${TYPE_BADGE[o.sale_type]}`}>{TYPE_LABEL[o.sale_type]}</span>
            {o.match_pct != null ? <MatchPct pct={o.match_pct} /> : null}
            <span className="sub">{o.from_course_name ?? '—'} → <b>{o.course_name}</b></span>
          </div>
          <table className="tbl"><tbody>
            {([
              ['Contact', <span>{o.full_name} <span className="mono sub">{o.phone}</span></span>],
              ['Value', o.stage === 'converted' ? `${inr(o.converted_value_minor)} (booked on enrolment ${o.enrolment_no ?? ''})` : inr(o.value_minor)],
              ['Owner', o.owner_name ?? '—'], ['Branch · Vertical', [o.branch_name, o.vertical_name].filter(Boolean).join(' · ') || '—'],
              ['Source', o.campaign_name ? `Campaign: ${o.campaign_name}` : o.source === 'recommendation' ? 'Recommendation' : 'Added by hand'],
              ['Next follow-up', o.follow_up_at ? `${dtt(o.follow_up_at)} (${o.follow_up_status})` : '—'],
              ...(o.stage === 'lost' ? [['Lost because', o.lost_reason ?? '—']] : []),
              ...(o.note ? [['Note', o.note]] : []),
            ] as Array<[string, any]>).map(([k, v]) => <tr key={k}><td style={{ width: 170, color: 'var(--muted)' }}>{k}</td><td>{v}</td></tr>)}
          </tbody></table>

          {can('crosssell.act') && !closed ? (
            <>
              <h4 style={{ margin: '14px 0 6px' }}>Move to stage</h4>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {open.map(([k, l]) => (
                  <button key={k} className={`btn sm${o.stage === k ? ' primary' : ''}`} disabled={busy || o.stage === k}
                    onClick={() => patch({ stage: k }, `Moved to ${l}`)} data-testid={`cs-stage-${k}`}>{l}</button>
                ))}
                <button className="btn sm primary" disabled={busy} onClick={() => setConvert(true)} data-testid="cs-convert"><Ic k="check" />Convert (Sale Closure)</button>
                <button className="btn sm danger" disabled={busy} onClick={() => setShowLost((v) => !v)} data-testid="cs-lost"><Ic k="x" />Lost</button>
              </div>
              {showLost ? (
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <input className="ainp" placeholder="Why was it lost? (e.g. fees too high, timing)" value={lost} onChange={(e) => setLost(e.target.value)} data-testid="cs-lost-reason" />
                  <button className="btn danger" disabled={busy || !lost.trim()} onClick={() => patch({ stage: 'lost', lost_reason: lost }, 'Marked lost')} data-testid="cs-lost-save">Mark lost</button>
                </div>
              ) : null}
              <h4 style={{ margin: '14px 0 6px' }}>Next follow-up</h4>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <input className="ainp" type="datetime-local" style={{ maxWidth: 230 }} value={when} onChange={(e) => setWhen(e.target.value)} data-testid="cs-fu-when" />
                <input className="ainp" style={{ flex: 1, minWidth: 180 }} placeholder="What to discuss" value={fuNote} onChange={(e) => setFuNote(e.target.value)} />
                <button className="btn" disabled={busy || !when} onClick={() => { patch({ next_follow_up_at: when, follow_up_note: fuNote }, 'Follow-up booked'); setWhen(''); setFuNote(''); }} data-testid="cs-fu-save"><Ic k="clock" />Book</button>
              </div>
              <h4 style={{ margin: '14px 0 6px' }}>Owner &amp; value</h4>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <select className="ainp" style={{ maxWidth: 240 }} value={String(o.owner_id ?? '')} onChange={(e) => e.target.value && patch({ owner_id: Number(e.target.value) }, 'Owner changed')}>
                  {selectableUsers(ref.users).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
                <input className="ainp" style={{ maxWidth: 160 }} type="number" min={0} defaultValue={Number(o.value_minor) / 100}
                  onBlur={(e) => { if (Number(e.target.value) * 100 !== Number(o.value_minor)) patch({ value: e.target.value }, 'Value updated'); }} aria-label="Value (₹)" />
              </div>
            </>
          ) : null}

          <h4 style={{ margin: '14px 0 6px' }}>History</h4>
          {(o.history ?? []).map((h: any) => (
            <div key={h.id} className="sub" style={{ padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
              <b>{h.from_stage ? `${STAGE_LABEL[h.from_stage] ?? h.from_stage} → ` : ''}{STAGE_LABEL[h.to_stage] ?? h.to_stage}</b> · {dtt(h.created_at)}{h.actor_name ? ` · ${h.actor_name}` : ''}{h.note ? <div>{h.note}</div> : null}
            </div>
          ))}
        </div>
        <div className="af">
          <button className="btn" onClick={() => screen?.openLead?.(Number(o.lead_id))}><Ic k="eye" />Open contact</button>
          <span style={{ flex: 1 }} />
          {can('crosssell.manage') ? <button className="btn danger" disabled={busy} onClick={async () => {
            if (!await askConfirm('Delete this opportunity? Its history goes with it; the contact and any enrolment stay.')) return;
            try { await api.del(`/cross-sell/opportunities/${id}`); toast('Opportunity deleted'); onChanged(); onClose(); } catch (e) { toast((e as Error).message, true); }
          }}><Ic k="trash" /></button> : null}
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
      {convert ? <EnrolmentModal prefill={{ lead_id: o.lead_id, lead_name: o.full_name, course_id: o.course_id, counsellor_id: o.owner_id, fee_minor: o.value_minor }}
        onClose={() => setConvert(false)} onSaved={() => { setConvert(false); setTick((t) => t + 1); onChanged(); toast('Sale closed — the opportunity converts once the enrolment is active'); }} /> : null}
    </div>
  );
}

/* --------------------------------------------------------- campaign modal */

function CampaignModal({ init, onClose, onSent }: { init?: any; onClose: () => void; onSent: () => void }) {
  const ref = useRef_();
  const templates = useFetch<any[]>('/templates?channel=whatsapp');
  const [name, setName] = useState(init?.course_name ? `${init.course_name} offer` : '');
  const [courseId, setCourseId] = useState(String(init?.course_id ?? ''));
  const [fromId, setFromId] = useState(String(init?.from_course_id ?? ''));
  const [branch, setBranch] = useState('');
  const [vertical, setVertical] = useState('');
  const [tpl, setTpl] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const aq = courseId ? `course_id=${courseId}${fromId ? `&from_course_id=${fromId}` : ''}${branch ? `&branch_id=${branch}` : ''}${vertical ? `&vertical_id=${vertical}` : ''}` : null;
  const aud = useFetch<any>(aq ? `/cross-sell/campaigns/audience?${aq}` : null, [aq]);
  const courses = (ref.courses as any[]);
  const send = async () => {
    if (!name.trim() || !courseId) { toast('Name the campaign and pick the course', true); return; }
    if (!await askConfirm(`Create ${aud.data?.count ?? 0} opportunities${tpl ? ' and send the WhatsApp template to them' : ''}?`)) return;
    setBusy(true);
    try {
      const r = await api.post<any>('/cross-sell/campaigns', { name, course_id: Number(courseId), from_course_id: fromId ? Number(fromId) : undefined,
        branch_id: branch || undefined, vertical_id: vertical || undefined, template_id: tpl ? Number(tpl) : undefined });
      setResult(r); toast(`${r.opportunities} opportunities created${tpl ? ` · ${r.notified} messages queued` : ''}`); onSent();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 680 }} data-testid="cs-campaign-modal">
        <div className="ah"><h3><Ic k="send" />Cross-sell campaign</h3><button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button></div>
        <div className="abody">
          {result ? (
            <div className="notice"><Ic k="check" /><div><b>Sent.</b> {result.audience} contacts · {result.opportunities} opportunities created
              {result.notified != null ? ` · ${result.notified} messages queued, ${result.skipped} skipped (opted out / limits), ${result.failed} could not be built` : ''}.</div></div>
          ) : (
            <div className="form-grid">
              <div className="fld span2"><label>Campaign name <span className="star">*</span></label>
                <input className="ainp" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. German A2 — November offer" data-testid="cs-camp-name" /></div>
              <div className="fld"><label>Offer course <span className="star">*</span></label>
                <select className="ainp" value={courseId} onChange={(e) => setCourseId(e.target.value)} data-testid="cs-camp-course">
                  <option value="">Select</option>{courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
              <div className="fld"><label>Only students of</label>
                <select className="ainp" value={fromId} onChange={(e) => setFromId(e.target.value)}>
                  <option value="">Anyone the offer suits</option>{courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
              <div className="fld"><label>Branch</label>
                <select className="ainp" value={branch} onChange={(e) => { setBranch(e.target.value); setVertical(''); }}>
                  <option value="">All branches</option>{ref.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
              <div className="fld"><label>Vertical</label>
                <select className="ainp" value={vertical} onChange={(e) => setVertical(e.target.value)}>
                  <option value="">All verticals</option>{ref.verticals.filter((v) => !branch || Number(v.branch_id) === Number(branch)).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></div>
              <div className="fld span2"><label>WhatsApp template (optional)</label>
                <select className="ainp" value={tpl} onChange={(e) => setTpl(e.target.value)}>
                  <option value="">Don't message — just create the opportunities</option>
                  {(templates.data ?? []).map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
                <div className="hint">Messages go through the normal queue — opt-outs, daily limits and business hours apply.</div></div>
              <div className="fld span2"><label>Audience</label>
                <div className="sub" data-testid="cs-camp-audience">{!courseId ? 'Pick the offer course to see who qualifies.'
                  : aud.loading ? 'Counting…' : `${aud.data?.count ?? 0} contacts qualify (converted students without this course and no open opportunity for it)`}</div>
                {(aud.data?.contacts ?? []).slice(0, 8).map((c: any) => (
                  <div key={c.lead_id} className="sub">· {c.full_name} — {c.from_course_name ?? '—'} <MatchPct pct={c.match_pct} parts={c.match_parts} /></div>))}
                {(aud.data?.count ?? 0) > 8 ? <div className="sub">… and {aud.data.count - 8} more</div> : null}
              </div>
            </div>
          )}
        </div>
        <div className="af"><button className="btn" onClick={onClose}>{result ? 'Close' : 'Cancel'}</button>
          {!result ? <button className="btn primary" disabled={busy || !aud.data?.count} onClick={send} data-testid="cs-camp-send"><Ic k="send" />{busy ? 'Sending…' : 'Create & send'}</button> : null}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- act modal */

function ActModal({ row, onClose, onDone }: { row: any; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [when, setWhen] = useState('');
  const [note, setNote] = useState('');
  const act = async (action: 'followup' | 'lead' | 'dismissed') => {
    setBusy(true);
    try {
      const body: any = { lead_id: row.lead_id, suggested_course_id: row.course_id ?? row.suggested_course_id, action };
      if (action === 'followup' && when) body.scheduled_at = when;
      if (note.trim()) body.note = note.trim();
      const r = await api.post<any>('/cross-sell/act', body);
      toast(action === 'lead' ? (r?.new_lead_id ? `New lead #${r.new_lead_id} created (${r.outcome})` : 'Cross-sell lead processed')
        : action === 'followup' ? 'Cross-sell follow-up created' : 'Suggestion dismissed');
      onDone(); onClose();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 560 }}>
        <div className="ah"><h3><Ic k="bolt" />Other actions</h3><button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button></div>
        <div className="abody">
          <div className="sub" style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
            <span>Contact: <b>{row.full_name}</b></span><span>Current: <b>{row.from_course_name ?? '—'}</b></span>
            <span>Suggest: <b>{row.course_name}</b></span>
          </div>
          <div style={{ marginTop: 12 }}><label className="sub" style={{ fontWeight: 700 }}>Follow-up date (optional — defaults to tomorrow)</label>
            <input className="ainp" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></div>
          <div style={{ marginTop: 10 }}><label className="sub" style={{ fontWeight: 700 }}>Note (optional)</label>
            <textarea className="ainp" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></div>
        </div>
        <div className="af" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="btn" disabled={busy} onClick={() => act('dismissed')}><Ic k="x" />Dismiss</button>
          <span style={{ flex: 1 }} />
          <button className="btn" disabled={busy} onClick={() => act('lead')}><Ic k="plus" />Create new lead</button>
          <button className="btn primary" disabled={busy} onClick={() => act('followup')}><Ic k="clock" />Create follow-up</button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- dashboard */

function Delta({ v, unit = '%' }: { v: number | null | undefined; unit?: string }) {
  if (v == null) return <span className="sub">—</span>;
  const up = v >= 0;
  return <span style={{ color: up ? 'var(--success)' : 'var(--danger)', fontSize: 12, fontWeight: 600 }}><Ic k={up ? 'up' : 'down'} />{Math.abs(v)}{unit}</span>;
}

function DashboardTab({ f, setF, open, notify, goOpps }: { f: Flt; setF: (f: Flt) => void; open: (id: number) => void; notify: (r: any) => void; goOpps: (stage?: string) => void }) {
  const ref = useRef_();
  const q = qsOf({ ...f, stage: f.stage, type: [] });
  const d = useFetch<any>(`/cross-sell/dashboard?${q}`, [q]);
  const x = d.data;
  const k = x?.kpis; const c = x?.change;
  const cards: Array<[string, string, string, any]> = [
    ['bolt', k ? inrShort(k.revenue_minor) : '—', 'Additional Revenue', <Delta v={c?.revenue_minor} />],
    ['users', String(k?.opportunities ?? 0), 'Opportunities', <Delta v={c?.opportunities} />],
    ['target', String(k?.converted ?? 0), 'Converted', <Delta v={c?.converted} />],
    ['analytics', k?.conversion_pct != null ? `${k.conversion_pct}%` : '—', 'Conversion Rate', <Delta v={c?.conversion_pct} unit=" pts" />],
    ['rupee', k ? inrShort(k.avg_value_minor) : '—', 'Avg Opportunity Value', <Delta v={c?.avg_value_minor} />],
    ['rupee', k ? inrShort(k.pipeline_value_minor) : '—', 'Pipeline Value', <span className="sub">open now</span>],
  ];
  const typeData = (x?.by_type ?? []).map((t: any) => ({ label: TYPE_LABEL[t.sale_type], value: t.revenue_minor }));
  const typeHasRevenue = typeData.some((t: any) => t.value > 0);
  return (
    <>
      <div className="cs-kpis">
        {cards.map(([ic, val, lab, delta]) => (
          <div className="card cs-kpi" key={lab}><div className="ic indigo"><Ic k={ic} /></div>
            <div className="cs-kv">{val}</div><div className="sub">{lab}</div><div>{delta}</div></div>
        ))}
      </div>
      <div className="toolbar-surface" style={{ marginTop: 12 }}><div className="filters">
        <FilterMulti label="Branch" icon="branch" value={f.branch} options={ref.branches} onChange={(v) => setF({ ...f, branch: v, vertical: [] })} />
        <FilterMulti label="Vertical" icon="grid" value={f.vertical} options={ref.verticals.filter((v) => !f.branch.length || f.branch.includes(Number(v.branch_id)))} onChange={(v) => setF({ ...f, vertical: v })} />
        <FilterMulti label="Course" icon="book" value={f.course} options={ref.courses as any} onChange={(v) => setF({ ...f, course: v })} />
        <select className="ainp" style={{ maxWidth: 190 }} aria-label="Customer type" value={f.customer} onChange={(e) => setF({ ...f, customer: e.target.value })}>
          <option value="">All customers</option><option value="student">Students</option><option value="lead">Leads (not yet students)</option></select>
        <EnumMulti label="Status" icon="list" value={f.stage} options={STAGES.map(([id, name]) => ({ id, name }))} onChange={(v) => setF({ ...f, stage: v })} />
        <button className="btn sm" onClick={() => setF({ ...f, branch: [], vertical: [], course: [], customer: '', stage: [] })}><Ic k="refresh" />Reset</button>
      </div></div>

      <div className="cs-grid" style={{ marginTop: 12 }}>
        <div className="card">
          <div className="card-head"><h3><Ic k="analytics" />Sales growth overview</h3></div>
          <div className="card-pad">
            {typeHasRevenue ? <DonutChart data={typeData} fmt={inrShort} ariaLabel="Additional revenue by type" />
              : <div className="empty-note">No converted cross-sales in this period yet — revenue by type appears once an opportunity converts.</div>}
            <div className="cs-mini">
              <div><div className="sub">Additional revenue by month</div>
                <LineChart data={(x?.months ?? []).map((m: any) => ({ label: m.label, value: m.revenue_minor }))} fmt={inrShort} ariaLabel="Additional revenue by month" height={150} /></div>
              <div><div className="sub">Opportunities created by month</div>
                <LineChart data={(x?.months ?? []).map((m: any) => ({ label: m.label, value: m.opportunities }))} fmt={(v) => String(Math.round(v))} ariaLabel="Opportunities by month" height={150} /></div>
            </div>
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h3><Ic k="award" />Top recommendations</h3></div>
          <div className="card-pad">
            {(x?.top_recommendations ?? []).length === 0 ? <div className="empty-note">No recommendations right now — add rules in Settings, or enrol students so they have a next course.</div>
              : (x.top_recommendations as any[]).map((r) => (
                <div className="cs-rec" key={`${r.from_course_id}-${r.course_id}`}>
                  <div style={{ flex: 1, minWidth: 0 }}><b>{r.course_name}</b> <span className={`bdg ${TYPE_BADGE[r.sale_type]}`}>{TYPE_LABEL[r.sale_type]}</span>
                    <div className="sub">For {r.from_course_name ?? 'your'} students · {r.contacts} contact{r.contacts === 1 ? '' : 's'}</div></div>
                  <MatchPct pct={r.match_pct} />
                  <button className="btn sm" onClick={() => notify(r)} data-testid="cs-notify">Notify</button>
                </div>
              ))}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="card-head"><h3><Ic k="filter" />Cross-sell pipeline</h3><a className="cell-link" onClick={() => goOpps()}>View pipeline →</a></div>
        <div className="card-pad"><div className="cs-strip">
          {(x?.stages ?? STAGES.map(([s]) => ({ stage: s, count: 0 }))).map((s: any, i: number) => (
            <button key={s.stage} className={`cs-step st-${s.stage}`} onClick={() => goOpps(s.stage)} title={s.value_minor ? inr(s.value_minor) : undefined}>
              <span className="cs-n">{i + 1}</span><span>{STAGE_LABEL[s.stage]}<br /><b>({s.count})</b></span>
            </button>
          ))}
        </div></div>
      </div>

      <div className="cs-grid" style={{ marginTop: 12 }}>
        <TableCard title="Recent opportunities" icon="list"
          cols={['Customer', 'Current course', 'Recommended course', 'Type', 'Value', 'Status', 'Next follow-up', '']}
          empty="No opportunities yet — create one, or start from a recommendation."
          rows={(x?.recent ?? []).map((o: any): Cell[] => [
            { node: <b>{o.full_name}</b> }, o.from_course_name ?? '—', o.course_name ?? '—', typeBadge(o.sale_type),
            { mono: inr(o.stage === 'converted' ? o.converted_value_minor : o.value_minor) }, stageBadge(o.stage), dtt(o.next_follow_up_at),
            { node: <button className="btn sm" onClick={() => open(Number(o.id))}><Ic k="eye" />View</button> },
          ])} />
        <div className="card">
          <div className="card-head"><h3><Ic k="bell" />Upcoming follow-ups</h3></div>
          <div className="card-pad">
            {(x?.followups ?? []).length === 0 ? <div className="empty-note">Nothing booked — book a follow-up from any opportunity.</div>
              : (x.followups as any[]).map((u) => {
                const dd = new Date(u.scheduled_at);
                return (
                  <div className="cs-fu" key={u.follow_up_id} onClick={() => open(Number(u.opportunity_id))} role="button">
                    <div className="cs-date"><b>{dd.getDate()}</b><span>{dd.toLocaleString('en-IN', { month: 'short' })}</span></div>
                    <div style={{ flex: 1 }}><b>{u.full_name}</b><div className="sub">{u.course_name} — Follow-up</div></div>
                    <span className="sub"><Ic k="clock" />{dd.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                );
              })}
          </div>
        </div>
      </div>
    </>
  );
}

/* ----------------------------------------------------------- opportunities */

interface OppTabProps { f: Flt; setF: (f: Flt) => void; open: (id: number) => void; tick: number }
function OpportunitiesTab(props: OppTabProps) {
  const { f, setF, open, tick } = props;
  const ref = useRef_();
  const [q, setQ] = useState('');
  const qs = qsOf({ ...f, period: f.period === 'all' ? '' : f.period }, { q: q.trim() || undefined });
  const { data, reload } = useFetch<any[]>(`/cross-sell/opportunities?${qs}`, [qs, tick]);
  const rows = data ?? [];
  const total = rows.reduce((a, o) => a + Number(o.stage === 'converted' ? o.converted_value_minor : o.value_minor), 0);
  return (
    <>
      <div className="toolbar-surface"><div className="filters">
        <input className="ainp" style={{ maxWidth: 220 }} placeholder="Search name, phone, course" value={q} onChange={(e) => setQ(e.target.value)} />
        <EnumMulti label="Stage" icon="list" value={f.stage} options={STAGES.map(([id, name]) => ({ id, name }))} onChange={(v) => setF({ ...f, stage: v })} />
        <EnumMulti label="Type" icon="tag" value={f.type} options={TYPES.map(([id, name]) => ({ id, name }))} onChange={(v) => setF({ ...f, type: v })} />
        <FilterMulti label="Branch" icon="branch" value={f.branch} options={ref.branches} onChange={(v) => setF({ ...f, branch: v, vertical: [] })} />
        <FilterMulti label="Course" icon="book" value={f.course} options={ref.courses as any} onChange={(v) => setF({ ...f, course: v })} />
        <FilterMulti label="Owner" icon="users" value={f.owner} options={selectableUsers(ref.users)} onChange={(v) => setF({ ...f, owner: v })} />
      </div></div>
      <TableCard title={`Opportunities · ${rows.length} · ${inr(total)}`} icon="target" listKey="crossSellOpps" serial
        more={<ListActions onExport={() => downloadObjectsCsv('cross-sell-opportunities.csv', rows.map((o) => ({
          customer: o.full_name, phone: o.phone, current_course: o.from_course_name, recommended_course: o.course_name, type: TYPE_LABEL[o.sale_type],
          stage: STAGE_LABEL[o.stage], value: Number(o.value_minor) / 100, converted_value: o.converted_value_minor != null ? Number(o.converted_value_minor) / 100 : '',
          owner: o.owner_name, branch: o.branch_name, next_follow_up: o.next_follow_up_at, created: o.created_at, lost_reason: o.lost_reason ?? '' })))} onRefresh={reload} />}
        cols={['Customer', 'Current course', 'Recommended course', 'Type', 'Value', 'Stage', 'Owner', 'Next follow-up', 'Created', '']}
        empty="No opportunities match."
        rows={rows.map((o): Cell[] => [
          { node: <div><b>{o.full_name}</b><div className="sub mono">{o.phone}</div></div>, sort: String(o.full_name).toLowerCase() },
          o.from_course_name ?? '—', o.course_name ?? '—', typeBadge(o.sale_type),
          { mono: inr(o.stage === 'converted' ? o.converted_value_minor : o.value_minor), sort: Number(o.value_minor) },
          stageBadge(o.stage), o.owner_name ?? '—', dtt(o.next_follow_up_at), dt(o.created_at),
          { node: <button className="btn sm" onClick={() => open(Number(o.id))} data-testid={`cs-open-${o.id}`}><Ic k="eye" />View</button> },
        ])} />
    </>
  );
}

/* --------------------------------------------------------- recommendations */

interface RecTabProps { create: (r: any) => void; act: (r: any) => void; notify: (r: any) => void; tick: number }
function RecommendationsTab(props: RecTabProps) {
  const { create, act, notify, tick } = props;
  const { can } = useAuth();
  const ref = useRef_();
  const [branch, setBranch] = useState<number[]>([]);
  const [type, setType] = useState<string[]>([]);
  const qs = qsOf({ branch, type });
  const { data, reload } = useFetch<any[]>(`/cross-sell/recommendations?${qs}`, [qs, tick]);
  const top = useFetch<any[]>(`/cross-sell/recommendations/top?${qs}`, [qs, tick]);
  const rows = data ?? [];
  return (
    <>
      <div className="toolbar-surface"><div className="filters">
        <FilterMulti label="Branch" icon="branch" value={branch} options={ref.branches} onChange={setBranch} />
        <EnumMulti label="Type" icon="tag" value={type} options={TYPES.map(([id, name]) => ({ id, name }))} onChange={setType} />
      </div></div>
      <TableCard title="Best matches by course" icon="award"
        cols={['Recommended course', 'For students of', 'Type', 'Contacts', 'Avg match', '']}
        empty="No recommendations."
        rows={(top.data ?? []).map((r): Cell[] => [
          { node: <b>{r.course_name}</b> }, r.from_course_name ?? '—', typeBadge(r.sale_type), String(r.contacts), { node: <MatchPct pct={r.match_pct} /> },
          { node: can('crosssell.act') ? <button className="btn sm" onClick={() => notify(r)}><Ic k="send" />Notify</button> : '' },
        ])} />
      <div style={{ height: 12 }} />
      <TableCard title={`Recommendations · ${rows.length}`} icon="bolt" listKey="crossSellRecs" serial
        more={<ListActions onExport={() => downloadObjectsCsv('cross-sell-recommendations.csv', rows.map((r) => ({
          contact: r.full_name, phone: r.phone, current_course: r.from_course_name, recommended_course: r.course_name, type: TYPE_LABEL[r.sale_type],
          match_pct: r.match_pct, value: r.value_minor / 100, owner: r.owner_name, branch: r.branch_name })))} onRefresh={reload} />}
        cols={['Contact', 'Current course', 'Recommended course', 'Type', 'Match', 'Value', 'Owner', '']}
        empty="No cross-sell recommendations — won / enrolled contacts appear here with the next course to offer."
        rows={rows.map((r): Cell[] => [
          { node: <div><b>{r.full_name}</b><div className="sub mono">{r.phone}</div>{r.student_id ? <span className="bdg b-cyan">Student</span> : null}</div>, sort: String(r.full_name).toLowerCase() },
          r.from_course_name ?? '—', { node: <b>{r.course_name}</b> }, typeBadge(r.sale_type),
          { node: <MatchPct pct={r.match_pct} parts={r.match_parts} />, sort: r.match_pct }, { mono: r.value_minor ? inr(r.value_minor) : '—' },
          r.owner_name ?? 'Unassigned',
          { node: can('crosssell.act') ? (
            <div className="rowacts"><button className="btn sm primary" onClick={() => create(r)} data-testid={`cs-rec-create-${r.lead_id}-${r.course_id}`}><Ic k="plus" />Opportunity</button>
              <button className="icon-btn sm" title="Follow-up / new lead / dismiss" onClick={() => act(r)}><Ic k="dots" /></button></div>) : '' },
        ])} />
    </>
  );
}

/* --------------------------------------------------------------- campaigns */

function CampaignsTab({ onNew, tick }: { onNew: () => void; tick: number }) {
  const { can } = useAuth();
  const { data, reload } = useFetch<any[]>('/cross-sell/campaigns', [tick]);
  const rows = data ?? [];
  return (
    <>
      {can('crosssell.act') ? <div className="page-actions"><button className="btn primary" onClick={onNew} data-testid="cs-camp-new"><Ic k="plus" />New campaign</button></div> : null}
      <TableCard title="Campaigns" icon="send"
        more={<ListActions onExport={() => downloadObjectsCsv('cross-sell-campaigns.csv', rows)} onRefresh={reload} />}
        cols={['Campaign', 'Offer', 'For students of', 'Template', 'Audience', 'Messages', 'Opportunities', 'Converted', 'Revenue', 'Sent']}
        empty="No campaigns yet — offer a course to a group of students from here or from Notify on a recommendation."
        rows={rows.map((c): Cell[] => [
          { node: <b>{c.name}</b> }, c.course_name ?? '—', c.from_course_name ?? 'Anyone suited', c.template_name ?? '—',
          String(c.audience_count), String(c.notified_count), String(c.opps_now ?? c.opportunities_count), String(c.converted ?? 0),
          { mono: inr(c.revenue_minor ?? 0) }, dt(c.sent_at ?? c.created_at),
        ])} />
    </>
  );
}

/* ----------------------------------------------------------------- reports */

function ReportsTab({ period }: { period: string }) {
  const d = useFetch<any>(`/cross-sell/reports?period=${period}`, [period]);
  const r = d.data;
  const table = (title: string, rows: any[], first: string) => (
    <TableCard title={title} icon="analytics"
      more={<ListActions onExport={() => downloadObjectsCsv(`cross-sell-${first.toLowerCase().replace(/\W+/g, '-')}.csv`, rows)} />}
      cols={[first, 'Opportunities', 'Open', 'Converted', 'Lost', 'Conversion', 'Revenue', 'Pipeline']}
      empty="Nothing in this period."
      rows={(rows ?? []).map((x): Cell[] => [
        { node: <b>{first === 'Type' ? (TYPE_LABEL[x.label] ?? x.label) : x.label}</b> }, String(x.opportunities), String(x.open), String(x.converted), String(x.lost),
        x.conversion_pct == null ? '—' : `${x.conversion_pct}%`, { mono: inr(x.revenue_minor) }, { mono: inr(x.pipeline_minor) },
      ])} />
  );
  if (!r) return <div className="empty-note">Loading…</div>;
  return (
    <>
      <div className="card"><div className="card-head"><h3><Ic k="analytics" />Additional revenue by counsellor</h3></div>
        <div className="card-pad">{r.by_counsellor.some((x: any) => x.revenue_minor > 0)
          ? <HBarChart data={r.by_counsellor.map((x: any) => ({ label: x.label, value: x.revenue_minor }))} fmt={inrShort} ariaLabel="Additional revenue by counsellor" />
          : <div className="empty-note">No converted cross-sales in this period yet.</div>}</div></div>
      <div style={{ height: 12 }} />
      {table('By counsellor', r.by_counsellor, 'Counsellor')}<div style={{ height: 12 }} />
      {table('By recommended course', r.by_course, 'Course')}<div style={{ height: 12 }} />
      {table('By type', r.by_type, 'Type')}<div style={{ height: 12 }} />
      {table('By branch', r.by_branch, 'Branch')}<div style={{ height: 12 }} />
      {table('By campaign', r.by_campaign, 'Campaign')}<div style={{ height: 12 }} />
      {table('Lost reasons', r.lost_reasons, 'Reason')}
    </>
  );
}

/* ---------------------------------------------------------------- settings */

function RuleModal({ init, onClose, onSaved }: { init?: any; onClose: () => void; onSaved: () => void }) {
  const ref = useRef_();
  const [src, setSrc] = useState(String(init?.source_course_id ?? ''));
  const [tgt, setTgt] = useState(String(init?.target_course_id ?? ''));
  const [type, setType] = useState(init?.sale_type ?? 'cross_sell');
  const [weight, setWeight] = useState(String(init?.weight ?? 85));
  const [note, setNote] = useState(init?.note ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      if (init?.id) await api.patch(`/cross-sell/rules/${init.id}`, { target_course_id: Number(tgt), sale_type: type, weight: Number(weight), note });
      else await api.post('/cross-sell/rules', { source_course_id: Number(src), target_course_id: Number(tgt), sale_type: type, weight: Number(weight), note });
      toast('Rule saved'); onSaved(); onClose();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const courses = ref.courses as any[];
  return (
    <div className="add-scrim"><div className="add-modal" style={{ maxWidth: 560 }} data-testid="cs-rule-modal">
      <div className="ah"><h3><Ic k="bolt" />{init?.id ? 'Edit rule' : 'New cross-sell rule'}</h3><button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button></div>
      <div className="abody"><div className="form-grid">
        <div className="fld"><label>Students of <span className="star">*</span></label>
          <select className="ainp" value={src} disabled={!!init?.id} onChange={(e) => setSrc(e.target.value)}><option value="">Select</option>{courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <div className="fld"><label>Recommend <span className="star">*</span></label>
          <select className="ainp" value={tgt} onChange={(e) => setTgt(e.target.value)}><option value="">Select</option>{courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <div className="fld"><label>Type</label>
          <select className="ainp" value={type} onChange={(e) => setType(e.target.value)}>{TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div className="fld"><label>Match strength (1–100)</label>
          <input className="ainp" type="number" min={1} max={100} value={weight} onChange={(e) => setWeight(e.target.value)} />
          <div className="hint">The starting match %; fully-paid, recent and next-level students score a little higher.</div></div>
        <div className="fld span2"><label>Note</label><input className="ainp" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why this pairing" /></div>
      </div></div>
      <div className="af"><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !tgt || (!init?.id && !src)} onClick={save}><Ic k="check" />Save</button></div>
    </div></div>
  );
}

function SettingsTab() {
  const { can } = useAuth();
  const rules = useFetch<any[]>('/cross-sell/rules');
  const attempts = useFetch<any[]>('/cross-sell/attempts');
  const [edit, setEdit] = useState<any>(null);
  const toggle = async (r: any) => { try { await api.patch(`/cross-sell/rules/${r.id}`, { is_active: !r.is_active }); rules.reload(); } catch (e) { toast((e as Error).message, true); } };
  const del = async (r: any) => {
    if (!await askConfirm(`Delete the rule ${r.source_course_name} → ${r.target_course_name}?`)) return;
    try { await api.del(`/cross-sell/rules/${r.id}`); toast('Rule deleted'); rules.reload(); } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <>
      {can('crosssell.manage') ? <div className="page-actions"><button className="btn primary" onClick={() => setEdit({})} data-testid="cs-rule-new"><Ic k="plus" />New rule</button></div> : null}
      <div className="sub" style={{ margin: '4px 0 12px' }}>
        A rule says: <b>students of</b> one course should be <b>recommended</b> another, what kind of sale it is and how strong the match is.
        Contacts with no rule get the other courses of their vertical at a 60% starting match. Stages: New → Assigned → Contacted → Interested →
        Quotation Sent → Negotiation → Converted (when the enrolment is made in Sale Closure) or Lost (with a reason).
      </div>
      <TableCard title="Rules" icon="bolt"
        cols={['Students of', '', 'Recommend', 'Type', 'Match strength', 'Status', 'Note', '']}
        empty="No rules yet — suggestions fall back to same-vertical courses."
        rows={(rules.data ?? []).map((r): Cell[] => [
          r.source_course_name ?? '—', { node: <span aria-hidden="true">&rarr;</span> }, r.target_course_name ?? '—', typeBadge(r.sale_type ?? 'cross_sell'),
          `${r.weight ?? 85}%`, r.is_active ? { b: ['Active', 'b-green'] } : { b: ['Off', 'b-gray'] }, r.note ?? '—',
          { node: can('crosssell.manage') ? (<div className="rowacts">
            <button className="icon-btn sm" title="Edit" onClick={() => setEdit(r)}><Ic k="pencil" /></button>
            <button className="icon-btn sm" title={r.is_active ? 'Switch off' : 'Switch on'} onClick={() => toggle(r)}><Ic k="power" /></button>
            <button className="icon-btn sm" title="Delete" onClick={() => del(r)}><Ic k="trash" /></button></div>) : '' },
        ])} />
      <div style={{ height: 12 }} />
      <TableCard title="Suggestion log (follow-ups, new leads, dismissed)" icon="list"
        more={<ListActions onExport={() => downloadObjectsCsv('cross-sell-attempts.csv', attempts.data ?? [])} onRefresh={attempts.reload} />}
        cols={['Contact', 'From', 'Suggested', 'Action', 'Owner', 'When', 'Note']}
        empty="Nothing actioned yet."
        rows={(attempts.data ?? []).map((a): Cell[] => [
          { node: <b>{a.full_name}</b> }, a.from_course_name ?? '—', a.suggested_course_name ?? '—', actionBadge(a.action), a.owner_name ?? '—', dt(a.created_at), a.note ?? '—',
        ])} />
      {edit ? <RuleModal init={edit.id ? edit : undefined} onClose={() => setEdit(null)} onSaved={rules.reload} /> : null}
    </>
  );
}

/* -------------------------------------------------------------------- main */

type Tab = 'dashboard' | 'opportunities' | 'recommendations' | 'campaigns' | 'reports' | 'settings';

export function CrossSell() {
  const { can } = useAuth();
  const ref = useRef_();
  const [tab, setTab] = useState<Tab>('dashboard');
  const [f, setF] = useState<Flt>({ period: 'this_month', branch: [], vertical: [], course: [], customer: '', stage: [], type: [], owner: [] });
  const [tick, setTick] = useState(0);
  const bump = () => setTick((t) => t + 1);
  const [openId, setOpenId] = useState<number | null>(null);
  const [newOpp, setNewOpp] = useState<any>(null);
  const [actRow, setActRow] = useState<any>(null);
  const [camp, setCamp] = useState<any>(null);
  const tabs: Array<[Tab, string]> = useMemo(() => {
    const t: Array<[Tab, string]> = [['dashboard', 'Dashboard'], ['opportunities', 'Opportunities'], ['recommendations', 'Recommendations'],
      ['campaigns', 'Campaigns'], ['reports', 'Reports']];
    if (can('crosssell.manage')) t.push(['settings', 'Settings']);
    return t;
  }, [can]);
  const branchSel = f.branch.length === 1 ? String(f.branch[0]) : '';
  return (
    <>
      <div className="page-actions" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <select className="ainp" style={{ maxWidth: 170 }} aria-label="Period" value={f.period} onChange={(e) => setF({ ...f, period: e.target.value })} data-testid="cs-period">
          {PERIODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <select className="ainp" style={{ maxWidth: 180 }} aria-label="Branch" value={branchSel} onChange={(e) => setF({ ...f, branch: e.target.value ? [Number(e.target.value)] : [], vertical: [] })}>
          <option value="">All Branches</option>{ref.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
        {can('crosssell.act') ? <button className="btn primary" onClick={() => setNewOpp({})} data-testid="cs-create"><Ic k="plus" />Create Opportunity</button> : null}
      </div>
      <div className="seg-tabs" role="tablist" style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`btn${tab === k ? ' primary' : ''}`} onClick={() => setTab(k)}>{l}</button>)}
      </div>

      {tab === 'dashboard' && <DashboardTab key={tick} f={f} setF={setF} open={setOpenId} notify={setCamp}
        goOpps={(stage) => { setF({ ...f, stage: stage ? [stage] : [] }); setTab('opportunities'); }} />}
      {tab === 'opportunities' && <OpportunitiesTab f={f} setF={setF} open={setOpenId} tick={tick} />}
      {tab === 'recommendations' && <RecommendationsTab tick={tick} notify={setCamp} act={setActRow}
        create={(r) => setNewOpp({ lead_id: r.lead_id, full_name: r.full_name, course_id: r.course_id, from_course_id: r.from_course_id,
          sale_type: r.sale_type, value_minor: r.value_minor, owner_id: r.owner_id, match_pct: r.match_pct })} />}
      {tab === 'campaigns' && <CampaignsTab tick={tick} onNew={() => setCamp({})} />}
      {tab === 'reports' && <ReportsTab period={f.period} />}
      {tab === 'settings' && can('crosssell.manage') && <SettingsTab />}

      {newOpp ? <OppModal init={newOpp.lead_id ? newOpp : undefined} onClose={() => setNewOpp(null)} onSaved={bump} /> : null}
      {openId ? <OppDetail id={openId} onClose={() => setOpenId(null)} onChanged={bump} /> : null}
      {actRow ? <ActModal row={actRow} onClose={() => setActRow(null)} onDone={bump} /> : null}
      {camp ? <CampaignModal init={camp} onClose={() => setCamp(null)} onSent={bump} /> : null}
    </>
  );
}
