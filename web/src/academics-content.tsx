/**
 * Students & Academics — Academics Governance Batch 2 UI: Course Content + Syllabus.
 *
 * Two governed content screens that reuse the Batch-1 approval workflow (draft ->
 * pending_approval -> published; reject -> changes_requested; unpublish). Each carries the FULL
 * list treatment (multi-select Branch/Vertical/Course + Status filters, Export values-not-ids,
 * column chooser, Refresh, bulk-delete) and permission-conditioned workflow controls: a user
 * with *.submit (Trainer) sees "Submit for approval" on their drafts; a user with *.approve
 * (Academic Admin) sees Approve / Reject / Unpublish. Files upload straight to Cloudflare R2 via
 * a presigned PUT (the row stores only the r2_key); links / YouTube use external_url.
 */
import { useMemo, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, TableCard } from './renderer';
import { toast, useFetch, useRef_ } from './refdata';
import { rowActions, ConfirmModal } from './rowactions';
import { DateRange } from './daterange';
import { useScope } from './scope';
import { FilterMulti } from './dyn';
import { ListActions, downloadObjectsCsv, useTableSelect, BulkBar, useBulkDelete } from './listtools';

/* ------------------------------------------------------------ shared bits -- */

const WF_BADGE: Record<string, string> = {
  draft: 'b-gray', pending_approval: 'b-amber', published: 'b-green',
  changes_requested: 'b-rose', unpublished: 'b-gray',
};
const WF_LABEL: Record<string, string> = {
  draft: 'Draft', pending_approval: 'Pending approval', published: 'Published',
  changes_requested: 'Changes requested', unpublished: 'Unpublished',
};
const WF_OPTS = ['draft', 'pending_approval', 'published', 'changes_requested', 'unpublished'];

/** Upload a file straight to R2 via a presigned PUT; returns the r2_key. */
async function uploadToR2(base: string, file: File): Promise<string> {
  const { url, r2_key } = await api.post<{ url: string; r2_key: string }>(`${base}/upload-url`, {
    file_name: file.name, content_type: file.type || 'application/octet-stream',
  });
  const res = await fetch(url, { method: 'PUT', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);
  return r2_key;
}

function useBatches(branchIds: number[], verticalIds: number[]) {
  const p = new URLSearchParams();
  if (branchIds.length) p.set('branch_id', branchIds.join(','));
  if (verticalIds.length) p.set('vertical_id', verticalIds.join(','));
  return useFetch<any[]>(`/batches?${p.toString()}`, [p.toString()]);
}

/** Branch + Vertical + Course + Status FilterMulti row shared by both screens. */
function ScopeFilters({ rd, fB, setFB, fV, setFV, fC, setFC, status, setStatus, canApprove, canSubmit, mine, setMine, range, setRange, idPrefix }: any) {
  const vOpts = rd.verticals.filter((vt: any) => !fB.length || fB.includes(Number(vt.branch_id)));
  const cOpts = rd.courses.filter((c: any) => (!fV.length || fV.includes(Number(c.vertical_id))) && (!fB.length || fB.includes(Number(c.branch_id))));
  return (
    <div className="filters">
      <FilterMulti label="Branch" icon="branch" value={fB} options={rd.branches}
        onChange={(v: number[]) => { setFB(v); setFV((cur: number[]) => cur.filter((id: number) => rd.verticals.some((vt: any) => Number(vt.id) === id && v.includes(Number(vt.branch_id))))); }} />
      <FilterMulti label="Vertical" icon="grid" value={fV} options={vOpts} onChange={setFV} />
      <FilterMulti label="Course" icon="doc" value={fC} options={cOpts} onChange={setFC} />
      {/* Status filter is available to everyone: a non-approver now gets their OWN draft/pending/
          changes_requested rows back from the API, so the status filter is meaningful for them too. */}
      <label className="fchip"><Ic k="shield" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }}>
          <option value="">All statuses</option>{WF_OPTS.map((s) => <option key={s} value={s}>{WF_LABEL[s]}</option>)}
        </select></label>
      {/* Creator-focused quick views: "Mine" + a one-click "Needs changes" (rejected-with-remarks) list. */}
      {canSubmit && !canApprove && setMine && (
        <>
          <button type="button" className={'fchip' + (mine ? ' on' : '')} onClick={() => setMine((m: boolean) => !m)}><Ic k="users" />Mine</button>
          <button type="button" className={'fchip' + (status === 'changes_requested' ? ' on' : '')}
            onClick={() => { setMine(true); setStatus(status === 'changes_requested' ? '' : 'changes_requested'); }}><Ic k="flag" />Needs changes</button>
        </>
      )}
      <DateRange value={range} onChange={setRange} idPrefix={idPrefix} style={{ marginLeft: 'auto' }} />
    </div>
  );
}

