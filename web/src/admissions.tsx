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
import { toast, useFetch, useRef_, selectableUsers } from './refdata';
import { MasterQuickAdd } from './forms';
import { rowActions, ConfirmModal, DetailModal, Section, KV } from './rowactions';
import { DateRange } from './daterange';
import { useScope } from './scope';
import { FilterMulti } from './dyn';
import { DOC_ACCEPT, DOC_MAX_FILES, SINGLE_DOCS, docError, fileToDoc, DocumentList } from './documents';
import { ListActions, downloadObjectsCsv, useTableSelect, BulkBar, useBulkDelete } from './listtools';
import { EnrolmentModal } from './sprint5';
import { EnrolmentActions, FeeCards, PAYMENT_STATUSES, enrolmentCells, enrolmentColumns, enrolmentCsvRow } from './enrolmentfees';

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
function OnlineApplicationsTab() {
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
    try {
      const r = await api.post<any>(`/admissions/${id}/approve`, {});
      // client 3 Sep (S4): approving also enrols the student in the applied course
      if (r.enrolment_no) toast(`Approved — student ${r.student_no} created and enrolled (${r.enrolment_no})`);
      else if (r.enrolment_error) toast(`Approved — student ${r.student_no} created; enrolment not created: ${r.enrolment_error}`, true);
      else toast(`Approved — student ${r.student_no} created (no course on the application — enrol from the student profile)`);
      onChanged(); onClose();
    }
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
          ...(!a.course_name && data.course_text ? [['Course (typed by applicant)', <span style={{ color: 'var(--amber)' }}>{data.course_text}</span>] as [string, any]] : []),
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
/* ---- Enrolments tab (Direct Enrolments + Master Directory) ------------------ */

function EnrolmentsTab({ origin, showOrigin }: { origin?: 'direct'; showOrigin?: boolean }) {
  const ref = useRef_();
  const { scope: gScope } = useScope();
  const trainersQ = useFetch<any[]>('/users?role=Trainer', []);
  const [fB, setFB] = useState<number[]>(gScope.branches);
  const [fV, setFV] = useState<number[]>(gScope.verticals);
  const [fC, setFC] = useState<number[]>([]);
  const [fTrainer, setFTrainer] = useState<number[]>([]);
  const [fOwner, setFOwner] = useState<number[]>([]);
  const [fStatus, setFStatus] = useState('');
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const [q, setQ] = useState('');
  const [tick, setTick] = useState(0);
  const [fPay, setFPay] = useState<string[]>([]);
  const qs = new URLSearchParams();
  if (origin) qs.set('origin', origin);
  if (fStatus) qs.set('status', fStatus);
  if (fTrainer.length) qs.set('trainer_id', fTrainer.join(','));
  if (range.from) qs.set('from', range.from);
  if (range.to) qs.set('to', range.to);
  if (q.trim()) qs.set('q', q.trim());
  qs.set('limit', '500');
  const list = useFetch<any[]>(`/enrolments?${qs.toString()}`, [qs.toString(), tick]);
  const after = () => setTick((t) => t + 1);
  const all = list.data ?? [];
  // Branch / Vertical / Course / Owner filter client-side (the /enrolments list filters status/trainer/date/q server-side).
  const rows = all.filter((e: any) =>
    (!fB.length || fB.includes(Number(e.branch_id))) &&
    (!fV.length || fV.includes(Number(e.vertical_id))) &&
    (!fC.length || fC.includes(Number(e.course_id))) &&
    (!fOwner.length || fOwner.includes(Number(e.counsellor_id))) &&
    (!fPay.length || fPay.includes(String(e.payment_status))));
  // client 4 Sep — the same enrolment columns, colours and actions as Sale Closure / Fee Management
  const cols = enrolmentColumns({ showBranch: true, showOwner: true, showOrigin });
  return (
    <>
      <FeeCards range={range} origin={origin} tick={tick} />
      <ScopeFilters rd={ref} fB={fB} setFB={setFB} fV={fV} setFV={setFV} fC={fC} setFC={setFC}
        extra={<>
          <FilterMulti label="Trainer" icon="users" value={fTrainer} options={(trainersQ.data ?? []) as any} onChange={setFTrainer} />
          <FilterMulti label="Owner" icon="users" value={fOwner} options={selectableUsers(ref.users) as any} onChange={setFOwner} />
          <FilterMulti label="Payment status" icon="rupee" value={fPay as any} options={PAYMENT_STATUSES.map((p) => ({ id: p, name: p })) as any} onChange={setFPay as any} />
          <label className="fchip"><Ic k="shield" />
            <select value={fStatus} onChange={(e) => setFStatus(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }}>
              <option value="">All statuses</option><option value="active">Active</option><option value="pending_approval">Pending approval</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option>
            </select></label>
          <label className="fchip" style={{ minWidth: 150 }}><Ic k="search" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search enrolment / student / phone" style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12, width: '100%' }} /></label>
          <DateRange value={range} onChange={setRange} idPrefix="enr-dr" style={{ marginLeft: 'auto' }} />
        </>} />
      <TableCard fill title={showOrigin ? 'Master Directory — all enrolments' : 'Direct Enrolments'} icon="students" listKey={showOrigin ? 'adm-master' : 'adm-direct'}
        more={<ListActions onExport={() => downloadObjectsCsv(showOrigin ? 'master-directory.csv' : 'direct-enrolments.csv', rows.map((e: any) => ({
          ...enrolmentCsvRow(e), trainer: e.trainer_name || '',
          origin: e.from_admission ? 'Online application' : 'Direct enrolment',
        })))} onRefresh={after} />}
        cols={cols}
        empty={showOrigin ? 'No enrolments yet.' : 'No direct enrolments yet — convert a lead or enrol from Student Management.'}
        rows={rows.map((e: any) => enrolmentCells(e, {
          showBranch: true, showOwner: true, showOrigin,
          actions: <EnrolmentActions e={e} onChanged={after} />,
        }))} />
    </>
  );
}

/* ---- Application Links tab -------------------------------------------------- */
function ApplicationLinksTab() {
  const ref = useRef_();
  return (
    <div className="card" style={{ padding: 16 }}>
      <FormLinksPanel rd={ref} />
    </div>
  );
}

/* ---- Admissions & Enrolment — 4 tabs (client Sep-1; order per client 12 Nov 2026:
 *      Master Directory › Direct Enrolment › Online Application › Application Link) ---- */
const ADM_TABS: Array<{ id: string; label: string; icon: string }> = [
  { id: 'master', label: 'Master Directory', icon: 'students' },
  { id: 'direct', label: 'Direct Enrolments', icon: 'users' },
  { id: 'online', label: 'Online Applications', icon: 'doc' },
  { id: 'links', label: 'Application Links', icon: 'link' },
];
export function AdmissionsScreen() {
  const { can } = useAuth();
  const [tab, setTab] = useState('master');
  const [newEnrol, setNewEnrol] = useState(false);
  const [gen, setGen] = useState(0);
  const tabs = ADM_TABS.filter((t) => t.id !== 'links' || can('admission.manage'));
  return (
    <>
      <div className="seg-tabs" role="tablist" style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`btn${tab === t.id ? ' primary' : ''}`} onClick={() => setTab(t.id)}>
            <Ic k={t.icon} />{t.label}
          </button>
        ))}
        {/* client 31 Oct (13): close a sale from here too, the same form as Sale Closure */}
        {can('enrolment.create') && (
          <button className="btn primary" style={{ marginLeft: 'auto' }} onClick={() => setNewEnrol(true)} data-testid="adm-new-enrolment">
            <Ic k="plus" />New enrolment
          </button>
        )}
      </div>
      {tab === 'online' && <OnlineApplicationsTab />}
      {tab === 'direct' && <EnrolmentsTab key={gen} origin="direct" />}
      {tab === 'links' && can('admission.manage') && <ApplicationLinksTab />}
      {tab === 'master' && <EnrolmentsTab key={gen} showOrigin />}
      {newEnrol && <EnrolmentModal onClose={() => setNewEnrol(false)} onSaved={() => { setGen((g) => g + 1); if (tab !== 'master') setTab('direct'); }} />}
    </>
  );
}

