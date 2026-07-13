/**
 * DUPLICATE / MERGE UI (NeoDove §4).
 *
 *  - <DuplicatePanel>  : lives inside the lead sheet. Shows "this lead is a
 *                        duplicate of #X", "N duplicates of this lead", and the
 *                        merge history — each with a "View diff" link.
 *  - <MergeModal>      : the merge itself. Fetches GET /leads/:id/merge-preview
 *                        so the user sees EXACTLY what will change before they
 *                        commit — which blanks get filled, and which conflicting
 *                        values are kept (existing wins; the incoming value is
 *                        recorded on the timeline, never dropped).
 *  - <DiffView>        : the same diff, rendered read-only for a past merge.
 *
 * RBAC: the panel needs lead.read; the Merge buttons only appear with
 * lead.merge, and the server re-checks BOTH leads against the caller's record
 * scope (an out-of-scope lead 404s).
 */
import { useEffect, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { toast } from './refdata';

export interface MergeDiff {
  filled: Record<string, unknown>;
  conflicts: Record<string, { kept: unknown; incoming: unknown }>;
  custom_filled: Record<string, unknown>;
  custom_conflicts: Record<string, { kept: unknown; incoming: unknown }>;
  tags_added: number[];
  note?: string | null;
}
export interface DupLead {
  id: number; full_name: string; phone: string; email: string | null;
  owner_name: string | null; stage_name: string | null; stage_type: string | null;
  campaign_name: string | null; source_name: string | null;
  created_at: string; deleted_at: string | null; merged_into_id: number | null;
}
export interface MergeRecord {
  id: number; action: string; reopened: boolean; channel: string;
  diff: MergeDiff; created_at: string; source_lead_id: number | null; actor_name: string | null;
}
export interface DuplicatesReport {
  lead_id: number; is_duplicate: boolean; merged_into_id: number | null;
  duplicate_of: DupLead | null;
  duplicates: DupLead[];
  merged: DupLead[];
  merges: MergeRecord[];
  counts: { open: number; merged: number };
}

export const FIELD_LABEL: Record<string, string> = {
  full_name: 'Name', email: 'Email', alt_phone: 'Alternate phone', state_id: 'State', city_id: 'City',
  course_id: 'Course', qualification_id: 'Qualification', budget_id: 'Budget', temperature: 'Temperature',
  priority: 'Priority', score: 'Score', next_follow_up_at: 'Next follow-up',
};
const label = (k: string) => FIELD_LABEL[k] ?? k;
const show = (v: unknown) => (v == null || v === '' ? '—' : String(v));
const fmtDT = (s?: string | null) => (s ? new Date(s).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

const ACTION_LABEL: Record<string, string> = {
  merge: 'Merged', merge_and_reopen: 'Merged & re-opened',
};

/** The merge diff, rendered. Used both as a preview and as history. */
export function DiffView({ diff }: { diff: MergeDiff }) {
  const filled = { ...diff.filled, ...diff.custom_filled };
  const conflicts = { ...diff.conflicts, ...diff.custom_conflicts };
  const nothing = !Object.keys(filled).length && !Object.keys(conflicts).length
    && !diff.tags_added?.length && !diff.note;

  if (nothing) {
    return <div className="empty-note" data-testid="diff-empty">No new information — the duplicate adds nothing this lead does not already have.</div>;
  }
  return (
    <div style={{ display: 'grid', gap: 10 }} data-testid="merge-diff">
      {!!Object.keys(filled).length && (
        <div>
          <div className="sub" style={{ fontSize: 11.5, marginBottom: 4 }}>
            Empty fields that will be filled from the duplicate
          </div>
          <div style={{ display: 'grid', gap: 4 }}>
            {Object.entries(filled).map(([k, v]) => (
              <div key={k} data-testid={`filled-${k}`} style={{
                display: 'flex', gap: 8, alignItems: 'baseline', padding: '6px 10px',
                borderRadius: 8, background: 'var(--success-soft)', fontSize: 12.5,
              }}>
                <span className="bdg b-green">Filled</span>
                <b>{label(k)}</b>
                <span>→ {show(v)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {!!Object.keys(conflicts).length && (
        <div>
          <div className="sub" style={{ fontSize: 11.5, marginBottom: 4 }}>
            Conflicts — the existing value is <b>kept</b>; the incoming value is recorded on the timeline, never lost
          </div>
          <div style={{ display: 'grid', gap: 4 }}>
            {Object.entries(conflicts).map(([k, c]) => (
              <div key={k} data-testid={`conflict-${k}`} style={{
                display: 'flex', gap: 8, alignItems: 'baseline', padding: '6px 10px',
                borderRadius: 8, background: 'var(--amber-soft)', fontSize: 12.5, flexWrap: 'wrap',
              }}>
                <span className="bdg b-amber">Kept</span>
                <b>{label(k)}</b>
                <span>{show(c.kept)}</span>
                <span className="sub" style={{ fontSize: 11.5 }}>
                  (incoming <span className="mono">{show(c.incoming)}</span> recorded, not applied)
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {!!diff.tags_added?.length && (
        <div className="sub" style={{ fontSize: 12 }} data-testid="tags-added">
          {diff.tags_added.length} tag(s) added — tags are appended, never replaced.
        </div>
      )}
      {diff.note && (
        <div className="sub" style={{ fontSize: 12 }} data-testid="note-added">Note appended: “{diff.note}”</div>
      )}
    </div>
  );
}

/** Side-by-side identity of the two leads. */
function LeadCard({ lead, tag }: { lead: DupLead; tag: string }) {
  return (
    <div style={{ flex: 1, minWidth: 0, padding: '9px 11px', borderRadius: 8, background: 'var(--surface-3)' }}>
      <div className="sub" style={{ fontSize: 11 }}>{tag}</div>
      <div style={{ fontWeight: 700, fontSize: 13 }}>{lead.full_name} <span className="sub">#{lead.id}</span></div>
      <div className="mono" style={{ fontSize: 12 }}>{lead.phone}</div>
      <div className="sub" style={{ fontSize: 11.5 }}>
        {lead.email || 'no email'} · {lead.stage_name || '—'} · {lead.owner_name || 'Unassigned'}
      </div>
      <div className="sub" style={{ fontSize: 11 }}>{lead.campaign_name} · {lead.source_name}</div>
    </div>
  );
}

/**
 * Merge `sourceId` INTO `targetId`. The target survives and keeps its owner;
 * the source becomes a soft-deleted tombstone that points at the survivor, and
 * its timeline + open follow-ups move across.
 */
export function MergeModal({ targetId, sourceId, onClose, onMerged }: {
  targetId: number; sourceId: number; onClose: () => void; onMerged: () => void;
}) {
  const [p, setP] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reopen, setReopen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<any>(`/leads/${targetId}/merge-preview?from=${sourceId}`)
      .then((r) => { setP(r); setReopen(!!r.can_reopen); })
      .catch((e) => setErr(e.message));
  }, [targetId, sourceId]);

  const doMerge = async () => {
    setBusy(true);
    try {
      await api.post(`/leads/${targetId}/merge`, { from_lead_id: sourceId, reopen });
      toast(`Lead #${sourceId} merged into #${targetId} — nothing was overwritten`);
      onMerged(); onClose();
    } catch (e: any) { toast(e.message, true); setBusy(false); }
  };

  return (
    <div className="add-scrim" style={{ zIndex: 320 }}>
      <div className="add-modal" style={{ width: 640 }}>
        <div className="ah">
          <h3><Ic k="refresh" />Merge duplicate leads</h3>
          <button className="ax" onClick={onClose}><Ic k="x" /></button>
        </div>
        <div className="abody" style={{ fontSize: 13 }}>
          {err && <div className="empty-note" style={{ color: 'var(--danger)' }}>{err}</div>}
          {!err && !p && <div className="empty-note">Loading merge preview…</div>}
          {p && (
            <>
              <div style={{
                display: 'flex', gap: 8, alignItems: 'flex-start', padding: '9px 11px', borderRadius: 8,
                background: 'var(--primary-soft)', marginBottom: 12, fontSize: 12.5,
              }}>
                <Ic k="shield" />
                <div>
                  Nothing is overwritten. Blank fields on the surviving lead are filled from the duplicate;
                  where both have a value the <b>existing value is kept</b> and the incoming one is recorded on
                  the timeline. The surviving lead <b>keeps its owner</b>, and the duplicate is kept as a
                  restorable, soft-deleted record.
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <LeadCard lead={p.target} tag="Survives (target)" />
                <div style={{ alignSelf: 'center' }}><Ic k="chev" /></div>
                <LeadCard lead={p.source} tag="Merged away (duplicate)" />
              </div>

              <div className="sheet-sec">
                <h5>What this merge will change</h5>
                <DiffView diff={p.diff} />
              </div>

              {p.can_reopen && (
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, cursor: 'pointer', fontSize: 12.5 }}>
                  <input type="checkbox" checked={reopen} aria-label="Re-open the closed lead"
                    onChange={(e) => setReopen(e.target.checked)} />
                  This lead is <b>{p.target.stage_name}</b> (closed) — re-open it and move it back to the first
                  open stage (NeoDove: “Merge Duplicate &amp; Reopen Closed Leads”).
                </label>
              )}
            </>
          )}
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!p || busy || !!err} onClick={doMerge}>
            <Ic k="check" />{busy ? 'Merging…' : reopen ? 'Merge & re-open' : 'Merge leads'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The lead sheet's Duplicates section. */
export function DuplicatePanel({ leadId, onChanged, onOpenLead }: {
  leadId: number; onChanged?: () => void; onOpenLead?: (id: number) => void;
}) {
  const { can } = useAuth();
  const [rep, setRep] = useState<DuplicatesReport | null>(null);
  const [merge, setMerge] = useState<{ target: number; source: number } | null>(null);
  const [openDiff, setOpenDiff] = useState<number | null>(null);

  const load = () => api.get<DuplicatesReport>(`/leads/${leadId}/duplicates`).then(setRep).catch(() => setRep(null));
  useEffect(() => { load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [leadId]);

  if (!rep) return null;
  const canMerge = can('lead.merge');
  const nothing = !rep.duplicate_of && !rep.duplicates.length && !rep.merged.length && !rep.merges.length;
  if (nothing) return null;

  return (
    <div className="sheet-sec" data-testid="duplicate-panel">
      <h5>
        Duplicates
        {rep.counts.open > 0 && <span className="bdg b-amber" style={{ marginLeft: 8 }}>{rep.counts.open} open</span>}
        {rep.counts.merged > 0 && <span className="bdg b-gray" style={{ marginLeft: 6 }}>{rep.counts.merged} merged</span>}
      </h5>

      {/* this lead IS a duplicate of another one */}
      {rep.duplicate_of && (
        <div data-testid="duplicate-of" style={{
          display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '8px 10px',
          borderRadius: 8, background: 'var(--amber-soft)', fontSize: 12.5, marginBottom: 8,
        }}>
          <span className="bdg b-amber">Duplicate</span>
          <span>
            This lead is a duplicate of{' '}
            <a className="mlink" onClick={() => onOpenLead?.(rep.duplicate_of!.id)}>
              #{rep.duplicate_of.id} {rep.duplicate_of.full_name}
            </a>
            {rep.merged_into_id ? ' — already merged into it.' : '.'}
          </span>
          {canMerge && !rep.merged_into_id && (
            <button className="btn" style={{ marginLeft: 'auto' }}
              onClick={() => setMerge({ target: rep.duplicate_of!.id, source: leadId })}>
              <Ic k="refresh" />Merge into #{rep.duplicate_of.id}
            </button>
          )}
        </div>
      )}

      {/* other leads that duplicate THIS one — mergeable into it */}
      {rep.duplicates.map((d) => (
        <div key={d.id} data-testid={`duplicate-row-${d.id}`} style={{
          display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '8px 10px',
          borderRadius: 8, background: 'var(--surface-3)', fontSize: 12.5, marginBottom: 6,
        }}>
          <a className="mlink" onClick={() => onOpenLead?.(d.id)}>#{d.id} {d.full_name}</a>
          <span className="mono">{d.phone}</span>
          <span className="sub">{d.stage_name || '—'} · {d.owner_name || 'Unassigned'} · {d.campaign_name}</span>
          {canMerge && (
            <button className="btn" style={{ marginLeft: 'auto' }}
              onClick={() => setMerge({ target: leadId, source: d.id })}>
              <Ic k="refresh" />Merge into this lead
            </button>
          )}
        </div>
      ))}

      {/* history: what has already been merged in, with the diff */}
      {rep.merges.map((m) => (
        <div key={m.id} data-testid={`merge-row-${m.id}`} style={{ marginBottom: 6 }}>
          <div style={{
            display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '8px 10px',
            borderRadius: 8, background: 'var(--surface-3)', fontSize: 12.5,
          }}>
            <span className="bdg b-green">{ACTION_LABEL[m.action] ?? m.action}</span>
            <span>
              from {m.channel}
              {m.source_lead_id ? ` · lead #${m.source_lead_id}` : ''}
              {m.reopened ? ' · lead re-opened' : ''}
            </span>
            <span className="sub">{fmtDT(m.created_at)}{m.actor_name ? ` · by ${m.actor_name}` : ''}</span>
            <a className="mlink" style={{ marginLeft: 'auto' }}
              onClick={() => setOpenDiff(openDiff === m.id ? null : m.id)}>
              {openDiff === m.id ? 'Hide diff' : 'View diff'}
            </a>
          </div>
          {openDiff === m.id && (
            <div style={{ padding: '8px 10px' }} data-testid={`merge-diff-${m.id}`}>
              <DiffView diff={m.diff} />
            </div>
          )}
        </div>
      ))}

      {merge && (
        <MergeModal targetId={merge.target} sourceId={merge.source}
          onClose={() => setMerge(null)}
          onMerged={() => { load(); onChanged?.(); }} />
      )}
    </div>
  );
}
