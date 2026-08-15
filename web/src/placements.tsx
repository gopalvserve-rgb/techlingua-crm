/**
 * Students & Academics — PLACEMENT SUPPORT (client feedback #14).
 *
 * Two surfaces:
 *   1) PlacementsScreen — staff admin list of JOB OPENINGS with the FULL list treatment
 *      (multi-select Branch/Vertical + Status/Job-type filters, Export values-not-ids, column
 *      chooser, Refresh, bulk-delete) + add/edit form (eligibility pickers for courses/verticals,
 *      JD upload → R2, deadline, status) + an APPLICANTS view per opening with status advance.
 *   2) PlacementsTab — the student-profile surface: the openings THIS student is eligible for
 *      (GET /students/:id/placements) with an Apply button, plus their applications.
 *
 * Eligibility is decided by the API; the UI simply lists what it returns.
 */
import { useMemo, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, TableCard } from './renderer';
import { toast, useFetch, useRef_ } from './refdata';
import { MasterQuickAdd } from './forms';
import { rowActions, ConfirmModal, Section } from './rowactions';
import { DateRange } from './daterange';
import { useScope } from './scope';
import { FilterMulti } from './dyn';
import { ListActions, downloadObjectsCsv, useTableSelect, BulkBar, useBulkDelete } from './listtools';
import { fmtINR } from './money';

const JOB_TYPE_LABEL: Record<string, string> = {
  full_time: 'Full-time', part_time: 'Part-time', internship: 'Internship', contract: 'Contract',
};
const JOB_TYPES = ['full_time', 'part_time', 'internship', 'contract'];
const STATUS_BADGE: Record<string, string> = { open: 'b-green', closed: 'b-gray', filled: 'b-amber' };
const STATUS_LABEL: Record<string, string> = { open: 'Open', closed: 'Closed', filled: 'Filled' };
const JOB_STATUSES = ['open', 'closed', 'filled'];
const APP_BADGE: Record<string, string> = { applied: 'b-blue', shortlisted: 'b-amber', selected: 'b-green', rejected: 'b-rose' };
const APP_LABEL: Record<string, string> = { applied: 'Applied', shortlisted: 'Shortlisted', selected: 'Selected', rejected: 'Rejected' };
const APP_STATUSES = ['applied', 'shortlisted', 'selected', 'rejected'];
// The eligibility "min status" mirrors the shared enrolment-status catalog (a useful subset).
const MIN_STATUS_OPTS = ['completed', 'active', 'failed'];

function salaryRange(min?: number | null, max?: number | null): string {
  if (min == null && max == null) return '—';
  if (min != null && max != null) return `${fmtINR(min, { symbol: true })} – ${fmtINR(max, { symbol: true })}`;
  return fmtINR((min ?? max) as number, { symbol: true });
}

