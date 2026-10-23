/**
 * MODULE COMPLETION (client, Oct 2026 — "many modules still show Phase 2 pending"). The
 * screens that were design placeholders, made working:
 *   · WhatsBot / AI Bot           — Engagement
 *   · Scholarships                — Finance
 *   · Shared Documents            — Workspace
 *   · Salary                      — HR
 *   · Keyword Tracking, AI Usage, AI Settings — Communication Intelligence
 *   · Forecasting                 — Analytics & Reports
 *   · Duplicate Rules             — Marketing & Lead Management
 *   · Compliance                  — Administration
 * Every number on these screens is read from the database — nothing is a fixed figure.
 */
import { useEffect, useState } from 'react';
import { api, getToken } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, HBars, Kpis, TableCard } from './renderer';
import { toast, useFetch, useRef_ } from './refdata';
import { ConfirmModal, DetailModal } from './rowactions';
import { DateRange } from './daterange';
import { fmtINR } from './money';

const dmy = (v?: unknown) => (v ? new Date(String(v)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const dt = (v?: unknown) => (v ? new Date(String(v)).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const Toggle = ({ on, onChange, label, testid }: { on: boolean; onChange: (v: boolean) => void; label: string; testid?: string }) => (
  <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', cursor: 'pointer' }} data-testid={testid}>
    <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} /> {label}
  </label>
);

/* ==================================================================== */
/*  WHATSBOT                                                            */
/* ==================================================================== */

export function WhatsBot() {
  const { can } = useAuth();
  const manage = can('message.manage');
  const s = useFetch<any>('/bots/settings');
  const rules = useFetch<any[]>('/bots/rules');
  const log = useFetch<any>('/bots/log?limit=100');
  const [cfg, setCfg] = useState<any>(null);
  const [edit, setEdit] = useState<any | null | undefined>(undefined);
  const [del, setDel] = useState<any>(null);
  const [tryText, setTryText] = useState('');
  const [tryOut, setTryOut] = useState<any>(null);
  useEffect(() => { if (s.data && !cfg) setCfg(s.data.whatsbot); }, [s.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    try { const r = await api.put<any>('/bots/whatsbot', cfg); setCfg(r); toast('WhatsBot settings saved'); s.reload(); }
    catch (e) { toast((e as Error).message, true); }
  };
  const tryIt = async () => {
    try { setTryOut(await api.post<any>('/bots/simulate', { text: tryText, first_message: false })); }
    catch (e) { toast((e as Error).message, true); }
  };
  const remove = async () => {
    try { await api.del(`/bots/rules/${del.id}`); toast('Rule deleted'); setDel(null); rules.reload(); }
    catch (e) { toast((e as Error).message, true); }
  };
  const st = log.data?.stats;
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <>
      <Kpis items={[
        { lab: 'Bot replies (24h)', val: String(st?.replies_24h ?? 0), ic: 'wa' },
        { lab: 'Conversations (24h)', val: String(st?.conversations_24h ?? 0), ic: 'users' },
        { lab: 'Hand-overs (24h)', val: String(st?.handovers_24h ?? 0), ic: 'check' },
        { lab: 'Active rules', val: String((rules.data ?? []).filter((r) => r.is_active).length), ic: 'list' },
      ]} />
      {cfg && (
        <div className="card">
          <div className="card-head"><h3><Ic k="wa" />WhatsBot settings</h3>
            <span className={`bdg ${cfg.enabled ? 'b-green' : 'b-gray'}`}>{cfg.enabled ? 'ON' : 'OFF'}</span></div>
          <div className="card-pad">
            <div className="form-grid">
              <div className="fld span2"><Toggle on={!!cfg.enabled} onChange={(v) => setCfg({ ...cfg, enabled: v })} label="Bot answers inbound WhatsApp messages (while a conversation's bot is ON in Live Chat)" testid="wb-enabled" /></div>
              <div className="fld span2">
                <Toggle on={!!cfg.welcome_enabled} onChange={(v) => setCfg({ ...cfg, welcome_enabled: v })} label="Welcome message for a new number" />
                <textarea className="ainp" rows={2} value={cfg.welcome_text} onChange={(e) => setCfg({ ...cfg, welcome_text: e.target.value })} data-testid="wb-welcome" />
              </div>
              <div className="fld span2">
                <Toggle on={!!cfg.away_enabled} onChange={(v) => setCfg({ ...cfg, away_enabled: v })} label="Out-of-hours reply (once per 12 hours per contact)" />
                <textarea className="ainp" rows={2} value={cfg.away_text} onChange={(e) => setCfg({ ...cfg, away_text: e.target.value })} />
              </div>
              <div className="fld"><label>Open from (IST)</label><input className="ainp" type="time" value={cfg.open_from} onChange={(e) => setCfg({ ...cfg, open_from: e.target.value })} /></div>
              <div className="fld"><label>Open until (IST)</label><input className="ainp" type="time" value={cfg.open_to} onChange={(e) => setCfg({ ...cfg, open_to: e.target.value })} /></div>
              <div className="fld span2"><label>Working days</label>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {DAYS.map((d, i) => (
                    <label key={d} style={{ display: 'inline-flex', gap: 4, fontWeight: 400 }}>
                      <input type="checkbox" checked={(cfg.open_days ?? []).includes(i)}
                        onChange={(e) => setCfg({ ...cfg, open_days: e.target.checked ? [...(cfg.open_days ?? []), i] : (cfg.open_days ?? []).filter((x: number) => x !== i) })} />{d}
                    </label>
                  ))}
                </div>
              </div>
              <div className="fld"><label>Max bot replies per contact per hour</label>
                <input className="ainp" type="number" min={1} max={30} value={cfg.max_replies_per_hour} onChange={(e) => setCfg({ ...cfg, max_replies_per_hour: Number(e.target.value) })} /></div>
            </div>
            {manage && <button className="btn primary" style={{ marginTop: 10 }} onClick={save} data-testid="wb-save"><Ic k="check" />Save settings</button>}
          </div>
        </div>
      )}
      <TableCard title="Keyword rules" icon="list"
        more={manage ? <a style={{ cursor: 'pointer', color: 'var(--primary)' }} onClick={() => setEdit(null)} data-testid="wb-add-rule">+ Add rule</a> : undefined}
        cols={['Priority', 'Rule', 'Keywords', 'Match', 'Reply', 'Used', 'Status', 'Actions']}
        empty='No rules yet — e.g. keywords "fee, fees" → reply with your fee details.'
        rows={(rules.data ?? []).map((r): Cell[] => [
          { mono: String(r.priority) }, { node: <b>{r.name}</b> }, r.keywords, r.match_type,
          { node: <span style={{ whiteSpace: 'pre-wrap' }}>{String(r.reply).slice(0, 120)}{String(r.reply).length > 120 ? '…' : ''}</span> },
          { mono: String(r.hits) },
          { b: [r.is_active ? 'Active' : 'Inactive', r.is_active ? 'b-green' : 'b-gray'] },
          { node: manage ? <span style={{ display: 'inline-flex', gap: 4 }}>
            <button className="icon-btn sm" title="Edit" onClick={() => setEdit(r)}><Ic k="pencil" /></button>
            <button className="icon-btn sm" title="Delete" onClick={() => setDel(r)}><Ic k="trash" /></button></span> : '—' },
        ])} />
      <div className="card">
        <div className="card-head"><h3><Ic k="bolt" />Try it</h3></div>
        <div className="card-pad" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input className="ainp" style={{ flex: 1, minWidth: 220 }} placeholder='Type a message a student might send, e.g. "what are the fees?"' value={tryText} onChange={(e) => setTryText(e.target.value)} data-testid="wb-try" />
          <button className="btn" onClick={tryIt} disabled={!tryText.trim()}><Ic k="wa" />What would the bot reply?</button>
          {tryOut && (
            <div className="notice" style={{ width: '100%' }}><Ic k="wa" /><div>
              {tryOut.reply ? <><b>{tryOut.kind === 'keyword' ? 'Keyword rule' : tryOut.kind === 'ai' ? 'AI Bot' : tryOut.kind === 'handover' ? 'Hand-over' : tryOut.kind === 'away' ? 'Away reply' : 'Welcome'}:</b> {tryOut.reply}</>
                : <>No automatic reply{tryOut.error ? ` — ${tryOut.error}` : ' — the message waits for a counsellor in Live Chat.'}</>}
            </div></div>
          )}
        </div>
      </div>
      <TableCard title="Bot activity" icon="clock" cols={['When', 'Contact', 'Lead', 'Type', 'Message', 'Bot reply', 'Status']}
        empty="No bot replies yet."
        rows={(log.data?.rows ?? []).map((r: any): Cell[] => [
          dt(r.created_at), { mono: r.phone10 }, r.lead_name ?? '—', { b: [r.kind, r.kind === 'skipped' ? 'b-gray' : r.kind === 'handover' ? 'b-amber' : 'b-indigo'] },
          String(r.inbound_text ?? '').slice(0, 80), String(r.reply_text ?? '—').slice(0, 80),
          r.error ? { node: <span className="sub">{r.status} · {r.error}</span> } : (r.status ?? '—'),
        ])} />
      {edit !== undefined && <BotRuleModal rule={edit} onClose={() => setEdit(undefined)} onSaved={() => { setEdit(undefined); rules.reload(); }} />}
      {del && <ConfirmModal title="Delete rule" danger confirmLabel="Delete" body={<>Delete the rule <b>{del.name}</b>?</>} onConfirm={remove} onClose={() => setDel(null)} />}
    </>
  );
}

function BotRuleModal({ rule, onClose, onSaved }: { rule: any | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<any>(rule ?? { name: '', keywords: '', match_type: 'contains', reply: '', priority: 100, is_active: true });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      if (rule?.id) await api.patch(`/bots/rules/${rule.id}`, f); else await api.post('/bots/rules', f);
      toast('Rule saved'); onSaved();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  return (
    <DetailModal title={rule?.id ? `Edit rule — ${rule.name}` : 'Add keyword rule'} icon="list" onClose={onClose} width={560}
      footer={<button className="btn primary" disabled={busy} onClick={save} data-testid="wb-rule-save"><Ic k="check" />Save rule</button>}>
      <div className="form-grid">
        <div className="fld"><label>Rule name *</label><input className="ainp" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} data-testid="wb-rule-name" /></div>
        <div className="fld"><label>Priority (lower first)</label><input className="ainp" type="number" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })} /></div>
        <div className="fld span2"><label>Keywords * <span className="fhint">comma-separated, e.g. fee, fees, price</span></label>
          <input className="ainp" value={f.keywords} onChange={(e) => setF({ ...f, keywords: e.target.value })} data-testid="wb-rule-keywords" /></div>
        <div className="fld"><label>Match</label>
          <select className="ainp" value={f.match_type} onChange={(e) => setF({ ...f, match_type: e.target.value })}>
            <option value="contains">Message contains the keyword</option><option value="starts">Message starts with it</option><option value="exact">Message is exactly it</option>
          </select></div>
        <div className="fld"><label>Status</label>
          <select className="ainp" value={f.is_active ? '1' : '0'} onChange={(e) => setF({ ...f, is_active: e.target.value === '1' })}><option value="1">Active</option><option value="0">Inactive</option></select></div>
        <div className="fld span2"><label>Reply *</label><textarea className="ainp" rows={4} value={f.reply} onChange={(e) => setF({ ...f, reply: e.target.value })} data-testid="wb-rule-reply" /></div>
      </div>
    </DetailModal>
  );
}

