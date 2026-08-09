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

function activityTitle(a: Activity, sourceName?: string): { tt: string; td: string } {
  switch (a.type) {
    case 'create': return { tt: `Lead captured${sourceName ? ` from ${sourceName}` : ''}`, td: a.note || 'Lead created' };
    case 'stage_change': return { tt: `Stage moved → ${a.to_value?.name ?? ''}`, td: a.from_value?.name ? `From ${a.from_value.name}` : 'Stage updated' };
    case 'status_change': return { tt: `Status → ${a.to_value?.name ?? ''}`, td: a.from_value?.name ? `From ${a.from_value.name}` : 'Status updated' };
    case 'assign': return { tt: a.to_value?.owner_id ? 'Lead assigned' : 'Owner cleared', td: 'Ownership change' };
    case 'follow_up': return { tt: a.to_value?.action === 'completed' ? 'Follow-up completed' : a.to_value?.action === 'scheduled' ? `Follow-up scheduled · ${fmtDT(a.to_value?.scheduled_at)}` : 'Follow-up updated', td: a.note || '' };
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

export function LeadSheet({ leadId, onClose, onChanged }: { leadId: number; onClose: () => void; onChanged?: () => void }) {
  const { can } = useAuth();
  const ref = useRef_();
  const [lead, setLead] = useState<any>(null);
  const [tab, setTab] = useState<'activity' | 'notes' | 'redflag' | 'calls' | 'whatsapp'>('activity');
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
  const canUpdate = can('lead.update');

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
    if (!Object.keys(edits).length) { onClose(); return; }
    setBusy(true);
    try {
      await api.patch(`/leads/${lead.id}`, edits);
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
              {/* Sprint 3 — a breached SLA and an escalation flag are visible on the sheet */}
              {lead.sla_breached ? <span className="bdg b-rose" title="SLA breached">SLA breached</span> : null}
              {lead.is_flagged && !lead.sla_breached
                ? <span className="bdg b-amber" title={lead.flag_reason || 'Flagged'}>{lead.flag_reason || 'Flagged'}</span>
                : null}
              {lead.is_red_flagged
                ? <span className="bdg b-rose" title="Red flagged"><Ic k="flag" w={2} /> Red flag</span>
                : null}
            </div>
          </div>
          <button className="x" onClick={onClose}><Ic k="x" /></button>
        </div>
        <div className="sheet-act">
          <a className="qa call" href={`tel:${lead.phone}`}><Ic k="calls" />Call</a>
          <a className="qa wa" href={`https://wa.me/${String(lead.whatsapp_phone || lead.phone).replace(/[^\d]/g, '')}`} target="_blank" rel="noreferrer"><Ic k="wa" />WhatsApp</a>
          <a className="qa" href={lead.email ? `mailto:${lead.email}` : undefined} onClick={(e) => { if (!lead.email) { e.preventDefault(); toast('No email on this lead', true); } }}><Ic k="mail" />Email</a>
          <button className="qa" onClick={() => setTab('notes')}><Ic k="note" />Edit</button>
          {/* UAT-R3 #23 — reassign the lead's owner to another (active, in-scope) user. */}
          {can('lead.assign') && <button className="qa" onClick={() => setReassign(true)}><Ic k="users" />Reassign</button>}
          {/* Jul 2026 — transfer the lead to another Branch / Vertical / Campaign (re-parents its path). */}
          {can('lead.transfer') && <button className="qa" onClick={() => setTransfer(true)}><Ic k="swap" />Transfer</button>}
          {/* Aug 2026 — RED FLAG: type a remark; records a red-flag entry + timeline + flag state. */}
          {canFlag && <button className="qa" onClick={() => setRedFlag(true)}
            style={lead.is_red_flagged ? { color: 'var(--danger)' } : undefined}>
            <Ic k="flag" />{lead.is_red_flagged ? 'Red flag' : 'Red flag'}</button>}
          {/* Phase 2 — convert this lead to a STUDENT (creates the student record + marks the lead WON). */}
          {can('student.create') && <button className="qa" onClick={() => setConvert(true)}><Ic k="students" />Convert to Student</button>}
        </div>
        <div className="sheet-body">
          <div className="sheet-sec">
            <h5>Pipeline stage — tap to update</h5>
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
              <div className="f"><label>Owner</label><div className="iv">
                {ref.users.length && can('lead.assign') ? sel('owner_id', selectableUsers(ref.users, ed('owner_id') ?? lead.owner_id)) : <span>{lead.owner_name || 'Unassigned'}</span>}
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
              <div className="f"><label>Source</label><div className="iv">{lead.source_name}{lead.source_deleted ? ' (deleted)' : ''}</div></div>
              <div className="f"><label>Course interest{mlink('course', 'course_id')}</label><div className="iv">
                {ref.courses.length || extra['course_id']?.length ? sel('course_id', withExtra('course_id', ref.courses)) : <span>{lead.course_name || '—'}</span>}
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
              <div className="f"><label>Status{mlink('status', 'status_id')}</label><div className="iv">
                {ref.statuses.length || extra['status_id']?.length ? sel('status_id', withExtra('status_id', ref.statuses), false) : <span>{lead.status_name || '—'}</span>}
              </div></div>
              <div className="f"><label>Next follow-up</label><div className="iv">
                <span>{fmtDT(lead.next_follow_up_at)}</span><Ic k="cal" />
              </div></div>
              <div className="f s2"><label>Path</label><div className="iv">
                <span>
                  {lead.branch_name}{lead.branch_deleted ? ' (deleted)' : ''} › {lead.vertical_name}{lead.vertical_deleted ? ' (deleted)' : ''} › {lead.pipeline_name}{lead.pipeline_deleted ? ' (deleted)' : ''} › {lead.campaign_name}{lead.campaign_deleted ? ' (deleted)' : ''}
                </span>
              </div></div>
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
                  {t === 'redflag' && lead.is_red_flagged ? <span style={{ color: 'var(--danger)', marginRight: 4 }}>●</span> : null}{lbl}
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
                <div className="kv"><div className="f s2"><label>Add note</label>
                  <div className="iv">
                    <input placeholder="Type a note…" value={noteText}
                      onChange={(e) => setNoteText(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') addNote(); }} />
                    <button className="bdg b-indigo" onClick={addNote} style={{ cursor: 'pointer' }}>Save</button>
                  </div>
                </div></div>
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
                {canFlag && (
                  <div className="kv"><div className="f s2"><label>Add a red-flag remark</label>
                    <div className="iv">
                      <input placeholder="Why is this lead red-flagged\u2026" value={rfText}
                        onChange={(e) => setRfText(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') addRedFlag(); }} />
                      <button className="bdg b-rose" onClick={addRedFlag} style={{ cursor: 'pointer' }}>Flag</button>
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
                      <div className="tt" style={{ color: 'var(--danger)' }}><Ic k="flag" w={2} /> {r.remark}</div>
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
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={saveEdits} disabled={busy || !canUpdate}>{checkS}Save changes</button>
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
        <div className="ah"><h3><Ic k="users" />Reassign lead</h3><button className="ax" onClick={onClose}><Ic k="x" /></button></div>
        <div className="abody">
          <div className="fld">
            <label>Current owner</label>
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
                    {fmtDT(a.occurred_at)} — {a.to_value?.owner_id ? `assigned to ${nameOfUser(a.to_value.owner_id) ?? `#${a.to_value.owner_id}`}` : 'owner cleared'}
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
        <div className="ah"><h3 style={{ color: 'var(--danger)' }}><Ic k="flag" />Red flag lead</h3>
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
            style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }}><Ic k="flag" />Red flag</button>
        </div>
      </div>
    </div>
  );
}
