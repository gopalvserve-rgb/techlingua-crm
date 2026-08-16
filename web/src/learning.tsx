/**
 * Students & Academics — ERP Batch 2 (Learning) UI: Study Material, Certificates, and
 * Academic Progress (report cards + a parent share view).
 *
 * Self-contained like academics.tsx. Every list carries the FULL treatment: multi-select
 * FilterMulti filters, Export (values not ids), a column chooser (TableCard fill+title),
 * Refresh, and bulk-delete (useTableSelect + BulkBar + useBulkDelete). Every API route has a
 * caller here (route-reachability guard).
 */
import { useMemo, useState } from 'react';
import { api, getToken } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, Kpis, TableCard } from './renderer';
import { toast, useFetch, useRef_ } from './refdata';
import { MasterQuickAdd } from './forms';
import { rowActions, fmtFull, ConfirmModal, DetailModal } from './rowactions';
import { DateRange } from './daterange';
import { useScope } from './scope';
import { FilterMulti } from './dyn';
import { ListActions, downloadObjectsCsv, useTableSelect, BulkBar, useBulkDelete } from './listtools';

/* ------------------------------------------------------------ shared bits -- */

/** Open an auth-guarded PDF: fetch as a blob with the bearer token, then open it. */
async function openPdf(path: string) {
  try {
    const res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!res.ok) throw new Error(`Could not open the PDF (${res.status}).`);
    const url = URL.createObjectURL(await res.blob());
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e: any) { toast(e.message, true); }
}

function useBatches(branchIds: number[], verticalIds: number[]) {
  const p = new URLSearchParams();
  if (branchIds.length) p.set('branch_id', branchIds.join(','));
  if (verticalIds.length) p.set('vertical_id', verticalIds.join(','));
  return useFetch<any[]>(`/batches?${p.toString()}`, [p.toString()]);
}

function useStudents(branchIds: number[], verticalIds: number[]) {
  const p = new URLSearchParams(); p.set('limit', '500');
  if (branchIds.length) p.set('branch_id', branchIds.join(','));
  if (verticalIds.length) p.set('vertical_id', verticalIds.join(','));
  return useFetch<any[]>(`/students?${p.toString()}`, [p.toString()]);
}

/** Branch + Vertical + Course FilterMulti row shared by the three screens. */
function ScopeFilters({ rd, fB, setFB, fV, setFV, fC, setFC, extra }: any) {
  const vOpts = rd.verticals.filter((vt: any) => !fB.length || fB.includes(Number(vt.branch_id)));
  const cOpts = rd.courses.filter((c: any) => (!fV.length || fV.includes(Number(c.meta?.vertical_id))) && (!fB.length || fB.includes(Number(c.meta?.branch_id))));
  return (
    <div className="filters">
      <FilterMulti label="Branch" icon="branch" value={fB} options={rd.branches}
        onChange={(v: number[]) => { setFB(v); setFV((cur: number[]) => cur.filter((id) => rd.verticals.some((vt: any) => Number(vt.id) === id && v.includes(Number(vt.branch_id))))); }} />
      <FilterMulti label="Vertical" icon="grid" value={fV} options={vOpts} onChange={setFV} />
      <FilterMulti label="Course" icon="doc" value={fC} options={cOpts} onChange={setFC} />
      {extra}
    </div>
  );
}

const MAT_TYPES = ['video', 'link', 'document', 'note', 'image', 'audio'];
const CERT_TYPES = ['completion', 'participation', 'merit', 'other'];

/* ==========================================================================
 * 1) STUDY MATERIAL
 * ======================================================================== */
const MAT_WF_BADGE = { draft: 'b-gray', pending_approval: 'b-amber', published: 'b-green', changes_requested: 'b-rose', unpublished: 'b-gray' } as Record<string, string>;
const MAT_WF_LABEL = { draft: 'Draft', pending_approval: 'Pending approval', published: 'Published', changes_requested: 'Changes requested', unpublished: 'Unpublished' } as Record<string, string>;
const MAT_WF = ['draft', 'pending_approval', 'published', 'changes_requested', 'unpublished'];

