/**
 * LIST TOOLS (client request, Aug 2026) — three things every listing now gets:
 *   1. EXPORT   — download the CURRENT (already filtered + scoped) rows as a CSV.
 *   2. REFRESH  — re-run the list query (each list passes its own reload()).
 *   3. BULK DELETE — multi-select + a soft-delete with an impact-preview confirm,
 *                    reusing the central soft-delete registry (records -> Deleted Items).
 *
 * All three are consistent across modules, keyboard-accessible (real <button>s), and never
 * dead: Export/Refresh always act, Bulk Delete only shows while rows are selected.
 */
import { ReactNode, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { Ic } from './icons';
import { toast } from './refdata';
import type { TableSelect } from './renderer';
import { ImpactList, ImpactReport } from './deletemodal';

/* ------------------------------------------------------------------ CSV ---- */

function csvCell(v: unknown): string {
  if (v == null) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Download an array of plain row objects as CSV. Columns = union of scalar keys (nested
 *  objects/arrays are skipped). Respects whatever filter/scope produced `rows`. */
export function objectsToCsv(rows: Record<string, any>[]): string {
  const skip = new Set<string>();
  const cols: string[] = [];
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      const v = (r as any)[k];
      if (Array.isArray(v) || (v && typeof v === 'object')) { skip.add(k); continue; }
      if (!cols.includes(k) && !skip.has(k)) cols.push(k);
    }
  }
  const use = cols.filter((c) => !skip.has(c));
  const lines = [use.join(',')];
  for (const r of rows) lines.push(use.map((c) => csvCell((r as any)[c])).join(','));
  return lines.join('\r\n');
}

/**
 * DISPLAY projection for exports (client, Aug 2026 — export shows VALUES, not IDs).
 * The list endpoints denormalise names alongside their foreign keys (owner_id + owner_name,
 * branch_id + branch_name, status_id + status_name, …). A raw dump therefore leaks bare numeric
 * ids into the CSV. This maps every row to what the table actually SHOWS: it drops any id column
 * that has a readable sibling (`x_id` when `x` / `x_name` / `x_label` / `x_code` exists, and the
 * primary `id`), plus obvious internal columns, and renames `x_name`/`x_label` → `x` so a header
 * reads the way it does on screen. Generic: every client-side list export runs through it, so the
 * fix applies to Campaigns, Users, Sources, Courses, Students, … without touching each call site.
 */
const INTERNAL_EXPORT_COLS = new Set([
  'org_id', 'deleted_at', 'deleted_by', 'password_hash', 'webhook_token', 'config',
  'score_breakdown', 'custom_fields',
]);
export function toDisplayRows(rows: Record<string, any>[]): Record<string, any>[] {
  if (!rows || !rows.length) return rows ?? [];
  return rows.map((r) => {
    const keys = new Set(Object.keys(r));
    const out: Record<string, any> = {};
    for (const k of Object.keys(r)) {
      const v = (r as any)[k];
      if (Array.isArray(v) || (v && typeof v === 'object')) continue; // objectsToCsv skips these too
      if (INTERNAL_EXPORT_COLS.has(k)) continue;
      // a foreign-key / primary-key id whose readable value is already in the row → drop it
      if (k === 'id' || k.endsWith('_id')) {
        const base = k === 'id' ? '' : k.slice(0, -3);
        const sibs = base
          ? [base, `${base}_name`, `${base}_label`, `${base}_title`, `${base}_code`]
          : ['name', 'full_name', 'title', 'label', 'display_name', 'code'];
        if (sibs.some((sib) => keys.has(sib))) continue;
      }
      // header reads like the screen: owner_name → owner, status_label → status
      let key = k.replace(/_(name|label)$/, '');
      if (key !== k && (keys.has(key) || key in out)) key = k; // never clobber a real column
      out[key] = v;
    }
    return out;
  });
}