/** The permission-conditioned workflow row actions shared by both screens. */
function workflowActions(mod: string, r: any, can: (p: string) => boolean, wf: (r: any, verb: string, label: string) => void, onReject: (r: any) => void) {
  const s = r.workflow_status;
  const extra: any[] = [];
  if (can(`${mod}.submit`) && !can(`${mod}.approve`) && (s === 'draft' || s === 'changes_requested' || s === 'unpublished')) {
    extra.push({ k: 'send', title: 'Submit for approval', onClick: () => wf(r, 'submit', 'Submitted for approval') });
  }
  if (can(`${mod}.approve`)) {
    if (s === 'pending_approval') {
      extra.push({ k: 'check', title: 'Approve & publish', onClick: () => wf(r, 'approve', 'Approved — published') });
      extra.push({ k: 'x', title: 'Reject (send back with remarks)', onClick: () => onReject(r) });
    }
    if (s === 'draft' || s === 'changes_requested' || s === 'unpublished') {
      extra.push({ k: 'check', title: 'Publish', onClick: () => wf(r, 'approve', 'Published') });
    }
    if (s === 'published') {
      extra.push({ k: 'restore', title: 'Unpublish', onClick: () => wf(r, 'unpublish', 'Unpublished') });
    }
  }
  return extra;
}

/* ==========================================================================
 * 1) COURSE CONTENT
 * ======================================================================== */
