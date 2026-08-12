/**
 * CUSTOM FIELDS (client, Aug 2026).
 *
 * Definitions live in `custom_field_def` (API: /custom-fields); the VALUES live in each lead's
 * `custom_fields` JSONB, keyed by `field_key`. This module is the mapping the client asked for:
 *   definition (key/label/type/required) → an input on the lead Add/Edit form → lead.custom_fields.
 *
 * Exports:
 *   - fetchLeadCfDefs()      : active lead custom-field definitions (resilient — [] on any error)
 *   - coerceCf / collectCf   : turn form string values into the typed JSON that persists
 *   - CustomFieldsAdmin      : Administration screen to DEFINE the fields (drives the form)
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { toast } from './refdata';
import { Ic } from './icons';
import { TableCard, Cell } from './renderer';
import { useAuth } from './auth';

export type CfType = 'text' | 'number' | 'date' | 'bool' | 'select' | 'multiselect';
export interface CfDef {
  id: number;
  entity: string;
  field_key: string;
  label: string;
  data_type: CfType;
  options: string[] | null;
  required: boolean;
  sort_order: number;
  is_active?: boolean;
}

export const CF_TYPES: Array<{ v: CfType; label: string }> = [
  { v: 'text', label: 'Text' }, { v: 'number', label: 'Number' }, { v: 'date', label: 'Date' },
  { v: 'bool', label: 'Yes / No' }, { v: 'select', label: 'Dropdown (single)' },
  { v: 'multiselect', label: 'Dropdown (multi)' },
];

/** Active custom-field definitions for ANY entity. Never throws — [] just means "no custom fields". */
export async function fetchCfDefs(entity: string): Promise<CfDef[]> {
  try {
    const rows = await api.get<CfDef[]>(`/custom-fields?entity=${encodeURIComponent(entity)}`);
    return (rows ?? []).map((r) => ({ ...r, options: Array.isArray(r.options) ? r.options : (r.options ?? null) }));
  } catch {
    return [];
  }
}

/** Active lead custom-field definitions. Never throws — an empty list just means "no custom fields". */
export async function fetchLeadCfDefs(): Promise<CfDef[]> {
  return fetchCfDefs('lead');
}

/** Turn a form string value into the JSON value that persists for a given field type. */
export function coerceCf(type: CfType, raw: unknown): unknown {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (type === 'number') { const n = Number(raw); return Number.isFinite(n) ? n : String(raw); }
  if (type === 'bool') return raw === true || raw === '1' || raw === 'true';
  if (type === 'multiselect') {
    if (Array.isArray(raw)) return raw;
    return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  }
  return String(raw);
}

/** Build the custom_fields JSON from the definitions and a value getter (keyed by field_key). */
export function collectCf(defs: CfDef[], get: (key: string) => unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const d of defs) {
    const v = coerceCf(d.data_type, get(d.field_key));
    if (v !== undefined) out[d.field_key] = v;
  }
  return out;
}

/** Present a stored custom-field value for read-only display. */
export function displayCf(def: CfDef, val: unknown): string {
  if (val === undefined || val === null || val === '') return '—';
  if (def.data_type === 'bool') return val === true || val === '1' || val === 'true' ? 'Yes' : 'No';
  if (Array.isArray(val)) return val.join(', ');
  return String(val);
}

/* ============================ Administration screen ============================ */

const emptyDraft = () => ({ label: '', field_key: '', data_type: 'text' as CfType, options: '', required: false, sort_order: 0 });