export function downloadObjectsCsv(filename: string, rows: Record<string, any>[]): void {
  if (!rows || rows.length === 0) { toast('Nothing to export - the list is empty.', true); return; }
  triggerCsvDownload(filename, objectsToCsv(toDisplayRows(rows)));
}

/** Download explicit header/row string matrices (used where a curated column set is wanted). */
export function downloadMatrixCsv(filename: string, headers: string[], rows: Array<Array<string | number | null | undefined>>): void {
  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  triggerCsvDownload(filename, lines.join('\r\n'));
}

function triggerCsvDownload(filename: string, body: string): void {
  const blob = new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/* -------------------------------------------------------- Export/Refresh --- */

/** The Export + Refresh pair, dropped into a TableCard `more` slot (or any toolbar). */
export function ListActions({ onExport, onRefresh, extra }: {
  onExport?: () => void; onRefresh?: () => void; extra?: ReactNode;
}) {
  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
      {extra}
      {onExport && (
        <button className="btn" type="button" onClick={onExport} data-testid="list-export" aria-label="Export this list to CSV">
          <Ic k="export" />Export
        </button>
      )}
      {onRefresh && (
        <button className="btn" type="button" onClick={onRefresh} data-testid="list-refresh" aria-label="Refresh this list">
          <Ic k="refresh" />Refresh
        </button>
      )}
    </span>
  );
}

/** Server-side leads export: fetch the whole filtered+scoped set, then CSV it. */
export async function exportLeads(query: string): Promise<void> {
  try {
    const r = await api.get<{ rows: Record<string, any>[]; count: number; capped: boolean }>(`/leads/export${query ? `?${query}` : ''}`);
    downloadObjectsCsv(`leads-${new Date().toISOString().slice(0, 10)}.csv`, r.rows ?? []);
    if (r.capped) toast(`Exported the first ${r.count} rows (large result capped) - narrow the filter for the rest.`);
  } catch (e: any) { toast(e.message, true); }
}

/* --------------------------------------------------------- Bulk select ----- */