export function CourseContentScreen() {
  const ref = useRef_();
  const { scope: gScope } = useScope();
  const { can } = useAuth();
  const canApprove = can('course_content.approve');
  const canSubmit = can('course_content.submit');
  const [fB, setFB] = useState<number[]>(gScope.branches);
  const [fV, setFV] = useState<number[]>(gScope.verticals);
  const [fC, setFC] = useState<number[]>([]);
  const [status, setStatus] = useState('');
  const [mine, setMine] = useState(false);
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const [tick, setTick] = useState(0);
  const [add, setAdd] = useState(false);
  const [edit, setEdit] = useState<any | null>(null);
  const [del, setDel] = useState<any | null>(null);
  const [reject, setReject] = useState<any | null>(null);

  const qs = new URLSearchParams();
  if (fB.length) qs.set('branch_id', fB.join(','));
  if (fV.length) qs.set('vertical_id', fV.join(','));
  if (fC.length) qs.set('course_id', fC.join(','));
  if (status) qs.set('status', status);
  if (mine) qs.set('mine', '1');
  const list = useFetch<any[]>(`/course-contents?${qs.toString()}`, [qs.toString(), tick]);
  const after = () => setTick((t) => t + 1);
  const rows = list.data ?? [];
  const ids = rows.map((r: any) => Number(r.id));
  const { selected, count, tableSelect, clear } = useTableSelect(ids);
  const { openBulk, bulkModal } = useBulkDelete('Course content', '/course-contents/bulk-delete/impact', '/course-contents/bulk-delete', () => { after(); clear(); });
  const doDelete = async () => { try { await api.del(`/course-contents/${del.id}`); toast('Deleted'); setDel(null); after(); } catch (e: any) { toast(e.message, true); } };
  const doReject = async (remarks: string) => { try { await api.post(`/course-contents/${reject.id}/reject`, { remarks }); toast('Sent back with remarks'); setReject(null); after(); } catch (e: any) { toast(e.message, true); } };
  const wf = async (r: any, verb: string, label: string) => { try { await api.post(`/course-contents/${r.id}/${verb}`, {}); toast(label); after(); } catch (e: any) { toast(e.message, true); } };

  return (
    <>
      {can('course_content.create') && <div className="page-actions"><button className="btn primary" onClick={() => setAdd(true)}><Ic k="plus" />New content</button></div>}
      <ScopeFilters rd={ref} fB={fB} setFB={setFB} fV={fV} setFV={setFV} fC={fC} setFC={setFC} status={status} setStatus={setStatus} canApprove={canApprove} canSubmit={canSubmit} mine={mine} setMine={setMine} range={range} setRange={setRange} idPrefix="cc-dr" />
      <BulkBar count={count} entityLabel="Course content" onDelete={() => openBulk(selected)} onClear={clear} />
      <TableCard fill title="Course content" icon="doc"
        select={can('course_content.delete') ? tableSelect : undefined}
        more={<ListActions onExport={() => downloadObjectsCsv('course-content.csv', rows)} onRefresh={after} />}
        cols={['Title', 'Module', 'Course', 'Batch', 'File / Link', 'Status', 'Actions']}
        empty="No course content yet — add a lesson/unit for a course."
        rows={rows.map((r: any) => [
          { node: <div><b className="nm">{r.title}</b>{r.review_remarks && r.workflow_status === 'changes_requested' ? <div className="sub" style={{ color: 'var(--danger)' }}>↩ {r.review_remarks}</div> : null}</div> } as Cell,
          `#${r.module_no}`,
          r.course_name ?? '—',
          r.batch_name ?? '—',
          { node: r.file_r2_key ? <a href="#" onClick={async (e) => { e.preventDefault(); try { const d = await api.get<any>(`/course-contents/${r.id}`); if (d.file_url) window.open(d.file_url, '_blank', 'noopener'); } catch (er: any) { toast(er.message, true); } }}>File</a> : (r.external_url ? <a href={r.external_url} target="_blank" rel="noopener noreferrer">Link</a> : '—') } as Cell,
          { b: [WF_LABEL[r.workflow_status] ?? r.workflow_status, WF_BADGE[r.workflow_status] ?? 'b-gray'] } as Cell,
          rowActions({
            onEdit: can('course_content.update') ? () => setEdit(r) : undefined,
            onDelete: can('course_content.delete') ? () => setDel(r) : undefined,
            extra: workflowActions('course_content', r, can, wf, setReject),
          }),
        ])} />
      {add && <ContentModal kind="course_content" base="/course-contents" onClose={() => setAdd(false)} onSaved={after} ref_={ref} />}
      {edit && <ContentModal kind="course_content" base="/course-contents" initial={edit} onClose={() => setEdit(null)} onSaved={after} ref_={ref} />}
      {del && <ConfirmModal title="Delete content?" body={`Delete "${del.title}"?`} danger confirmLabel="Delete" onConfirm={doDelete} onClose={() => setDel(null)} />}
      {reject && <RejectModal item={reject} onClose={() => setReject(null)} onConfirm={doReject} />}
      {bulkModal}
    </>
  );
}

/* ==========================================================================
 * 2) SYLLABUS
 * ======================================================================== */
