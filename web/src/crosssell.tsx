/**
 * CROSS-SELL — CRM › Cross-Sell (CRM-level, on the leads/enrolments that exist today).
 *
 * Replaces the Phase-2 shell with a real, working module:
 *   · Candidates — converted contacts (won/enrolled) paired with a suggested course they
 *     don't already hold. Suggestion basis is a rule (admin map) or the same vertical.
 *   · Act on a suggestion — create a cross-sell follow-up, create a NEW lead through the
 *     ingestion pipeline (dedup/distribution/audit), or dismiss it. Each act logs a
 *     cross_sell attempt so the pair is never suggested again.
 *   · Rules (crosssell.manage) — the admin "current course -> suggested course" map.
 *   · Attempts — the log of everything acted on, RBAC-scoped.
 *
 * Follows the existing design system — kpi strip / filters / TableCard / add-modal — no
 * new visual language. Every action is wired to a real endpoint.
 */
import { useMemo, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, Kpis, TableCard } from './renderer';
import { toast, useFetch, useRef_ } from './refdata';
import { AddModal } from './forms';

const dt = (v: unknown) => (v ? new Date(String(v)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const basisBadge = (b: string): Cell =>
  b === 'rule' ? { b: ['Rule', 'b-indigo'] } : { b: ['Same vertical', 'b-gray'] };
const actionBadge = (a: string): Cell => {
  const map: Record<string, [string, string]> = {
    followup: ['Follow-up', 'b-amber'], lead: ['New lead', 'b-green'], dismissed: ['Dismissed', 'b-gray'],
  };
  const [l, c] = map[a] ?? [a, 'b-gray'];
  return { b: [l, c] };
};

/* ------------------------------------------------------------------ act modal */

function ActModal({ row, onClose, onDone }: { row: any; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [when, setWhen] = useState('');
  const [note, setNote] = useState('');

  const act = async (action: 'followup' | 'lead' | 'dismissed') => {
    setBusy(true);
    try {
      const body: any = { lead_id: row.lead_id, suggested_course_id: row.suggested_course_id, action };
      if (action === 'followup' && when) body.scheduled_at = when;
      if (note.trim()) body.note = note.trim();
      const r = await api.post<any>('/cross-sell/act', body);
      toast(action === 'lead'
        ? (r?.new_lead_id ? `New lead #${r.new_lead_id} created (${r.outcome})` : 'Cross-sell lead processed')
        : action === 'followup' ? 'Cross-sell follow-up created' : 'Suggestion dismissed');
      onDone(); onClose();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 560 }}>
        <div className="ah">
          <h3><Ic k="bolt" />Act on suggestion</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          <div className="card"><div className="card-pad">
            <div className="sub" style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
              <span>Contact: <b>{row.full_name}</b></span>
              <span>Current: <b>{row.current_course_name ?? '—'}</b></span>
              <span>Suggest: <b>{row.suggested_course_name}</b></span>
              <span>Owner: <b>{row.owner_name ?? 'Unassigned'}</b></span>
            </div>
          </div></div>

          <div style={{ marginTop: 12 }}>
            <label className="sub" style={{ fontWeight: 700 }}>Follow-up date (optional — defaults to tomorrow)</label>
            <input className="ainp" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          </div>
          <div style={{ marginTop: 10 }}>
            <label className="sub" style={{ fontWeight: 700 }}>Note (optional)</label>
            <textarea className="ainp" rows={2} placeholder="e.g. keen on visa prep after IELTS"
              value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
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

/* -------------------------------------------------------------------- rules */

function RulesTab({ courses }: { courses: Array<{ id: number; name: string }> }) {
  const { can } = useAuth();
  const { data, reload } = useFetch<any[]>('/cross-sell/rules');
  const [add, setAdd] = useState(false);
  const rows = data ?? [];

  const toggle = async (r: any) => {
    try { await api.patch(`/cross-sell/rules/${r.id}`, { is_active: !r.is_active }); toast('Rule updated'); reload(); }
    catch (e) { toast((e as Error).message, true); }
  };
  const del = async (r: any) => {
    if (!window.confirm(`Delete this cross-sell rule (${r.source_course_name} → ${r.target_course_name})?`)) return;
    try { await api.del(`/cross-sell/rules/${r.id}`); toast('Rule deleted'); reload(); }
    catch (e) { toast((e as Error).message, true); }
  };

  return (
    <>
      {can('crosssell.manage') && (
        <div className="page-actions"><button className="btn primary" onClick={() => setAdd(true)}><Ic k="plus" />New rule</button></div>
      )}
      <div className="sub" style={{ margin: '4px 0 12px' }}>
        When a contact holds the <b>current</b> course, suggest the <b>mapped</b> course(s). Contacts with no matching
        rule fall back to other active courses in their vertical.
      </div>
      <TableCard
        listKey="crossSellRules"
        title="Cross-sell rules" icon="bolt"
        cols={['Current course', '', 'Suggested course', 'Status', 'Note', '']}
        empty="No rules yet — add one, or suggestions fall back to same-vertical courses."
        rows={rows.map((r): Cell[] => [
          r.source_course_name ?? '—',
          { node: <span aria-hidden="true">&rarr;</span> },
          r.target_course_name ?? '—',
          r.is_active ? { b: ['Active', 'b-green'] } : { b: ['Off', 'b-gray'] },
          r.note ?? '—',
          {
            node: (
              <div className="rowacts" onClick={(e) => e.stopPropagation()}>
                {can('crosssell.manage') && <button className="icon-btn sm" title={r.is_active ? 'Deactivate' : 'Activate'} onClick={() => toggle(r)}><Ic k="refresh" /></button>}
                {can('crosssell.manage') && <button className="icon-btn sm" title="Delete" onClick={() => del(r)}><Ic k="trash" /></button>}
              </div>
            ),
          },
        ])}
      />
      {add && <AddModal formKey="crosssell.rules" onClose={() => setAdd(false)} onSaved={reload} />}
    </>
  );
}

/* ----------------------------------------------------------------- attempts */

function AttemptsTab() {
  const ref = useRef_();
  const [f, setF] = useState<Record<string, string>>({ action: '', branch_id: '', vertical_id: '', owner_id: '' });
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
    return p.toString();
  }, [f]);
  const { data } = useFetch<any[]>('/cross-sell/attempts' + (qs ? `?${qs}` : ''), [qs]);
  const rows = data ?? [];
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));

  return (
    <>
      <div className="filters" style={{ margin: '12px 0', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <select className="ainp" value={f.action} onChange={(e) => set('action', e.target.value)}>
          <option value="">All actions</option>
          <option value="followup">Follow-up</option>
          <option value="lead">New lead</option>
          <option value="dismissed">Dismissed</option>
        </select>
        <select className="ainp" value={f.branch_id} onChange={(e) => set('branch_id', e.target.value)}>
          <option value="">All branches</option>
          {ref.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <select className="ainp" value={f.vertical_id} onChange={(e) => set('vertical_id', e.target.value)}>
          <option value="">All verticals</option>
          {ref.verticals.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        <select className="ainp" value={f.owner_id} onChange={(e) => set('owner_id', e.target.value)}>
          <option value="">Any owner</option>
          {ref.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </div>
      <TableCard
        title="Cross-sell attempts" icon="list"
        cols={['Contact', 'From', 'Suggested', 'Action', 'Owner', 'Branch', 'When', 'Note']}
        empty="No cross-sell attempts yet."
        rows={rows.map((a): Cell[] => [
          { node: <div><b>{a.full_name}</b><div className="sub mono">{a.phone}</div></div> },
          a.from_course_name ?? '—',
          a.suggested_course_name ?? '—',
          actionBadge(a.action),
          a.owner_name ?? 'Unassigned',
          a.branch_name ?? '—',
          dt(a.created_at),
          a.note ?? '—',
        ])}
      />
    </>
  );
}

/* --------------------------------------------------------------------- main */

export function CrossSell() {
  const { can } = useAuth();
  const ref = useRef_();
  const meta = useFetch<any>('/cross-sell/meta');
  const courses: Array<{ id: number; name: string }> = meta.data?.courses ?? [];
  const [tab, setTab] = useState<'candidates' | 'attempts' | 'rules'>('candidates');

  const [f, setF] = useState<Record<string, string>>({ branch_id: '', vertical_id: '', owner_id: '', course_id: '' });
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
    return p.toString();
  }, [f]);
  const { data, reload } = useFetch<any[]>('/cross-sell/candidates' + (qs ? `?${qs}` : ''), [qs]);
  const summary = useFetch<any>('/cross-sell/summary');
  const [actRow, setActRow] = useState<any>(null);
  const rows = data ?? [];
  const s = summary.data;
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  const bump = () => { reload(); summary.reload(); };

  const tabs: Array<[string, string]> = [['candidates', 'Candidates'], ['attempts', 'Attempts']];
  if (can('crosssell.manage')) tabs.push(['rules', 'Rules']);

  return (
    <>
      <div className="tabs" style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {tabs.map(([k, l]) => (
          <button key={k} className={`fchip${tab === k ? ' on' : ''}`} onClick={() => setTab(k as any)}>{l}</button>
        ))}
      </div>

      {tab === 'candidates' && (
        <>
          <Kpis cols={5} items={[
            { lab: 'Open suggestions', val: String(s?.suggestions ?? 0), ic: 'bolt' },
            { lab: 'Contacts', val: String(s?.contacts ?? 0), ic: 'users' },
            { lab: 'Follow-ups made', val: String(s?.followups ?? 0), ic: 'clock' },
            { lab: 'Leads created', val: String(s?.leads ?? 0), ic: 'plus' },
            { lab: 'Dismissed', val: String(s?.dismissed ?? 0), ic: 'x' },
          ]} />

          <div className="filters" style={{ margin: '12px 0', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <select className="ainp" value={f.branch_id} onChange={(e) => set('branch_id', e.target.value)}>
              <option value="">All branches</option>
              {ref.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <select className="ainp" value={f.vertical_id} onChange={(e) => set('vertical_id', e.target.value)}>
              <option value="">All verticals</option>
              {ref.verticals.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
            <select className="ainp" value={f.owner_id} onChange={(e) => set('owner_id', e.target.value)}>
              <option value="">Any owner</option>
              {ref.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <select className="ainp" value={f.course_id} onChange={(e) => set('course_id', e.target.value)}>
              <option value="">Any current course</option>
              {courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>

          <TableCard
            title="Cross-sell candidates" icon="bolt"
            cols={['Contact', 'Current course', 'Suggested course', 'Basis', 'Branch', 'Vertical', 'Owner', '']}
            empty="No cross-sell candidates match — won/enrolled contacts appear here with a suggested next course."
            rows={rows.map((r): Cell[] => [
              { node: <div><b>{r.full_name}</b><div className="sub mono">{r.phone}</div></div> },
              r.current_course_name ?? '—',
              { node: <b>{r.suggested_course_name}</b> },
              basisBadge(r.basis),
              r.branch_name ?? '—',
              r.vertical_name ?? '—',
              r.owner_name ?? 'Unassigned',
              {
                node: (
                  <div className="rowacts" onClick={(e) => e.stopPropagation()}>
                    {can('crosssell.act')
                      ? <button className="btn sm" title="Act on suggestion" onClick={() => setActRow(r)}><Ic k="bolt" />Act</button>
                      : <span className="sub">—</span>}
                  </div>
                ),
              },
            ])}
          />
        </>
      )}

      {tab === 'attempts' && <AttemptsTab />}
      {tab === 'rules' && can('crosssell.manage') && <RulesTab courses={courses} />}

      {actRow && <ActModal row={actRow} onClose={() => setActRow(null)} onDone={bump} />}
    </>
  );
}
