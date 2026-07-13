/**
 * Soft delete — impact-preview modal + Deleted Items helpers (client request).
 *
 * Before anything is deleted the modal fetches GET /<entity>/:id/impact and
 * renders the full association hierarchy (counts + first sample names per
 * dependent type). Soft delete marks ONLY the entity itself; children stay
 * intact and visible in their own lists ("This will NOT delete the associated
 * records"). A confirm checkbox gates the Delete button.
 */
import { useEffect, useState } from 'react';
import { api } from './api';
import { Ic } from './icons';
import { toast } from './refdata';

export interface ImpactEntry { key: string; label: string; count: number; sample: string[] }
export interface ImpactReport {
  entity: string; label: string; id: number; name: string; deleted: boolean;
  total_associations: number; impact: ImpactEntry[];
}

/** Association hierarchy list (shared by DeleteModal + Deleted Items impact view). */
export function ImpactList({ report }: { report: ImpactReport }) {
  const rows = report.impact.filter((e) => e.count > 0);
  if (!rows.length) {
    return <div className="empty-note">No associated records — this {report.label.toLowerCase()} is not referenced anywhere.</div>;
  }
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {rows.map((e) => (
        <div key={e.key} style={{
          display: 'flex', alignItems: 'baseline', gap: 8, padding: '7px 10px',
          background: 'var(--surface-2, rgba(128,128,128,.06))', borderRadius: 8, fontSize: 12.5,
        }}>
          <b style={{ minWidth: 34, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{e.count}</b>
          <span style={{ fontWeight: 600 }}>{e.label}</span>
          {e.sample.length > 0 && (
            <span className="sub" style={{ fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {e.sample.join(', ')}{e.count > e.sample.length ? ` +${e.count - e.sample.length} more` : ''}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * "Delete <name>?" — impact preview, warning banner, confirm checkbox.
 * `impactPath` e.g. `/branches/3/impact`; `deletePath` e.g. `/branches/3`.
 */
export function DeleteModal({ entityLabel, name, impactPath, deletePath, onClose, onDeleted }: {
  entityLabel: string; name: string; impactPath: string; deletePath: string;
  onClose: () => void; onDeleted: () => void;
}) {
  const [report, setReport] = useState<ImpactReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<ImpactReport>(impactPath).then(setReport).catch((e) => setErr(e.message));
  }, [impactPath]);

  const doDelete = async () => {
    setBusy(true);
    try {
      await api.del(deletePath);
      toast(`${entityLabel} "${name}" deleted — associated records kept intact`);
      onDeleted(); onClose();
    } catch (e: any) { toast(e.message, true); setBusy(false); }
  };

  return (
    <div className="add-scrim" style={{ zIndex: 300 }}>
      <div className="add-modal" style={{ width: 520 }}>
        <div className="ah">
          <h3><Ic k="trash" />Delete {entityLabel} — {name}?</h3>
          <button className="ax" onClick={onClose}><Ic k="x" /></button>
        </div>
        <div className="abody" style={{ fontSize: 13 }}>
          <div style={{
            display: 'flex', gap: 8, alignItems: 'flex-start', padding: '9px 11px', borderRadius: 8,
            background: 'color-mix(in srgb, var(--danger) 12%, transparent)', border: '1px solid var(--danger)',
            marginBottom: 12, fontSize: 12.5,
          }}>
            <Ic k="shield" />
            <div>
              This will <b>NOT</b> delete the associated records below — only this {entityLabel.toLowerCase()} will
              be removed and hidden from lists, dropdowns and reports. A Super Admin / Org Admin can restore it
              from Administration › Deleted Items.
            </div>
          </div>
          <div className="sheet-sec">
            <h5>Where this {entityLabel.toLowerCase()} is used ({report ? report.total_associations : '…'} associations)</h5>
            {err ? <div className="empty-note" style={{ color: 'var(--danger)' }}>{err}</div>
              : !report ? <div className="empty-note">Loading impact…</div>
              : <ImpactList report={report} />}
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, cursor: 'pointer', fontSize: 12.5 }}>
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            I understand — delete this {entityLabel.toLowerCase()} only, keep all associated records.
          </label>
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!agree || busy || !report} onClick={doDelete}
            style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }}>
            <Ic k="trash" />Delete {entityLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Row state for wiring a DeleteModal into a list screen with one hook. */
export function useDelete(entityLabel: string, base: string, after: () => void) {
  const [target, setTarget] = useState<{ id: number; name: string } | null>(null);
  const modal = target ? (
    <DeleteModal entityLabel={entityLabel} name={target.name}
      impactPath={`${base}/${target.id}/impact`} deletePath={`${base}/${target.id}`}
      onClose={() => setTarget(null)} onDeleted={after} />
  ) : null;
  return { openDelete: (id: number, name: string) => setTarget({ id, name }), deleteModal: modal };
}
