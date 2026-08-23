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
  qualification: 'Qualification', budget: 'Budget', status: 'Lead Status',
  tag: 'Tag', followup_type: 'Follow-up Type', disposition: 'Disposition',
  training: 'Training Mode', visit_purpose: 'Purpose of Visit', walkin_status: 'Walk-in Status',
  ticket_category: 'Ticket Category', course_type: 'Course Type', level: 'Level', campaign_type: 'Campaign Type',
};

/** "Data Science & AI" -> "DATA_SCIENCE_AI" — editable suggestion, never forced. */
const suggestCode = (name: string) =>
  name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);

export function AddMasterModal({ type, onClose, onCreated, initial }: {
  type: string;
  onClose: () => void;
  /** Fires with the created/updated row so the caller can inject + auto-select it. */
  onCreated: (row: Named) => void;
  /** UAT edit mode: prefill and PATCH instead of POST. */
  initial?: Named;
}) {
  const label = MASTER_LABELS[type] ?? type;
  const [name, setName] = useState(initial?.name ?? '');
  const [code, setCode] = useState(initial?.code ?? '');
  const [codeTouched, setCodeTouched] = useState(!!initial);
  const [parentType, setParentType] = useState<string | null>(type === 'city' ? 'state' : null);
  const [parents, setParents] = useState<Named[]>([]);
  const [parentId, setParentId] = useState<number | undefined>(initial?.parent_id ? Number(initial.parent_id) : undefined);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Level master (dev/131, task #214 item 8): a Level follows Branch -> Vertical and carries a Fee +
  // Duration, stored in the master's meta. The generic /masters list already filters by
  // meta.branch_id / meta.vertical_id, so persisting them here makes the Level master branch/vertical-scoped.
  const isLevel = type === 'level';
  const lmeta = ((initial as any)?.meta ?? {}) as Record<string, unknown>;
  const [branches, setBranches] = useState<Named[]>([]);
  const [verticals, setVerticals] = useState<Named[]>([]);
  const [lBranch, setLBranch] = useState<number | undefined>(lmeta.branch_id ? Number(lmeta.branch_id) : undefined);
  const [lVertical, setLVertical] = useState<number | undefined>(lmeta.vertical_id ? Number(lmeta.vertical_id) : undefined);
  const [lFee, setLFee] = useState<string>(lmeta.fee != null ? String(lmeta.fee) : '');
  const [lDuration, setLDuration] = useState<string>(lmeta.duration != null ? String(lmeta.duration) : '');
  useEffect(() => {
    if (!isLevel) return;
    api.get<Named[]>('/branches').then(setBranches).catch(() => setBranches([]));
    api.get<Named[]>('/verticals').then(setVerticals).catch(() => setVerticals([]));
  }, [isLevel]);

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
      const body: Record<string, unknown> = {
        name: name.trim(),
        code: code.trim() || undefined,
        parent_id: parentType ? parentId : undefined,
      };
      if (isLevel) {
        body.meta = {
          ...lmeta,
          branch_id: lBranch ?? null, vertical_id: lVertical ?? null,
          fee: lFee.trim() === '' ? null : Number(lFee), duration: lDuration.trim() || null,
        };
      }
      const row = initial
        ? await api.patch<Named>(`/masters/${type}/${initial.id}`, body)
        : await api.post<Named>(`/masters/${type}`, body);
      toast(initial ? `${label} "${row.name}" updated` : `${label} "${row.name}" added to the master`);
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
    <div className="add-scrim" style={{ zIndex: 260 }}>
      <div className="add-modal" style={{ width: 440 }}>
        <div className="ah">
          <h3><Ic k={initial ? 'pencil' : 'plus'} />{initial ? `Edit ${label}` : `Add ${label}`}</h3>
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
            {isLevel && (
              <>
                <div className="fld">
                  <label>Branch<span className="fhint">optional · scopes this level</span></label>
                  <select className="ainp" data-testid="level-branch" value={lBranch ?? ''}
                    onChange={(e) => { setLBranch(e.target.value ? Number(e.target.value) : undefined); setLVertical(undefined); }}>
                    <option value="">All branches</option>
                    {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>
                <div className="fld">
                  <label>Vertical<span className="fhint">optional · filtered by Branch</span></label>
                  <select className="ainp" data-testid="level-vertical" value={lVertical ?? ''}
                    onChange={(e) => setLVertical(e.target.value ? Number(e.target.value) : undefined)}>
                    <option value="">{lBranch ? 'All verticals in branch' : 'All verticals'}</option>
                    {verticals.filter((v) => !lBranch || Number((v as any).branch_id) === lBranch).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                </div>
                <div className="fld">
                  <label>Fee<span className="fhint">₹ · the level fee; blank falls back to the course Standard Fee</span></label>
                  <input className="ainp" type="number" min={0} data-testid="level-fee" placeholder="e.g. 15000" value={lFee}
                    onChange={(e) => setLFee(e.target.value)} />
                </div>
                <div className="fld">
                  <label>Duration<span className="fhint">free text · e.g. 3 Months, 40 Hours</span></label>
                  <input className="ainp" data-testid="level-duration" placeholder="e.g. 3 Months" value={lDuration}
                    onChange={(e) => setLDuration(e.target.value)} />
                </div>
              </>
            )}
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
