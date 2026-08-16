/**
 * Students & Academics — ERP Batch 3 (Admissions) UI.
 *
 *  · AdmissionsScreen  — the staff REVIEW QUEUE with the FULL list treatment (multi-select
 *    FilterMulti filters branch/vertical/course/status + date range, Export values-not-ids,
 *    column chooser via TableCard fill+title, Refresh, bulk-delete). Row → open a submission,
 *    edit it, APPROVE → creates the student, or REJECT with a reason. A "Form links" button
 *    opens the manager for the PUBLIC form links (generate / copy URL / activate / regenerate
 *    key / delete). Every admission API route has a caller here (route-reachability guard).
 *  · PublicAdmissionForm — the login-free self-serve form a prospective student fills; it POSTs
 *    to the public keyed endpoint and lands a PENDING admission.
 */
import { useMemo, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, TableCard } from './renderer';
import { toast, useFetch, useRef_ } from './refdata';
import { MasterQuickAdd } from './forms';
import { rowActions, ConfirmModal, DetailModal, Section, KV } from './rowactions';
import { DateRange } from './daterange';
import { useScope } from './scope';
import { FilterMulti } from './dyn';
import { DOC_ACCEPT, DOC_MAX_FILES, SINGLE_DOCS, docError, fileToDoc, DocumentList } from './documents';
import { ListActions, downloadObjectsCsv, useTableSelect, BulkBar, useBulkDelete } from './listtools';

const STATUS_CELL = (s: string): Cell =>
  ({ b: [s === 'approved' ? 'Approved' : s === 'rejected' ? 'Rejected' : 'Pending',
       s === 'approved' ? 'b-green' : s === 'rejected' ? 'b-rose' : 'b-amber'] });


/** Branch + Vertical + Course FilterMulti row (local copy of the learning-screen filter). */
function ScopeFilters({ rd, fB, setFB, fV, setFV, fC, setFC, extra }: any) {
  const vOpts = rd.verticals.filter((vt: any) => !fB.length || fB.includes(Number(vt.branch_id)));
  const cOpts = rd.courses.filter((c: any) => (!fV.length || fV.includes(Number(c.meta?.vertical_id))) && (!fB.length || fB.includes(Number(c.meta?.branch_id))));
  return (
    <div className="filters">
      <FilterMulti label="Branch" icon="branch" value={fB} options={rd.branches}
        onChange={(v: number[]) => { setFB(v); setFV((cur: number[]) => cur.filter((id: number) => rd.verticals.some((vt: any) => Number(vt.id) === id && v.includes(Number(vt.branch_id))))); }} />
      <FilterMulti label="Vertical" icon="grid" value={fV} options={vOpts} onChange={setFV} />
      <FilterMulti label="Course" icon="doc" value={fC} options={cOpts} onChange={setFC} />
      {extra}
    </div>
  );
}

