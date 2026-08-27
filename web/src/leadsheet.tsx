/** Lead detail / edit slide-in sheet — ported 1:1 from the prototype's renderLead(). */
import { useEffect, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic, checkS } from './icons';
import { AddMasterModal } from './mastermodal';
import { AddModal } from './forms';
import { fetchLeadCfDefs, coerceCf, displayCf, CfDef } from './customfields';
import { PhoneInput } from './phonefield';
import { Avatar, TempBadge } from './renderer';
import { DuplicatePanel } from './mergemodal';
import { LeadTransferModal } from './leadtransfer';
import { ConvertStudentModal } from './convertstudent';
import { toast, useRef_, Named, selectableUsers } from './refdata';

interface Stage { id: number; name: string; sort_order: number; stage_type: string }
interface Activity { id: number; type: string; from_value: any; to_value: any; note: string | null; occurred_at: string; actor_name: string | null }

const fmtDT = (s?: string | null) => (s ? new Date(s).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

export function activityTitle(a: Activity, sourceName?: string): { tt: string; td: string } {
  switch (a.type) {
    case 'create': return { tt: `Lead captured${sourceName ? ` from ${sourceName}` : ''}`, td: a.note || 'Lead created' };
    case 'stage_change': return { tt: `Stage moved → ${a.to_value?.name ?? ''}`, td: a.from_value?.name ? `From ${a.from_value.name}` : 'Stage updated' };
    case 'status_change': return { tt: `Status → ${a.to_value?.name ?? ''}`, td: a.from_value?.name ? `From ${a.from_value.name}` : 'Status updated' };
    case 'assign': return { tt: a.to_value?.owner_id ? 'Lead assigned' : 'Lead Counsellor cleared', td: 'Lead Counsellor change' };
    // dev/133 BUG FIX #8 — a task and a follow-up share the follow_up table; the timeline label
    // must reflect the REAL type. The activity carries `kind` ('task' | 'follow_up') written at
    // create/update time — a task now reads "Task …", not "Follow-up …".
    case 'follow_up': {
      const noun = a.to_value?.kind === 'task' ? 'Task' : 'Follow-up';
      return { tt: a.to_value?.action === 'completed' ? `${noun} completed` : a.to_value?.action === 'scheduled' ? `${noun} scheduled · ${fmtDT(a.to_value?.scheduled_at)}` : `${noun} updated`, td: a.note || '' };
    }
    case 'note': return { tt: a.note || 'Note', td: 'Note added' };
    case 'field_change': return { tt: 'Lead details updated', td: Object.keys(a.to_value || {}).join(', ') };
    // Start Calling (§4.1): the outcome an agent logged while working a handed-out batch
    case 'disposition': return {
      tt: a.note ? `Call outcome — ${a.note}` : 'Call outcome logged',
      td: a.to_value?.handout_id
        ? `Start Calling batch #${a.to_value.handout_id}${a.to_value.position ? ` · lead ${a.to_value.position}` : ''}`
        : 'Disposition logged',
    };
    case 'merge': return {
      tt: a.to_value?.reopened ? 'Duplicate merged & lead re-opened' : 'Duplicate merged',
      td: a.note || `Merged from ${a.to_value?.channel ?? 'another lead'}`,
    };
    case 'red_flag': return {
      tt: a.to_value?.action === 'cleared' ? 'Red flag cleared' : 'Red flag raised',
      td: a.note || 'Red flag',
    };
    default: return { tt: a.type, td: a.note || '' };
  }
}

export function LeadSheet({ leadId, mode: initialMode = 'view', onClose, onChanged }: { leadId: number; mode?: 'view' | 'edit'; onClose: () => void; onChanged?: () => void }) {
  const { can } = useAuth();
  const ref = useRef_();
  const [lead, setLead] = useState<any>(null);
  const [tab, setTab] = useState<'activity' | 'notes' | 'redflag' | 'calls' | 'whatsapp'>('activity');
  // dev/84 item 1 — the lead sheet opens READ-ONLY (view) or editable (edit). View shows
  // every field display-only with no Save; an Edit button flips to edit mode (lead.update).
  const [mode, setMode] = useState<'view' | 'edit'>(initialMode);
  const [saved, setSaved] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [noteText, setNoteText] = useState('');
  const [busy, setBusy] = useState(false);
  const [masterAdd, setMasterAdd] = useState<{ type: string; k: string } | null>(null);
  const [courseAdd, setCourseAdd] = useState(false);
  const [reassign, setReassign] = useState(false); // UAT-R3 #23 reassign-owner modal
  const [transfer, setTransfer] = useState(false); // Jul 2026 — transfer to another Branch/Vertical/Campaign
  const [redFlag, setRedFlag] = useState(false);   // Aug 2026 — red-flag remark dialog
  const [convert, setConvert] = useState(false);   // Phase 2 — convert this lead to a student
  const [rfText, setRfText] = useState('');        // Red Flag tab — continue the conversation
  const [rfList, setRfList] = useState<any[] | null>(null); // Red Flag conversation (GET /leads/:id/red-flags)
  const canFlag = can('lead.flag');
  const [extra, setExtra] = useState<Record<string, Named[]>>({});
  const [cfDefs, setCfDefs] = useState<CfDef[]>([]); // lead custom-field definitions (Aug 2026)

  const load = () => api.get<any>(`/leads/${leadId}`).then(setLead).catch((e) => { toast(e.message, true); onClose(); });
  const loadRedFlags = () => api.get<any[]>(`/leads/${leadId}/red-flags`).then(setRfList).catch(() => setRfList([]));
  useEffect(() => { load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [leadId]);
  useEffect(() => { setMode(initialMode); }, [leadId, initialMode]);
  useEffect(() => { let live = true; fetchLeadCfDefs().then((d) => { if (live) setCfDefs(d); }); return () => { live = false; }; }, []);
  useEffect(() => { if (tab === 'redflag') loadRedFlags(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [tab, leadId]);

  if (!lead) return (
    <div className="modal-scrim">
      <div className="sheet">
        <div className="sheet-head" style={{ borderBottom: 'none' }}>
          <button className="x" onClick={onClose}><Ic k="x" /></button>
        </div>
        <div className="empty-note" style={{ marginTop: '36vh' }}>Loading lead…</div>
      </div>
    </div>
  );

  const stages: Stage[] = lead.stages || [];
  const curIdx = stages.findIndex((s) => Number(s.id) === Number(lead.stage_id));
  const editing = mode === 'edit';           // dev/84 item 1 — edit vs read-only view
  const canEditLead = can('lead.update');
  const canUpdate = editing && canEditLead;  // every field/save keys off this → disabled in view

  const setStage = async (s: Stage) => {
    if (!canUpdate || Number(s.id) === Number(lead.stage_id)) return;
    setBusy(true);
    try {
      await api.patch(`/leads/${lead.id}`, { stage_id: s.id });
      setSaved(`Status updated to "${s.name}" · saved & logged`);
      await load(); onChanged?.();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };

  const saveEdits = async () => {
    // dev/95 item 5 — Branch/Vertical/Pipeline are edited via the SAME re-parent path the
    // Transfer flow uses (the app cascade is Branch › Vertical › Pipeline › Campaign): when a
    // new Campaign is picked the lead is transferred (owner kept); the remaining fields save
    // through the normal PATCH. branch/vertical/pipeline never go to PATCH (they are not lead
    // columns) — a Campaign choice carries the whole path.
    const { branch_id, vertical_id, pipeline_id, campaign_id, ...rest } = edits as Record<string, unknown>;
    void branch_id; void vertical_id; void pipeline_id;
    const reparent = campaign_id != null && Number(campaign_id) !== Number(lead.campaign_id);
    if (!Object.keys(rest).length && !reparent) { onClose(); return; }
    setBusy(true);
    try {
      if (reparent) await api.post(`/leads/${lead.id}/transfer`, { campaign_id: Number(campaign_id), owner_mode: 'keep' });
      if (Object.keys(rest).length) await api.patch(`/leads/${lead.id}`, rest);
      setEdits({});
      setSaved('Changes saved & logged');
      await load(); onChanged?.();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };

  const addNote = async () => {
    if (!noteText.trim()) return;
    try {
      await api.post(`/leads/${lead.id}/notes`, { note: noteText.trim() });
      setNoteText('');
      await load();
    } catch (e: any) { toast(e.message, true); }
  };

  const addRedFlag = async () => {
    if (!rfText.trim()) return;
    try {
      await api.post(`/leads/${lead.id}/red-flag`, { remark: rfText.trim() });
      setRfText('');
      toast('Red flag raised');
      await Promise.all([load(), loadRedFlags()]); onChanged?.();
    } catch (e: any) { toast(e.message, true); }
  };
  const clearRedFlag = async () => {
    try {
      await api.post(`/leads/${lead.id}/red-flag/clear`, {});
      toast('Red flag cleared');
      await Promise.all([load(), loadRedFlags()]); onChanged?.();
    } catch (e: any) { toast(e.message, true); }
  };

  const ed = (k: string) => (edits[k] !== undefined ? edits[k] : lead[k]) as any;
  /** Master-bound select options + any value just added via ＋ Master (pre-reload). */
  const withExtra = (k: string, opts: Named[]) =>
    [...opts, ...(extra[k] ?? []).filter((e) => !opts.some((o) => Number(o.id) === Number(e.id)))];
  /** Course options FILTERED to the lead's Branch > Vertical path (client refinement, dev/80):
   *  only courses under the lead's vertical show — the same rule the enrol/convert selectors use
   *  (m_course.meta.vertical_id === the lead's vertical). LEGACY SAFETY: if the lead already has a
   *  course stored that is out-of-path (a value saved before this filter, or a re-parented lead),
   *  that course is still shown so a saved value is never silently dropped. */
  const courseOpts = (): Named[] => {
    const all = withExtra('course_id', ref.courses);
    const vid = lead.vertical_id;
    let list = vid != null
      ? all.filter((c: any) => String((c.meta as any)?.vertical_id ?? '') === String(vid))
      : all;
    const cur = ed('course_id');
    if (cur != null && !list.some((c: any) => Number(c.id) === Number(cur))) {
      const kept = all.find((c: any) => Number(c.id) === Number(cur));
      if (kept) list = [kept, ...list];
    }
    return list;
  };
  /** ＋ Master link on master-bound lead fields — hidden without master.create.
   *  Course opens the full Courses-screen form (all fields), not the generic name/code modal. */
  const mlink = (type: string, k: string) => (canUpdate && can('master.create')
    ? <a className="mlink" onClick={() => (type === 'course' ? setCourseAdd(true) : setMasterAdd({ type, k }))}>＋ Master</a> : null);
  const sel = (k: string, opts: Array<{ id: number; name: string }>, allowEmpty = true) => (
    <select value={ed(k) ?? ''} disabled={!canUpdate}
      onChange={(e) => setEdits((x) => ({ ...x, [k]: e.target.value ? Number(e.target.value) : null }))}>
      {allowEmpty && <option value="">—</option>}
      {opts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
    </select>
  );

  // dev/95 item 5 — editable Branch › Vertical › Pipeline › Campaign (re-parent) in the edit
  // form. Only offered in edit mode with lead.transfer; the strict cascade mirrors the Transfer
  // modal. Children reset (null) when a parent changes; a saved Campaign drives the re-parent.
  const canReparent = editing && can('lead.transfer');
  const rp = (k: string) => (edits[k] !== undefined ? edits[k] : lead[k]) as any;
  const setRp = (k: string, v: number | null) => setEdits((x) => {
    const nx: Record<string, unknown> = { ...x, [k]: v };
    if (k === 'branch_id') { nx.vertical_id = null; nx.pipeline_id = null; nx.campaign_id = null; }
    if (k === 'vertical_id') { nx.pipeline_id = null; nx.campaign_id = null; }
    if (k === 'pipeline_id') { nx.campaign_id = null; }
    return nx;
  });
  const rpsel = (label: string, k: string, opts: Array<{ id: number; name: string }>, disabled?: boolean) => (
    <div className="f"><label>{label}</label><div className="iv">
      <select value={rp(k) ?? ''} disabled={!canReparent || disabled}
        onChange={(e) => setRp(k, e.target.value ? Number(e.target.value) : null)}>
        <option value="">{disabled ? 'Pick the parent first…' : 'Select…'}</option>
        {opts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </div></div>
  );

  const notes = (lead.activities as Activity[]).filter((a) => a.type === 'note');

  return (
    <div className="modal-scrim">
      <div className="sheet">
        <div className="sheet-head">
          <Avatar name={lead.full_name} size="lg" />
          <div>
            <div className="nm">{lead.full_name}</div>
            <div className="mt">{lead.course_name || 'Course TBD'} · <span className="mono">{lead.phone}</span></div>
            <div style={{ marginTop: 7, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <TempBadge temperature={lead.temperature} score={lead.score} />
              <span className="bdg b-indigo">{lead.vertical_name}{lead.vertical_deleted ? ' (deleted)' : ''} · {lead.pipeline_name}{lead.pipeline_deleted ? ' (deleted)' : ''}</span>
              {lead.is_duplicate && <span className="bdg b-rose">Duplicate</span>}
              {/* dev/95 item 1 — returning student (alumni) flag. */}
              {lead.is_existing_student
                ? <span className="bdg b-green" title={`Returning student${lead.existing_student_name ? ' — ' + lead.existing_student_name : ''}${lead.existing_student_no ? ' (' + lead.existing_student_no + ')' : ''}`}>Existing student</span>
                : null}
              {/* Sprint 3 — a breached SLA and an escalation flag are visible on the sheet */}
              {lead.sla_breached ? <span className="bdg b-rose" title="SLA breached">SLA breached</span> : null}
              {lead.is_flagged && !lead.sla_breached
                ? <span className="bdg b-amber" title={lead.flag_reason || 'Flagged'}>{lead.flag_reason || 'Flagged'}</span>
                : null}
              {lead.is_red_flagged
                ? <span className="bdg b-red" title="Red flagged"><Ic k="flag" w={2} /> Red flag</span>
                : null}
            </div>
          </div>
          <button className="x" onClick={onClose}><Ic k="x" /></button>
        </div>
        <div className="sheet-act">
          <a className="qa call" href={`tel:${lead.phone}`}><Ic k="calls" />Call</a>
          <a className="qa wa" href={`https://wa.me/${String(lead.whatsapp_phone || lead.phone).replace(/[^\d]/g, '')}`} target="_blank" rel="noreferrer"><Ic k="wa" />WhatsApp</a>
          <a className="qa" href={lead.email ? `mailto:${lead.email}` : undefined} onClick={(e) => { if (!lead.email) { e.preventDefault(); toast('No email on this lead', true); } }}><Ic k="mail" />Email</a>
          {/* dev/84 item 1 — in VIEW mode the only control is Edit (read-only otherwise). */}
          {!editing && canEditLead && <button className="qa" onClick={() => setMode('edit')}><Ic k="pencil" />Edit</button>}
          {editing && <button className="qa" onClick={() => setTab('notes')}><Ic k="note" />Add note</button>}
          {/* UAT-R3 #23 — reassign the lead's owner to another (active, in-scope) user. */}
          {editing && can('lead.assign') && <button className="qa" onClick={() => setReassign(true)}><Ic k="users" />Reassign</button>}
          {/* Jul 2026 — transfer the lead to another Branch / Vertical / Campaign (re-parents its path). */}
          {editing && can('lead.transfer') && <button className="qa" onClick={() => setTransfer(true)}><Ic k="swap" />Transfer</button>}
          {/* Aug 2026 — RED FLAG: type a remark; records a red-flag entry + timeline + flag state. */}
          {editing && canFlag && <button className="qa" onClick={() => setRedFlag(true)}
            style={lead.is_red_flagged ? { color: 'var(--red)' } : undefined}>
            <Ic k="flag" />{lead.is_red_flagged ? 'Red flag' : 'Red flag'}</button>}
          {/* Phase 2 — convert this lead to a STUDENT (creates the student record + marks the lead WON). */}
          {editing && can('student.create') && <button className="qa" onClick={() => setConvert(true)}><Ic k="students" />Convert to Student</button>}
        </div>
        <div className="sheet-body">
          <div className="sheet-sec">
            <h5>{editing ? 'Pipeline stage — tap to update' : 'Pipeline stage'}</h5>
            <div className="stepper">
              {stages.map((s, i) => (
                <span key={s.id} style={{ display: 'contents' }}>
                  <div className={`step ${i < curIdx ? 'done' : i === curIdx ? 'active' : ''}`} onClick={() => setStage(s)}>
                    <div className="sd">{i < curIdx ? '✓' : i + 1}</div>
                    <div className="sl">{s.name}</div>
                  </div>
                  {i < stages.length - 1 && <div className={`step-line ${i < curIdx ? 'done' : ''}`} />}
                </span>
              ))}
            </div>
            {saved && <div className="toast">{checkS}{saved}</div>}
          </div>
          {/* Sprint 3 — WHY is this lead Hot? The score breakdown is stored on the lead,
              so the answer is the rules that actually fired, not a guess. */}
          {Array.isArray(lead.score_breakdown) && lead.score_breakdown.length > 0 && (
            <div className="sheet-sec">
              <h5>Lead score — {lead.score} / 100 · {String(lead.temperature ?? 'unscored').replace(/^./, (c: string) => c.toUpperCase())}</h5>
              <div className="hbars">
                {lead.score_breakdown.map((b: any, i: number) => (
                  <div className="hbar" key={i}>
                    <div className="top">
                      <span>{b.name}</span>
                      <b style={{ color: Number(b.points) >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                        {Number(b.points) > 0 ? '+' : ''}{b.points}
                      </b>
                    </div>
                    <div className="track">
                      <div className="fill" style={{
                        width: `${Math.min(100, Math.abs(Number(b.points)))}%`,
                        background: Number(b.points) >= 0 ? 'var(--success)' : 'var(--danger)',
                      }} />
                    </div>
                  </div>
                ))}
              </div>
              <div className="empty-note" style={{ marginTop: 8, textAlign: 'left' }}>
                Rules are configured under Marketing &amp; Lead Management &rsaquo; Lead Scoring.
              </div>
            </div>
          )}
          <div className="sheet-sec">
            <h5>Lead details</h5>
            <div className="kv">
              {/* dev/117 item 1 — Lead Name (full_name) is EDITABLE on the edit form (was
                  header-only / read-only). View mode stays read-only. Persists via PATCH. */}
              <div className="f"><label>Name</label><div className="iv">
                {canUpdate
                  ? <input type="text" value={String(ed('full_name') ?? '')}
                      onChange={(e) => setEdits((x) => ({ ...x, full_name: e.target.value }))} />
                  : <span>{lead.full_name}</span>}
              </div></div>
              <div className="f"><label>Lead Counsellor</label><div className="iv">
                {editing && ref.users.length && can('lead.assign') ? sel('owner_id', selectableUsers(ref.users, ed('owner_id') ?? lead.owner_id)) : <span>{lead.owner_name || 'Unassigned'}</span>}
              </div></div>
              <div className="f"><label>Phone</label>
                {canUpdate
                  ? <PhoneInput value={String(ed('phone') ?? '')} onChange={(v) => setEdits((x) => ({ ...x, phone: v }))} />
                  : <div className="iv"><span className="mono">{lead.phone}</span></div>}
              </div>
              {/* DEF-S2-03 — WhatsApp Number is a stored contact field, editable here */}
              <div className="f"><label>WhatsApp</label>
                {canUpdate
                  ? <PhoneInput value={String(ed('whatsapp_phone') ?? '')} onChange={(v) => setEdits((x) => ({ ...x, whatsapp_phone: v }))} />
                  : <div className="iv"><span className="mono">{lead.whatsapp_phone || '\u2014'}</span></div>}
              </div>
              {/* UAT-R3 #18 — Alternate Mobile Number is a stored contact field (lead.alt_phone), shown + editable here beside the primary mobile / WhatsApp. */}
              <div className="f"><label>Alt. Mobile</label>
                {canUpdate
                  ? <PhoneInput value={String(ed('alt_phone') ?? '')} onChange={(v) => setEdits((x) => ({ ...x, alt_phone: v }))} />
                  : <div className="iv"><span className="mono">{lead.alt_phone || '\u2014'}</span></div>}
              </div>
              {/* dev/117 item 1 — Source is the lead's Source-master value, EDITABLE here on the
                  edit form (was read-only). View mode + no options fall back to the read-only name. */}
              <div className="f"><label>Source</label><div className="iv">
                {canUpdate && (ref.sources.length || extra['source_id']?.length)
                  ? sel('source_id', withExtra('source_id', ref.sources), false)
                  : <span>{lead.source_name}{lead.source_deleted ? ' (deleted)' : ''}</span>}
              </div></div>
              <div className="f"><label>Course interest{mlink('course', 'course_id')}</label><div className="iv">
                {ref.courses.length || extra['course_id']?.length ? sel('course_id', courseOpts()) : <span>{lead.course_name || '—'}</span>}
              </div>
                {(() => { // client update #3 — course fee auto-fetched from the Course master
                  const cid = ed('course_id');
                  const course: any = cid != null ? withExtra('course_id', ref.courses).find((c) => Number(c.id) === Number(cid)) : null;
                  const fee = course?.meta?.fee;
                  return fee != null && fee !== ''
                    ? <div style={{ fontSize: 11, color: 'var(--success)', marginTop: 3 }}>Course fee: ₹{fee}</div>
                    : null;
                })()}
              </div>
              <div className="f"><label>Budget{mlink('budget', 'budget_id')}</label><div className="iv">
                {ref.budgets.length || extra['budget_id']?.length ? sel('budget_id', withExtra('budget_id', ref.budgets)) : <span>—</span>}
              </div></div>
              <div className="f"><label>Temperature</label><div className="iv">
                <select value={ed('temperature') ?? ''} disabled={!canUpdate}
                  onChange={(e) => setEdits((x) => ({ ...x, temperature: e.target.value || null }))}>
                  <option value="">—</option><option value="hot">Hot</option><option value="warm">Warm</option><option value="cold">Cold</option>
                </select>
              </div></div>
              <div className="f"><label>Priority</label><div className="iv">
                <select value={ed('priority') ?? 'med'} disabled={!canUpdate}
                  onChange={(e) => setEdits((x) => ({ ...x, priority: e.target.value }))}>
                  <option value="low">Low</option><option value="med">Medium</option><option value="high">High</option>
                </select>
              </div></div>
              {/* dev/95 item 5 — Stage editable in the edit form (in addition to the stepper).
                  Changing it moves the lead and triggers the auto-status rule (won→Won, lost→Lost). */}
              <div className="f"><label>Stage</label><div className="iv">
                {canUpdate && stages.length
                  ? <select value={lead.stage_id ?? ''} disabled={busy}
                      onChange={(e) => { const sid = Number(e.target.value); const s = stages.find((x) => Number(x.id) === sid); if (s) setStage(s); }}>
                      {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  : <span>{lead.stage_name || '—'}</span>}
              </div></div>
              <div className="f"><label>Status{mlink('status', 'status_id')}</label><div className="iv">
                {ref.statuses.length || extra['status_id']?.length ? sel('status_id', withExtra('status_id', ref.statuses), false) : <span>{lead.status_name || '—'}</span>}
              </div></div>
              <div className="f"><label>Next follow-up</label><div className="iv">
                <span>{fmtDT(lead.next_follow_up_at)}</span><Ic k="cal" />
              </div></div>
              {/* Calling CRM (dev/139) — the lead's last call disposition (read-only; set via the
                  Start Calling queue or the leads-list "Log disposition" control). */}
              <div className="f"><label>Last call disposition</label><div className="iv">
                <span>{lead.last_call_disposition_name || '—'}{lead.last_call_disposition_at ? ` · ${fmtDT(lead.last_call_disposition_at)}` : ''}</span>
              </div></div>
              {/* dev/95 item 5 — Branch & Vertical are EDITABLE here (re-parent). Editing them
                  walks the strict Branch › Vertical › Pipeline › Campaign cascade and moves the
                  lead on Save (keeps owner). Without edit + lead.transfer, the path is read-only. */}
              {canReparent ? (
                <>
                  {rpsel('Branch', 'branch_id', ref.branches)}
                  {rpsel('Vertical', 'vertical_id', ref.verticals.filter((v: any) => !rp('branch_id') || Number(v.branch_id) === Number(rp('branch_id'))), !rp('branch_id'))}
                  {rpsel('Pipeline', 'pipeline_id', ref.pipelines.filter((p: any) => !rp('vertical_id') || Number(p.vertical_id) === Number(rp('vertical_id'))), !rp('vertical_id'))}
                  {rpsel('Campaign', 'campaign_id', ref.campaigns.filter((c: any) => !rp('pipeline_id') || Number(c.pipeline_id) === Number(rp('pipeline_id'))), !rp('pipeline_id'))}
                  <div className="f s2"><div className="empty-note" style={{ fontSize: 11, textAlign: 'left', padding: 0 }}>
                    Changing Branch / Vertical re-parents the lead. Pick down to a Campaign, then Save to move it (owner kept).
                  </div></div>
                </>
              ) : (
                <div className="f s2"><label>Path</label><div className="iv">
                  <span>
                    {lead.branch_name}{lead.branch_deleted ? ' (deleted)' : ''} › {lead.vertical_name}{lead.vertical_deleted ? ' (deleted)' : ''} › {lead.pipeline_name}{lead.pipeline_deleted ? ' (deleted)' : ''} › {lead.campaign_name}{lead.campaign_deleted ? ' (deleted)' : ''}
                  </span>
                </div></div>
              )}
              {/* dev/95 item 1 — returning student reference (link to the matched student profile). */}
              {lead.is_existing_student && (
                <div className="f s2"><label>Returning student</label><div className="iv">
                  <span className="bdg b-green" title="This contact matches an existing student">Existing student</span>
                  <span style={{ marginLeft: 8 }}>{lead.existing_student_name || `Student #${lead.existing_student_id}`}{lead.existing_student_no ? ` · ${lead.existing_student_no}` : ''}</span>
                </div></div>
              )}
            </div>
          </div>
          {cfDefs.length > 0 && (() => {
            // Custom fields (client, Aug 2026): each definition renders here, prefilled from
            // lead.custom_fields; edits merge back into the custom_fields JSONB on Save.
            const bag = (): Record<string, unknown> => ((edits.custom_fields as any) ?? lead.custom_fields ?? {}) as Record<string, unknown>;
            const cur = (k: string) => bag()[k];
            const setCf = (k: string, type: CfDef['data_type'], value: unknown) => {
              const coerced = coerceCf(type, value);
              setEdits((x) => {
                const base: Record<string, unknown> = { ...((x.custom_fields as any) ?? lead.custom_fields ?? {}) };
                if (coerced === undefined) delete base[k]; else base[k] = coerced;
                return { ...x, custom_fields: base };
              });
            };
            return (
              <div className="sheet-sec" data-testid="lead-custom-fields">
                <h5>Custom fields</h5>
                <div className="kv">
                  {cfDefs.map((d) => (
                    <div className="f" key={d.field_key}>
                      <label>{d.label}{d.required ? <> <span className="star">*</span></> : null}</label>
                      <div className="iv">
                        {!canUpdate ? <span>{displayCf(d, cur(d.field_key))}</span>
                          : d.data_type === 'bool' ? (
                            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5 }}>
                              <input type="checkbox" checked={cur(d.field_key) === true || cur(d.field_key) === '1' || cur(d.field_key) === 'true'}
                                onChange={(e) => setCf(d.field_key, d.data_type, e.target.checked ? '1' : '')} /> Yes
                            </label>
                          ) : (d.data_type === 'select' || d.data_type === 'multiselect') ? (
                            <select value={String(cur(d.field_key) ?? '')} onChange={(e) => setCf(d.field_key, d.data_type, e.target.value)}>
                              <option value="">—</option>
                              {(d.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                            </select>
                          ) : d.data_type === 'number' ? (
                            <input type="number" value={String(cur(d.field_key) ?? '')} onChange={(e) => setCf(d.field_key, d.data_type, e.target.value)} />
                          ) : d.data_type === 'date' ? (
                            <input type="date" value={String(cur(d.field_key) ?? '')} onChange={(e) => setCf(d.field_key, d.data_type, e.target.value)} />
                          ) : (
                            <input type="text" value={String(cur(d.field_key) ?? '')} onChange={(e) => setCf(d.field_key, d.data_type, e.target.value)} />
                          )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
          <DuplicatePanel leadId={lead.id} onChanged={() => { load(); onChanged?.(); }} />
          <div className="sheet-sec">
            <h5>History</h5>
            <div className="seltabs">
              {([['activity', 'Activity'], ['notes', 'Notes'], ['redflag', 'Red Flag'], ['calls', 'Calls'], ['whatsapp', 'WhatsApp']] as const).map(([t, lbl]) => (
                <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                  {t === 'redflag' && lead.is_red_flagged ? <span style={{ color: 'var(--red)', marginRight: 4 }}>●</span> : null}{lbl}
                </button>
              ))}
            </div>
            {tab === 'activity' && (
              <div className="tl">
                {(lead.activities as Activity[]).length === 0 && <div className="empty-note">No activity yet</div>}
                {(lead.activities as Activity[]).map((a) => {
                  const { tt, td } = activityTitle(a, lead.source_name);
                  return (
                    <div className="tl-item" key={a.id}>
                      <div className="tt">{tt}</div>
                      <div className="td">{td}{a.actor_name ? ` · by ${a.actor_name}` : ''}</div>
                      <div className="tm">{fmtDT(a.occurred_at)}</div>
                    </div>
                  );
                })}
              </div>
            )}
            {tab === 'notes' && (
              <>
                {editing && <div className="kv"><div className="f s2"><label>Add note</label>
                  <div className="iv">
                    <input placeholder="Type a note…" value={noteText}
                      onChange={(e) => setNoteText(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') addNote(); }} />
                    <button className="bdg b-indigo" onClick={addNote} style={{ cursor: 'pointer' }}>Save</button>
                  </div>
                </div></div>}
                <div className="tl" style={{ marginTop: 14 }}>
                  {notes.length === 0 && <div className="empty-note">No notes yet</div>}
                  {notes.map((a) => (
                    <div className="tl-item" key={a.id}>
                      <div className="tt">{a.note}</div>
                      <div className="td">{a.actor_name || ''}</div>
                      <div className="tm">{fmtDT(a.occurred_at)}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
            {tab === 'redflag' && (
              <>
                {editing && canFlag && (
                  <div className="kv"><div className="f s2"><label>Add a red-flag remark</label>
                    <div className="iv">
                      <input placeholder="Why is this lead red-flagged\u2026" value={rfText}
                        onChange={(e) => setRfText(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') addRedFlag(); }} />
                      <button className="bdg b-red" onClick={addRedFlag} style={{ cursor: 'pointer' }}>Flag</button>
                      {lead.is_red_flagged && (
                        <button className="bdg b-gray" onClick={clearRedFlag} style={{ cursor: 'pointer' }} title="Clear the red-flag state (keeps the history)">Clear flag</button>
                      )}
                    </div>
                  </div></div>
                )}
                <div className="tl" style={{ marginTop: 14 }}>
                  {((rfList ?? lead.red_flags) ?? []).length === 0 && <div className="empty-note">No red flags on this lead</div>}
                  {((rfList ?? lead.red_flags) ?? []).map((r: any) => (
                    <div className="tl-item" key={r.id}>
                      <div className="tt" style={{ color: 'var(--red)' }}><Ic k="flag" w={2} /> {r.remark}</div>
                      <div className="td">{r.created_by_name || 'Unknown'}</div>
                      <div className="tm">{fmtDT(r.created_at)}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
            {tab === 'calls' && <div className="empty-note">Telephony is out of scope for this CRM — calls are made from your own phone, so call logs are not recorded here.</div>}
            {tab === 'whatsapp' && <div className="empty-note">WhatsApp message history appears here once WhatsApp is connected in Settings › Channels.</div>}
          </div>
        </div>
        <div className="sheet-foot">
          <button className="btn ghost" onClick={onClose}>Close</button>
          {/* dev/84 item 1 — no Save in view mode; an Edit button flips to editable. */}
          {!editing && canEditLead && <button className="btn primary" onClick={() => setMode('edit')}><Ic k="pencil" />Edit</button>}
          {editing && <button className="btn primary" onClick={saveEdits} disabled={busy || !canUpdate}>{checkS}Save changes</button>}
        </div>
      </div>
      {masterAdd && (
        <AddMasterModal type={masterAdd.type} onClose={() => setMasterAdd(null)}
          onCreated={(row) => {
            setExtra((x) => ({ ...x, [masterAdd.k]: [...(x[masterAdd.k] ?? []), row] }));
            setEdits((x) => ({ ...x, [masterAdd.k]: Number(row.id) })); // auto-select the new value
            ref.reload();
          }} />
      )}
      {courseAdd && (
        <AddModal formKey="students.courses" onClose={() => setCourseAdd(false)}
          onSavedRow={(row) => {
            setExtra((x) => ({ ...x, course_id: [...(x.course_id ?? []), row] }));
            setEdits((x) => ({ ...x, course_id: Number(row.id) })); // auto-select + fee hint re-renders from meta.fee
            ref.reload();
          }} />
      )}
      {transfer && (
        <LeadTransferModal leadId={Number(lead.id)} leadName={lead.full_name}
          onClose={() => setTransfer(false)}
          onDone={() => { setTransfer(false); load(); onChanged?.(); }} />
      )}
      {reassign && (
        <ReassignModal lead={lead} users={ref.users}
          onClose={() => setReassign(false)}
          onDone={() => { setReassign(false); load(); onChanged?.(); }} />
      )}
      {redFlag && (
        <RedFlagModal leadId={Number(lead.id)} leadName={lead.full_name} flagged={!!lead.is_red_flagged}
          onClose={() => setRedFlag(false)}
          onDone={() => { setRedFlag(false); setTab('redflag'); load(); onChanged?.(); }} />
      )}
      {convert && (
        <ConvertStudentModal leadId={Number(lead.id)} leadName={lead.full_name}
          onClose={() => setConvert(false)}
          onDone={() => { setConvert(false); load(); onChanged?.(); }} />
      )}
    </div>
  );
}

/**
 * UAT-R3 #23 — Reassign a lead's OWNER. Only ACTIVE, in-scope users are offered
 * (selectableUsers filters deactivated users, keeping the current owner visible); the
 * current owner is not re-offered. Posts to /leads/:id/reassign (gated on `lead.assign`,
 * writes an 'assign' activity + audit). The "Assignment history" panel reads the lead's
 * timeline via GET /leads/:id/activities — the previously-unreachable duplicate endpoint,
 * now wired (route-reachability census 23 -> 22).
 */
function ReassignModal({ lead, users, onClose, onDone }:
  { lead: any; users: Named[]; onClose: () => void; onDone: () => void }) {
  const [ownerId, setOwnerId] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<Activity[] | null>(null);
  const options = selectableUsers(users, lead.owner_id).filter((u) => Number(u.id) !== Number(lead.owner_id));
  useEffect(() => {
    api.get<Activity[]>(`/leads/${lead.id}/activities`)
      .then((rows) => setHistory((rows ?? []).filter((a) => a.type === 'assign')))
      .catch(() => setHistory([]));
  }, [lead.id]);
  const submit = async () => {
    if (!ownerId) return toast('Pick a user to reassign this lead to', true);
    setBusy(true);
    try {
      await api.post(`/leads/${lead.id}/reassign`, { owner_id: ownerId });
      toast('Lead reassigned');
      onDone();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  const nameOfUser = (id: any) => users.find((u) => Number(u.id) === Number(id))?.name;
  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 460 }}>
        <div className="ah"><h3><Ic k="users" />Reassign Lead Counsellor</h3><button className="ax" onClick={onClose}><Ic k="x" /></button></div>
        <div className="abody">
          <div className="fld">
            <label>Current Lead Counsellor</label>
            <div className="ainp" style={{ color: 'var(--text-dim)', background: 'var(--surface-3)' }}>{lead.owner_name || 'Unassigned'}</div>
          </div>
          <div className="fld">
            <label>Reassign to <span className="star">*</span><span className="fhint">active users in your scope</span></label>
            <select className="ainp" aria-label="Reassign to" value={ownerId ?? ''} onChange={(e) => setOwnerId(e.target.value ? Number(e.target.value) : undefined)}>
              <option value="">Select a user…</option>
              {options.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          {history && history.length > 0 && (
            <div className="fld">
              <label>Assignment history</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, color: 'var(--text-muted)' }}>
                {history.slice(0, 5).map((a) => (
                  <div key={a.id}>
                    {fmtDT(a.occurred_at)} — {a.to_value?.owner_id ? `assigned to ${nameOfUser(a.to_value.owner_id) ?? `#${a.to_value.owner_id}`}` : 'Lead Counsellor cleared'}
                    {a.actor_name ? ` (by ${a.actor_name})` : ''}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={busy || !ownerId}><Ic k="check" />Reassign</button>
        </div>
      </div>
    </div>
  );
}

/**
 * RED FLAG dialog (client request, Aug 2026) — type a remark and submit. Records a red-flag
 * entry on the lead (who, when, remark), sets the lead's red-flagged state, and writes a
 * `red_flag` activity so it shows on the main timeline too. Shared by the lead sheet's Red
 * Flag button and the Leads-list row action. A lead can be flagged multiple times (each is a
 * conversation entry) — the running thread lives in the sheet's "Red Flag" tab.
 */
export function RedFlagModal({ leadId, leadName, flagged, onClose, onDone }:
  { leadId: number; leadName?: string; flagged?: boolean; onClose: () => void; onDone: () => void }) {
  const [remark, setRemark] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!remark.trim()) return toast('Type a remark for the red flag', true);
    setBusy(true);
    try {
      await api.post(`/leads/${leadId}/red-flag`, { remark: remark.trim() });
      toast('Red flag raised');
      onDone();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <div className="add-scrim" style={{ zIndex: 300 }}>
      <div className="add-modal" style={{ width: 440 }}>
        <div className="ah"><h3 style={{ color: 'var(--red)' }}><Ic k="flag" />Red flag lead</h3>
          <button className="ax" onClick={onClose}><Ic k="x" /></button></div>
        <div className="abody">
          <div className="fld">
            <label>Lead</label>
            <div className="ainp" style={{ color: 'var(--text-dim)', background: 'var(--surface-3)' }}>{leadName || `#${leadId}`}{flagged ? ' · already red-flagged' : ''}</div>
          </div>
          <div className="fld">
            <label>Remark <span className="star">*</span><span className="fhint">why is this lead red-flagged</span></label>
            <textarea className="ainp" rows={3} aria-label="Red flag remark" value={remark}
              onChange={(e) => setRemark(e.target.value)} placeholder="Type a remark…" />
          </div>
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={busy || !remark.trim()}
            style={{ background: 'var(--red)', borderColor: 'var(--red)' }}><Ic k="flag" />Red flag</button>
        </div>
      </div>
    </div>
  );
}