/* ==================================================================== */
/*  AI BOT                                                               */
/* ==================================================================== */

export function AiBot() {
  const { can } = useAuth();
  const s = useFetch<any>('/bots/settings');
  const [cfg, setCfg] = useState<any>(null);
  const [tryText, setTryText] = useState('');
  const [tryOut, setTryOut] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (s.data && !cfg) setCfg(s.data.aibot); }, [s.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    setBusy(true);
    try { const r = await api.put<any>('/bots/aibot', cfg); setCfg(r); toast('AI Bot settings saved'); s.reload(); }
    catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const tryIt = async () => {
    setBusy(true);
    try { setTryOut(await api.post<any>('/bots/simulate', { text: tryText })); }
    catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  if (!cfg) return <div className="card"><div className="empty-note">Loading…</div></div>;
  return (
    <>
      {!s.data?.ai_configured && (
        <div className="notice warn"><Ic k="bolt" /><div>No AI provider key is saved yet. Add a <b>Gemini</b> or <b>DeepSeek</b> API key in Administration › Settings › Channels › AI, then switch the AI Bot on.</div></div>
      )}
      <div className="card">
        <div className="card-head"><h3><Ic k="intel" />AI Bot</h3><span className={`bdg ${cfg.enabled ? 'b-green' : 'b-gray'}`}>{cfg.enabled ? 'ON' : 'OFF'}</span></div>
        <div className="card-pad">
          <div className="form-grid">
            <div className="fld span2"><Toggle on={!!cfg.enabled} onChange={(v) => setCfg({ ...cfg, enabled: v })} label="AI answers WhatsApp messages that no WhatsBot keyword rule matched" testid="ai-enabled" /></div>
            <div className="fld span2"><label>Knowledge the bot answers from <span className="fhint">courses, fees, batches, address, timings, FAQs — the bot never invents anything outside this</span></label>
              <textarea className="ainp" rows={10} value={cfg.knowledge} onChange={(e) => setCfg({ ...cfg, knowledge: e.target.value })} data-testid="ai-knowledge"
                placeholder={'e.g.\nIELTS Academic — 8 weeks, ₹18,000. Batches Mon–Fri 10am & 6pm.\nAddress: …\nDemo class every Saturday 11am.'} /></div>
            <div className="fld span2"><label>Tone</label><input className="ainp" value={cfg.tone} onChange={(e) => setCfg({ ...cfg, tone: e.target.value })} /></div>
            <div className="fld span2"><label>Hand over to a counsellor on these words <span className="fhint">comma-separated — the bot switches off for that conversation</span></label>
              <input className="ainp" value={cfg.handover_keywords} onChange={(e) => setCfg({ ...cfg, handover_keywords: e.target.value })} /></div>
            <div className="fld span2"><label>Hand-over message</label><input className="ainp" value={cfg.handover_text} onChange={(e) => setCfg({ ...cfg, handover_text: e.target.value })} /></div>
            <div className="fld"><label>Provider</label>
              <select className="ainp" value={cfg.provider} onChange={(e) => setCfg({ ...cfg, provider: e.target.value })}>
                <option value="">Default (AI Settings)</option>
                {(s.data?.providers ?? []).map((p: any) => <option key={p.provider} value={p.provider}>{p.label}{p.configured ? '' : ' — no key'}</option>)}
              </select></div>
          </div>
          {can('message.manage') && <button className="btn primary" style={{ marginTop: 10 }} disabled={busy} onClick={save} data-testid="ai-save"><Ic k="check" />Save AI Bot</button>}
        </div>
      </div>
      <div className="card">
        <div className="card-head"><h3><Ic k="bolt" />Try it</h3></div>
        <div className="card-pad" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input className="ainp" style={{ flex: 1, minWidth: 220 }} value={tryText} onChange={(e) => setTryText(e.target.value)} placeholder="Ask what a student would ask (save first)" data-testid="ai-try" />
          <button className="btn" disabled={busy || !tryText.trim()} onClick={tryIt}><Ic k="intel" />Ask the bot</button>
          {tryOut && <div className="notice" style={{ width: '100%' }}><Ic k="intel" /><div>{tryOut.reply ? <><b>{tryOut.kind}:</b> {tryOut.reply}</> : <>No reply{tryOut.error ? ` — ${tryOut.error}` : ''}.</>}</div></div>}
        </div>
      </div>
    </>
  );
}

/* ==================================================================== */
/*  SCHOLARSHIPS                                                         */
/* ==================================================================== */

const SCH_BADGE: Record<string, string> = { pending: 'b-amber', approved: 'b-green', rejected: 'b-rose', cancelled: 'b-gray' };

export function Scholarships() {
  const { can } = useAuth();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [tick, setTick] = useState(0);
  const qs = new URLSearchParams(); if (status) qs.set('status', status); if (q.trim()) qs.set('q', q.trim());
  const list = useFetch<any>(`/scholarships?${qs}`, [qs.toString(), tick]);
  const [add, setAdd] = useState(false);
  const [decide, setDecide] = useState<{ row: any; approve: boolean } | null>(null);
  const after = () => setTick((t) => t + 1);
  const rows: any[] = list.data?.rows ?? [];
  const sm = list.data?.summary ?? {};
  const removeRow = async (r: any) => {
    if (!window.confirm(`Delete the ${r.status} scholarship request for ${r.enrolment_no}?`)) return;
    try { await api.del(`/scholarships/${r.id}`); toast('Scholarship request deleted'); after(); } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <>
      {can('scholarship.request') && <div className="page-actions"><button className="btn primary" onClick={() => setAdd(true)} data-testid="sch-add"><Ic k="plus" />Request scholarship</button></div>}
      <Kpis items={[
        { lab: 'Pending approval', val: String(sm.pending ?? 0), ic: 'clock', onClick: () => setStatus('pending') },
        { lab: 'Approved', val: String(sm.approved ?? 0), ic: 'check', onClick: () => setStatus('approved') },
        { lab: 'Rejected', val: String(sm.rejected ?? 0), ic: 'x', onClick: () => setStatus('rejected') },
        { lab: 'Approved value', val: fmtINR(Number(sm.approved_minor ?? 0)), ic: 'rupee' },
      ]} />
      <div className="filters">
        <label className="fchip"><Ic k="search" /><input placeholder="Enrolment / student" value={q} onChange={(e) => setQ(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', font: 'inherit', color: 'var(--text)' }} /></label>
        <label className="fchip"><Ic k="shield" /><select value={status} onChange={(e) => setStatus(e.target.value)} style={{ background: 'none', border: 'none', font: 'inherit', color: 'var(--text)' }}>
          <option value="">All statuses</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select></label>
      </div>
      <TableCard fill title="Scholarships" icon="award" listKey="scholarships"
        cols={['Enrolment', 'Student', 'Course', 'Branch', 'Type', 'Value', 'Amount', 'Reason', 'Requested by', 'Status', 'Decided', 'Actions']}
        empty="No scholarship requests yet."
        rows={rows.map((r): Cell[] => [
          { mono: r.enrolment_no }, r.student_name ?? '—', r.course_name ?? '—', r.branch_name ?? '—',
          r.scholarship_type === 'percent' ? 'Percentage' : 'Fixed ₹',
          r.scholarship_type === 'percent' ? `${Number(r.value)}%` : fmtINR(Math.round(Number(r.value) * 100)),
          { mono: fmtINR(Number(r.amount_minor)) },
          { node: <span title={r.reason}>{String(r.reason).slice(0, 60)}</span> },
          r.requested_by_name ?? '—',
          { b: [r.status, SCH_BADGE[r.status] ?? 'b-gray'] },
          { node: r.decided_at ? <span>{dmy(r.decided_at)}<div className="sub">{r.decided_by_name}{r.remarks ? ` · ${r.remarks}` : ''}</div></span> : <span className="sub">—</span> },
          { node: <span style={{ display: 'inline-flex', gap: 4 }}>
              {r.status === 'pending' && can('scholarship.approve') && <>
                <button className="btn sm primary" onClick={() => setDecide({ row: r, approve: true })}><Ic k="check" />Approve</button>
                <button className="btn sm" onClick={() => setDecide({ row: r, approve: false })}><Ic k="x" />Reject</button></>}
              {r.status !== 'approved' && can('scholarship.delete') &&
                <button className="icon-btn sm" title="Delete" onClick={() => void removeRow(r)}><Ic k="trash" /></button>}
            </span> },
        ])} />
      {add && <ScholarshipRequestModal onClose={() => setAdd(false)} onDone={() => { setAdd(false); after(); }} />}
      {decide && <ScholarshipDecideModal {...decide} onClose={() => setDecide(null)} onDone={() => { setDecide(null); after(); }} />}
    </>
  );
}

function ScholarshipRequestModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState('');
  const found = useFetch<any[]>(q.trim().length >= 2 ? `/enrolments?q=${encodeURIComponent(q.trim())}&status=active&limit=10` : null, [q]);
  const [enr, setEnr] = useState<any>(null);
  const [type, setType] = useState('percent');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const net = Number(enr?.net_fee_minor ?? 0);
  const amt = type === 'percent' ? Math.round((net * Number(value || 0)) / 100) : Math.round(Number(value || 0) * 100);
  const save = async () => {
    if (!enr) { toast('Pick the enrolment', true); return; }
    setBusy(true);
    try { await api.post('/scholarships', { enrolment_id: Number(enr.id), scholarship_type: type, value: Number(value), reason }); toast('Scholarship requested — waiting for approval'); onDone(); }
    catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  return (
    <DetailModal title="Request scholarship" icon="award" onClose={onClose} width={560}
      footer={<button className="btn primary" disabled={busy || !enr || !value || !reason.trim()} onClick={save} data-testid="sch-save"><Ic k="check" />Send for approval</button>}>
      <div className="form-grid">
        <div className="fld span2"><label>Enrolment *</label>
          {enr ? <div className="notice"><Ic k="students" /><div><b>{enr.enrolment_no}</b> · {enr.lead_name} · {enr.course_name ?? '—'} · net {fmtINR(net)} <a style={{ cursor: 'pointer', marginLeft: 8 }} onClick={() => setEnr(null)}>change</a></div></div>
            : <>
              <input className="ainp" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search enrolment no / student / phone" data-testid="sch-search" />
              {(found.data ?? []).map((e) => (
                <div key={e.id} className="lrow" style={{ cursor: 'pointer' }} onClick={() => setEnr(e)}>
                  <div className="gr"><div className="t1">{e.enrolment_no} · {e.lead_name}</div><div className="t2">{e.course_name ?? '—'} · net {fmtINR(Number(e.net_fee_minor))}</div></div>
                </div>))}
            </>}
        </div>
        <div className="fld"><label>Type</label>
          <select className="ainp" value={type} onChange={(e) => setType(e.target.value)}><option value="percent">Percentage (%)</option><option value="amount">Fixed amount (₹)</option></select></div>
        <div className="fld"><label>{type === 'percent' ? 'Percentage *' : 'Amount (₹) *'}</label>
          <input className="ainp" type="number" value={value} onChange={(e) => setValue(e.target.value)} data-testid="sch-value" />
          {enr && value ? <div className="fhint">Takes {fmtINR(amt)} off the net fee → {fmtINR(Math.max(0, net - amt))}</div> : null}</div>
        <div className="fld span2"><label>Reason * <span className="fhint">mandatory</span></label>
          <textarea className="ainp" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="sch-reason" /></div>
      </div>
    </DetailModal>
  );
}

function ScholarshipDecideModal({ row, approve, onClose, onDone }: { row: any; approve: boolean; onClose: () => void; onDone: () => void }) {
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await api.post(`/scholarships/${row.id}/${approve ? 'approve' : 'reject'}`, { remarks });
      toast(approve ? `Approved — ${fmtINR(Number(row.amount_minor))} taken off ${row.enrolment_no}` : 'Rejected');
      onDone();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  return (
    <DetailModal title={`${approve ? 'Approve' : 'Reject'} scholarship — ${row.enrolment_no}`} icon={approve ? 'check' : 'x'} onClose={onClose} width={480}
      footer={<button className="btn primary" disabled={busy || (!approve && !remarks.trim())} onClick={go}><Ic k={approve ? 'check' : 'x'} />{approve ? 'Approve' : 'Reject'}</button>}>
      <p>{row.student_name} · {row.scholarship_type === 'percent' ? `${Number(row.value)}%` : 'fixed'} = <b>{fmtINR(Number(row.amount_minor))}</b></p>
      <p className="sub">Reason: {row.reason}</p>
      {approve && <div className="notice"><Ic k="rupee" /><div>The enrolment's net fee drops by this amount and its payment plan reconciles.</div></div>}
      <div className="fld"><label>Remarks{approve ? '' : ' *'}</label><textarea className="ainp" rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} /></div>
    </DetailModal>
  );
}

/* ==================================================================== */
/*  SHARED DOCUMENTS                                                     */
/* ==================================================================== */

const fmtSize = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function SharedDocs() {
  const { can } = useAuth();
  const [folder, setFolder] = useState('');
  const [q, setQ] = useState('');
  const [tick, setTick] = useState(0);
  const qs = new URLSearchParams(); if (folder) qs.set('folder_id', folder); if (q.trim()) qs.set('q', q.trim());
  const list = useFetch<any>(`/shared-docs?${qs}`, [qs.toString(), tick]);
  const [up, setUp] = useState(false);
  const [del, setDel] = useState<any>(null);
  const after = () => setTick((t) => t + 1);
  const download = async (d: any) => {
    try {
      const res = await fetch(`/api/shared-docs/${d.id}/download`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a'); a.href = url; a.download = d.file_name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000); after();
    } catch (e) { toast((e as Error).message, true); }
  };
  const newFolder = async () => {
    const name = window.prompt('Folder name');
    if (!name?.trim()) return;
    try { await api.post('/shared-docs/folders', { name }); toast('Folder created'); after(); } catch (e) { toast((e as Error).message, true); }
  };
  const delFolder = async (id: number) => {
    try { await api.del(`/shared-docs/folders/${id}`); toast('Folder deleted'); setFolder(''); after(); } catch (e) { toast((e as Error).message, true); }
  };
  const remove = async () => {
    try { await api.del(`/shared-docs/${del.id}`); toast('Document deleted'); setDel(null); after(); } catch (e) { toast((e as Error).message, true); }
  };
  const SHARE: Record<string, string> = { all: 'Everyone', branch: 'Branch', vertical: 'Vertical', role: 'Role' };
  const folders: any[] = list.data?.folders ?? [];
  return (
    <>
      {can('shared_doc.upload') && <div className="page-actions">
        <button className="btn" onClick={newFolder}><Ic k="plus" />New folder</button>
        <button className="btn primary" onClick={() => setUp(true)} data-testid="doc-upload"><Ic k="plus" />Upload document</button></div>}
      <div className="filters">
        <label className="fchip"><Ic k="search" /><input placeholder="Search documents" value={q} onChange={(e) => setQ(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', font: 'inherit', color: 'var(--text)' }} /></label>
        <button className={`fchip${folder === '' ? ' on' : ''}`} onClick={() => setFolder('')}>All folders</button>
        <button className={`fchip${folder === 'none' ? ' on' : ''}`} onClick={() => setFolder('none')}>Unfiled</button>
        {folders.map((f) => (
          <span key={f.id} className={`fchip${folder === String(f.id) ? ' on' : ''}`} style={{ cursor: 'pointer' }} onClick={() => setFolder(String(f.id))}>
            <Ic k="doc" />{f.name} ({f.files}){can('shared_doc.delete') && Number(f.files) === 0
              ? <a title="Delete folder" onClick={(e) => { e.stopPropagation(); void delFolder(Number(f.id)); }} style={{ marginLeft: 4 }}>×</a> : null}
          </span>))}
      </div>
      <TableCard fill title="Shared documents" icon="doc" listKey="sharedDocs"
        cols={['Title', 'File', 'Folder', 'Shared with', 'Size', 'Uploaded by', 'Date', 'Downloads', 'Actions']}
        empty="No documents shared yet."
        rows={(list.data?.rows ?? []).map((d: any): Cell[] => [
          { node: <div><b>{d.title}</b>{d.description ? <div className="sub">{d.description}</div> : null}</div> },
          d.file_name, d.folder_name ?? '—',
          `${SHARE[d.share_scope] ?? d.share_scope}${d.branch_name ? ` · ${d.branch_name}` : ''}${d.vertical_name ? ` · ${d.vertical_name}` : ''}${d.role_name ? ` · ${d.role_name}` : ''}`,
          fmtSize(Number(d.size_bytes)), d.uploaded_by_name ?? '—', dmy(d.created_at), { mono: String(d.downloads) },
          { node: <span style={{ display: 'inline-flex', gap: 4 }}>
            <button className="icon-btn sm" title="Download" onClick={() => void download(d)}><Ic k="download" /></button>
            {can('shared_doc.delete') && <button className="icon-btn sm" title="Delete" onClick={() => setDel(d)}><Ic k="trash" /></button>}</span> },
        ])} />
      {up && <DocUploadModal folders={folders} defaultFolder={folder && folder !== 'none' ? folder : ''} onClose={() => setUp(false)} onDone={() => { setUp(false); after(); }} />}
      {del && <ConfirmModal title="Delete document" danger confirmLabel="Delete" body={<>Delete <b>{del.title}</b>?</>} onConfirm={remove} onClose={() => setDel(null)} />}
    </>
  );
}

function DocUploadModal({ folders, defaultFolder, onClose, onDone }: { folders: any[]; defaultFolder: string; onClose: () => void; onDone: () => void }) {
  const ref = useRef_();
  const roles = useFetch<any[]>('/roles');
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [folderId, setFolderId] = useState(defaultFolder);
  const [scope, setScope] = useState('all');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!file) { toast('Choose a file', true); return; }
    if (file.size > 15 * 1024 * 1024) { toast('Files up to 15 MB', true); return; }
    setBusy(true);
    try {
      const base64 = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(file); });
      await api.post('/shared-docs', {
        title: title || file.name, description: desc || undefined, folder_id: folderId || undefined, share_scope: scope,
        branch_id: scope === 'branch' ? target : undefined, vertical_id: scope === 'vertical' ? target : undefined, role_id: scope === 'role' ? target : undefined,
        file: { name: file.name, mime: file.type || 'application/octet-stream', base64 },
      });
      toast('Document uploaded'); onDone();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const opts = scope === 'branch' ? ref.branches : scope === 'vertical' ? ref.verticals : scope === 'role' ? (roles.data ?? []) : [];
  return (
    <DetailModal title="Upload document" icon="doc" onClose={onClose} width={560}
      footer={<button className="btn primary" disabled={busy || !file} onClick={save} data-testid="doc-save"><Ic k="check" />{busy ? 'Uploading…' : 'Upload'}</button>}>
      <div className="form-grid">
        <div className="fld span2"><label>File * <span className="fhint">up to 15 MB</span></label>
          <input type="file" className="ainp" onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); if (f && !title) setTitle(f.name); }} data-testid="doc-file" /></div>
        <div className="fld span2"><label>Title</label><input className="ainp" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
        <div className="fld span2"><label>Description</label><input className="ainp" value={desc} onChange={(e) => setDesc(e.target.value)} /></div>
        <div className="fld"><label>Folder</label>
          <select className="ainp" value={folderId} onChange={(e) => setFolderId(e.target.value)}><option value="">— None —</option>{folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></div>
        <div className="fld"><label>Share with</label>
          <select className="ainp" value={scope} onChange={(e) => { setScope(e.target.value); setTarget(''); }}>
            <option value="all">Everyone</option><option value="branch">A branch</option><option value="vertical">A vertical</option><option value="role">A role</option></select></div>
        {scope !== 'all' && <div className="fld span2"><label>{scope === 'branch' ? 'Branch' : scope === 'vertical' ? 'Vertical' : 'Role'} *</label>
          <select className="ainp" value={target} onChange={(e) => setTarget(e.target.value)}><option value="">— Choose —</option>{(opts as any[]).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>}
      </div>
    </DetailModal>
  );
}

/* ==================================================================== */
/*  SALARY                                                               */
/* ==================================================================== */

export function Payroll() {
  const { can } = useAuth();
  const manage = can('payroll.manage');
  const [tab, setTab] = useState<'structures' | 'runs'>('structures');
  const [tick, setTick] = useState(0);
  const structs = useFetch<any[]>('/payroll/structures', [tick]);
  const runs = useFetch<any[]>('/payroll/runs', [tick]);
  const [edit, setEdit] = useState<any>(null);
  const [view, setView] = useState<number | null>(null);
  const [period, setPeriod] = useState(() => new Date().toISOString().slice(0, 7));
  const [busy, setBusy] = useState(false);
  const after = () => setTick((t) => t + 1);
  const run = async () => {
    setBusy(true);
    try {
      const r = await api.post<any>('/payroll/runs', { period });
      toast(r.note ?? `Payroll ${period}: ${r.payslips} payslips · net ${fmtINR(r.net_minor)}`, !!r.note);
      after(); setTab('runs');
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const finalise = async (id: number) => { try { await api.post(`/payroll/runs/${id}/finalise`, {}); toast('Payroll finalised'); after(); } catch (e) { toast((e as Error).message, true); } };
  const removeRun = async (id: number) => { try { await api.del(`/payroll/runs/${id}`); toast('Draft payroll deleted'); after(); } catch (e) { toast((e as Error).message, true); } };
  const rows = structs.data ?? [];
  const withSalary = rows.filter((r) => Number(r.monthly_gross_minor) > 0);
  return (
    <>
      <Kpis items={[
        { lab: 'Active employees', val: String(rows.length), ic: 'users' },
        { lab: 'With salary set', val: String(withSalary.length), ic: 'check' },
        { lab: 'Monthly gross', val: fmtINR(withSalary.reduce((a, r) => a + Number(r.monthly_gross_minor), 0)), ic: 'rupee' },
        { lab: 'Payroll runs', val: String((runs.data ?? []).length), ic: 'doc' },
      ]} />
      <div className="filters">
        <button className={`btn${tab === 'structures' ? ' primary' : ''}`} onClick={() => setTab('structures')}>Salary structures</button>
        <button className={`btn${tab === 'runs' ? ' primary' : ''}`} onClick={() => setTab('runs')}>Payroll runs</button>
        {manage && <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input className="ainp" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} style={{ width: 150 }} data-testid="pay-period" />
          <button className="btn primary" disabled={busy} onClick={run} data-testid="pay-run"><Ic k="rupee" />Run payroll</button></span>}
      </div>
      {tab === 'structures' ? (
        <TableCard fill title="Salary structures" icon="users" listKey="payrollStructures"
          cols={['Code', 'Employee', 'Designation', 'Branch', 'Basic', 'HRA', 'Allowances', 'PF %', 'ESI %', 'Prof. tax', 'TDS', 'Monthly gross', 'Actions']}
          empty="No active employees — add them in HR › Employee Directory."
          rows={rows.map((r): Cell[] => [
            { mono: r.employee_code }, { node: <b>{r.name}</b> }, r.designation ?? '—', r.branch_name ?? '—',
            { mono: fmtINR(Number(r.basic_minor ?? 0)) }, { mono: fmtINR(Number(r.hra_minor ?? 0)) }, { mono: fmtINR(Number(r.allowance_minor ?? 0)) },
            String(Number(r.pf_pct ?? 0)), String(Number(r.esi_pct ?? 0)), { mono: fmtINR(Number(r.pt_minor ?? 0)) }, { mono: fmtINR(Number(r.tds_minor ?? 0)) },
            { mono: fmtINR(Number(r.monthly_gross_minor ?? 0)) },
            { node: manage ? <button className="btn sm" onClick={() => setEdit(r)}><Ic k="pencil" />Set salary</button> : '—' },
          ])} />
      ) : (
        <TableCard fill title="Payroll runs" icon="doc" listKey="payrollRuns"
          cols={['Month', 'Payslips', 'Gross', 'Net pay', 'Status', 'Created', 'Actions']}
          empty="No payroll run yet — set salaries, pick the month and press Run payroll."
          rows={(runs.data ?? []).map((r): Cell[] => [
            { mono: r.period }, String(r.payslips), { mono: fmtINR(Number(r.gross_minor)) }, { mono: fmtINR(Number(r.net_minor)) },
            { b: [r.status === 'finalised' ? 'Finalised' : 'Draft', r.status === 'finalised' ? 'b-green' : 'b-amber'] }, dmy(r.created_at),
            { node: <span style={{ display: 'inline-flex', gap: 4 }}>
              <button className="btn sm" onClick={() => setView(Number(r.id))}><Ic k="eye" />Payslips</button>
              {manage && r.status !== 'finalised' && <button className="btn sm" onClick={() => void finalise(Number(r.id))}><Ic k="check" />Finalise</button>}
              {manage && r.status !== 'finalised' && <button className="icon-btn sm" title="Delete draft" onClick={() => void removeRun(Number(r.id))}><Ic k="trash" /></button>}</span> },
          ])} />
      )}
      {edit && <SalaryModal emp={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); after(); }} />}
      {view != null && <PayslipsModal runId={view} onClose={() => setView(null)} />}
    </>
  );
}

function SalaryModal({ emp, onClose, onDone }: { emp: any; onClose: () => void; onDone: () => void }) {
  const r = (m: unknown) => (m == null ? '' : String(Number(m) / 100));
  const [f, setF] = useState<any>({ basic: r(emp.basic_minor), hra: r(emp.hra_minor), allowance: r(emp.allowance_minor),
    pf_pct: String(emp.pf_pct ?? 12), esi_pct: String(emp.esi_pct ?? 0), pt: r(emp.pt_minor ?? 20000), tds: r(emp.tds_minor), effective_from: emp.effective_from ? String(emp.effective_from).slice(0, 10) : '' });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await api.put(`/payroll/structures/${emp.employee_id}`, f); toast('Salary saved'); onDone(); }
    catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const F = (k: string, label: string, type = 'number') => (
    <div className="fld"><label>{label}</label><input className="ainp" type={type} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} data-testid={`sal-${k}`} /></div>);
  const gross = Number(f.basic || 0) + Number(f.hra || 0) + Number(f.allowance || 0);
  return (
    <DetailModal title={`Salary — ${emp.name}`} icon="rupee" onClose={onClose} width={560}
      footer={<button className="btn primary" disabled={busy} onClick={save} data-testid="sal-save"><Ic k="check" />Save salary</button>}>
      <div className="form-grid">
        {F('basic', 'Basic (₹ / month)')}{F('hra', 'HRA (₹ / month)')}{F('allowance', 'Other allowances (₹ / month)')}
        {F('pf_pct', 'Employee PF (% of basic)')}{F('esi_pct', 'Employee ESI (% of gross)')}{F('pt', 'Professional tax (₹ / month)')}
        {F('tds', 'TDS (₹ / month)')}{F('effective_from', 'Effective from', 'date')}
      </div>
      <div className="notice" style={{ marginTop: 8 }}><Ic k="rupee" /><div>Monthly gross ₹{gross.toLocaleString('en-IN')}. Absent and unpaid-leave days (HR attendance) are deducted when payroll runs.</div></div>
    </DetailModal>
  );
}