/** Presign + PUT a header logo to R2; returns the r2_key to save on the link (12 Nov 2026). */
async function uploadFormLogo(file: File): Promise<string> {
  if (!/^image\/(png|jpe?g|webp|svg\+xml)$/.test(file.type)) throw new Error('The logo must be a JPG, PNG, WEBP or SVG image.');
  if (file.size > 2 * 1024 * 1024) throw new Error('The logo must be under 2 MB.');
  const { url, r2_key } = await api.post<{ url: string; r2_key: string }>('/admissions/forms/logo/upload-url', { file_name: file.name, content_type: file.type });
  const res = await fetch(url, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
  if (!res.ok) throw new Error('Logo upload failed');
  return r2_key;
}

const EMPTY_HEADER = { name: '', address: '', phone: '', email: '', logo_r2_key: '' };

/** Logo, name, address, phone, email shown at the top of the public form. Blank = the vertical's. */
function FormHeaderFields({ value, onChange, defaults }: { value: any; onChange: (h: any) => void; defaults: any }) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const set = (k: string, v: string) => onChange({ ...value, [k]: v });
  const pick = async (e: any) => {
    const f: File | undefined = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    setBusy(true);
    try { const key = await uploadFormLogo(f); onChange({ ...value, logo_r2_key: key }); setPreview(URL.createObjectURL(f)); toast('Logo uploaded'); }
    catch (err: any) { toast(err.message, true); } finally { setBusy(false); }
  };
  const logo = preview ?? (value.logo_r2_key ? null : defaults?.logo_url);
  return (
    <>
      <div className="fhint" style={{ margin: '10px 0 6px' }}>Shown at the top of the form. Leave a field blank to use the vertical's details (Hierarchy › Verticals).</div>
      <div className="form-grid">
        <div className="fld"><label>Logo</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {logo ? <img src={logo} alt="" style={{ height: 40, maxWidth: 120, objectFit: 'contain', border: '1px solid var(--border)', borderRadius: 6, padding: 2 }} />
              : value.logo_r2_key ? <span className="bdg b-green">Own logo</span> : <span className="sub">No logo</span>}
            <label className="btn sm" style={{ cursor: 'pointer' }}><Ic k="up" />{busy ? 'Uploading…' : 'Upload'}
              <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" style={{ display: 'none' }} onChange={pick} data-testid="form-logo-input" /></label>
            {value.logo_r2_key ? <button className="btn sm" onClick={() => { onChange({ ...value, logo_r2_key: '' }); setPreview(null); }}>Use vertical logo</button> : null}
          </div></div>
        <div className="fld"><label>Institute name</label><input className="ainp" placeholder={defaults?.name ?? ''} value={value.name ?? ''} onChange={(e) => set('name', e.target.value)} data-testid="form-h-name" /></div>
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Address</label><input className="ainp" placeholder={defaults?.address ?? ''} value={value.address ?? ''} onChange={(e) => set('address', e.target.value)} data-testid="form-h-address" /></div>
        <div className="fld"><label>Contact phone</label><input className="ainp" placeholder={defaults?.phone ?? ''} value={value.phone ?? ''} onChange={(e) => set('phone', e.target.value)} data-testid="form-h-phone" /></div>
        <div className="fld"><label>Contact email</label><input className="ainp" placeholder={defaults?.email ?? ''} value={value.email ?? ''} onChange={(e) => set('email', e.target.value)} data-testid="form-h-email" /></div>
      </div>
    </>
  );
}