/** Upload a file straight to R2 via a presigned PUT; returns the r2_key. */
async function uploadToR2(base: string, file: File): Promise<string> {
  const { url, r2_key } = await api.post<{ url: string; r2_key: string }>(`${base}/upload-url`, {
    file_name: file.name, content_type: file.type || 'application/octet-stream',
  });
  const res = await fetch(url, { method: 'PUT', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);
  return r2_key;
}

const Empty = ({ t }: { t: string }) => <div className="empty-note">{t}</div>;

/* ==========================================================================
 * 1) STAFF ADMIN — Placements (job openings) list
 * ======================================================================== */
export function PlacementsScreen() {
  const rd = useRef_();
  const { scope: gScope } = useScope();
  const { can } = useAuth();
  const [fB, setFB] = useState<number[]>(gScope.branches);
  const [fV, setFV] = useState<number[]>(gScope.verticals);
  const [status, setStatus] = useState('');
  const [jobType, setJobType] = useState('');
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const [tick, setTick] = useState(0);
  const [add, setAdd] = useState(false);
  const [edit, setEdit] = useState<any | null>(null);
  const [del, setDel] = useState<any | null>(null);
  const [applicantsFor, setApplicantsFor] = useState<any | null>(null);

  const vOpts = rd.verticals.filter((vt: any) => !fB.length || fB.includes(Number(vt.branch_id)));

  const qs = new URLSearchParams();
  if (fB.length) qs.set('branch_id', fB.join(','));
  if (fV.length) qs.set('vertical_id', fV.join(','));
  if (status) qs.set('status', status);
  if (jobType) qs.set('job_type', jobType);
  const list = useFetch<any[]>(`/job-openings?${qs.toString()}`, [qs.toString(), tick]);
  const after = () => setTick((t) => t + 1);
  const rows = list.data ?? [];
  const ids = rows.map((r: any) => Number(r.id));
  const { selected, count, tableSelect, clear } = useTableSelect(ids);
  const { openBulk, bulkModal } = useBulkDelete('Job openings', '/job-openings/bulk-delete/impact', '/job-openings/bulk-delete', () => { after(); clear(); });
  const doDelete = async () => { try { await api.del(`/job-openings/${del.id}`); toast('Deleted'); setDel(null); after(); } catch (e: any) { toast(e.message, true); } };

  const exportRows = rows.map((r: any) => ({
    Title: r.title, Employer: r.employer ?? '', Location: r.location ?? '', Type: JOB_TYPE_LABEL[r.job_type] ?? r.job_type,
    Openings: r.openings, Branch: r.branch_name ?? '', Vertical: r.vertical_name ?? '',
    Deadline: r.deadline ?? '', Status: STATUS_LABEL[r.status] ?? r.status, Applicants: r.applicant_count ?? 0,
  }));

  return (
    <>
      {can('placement.create') && <div className="page-actions"><button className="btn primary" onClick={() => setAdd(true)}><Ic k="plus" />New job opening</button></div>}
      <div className="filters">
        <FilterMulti label="Branch" icon="branch" value={fB} options={rd.branches}
          onChange={(v: number[]) => { setFB(v); setFV((cur: number[]) => cur.filter((id: number) => rd.verticals.some((vt: any) => Number(vt.id) === id && v.includes(Number(vt.branch_id))))); }} />
        <FilterMulti label="Vertical" icon="grid" value={fV} options={vOpts} onChange={setFV} />
        <label className="fchip"><Ic k="shield" />
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }}>
            <option value="">All statuses</option>{JOB_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select></label>
        <label className="fchip"><Ic k="target" />
          <select value={jobType} onChange={(e) => setJobType(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }}>
            <option value="">All types</option>{JOB_TYPES.map((s) => <option key={s} value={s}>{JOB_TYPE_LABEL[s]}</option>)}
          </select></label>
        <DateRange value={range} onChange={setRange} idPrefix="pl-dr" style={{ marginLeft: 'auto' }} />
      </div>
      <BulkBar count={count} entityLabel="Job openings" onDelete={() => openBulk(selected)} onClear={clear} />
      <TableCard fill title="Job openings" icon="target"
        select={can('placement.delete') ? tableSelect : undefined}
        more={<ListActions onExport={() => downloadObjectsCsv('placements.csv', exportRows)} onRefresh={after} />}
        cols={['Title', 'Employer', 'Type', 'Location', 'Salary / Stipend', 'Openings', 'Deadline', 'Applicants', 'Status', 'Actions']}
        empty="No job openings yet — post one for eligible students."
        rows={rows.map((r: any) => [
          { node: <div><b className="nm">{r.title}</b><div className="sub">{r.branch_name} › {r.vertical_name}</div></div> } as Cell,
          r.employer ?? '—',
          JOB_TYPE_LABEL[r.job_type] ?? r.job_type,
          r.location ?? '—',
          salaryRange(r.salary_min_minor, r.salary_max_minor),
          String(r.openings ?? 1),
          r.deadline ?? '—',
          { node: <a href="#" onClick={(e) => { e.preventDefault(); setApplicantsFor(r); }}>{r.applicant_count ?? 0} applicant{Number(r.applicant_count) === 1 ? '' : 's'}</a> } as Cell,
          { b: [STATUS_LABEL[r.status] ?? r.status, STATUS_BADGE[r.status] ?? 'b-gray'] } as Cell,
          rowActions({
            onEdit: can('placement.update') ? () => setEdit(r) : undefined,
            onDelete: can('placement.delete') ? () => setDel(r) : undefined,
            extra: [{ k: 'users', title: 'View applicants', onClick: () => setApplicantsFor(r) }],
          }),
        ])} />
      {add && <JobOpeningModal base="/job-openings" onClose={() => setAdd(false)} onSaved={after} rd={rd} />}
      {edit && <JobOpeningModal base="/job-openings" initial={edit} onClose={() => setEdit(null)} onSaved={after} rd={rd} />}
      {del && <ConfirmModal title="Delete job opening?" body={`Delete "${del.title}"?`} danger confirmLabel="Delete" onConfirm={doDelete} onClose={() => setDel(null)} />}
      {applicantsFor && <ApplicantsModal opening={applicantsFor} onClose={() => setApplicantsFor(null)} canAdvance={can('placement_application.update')} />}
      {bulkModal}
    </>
  );
}