/** Multi-select state for a page of rows identified by `ids` (row index -> id). */
export function useTableSelect(ids: number[]) {
  const [sel, setSel] = useState<Set<number>>(new Set());
  const idsKey = ids.join(',');
  // Drop selections whose row is no longer present (filter/refresh changed the page).
  useEffect(() => {
    setSel((prev) => {
      const alive = new Set(ids);
      const next = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  const tableSelect: TableSelect = useMemo(() => ({
    checked: (ri: number) => sel.has(ids[ri]),
    onToggle: (ri: number) => setSel((p) => { const n = new Set(p); const id = ids[ri]; n.has(id) ? n.delete(id) : n.add(id); return n; }),
    allChecked: ids.length > 0 && ids.every((id) => sel.has(id)),
    onToggleAll: () => setSel((p) => (ids.every((id) => p.has(id)) ? new Set() : new Set(ids))),
  }), [sel, idsKey]);

  return { selected: [...sel], count: sel.size, tableSelect, clear: () => setSel(new Set()) };
}

/* --------------------------------------------------------- Bulk delete ----- */

export interface BulkImpact {
  entity: string; label: string; requested: number; in_scope: number; out_of_scope: number;
  total_associations: number; impact: Array<{ key: string; label: string; count: number }>;
}

/**
 * "Delete N selected <entity>?" - bulk soft-delete with an aggregate impact preview.
 * `impactPath`/`deletePath` are the module's bulk endpoints; `idKey` is the body field
 * (`ids` everywhere, `lead_ids` for leads to mirror the other /leads/bulk/* actions).
 */
export function BulkDeleteModal({ entityLabel, ids, impactPath, deletePath, idKey = 'ids', onClose, onDone }: {
  entityLabel: string; ids: number[]; impactPath: string; deletePath: string;
  idKey?: string; onClose: () => void; onDone: (deleted: number) => void;
}) {
  const [preview, setPreview] = useState<BulkImpact | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.post<BulkImpact>(impactPath, { [idKey]: ids }).then(setPreview).catch((e) => setErr(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const report: ImpactReport | null = preview ? {
    entity: preview.entity, label: preview.label, id: 0, name: '', deleted: false,
    total_associations: preview.total_associations,
    impact: preview.impact.map((e) => ({ ...e, sample: [] })),
  } : null;

  const doDelete = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ deleted: number; skipped: number }>(deletePath, { [idKey]: ids });
      toast(`${res.deleted} ${entityLabel.toLowerCase()}${res.deleted === 1 ? '' : 's'} deleted${res.skipped ? ` - ${res.skipped} skipped (out of scope / already deleted)` : ''} - restore from Deleted Items`);
      onDone(res.deleted); onClose();
    } catch (e: any) { toast(e.message, true); setBusy(false); }
  };

  return (
    <div className="add-scrim" style={{ zIndex: 300 }}>
      <div className="add-modal" style={{ width: 540 }}>
        <div className="ah">
          <h3><Ic k="trash" />Delete {ids.length} selected {entityLabel.toLowerCase()}{ids.length === 1 ? '' : 's'}?</h3>
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
              This will <b>NOT</b> delete the associated records below - only the selected {entityLabel.toLowerCase()}s move to
              Administration &rsaquo; Deleted Items (a Super Admin / Org Admin can restore them). Records outside your scope
              are skipped automatically.
            </div>
          </div>
          {preview && preview.out_of_scope > 0 && (
            <div className="empty-note" style={{ marginBottom: 10 }}>
              <b>{preview.in_scope}</b> of {preview.requested} selected are within your scope and will be deleted;
              the other <b>{preview.out_of_scope}</b> will be skipped.
            </div>
          )}
          <div className="sheet-sec">
            <h5>Child records affected ({preview ? preview.total_associations : '...'})</h5>
            {err ? <div className="empty-note" style={{ color: 'var(--danger)' }}>{err}</div>
              : !report ? <div className="empty-note">Loading impact...</div>
              : <ImpactList report={report} />}
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, cursor: 'pointer', fontSize: 12.5 }}>
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            I understand - delete the selected {entityLabel.toLowerCase()}s only, keep all associated records.
          </label>
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!agree || busy || !preview} onClick={doDelete}
            style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }}>
            <Ic k="trash" />Delete {preview ? preview.in_scope : ids.length}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Bulk toolbar (appears when >=1 row selected). One shared look across every module. */
export function BulkBar({ count, entityLabel, onDelete, onClear, note }: {
  count: number; entityLabel: string; onDelete: () => void; onClear: () => void; note?: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div className="card" data-testid="bulk-bar" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', marginBottom: 10, flexWrap: 'wrap' }}>
      <b>{count} selected</b>
      <button className="btn" type="button" onClick={onClear}>Clear</button>
      {note}
      <span style={{ flex: 1 }} />
      <button className="btn" type="button" onClick={onDelete} data-testid="bulk-delete"
        style={{ background: 'var(--danger)', borderColor: 'var(--danger)', color: '#fff' }}>
        <Ic k="trash" />Delete {entityLabel.toLowerCase()}s
      </button>
    </div>
  );
}

/** One hook wiring a module's bulk-delete: gives openBulk(ids) + the modal element. */
export function useBulkDelete(entityLabel: string, impactPath: string, deletePath: string, after: () => void, idKey = 'ids') {
  const [ids, setIds] = useState<number[] | null>(null);
  const modal = ids && ids.length ? (
    <BulkDeleteModal entityLabel={entityLabel} ids={ids} impactPath={impactPath} deletePath={deletePath}
      idKey={idKey} onClose={() => setIds(null)} onDone={() => { after(); }} />
  ) : null;
  return { openBulk: (list: number[]) => setIds(list), bulkModal: modal };
}