/* ========================================================= REVIEW QUEUE === */
export function AdmissionsScreen() {
  const ref = useRef_();
  const { scope: gScope } = useScope();
  const { can } = useAuth();
  const [fB, setFB] = useState<number[]>(gScope.branches);
  const [fV, setFV] = useState<number[]>(gScope.verticals);
  const [fC, setFC] = useState<number[]>([]);
  const [fStatus, setFStatus] = useState('');
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const [tick, setTick] = useState(0);
  const [view, setView] = useState<any | null>(null);
  const [del, setDel] = useState<any | null>(null);
  const [links, setLinks] = useState(false);

  const qs = new URLSearchParams();
  if (fB.length) qs.set('branch_id', fB.join(','));
  if (fV.length) qs.set('vertical_id', fV.join(','));
  if (fC.length) qs.set('course_id', fC.join(','));
  if (fStatus) qs.set('status', fStatus);
  if (range.from) qs.set('from', range.from);
  if (range.to) qs.set('to', range.to);
  const list = useFetch<any[]>(`/admissions?${qs.toString()}`, [qs.toString(), tick]);
  const after = () => setTick((t) => t + 1);
  const rows = list.data ?? [];
  const ids = rows.map((r: any) => Number(r.id));
  const { selected, count, tableSelect, clear } = useTableSelect(ids);
  const { openBulk, bulkModal } = useBulkDelete('Admission', '/admissions/bulk-delete/impact', '/admissions/bulk-delete', () => { after(); clear(); });
  const doDelete = async () => { try { await api.del(`/admissions/${del.id}`); toast('Admission deleted'); setDel(null); after(); } catch (e: any) { toast(e.message, true); } };

  const fmtDate = (v?: string) => (v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

  return (
    <>
      <div className="page-actions">
        {can('admission.manage') && <button className="btn" onClick={() => setLinks(true)}><Ic k="link" />Form links</button>}
      </div>
      <ScopeFilters rd={ref} fB={fB} setFB={setFB} fV={fV} setFV={setFV} fC={fC} setFC={setFC}
        extra={<>
          <label className="fchip"><Ic k="shield" />
            <select value={fStatus} onChange={(e) => setFStatus(e.target.value)} data-testid="adm-status" style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }}>
              <option value="">All statuses</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option>
            </select></label>
          <DateRange value={range} onChange={setRange} idPrefix="adm-dr" style={{ marginLeft: 'auto' }} />
        </>} />
      <BulkBar count={count} entityLabel="Admission" onDelete={() => openBulk(selected)} onClear={clear} />
      <TableCard fill title="Admissions" icon="students"
        select={can('admission.delete') ? tableSelect : undefined}
        more={<ListActions onExport={() => downloadObjectsCsv('admissions.csv', rows.map((r: any) => ({
          admission_no: r.admission_no, name: r.full_name, phone: r.phone, email: r.email,
          branch: r.branch_name, vertical: r.vertical_name, course: r.course_name,
          status: r.status, student_no: r.student_no, submitted: r.created_at,
        })))} onRefresh={after} />}
        cols={['Applicant', 'Branch', 'Vertical', 'Course', 'Submitted', 'Status', 'Actions']}
        empty="No admissions yet — share a public form link to start receiving applications."
        rows={rows.map((a: any) => [
          { node: <div><b className="nm">{a.full_name}</b><div className="sub mono">{a.phone ?? '—'}{a.admission_no ? ` · ${a.admission_no}` : ''}</div></div> } as Cell,
          a.branch_name ?? '—',
          a.vertical_name ?? '—',
          a.course_name ?? '—',
          fmtDate(a.created_at),
          STATUS_CELL(a.status),
          rowActions({
            extra: [{ k: 'eye', title: 'Open', onClick: () => setView(a) }],
            onDelete: can('admission.delete') ? () => setDel(a) : undefined,
          }),
        ])} />
      {view && <AdmissionDetail id={view.id} onClose={() => setView(null)} onChanged={after} rd={ref} />}
      {del && <ConfirmModal title="Delete admission?" body={`Delete the submission from "${del.full_name}"?`} danger confirmLabel="Delete" onConfirm={doDelete} onClose={() => setDel(null)} />}
      {links && <FormLinksModal onClose={() => setLinks(false)} rd={ref} />}
      {bulkModal}
    </>
  );
}