export function SyllabusScreen() {
  const ref = useRef_();
  const { scope: gScope } = useScope();
  const { can } = useAuth();
  const canApprove = can('syllabus.approve');
  const canSubmit = can('syllabus.submit');
  const [fB, setFB] = useState<number[]>(gScope.branches);
  const [fV, setFV] = useState<number[]>(gScope.verticals);
  const [fC, setFC] = useState<number[]>([]);
  const [status, setStatus] = useState('');
  const [mine, setMine] = useState(false);
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const [tick, setTick] = useState(0);
  const [add, setAdd] = useState(false);
  const [edit, setEdit] = useState<any | null>(null);
  const [del, setDel] = useState<any | null>(null);
  const [reject, setReject] = useState<any | null>(null);

  const qs = new URLSearchParams();
  if (fB.length) qs.set('branch_id', fB.join(','));
  if (fV.length) qs.set('vertical_id', fV.join(','));
  if (fC.length) qs.set('course_id', fC.join(','));
  if (status) qs.set('status', status);
  if (mine) qs.set('mine', '1');
  const list = useFetch<any[]>(`/syllabi?${qs.toString()}`, [qs.toString(), tick]);
  const after = () => setTick((t) => t + 1);
  const rows = list.data ?? [];
  const ids = rows.map((r: any) => Number(r.id));
  const { selected, count, tableSelect, clear } = useTableSelect(ids);
  const { openBulk, bulkModal } = useBulkDelete('Syllabus', '/syllabi/bulk-delete/impact', '/syllabi/bulk-delete', () => { after(); clear(); });
  const doDelete = async () => { try { await api.del(`/syllabi/${del.id}`); toast('Deleted'); setDel(null); after(); } catch (e: any) { toast(e.message, true); } };
  const doReject = async (remarks: string) => { try { await api.post(`/syllabi/${reject.id}/reject`, { remarks }); toast('Sent back with remarks'); setReject(null); after(); } catch (e: any) { toast(e.message, true); } };
  const wf = async (r: any, verb: string, label: string) => { try { await api.post(`/syllabi/${r.id}/${verb}`, {}); toast(label); after(); } catch (e: any) { toast(e.message, true); } };

  return (
    <>
      {can('syllabus.create') && <div className="page-actions"><button className="btn primary" onClick={() => setAdd(true)}><Ic k="plus" />New syllabus</button></div>}
      <ScopeFilters rd={ref} fB={fB} setFB={setFB} fV={fV} setFV={setFV} fC={fC} setFC={setFC} status={status} setStatus={setStatus} canApprove={canApprove} canSubmit={canSubmit} mine={mine} setMine={setMine} range={range} setRange={setRange} idPrefix="sy-dr" />
      <BulkBar count={count} entityLabel="Syllabus" onDelete={() => openBulk(selected)} onClear={clear} />
      <TableCard fill title="Syllabus" icon="list"
        select={can('syllabus.delete') ? tableSelect : undefined}
        more={<ListActions onExport={() => downloadObjectsCsv('syllabus.csv', rows)} onRefresh={after} />}
        cols={['Title', 'Version', 'Course', 'Batch', 'File / Link', 'Status', 'Actions']}
        empty="No syllabus yet — add one for a course."
        rows={rows.map((r: any) => [
          { node: <div><b className="nm">{r.title}</b>{r.review_remarks && r.workflow_status === 'changes_requested' ? <div className="sub" style={{ color: 'var(--danger)' }}>↩ {r.review_remarks}</div> : null}</div> } as Cell,
          { mono: r.version } as Cell,
          r.course_name ?? '—',
          r.batch_name ?? '—',
          { node: r.file_r2_key ? <a href="#" onClick={async (e) => { e.preventDefault(); try { const d = await api.get<any>(`/syllabi/${r.id}`); if (d.file_url) window.open(d.file_url, '_blank', 'noopener'); } catch (er: any) { toast(er.message, true); } }}>File</a> : (r.external_url ? <a href={r.external_url} target="_blank" rel="noopener noreferrer">Link</a> : '—') } as Cell,
          { b: [WF_LABEL[r.workflow_status] ?? r.workflow_status, WF_BADGE[r.workflow_status] ?? 'b-gray'] } as Cell,
          rowActions({
            onEdit: can('syllabus.update') ? () => setEdit(r) : undefined,
            onDelete: can('syllabus.delete') ? () => setDel(r) : undefined,
            extra: workflowActions('syllabus', r, can, wf, setReject),
          }),
        ])} />
      {add && <ContentModal kind="syllabus" base="/syllabi" onClose={() => setAdd(false)} onSaved={after} ref_={ref} />}
      {edit && <ContentModal kind="syllabus" base="/syllabi" initial={edit} onClose={() => setEdit(null)} onSaved={after} ref_={ref} />}
      {del && <ConfirmModal title="Delete syllabus?" body={`Delete "${del.title}"?`} danger confirmLabel="Delete" onConfirm={doDelete} onClose={() => setDel(null)} />}
      {reject && <RejectModal item={reject} onClose={() => setReject(null)} onConfirm={doReject} />}
      {bulkModal}
    </>
  );
}