function PayslipsModal({ runId, onClose }: { runId: number; onClose: () => void }) {
  const { data } = useFetch<any>(`/payroll/runs/${runId}`);
  const [slip, setSlip] = useState<any>(null);
  const print = () => window.print();
  return (
    <DetailModal title={`Payslips — ${data?.run?.period ?? ''}`} icon="doc" onClose={onClose} width={900}>
      <TableCard title="Payslips" icon="doc" cols={['Code', 'Employee', 'Paid days', 'Gross', 'Deductions', 'Net pay', '']}
        empty="No payslips in this run."
        rows={(data?.rows ?? []).map((p: any): Cell[] => [
          { mono: p.employee_code }, p.name, `${Number(p.paid_days)} / ${p.days_in_month}`,
          { mono: fmtINR(Number(p.gross_minor)) }, { mono: fmtINR(Number(p.deduction_minor)) }, { mono: fmtINR(Number(p.net_minor)) },
          { node: <button className="btn sm" onClick={() => setSlip(p)}><Ic k="eye" />Payslip</button> },
        ])} />
      {slip && (
        <DetailModal title={`Payslip — ${slip.name} — ${data?.run?.period}`} icon="doc" onClose={() => setSlip(null)} width={520}
          footer={<button className="btn" onClick={print}><Ic k="print" />Print</button>}>
          <div className="kv-grid">
            <div><span className="kl">Employee</span><span className="kvv">{slip.name} ({slip.employee_code})</span></div>
            <div><span className="kl">Designation</span><span className="kvv">{slip.designation ?? '—'}</span></div>
            <div><span className="kl">Paid days</span><span className="kvv">{Number(slip.paid_days)} of {slip.days_in_month}</span></div>
          </div>
          <table className="minitbl" style={{ width: '100%', marginTop: 10 }}>
            <thead><tr><th>Earnings</th><th style={{ textAlign: 'right' }}>₹</th><th>Deductions</th><th style={{ textAlign: 'right' }}>₹</th></tr></thead>
            <tbody>
              <tr><td>Basic</td><td style={{ textAlign: 'right' }}>{fmtINR(Number(slip.earnings?.basic ?? 0))}</td><td>PF</td><td style={{ textAlign: 'right' }}>{fmtINR(Number(slip.deductions?.pf ?? 0))}</td></tr>
              <tr><td>HRA</td><td style={{ textAlign: 'right' }}>{fmtINR(Number(slip.earnings?.hra ?? 0))}</td><td>ESI</td><td style={{ textAlign: 'right' }}>{fmtINR(Number(slip.deductions?.esi ?? 0))}</td></tr>
              <tr><td>Allowances</td><td style={{ textAlign: 'right' }}>{fmtINR(Number(slip.earnings?.allowance ?? 0))}</td><td>Professional tax</td><td style={{ textAlign: 'right' }}>{fmtINR(Number(slip.deductions?.professional_tax ?? 0))}</td></tr>
              <tr><td /><td /><td>TDS</td><td style={{ textAlign: 'right' }}>{fmtINR(Number(slip.deductions?.tds ?? 0))}</td></tr>
            </tbody>
            <tfoot><tr><td><b>Gross</b></td><td style={{ textAlign: 'right' }}><b>{fmtINR(Number(slip.gross_minor))}</b></td><td><b>Net pay</b></td><td style={{ textAlign: 'right' }}><b>{fmtINR(Number(slip.net_minor))}</b></td></tr></tfoot>
          </table>
        </DetailModal>
      )}
    </DetailModal>
  );
}