/* ---- one submission: view / edit / approve / reject ---- */
function AdmissionDetail({ id, onClose, onChanged, rd }: { id: number; onClose: () => void; onChanged: () => void; rd: any }) {
  const { can } = useAuth();
  const d = useFetch<any>(`/admissions/${id}`, [id]);
  const a = d.data;
  const [busy, setBusy] = useState(false);
  const [reject, setReject] = useState(false);
  const [reason, setReason] = useState('');
  const [edit, setEdit] = useState(false);

  if (d.loading || !a) return <DetailModal title="Admission" icon="students" onClose={onClose}><div className="empty-note">Loading…</div></DetailModal>;
  const data = a.data ?? {};
  const canReview = can('admission.review') && a.status === 'pending';
  const dash = (v: any) => (v == null || v === '' ? '—' : v);

  const approve = async () => {
    setBusy(true);
    try { const r = await api.post<any>(`/admissions/${id}/approve`, {}); toast(`Approved — student ${r.student_no} created`); onChanged(); onClose(); }
    catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  const doReject = async () => {
    setBusy(true);
    try { await api.post(`/admissions/${id}/reject`, { reason }); toast('Admission rejected'); onChanged(); onClose(); }
    catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };

  if (edit) return <AdmissionEdit a={a} rd={rd} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); d.reload?.(); onChanged(); }} />;

  return (
    <DetailModal title={`Admission — ${a.full_name}`} icon="students" onClose={onClose} width={680}
      footer={canReview ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => setEdit(true)} disabled={busy}><Ic k="pencil" />Edit</button>
          <button className="btn danger" onClick={() => setReject(true)} disabled={busy}><Ic k="x" />Reject</button>
          <button className="btn primary" onClick={approve} disabled={busy}><Ic k="check" />Approve → Student</button>
        </div>
      ) : undefined}>
      <Section title="Status">
        <KV rows={[
          ['Status', a.status === 'approved' ? `Approved → ${a.student_no ?? 'student'}` : a.status === 'rejected' ? `Rejected${a.reject_reason ? ` · ${a.reject_reason}` : ''}` : 'Pending review'],
          ['Admission No.', dash(a.admission_no)],
          ['Placement', `${dash(a.branch_name)} › ${dash(a.vertical_name)}${a.course_name ? ` › ${a.course_name}` : ''}`],
          ['Reviewed by', dash(a.reviewed_by_name)],
        ]} />
      </Section>
      <Section title="Identity & Contact">
        <KV rows={[
          ['Name', dash(data.full_name)], ['Date of Birth', dash(data.dob)], ['Gender', dash(data.gender)],
          ['Nationality', dash(data.nationality)],
          ['Mobile', <span className="mono">{dash(data.phone)}</span>], ['WhatsApp', <span className="mono">{dash(data.whatsapp_phone)}</span>],
          ['Alt Mobile', <span className="mono">{dash(data.alt_phone)}</span>], ['Email', dash(data.email)],
        ]} />
      </Section>
      <Section title="Family / Guardian">
        <KV rows={[
          ['Father Name', dash(data.father_name)], ['Father Mobile', <span className="mono">{dash(data.father_mobile)}</span>],
          ['Guardian', dash(data.guardian_name)], ['Guardian Mobile', <span className="mono">{dash(data.guardian_mobile)}</span>],
          ['Guardian Email', dash(data.guardian_email)], ['Relation', dash(data.guardian_relation)],
        ]} />
      </Section>
      <Section title="Address">
        <KV rows={[
          ['Address', [data.address_line1, data.address_line2, data.landmark].filter(Boolean).join(', ') || '—'],
          ['District', dash(data.district)], ['Pincode', dash(data.pincode)], ['Country', dash(data.country)],
        ]} />
      </Section>
      <Section title="ID Proofs & Education">
        <KV rows={[
          ['Aadhaar', <span className="mono">{dash(data.aadhaar)}</span>], ['PAN', <span className="mono">{dash(data.pan)}</span>],
          ['Passport', <span className="mono">{dash(data.passport)}</span>], ['ID Proof', `${dash(data.id_proof_type)} ${data.id_proof_number ? '· ' + data.id_proof_number : ''}`.trim()],
          ['Qualification', dash(data.qualification)], ['Institution', dash(data.institution)],
          ['Board / University', dash(data.board_university)], ['Passing Year', dash(data.passing_year)],
        ]} />
      </Section>
      <Section title="Uploaded documents">
        <DocumentList basePath={`/admissions/${id}`} />
      </Section>
      {reject && <ConfirmModal title="Reject admission?" body={
        <div><p>This submission will be marked rejected. An optional reason is shown to reviewers.</p>
          <input className="ainp" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      } danger confirmLabel="Reject" busy={busy} onConfirm={doReject} onClose={() => setReject(false)} />}
    </DetailModal>
  );
}

const EDIT_FIELDS: Array<[string, string]> = [
  ['full_name', 'Full name'], ['phone', 'Mobile'], ['email', 'Email'],
  ['father_name', 'Father name'], ['guardian_name', 'Guardian name'], ['guardian_mobile', 'Guardian mobile'],
  ['pincode', 'Pincode'], ['aadhaar', 'Aadhaar'], ['qualification', 'Qualification'],
];
function AdmissionEdit({ a, rd, onClose, onSaved }: { a: any; rd: any; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<any>({ ...(a.data ?? {}), course_id: a.course_id ?? '' });
  const [busy, setBusy] = useState(false);
  const cOpts = rd.courses.filter((c: any) => Number(c.meta?.branch_id) === Number(a.branch_id) && Number(c.meta?.vertical_id) === Number(a.vertical_id));
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));
  const save = async () => {
    setBusy(true);
    try { await api.patch(`/admissions/${a.id}`, { ...form, course_id: form.course_id ? Number(form.course_id) : null }); toast('Admission updated'); onSaved(); }
    catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <DetailModal title={`Edit admission — ${a.full_name}`} icon="pencil" onClose={onClose} width={620}
      footer={<div style={{ display: 'flex', gap: 8 }}><button className="btn" onClick={onClose} disabled={busy}>Cancel</button><button className="btn primary" onClick={save} disabled={busy}><Ic k="check" />Save</button></div>}>
      <div className="form-grid">
        <div className="fld"><label>Course</label><MasterQuickAdd type="course" onAdded={(row) => set('course_id', String(row.id))} />
          <select className="ainp" value={form.course_id ?? ''} onChange={(e) => set('course_id', e.target.value)}>
            <option value="">— Not chosen —</option>
            {cOpts.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></div>
        {EDIT_FIELDS.map(([k, label]) => (
          <div className="fld" key={k}><label>{label}</label>
            <input className="ainp" value={form[k] ?? ''} onChange={(e) => set(k, e.target.value)} /></div>
        ))}
      </div>
    </DetailModal>
  );
}