function CfModal({ initial, onClose, onSaved }: {
  initial: CfDef | null; onClose: () => void; onSaved: () => void;
}) {
  const [d, setD] = useState(() => initial
    ? { label: initial.label, field_key: initial.field_key, data_type: initial.data_type,
        options: (initial.options ?? []).join('\n'), required: !!initial.required, sort_order: initial.sort_order ?? 0 }
    : emptyDraft());
  const [busy, setBusy] = useState(false);
  const isSelect = d.data_type === 'select' || d.data_type === 'multiselect';
  const keyTouched = !!initial;

  const save = async () => {
    if (!d.label.trim()) { toast('A label is required', true); return; }
    const options = isSelect ? d.options.split(/[\n,]/).map((s) => s.trim()).filter(Boolean) : null;
    if (isSelect && (!options || options.length === 0)) { toast('Add at least one dropdown option', true); return; }
    setBusy(true);
    try {
      const body = {
        entity: 'lead', label: d.label.trim(),
        data_type: d.data_type, options, required: !!d.required, sort_order: Number(d.sort_order) || 0,
        ...(initial ? {} : { field_key: d.field_key.trim() || undefined }),
      };
      if (initial) await api.patch(`/custom-fields/${initial.id}`, body);
      else await api.post('/custom-fields', body);
      toast(initial ? 'Custom field updated' : 'Custom field created');
      onSaved(); onClose();
    } catch (e: any) { toast(e.message, true); setBusy(false); }
  };

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ width: 520 }}>
        <div className="ah">
          <h3><Ic k={initial ? 'pencil' : 'plus'} />{initial ? 'Edit custom field' : 'Add custom field'}</h3>
          <button className="ax" onClick={onClose}><Ic k="x" /></button>
        </div>
        <div className="abody">
          <div className="form-grid">
            <div className="fld"><label>Label <span className="star">*</span></label>
              <input className="ainp" value={d.label} data-testid="cf-label"
                onChange={(e) => setD((x) => ({ ...x, label: e.target.value }))} /></div>
            <div className="fld"><label>Field key
              <span className="fhint">machine key in custom_fields · auto from label</span></label>
              {initial
                ? <div className="ainp" style={{ color: 'var(--text-dim)', background: 'var(--surface-3)' }}>{d.field_key}</div>
                : <input className="ainp" value={d.field_key} placeholder="auto from label"
                    onChange={(e) => setD((x) => ({ ...x, field_key: e.target.value }))} />}
            </div>
            <div className="fld"><label>Type</label>
              <select className="ainp" value={d.data_type} data-testid="cf-type"
                onChange={(e) => setD((x) => ({ ...x, data_type: e.target.value as CfType }))}>
                {CF_TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
              </select></div>
            <div className="fld"><label>Sort order</label>
              <input className="ainp" type="number" value={d.sort_order}
                onChange={(e) => setD((x) => ({ ...x, sort_order: Number(e.target.value) }))} /></div>
            {isSelect && (
              <div className="fld span2"><label>Options<span className="fhint">one per line (or comma-separated)</span></label>
                <textarea className="ainp" value={d.options} rows={4}
                  onChange={(e) => setD((x) => ({ ...x, options: e.target.value }))} /></div>
            )}
            <div className="fld span2">
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5 }}>
                <input type="checkbox" checked={d.required} data-testid="cf-required"
                  onChange={(e) => setD((x) => ({ ...x, required: e.target.checked }))} />
                Required — the lead form must have a value before it saves
              </label>
            </div>
          </div>
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy}><Ic k="check" />{initial ? 'Save changes' : 'Create'}</button>
        </div>
      </div>
    </div>
  );
}

export function CustomFieldsAdmin() {
  const { can } = useAuth();
  const [defs, setDefs] = useState<CfDef[] | null>(null);
  const [add, setAdd] = useState(false);
  const [edit, setEdit] = useState<CfDef | null>(null);
  const [del, setDel] = useState<CfDef | null>(null);
  const canCreate = can('custom_field.create');
  const canUpdate = can('custom_field.update');
  const canDelete = can('custom_field.delete');

  const reload = () => api.get<CfDef[]>('/custom-fields?entity=lead&all=1').then(setDefs).catch((e) => { toast(e.message, true); setDefs([]); });
  useEffect(() => { reload(); }, []);

  const typeLabel = (t: string) => CF_TYPES.find((x) => x.v === t)?.label ?? t;
  const rows: Cell[][] = (defs ?? []).map((f): Cell[] => [
    { node: <b>{f.label}</b> },
    { mono: f.field_key },
    typeLabel(f.data_type),
    { b: f.required ? ['Required', 'b-rose'] : ['Optional', 'b-gray'] },
    (f.options ?? []).join(', ') || '—',
    { b: f.is_active === false ? ['Inactive', 'b-gray'] : ['Active', 'b-green'] },
    { node: (
      <span style={{ display: 'inline-flex', gap: 6 }}>
        {canUpdate && <button className="btn" type="button" title="Edit" onClick={() => setEdit(f)}><Ic k="pencil" /></button>}
        {canDelete && f.is_active !== false && <button className="btn" type="button" title="Delete"
          onClick={() => setDel(f)} style={{ color: 'var(--danger)' }}><Ic k="trash" /></button>}
      </span>
    ) },
  ]);

  const doDelete = async () => {
    if (!del) return;
    try {
      await api.del(`/custom-fields/${del.id}`);
      toast('Custom field removed');
      setDel(null); reload();
    } catch (e: any) { toast(e.message, true); }
  };

  return (
    <>
      {canCreate && (
        <div className="page-actions"><button className="btn primary" onClick={() => setAdd(true)}><Ic k="plus" />Add custom field</button></div>
      )}
      <div className="sub" style={{ margin: '4px 0 12px' }}>
        Extra lead fields you define here render on the Add / Edit Lead form and save into each lead’s record.
      </div>
      <TableCard title="Lead custom fields" icon="cfg" listKey="customFields"
        cols={['Field', 'Key', 'Type', 'Mandatory', 'Options', 'Status', 'Actions']}
        rows={rows}
        empty={defs == null ? 'Loading…' : 'No custom fields yet — add one and it appears on the lead form.'} />
      {add && <CfModal initial={null} onClose={() => setAdd(false)} onSaved={reload} />}
      {edit && <CfModal initial={edit} onClose={() => setEdit(null)} onSaved={reload} />}
      {del && (
        <div className="add-scrim" style={{ zIndex: 300 }}>
          <div className="add-modal" style={{ width: 440 }}>
            <div className="ah"><h3><Ic k="trash" />Remove “{del.label}”?</h3><button className="ax" onClick={() => setDel(null)}><Ic k="x" /></button></div>
            <div className="abody" style={{ fontSize: 13 }}>
              The field stops showing on the lead form. Values already stored on leads are kept in their record.
            </div>
            <div className="af">
              <button className="btn" onClick={() => setDel(null)}>Cancel</button>
              <button className="btn primary" onClick={doDelete} style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }}><Ic k="trash" />Remove</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
