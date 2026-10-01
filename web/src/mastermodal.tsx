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
import { UserPicker } from './userpicker';

/** Display labels for the API's master type keys (masters.service MASTER_TYPES). */
export const MASTER_LABELS: Record<string, string> = {
  state: 'State', city: 'City', source: 'Source', course: 'Course',
  qualification: 'Qualification', budget: 'Budget', status: 'Lead Status',
  tag: 'Tag', followup_type: 'Follow-up Type', disposition: 'Disposition',
  training: 'Training Mode', visit_purpose: 'Purpose of Visit', walkin_status: 'Walk-in Status',
  ticket_category: 'Ticket Category', course_type: 'Course Type', level: 'Level', campaign_type: 'Campaign Type',
};

/** A Level master row's Branch / Vertical / Course scope as an id list. Reads the multi-select
 *  meta.<kind>_ids and falls back to the single meta.<kind>_id written before Oct 2026. Empty = all. */
export function levelScopeIds(meta: Record<string, unknown> | null | undefined, kind: 'branch' | 'vertical' | 'course'): number[] {
  const m = meta ?? {};
  const arr = m[`${kind}_ids`];
  const raw = Array.isArray(arr) && arr.length ? arr : (m[`${kind}_id`] != null && m[`${kind}_id`] !== '' ? [m[`${kind}_id`]] : []);
  return [...new Set(raw.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
}

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
  // Oct 2026 (client) — a Level sits under Branch › Vertical › Course, and Branch / Vertical / Course
  // are MULTI-select: one level can serve several branches / verticals / courses. Stored as
  // meta.branch_ids / vertical_ids / course_ids; the single meta.branch_id / vertical_id is still
  // written when exactly one is picked (and read back for levels saved before this change).
  const [courses, setCourses] = useState<Named[]>([]);
  const [lBranches, setLBranches] = useState<number[]>(() => levelScopeIds(lmeta, 'branch'));
  const [lVerticals, setLVerticals] = useState<number[]>(() => levelScopeIds(lmeta, 'vertical'));
  const [lCourses, setLCourses] = useState<number[]>(() => levelScopeIds(lmeta, 'course'));
  const [lFee, setLFee] = useState<string>(lmeta.fee != null ? String(lmeta.fee) : '');
  const [lDuration, setLDuration] = useState<string>(lmeta.duration != null ? String(lmeta.duration) : '');
  useEffect(() => {
    if (!isLevel) return;
    api.get<Named[]>('/branches').then(setBranches).catch(() => setBranches([]));
    api.get<Named[]>('/verticals').then(setVerticals).catch(() => setVerticals([]));
    api.get<Named[]>('/masters/course').then(setCourses).catch(() => setCourses([]));
  }, [isLevel]);
  // Cascade: Vertical options follow the picked Branch(es), Course options the picked Vertical(s).
  const branchName = new Map(branches.map((b) => [Number(b.id), b.name]));
  const verticalName = new Map(verticals.map((v) => [Number(v.id), v.name]));
  const vertOpts = verticals
    .filter((v) => !lBranches.length || lBranches.includes(Number((v as any).branch_id)))
    .map((v) => ({ id: Number(v.id), name: branchName.get(Number((v as any).branch_id)) ? `${branchName.get(Number((v as any).branch_id))} › ${v.name}` : v.name }));
  const courseOpts = courses
    .filter((c) => (!lBranches.length || lBranches.includes(Number((c as any).meta?.branch_id)))
      && (!lVerticals.length || lVerticals.includes(Number((c as any).meta?.vertical_id))))
    .map((c) => ({ id: Number(c.id), name: verticalName.get(Number((c as any).meta?.vertical_id)) ? `${verticalName.get(Number((c as any).meta?.vertical_id))} › ${c.name}` : c.name }));
  const pickBranches = (arr: number[]) => {
    setLBranches(arr);
    if (!arr.length) return;
    const okV = new Set(verticals.filter((v) => arr.includes(Number((v as any).branch_id))).map((v) => Number(v.id)));
    setLVerticals((vs) => vs.filter((v) => okV.has(v)));
    setLCourses((cs) => cs.filter((cid) => arr.includes(Number((courses.find((c) => Number(c.id) === cid) as any)?.meta?.branch_id))));
  };
  const pickVerticals = (arr: number[]) => {
    setLVerticals(arr);
    if (!arr.length) return;
    setLCourses((cs) => cs.filter((cid) => arr.includes(Number((courses.find((c) => Number(c.id) === cid) as any)?.meta?.vertical_id))));
  };

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
          branch_ids: lBranches, vertical_ids: lVerticals, course_ids: lCourses,
          branch_id: lBranches.length === 1 ? lBranches[0] : null,
          vertical_id: lVerticals.length === 1 ? lVerticals[0] : null,
          course_id: lCourses.length === 1 ? lCourses[0] : null,
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
            {/* Level master: the hierarchy comes FIRST — Branch › Vertical › Course, then the Level. */}
            {isLevel && (
              <>
                <div className="fld" data-testid="level-branch">
                  <label>Branch<span className="fhint">multi-select · leave empty for all branches</span></label>
                  <UserPicker options={branches.map((b) => ({ id: Number(b.id), name: b.name }))} value={lBranches} hideBranch
                    placeholder="All branches — tick to limit…" onChange={pickBranches} />
                </div>
                <div className="fld" data-testid="level-vertical">
                  <label>Vertical<span className="fhint">multi-select · filtered by Branch</span></label>
                  <UserPicker options={vertOpts} value={lVerticals} hideBranch
                    placeholder={lBranches.length ? 'All verticals in the branch(es) — tick to limit…' : 'All verticals — tick to limit…'} onChange={pickVerticals} />
                </div>
                <div className="fld" data-testid="level-course">
                  <label>Course<span className="fhint">multi-select · filtered by Vertical</span></label>
                  <UserPicker options={courseOpts} value={lCourses} hideBranch
                    placeholder="All courses — tick to limit…" onChange={setLCourses} />
                </div>
              </>
            )}
            <div className="fld">
              <label>{isLevel ? 'Level name' : 'Name'} <span className="star">*</span></label>
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
                  <label>Fee<span className="fhint">₹ · auto-fills the course form when this level is picked</span></label>
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