/* ------------------------------------------------------------- shared modal */

function ContentModal({ kind, base, initial, onClose, onSaved, ref_ }: { kind: 'course_content' | 'syllabus'; base: string; initial?: any; onClose: () => void; onSaved: () => void; ref_: any }) {
  const isEdit = !!initial?.id;
  const isSyl = kind === 'syllabus';
  const [branchId, setBranchId] = useState<string>(String(initial?.branch_id ?? ''));
  const [verticalId, setVerticalId] = useState<string>(String(initial?.vertical_id ?? ''));
  const [courseId, setCourseId] = useState<string>(String(initial?.course_id ?? ''));
  const [batchId, setBatchId] = useState<string>(String(initial?.batch_id ?? ''));
  const [title, setTitle] = useState<string>(initial?.title ?? '');
  const [moduleNo, setModuleNo] = useState<string>(String(initial?.module_no ?? '1'));
  const [version, setVersion] = useState<string>(initial?.version ?? 'v1');
  const [text, setText] = useState<string>(isSyl ? (initial?.body ?? '') : (initial?.description ?? ''));
  const [externalUrl, setExternalUrl] = useState<string>(initial?.external_url ?? '');
  const [fileKey, setFileKey] = useState<string>(initial?.file_r2_key ?? '');
  const [fileName, setFileName] = useState<string>(initial?.file_r2_key ? 'Attached file' : '');
  const [tags, setTags] = useState<string>(Array.isArray(initial?.tags) ? initial.tags.join(', ') : (initial?.tags ?? ''));
  const [busy, setBusy] = useState(false); const [uploading, setUploading] = useState(false); const [err, setErr] = useState('');

  const vOpts = ref_.verticals.filter((v: any) => !branchId || Number(v.branch_id) === Number(branchId));
  const cOpts = ref_.courses.filter((c: any) => (!verticalId || Number(c.vertical_id) === Number(verticalId)) && (!branchId || Number(c.branch_id) === Number(branchId)));
  const batches = useBatches(branchId ? [Number(branchId)] : [], verticalId ? [Number(verticalId)] : []);

  const pickFile = async (f?: File | null) => {
    if (!f) return;
    setUploading(true); setErr('');
    try { const key = await uploadToR2(base, f); setFileKey(key); setFileName(f.name); }
    catch (e: any) { setErr(e.message); } finally { setUploading(false); }
  };

  const save = async () => {
    setErr('');
    if (!title.trim()) return setErr('Give it a title.');
    if (!isEdit && (!branchId || !verticalId || !courseId)) return setErr('Choose a branch, vertical and course.');
    setBusy(true);
    const base_body: any = {
      title: title.trim(),
      external_url: externalUrl.trim() || null,
      file_r2_key: fileKey || null,
      tags: tags.trim() || null,
      batch_id: batchId ? Number(batchId) : null,
    };
    if (isSyl) { base_body.version = version.trim() || 'v1'; base_body.body = text || null; }
    else { base_body.module_no = Number(moduleNo) || 1; base_body.description = text || null; }
    if (!isEdit) { base_body.course_id = Number(courseId); base_body.branch_id = Number(branchId); base_body.vertical_id = Number(verticalId); }
    try {
      if (isEdit) await api.patch(`${base}/${initial.id}`, base_body);
      else await api.post(base, base_body);
      toast(isEdit ? 'Saved' : 'Created (draft)'); onSaved(); onClose();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim"><div className="add-modal" style={{ maxWidth: 640 }}>
      <div className="ah"><h3><Ic k={isSyl ? 'list' : 'doc'} />{isEdit ? 'Edit' : 'New'} {isSyl ? 'syllabus' : 'course content'}</h3><button className="ax" onClick={onClose}><Ic k="x" /></button></div>
      <div className="abody"><div className="form-grid">
        {!isEdit && (
          <>
            <div className="fld"><label>Branch <span className="star">*</span></label>
              <select className="ainp" value={branchId} onChange={(e) => { setBranchId(e.target.value); setVerticalId(''); setCourseId(''); setBatchId(''); }}>
                <option value="">— Select branch —</option>{ref_.branches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select></div>
            <div className="fld"><label>Vertical <span className="star">*</span></label>
              <select className="ainp" value={verticalId} onChange={(e) => { setVerticalId(e.target.value); setCourseId(''); setBatchId(''); }}>
                <option value="">— Select vertical —</option>{vOpts.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select></div>
            <div className="fld"><label>Course <span className="star">*</span></label>
              <select className="ainp" value={courseId} onChange={(e) => setCourseId(e.target.value)}>
                <option value="">— Select course —</option>{cOpts.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></div>
            <div className="fld"><label>Batch (optional)</label>
              <select className="ainp" value={batchId} onChange={(e) => setBatchId(e.target.value)}>
                <option value="">— Whole course —</option>{(batches.data ?? []).map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select></div>
          </>
        )}
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Title <span className="star">*</span></label><input className="ainp" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
        {isSyl
          ? <div className="fld"><label>Version</label><input className="ainp" value={version} onChange={(e) => setVersion(e.target.value)} placeholder="v1" /></div>
          : <div className="fld"><label>Module / unit no</label><input className="ainp" type="number" value={moduleNo} onChange={(e) => setModuleNo(e.target.value)} /></div>}
        {isEdit && <div className="fld"><label>Batch (optional)</label>
          <select className="ainp" value={batchId} onChange={(e) => setBatchId(e.target.value)}>
            <option value="">— Whole course —</option>{(batches.data ?? []).map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select></div>}
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>{isSyl ? 'Syllabus outline' : 'Lesson content'}</label>
          <textarea className="ainp" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={isSyl ? 'Unit 1: …\nUnit 2: …' : 'Lesson body (rich text)'} /></div>
        <div className="fld"><label>External / YouTube link</label><input className="ainp" value={externalUrl} onChange={(e) => setExternalUrl(e.target.value)} placeholder="https://…" /></div>
        <div className="fld"><label>Or upload a file (→ R2)</label>
          <input className="ainp" type="file" onChange={(e) => pickFile(e.target.files?.[0])} />
          {uploading ? <div className="sub">Uploading…</div> : (fileKey ? <div className="sub">Attached: {fileName} <a href="#" onClick={(e) => { e.preventDefault(); setFileKey(''); setFileName(''); }}>remove</a></div> : null)}</div>
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Tags</label><input className="ainp" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="comma,separated" /></div>
      </div>{err && <div className="form-err" style={{ marginTop: 8 }}>{err}</div>}</div>
      <div className="af"><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || uploading} onClick={save}><Ic k="check" />{busy ? 'Saving…' : 'Save'}</button></div>
    </div></div>
  );
}

function RejectModal({ item, onClose, onConfirm }: { item: any; onClose: () => void; onConfirm: (remarks: string) => void }) {
  const [remarks, setRemarks] = useState('');
  return (
    <div className="add-scrim" style={{ zIndex: 320 }}><div className="add-modal" style={{ maxWidth: 460 }}>
      <div className="ah"><h3><Ic k="x" />Send back for changes</h3><button className="ax" onClick={onClose}><Ic k="x" /></button></div>
      <div className="abody">
        <div className="empty-note" style={{ marginBottom: 10 }}>Send <b>{item.title}</b> back to the trainer with remarks. It returns to draft.</div>
        <div className="fld"><label>Remarks <span className="star">*</span></label><textarea className="ainp" rows={3} value={remarks} onChange={(e) => setRemarks(e.target.value)} /></div>
      </div>
      <div className="af"><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!remarks.trim()} onClick={() => onConfirm(remarks)}><Ic k="send" />Send back</button></div>
    </div></div>
  );
}
