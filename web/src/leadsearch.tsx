/**
 * SEARCH ANY LEAD — client 11 Nov 2026: "as per role & permission a user can view and work on
 * their own leads, but the user wants to search any lead — this permission should be separate".
 *
 * Gated by `lead.search` (Roles & Permissions › Leads › Search). Finds a lead by name / phone /
 * email across the lead.search scope. A lead inside the user's own scope opens normally; any
 * other lead opens a READ-ONLY summary (owner, stage, last activity) — no edit, no calling.
 */
import { useState } from 'react';
import { api } from './api';
import { Ic } from './icons';
import { toast } from './refdata';

interface Hit {
  id: number; full_name: string; phone?: string | null; email?: string | null; created_at: string;
  owner_name?: string | null; branch_name?: string | null; vertical_name?: string | null;
  stage_name?: string | null; course_name?: string | null; in_scope: boolean;
}

const dt = (v?: string | null) => (v ? new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—');

export function LeadSearchModal({ onClose, onOpen }: { onClose: () => void; onOpen: (id: number) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [peek, setPeek] = useState<any>(null);

  const run = async () => {
    if (q.trim().length < 3) { toast('Type at least 3 characters', true); return; }
    setBusy(true);
    try { setHits(await api.get<Hit[]>(`/leads/search-all?q=${encodeURIComponent(q.trim())}`)); }
    catch (e) { toast((e as Error).message, true); }
    finally { setBusy(false); }
  };
  const view = async (h: Hit) => {
    if (h.in_scope) { onOpen(Number(h.id)); onClose(); return; }
    try { setPeek(await api.get<any>(`/leads/${h.id}/peek`)); }
    catch (e) { toast((e as Error).message, true); }
  };

  return (
    <div className="add-scrim" style={{ zIndex: 300 }}>
      <div className="add-modal" style={{ maxWidth: 860 }} data-testid="lead-search-modal">
        <div className="ah">
          <h3><Ic k="search" />Search all leads</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          {!peek ? (
            <>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="ainp" autoFocus placeholder="Name, phone or email" value={q} data-testid="lead-search-input"
                  onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void run(); }} />
                <button className="btn primary" disabled={busy} onClick={() => void run()} data-testid="lead-search-go"><Ic k="search" />{busy ? 'Searching…' : 'Search'}</button>
              </div>
              <div className="fhint" style={{ marginTop: 6 }}>Finds leads that belong to anyone. Leads that are not yours open read-only.</div>
              {hits && (
                hits.length === 0 ? <div className="empty-note" style={{ marginTop: 12 }}>No lead matches “{q}”.</div> : (
                  <div className="scroll-x" style={{ marginTop: 12 }}>
                    <table className="tbl" data-testid="lead-search-results">
                      <thead><tr><th>Lead</th><th>Phone</th><th>Owner</th><th>Stage</th><th>Branch · Vertical</th><th>Created</th><th /></tr></thead>
                      <tbody>
                        {hits.map((h) => (
                          <tr key={h.id}>
                            <td><b>{h.full_name}</b>{h.course_name ? <div className="sub">{h.course_name}</div> : null}</td>
                            <td className="mono">{h.phone ?? '—'}</td>
                            <td>{h.owner_name ?? 'Unassigned'}</td>
                            <td>{h.stage_name ?? '—'}</td>
                            <td>{[h.branch_name, h.vertical_name].filter(Boolean).join(' · ')}</td>
                            <td className="mono">{dt(h.created_at)}</td>
                            <td><button className="btn sm" onClick={() => void view(h)} data-testid={`lead-search-open-${h.id}`}>
                              <Ic k="eye" />{h.in_scope ? 'Open' : 'View'}</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
            </>
          ) : (
            <div data-testid="lead-peek">
              <div className="notice" style={{ marginBottom: 10 }}><Ic k="eye" /><div>Read-only — this lead belongs to <b>{peek.owner_name ?? 'nobody yet'}</b>. Ask them or your manager to transfer it if you need to work on it.</div></div>
              <table className="tbl"><tbody>
                {[
                  ['Name', peek.full_name], ['Phone', peek.phone], ['Email', peek.email],
                  ['Owner', peek.owner_name ?? 'Unassigned'], ['Stage', peek.stage_name], ['Status', peek.status_name],
                  ['Course', peek.course_name ?? peek.course_text], ['Branch › Vertical › Pipeline', [peek.branch_name, peek.vertical_name, peek.pipeline_name].filter(Boolean).join(' › ')],
                  ['Campaign · Source', [peek.campaign_name, peek.source_name].filter(Boolean).join(' · ')],
                  ['Created', dt(peek.created_at)], ['Next follow-up', dt(peek.next_followup_at)],
                ].map(([k, v]) => <tr key={String(k)}><td style={{ width: 200, color: 'var(--muted)' }}>{k}</td><td>{v || '—'}</td></tr>)}
              </tbody></table>
              {peek.activity?.length ? (
                <>
                  <h4 style={{ margin: '14px 0 6px' }}>Recent activity</h4>
                  {peek.activity.map((a: any, i: number) => (
                    <div key={i} className="sub" style={{ padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
                      <b>{a.type.replace(/_/g, ' ')}</b> · {dt(a.created_at)}{a.actor_name ? ` · ${a.actor_name}` : ''}{a.note ? <div>{String(a.note).slice(0, 200)}</div> : null}
                    </div>
                  ))}
                </>
              ) : null}
            </div>
          )}
        </div>
        <div className="af">
          {peek ? <button className="btn" onClick={() => setPeek(null)}><Ic k="search" />Back to results</button> : null}
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