/* ==================================================================== */
/*  COMMUNICATION INTELLIGENCE — keywords · AI usage · AI settings      */
/* ==================================================================== */

export function KeywordTracking() {
  const { can } = useAuth();
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const [tick, setTick] = useState(0);
  const [focus, setFocus] = useState<string>('');
  const [kw, setKw] = useState('');
  const [cat, setCat] = useState('course');
  const qs = new URLSearchParams(); if (range.from) qs.set('from', range.from); if (range.to) qs.set('to', range.to); if (focus) qs.set('keyword_id', focus);
  const rep = useFetch<any>(`/insights/keyword-report?${qs}`, [qs.toString(), tick]);
  const kws = useFetch<any[]>('/insights/keywords', [tick]);
  const add = async () => {
    try { await api.post('/insights/keywords', { keyword: kw, category: cat }); setKw(''); setTick((t) => t + 1); toast('Keyword tracked'); }
    catch (e) { toast((e as Error).message, true); }
  };
  const toggle = async (k: any) => { try { await api.patch(`/insights/keywords/${k.id}`, { is_active: !k.is_active }); setTick((t) => t + 1); } catch (e) { toast((e as Error).message, true); } };
  const remove = async (k: any) => { try { await api.del(`/insights/keywords/${k.id}`); setTick((t) => t + 1); } catch (e) { toast((e as Error).message, true); } };
  const rows: any[] = rep.data?.rows ?? [];
  const max = Math.max(1, ...rows.map((r) => r.mentions));
  return (
    <>
      <div className="filters"><DateRange value={range} onChange={setRange} idPrefix="kw-dr" /></div>
      {can('ai.run') && (
        <div className="card"><div className="card-pad" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input className="ainp" style={{ flex: 1, minWidth: 180 }} placeholder="Keyword to track — e.g. IELTS, fees, discount, a competitor's name" value={kw} onChange={(e) => setKw(e.target.value)} data-testid="kw-input" />
          <select className="ainp" style={{ width: 150 }} value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="course">Course</option><option value="competitor">Competitor</option><option value="objection">Objection</option><option value="other">Other</option></select>
          <button className="btn primary" disabled={kw.trim().length < 2} onClick={add} data-testid="kw-add"><Ic k="plus" />Track</button>
        </div></div>
      )}
      <HBars title="Mentions by keyword" rows={rows.map((r) => ({ label: `${r.keyword} — ${r.leads} lead(s)`, val: String(r.mentions), pct: Math.round((r.mentions * 100) / max), color: 'var(--indigo)' }))}
        empty="Add keywords to start tracking." />
      <TableCard title="Tracked keywords" icon="intel" cols={['Keyword', 'Category', 'Mentions', 'Leads', 'Calls / AI', 'WhatsApp', 'Notes', 'Last seen', 'Status', 'Actions']}
        empty="No keywords tracked yet."
        rows={(kws.data ?? []).map((k): Cell[] => {
          const r = rows.find((x) => x.id === Number(k.id));
          return [
            { node: <a style={{ cursor: 'pointer', color: 'var(--primary)' }} onClick={() => setFocus(String(k.id))}><b>{k.keyword}</b></a> },
            k.category ?? '—', { mono: String(r?.mentions ?? 0) }, { mono: String(r?.leads ?? 0) }, String(r?.calls ?? 0), String(r?.whatsapp ?? 0), String(r?.notes ?? 0),
            r?.last_at ? dt(r.last_at) : '—', { b: [k.is_active ? 'Active' : 'Paused', k.is_active ? 'b-green' : 'b-gray'] },
            { node: can('ai.run') ? <span style={{ display: 'inline-flex', gap: 4 }}>
              <button className="btn sm" onClick={() => void toggle(k)}>{k.is_active ? 'Pause' : 'Resume'}</button>
              <button className="icon-btn sm" title="Remove" onClick={() => void remove(k)}><Ic k="trash" /></button></span> : '—' },
          ];
        })} />
      {rep.data?.keyword && (
        <TableCard title={`Latest mentions of "${rep.data.keyword.keyword}"`} icon="list" cols={['When', 'Where', 'Lead', 'Text']}
          more={<a style={{ cursor: 'pointer' }} onClick={() => setFocus('')}>close</a>}
          empty="No mentions in this period."
          rows={(rep.data.mentions ?? []).map((m: any): Cell[] => [dt(m.at), m.source, m.full_name ?? '—', String(m.text ?? '')])} />
      )}
    </>
  );
}