function FormLinksPanel({ rd }: { rd: any }) {
  const [tick, setTick] = useState(0);
  const list = useFetch<any[]>('/admissions/forms', [tick]);
  const rows = list.data ?? [];
  const [branch, setBranch] = useState('');
  const [vertical, setVertical] = useState('');
  const [course, setCourse] = useState('');
  const [title, setTitle] = useState('');
  const [header, setHeader] = useState<any>(EMPTY_HEADER);
  const [editing, setEditing] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const after = () => setTick((t) => t + 1);
  const vOpts = rd.verticals.filter((vt: any) => !branch || Number(vt.branch_id) === Number(branch));
  const cOpts = rd.courses.filter((c: any) => (!vertical || Number(c.meta?.vertical_id) === Number(vertical)) && (!branch || Number(c.meta?.branch_id) === Number(branch)));
  // what the header shows when a field is left blank (the vertical's, else the branch's details)
  const defaults = useFetch<any>(branch && vertical ? `/admissions/forms/header-defaults?branch_id=${branch}&vertical_id=${vertical}` : null, [branch, vertical]);

  const publicUrl = (key: string) => `${window.location.origin}/admit/${key}`;
  const create = async () => {
    if (!branch || !vertical) { toast('Choose the branch and vertical this form is for', true); return; }
    setBusy(true);
    try {
      await api.post('/admissions/forms', { title: title || undefined, branch_id: branch, vertical_id: vertical, course_id: course || undefined, header });
      toast('Form link created'); setTitle(''); setBranch(''); setVertical(''); setCourse(''); setHeader(EMPTY_HEADER); after();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  const saveEdit = async () => {
    setBusy(true);
    try {
      await api.patch(`/admissions/forms/${editing.id}`, { title: editing.title, header: editing.header, course_id: editing.course_id || null });
      toast('Form link updated'); setEditing(null); after();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  const copy = (key: string) => { navigator.clipboard?.writeText(publicUrl(key)); toast('Public form URL copied'); };
  const toggle = async (f: any) => { try { await api.patch(`/admissions/forms/${f.id}`, { is_active: !f.is_active }); after(); } catch (e: any) { toast(e.message, true); } };
  const regen = async (f: any) => { try { await api.post(`/admissions/forms/${f.id}/regenerate`, {}); toast('Key regenerated — old link now dead'); after(); } catch (e: any) { toast(e.message, true); } };
  const remove = async (f: any) => { try { await api.del(`/admissions/forms/${f.id}`); toast('Form link deleted'); after(); } catch (e: any) { toast(e.message, true); } };

  return (
    <>
      <Section title="Generate a link">
        <div className="form-grid">
          <div className="fld"><label>Title</label><input className="ainp" placeholder="Admission Form" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <div className="fld"><label>Branch *</label>
            <select className="ainp" value={branch} onChange={(e) => { setBranch(e.target.value); setVertical(''); setCourse(''); }} data-testid="form-branch">
              <option value="">Select a branch</option>{rd.branches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select></div>
          <div className="fld"><label>Vertical *</label>
            <select className="ainp" value={vertical} onChange={(e) => { setVertical(e.target.value); setCourse(''); }} disabled={!branch} data-testid="form-vertical">
              <option value="">Select a vertical</option>{vOpts.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select></div>
          <div className="fld"><label>Course (optional — fixes the course)</label><MasterQuickAdd type="course" onAdded={(row) => setCourse(String(row.id))} />
            <select className="ainp" value={course} onChange={(e) => setCourse(e.target.value)} disabled={!vertical}>
              <option value="">Applicant chooses from the vertical's courses</option>{cOpts.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></div>
        </div>
        {branch && vertical ? <FormHeaderFields value={header} onChange={setHeader} defaults={defaults.data} /> : null}
        <div style={{ marginTop: 8 }}><button className="btn primary" onClick={create} disabled={busy || !branch || !vertical} data-testid="form-create"><Ic k="plus" />Create link</button></div>
      </Section>
      {editing && (
        <DetailModal title={`Edit form link — ${editing.title}`} icon="link" onClose={() => setEditing(null)} width={720}
          footer={<div style={{ display: 'flex', gap: 8 }}><button className="btn" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn primary" onClick={saveEdit} disabled={busy} data-testid="form-edit-save"><Ic k="check" />Save</button></div>}>
          <div className="form-grid">
            <div className="fld"><label>Title</label><input className="ainp" value={editing.title ?? ''} onChange={(e) => setEditing({ ...editing, title: e.target.value })} /></div>
            <div className="fld"><label>Course (optional — fixes the course)</label>
              <select className="ainp" value={editing.course_id ?? ''} onChange={(e) => setEditing({ ...editing, course_id: e.target.value })}>
                <option value="">Applicant chooses from the vertical's courses</option>
                {rd.courses.filter((c: any) => Number(c.meta?.vertical_id) === Number(editing.vertical_id)).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></div>
          </div>
          <FormHeaderFields value={editing.header} onChange={(h) => setEditing({ ...editing, header: h })} defaults={editing.defaults} />
        </DetailModal>
      )}
      <Section title="Active links">
        {rows.length === 0 ? <div className="empty-note">No form links yet.</div> : rows.map((f: any) => (
          <div className="lrow" key={f.id}>
            <div className="gr" style={{ minWidth: 0 }}>
              <div className="t1"><b>{f.title}</b> {f.is_active ? <span className="bdg b-green">Active</span> : <span className="bdg b-gray">Inactive</span>} <span className="sub">· {f.submissions} submitted</span></div>
              <div className="t2 mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{publicUrl(f.form_key)}</div>
              <div className="t2 sub">{[f.branch_name, f.vertical_name, f.course_name].filter(Boolean).join(' › ') || 'Applicant chooses branch / vertical / course'}</div>
              <div className="t2 sub" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {f.resolved_header?.logo_url ? <img src={f.resolved_header.logo_url} alt="" style={{ height: 18, maxWidth: 60, objectFit: 'contain' }} /> : null}
                {[f.resolved_header?.name, f.resolved_header?.phone, f.resolved_header?.email].filter(Boolean).join(' · ') || 'No header details yet'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="btn sm" onClick={() => setEditing({ id: f.id, title: f.title, course_id: f.course_id ?? '', vertical_id: f.vertical_id,
                header: { ...EMPTY_HEADER, ...(f.header ?? {}) },
                defaults: { ...f.resolved_header, ...Object.fromEntries(Object.keys(f.header ?? {}).map((k) => [k, undefined])) } })}
                data-testid={`form-edit-${f.id}`}><Ic k="pencil" />Edit</button>
              <button className="btn sm" onClick={() => copy(f.form_key)}><Ic k="link" />Copy URL</button>
              <button className="btn sm" onClick={() => window.open(publicUrl(f.form_key), '_blank', 'noopener')}><Ic k="eye" />Open</button>
              <button className="btn sm" onClick={() => toggle(f)}>{f.is_active ? 'Deactivate' : 'Activate'}</button>
              <button className="btn sm" onClick={() => regen(f)}>Regenerate</button>
              <button className="btn sm danger" onClick={() => remove(f)}><Ic k="trash" /></button>
            </div>
          </div>
        ))}
      </Section>
    </>
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
  const fixed = d?.fixed ?? {};
  // 12 Nov 2026: only the courses of the form's (or the chosen) vertical; a course that is not
  // listed can be typed in ("Course name") — staff link it to the Course master on approve.
  const vSel = fixed.vertical_id ?? form.vertical_id;
  const courses = useMemo(() => (d?.options?.courses ?? []).filter((c: any) => !vSel || c.vertical_id == null || Number(c.vertical_id) === Number(vSel)), [d, vSel]);
  const fixedCourse = fixed.course_id ? (d?.options?.courses ?? []).find((c: any) => Number(c.id) === Number(fixed.course_id)) : null;
  const h = d?.header ?? {};
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
      if (!body.course_id && body.course_id_choice === 'other') delete body.course_id;
      delete body.course_id_choice;
      if (!body.course_id && !String(body.course_text ?? '').trim()) { toast('Please choose the course you are applying for.', true); setBusy(false); return; }
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
        {(h.logo_url || h.name || h.address || h.phone || h.email) ? (
          <div data-testid="adm-form-header" style={{ display: 'flex', gap: 14, alignItems: 'center', paddingBottom: 14, marginBottom: 14, borderBottom: '1px solid var(--border)' }}>
            {h.logo_url ? <img src={h.logo_url} alt={h.name ?? 'Logo'} style={{ height: 64, maxWidth: 160, objectFit: 'contain' }} /> : null}
            <div style={{ minWidth: 0 }}>
              {h.name ? <div style={{ fontWeight: 700, fontSize: 18 }}>{h.name}</div> : null}
              {h.address ? <div className="sub">{h.address}</div> : null}
              {(h.phone || h.email) ? <div className="sub">{[h.phone && `Phone: ${h.phone}`, h.email && `Email: ${h.email}`].filter(Boolean).join('  ·  ')}</div> : null}
            </div>
          </div>
        ) : null}
        <h2 style={{ marginTop: 0 }}>{d.title || 'Admission Form'}</h2>
        <div className="page-sub" style={{ marginBottom: 12 }}>Fill in your details below. Fields marked * are required.</div>

        {/* honeypot — hidden from humans, bots fill it */}
        <input tabIndex={-1} autoComplete="off" value={form._hp} onChange={(e) => set('_hp', e.target.value)}
          style={{ position: 'absolute', left: '-9999px', width: 1, height: 1 }} aria-hidden="true" />

        <div className="form-grid" style={{ marginBottom: 8 }}>
          {!fixed.branch_id && (
            <>
              <div className="fld"><label>Branch *</label>
                <select className="ainp" value={form.branch_id ?? ''} onChange={(e) => { set('branch_id', e.target.value); set('vertical_id', ''); set('course_id', ''); }}>
                  <option value="">Select a branch</option>{branches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select></div>
              <div className="fld"><label>Vertical *</label>
                <select className="ainp" value={form.vertical_id ?? ''} onChange={(e) => { set('vertical_id', e.target.value); set('course_id', ''); }} disabled={!form.branch_id}>
                  <option value="">Select</option>{verticals.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select></div>
            </>
          )}
          {fixedCourse ? (
            <div className="fld"><label>Course</label><input className="ainp" value={fixedCourse.name} readOnly data-testid="adm-course-fixed" /></div>
          ) : (
            <>
              <div className="fld"><label>Course name *</label>
                <select className="ainp" data-testid="adm-course" value={form.course_id_choice === 'other' ? 'other' : (form.course_id ?? '')}
                  onChange={(e) => { const v = e.target.value; setForm((f: any) => ({ ...f, course_id: v === 'other' ? '' : v, course_id_choice: v === 'other' ? 'other' : '', course_text: v === 'other' ? f.course_text : '' })); }}>
                  <option value="">Select a course</option>
                  {courses.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  <option value="other">Other — type the course name</option>
                </select></div>
              {(form.course_id_choice === 'other' || courses.length === 0) && (
                <div className="fld"><label>Type the course name *</label>
                  <input className="ainp" data-testid="adm-course-text" value={form.course_text ?? ''} onChange={(e) => set('course_text', e.target.value)} placeholder="e.g. German A1" /></div>
              )}
            </>
          )}
        </div>

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
