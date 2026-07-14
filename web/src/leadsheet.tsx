/** Lead detail / edit slide-in sheet — ported 1:1 from the prototype's renderLead(). */
import { useEffect, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic, checkS } from './icons';
import { AddMasterModal } from './mastermodal';
import { AddModal } from './forms';
import { PhoneInput } from './phonefield';
import { Avatar, TempBadge } from './renderer';
import { DuplicatePanel } from './mergemodal';
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
    default: return { tt: a.type, td: a.note || '' };
  }
}

export function LeadSheet({ leadId, onClose, onChanged }: { leadId: number; onClose: () => void; onChanged?: () => void }) {
  const { can } = useAuth();
  const ref = useRef_();
  const [lead, setLead] = useState<any>(null);
  const [tab, setTab] = useState<'activity' | 'notes' | 'calls' | 'whatsapp'>('activity');
  const [saved, setSaved] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [noteText, setNoteText] = useState('');
  const [busy, setBusy] = useState(false);
  const [masterAdd, setMasterAdd] = useState<{ type: string; k: string } | null>(null);
  const [courseAdd, setCourseAdd] = useState(false);
  const [extra, setExtra] = useState<Record<string, Named[]>>({});

  const load = () => api.get<any>(`/leads/${leadId}`).then(setLead).catch((e) => { toast(e.message, true); onClose(); });
  useEffect(() => { load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [leadId]);

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
            </div>
          </div>
          <button className="x" onClick={onClose}><Ic k="x" /></button>
        </div>
        <div className="sheet-act">
          <a className="qa call" href={`tel:${lead.phone}`}><Ic k="calls" />Call</a>
          <a className="qa wa" href={`https://wa.me/${String(lead.whatsapp_phone || lead.phone).replace(/[^\d]/g, '')}`} target="_blank" rel="noreferrer"><Ic k="wa" />WhatsApp</a>
          <a className="qa" href={lead.email ? `mailto:${lead.email}` : undefined} onClick={(e) => { if (!lead.email) { e.preventDefault(); toast('No email on this lead', true); } }}><Ic k="mail" />Email</a>
          <button className="qa" onClick={() => setTab('notes')}><Ic k="note" />Edit</button>
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
          <DuplicatePanel leadId={lead.id} onChanged={() => { load(); onChanged?.(); }} />
          <div className="sheet-sec">
            <h5>History</h5>
            <div className="seltabs">
              {(['activity', 'notes', 'calls', 'whatsapp'] as const).map((t) => (
                <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                  {t[0].toUpperCase() + t.slice(1)}
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
            {tab === 'calls' && <div className="empty-note">Call logs ride on the NeoDove telephony integration (Sprint 3).</div>}
            {tab === 'whatsapp' && <div className="empty-note">WhatsApp threads switch on with the Meta Cloud API integration (Sprint 3).</div>}
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
    </div>
  );
}