export function AiUsage() {
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const qs = new URLSearchParams(); if (range.from) qs.set('from', range.from); if (range.to) qs.set('to', range.to);
  const { data: u } = useFetch<any>(`/insights/ai-usage?${qs}`, [qs.toString()]);
  const bar = (rows: any[], color: string) => {
    const max = Math.max(1, ...(rows ?? []).map((r: any) => Number(r.runs)));
    return (rows ?? []).map((r: any) => ({ label: String(r.label), val: `${r.runs}${Number(r.tokens) ? ` · ${Number(r.tokens).toLocaleString('en-IN')} tokens` : ''}`, pct: Math.round((Number(r.runs) * 100) / max), color }));
  };
  return (
    <>
      <div className="filters"><DateRange value={range} onChange={setRange} idPrefix="aiu-dr" /></div>
      <Kpis items={[
        { lab: 'AI runs', val: String(u?.runs ?? 0), ic: 'intel' },
        { lab: 'This month', val: u?.limit ? `${u?.this_month ?? 0} / ${u.limit}` : String(u?.this_month ?? 0), ic: 'clock' },
        { lab: 'Tokens', val: Number(u?.tokens ?? 0).toLocaleString('en-IN'), ic: 'bolt' },
        { lab: 'AI Bot replies', val: String(u?.ai_bot_replies ?? 0), ic: 'wa' },
      ]} />
      <div className="split2">
        <HBars title="By analysis type" rows={bar(u?.byType, 'var(--indigo)')} empty="No AI runs yet." />
        <HBars title="By provider" rows={bar(u?.byProvider, 'var(--cyan)')} empty="No AI runs yet." />
      </div>
      <div className="split2">
        <HBars title="By user" rows={bar(u?.byUser, 'var(--amber)')} empty="No AI runs yet." />
        <HBars title="By day" rows={bar(u?.byDay, 'var(--green, #15803d)')} empty="No AI runs yet." />
      </div>
    </>
  );
}