/** Upload straight to R2 via presigned PUT; returns the r2_key. */
async function materialUpload(file: File): Promise<string> {
  const { url, r2_key } = await api.post<{ url: string; r2_key: string }>('/learning/materials/upload-url', { file_name: file.name, content_type: file.type || 'application/octet-stream' });
  const res = await fetch(url, { method: 'PUT', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);
  return r2_key;
}

export function StudyMaterialScreen() {
  const ref = useRef_();
  const { scope: gScope } = useScope();
  const { can } = useAuth();
  const canApprove = can('material.approve');
  const canSubmit = can('material.submit');
  const [fB, setFB] = useState<number[]>(gScope.branches);
  const [fV, setFV] = useState<number[]>(gScope.verticals);
  const [fC, setFC] = useState<number[]>([]);
  const [ftype, setFtype] = useState('');
  const [fstat, setFstat] = useState('');
  const [mine, setMine] = useState(false);
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const [tick, setTick] = useState(0);
  const [add, setAdd] = useState(false);
  const [edit, setEdit] = useState<any | null>(null);
  const [del, setDel] = useState<any | null>(null);

  const qs = new URLSearchParams();
  if (fB.length) qs.set('branch_id', fB.join(','));
  if (fV.length) qs.set('vertical_id', fV.join(','));
  if (fC.length) qs.set('course_id', fC.join(','));
  if (ftype) qs.set('material_type', ftype);
  if (fstat) qs.set('status', fstat);
  if (mine) qs.set('mine', '1');
  if (range.from) qs.set('from', range.from);
  if (range.to) qs.set('to', range.to);
  const list = useFetch<any[]>(`/learning/materials?${qs.toString()}`, [qs.toString(), tick]);
  const after = () => setTick((t) => t + 1);
  const rows = list.data ?? [];
  const ids = rows.map((r: any) => Number(r.id));
  const { selected, count, tableSelect, clear } = useTableSelect(ids);
  const { openBulk, bulkModal } = useBulkDelete('Material', '/learning/materials/bulk-delete/impact', '/learning/materials/bulk-delete', () => { after(); clear(); });
  const doDelete = async () => { try { await api.del(`/learning/materials/${del.id}`); toast('Material deleted'); setDel(null); after(); } catch (e: any) { toast(e.message, true); } };
  const wf = async (r: any, verb: string, label: string) => { try { await api.post(`/learning/materials/${r.id}/${verb}`, {}); toast(label); after(); } catch (e: any) { toast(e.message, true); } };
  const doReject = async (r: any) => { const remarks = window.prompt('Reason / changes requested (sent back to the trainer):', ''); if (remarks == null) return; if (!remarks.trim()) { toast('Remarks are required', true); return; } try { await api.post(`/learning/materials/${r.id}/reject`, { remarks }); toast('Sent back with remarks'); after(); } catch (e: any) { toast(e.message, true); } };
  const openFile = async (r: any) => { try { const d = await api.get<any>(`/learning/materials/${r.id}`); if (d.file_url) window.open(d.file_url, '_blank', 'noopener'); else toast('No file attached'); } catch (e: any) { toast(e.message, true); } };

  const wfActions = (m: any) => {
    const s = m.workflow_status; const extra: any[] = [];
    if (can('material.submit') && !can('material.approve') && (s === 'draft' || s === 'changes_requested' || s === 'unpublished')) extra.push({ k: 'send', title: 'Submit for approval', onClick: () => wf(m, 'submit', 'Submitted for approval') });
    if (can('material.approve')) {
      if (s === 'pending_approval') { extra.push({ k: 'check', title: 'Approve & publish', onClick: () => wf(m, 'approve', 'Approved — published') }); extra.push({ k: 'x', title: 'Reject (send back)', onClick: () => doReject(m) }); }
      if (s === 'draft' || s === 'changes_requested' || s === 'unpublished') extra.push({ k: 'check', title: 'Publish', onClick: () => wf(m, 'approve', 'Published') });
      if (s === 'published') extra.push({ k: 'restore', title: 'Unpublish', onClick: () => wf(m, 'unpublish', 'Unpublished') });
    }
    return extra;
  };

  return (
    <>
      {can('material.create') && <div className="page-actions"><button className="btn primary" onClick={() => setAdd(true)}><Ic k="plus" />New material</button></div>}
      <ScopeFilters rd={ref} fB={fB} setFB={setFB} fV={fV} setFV={setFV} fC={fC} setFC={setFC}
        extra={<>
          <label className="fchip"><Ic k="doc" />
            <select value={ftype} onChange={(e) => setFtype(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }}>
              <option value="">All types</option>{MAT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select></label>
          {/* Status filter is available to everyone: a non-approver now gets their OWN
              draft/pending/changes_requested items back, so the filter is meaningful for them too. */}
          <label className="fchip"><Ic k="shield" />
            <select value={fstat} onChange={(e) => setFstat(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }}>
              <option value="">All statuses</option>{MAT_WF.map((t) => <option key={t} value={t}>{MAT_WF_LABEL[t]}</option>)}
            </select></label>
          {canSubmit && !canApprove && <>
            <button type="button" className={'fchip' + (mine ? ' on' : '')} onClick={() => setMine((m) => !m)}><Ic k="users" />Mine</button>
            <button type="button" className={'fchip' + (fstat === 'changes_requested' ? ' on' : '')}
              onClick={() => { setMine(true); setFstat(fstat === 'changes_requested' ? '' : 'changes_requested'); }}><Ic k="flag" />Needs changes</button>
          </>}
          <DateRange value={range} onChange={setRange} idPrefix="mat-dr" style={{ marginLeft: 'auto' }} />
        </>} />
      <BulkBar count={count} entityLabel="Material" onDelete={() => openBulk(selected)} onClear={clear} />
      <TableCard fill title="Study material" icon="doc"
        select={can('material.delete') ? tableSelect : undefined}
        more={<ListActions onExport={() => downloadObjectsCsv('study-material.csv', rows)} onRefresh={after} />}
        cols={['Title', 'Type', 'Access', 'Course', 'Batch', 'File / Link', 'Status', 'Actions']}
        empty="No study material yet — add an item for a batch, course or vertical."
        rows={rows.map((m: any) => [
          { node: <div><b className="nm">{m.title}</b>{m.review_remarks && m.workflow_status === 'changes_requested' ? <div className="sub" style={{ color: 'var(--danger)' }}>↩ {m.review_remarks}</div> : null}</div> } as Cell,
          m.material_type,
          m.access_level,
          m.course_name ?? '—',
          m.batch_name ?? '—',
          { node: m.file_r2_key ? <a href="#" onClick={(e) => { e.preventDefault(); openFile(m); }}>File</a> : ((m.external_url || m.url) ? <a href={m.external_url || m.url} target="_blank" rel="noopener noreferrer">{m.material_type === 'video' ? 'Watch' : 'Open link'}</a> : '—') } as Cell,
          { b: [MAT_WF_LABEL[m.workflow_status] ?? m.workflow_status, MAT_WF_BADGE[m.workflow_status] ?? 'b-gray'] } as Cell,
          rowActions({
            onEdit: can('material.update') ? () => setEdit(m) : undefined,
            onDelete: can('material.delete') ? () => setDel(m) : undefined,
            extra: wfActions(m),
          }),
        ])} />
      {add && <MaterialModal onClose={() => setAdd(false)} onSaved={after} ref_={ref} />}
      {edit && <MaterialModal initial={edit} onClose={() => setEdit(null)} onSaved={after} ref_={ref} />}
      {del && <ConfirmModal title="Delete material?" body={`Delete "${del.title}"?`} danger confirmLabel="Delete" onConfirm={doDelete} onClose={() => setDel(null)} />}
      {bulkModal}
    </>
  );
}

function MaterialModal({ initial, onClose, onSaved, ref_ }: { initial?: any; onClose: () => void; onSaved: () => void; ref_: any }) {
  const isEdit = !!initial?.id;
  const [level, setLevel] = useState<string>(initial?.access_level ?? 'batch');
  const [branchId, setBranchId] = useState<string>(String(initial?.branch_id ?? ''));
  const [verticalId, setVerticalId] = useState<string>(String(initial?.vertical_id ?? ''));
  const [courseId, setCourseId] = useState<string>(String(initial?.course_id ?? ''));
  const [batchId, setBatchId] = useState<string>(String(initial?.batch_id ?? ''));
  const [title, setTitle] = useState<string>(initial?.title ?? '');
  const [desc, setDesc] = useState<string>(initial?.description ?? '');
  const [type, setType] = useState<string>(initial?.material_type ?? 'link');
  const [externalUrl, setExternalUrl] = useState<string>(initial?.external_url ?? initial?.url ?? '');
  const [fileKey, setFileKey] = useState<string>(initial?.file_r2_key ?? '');
  const [fileName, setFileName] = useState<string>(initial?.file_r2_key ? 'Attached file' : '');
  const [body, setBody] = useState<string>(initial?.body ?? '');
  const [tags, setTags] = useState<string>(initial?.tags ?? '');
  const [parents, setParents] = useState<boolean>(!!initial?.allow_parents);
  const [busy, setBusy] = useState(false); const [uploading, setUploading] = useState(false); const [err, setErr] = useState('');

  const vOpts = ref_.verticals.filter((v: any) => !branchId || Number(v.branch_id) === Number(branchId));
  const cOpts = ref_.courses.filter((c: any) => (!verticalId || Number(c.meta?.vertical_id) === Number(verticalId)));
  const batches = useBatches(branchId ? [Number(branchId)] : [], verticalId ? [Number(verticalId)] : []);
  const isLinkType = type === 'link' || type === 'video';

  const pickFile = async (f?: File | null) => {
    if (!f) return; setUploading(true); setErr('');
    try { const key = await materialUpload(f); setFileKey(key); setFileName(f.name); } catch (e: any) { setErr(e.message); } finally { setUploading(false); }
  };

  const save = async () => {
    setErr('');
    if (!title.trim()) return setErr('Give the material a title.');
    if (type === 'note' && !body.trim()) return setErr('A note needs some content.');
    if (isLinkType && !externalUrl.trim()) return setErr('Add a link / YouTube URL.');
    if (!isLinkType && type !== 'note' && !fileKey && !externalUrl.trim()) return setErr('Upload a file or provide a link.');
    setBusy(true);
    const base: any = { title: title.trim(), description: desc || null, material_type: type, external_url: externalUrl || null, file_r2_key: fileKey || null, body: type === 'note' ? body : null, tags: tags || null, allow_parents: parents };
    if (!isEdit) {
      base.access_level = level;
      if (level === 'batch') { if (!batchId) { setBusy(false); return setErr('Choose a batch.'); } base.batch_id = Number(batchId); }
      else { if (!branchId || !verticalId) { setBusy(false); return setErr('Choose a branch and vertical.'); } base.branch_id = Number(branchId); base.vertical_id = Number(verticalId); if (level === 'course') { if (!courseId) { setBusy(false); return setErr('Choose a course.'); } base.course_id = Number(courseId); } }
    }
    try {
      if (isEdit) await api.patch(`/learning/materials/${initial.id}`, base);
      else await api.post('/learning/materials', base);
      toast(isEdit ? 'Material updated' : 'Material added (draft)'); onSaved(); onClose();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim"><div className="add-modal" style={{ maxWidth: 620 }}>
      <div className="ah"><h3><Ic k="doc" />{isEdit ? 'Edit material' : 'New study material'}</h3><button className="ax" onClick={onClose}><Ic k="x" /></button></div>
      <div className="abody"><div className="form-grid">
        {!isEdit && (
          <div className="fld"><label>Access level <span className="star">*</span></label>
            <select className="ainp" value={level} onChange={(e) => setLevel(e.target.value)}>
              <option value="batch">A specific batch</option>
              <option value="course">A whole course</option>
              <option value="vertical">A whole vertical (branch)</option>
            </select></div>
        )}
        {!isEdit && level === 'batch' && (
          <>
            <div className="fld"><label>Branch</label>
              <select className="ainp" value={branchId} onChange={(e) => { setBranchId(e.target.value); setVerticalId(''); setBatchId(''); }}>
                <option value="">— any of my branches —</option>{ref_.branches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select></div>
            <div className="fld"><label>Vertical</label>
              <select className="ainp" value={verticalId} onChange={(e) => { setVerticalId(e.target.value); setBatchId(''); }}>
                <option value="">— any —</option>{vOpts.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select></div>
            <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Batch <span className="star">*</span></label>
              <select className="ainp" value={batchId} onChange={(e) => setBatchId(e.target.value)}>
                <option value="">— Select batch —</option>{(batches.data ?? []).map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select></div>
          </>
        )}
        {!isEdit && (level === 'course' || level === 'vertical') && (
          <>
            <div className="fld"><label>Branch <span className="star">*</span></label>
              <select className="ainp" value={branchId} onChange={(e) => { setBranchId(e.target.value); setVerticalId(''); setCourseId(''); }}>
                <option value="">— Select branch —</option>{ref_.branches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select></div>
            <div className="fld"><label>Vertical <span className="star">*</span></label>
              <select className="ainp" value={verticalId} onChange={(e) => { setVerticalId(e.target.value); setCourseId(''); }}>
                <option value="">— Select vertical —</option>{vOpts.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select></div>
            {level === 'course' && (
              <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Course <span className="star">*</span></label><MasterQuickAdd type="course" onAdded={(row) => setCourseId(String(row.id))} />
                <select className="ainp" value={courseId} onChange={(e) => setCourseId(e.target.value)}>
                  <option value="">— Select course —</option>{cOpts.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select></div>
            )}
          </>
        )}
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Title <span className="star">*</span></label><input className="ainp" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
        <div className="fld"><label>Type</label>
          <select className="ainp" value={type} onChange={(e) => setType(e.target.value)}>{MAT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select></div>
        <div className="fld"><label>Parents can view</label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}><input type="checkbox" checked={parents} onChange={(e) => setParents(e.target.checked)} /> Show in the parent view</label></div>
        {type !== 'note' && <div className="fld" style={{ gridColumn: '1 / -1' }}><label>{isLinkType ? 'Link / YouTube URL' : 'External link (optional)'} {isLinkType && <span className="star">*</span>}</label><input className="ainp" value={externalUrl} onChange={(e) => setExternalUrl(e.target.value)} placeholder="https://…" /></div>}
        {type !== 'note' && !isLinkType && <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Or upload a file (→ R2)</label>
          <input className="ainp" type="file" onChange={(e) => pickFile(e.target.files?.[0])} />
          {uploading ? <div className="sub">Uploading…</div> : (fileKey ? <div className="sub">Attached: {fileName} <a href="#" onClick={(e) => { e.preventDefault(); setFileKey(''); setFileName(''); }}>remove</a></div> : null)}</div>}
        {type === 'note' && <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Note content <span className="star">*</span></label><textarea className="ainp" rows={3} value={body} onChange={(e) => setBody(e.target.value)} /></div>}
        <div className="fld"><label>Tags</label><input className="ainp" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="comma,separated" /></div>
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Description</label><textarea className="ainp" rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} /></div>
      </div>{err && <div className="form-err" style={{ marginTop: 8 }}>{err}</div>}</div>
      <div className="af"><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || uploading} onClick={save}><Ic k="check" />{busy ? 'Saving…' : 'Save'}</button></div>
    </div></div>
  );
}

/* ==========================================================================
 * 2) CERTIFICATES
 * ======================================================================== */
export function CertificatesScreen() {
  const ref = useRef_();
  const { scope: gScope } = useScope();
  const { can } = useAuth();
  const [fB, setFB] = useState<number[]>(gScope.branches);
  const [fV, setFV] = useState<number[]>(gScope.verticals);
  const [fC, setFC] = useState<number[]>([]);
  const [ftype, setFtype] = useState('');
  const [fstat, setFstat] = useState('');
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const [tick, setTick] = useState(0);
  const [issue, setIssue] = useState(false);
  const [revoke, setRevoke] = useState<any | null>(null);
  const [reissue, setReissue] = useState<any | null>(null);
  const [del, setDel] = useState<any | null>(null);

  const qs = new URLSearchParams();
  if (fB.length) qs.set('branch_id', fB.join(','));
  if (fV.length) qs.set('vertical_id', fV.join(','));
  if (fC.length) qs.set('course_id', fC.join(','));
  if (ftype) qs.set('cert_type', ftype);
  if (fstat) qs.set('status', fstat);
  if (range.from) qs.set('from', range.from);
  if (range.to) qs.set('to', range.to);
  const list = useFetch<any[]>(`/learning/certificates?${qs.toString()}`, [qs.toString(), tick]);
  const after = () => setTick((t) => t + 1);
  const rows = list.data ?? [];
  const ids = rows.map((r: any) => Number(r.id));
  const { selected, count, tableSelect, clear } = useTableSelect(ids);
  const { openBulk, bulkModal } = useBulkDelete('Certificate', '/learning/certificates/bulk-delete/impact', '/learning/certificates/bulk-delete', () => { after(); clear(); });

  const doDelete = async () => { try { await api.del(`/learning/certificates/${del.id}`); toast('Certificate deleted'); setDel(null); after(); } catch (e: any) { toast(e.message, true); } };
  const doRevoke = async (reason: string) => { try { await api.post(`/learning/certificates/${revoke.id}/revoke`, { reason }); toast('Certificate revoked'); setRevoke(null); after(); } catch (e: any) { toast(e.message, true); } };
  const doReissue = async () => { try { const r = await api.post<any>(`/learning/certificates/${reissue.id}/reissue`, {}); toast(`Reissued as ${r.serial_no}`); setReissue(null); after(); } catch (e: any) { toast(e.message, true); } };

  return (
    <>
      {can('certificate.issue') && <div className="page-actions"><button className="btn primary" onClick={() => setIssue(true)}><Ic k="plus" />Issue certificate</button></div>}
      <ScopeFilters rd={ref} fB={fB} setFB={setFB} fV={fV} setFV={setFV} fC={fC} setFC={setFC}
        extra={<>
          <label className="fchip"><Ic k="doc" />
            <select value={ftype} onChange={(e) => setFtype(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }}>
              <option value="">All types</option>{CERT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
          <label className="fchip"><Ic k="shield" />
            <select value={fstat} onChange={(e) => setFstat(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }}>
              <option value="">All</option><option value="issued">Issued</option><option value="revoked">Revoked</option></select></label>
          <DateRange value={range} onChange={setRange} idPrefix="cert-dr" style={{ marginLeft: 'auto' }} />
        </>} />
      <BulkBar count={count} entityLabel="Certificate" onDelete={() => openBulk(selected)} onClear={clear} />
      <TableCard fill title="Certificates" icon="shield"
        select={can('certificate.delete') ? tableSelect : undefined}
        more={<ListActions onExport={() => downloadObjectsCsv('certificates.csv', rows)} onRefresh={after} />}
        cols={['Serial', 'Student', 'Title', 'Type', 'Course', 'Issued', 'Status', 'Actions']}
        empty="No certificates issued yet."
        rows={rows.map((ct: any) => [
          { mono: ct.serial_no } as Cell,
          { node: <div><b className="nm">{ct.student_name}</b><div className="sub mono">{ct.student_no ?? '—'}</div></div> } as Cell,
          ct.title,
          ct.cert_type,
          ct.course_name ?? '—',
          fmtFull(ct.issue_date),
          { b: [ct.status, ct.status === 'issued' ? 'b-green' : 'b-red'] } as Cell,
          rowActions({
            extra: [{ k: 'doc', title: 'Download PDF', onClick: () => openPdf(`/learning/certificates/${ct.id}/pdf`) },
              ...(can('certificate.issue') ? [{ k: 'refresh', title: 'Reissue (new serial)', onClick: () => setReissue(ct) }] : []),
              ...(can('certificate.revoke') && ct.status === 'issued' ? [{ k: 'shield', title: 'Revoke', onClick: () => setRevoke(ct) }] : [])],
            onDelete: can('certificate.delete') ? () => setDel(ct) : undefined,
          }),
        ])} />
      {issue && <IssueCertModal onClose={() => setIssue(false)} onSaved={after} ref_={ref} />}
      {revoke && <RevokeModal cert={revoke} onClose={() => setRevoke(null)} onConfirm={doRevoke} />}
      {reissue && <ConfirmModal title="Reissue certificate?" body={`Reissue "${reissue.title}" for ${reissue.student_name} with a fresh serial number?`} confirmLabel="Reissue" onConfirm={doReissue} onClose={() => setReissue(null)} />}
      {del && <ConfirmModal title="Delete certificate?" body={`Delete ${del.serial_no} for ${del.student_name}?`} danger confirmLabel="Delete" onConfirm={doDelete} onClose={() => setDel(null)} />}
      {bulkModal}
    </>
  );
}

function IssueCertModal({ onClose, onSaved, ref_ }: { onClose: () => void; onSaved: () => void; ref_: any }) {
  const [fB, setFB] = useState<number[]>([]);
  const [fV, setFV] = useState<number[]>([]);
  const students = useStudents(fB, fV);
  const [studentId, setStudentId] = useState('');
  const [type, setType] = useState('completion');
  const [title, setTitle] = useState('');
  const [issueDate, setIssueDate] = useState('');
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const vOpts = ref_.verticals.filter((v: any) => !fB.length || fB.includes(Number(v.branch_id)));

  const save = async () => {
    setErr('');
    if (!studentId) return setErr('Choose a student.');
    if (!title.trim()) return setErr('Give the certificate a title.');
    setBusy(true);
    try {
      const r = await api.post<any>('/learning/certificates', { student_id: Number(studentId), cert_type: type, title: title.trim(), issue_date: issueDate || null, remarks: remarks || null });
      toast(`Certificate ${r.serial_no} issued`); onSaved(); onClose();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="add-scrim"><div className="add-modal" style={{ maxWidth: 560 }}>
      <div className="ah"><h3><Ic k="shield" />Issue certificate</h3><button className="ax" onClick={onClose}><Ic k="x" /></button></div>
      <div className="abody">
        <div className="filters" style={{ marginBottom: 10 }}>
          <FilterMulti label="Branch" icon="branch" value={fB} options={ref_.branches} onChange={(v: number[]) => { setFB(v); setStudentId(''); }} />
          <FilterMulti label="Vertical" icon="grid" value={fV} options={vOpts} onChange={(v: number[]) => { setFV(v); setStudentId(''); }} />
        </div>
        <div className="form-grid">
          <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Student <span className="star">*</span></label>
            <select className="ainp" value={studentId} onChange={(e) => setStudentId(e.target.value)}>
              <option value="">— Select student —</option>
              {(students.data ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.full_name}{s.student_no ? ` (${s.student_no})` : ''}</option>)}
            </select></div>
          <div className="fld"><label>Type</label><select className="ainp" value={type} onChange={(e) => setType(e.target.value)}>{CERT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select></div>
          <div className="fld"><label>Issue date</label><input className="ainp" type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} /></div>
          <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Title <span className="star">*</span></label><input className="ainp" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Diploma in Spoken English" /></div>
          <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Remarks</label><input className="ainp" value={remarks} onChange={(e) => setRemarks(e.target.value)} /></div>
        </div>{err && <div className="form-err" style={{ marginTop: 8 }}>{err}</div>}
      </div>
      <div className="af"><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={save}><Ic k="check" />{busy ? 'Issuing…' : 'Issue'}</button></div>
    </div></div>
  );
}

function RevokeModal({ cert, onClose, onConfirm }: { cert: any; onClose: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <div className="add-scrim" style={{ zIndex: 320 }}><div className="add-modal" style={{ maxWidth: 460 }}>
      <div className="ah"><h3><Ic k="shield" />Revoke certificate</h3><button className="ax" onClick={onClose}><Ic k="x" /></button></div>
      <div className="abody">
        <div className="empty-note" style={{ marginBottom: 10 }}>Revoke <b>{cert.serial_no}</b> ({cert.title}) for {cert.student_name}? The PDF will show a REVOKED overlay.</div>
        <div className="fld"><label>Reason</label><input className="ainp" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional" /></div>
      </div>
      <div className="af"><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={() => onConfirm(reason)}><Ic k="shield" />Revoke</button></div>
    </div></div>
  );
}

/* ==========================================================================
 * 3) ACADEMIC PROGRESS (report cards + parent view)
 * ======================================================================== */
export function ReportCardsScreen() {
  const ref = useRef_();
  const { scope: gScope } = useScope();
  const { can } = useAuth();
  const [fB, setFB] = useState<number[]>(gScope.branches);
  const [fV, setFV] = useState<number[]>(gScope.verticals);
  const [fC, setFC] = useState<number[]>([]);
  const [fstat, setFstat] = useState('');
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const [tick, setTick] = useState(0);
  const [gen, setGen] = useState(false);
  const [view, setView] = useState<any | null>(null);
  const [del, setDel] = useState<any | null>(null);

  const qs = new URLSearchParams();
  if (fB.length) qs.set('branch_id', fB.join(','));
  if (fV.length) qs.set('vertical_id', fV.join(','));
  if (fC.length) qs.set('course_id', fC.join(','));
  if (fstat) qs.set('status', fstat);
  if (range.from) qs.set('from', range.from);
  if (range.to) qs.set('to', range.to);
  const list = useFetch<any[]>(`/learning/report-cards?${qs.toString()}`, [qs.toString(), tick]);
  const after = () => setTick((t) => t + 1);
  const rows = list.data ?? [];
  const ids = rows.map((r: any) => Number(r.id));
  const { selected, count, tableSelect, clear } = useTableSelect(ids);
  const { openBulk, bulkModal } = useBulkDelete('Report card', '/learning/report-cards/bulk-delete/impact', '/learning/report-cards/bulk-delete', () => { after(); clear(); });
  const doDelete = async () => { try { await api.del(`/learning/report-cards/${del.id}`); toast('Report card deleted'); setDel(null); after(); } catch (e: any) { toast(e.message, true); } };

  return (
    <>
      {can('reportcard.create') && <div className="page-actions"><button className="btn primary" onClick={() => setGen(true)}><Ic k="plus" />Generate report card</button></div>}
      <ScopeFilters rd={ref} fB={fB} setFB={setFB} fV={fV} setFV={setFV} fC={fC} setFC={setFC}
        extra={<>
          <label className="fchip"><Ic k="shield" />
            <select value={fstat} onChange={(e) => setFstat(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }}>
              <option value="">All</option><option value="published">Published</option><option value="draft">Draft</option></select></label>
          <DateRange value={range} onChange={setRange} idPrefix="rc-dr" style={{ marginLeft: 'auto' }} />
        </>} />
      <BulkBar count={count} entityLabel="Report card" onDelete={() => openBulk(selected)} onClear={clear} />
      <TableCard fill title="Report cards" icon="perf"
        select={can('reportcard.delete') ? tableSelect : undefined}
        more={<ListActions onExport={() => downloadObjectsCsv('report-cards.csv', rows)} onRefresh={after} />}
        cols={['Student', 'Term', 'Attendance', 'Tests', 'Assign.', 'Overall', 'Grade', 'Status', 'Actions']}
        empty="No report cards yet — generate one for a student."
        onRowClick={(i) => setView(rows[i])}
        rows={rows.map((rc: any) => [
          { node: <div><b className="nm">{rc.student_name}</b><div className="sub mono">{rc.student_no ?? '—'}</div></div> } as Cell,
          rc.term,
          rc.attendance_pct != null ? `${rc.attendance_pct}%` : '—',
          rc.test_avg_pct != null ? `${rc.test_avg_pct}%` : '—',
          rc.assignment_avg_pct != null ? `${rc.assignment_avg_pct}%` : '—',
          rc.overall_pct != null ? `${rc.overall_pct}%` : '—',
          rc.overall_grade ?? '—',
          { b: [rc.status, rc.status === 'published' ? 'b-green' : 'b-gray'] } as Cell,
          rowActions({
            onView: () => setView(rc),
            extra: [{ k: 'doc', title: 'PDF', onClick: () => openPdf(`/learning/report-cards/${rc.id}/pdf`) }],
            onDelete: can('reportcard.delete') ? () => setDel(rc) : undefined,
          }),
        ])} />
      {gen && <GenerateReportModal onClose={() => setGen(false)} onSaved={after} ref_={ref} />}
      {view && <ReportCardModal card={view} onClose={() => setView(null)} onChanged={after} />}
      {del && <ConfirmModal title="Delete report card?" body={`Delete ${del.student_name}'s "${del.term}" report card?`} danger confirmLabel="Delete" onConfirm={doDelete} onClose={() => setDel(null)} />}
      {bulkModal}
    </>
  );
}

function GenerateReportModal({ onClose, onSaved, ref_ }: { onClose: () => void; onSaved: () => void; ref_: any }) {
  const [fB, setFB] = useState<number[]>([]);
  const [fV, setFV] = useState<number[]>([]);
  const students = useStudents(fB, fV);
  const [studentId, setStudentId] = useState('');
  const [term, setTerm] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const vOpts = ref_.verticals.filter((v: any) => !fB.length || fB.includes(Number(v.branch_id)));

  const pv = new URLSearchParams();
  if (studentId) pv.set('student_id', studentId);
  if (from) pv.set('from', from);
  if (to) pv.set('to', to);
  const preview = useFetch<any>(studentId ? `/learning/report-cards/preview?${pv.toString()}` : null, [pv.toString()]);
  const p = preview.data;

  const save = async () => {
    setErr('');
    if (!studentId) return setErr('Choose a student.');
    if (!term.trim()) return setErr('Give the report a term name (e.g. "Term 1 2026").');
    setBusy(true);
    try {
      await api.post('/learning/report-cards', { student_id: Number(studentId), term: term.trim(), period_from: from || null, period_to: to || null, remarks: remarks || null });
      toast('Report card generated'); onSaved(); onClose();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="add-scrim"><div className="add-modal" style={{ maxWidth: 580 }}>
      <div className="ah"><h3><Ic k="perf" />Generate report card</h3><button className="ax" onClick={onClose}><Ic k="x" /></button></div>
      <div className="abody">
        <div className="filters" style={{ marginBottom: 10 }}>
          <FilterMulti label="Branch" icon="branch" value={fB} options={ref_.branches} onChange={(v: number[]) => { setFB(v); setStudentId(''); }} />
          <FilterMulti label="Vertical" icon="grid" value={fV} options={vOpts} onChange={(v: number[]) => { setFV(v); setStudentId(''); }} />
        </div>
        <div className="form-grid">
          <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Student <span className="star">*</span></label>
            <select className="ainp" value={studentId} onChange={(e) => setStudentId(e.target.value)}>
              <option value="">— Select student —</option>
              {(students.data ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.full_name}{s.student_no ? ` (${s.student_no})` : ''}</option>)}
            </select></div>
          <div className="fld"><label>Term / period name <span className="star">*</span></label><input className="ainp" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Term 1 2026" /></div>
          <div className="fld"><label>From</label><input className="ainp" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="fld"><label>To</label><input className="ainp" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Remarks</label><input className="ainp" value={remarks} onChange={(e) => setRemarks(e.target.value)} /></div>
        </div>
        {studentId && p && (
          <Kpis items={[
            { lab: 'Attendance', val: p.attendance_pct != null ? `${p.attendance_pct}%` : '—', ic: 'check' },
            { lab: 'Test avg', val: p.test_avg_pct != null ? `${p.test_avg_pct}%` : '—', ic: 'doc' },
            { lab: 'Assignment avg', val: p.assignment_avg_pct != null ? `${p.assignment_avg_pct}%` : '—', ic: 'list' },
            { lab: 'Overall', val: p.overall_pct != null ? `${p.overall_pct}% (${p.overall_grade ?? '—'})` : '—', ic: 'perf' },
          ]} />
        )}
        {err && <div className="form-err" style={{ marginTop: 8 }}>{err}</div>}
      </div>
      <div className="af"><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={save}><Ic k="check" />{busy ? 'Generating…' : 'Generate'}</button></div>
    </div></div>
  );
}

function ReportCardModal({ card, onClose, onChanged }: { card: any; onClose: () => void; onChanged: () => void }) {
  const { can } = useAuth();
  const detail = useFetch<any>(`/learning/report-cards/${card.id}`, [card.id]);
  const d = detail.data ?? card;
  const [token, setToken] = useState<string>(card.share_token ?? '');
  const published = (detail.data?.status ?? card.status) === 'published';
  const shareUrl = token ? `${window.location.origin}/parent/report/${token}` : '';

  const publish = async (on: boolean) => {
    try { const r = await api.post<any>(`/learning/report-cards/${card.id}/publish`, { publish: on }); setToken(r.share_token ?? ''); toast(on ? 'Published — parent link ready' : 'Unpublished'); detail.reload(); onChanged(); }
    catch (e: any) { toast(e.message, true); }
  };
  return (
    <DetailModal title={`Report card — ${d.student_name}`} icon="perf" width={620} onClose={onClose}
      footer={<>
        <button className="btn" onClick={() => openPdf(`/learning/report-cards/${card.id}/pdf`)}><Ic k="doc" />PDF</button>
        {can('reportcard.create') && (published
          ? <button className="btn" onClick={() => publish(false)}><Ic k="x" />Unpublish</button>
          : <button className="btn primary" onClick={() => publish(true)}><Ic k="shield" />Publish for parent</button>)}
      </>}>
      <div className="page-sub" style={{ marginBottom: 10 }}>{d.term} · {d.course_name ?? '—'}{d.batch_name ? ` · ${d.batch_name}` : ''}</div>
      <Kpis items={[
        { lab: 'Attendance', val: d.attendance_pct != null ? `${d.attendance_pct}%` : '—', ic: 'check' },
        { lab: 'Test avg', val: d.test_avg_pct != null ? `${d.test_avg_pct}%` : '—', ic: 'doc' },
        { lab: 'Assignment avg', val: d.assignment_avg_pct != null ? `${d.assignment_avg_pct}%` : '—', ic: 'list' },
        { lab: 'Overall', val: d.overall_pct != null ? `${d.overall_pct}% (${d.overall_grade ?? '—'})` : '—', ic: 'perf' },
      ]} />
      {d.remarks && <div className="empty-note" style={{ marginTop: 10 }}><b>Remarks:</b> {d.remarks}</div>}
      {published && shareUrl && (
        <div className="sheet-sec" style={{ marginTop: 12 }}>
          <h5>Parent view link</h5>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input className="ainp" readOnly value={shareUrl} style={{ flex: 1 }} />
            <button className="btn" onClick={() => { navigator.clipboard?.writeText(shareUrl); toast('Link copied'); }}>Copy</button>
            <button className="btn" onClick={() => window.open(shareUrl, '_blank', 'noopener')}>Open</button>
          </div>
          <div className="empty-note" style={{ marginTop: 8 }}>Share this link with the parent/guardian — it opens a read-only report card, attendance and the parent-visible study material. No login required.</div>
        </div>
      )}
    </DetailModal>
  );
}

/* ==========================================================================
 * PARENT VIEW (public, tokenised) — rendered by App at /parent/report/:token
 * ======================================================================== */
export function ParentReportView({ token }: { token: string }) {
  const data = useFetch<any>(`/public/report-card/${token}`, [token]);
  const d = data.data;
  if (data.loading) return <div className="notice" style={{ margin: 40 }}><Ic k="clock" /><div>Loading…</div></div>;
  if (!d) return <div className="notice" style={{ margin: 40 }}><Ic k="shield" /><div>This report card link is invalid or has been unpublished.</div></div>;
  const rc = d.report_card;
  return (
    <div style={{ maxWidth: 760, margin: '24px auto', padding: '0 16px' }}>
      <div className="card" style={{ padding: 20 }}>
        <h2 style={{ marginTop: 0 }}>{d.vertical_name || d.org_name}</h2>
        <div className="page-sub">{d.branch_name ? `${d.branch_name} · ` : ''}Report card for {d.student_name}{d.student_no ? ` (${d.student_no})` : ''}</div>
        <div className="page-sub" style={{ marginBottom: 12 }}>{rc.term}{d.course_name ? ` · ${d.course_name}` : ''}{d.batch_name ? ` · ${d.batch_name}` : ''}</div>
        <Kpis items={[
          { lab: 'Attendance', val: rc.attendance_pct != null ? `${rc.attendance_pct}%` : '—', ic: 'check' },
          { lab: 'Test avg', val: rc.test_avg_pct != null ? `${rc.test_avg_pct}%` : '—', ic: 'doc' },
          { lab: 'Assignment avg', val: rc.assignment_avg_pct != null ? `${rc.assignment_avg_pct}%` : '—', ic: 'list' },
          { lab: 'Overall', val: rc.overall_pct != null ? `${rc.overall_pct}% (${rc.overall_grade ?? '—'})` : '—', ic: 'perf' },
        ]} />
        {rc.remarks && <div className="empty-note" style={{ marginTop: 10 }}><b>Remarks:</b> {rc.remarks}</div>}
        <div style={{ marginTop: 14 }}>
          <button className="btn primary" onClick={() => window.open(`/api/public/report-card/${token}/pdf`, '_blank', 'noopener')}><Ic k="doc" />Download PDF</button>
        </div>
      </div>
      <div className="card" style={{ padding: 20, marginTop: 16 }}>
        <h3><Ic k="doc" />Study material</h3>
        {(d.materials ?? []).length === 0 ? <div className="empty-note">No study material has been shared for parents yet.</div>
          : (d.materials ?? []).map((m: any) => (
            <div className="lrow" key={m.id}>
              <div className="gr"><div className="t1"><b>{m.title}</b> <span className="sub">({m.material_type})</span></div>
                <div className="t2">{m.course_name ?? m.batch_name ?? ''}{m.url ? <> · <a href={m.url} target="_blank" rel="noopener noreferrer">Open</a></> : null}</div></div>
            </div>
          ))}
      </div>
    </div>
  );
}
