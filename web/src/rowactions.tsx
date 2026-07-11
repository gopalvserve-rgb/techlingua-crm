/**
 * Shared row-action primitives — UAT "edit & view on every module".
 * View (eye) / Edit (pencil) icon buttons per TableCard row, a clickable
 * Active/Inactive status chip with a confirm step, a read-only detail-modal
 * shell (same add-modal skin) and an "Include inactive" filter chip.
 * All additive — sanctioned in docs/design/01-prototype-parity-spec.md.
 */
import { ReactNode, useState } from 'react';
import { Ic } from './icons';
import { toast } from './refdata';
import { Cell } from './renderer';

/* ------------------------- view / edit buttons ------------------------- */

export function rowActions(opts: {
  onView?: () => void; onEdit?: () => void;
  /** additional icon buttons (e.g. pipeline "Stages" configurator) */
  extra?: Array<{ k: string; title: string; onClick: () => void }>;
}): Cell {
  return { node: (
    <span className="rowact" onClick={(e) => e.stopPropagation()}>
      {opts.onView && (
        <button className="ract" title="View" onClick={opts.onView}><Ic k="eye" w={2.1} /></button>
      )}
      {opts.onEdit && (
        <button className="ract" title="Edit" onClick={opts.onEdit}><Ic k="pencil" w={2.1} /></button>
      )}
      {(opts.extra ?? []).map((x) => (
        <button className="ract" key={x.title} title={x.title} onClick={x.onClick}><Ic k={x.k} w={2.1} /></button>
      ))}
    </span>
  ) };
}

/* ----------------------------- confirm step ---------------------------- */

export function ConfirmModal({ title, body, confirmLabel = 'Confirm', danger, busy, onConfirm, onClose }: {
  title: string; body: ReactNode; confirmLabel?: string; danger?: boolean; busy?: boolean;
  onConfirm: () => void; onClose: () => void;
}) {
  return (
    <div className="add-scrim" style={{ zIndex: 300 }}>
      <div className="add-modal" style={{ width: 400 }}>
        <div className="ah">
          <h3><Ic k="shield" />{title}</h3>
          <button className="ax" onClick={onClose}><Ic k="x" /></button>
        </div>
        <div className="abody" style={{ fontSize: 13 }}>{body}</div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={onConfirm}
            style={danger ? { background: 'var(--danger)', borderColor: 'var(--danger)' } : undefined}>
            <Ic k="check" />{confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Active/Inactive chip; when the user may toggle, clicking asks to confirm then PATCHes. */
export function ToggleChip({ active, name, entity, canToggle, onToggle }: {
  active: boolean; name: string; entity: string; canToggle: boolean;
  onToggle: (next: boolean) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const next = !active;
  const go = async () => {
    setBusy(true);
    try {
      await onToggle(next);
      toast(`${entity} "${name}" marked ${next ? 'Active' : 'Inactive'}`);
      setOpen(false);
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <>
      <span className={`bdg ${active ? 'b-green' : 'b-gray'}${canToggle ? ' togglable' : ''}`}
        title={canToggle ? `Mark ${next ? 'Active' : 'Inactive'}` : undefined}
        onClick={canToggle ? (e) => { e.stopPropagation(); setOpen(true); } : undefined}>
        {active ? 'Active' : 'Inactive'}
      </span>
      {open && (
        <ConfirmModal
          title={next ? `Activate ${entity.toLowerCase()}` : `Deactivate ${entity.toLowerCase()}`}
          danger={!next} busy={busy} confirmLabel={next ? 'Activate' : 'Deactivate'}
          body={next
            ? <>Mark {entity.toLowerCase()} <b>{name}</b> as Active again? It returns to pickers and lists immediately.</>
            : <>Mark {entity.toLowerCase()} <b>{name}</b> as Inactive? Existing records keep referencing it, but it disappears from pickers and default lists. You can reactivate it any time.</>}
          onConfirm={go} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

export const toggleCell = (props: Parameters<typeof ToggleChip>[0]): Cell => ({ node: <ToggleChip {...props} /> });

/* --------------------------- detail (view) modal ------------------------ */

export function DetailModal({ title, icon = 'eye', width = 600, onClose, children, footer }: {
  title: ReactNode; icon?: string; width?: number; onClose: () => void; children: ReactNode; footer?: ReactNode;
}) {
  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ width }}>
        <div className="ah">
          <h3><Ic k={icon} />{title}</h3>
          <button className="ax" onClick={onClose}><Ic k="x" /></button>
        </div>
        <div className="abody">{children}</div>
        <div className="af">
          <button className="btn" onClick={onClose}>Close</button>
          {footer}
        </div>
      </div>
    </div>
  );
}

/** Key/value grid for detail modals (skips rows whose value is null/undefined). */
export function KV({ rows }: { rows: Array<[string, ReactNode] | null | false> }) {
  return (
    <div className="dvgrid">
      {rows.filter((r): r is [string, ReactNode] => !!r).map(([k, v], i) => (
        <span key={i} style={{ display: 'contents' }}>
          <span className="k">{k}</span><span className="v">{v ?? '—'}</span>
        </span>
      ))}
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return <div className="sheet-sec"><h5>{title}</h5>{children}</div>;
}

export const fmtFull = (s?: string | null) =>
  (s ? new Date(s).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

/* ------------------------- include-inactive chip ------------------------ */

export function IncInactiveChip({ on, set }: { on: boolean; set: (v: boolean) => void }) {
  return (
    <button className="fchip" onClick={() => set(!on)}
      style={{ cursor: 'pointer', color: on ? 'var(--primary)' : 'var(--text-muted)', borderColor: on ? 'var(--primary)' : undefined }}>
      <Ic k={on ? 'eye' : 'filter'} />{on ? 'Showing inactive' : 'Include inactive'}
    </button>
  );
}
