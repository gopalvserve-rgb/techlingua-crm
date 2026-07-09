/**
 * Inline "＋ Master" modal — add a master value (Course, Status, Follow-up Type,
 * City, …) without leaving the form being filled. POSTs /api/masters/<type>;
 * API errors (duplicate 409 / bad reference 400 from the pg exception filter)
 * render inline. Parent masters (city → state) come from the API type registry.
 */
import { useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { Ic } from './icons';
import { toast, Named } from './refdata';

/** Display labels for the API's master type keys (masters.service MASTER_TYPES). */
export const MASTER_LABELS: Record<string, string> = {
  state: 'State', city: 'City', source: 'Source', course: 'Course',
  qualification: 'Qualification', budget: 'Budget', status: 'Status',
  tag: 'Tag', followup_type: 'Follow-up Type', disposition: 'Disposition',
};

/** "Data Science & AI" -> "DATA_SCIENCE_AI" — editable suggestion, never forced. */
const suggestCode = (name: string) =>
  name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);

export function AddMasterModal({ type, onClose, onCreated }: {
  type: string;
  onClose: () => void;
  /** Fires with the created row so the caller can inject + auto-select it. */
  onCreated: (row: Named) => void;
}) {
  const label = MASTER_LABELS[type] ?? type;
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [codeTouched, setCodeTouched] = useState(false);
  const [parentType, setParentType] = useState<string | null>(type === 'city' ? 'state' : null);
  const [parents, setParents] = useState<Named[]>([]);
  const [parentId, setParentId] = useState<number>();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Parent link is data-driven: /masters lists {type, label, parent} per master.
  useEffect(() => {
    api.get<Array<{ type: string; parent: string | null }>>('/masters')
      .then((types) => setParentType(types.find((t) => t.type === type)?.parent ?? null))
      .catch(() => undefined);
  }, [type]);
  useEffect(() => {
    if (!parentType) { setParents([]); return; }
    api.get<Named[]>(`/masters/${parentType}`).then(setParents).catch(() => setParents([]));
  }, [parentType]);

  const save = async () => {
    if (!name.trim()) return setErr('Name is required');
    if (parentType && !parentId) return setErr(`Pick a ${MASTER_LABELS[parentType] ?? parentType}`);
    setBusy(true); setErr(null);
    try {
      const row = await api.post<Named>(`/masters/${type}`, {
        name: name.trim(),
        code: code.trim() || undefined,
        parent_id: parentType ? parentId : undefined,
      });
      toast(`${label} "${row.name}" added to the master`);
      onCreated(row);
      onClose();
    } catch (e: any) {
      // 409 = unique index hit (pg exception filter); other API messages show as-is
      setErr(e instanceof ApiError && e.status === 409
        ? `This ${label.toLowerCase()} already exists (duplicate name or code)`
        : e?.message ?? 'Could not save');
    } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim" style={{ zIndex: 260 }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="add-modal" style={{ width: 440 }}>
        <div className="ah">
          <h3><Ic k="plus" />Add {label}</h3>
          <button className="ax" onClick={onClose}><Ic k="x" /></button>
        </div>
        <div className="abody">
          {err && <div className="form-err">{err}</div>}
          <div className="form-grid" style={{ gridTemplateColumns: '1fr', padding: 0 }}>
            <div className="fld">
              <label>Name <span className="star">*</span></label>
              <input className="ainp" autoFocus placeholder={`${label} name`} value={name}
                onChange={(e) => { setName(e.target.value); if (!codeTouched) setCode(suggestCode(e.target.value)); }}
                onKeyDown={(e) => { if (e.key === 'Enter') save(); }} />
            </div>
            <div className="fld">
              <label>Code<span className="fhint">optional · auto-suggested from name</span></label>
              <input className="ainp" value={code}
                onChange={(e) => { setCode(e.target.value); setCodeTouched(true); }} />
            </div>
            {parentType && (
              <div className="fld">
                <label>{MASTER_LABELS[parentType] ?? parentType} <span className="star">*</span><span className="fhint">parent</span></label>
                <select className="ainp" value={parentId ?? ''}
                  onChange={(e) => setParentId(e.target.value ? Number(e.target.value) : undefined)}>
                  <option value="">Select…</option>
                  {parents.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            )}
          </div>
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy}><Ic k="check" />Save</button>
        </div>
      </div>
    </div>
  );
}