/* ---- public form links manager ---- */
function FormLinksModal({ onClose, rd }: { onClose: () => void; rd: any }) {
  const [tick, setTick] = useState(0);
  const list = useFetch<any[]>('/admissions/forms', [tick]);
  const rows = list.data ?? [];
  const [branch, setBranch] = useState('');
  const [vertical, setVertical] = useState('');
  const [course, setCourse] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const after = () => setTick((t) => t + 1);
  const vOpts = rd.verticals.filter((vt: any) => !branch || Number(vt.branch_id) === Number(branch));
  const cOpts = rd.courses.filter((c: any) => (!vertical || Number(c.meta?.vertical_id) === Number(vertical)) && (!branch || Number(c.meta?.branch_id) === Number(branch)));

  const publicUrl = (key: string) => `${window.location.origin}/admit/${key}`;
  const create = async () => {
    setBusy(true);
    try {
      await api.post('/admissions/forms', { title: title || undefined, branch_id: branch || undefined, vertical_id: vertical || undefined, course_id: course || undefined });
      toast('Form link created'); setTitle(''); setBranch(''); setVertical(''); setCourse(''); after();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  const copy = (key: string) => { navigator.clipboard?.writeText(publicUrl(key)); toast('Public form URL copied'); };
  const toggle = async (f: any) => { try { await api.patch(`/admissions/forms/${f.id}`, { is_active: !f.is_active }); after(); } catch (e: any) { toast(e.message, true); } };
  const regen = async (f: any) => { try { await api.post(`/admissions/forms/${f.id}/regenerate`, {}); toast('Key regenerated — old link now dead'); after(); } catch (e: any) { toast(e.message, true); } };
  const remove = async (f: any) => { try { await api.del(`/admissions/forms/${f.id}`); toast('Form link deleted'); after(); } catch (e: any) { toast(e.message, true); } };

  return (
    <DetailModal title="Public admission form links" icon="link" onClose={onClose} width={720}>
      <Section title="Generate a link">
        <div className="form-grid">
          <div className="fld"><label>Title</label><input className="ainp" placeholder="Admission Form" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <div className="fld"><label>Branch (optional — locks the form)</label>
            <select className="ainp" value={branch} onChange={(e) => { setBranch(e.target.value); setVertical(''); setCourse(''); }}>
              <option value="">Applicant chooses</option>{rd.branches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select></div>
          <div className="fld"><label>Vertical (optional)</label>
            <select className="ainp" value={vertical} onChange={(e) => { setVertical(e.target.value); setCourse(''); }} disabled={!branch}>
              <option value="">Applicant chooses</option>{vOpts.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select></div>
          <div className="fld"><label>Course (optional)</label><MasterQuickAdd type="course" onAdded={(row) => setCourse(String(row.id))} />
            <select className="ainp" value={course} onChange={(e) => setCourse(e.target.value)} disabled={!vertical}>
              <option value="">Applicant chooses</option>{cOpts.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></div>
        </div>
        <div style={{ marginTop: 8 }}><button className="btn primary" onClick={create} disabled={busy}><Ic k="plus" />Create link</button></div>
      </Section>
      <Section title="Active links">
        {rows.length === 0 ? <div className="empty-note">No form links yet.</div> : rows.map((f: any) => (
          <div className="lrow" key={f.id}>
            <div className="gr" style={{ minWidth: 0 }}>
              <div className="t1"><b>{f.title}</b> {f.is_active ? <span className="bdg b-green">Active</span> : <span className="bdg b-gray">Inactive</span>} <span className="sub">· {f.submissions} submitted</span></div>
              <div className="t2 mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{publicUrl(f.form_key)}</div>
              <div className="t2 sub">{[f.branch_name, f.vertical_name, f.course_name].filter(Boolean).join(' › ') || 'Applicant chooses branch / vertical / course'}</div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="btn sm" onClick={() => copy(f.form_key)}><Ic k="link" />Copy URL</button>
              <button className="btn sm" onClick={() => window.open(publicUrl(f.form_key), '_blank', 'noopener')}><Ic k="eye" />Open</button>
              <button className="btn sm" onClick={() => toggle(f)}>{f.is_active ? 'Deactivate' : 'Activate'}</button>
              <button className="btn sm" onClick={() => regen(f)}>Regenerate</button>
              <button className="btn sm danger" onClick={() => remove(f)}><Ic k="trash" /></button>
            </div>
          </div>
        ))}
      </Section>
    </DetailModal>
  );
}

/* ==================================================== PUBLIC SELF-SERVE FORM === */
const SECTIONS: Array<{ title: string; fields: Array<[string, string, string?]> }> = [
  { title: 'Your details', fields: [['full_name', 'Full name *'], ['dob', 'Date of birth', 'date'], ['gender', 'Gender'], ['nationality', 'Nationality']] },
  { title: 'Contact', fields: [['phone', 'Mobile *', 'tel'], ['whatsapp_phone', 'WhatsApp', 'tel'], ['alt_phone', 'Alternate mobile', 'tel'], ['email', 'Email', 'email']] },
  { title: 'Parent / Guardian', fields: [['father_name', 'Father name'], ['father_mobile', 'Father mobile', 'tel'], ['guardian_name', 'Guardian name'], ['guardian_mobile', 'Guardian mobile', 'tel'], ['guardian_email', 'Guardian email', 'email'], ['guardian_relation', 'Guardian relation']] },
  { title: 'Address', fields: [['address_line1', 'Address line 1'], ['address_line2', 'Address line 2'], ['landmark', 'Landmark'], ['district', 'District'], ['pincode', 'Pincode (6 digits)'], ['country', 'Country']] },
  { title: 'ID proofs', fields: [['aadhaar', 'Aadhaar (12 digits)'], ['pan', 'PAN'], ['passport', 'Passport'], ['id_proof_type', 'Other ID type'], ['id_proof_number', 'Other ID number']] },
  { title: 'Education', fields: [['qualification', 'Highest qualification'], ['institution', 'Institution'], ['board_university', 'Board / University'], ['passing_year', 'Passing year'], ['previous_institution', 'Previous institution']] },
];

export function PublicAdmissionForm({ formKey }: { formKey: string }) {
  const info = useFetch<any>(`/public/admission/${formKey}`, [formKey]);
  const [form, setForm] = useState<any>({ _hp: '' });
  const [docs, setDocs] = useState<Record<string, File[]>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const d = info.data;

  const branches = d?.options?.branches ?? [];
  const verticals = useMemo(() => (d?.options?.verticals ?? []).filter((v: any) => !form.branch_id || Number(v.branch_id) === Number(form.branch_id)), [d, form.branch_id]);
  // Public options: m_course has no branch/vertical columns (they map via a cascade), so the
  // self-serve form offers the flat active-course list; staff confirm/adjust the course on approve.
  const courses = useMemo(() => (d?.options?.courses ?? []), [d]);

  const fixed = d?.fixed ?? {};
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));
  // Attachments — validate each file (PDF/JPG/PNG, 5 MB) before it is accepted.
  const pickDoc = (doc_type: string, multiple: boolean) => (e: any) => {
    const files: File[] = Array.from(e.target.files ?? []);
    for (const f of files) { const err = docError(f); if (err) { toast(err, true); e.target.value = ''; return; } }
    setDocs((prev) => ({ ...prev, [doc_type]: multiple ? [...(prev[doc_type] ?? []), ...files] : files }));
  };

  if (info.loading) return <div className="notice" style={{ margin: 40 }}><Ic k="clock" /><div>Loading…</div></div>;
  if (!d) return <div className="notice" style={{ margin: 40 }}><Ic k="shield" /><div>This admission form is not available.</div></div>;
  if (done) return (
    <div style={{ maxWidth: 640, margin: '40px auto', padding: '0 16px' }}>
      <div className="card" style={{ padding: 28, textAlign: 'center' }}>
        <Ic k="check" /><h2>Application received</h2>
        <p className="page-sub">Thank you. Your admission enquiry (reference #{done}) has been submitted and is pending review. Our team will be in touch.</p>
      </div>
    </div>
  );

  const submit = async () => {
    setBusy(true);
    try {
      const body: any = { ...form };
      if (fixed.branch_id) body.branch_id = fixed.branch_id;
      if (fixed.vertical_id) body.vertical_id = fixed.vertical_id;
      if (fixed.course_id) body.course_id = fixed.course_id;
      const chosen: Array<{ f: File; t: string }> = [];
      for (const [t, arr] of Object.entries(docs)) for (const f of arr) chosen.push({ f, t });
      if (chosen.length > DOC_MAX_FILES) { toast(`Please attach at most ${DOC_MAX_FILES} files.`, true); setBusy(false); return; }
      if (chosen.length) body.documents = await Promise.all(chosen.map((x) => fileToDoc(x.f, x.t)));
      const r = await api.post<any>(`/public/admission/${formKey}`, body);
      setDone(r.reference ?? 0);
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };

  return (
    <div style={{ maxWidth: 720, margin: '24px auto', padding: '0 16px' }}>
      <div className="card" style={{ padding: 24 }}>
        <h2 style={{ marginTop: 0 }}>{d.title || 'Admission Form'}</h2>
        <div className="page-sub" style={{ marginBottom: 12 }}>Fill in your details below. Fields marked * are required.</div>

        {/* honeypot — hidden from humans, bots fill it */}
        <input tabIndex={-1} autoComplete="off" value={form._hp} onChange={(e) => set('_hp', e.target.value)}
          style={{ position: 'absolute', left: '-9999px', width: 1, height: 1 }} aria-hidden="true" />

        {!fixed.branch_id && (
          <div className="form-grid" style={{ marginBottom: 8 }}>
            <div className="fld"><label>Branch *</label>
              <select className="ainp" value={form.branch_id ?? ''} onChange={(e) => { set('branch_id', e.target.value); set('vertical_id', ''); set('course_id', ''); }}>
                <option value="">Select a branch</option>{branches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select></div>
            <div className="fld"><label>Vertical *</label>
              <select className="ainp" value={form.vertical_id ?? ''} onChange={(e) => { set('vertical_id', e.target.value); set('course_id', ''); }} disabled={!form.branch_id}>
                <option value="">Select</option>{verticals.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select></div>
            <div className="fld"><label>Course</label>
              <select className="ainp" value={form.course_id ?? ''} onChange={(e) => set('course_id', e.target.value)}>
                <option value="">Select a course</option>{courses.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></div>
          </div>
        )}

        {SECTIONS.map((sec) => (
          <div key={sec.title} style={{ marginTop: 8 }}>
            <h3 style={{ margin: '10px 0 4px' }}>{sec.title}</h3>
            <div className="form-grid">
              {sec.fields.map(([k, label, type]) => (
                <div className="fld" key={k}><label>{label}</label>
                  <input className="ainp" type={type ?? 'text'} value={form[k] ?? ''} onChange={(e) => set(k, e.target.value)} /></div>
              ))}
            </div>
          </div>
        ))}

        <div style={{ marginTop: 8 }}>
          <h3 style={{ margin: '10px 0 4px' }}>Documents</h3>
          <div className="page-sub" style={{ marginBottom: 4 }}>Upload PDF, JPG or PNG files (max 5 MB each). Education documents (marksheet / certificate) and KYC (photo, Aadhaar, PAN).</div>
          <div className="form-grid">
            {SINGLE_DOCS.map(([k, label]) => (
              <div className="fld" key={k}><label>{label}</label>
                <input className="ainp" type="file" accept={DOC_ACCEPT} data-testid={`doc-${k}`} onChange={pickDoc(k, false)} />
                {docs[k]?.length ? <div className="sub">{docs[k][0].name}</div> : null}
              </div>
            ))}
            <div className="fld"><label>Other documents (you can add several)</label>
              <input className="ainp" type="file" accept={DOC_ACCEPT} multiple data-testid="doc-other" onChange={pickDoc('other', true)} />
              {docs.other?.length ? <div className="sub">{docs.other.map((f) => f.name).join(', ')}</div> : null}
            </div>
          </div>
        </div>

        <div style={{ marginTop: 16 }}>
          <button className="btn primary" onClick={submit} disabled={busy}><Ic k="check" />Submit application</button>
        </div>
      </div>
    </div>
  );
}