export function AiSettings() {
  const { can } = useAuth();
  const { data, reload } = useFetch<any>('/insights/ai-settings');
  const [f, setF] = useState<any>(null);
  useEffect(() => { if (data && !f) setF(data.settings); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => { try { setF(await api.put<any>('/insights/ai-settings', f)); toast('AI settings saved'); reload(); } catch (e) { toast((e as Error).message, true); } };
  if (!f) return <div className="card"><div className="empty-note">Loading…</div></div>;
  return (
    <div className="card">
      <div className="card-head"><h3><Ic k="cfg" />AI provider &amp; cost</h3></div>
      <div className="card-pad">
        <table className="minitbl" style={{ width: '100%', marginBottom: 12 }}>
          <thead><tr><th>Provider</th><th>Key</th></tr></thead>
          <tbody>{(data?.providers ?? []).map((p: any) => (
            <tr key={p.provider}><td>{p.label}</td><td>{p.configured ? <span className="bdg b-green">Key saved</span> : <span className="bdg b-gray">No key — add it in Administration › Settings › Channels › AI</span>}</td></tr>))}</tbody>
        </table>
        <div className="form-grid">
          <div className="fld"><label>Default provider</label>
            <select className="ainp" value={f.default_provider} onChange={(e) => setF({ ...f, default_provider: e.target.value })} data-testid="ais-provider">
              <option value="">Automatic (first with a key)</option><option value="gemini">Google Gemini</option><option value="deepseek">DeepSeek</option></select></div>
          <div className="fld"><label>Monthly AI run limit <span className="fhint">0 = no limit; AI Insights stops at the limit</span></label>
            <input className="ainp" type="number" min={0} value={f.monthly_run_limit} onChange={(e) => setF({ ...f, monthly_run_limit: Number(e.target.value) })} data-testid="ais-limit" /></div>
        </div>
        {can('settings.update') && <button className="btn primary" style={{ marginTop: 10 }} onClick={save} data-testid="ais-save"><Ic k="check" />Save</button>}
      </div>
    </div>
  );
}

/* ==================================================================== */
/*  FORECASTING                                                          */
/* ==================================================================== */

export function Forecasting() {
  const { data } = useFetch<any>('/insights/forecast');
  const t = data?.totals;
  const cash: any[] = data?.cash ?? [];
  const max = Math.max(1, ...cash.map((c) => c.due_minor));
  return (
    <>
      <Kpis items={[
        { lab: 'Open leads', val: String(t?.open_leads ?? 0), ic: 'leads' },
        { lab: 'Expected enrolments', val: String(t?.expected_enrolments ?? 0), ic: 'check' },
        { lab: 'Expected revenue', val: fmtINR(Number(t?.expected_revenue_minor ?? 0)), ic: 'rupee' },
        { lab: 'Overdue installments', val: fmtINR(Number(t?.overdue_minor ?? 0)), ic: 'clock' },
      ]} />
      <TableCard title="Pipeline forecast" icon="analytics"
        cols={['Pipeline', 'Vertical', 'Branch', 'Open leads', 'Won (12m)', 'Closed (12m)', 'Win rate', 'Expected enrolments', 'Avg net fee', 'Expected revenue']}
        empty="No pipelines yet."
        rows={(data?.pipelines ?? []).map((p: any): Cell[] => [
          { node: <b>{p.pipeline}</b> }, p.vertical ?? '—', p.branch ?? '—', { mono: String(p.open_leads) }, String(p.won_12m), String(p.closed_12m),
          `${p.win_rate_pct}%`, { mono: String(p.expected_enrolments) }, { mono: fmtINR(p.avg_fee_minor) }, { mono: fmtINR(p.expected_revenue_minor) },
        ])} />
      <HBars title="Cash forecast — installments falling due (next 6 months)"
        rows={cash.map((c) => ({ label: `${c.month} · ${c.installments} installment(s)`, val: fmtINR(c.due_minor), pct: Math.round((c.due_minor * 100) / max), color: 'var(--green, #15803d)' }))}
        empty="No upcoming installments." />
      <div className="fhint" style={{ marginTop: 6 }}>Expected enrolments = open leads × the pipeline's win rate over the last 12 months (won ÷ won-or-lost). Expected revenue = expected enrolments × the pipeline's average net fee.</div>
    </>
  );
}

/* ==================================================================== */
/*  DUPLICATE RULES                                                      */
/* ==================================================================== */

export function DuplicateRules() {
  const { can } = useAuth();
  const { data, reload } = useFetch<any>('/insights/duplicate-rules');
  const [f, setF] = useState<any>(null);
  const [apply, setApply] = useState(false);
  useEffect(() => { if (data && !f) setF(data.rules); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    try {
      const r = await api.put<any>('/insights/duplicate-rules', { ...f, apply_to_campaigns: apply });
      setF(r.rules); toast(apply ? `Saved and applied to ${r.applied_to_campaigns} campaign(s)` : 'Duplicate rules saved'); reload();
    } catch (e) { toast((e as Error).message, true); }
  };
  if (!f) return <div className="card"><div className="empty-note">Loading…</div></div>;
  return (
    <>
      <Kpis items={[
        { lab: 'Leads checked (30d)', val: String(data?.stats?.checked_30d ?? 0), ic: 'leads' },
        { lab: 'Duplicates caught (30d)', val: String(data?.stats?.duplicates_30d ?? 0), ic: 'flag' },
        { lab: 'Campaigns with own rule', val: String(data?.campaigns_with_own_rule ?? 0), ic: 'bolt' },
      ]} cols={3} />
      <div className="card">
        <div className="card-head"><h3><Ic k="shield" />Duplicate handling</h3></div>
        <div className="card-pad">
          <div className="form-grid">
            <div className="fld span2"><Toggle on label="Detect by phone / WhatsApp number (always on — the primary key)" onChange={() => undefined} /></div>
            <div className="fld span2"><Toggle on={!!f.match_email} onChange={(v) => setF({ ...f, match_email: v })} label="Also detect by email address" testid="dup-email" /></div>
            <div className="fld"><label>Scope of the check</label>
              <select className="ainp" value={f.check_scope} onChange={(e) => setF({ ...f, check_scope: e.target.value })} data-testid="dup-scope">
                <option value="global">Whole organisation</option><option value="this_branch">Same branch</option><option value="this_vertical">Same vertical</option><option value="this_campaign">Same campaign</option></select></div>
            <div className="fld"><label>When a duplicate arrives</label>
              <select className="ainp" value={f.on_duplicate} onChange={(e) => setF({ ...f, on_duplicate: e.target.value })} data-testid="dup-action">
                <option value="merge_and_reopen">Merge into the existing lead; re-open it if lost / closed</option>
                <option value="merge">Merge into the existing lead</option>
                <option value="flag">Create it, flagged as a duplicate</option>
                <option value="ignore">Ignore the new enquiry</option>
                <option value="create">Always create a new lead</option></select></div>
            <div className="fld span2"><Toggle on={!!f.open_reassign_same_user} onChange={(v) => setF({ ...f, open_reassign_same_user: v })} label="If the lead is open, keep it with the same counsellor" /></div>
            <div className="fld span2"><Toggle on={!!f.highlight} onChange={(v) => setF({ ...f, highlight: v })} label="Highlight duplicates on the lead list and card" /></div>
            <div className="fld span2"><Toggle on={apply} onChange={setApply} label="Also apply these settings to every existing campaign (otherwise campaigns keep their own rule)" testid="dup-apply" /></div>
          </div>
          {can('settings.update') && <button className="btn primary" style={{ marginTop: 10 }} onClick={save} data-testid="dup-save"><Ic k="check" />Save rules</button>}
          <div className="fhint" style={{ marginTop: 8 }}>This is the organisation default. A campaign that sets its own duplicate rule (Campaign › Edit) overrides it for that campaign.</div>
        </div>
      </div>
    </>
  );
}

/* ==================================================================== */
/*  COMPLIANCE                                                           */
/* ==================================================================== */

export function Compliance() {
  const { can } = useAuth();
  const { data, reload } = useFetch<any>('/insights/compliance');
  const [f, setF] = useState<any>(null);
  useEffect(() => { if (data && !f) setF(data.settings); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => { try { setF(await api.put<any>('/insights/compliance', f)); toast('Compliance settings saved'); reload(); } catch (e) { toast((e as Error).message, true); } };
  const st = data?.stats;
  if (!f) return <div className="card"><div className="empty-note">Loading…</div></div>;
  return (
    <>
      <Kpis items={[
        { lab: 'Opt-outs (STOP)', val: String(st?.opt_outs ?? 0), ic: 'shield' },
        { lab: 'DLT templates registered', val: String(st?.dlt_templates ?? 0), ic: 'doc' },
        { lab: 'Audit events (30d)', val: String(st?.audit_events_30d ?? 0), ic: 'list' },
        { lab: 'Deleted leads held', val: `${st?.deleted_leads ?? 0}${f.retention_days ? ` · ${st?.past_retention ?? 0} past retention` : ''}`, ic: 'trash' },
      ]} />
      <div className="card">
        <div className="card-head"><h3><Ic k="shield" />DPDP &amp; data policy</h3></div>
        <div className="card-pad">
          <div className="form-grid">
            <div className="fld span2"><label>Consent wording (shown with lead capture)</label>
              <textarea className="ainp" rows={2} value={f.consent_text} onChange={(e) => setF({ ...f, consent_text: e.target.value })} data-testid="cmp-consent" /></div>
            <div className="fld span2"><Toggle on={!!f.require_consent} onChange={(v) => setF({ ...f, require_consent: v })} label="Consent must be recorded before a lead is messaged" /></div>
            <div className="fld"><label>Retention for deleted records (days) <span className="fhint">0 = keep until purged by an admin in Deleted Items</span></label>
              <input className="ainp" type="number" min={0} value={f.retention_days} onChange={(e) => setF({ ...f, retention_days: Number(e.target.value) })} data-testid="cmp-retention" /></div>
            <div className="fld span2"><label>Call-recording notice</label>
              <input className="ainp" value={f.recording_note} onChange={(e) => setF({ ...f, recording_note: e.target.value })} /></div>
          </div>
          {can('settings.update') && <button className="btn primary" style={{ marginTop: 10 }} onClick={save} data-testid="cmp-save"><Ic k="check" />Save</button>}
          <div className="fhint" style={{ marginTop: 8 }}>
            Opt-outs are honoured on every send (a STOP reply on WhatsApp opts the number out automatically). DLT templates live in Engagement › SMS Templates.
            Every user action is in Administration › Audit Logs; deleted records are reviewed and purged in Administration › Deleted Items.
          </div>
        </div>
      </div>
    </>
  );
}