/* ------------------------------------------------------------- add/edit form */
function JobOpeningModal({ base, initial, onClose, onSaved, rd }: { base: string; initial?: any; onClose: () => void; onSaved: () => void; rd: any }) {
  const isEdit = !!initial?.id;
  const [branchId, setBranchId] = useState<string>(String(initial?.branch_id ?? ''));
  const [verticalId, setVerticalId] = useState<string>(String(initial?.vertical_id ?? ''));
  const [title, setTitle] = useState<string>(initial?.title ?? '');
  const [employer, setEmployer] = useState<string>(initial?.employer ?? '');
  const [description, setDescription] = useState<string>(initial?.description ?? '');
  const [location, setLocation] = useState<string>(initial?.location ?? '');
  const [jobType, setJobType] = useState<string>(initial?.job_type ?? 'full_time');
  const [openings, setOpenings] = useState<string>(String(initial?.openings ?? '1'));
  const [salMin, setSalMin] = useState<string>(initial?.salary_min_minor != null ? String(Number(initial.salary_min_minor) / 100) : '');
  const [salMax, setSalMax] = useState<string>(initial?.salary_max_minor != null ? String(Number(initial.salary_max_minor) / 100) : '');
  const [skills, setSkills] = useState<string>(Array.isArray(initial?.skills) ? initial.skills.join(', ') : (initial?.skills ?? ''));
  const [eligCourses, setEligCourses] = useState<number[]>((initial?.eligible_course_ids ?? []).map((n: any) => Number(n)));
  const [eligVerticals, setEligVerticals] = useState<number[]>((initial?.eligible_vertical_ids ?? []).map((n: any) => Number(n)));
  const [minStatus, setMinStatus] = useState<string>(initial?.min_status ?? '');
  const [deadline, setDeadline] = useState<string>(initial?.deadline ?? '');
  const [status, setStatus] = useState<string>(initial?.status ?? 'open');
  const [jdKey, setJdKey] = useState<string>(initial?.jd_r2_key ?? '');
  const [jdName, setJdName] = useState<string>(initial?.jd_r2_key ? 'Attached JD' : '');
  const [busy, setBusy] = useState(false); const [uploading, setUploading] = useState(false); const [err, setErr] = useState('');

  const vOpts = rd.verticals.filter((v: any) => !branchId || Number(v.branch_id) === Number(branchId));
  const courseOpts = useMemo(() => rd.courses, [rd.courses]);

  const pickFile = async (f?: File | null) => {
    if (!f) return;
    setUploading(true); setErr('');
    try { const key = await uploadToR2(base, f); setJdKey(key); setJdName(f.name); }
    catch (e: any) { setErr(e.message); } finally { setUploading(false); }
  };

  const toMinor = (v: string): number | null => { const n = Number(v); return v.trim() && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null; };

  const save = async () => {
    setErr('');
    if (!title.trim()) return setErr('Give the opening a title.');
    if (!isEdit && (!branchId || !verticalId)) return setErr('Choose a branch and vertical.');
    setBusy(true);
    const body: any = {
      title: title.trim(), employer: employer.trim() || null, description: description.trim() || null,
      location: location.trim() || null, job_type: jobType, openings: Number(openings) || 1,
      salary_min_minor: toMinor(salMin), salary_max_minor: toMinor(salMax),
      skills: skills.trim() || null, eligible_course_ids: eligCourses, eligible_vertical_ids: eligVerticals,
      min_status: minStatus || null, jd_r2_key: jdKey || null, deadline: deadline || null, status,
    };
    if (!isEdit) { body.branch_id = Number(branchId); body.vertical_id = Number(verticalId); }
    try {
      if (isEdit) await api.patch(`${base}/${initial.id}`, body);
      else await api.post(base, body);
      toast(isEdit ? 'Saved' : 'Job opening posted'); onSaved(); onClose();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim"><div className="add-modal" style={{ maxWidth: 720 }}>
      <div className="ah"><h3><Ic k="target" />{isEdit ? 'Edit' : 'New'} job opening</h3><button className="ax" onClick={onClose}><Ic k="x" /></button></div>
      <div className="abody"><div className="form-grid">
        {!isEdit && (
          <>
            <div className="fld"><label>Branch <span className="star">*</span></label>
              <select className="ainp" value={branchId} onChange={(e) => { setBranchId(e.target.value); setVerticalId(''); }}>
                <option value="">— Select branch —</option>{rd.branches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select></div>
            <div className="fld"><label>Vertical <span className="star">*</span></label>
              <select className="ainp" value={verticalId} onChange={(e) => setVerticalId(e.target.value)}>
                <option value="">— Select vertical —</option>{vOpts.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select></div>
          </>
        )}
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Title <span className="star">*</span></label><input className="ainp" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Junior Software Engineer" /></div>
        <div className="fld"><label>Company / Employer</label><input className="ainp" value={employer} onChange={(e) => setEmployer(e.target.value)} /></div>
        <div className="fld"><label>Location</label><input className="ainp" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="City" /></div>
        <div className="fld"><label>Job type</label>
          <select className="ainp" value={jobType} onChange={(e) => setJobType(e.target.value)}>{JOB_TYPES.map((t) => <option key={t} value={t}>{JOB_TYPE_LABEL[t]}</option>)}</select></div>
        <div className="fld"><label>No. of openings</label><input className="ainp" type="number" min={1} value={openings} onChange={(e) => setOpenings(e.target.value)} /></div>
        <div className="fld"><label>Salary / stipend min (₹)</label><input className="ainp" type="number" min={0} value={salMin} onChange={(e) => setSalMin(e.target.value)} placeholder="optional" /></div>
        <div className="fld"><label>Salary / stipend max (₹)</label><input className="ainp" type="number" min={0} value={salMax} onChange={(e) => setSalMax(e.target.value)} placeholder="optional" /></div>
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Description / JD</label>
          <textarea className="ainp" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Role, responsibilities, requirements…" /></div>
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Skills / tags</label><input className="ainp" value={skills} onChange={(e) => setSkills(e.target.value)} placeholder="comma,separated" /></div>
        {/* Eligibility */}
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Eligibility — eligible courses</label>
          <FilterMulti label="Courses" icon="doc" value={eligCourses} options={courseOpts} onChange={setEligCourses} />
          <MasterQuickAdd type="course" onAdded={(row: any) => setEligCourses((c) => [...c, Number(row.id)])} /></div>
        <div className="fld"><label>Eligibility — eligible verticals</label>
          <FilterMulti label="Verticals" icon="grid" value={eligVerticals} options={rd.verticals} onChange={setEligVerticals} /></div>
        <div className="fld"><label>Min. enrolment status (optional)</label>
          <select className="ainp" value={minStatus} onChange={(e) => setMinStatus(e.target.value)}>
            <option value="">— Any (enrolled) —</option>{MIN_STATUS_OPTS.map((s) => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
          </select></div>
        <div className="fld"><label>Application deadline</label><input className="ainp" type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} /></div>
        <div className="fld"><label>Status</label>
          <select className="ainp" value={status} onChange={(e) => setStatus(e.target.value)}>{JOB_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select></div>
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>JD attachment (→ R2)</label>
          <input className="ainp" type="file" onChange={(e) => pickFile(e.target.files?.[0])} />
          {uploading ? <div className="sub">Uploading…</div> : (jdKey ? <div className="sub">Attached: {jdName} <a href="#" onClick={(e) => { e.preventDefault(); setJdKey(''); setJdName(''); }}>remove</a></div> : null)}</div>
      </div>{err && <div className="form-err" style={{ marginTop: 8 }}>{err}</div>}</div>
      <div className="af"><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || uploading} onClick={save}><Ic k="check" />{busy ? 'Saving…' : 'Save'}</button></div>
    </div></div>
  );
}

/* --------------------------------------------------------- applicants modal */
function ApplicantsModal({ opening, onClose, canAdvance }: { opening: any; onClose: () => void; canAdvance: boolean }) {
  const [tick, setTick] = useState(0);
  const apps = useFetch<any[]>(`/job-openings/${opening.id}/applications`, [opening.id, tick]);
  const rows = apps.data ?? [];
  const advance = async (a: any, status: string) => {
    try { await api.patch(`/placement-applications/${a.id}`, { status }); toast(`Marked ${APP_LABEL[status]}`); setTick((t) => t + 1); }
    catch (e: any) { toast(e.message, true); }
  };
  return (
    <div className="add-scrim"><div className="add-modal" style={{ maxWidth: 760 }}>
      <div className="ah"><h3><Ic k="users" />Applicants — {opening.title}</h3><button className="ax" onClick={onClose}><Ic k="x" /></button></div>
      <div className="abody">
        {rows.length ? (
          <table className="tbl"><thead><tr><th>Student</th><th>Contact</th><th>Applied</th><th>Status</th>{canAdvance && <th>Advance</th>}</tr></thead>
            <tbody>{rows.map((a: any) => (
              <tr key={a.id} data-testid={`applicant-${a.id}`}>
                <td><b>{a.student_name}</b>{a.student_no ? <div className="sub mono">{a.student_no}</div> : null}</td>
                <td className="sub">{a.phone ?? '—'}{a.email ? <div>{a.email}</div> : null}</td>
                <td className="sub">{a.applied_at ? String(a.applied_at).slice(0, 10) : '—'}</td>
                <td><span className={`badge ${APP_BADGE[a.status] ?? 'b-gray'}`}>{APP_LABEL[a.status] ?? a.status}</span></td>
                {canAdvance && <td>
                  <select className="ainp" style={{ minWidth: 130 }} value={a.status} onChange={(e) => advance(a, e.target.value)}>
                    {APP_STATUSES.map((s) => <option key={s} value={s}>{APP_LABEL[s]}</option>)}
                  </select></td>}
              </tr>
            ))}</tbody>
          </table>
        ) : <Empty t="No applicants yet." />}
      </div>
      <div className="af"><button className="btn" onClick={onClose}>Close</button></div>
    </div></div>
  );
}

/* ==========================================================================
 * 2) STUDENT-FACING — Placements tab on the student profile
 * ======================================================================== */
export function PlacementsTab({ studentId, canApply }: { studentId: number; canApply: boolean }) {
  const [tick, setTick] = useState(0);
  const elig = useFetch<any>(`/students/${studentId}/placements`, [studentId, tick]);
  const mine = useFetch<any[]>(`/students/${studentId}/placement-applications`, [studentId, tick]);
  const openings = elig.data?.openings ?? [];
  const applications = mine.data ?? [];

  const apply = async (jobId: number) => {
    try {
      const res = await api.post<any>(`/students/${studentId}/placements/${jobId}/apply`, {});
      toast(res?.idempotent ? 'Already applied to this opening.' : 'Application submitted.');
      setTick((t) => t + 1);
    } catch (e: any) { toast(e.message, true); }
  };

  return (
    <Section title="Placement Support">
      <div className="notice" style={{ marginBottom: 10 }}><Ic k="target" /><div>Open job openings this student is <b>eligible</b> for (by their enrolled course / vertical, and any required minimum status). Eligible students can apply; staff track applications.</div></div>
      {openings.length ? openings.map((j: any) => (
        <div key={j.id} style={{ padding: 12, marginBottom: 10, border: '1px solid var(--border)', borderRadius: 8 }} data-testid={`placement-opening-${j.id}`}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <div><b>{j.title}</b>{j.employer ? <span className="sub"> · {j.employer}</span> : null}
              <div className="sub">{JOB_TYPE_LABEL[j.job_type] ?? j.job_type}{j.location ? ` · ${j.location}` : ''}{j.deadline ? ` · apply by ${String(j.deadline).slice(0, 10)}` : ''}</div>
              <div className="sub">{salaryRange(j.salary_min_minor, j.salary_max_minor)}{j.min_status ? ` · min status: ${j.min_status}` : ''}</div>
            </div>
            {j.application_id
              ? <span className={`badge ${APP_BADGE[j.application_status] ?? 'b-blue'}`}>{APP_LABEL[j.application_status] ?? 'Applied'}</span>
              : (canApply
                ? <button className="btn primary" onClick={() => apply(j.id)} data-testid={`placement-apply-${j.id}`}><Ic k="check" />Apply</button>
                : <span className="sub">Eligible</span>)}
          </div>
        </div>
      )) : <Empty t="No eligible job openings for this student right now." />}

      {applications.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="sub" style={{ fontWeight: 600, marginBottom: 6 }}>This student's applications</div>
          <table className="tbl"><thead><tr><th>Opening</th><th>Employer</th><th>Applied</th><th>Status</th></tr></thead>
            <tbody>{applications.map((a: any) => (
              <tr key={a.id}><td>{a.title}</td><td className="sub">{a.employer ?? '—'}</td>
                <td className="sub">{a.applied_at ? String(a.applied_at).slice(0, 10) : '—'}</td>
                <td><span className={`badge ${APP_BADGE[a.status] ?? 'b-gray'}`}>{APP_LABEL[a.status] ?? a.status}</span></td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
