/**
 * SUPPORT & TICKETS — Help & Support › Support Tickets (INTERNAL staff tickets).
 *
 * Replaces the design-only shell with a real, working module: a filterable list, an
 * Add Ticket form (SPEC_FORMS['help.tickets'] + its wired SAVER, covered by the qa10
 * matrix), a detail view with the comment thread + status/assignee controls + add-comment
 * box, and row actions (open · edit · delete). Follows the existing design system —
 * card / add-modal / kpi-strip / filters — no new visual language.
 *
 * Every action is wired to a real endpoint; there is no "later sprint" placeholder.
 */
import { useMemo, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, Kpis, TableCard } from './renderer';
import { toast, useFetch, useRef_, selectableUsers } from './refdata';
import { AddModal, EditSpec, need } from './forms';

const PRIORITY_ORDER = ['low', 'medium', 'high', 'urgent'] as const;
const STATUS_LABEL: Record<string, string> = {
  open: 'Open', in_progress: 'In Progress', resolved: 'Resolved', closed: 'Closed',
};
// Lifecycle (mirror of the server's TRANSITIONS map; the API is the authority and rejects
// anything illegal with a 400, so this only decides which BUTTONS to offer).
const TRANSITIONS: Record<string, string[]> = {
  open: ['in_progress', 'resolved'],
  in_progress: ['open', 'resolved'],
  resolved: ['in_progress', 'closed'],
  closed: ['in_progress'],
};

const statusBadge = (s: string): Cell => {
  const map: Record<string, string> = {
    open: 'b-indigo', in_progress: 'b-amber', resolved: 'b-green', closed: 'b-gray',
  };
  return { b: [STATUS_LABEL[s] ?? s, map[s] ?? 'b-gray'] };
};
const priorityBadge = (p: string): Cell => {
  const map: Record<string, [string, string]> = {
    low: ['Low', 'b-gray'], medium: ['Medium', 'b-indigo'], high: ['High', 'b-amber'], urgent: ['Urgent', 'b-rose'],
  };
  const [l, c] = map[p] ?? [p, 'b-gray'];
  return { b: [l, c] };
};
const dt = (v: unknown) => (v ? new Date(String(v)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const dtt = (v: unknown) => (v ? new Date(String(v)).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

/** SLA cell — an overdue open ticket is flagged in red; a closed/resolved one is settled. */
const slaCell = (t: any): Cell => {
  if (t.status === 'resolved' || t.status === 'closed') return { b: ['Met', 'b-green'] };
  if (t.overdue) return { b: ['Overdue', 'b-rose'] };
  if (t.first_response_breached) return { b: ['Response due', 'b-amber'] };
  return { mono: dt(t.resolution_due_at) };
};

/* ---------------------------------------------------------------- edit spec */

const num = (v: unknown) => (v == null || v === '' ? undefined : Number(v));

export const ticketEditSpec = (t: any, after: () => void): EditSpec => ({
  title: `Edit Ticket — ${t.ticket_no}`,
  initialVals: {
    'Subject': t.subject ?? '',
    'Category': t.category ?? '',
    'Priority': '',  // set by withPriority() below (the select needs the capitalised label)
    'Description': t.description ?? '',
    'Branch': t.branch_name ?? '',
    'Vertical': t.vertical_name ?? '',
    'Assignee': t.assignee_name ?? '',
  },
  initialIds: {
    'Branch': num(t.branch_id), 'Vertical': num(t.vertical_id), 'Assignee': num(t.assignee_id),
  },
  // Branch/Vertical set the ticket's RBAC scope at creation; keep them stable on edit so a
  // ticket cannot be quietly moved out of the reporter's sight. Reassignment + priority +
  // category + subject + description remain editable.
  lock: ['Branch', 'Vertical'],
  submit: async (vals, ids) => {
    await api.patch(`/support-tickets/${t.id}`, {
      subject: need(vals['Subject'], 'A subject is required'),
      category: vals['Category'] || null,
      priority: (vals['Priority'] || 'medium').toLowerCase(),
      description: vals['Description'] || null,
      assignee_id: ids['Assignee'] ?? null,
    });
    after();
    return 'Ticket updated';
  },
});
// the Priority initial value must be the capitalised option label so the select prefills
const withPriority = (spec: EditSpec, priority: string): EditSpec => ({
  ...spec,
  initialVals: { ...spec.initialVals, 'Priority': priority ? priority[0].toUpperCase() + priority.slice(1) : 'Medium' },
});

/* ------------------------------------------------------------------- detail */

function TicketDetail({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const { data, reload } = useFetch<any>(`/support-tickets/${id}`);
  const { can } = useAuth();
  const ref = useRef_();
  const [comment, setComment] = useState('');
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reassign, setReassign] = useState<string>('');
  const t = data;

  const users = useMemo(() => selectableUsers(ref.users, t?.assignee_id), [ref.users, t?.assignee_id]);
  if (!t) return null;

  const move = async (to: string) => {
    setBusy(true);
    try {
      await api.post(`/support-tickets/${id}/transition`, { status: to });
      toast(to === 'in_progress' && (t.status === 'resolved' || t.status === 'closed') ? 'Ticket reopened' : `Marked ${STATUS_LABEL[to]}`);
      reload(); onChanged();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };

  const doReassign = async () => {
    setBusy(true);
    try {
      await api.patch(`/support-tickets/${id}`, { assignee_id: reassign ? Number(reassign) : null });
      toast('Reassigned'); setReassign(''); reload(); onChanged();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };

  const addComment = async () => {
    if (!comment.trim()) { toast('A comment cannot be empty', true); return; }
    setBusy(true);
    try {
      await api.post(`/support-tickets/${id}/comments`, { body: comment.trim(), is_internal: internal });
      setComment(''); setInternal(false); toast('Comment added'); reload(); onChanged();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 820 }}>
        <div className="ah">
          <h3><Ic k="help" />{t.ticket_no} · {t.subject}</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          <div className="kpi-strip" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
            {([['Status', statusBadge(t.status)], ['Priority', priorityBadge(t.priority)],
               ['SLA', slaCell(t)], ['Category', t.category ?? '—']] as Array<[string, Cell | string]>)
              .map(([lab, val]) => (
                <div className="card kpi" key={lab}>
                  <div className="lab">{lab}</div>
                  <div className="val" style={{ fontSize: 14 }}>
                    {typeof val === 'object' && val && 'b' in (val as any)
                      ? <span className={`bdg ${(val as any).b[1]}`}>{(val as any).b[0]}</span>
                      : typeof val === 'object' && val && 'mono' in (val as any)
                        ? <span className="mono">{(val as any).mono}</span>
                        : String(val)}
                  </div>
                </div>
              ))}
          </div>

          <div className="card" style={{ marginTop: 12 }}><div className="card-pad">
            <div className="sub" style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
              <span>Reporter: <b>{t.reporter_name ?? '—'}</b></span>
              <span>Assignee: <b>{t.assignee_name ?? 'Unassigned'}</b></span>
              <span>Branch: <b>{t.branch_name ?? '—'}</b></span>
              <span>Vertical: <b>{t.vertical_name ?? '—'}</b></span>
              <span>Raised: <b>{dtt(t.created_at)}</b></span>
              {t.resolved_at ? <span>Resolved: <b>{dtt(t.resolved_at)}</b></span> : null}
              {t.closed_at ? <span>Closed: <b>{dtt(t.closed_at)}</b></span> : null}
            </div>
            {t.description ? <div style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>{t.description}</div> : null}
          </div></div>

          {/* lifecycle + reassign controls */}
          {can('ticket.update') && (
            <div className="card" style={{ marginTop: 12 }}><div className="card-pad">
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                {(TRANSITIONS[t.status] ?? []).map((to) => {
                  const reopen = (t.status === 'resolved' || t.status === 'closed') && to === 'in_progress';
                  return (
                    <button key={to} className="btn" disabled={busy} onClick={() => move(to)}>
                      <Ic k={to === 'resolved' || to === 'closed' ? 'check' : 'refresh'} />
                      {reopen ? 'Reopen' : `Mark ${STATUS_LABEL[to]}`}
                    </button>
                  );
                })}
                <span style={{ flex: 1 }} />
                <select className="ainp" style={{ width: 180 }} value={reassign} onChange={(e) => setReassign(e.target.value)}>
                  <option value="">Reassign to…</option>
                  <option value="">Unassign</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
                <button className="btn" disabled={busy} onClick={doReassign}><Ic k="users" />Reassign</button>
              </div>
            </div></div>
          )}

          {/* comment thread */}
          <div className="card" style={{ marginTop: 12 }}><div className="card-pad">
            <div className="sub" style={{ fontWeight: 700, marginBottom: 8 }}>Conversation</div>
            {(t.comments ?? []).length === 0 ? <div className="sub">No comments yet.</div> : null}
            {(t.comments ?? []).map((c: any) => (
              <div key={c.id} style={{ borderTop: '1px solid var(--line)', padding: '8px 0' }}>
                <div className="sub" style={{ display: 'flex', gap: 8 }}>
                  <b>{c.author_name ?? 'System'}</b>
                  <span>{dtt(c.created_at)}</span>
                  {c.is_internal ? <span className="bdg b-amber">Internal note</span> : null}
                </div>
                <div style={{ whiteSpace: 'pre-wrap', marginTop: 2 }}>{c.body}</div>
              </div>
            ))}
            {can('ticket.comment') && (
              <div style={{ marginTop: 10 }}>
                <textarea className="ainp" rows={3} placeholder="Add a comment or reply…"
                  value={comment} onChange={(e) => setComment(e.target.value)} />
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8 }}>
                  <label className="sub" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
                    Internal note (staff only)
                  </label>
                  <span style={{ flex: 1 }} />
                  <button className="btn primary" disabled={busy} onClick={addComment}><Ic k="send" />Add comment</button>
                </div>
              </div>
            )}
          </div></div>
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------- list */

export function SupportTickets() {
  const { can } = useAuth();
  const ref = useRef_();
  const [f, setF] = useState<Record<string, string>>({ status: '', priority: '', category: '', assignee_id: '', q: '', overdue: '' });
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
    return p.toString();
  }, [f]);
  const { data, reload } = useFetch<any[]>(`/support-tickets${qs ? `?${qs}` : ''}`, [qs]);
  const summary = useFetch<any>('/support-tickets/summary');
  const [add, setAdd] = useState(false);
  const [detail, setDetail] = useState<number | null>(null);
  const [edit, setEdit] = useState<any>(null);
  const rows = data ?? [];
  const s = summary.data;

  const bump = () => { reload(); summary.reload(); };
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));

  const del = async (t: any) => {
    if (!window.confirm(`Delete ticket ${t.ticket_no}? It moves to Deleted Items and can be restored.`)) return;
    try { await api.del(`/support-tickets/${t.id}`); toast('Ticket deleted'); bump(); }
    catch (e) { toast((e as Error).message, true); }
  };

  return (
    <>
      {can('ticket.create') && (
        <div className="page-actions">
          <button className="btn primary" onClick={() => setAdd(true)}><Ic k="plus" />Raise a ticket</button>
        </div>
      )}
      <Kpis cols={5} items={[
        { lab: 'Open', val: String(s?.open ?? 0), ic: 'help' },
        { lab: 'In progress', val: String(s?.in_progress ?? 0), ic: 'clock' },
        { lab: 'Resolved', val: String(s?.resolved ?? 0), ic: 'check' },
        { lab: 'Closed', val: String(s?.closed ?? 0), ic: 'check' },
        { lab: 'Overdue (SLA)', val: String(s?.overdue ?? 0), ic: 'bolt' },
      ]} />

      <div className="filters" style={{ margin: '12px 0', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <input className="ainp" style={{ width: 200 }} placeholder="Search subject / #…"
          value={f.q} onChange={(e) => set('q', e.target.value)} />
        <select className="ainp" value={f.status} onChange={(e) => set('status', e.target.value)}>
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select className="ainp" value={f.priority} onChange={(e) => set('priority', e.target.value)}>
          <option value="">All priorities</option>
          {PRIORITY_ORDER.map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
        </select>
        <select className="ainp" value={f.category} onChange={(e) => set('category', e.target.value)}>
          <option value="">All categories</option>
          {ref.ticketCategories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
        </select>
        <select className="ainp" value={f.assignee_id} onChange={(e) => set('assignee_id', e.target.value)}>
          <option value="">Any assignee</option>
          {ref.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <button className={`fchip${f.overdue === '1' ? ' on' : ''}`} onClick={() => set('overdue', f.overdue === '1' ? '' : '1')}>
          Overdue only
        </button>
      </div>

      <TableCard
        listKey="supportTickets"
        title="Support tickets" icon="help"
        cols={['Ticket #', 'Subject', 'Category', 'Priority', 'Status', 'Assignee', 'Created', 'SLA', '']}
        empty="No tickets match — raise one with “Raise a ticket”."
        onRowClick={(i) => setDetail(rows[i].id)}
        rows={rows.map((t): Cell[] => [
          { mono: t.ticket_no },
          { node: <div><b>{t.subject}</b>{Number(t.comment_count) ? <div className="sub">{t.comment_count} comment{Number(t.comment_count) > 1 ? 's' : ''}</div> : null}</div> },
          t.category ?? '—',
          priorityBadge(t.priority),
          statusBadge(t.status),
          t.assignee_name ?? 'Unassigned',
          dt(t.created_at),
          slaCell(t),
          {
            node: (
              <div className="rowacts" onClick={(e) => e.stopPropagation()}>
                <button className="icon-btn sm" title="Open" onClick={() => setDetail(t.id)}><Ic k="eye" /></button>
                {can('ticket.update') && <button className="icon-btn sm" title="Edit" onClick={() => setEdit(t)}><Ic k="pencil" /></button>}
                {can('ticket.delete') && <button className="icon-btn sm" title="Delete" onClick={() => del(t)}><Ic k="trash" /></button>}
              </div>
            ),
          },
        ])}
      />

      {add && <AddModal formKey="help.tickets" onClose={() => setAdd(false)} onSaved={bump} />}
      {edit && (
        <AddModal formKey="help.tickets" edit={withPriority(ticketEditSpec(edit, bump), edit.priority)}
          onClose={() => setEdit(null)} onSaved={bump} />
      )}
      {detail != null && <TicketDetail id={detail} onClose={() => setDetail(null)} onChanged={bump} />}
    </>
  );
}
