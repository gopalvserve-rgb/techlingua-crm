/**
 * HR & WORKFORCE — ERP Batch 6 UI (Employee Directory · Staff Attendance · Leaves).
 *
 * Every listing carries the FULL list treatment: multi-select FilterMulti filters, Export
 * (values-not-ids), the TableCard column chooser (fill+title), Refresh, and bulk-delete.
 * India-first: Indian mobile/E.164, DD-MMM-YYYY dates, India leave types (Casual/Sick/Earned/
 * Unpaid), sensible defaults.
 *
 *  · EmployeeDirectoryScreen — the staff register (EMP- code, designation, department, branch/
 *                              vertical, joining, employment type, contact, personal, status, mgr).
 *  · StaffAttendanceScreen   — daily staff attendance (present/absent/half-day/leave/holiday), a
 *                              monthly sheet per branch + a per-employee summary.
 *  · LeavesScreen            — leave types (config), balances, and apply → approve/reject; on
 *                              approval the balance is deducted and the days show as Leave.
 */
import { useMemo, useState } from 'react';
import { api, getToken } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, Kpis, TableCard } from './renderer';
import { toast, useFetch, useRef_, selectableUsers } from './refdata';
import { rowActions, ConfirmModal, DetailModal, Section, KV } from './rowactions';
import { DateRange } from './daterange';
import { useScope } from './scope';
import { FilterMulti } from './dyn';

/** dev/143 item 5 — open an authed PDF the API streams (Employee ID card). */
async function openHrPdf(path: string) {
  try {
    const res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!res.ok) throw new Error(`Could not open the PDF (${res.status}).`);
    const url = URL.createObjectURL(await res.blob());
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e: any) { toast(e.message, true); }
}
import { ListActions, downloadObjectsCsv, useTableSelect, BulkBar, useBulkDelete } from './listtools';

const fmtDate = (v?: string | null) => (v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const isoToday = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => new Date().toISOString().slice(0, 7);
const uniq = (xs: any[]) => Array.from(new Set(xs.filter(Boolean)));
const asOpts = (vals: string[]) => vals.map((v) => ({ id: v, name: v }));
const DEPARTMENTS = ['Sales', 'Academics', 'Finance', 'Admin', 'Marketing'];
const EMP_TYPE_LABEL: Record<string, string> = { full_time: 'Full-time', part_time: 'Part-time', contract: 'Contract' };
const ATT_STATUS: Record<string, [string, string]> = {
  present: ['Present', 'b-green'], absent: ['Absent', 'b-rose'], half_day: ['Half-day', 'b-amber'],
  leave: ['Leave', 'b-blue'], holiday: ['Holiday', 'b-gray'],
};
const LEAVE_STATUS: Record<string, [string, string]> = {
  pending: ['Pending', 'b-amber'], approved: ['Approved', 'b-green'], rejected: ['Rejected', 'b-rose'], cancelled: ['Cancelled', 'b-gray'],
};

/* ============================================================ EMPLOYEE DIRECTORY === */
export function EmployeeDirectoryScreen() {
  const { can } = useAuth();
  const rd = useRef_();
  const { scope: gScope } = useScope();
  const [tick, setTick] = useState(0);
  const [fB, setFB] = useState<number[]>(gScope.branches);
  const [fV, setFV] = useState<number[]>(gScope.verticals);
  const [fDept, setFDept] = useState<number[]>([]);
  const [fDesig, setFDesig] = useState<number[]>([]);
  const [fStatus, setFStatus] = useState<number[]>([]);
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<any | null>(null);
  const [view, setView] = useState<any | null>(null);
  const [del, setDel] = useState<any | null>(null);
  const after = () => setTick((t) => t + 1);

  const qs = new URLSearchParams();
  if (fB.length) qs.set('branch_id', fB.join(','));
  if (fV.length) qs.set('vertical_id', fV.join(','));
  if (fDept.length) qs.set('department', fDept.map(String).join(','));
  if (fStatus.length) qs.set('status', fStatus.map(String).join(','));
  if (q) qs.set('q', q);
  const list = useFetch<any[]>(`/employees?${qs.toString()}`, [qs.toString(), tick]);
  const summary = useFetch<any>(`/employees/summary?${fB.length ? 'branch_id=' + fB.join(',') : ''}`, [fB.join(','), tick]);
  const allRows = list.data ?? [];
  const desigs = uniq(allRows.map((r) => r.designation)) as string[];
  const rows = allRows.filter((r) => (!fDesig.length || fDesig.map(String).includes(String(r.designation))));
  const ids = rows.map((r: any) => Number(r.id));
  const { selected, count, tableSelect, clear } = useTableSelect(ids);
  const { openBulk, bulkModal } = useBulkDelete('Employee', '/employees/bulk-delete/impact', '/employees/bulk-delete', () => { after(); clear(); });
  const doDelete = async () => { try { await api.del(`/employees/${del.id}`); toast('Employee deleted'); setDel(null); after(); } catch (e: any) { toast(e.message, true); } };
  const s = summary.data;

  return (
    <>
      {can('employee.create') && <div className="page-actions"><button className="btn primary" onClick={() => setEdit({})}><Ic k="plus" />Add employee</button></div>}
      <Kpis items={[
        { lab: 'Employees', val: String(s?.total ?? 0), ic: 'users' },
        { lab: 'Active', val: String(s?.active ?? 0), ic: 'check' },
        { lab: 'Inactive', val: String(s?.inactive ?? 0), ic: 'clock' },
        { lab: 'Full-time', val: String(s?.full_time ?? 0), ic: 'shield' },
      ]} />
      <div className="filters">
        <FilterMulti label="Branch" icon="branch" value={fB} options={rd.branches} onChange={setFB} />
        <FilterMulti label="Vertical" icon="grid" value={fV} options={rd.verticals} onChange={setFV} />
        <FilterMulti label="Department" icon="doc" value={fDept as any} options={asOpts(DEPARTMENTS) as any} onChange={setFDept as any} />
        <FilterMulti label="Designation" icon="doc" value={fDesig as any} options={asOpts(desigs) as any} onChange={setFDesig as any} />
        <FilterMulti label="Status" icon="shield" value={fStatus as any} options={asOpts(['active', 'inactive']) as any} onChange={setFStatus as any} />
        <label className="fchip"><Ic k="search" /><input placeholder="Search name / code / email / phone" value={q} onChange={(e) => setQ(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', font: 'inherit' }} /></label>
      </div>
      <BulkBar count={count} entityLabel="Employee" onDelete={() => openBulk(selected)} onClear={clear} />
      <TableCard fill title="Employees" icon="users"
        select={can('employee.delete') ? tableSelect : undefined}
        more={<ListActions onExport={() => downloadObjectsCsv('employees.csv', rows.map((r: any) => ({
          employee_code: r.employee_code, name: r.name, designation: r.designation, department: r.department,
          branch: r.branch_name, vertical: r.vertical_name, manager: r.manager_name, employment_type: EMP_TYPE_LABEL[r.employment_type] ?? r.employment_type,
          date_of_joining: r.date_of_joining, phone: r.phone, email: r.email, status: r.status,
        })))} onRefresh={after} />}
        cols={['Employee', 'Emp ID', 'Designation', 'Department', 'Branch', 'Manager', 'Status', 'Actions']}
        empty="No employees yet — add your first staff record."
        rows={rows.map((r: any) => [
          { node: <div><b className="nm">{r.name}</b><div className="sub">{r.phone || r.email || '—'}</div></div> } as Cell,
          { node: <span className="mono">{r.employee_code}</span> } as Cell,
          r.designation ?? '—',
          r.department ?? '—',
          r.branch_name ?? '—',
          r.manager_name ?? '—',
          { b: [r.status === 'active' ? 'Active' : 'Inactive', r.status === 'active' ? 'b-green' : 'b-gray'] } as Cell,
          rowActions({ onView: () => setView(r), onEdit: can('employee.update') ? () => setEdit(r) : undefined, onDelete: can('employee.delete') ? () => setDel(r) : undefined,
            extra: [{ k: 'doc', title: 'ID card (PDF)', onClick: () => openHrPdf(`/employees/${r.id}/id-card`) }] }),
        ])} />
      {edit && <EmployeeForm emp={edit} rd={rd} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); after(); }} />}
      {view && <EmployeeDetail id={view.id} onClose={() => setView(null)} />}
      {del && <ConfirmModal title="Delete employee?" body={`Delete "${del.name}" (${del.employee_code})?`} danger confirmLabel="Delete" onConfirm={doDelete} onClose={() => setDel(null)} />}
      {bulkModal}
    </>
  );
}

function EmployeeDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const d = useFetch<any>(`/employees/${id}`, [id]);
  const e = d.data;
  const dash = (x: any) => (x == null || x === '' ? '—' : x);
  if (!e) return <DetailModal title="Employee" icon="users" onClose={onClose}><div className="empty-note">Loading…</div></DetailModal>;
  return (
    <DetailModal title={`Employee — ${e.name}`} icon="users" width={660} onClose={onClose}>
      <Section title="Identity"><KV rows={[
        ['Employee ID', <span className="mono">{dash(e.employee_code)}</span>], ['Designation', dash(e.designation)],
        ['Department', dash(e.department)], ['Employment type', EMP_TYPE_LABEL[e.employment_type] ?? e.employment_type],
        ['Status', e.status === 'active' ? 'Active' : 'Inactive'],
        ['Placement', `${dash(e.branch_name)}${e.vertical_name ? ' › ' + e.vertical_name : ''}`],
        ['Reporting manager', dash(e.manager_name)], ['Login account', dash(e.user_name)],
      ]} /></Section>
      <Section title="Contact & personal"><KV rows={[
        ['Mobile', dash(e.phone)], ['Email', dash(e.email)], ['Date of joining', fmtDate(e.date_of_joining)],
        ['Date of birth', fmtDate(e.dob)], ['Gender', dash(e.gender)],
      ]} /></Section>
      {e.notes ? <Section title="Notes"><div style={{ fontSize: 13 }}>{e.notes}</div></Section> : null}
    </DetailModal>
  );
}

function EmployeeForm({ emp, rd, onClose, onSaved }: { emp: any; rd: any; onClose: () => void; onSaved: () => void }) {
  const isNew = !emp?.id;
  const [f, setF] = useState<any>({
    employee_code: emp.employee_code ?? '', name: emp.name ?? '', designation: emp.designation ?? '',
    department: emp.department ?? '', branch_id: emp.branch_id ?? '', vertical_id: emp.vertical_id ?? '',
    date_of_joining: emp.date_of_joining ?? '', employment_type: emp.employment_type ?? 'full_time',
    phone: emp.phone ?? '', email: emp.email ?? '', dob: emp.dob ?? '', gender: emp.gender ?? '',
    status: emp.status ?? 'active', reporting_manager_id: emp.reporting_manager_id ?? '', user_id: emp.user_id ?? '', notes: emp.notes ?? '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const vOpts = rd.verticals.filter((v: any) => !f.branch_id || Number(v.branch_id) === Number(f.branch_id));
  const managers = useFetch<any[]>('/employees?status=active', []);
  const users = selectableUsers(rd.users, emp.user_id);
  const save = async () => {
    setBusy(true);
    try {
      const body = { ...f, branch_id: f.branch_id ? Number(f.branch_id) : undefined, vertical_id: f.vertical_id ? Number(f.vertical_id) : null,
        reporting_manager_id: f.reporting_manager_id ? Number(f.reporting_manager_id) : null, user_id: f.user_id ? Number(f.user_id) : null };
      if (isNew) await api.post('/employees', body); else await api.patch(`/employees/${emp.id}`, body);
      toast(isNew ? 'Employee created' : 'Employee updated'); onSaved();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <DetailModal title={isNew ? 'Add employee' : `Edit — ${emp.name}`} icon="users" width={720} onClose={onClose}
      footer={<div style={{ display: 'flex', gap: 8 }}><button className="btn" onClick={onClose} disabled={busy}>Cancel</button><button className="btn primary" onClick={save} disabled={busy}><Ic k="check" />Save</button></div>}>
      <Section title="Identity"><div className="form-grid">
        <div className="fld"><label>Employee ID {isNew ? '(auto if blank)' : ''}</label><input className="ainp" value={f.employee_code} onChange={(e) => set('employee_code', e.target.value)} placeholder="EMP-…" /></div>
        <div className="fld"><label>Full name *</label><input className="ainp" value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
        <div className="fld"><label>Designation</label><input className="ainp" value={f.designation} onChange={(e) => set('designation', e.target.value)} placeholder="Counsellor / Trainer / Manager" /></div>
        <div className="fld"><label>Department</label><select className="ainp" value={f.department} onChange={(e) => set('department', e.target.value)}><option value="">—</option>{DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}</select></div>
        <div className="fld"><label>Employment type</label><select className="ainp" value={f.employment_type} onChange={(e) => set('employment_type', e.target.value)}><option value="full_time">Full-time</option><option value="part_time">Part-time</option><option value="contract">Contract</option></select></div>
        <div className="fld"><label>Status</label><select className="ainp" value={f.status} onChange={(e) => set('status', e.target.value)}><option value="active">Active</option><option value="inactive">Inactive</option></select></div>
      </div></Section>
      <Section title="Placement & reporting"><div className="form-grid">
        <div className="fld"><label>Branch *</label><select className="ainp" value={f.branch_id} onChange={(e) => { set('branch_id', e.target.value); set('vertical_id', ''); }}><option value="">Select</option>{rd.branches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
        <div className="fld"><label>Vertical</label><select className="ainp" value={f.vertical_id} onChange={(e) => set('vertical_id', e.target.value)} disabled={!f.branch_id}><option value="">—</option>{vOpts.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></div>
        <div className="fld"><label>Reporting manager</label><select className="ainp" value={f.reporting_manager_id} onChange={(e) => set('reporting_manager_id', e.target.value)}><option value="">—</option>{(managers.data ?? []).filter((m: any) => Number(m.id) !== Number(emp.id)).map((m: any) => <option key={m.id} value={m.id}>{m.name} ({m.employee_code})</option>)}</select></div>
        <div className="fld"><label>Login account (user)</label><select className="ainp" value={f.user_id} onChange={(e) => set('user_id', e.target.value)}><option value="">— none —</option>{users.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
      </div></Section>
      <Section title="Contact & personal"><div className="form-grid">
        <div className="fld"><label>Mobile</label><input className="ainp" value={f.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+91…" /></div>
        <div className="fld"><label>Email</label><input className="ainp" value={f.email} onChange={(e) => set('email', e.target.value)} /></div>
        <div className="fld"><label>Date of joining</label><input className="ainp" type="date" value={f.date_of_joining ?? ''} onChange={(e) => set('date_of_joining', e.target.value)} /></div>
        <div className="fld"><label>Date of birth</label><input className="ainp" type="date" value={f.dob ?? ''} onChange={(e) => set('dob', e.target.value)} /></div>
        <div className="fld"><label>Gender</label><select className="ainp" value={f.gender} onChange={(e) => set('gender', e.target.value)}><option value="">—</option><option value="male">Male</option><option value="female">Female</option><option value="other">Other</option></select></div>
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Notes</label><input className="ainp" value={f.notes} onChange={(e) => set('notes', e.target.value)} /></div>
      </div></Section>
    </DetailModal>
  );
}

/* ============================================================ STAFF ATTENDANCE === */
export function StaffAttendanceScreen() {
  const { can } = useAuth();
  const rd = useRef_();
  const { scope: gScope } = useScope();
  const [fB, setFB] = useState<number[]>(gScope.branches);
  const [fV, setFV] = useState<number[]>(gScope.verticals);
  const [date, setDate] = useState<string>(isoToday());
  const [mode, setMode] = useState<'staff' | 'self'>('staff');
  const [month, setMonth] = useState<string>(thisMonth());
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const [tick, setTick] = useState(0);
  const canMark = can('hr_attendance.mark');
  const after = () => setTick((t) => t + 1);

  const scopeQs = () => { const p = new URLSearchParams(); if (fB.length) p.set('branch_id', fB.join(',')); if (fV.length) p.set('vertical_id', fV.join(',')); return p; };

  const rosterQs = scopeQs(); rosterQs.set('date', date);
  const roster = useFetch<any>(date ? `/hr/attendance/roster?${rosterQs.toString()}` : null, [rosterQs.toString(), tick]);
  const [marks, setMarks] = useState<Record<number, string>>({});
  const rosterRows = roster.data?.roster ?? [];
  useMemo(() => {
    const m: Record<number, string> = {};
    for (const r of rosterRows) m[r.employee_id] = r.status ?? 'present';
    setMarks(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roster.data]);

  const sheetQs = scopeQs(); sheetQs.set('month', month);
  const sheet = useFetch<any>(`/hr/attendance/sheet?${sheetQs.toString()}`, [sheetQs.toString(), tick]);

  const sumQs = scopeQs();
  if (range.from) sumQs.set('from', range.from);
  if (range.to) sumQs.set('to', range.to);
  const summary = useFetch<any>(`/hr/attendance/summary?${sumQs.toString()}`, [sumQs.toString(), tick]);

  const listQs = scopeQs();
  if (range.from) listQs.set('from', range.from);
  if (range.to) listQs.set('to', range.to);
  const list = useFetch<any[]>(`/hr/attendance?${listQs.toString()}`, [listQs.toString(), tick]);
  const listRows = list.data ?? [];
  const attIds = listRows.map((r: any) => Number(r.id));
  const { selected: attSel, count: attCount, tableSelect: attSelect, clear: attClear } = useTableSelect(attIds);
  const { openBulk: attOpenBulk, bulkModal: attBulkModal } = useBulkDelete('Attendance record', '/hr/attendance/bulk-delete/impact', '/hr/attendance/bulk-delete', () => { after(); attClear(); });
  const [attDel, setAttDel] = useState<any | null>(null);
  const doAttDelete = async () => { try { await api.del(`/hr/attendance/${attDel.id}`); toast('Record deleted'); setAttDel(null); after(); } catch (e: any) { toast(e.message, true); } };
  const canAttDel = can('hr_attendance.delete');

  const save = async () => {
    if (!date) { toast('Pick a date first.', true); return; }
    const entries = rosterRows.map((r: any) => ({ employee_id: r.employee_id, status: marks[r.employee_id] ?? 'present' }));
    if (!entries.length) { toast('No employees to mark for these filters.', true); return; }
    try {
      const res = await api.post<any>('/hr/attendance/mark', { date, mode, entries });
      toast(`Attendance saved (${res.marked} marked).`); after();
    } catch (e: any) { toast(e.message, true); }
  };

  const k = summary.data?.kpis;
  const statusOpts = ['present', 'absent', 'half_day', 'leave', 'holiday'];
  const sheetData = sheet.data;
  const dayNums = sheetData ? Array.from({ length: sheetData.days_in_month }, (_, i) => i + 1) : [];

  return (
    <>
      <div className="filters">
        <FilterMulti label="Branch" icon="branch" value={fB} options={rd.branches} onChange={setFB} />
        <FilterMulti label="Vertical" icon="grid" value={fV} options={rd.verticals} onChange={setFV} />
        <label className="fchip"><Ic k="cal" /><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }} /></label>
        <label className="fchip"><Ic k="users" /><select value={mode} onChange={(e) => setMode(e.target.value as any)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }}><option value="staff">Staff marking</option><option value="self">Self check-in</option></select></label>
        <DateRange value={range} onChange={setRange} idPrefix="hratt-dr" style={{ marginLeft: 'auto' }} />
      </div>

      <Kpis items={[
        { lab: 'Present', val: String(k?.present ?? 0), ic: 'check' },
        { lab: 'Absent', val: String(k?.absent ?? 0), ic: 'clock' },
        { lab: 'On leave', val: String(k?.leave ?? 0), ic: 'cal' },
        { lab: 'Half-day', val: String(k?.half_day ?? 0), ic: 'clock' },
      ]} />

      <TableCard title={`Mark attendance — ${date}`} icon="check"
        more={canMark ? <button className="btn primary" onClick={save} data-testid="hratt-save"><Ic k="check" />Save attendance</button> : null}
        cols={['Employee', 'Dept', 'Status']}
        empty="No active employees for these filters."
        rows={rosterRows.map((r: any) => [
          { node: <div><b className="nm">{r.name}</b><div className="sub mono">{r.employee_code}</div></div> } as Cell,
          r.department ?? '—',
          { node: (<select className="ainp" style={{ maxWidth: 150 }} disabled={!canMark} value={marks[r.employee_id] ?? 'present'} onChange={(e) => setMarks((m) => ({ ...m, [r.employee_id]: e.target.value }))}>{statusOpts.map((sx) => <option key={sx} value={sx}>{ATT_STATUS[sx][0]}</option>)}</select>) } as Cell,
        ])} />

      <TableCard fill title="Monthly sheet" icon="cal"
        more={<label className="fchip"><Ic k="cal" /><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }} /></label>}
        cols={['Employee', ...dayNums.map(String), 'P', 'A', 'L']}
        empty="No employees for these filters."
        rows={(sheetData?.employees ?? []).map((e: any) => [
          { node: <div><b className="nm">{e.name}</b><div className="sub mono">{e.employee_code}</div></div> } as Cell,
          ...dayNums.map((d) => {
            const st = e.marks?.[d];
            return { node: <span title={st ? ATT_STATUS[st][0] : ''} style={{ fontWeight: 600, color: st === 'absent' ? 'var(--rose,#e11)' : st === 'leave' ? 'var(--blue,#2563eb)' : 'var(--text)' }}>{st ? ATT_STATUS[st][0][0] : '·'}</span> } as Cell;
          }),
          String(e.present), String(e.absent), String(e.leave),
        ])} />

      <BulkBar count={attCount} entityLabel="Attendance record" onDelete={() => attOpenBulk(attSel)} onClear={attClear} />
      <TableCard fill title="Attendance records" icon="list"
        select={canAttDel ? attSelect : undefined}
        more={<ListActions onExport={() => downloadObjectsCsv('staff-attendance.csv', listRows.map((a: any) => ({
          date: a.att_date, employee: a.employee_name, employee_code: a.employee_code, status: a.status, mode: a.mode,
          branch: a.branch_name, remarks: a.remarks, marked_by: a.marked_by_name,
        })))} onRefresh={after} />}
        cols={['Date', 'Employee', 'Branch', 'Status', 'Mode', 'Marked by', 'Actions']}
        empty="No attendance records for these filters."
        rows={listRows.map((a: any) => [
          fmtDate(a.att_date), a.employee_name, a.branch_name ?? '—',
          { b: ATT_STATUS[a.status] ?? [a.status, 'b-gray'] } as Cell, a.mode, a.marked_by_name ?? '—',
          rowActions({ onDelete: canAttDel ? () => setAttDel(a) : undefined }),
        ])} />
      {attDel && <ConfirmModal title="Delete attendance record?" body={`Delete ${attDel.employee_name}'s ${fmtDate(attDel.att_date)} record?`} danger confirmLabel="Delete" onConfirm={doAttDelete} onClose={() => setAttDel(null)} />}
      {attBulkModal}
    </>
  );
}

/* ============================================================ LEAVES === */
export function LeavesScreen() {
  const { can } = useAuth();
  const rd = useRef_();
  const { scope: gScope } = useScope();
  const [tick, setTick] = useState(0);
  const [fB, setFB] = useState<number[]>(gScope.branches);
  const [fStatus, setFStatus] = useState<number[]>([]);
  const [fType, setFType] = useState<number[]>([]);
  const [apply, setApply] = useState(false);
  const [decide, setDecide] = useState<{ app: any; action: 'approve' | 'reject' } | null>(null);
  const [del, setDel] = useState<any | null>(null);
  const [showTypes, setShowTypes] = useState(false);
  const [showBalances, setShowBalances] = useState(false);
  const after = () => setTick((t) => t + 1);

  const types = useFetch<any[]>('/leaves/types', [tick]);
  const summary = useFetch<any>(`/leaves/summary`, [tick]);
  const qs = new URLSearchParams();
  if (fB.length) qs.set('branch_id', fB.join(','));
  if (fStatus.length) qs.set('status', fStatus.map(String).join(','));
  if (fType.length) qs.set('leave_type_id', fType.map(String).join(','));
  const list = useFetch<any[]>(`/leaves?${qs.toString()}`, [qs.toString(), tick]);
  const rows = list.data ?? [];
  const ids = rows.map((r: any) => Number(r.id));
  const { selected, count, tableSelect, clear } = useTableSelect(ids);
  const { openBulk, bulkModal } = useBulkDelete('Leave application', '/leaves/bulk-delete/impact', '/leaves/bulk-delete', () => { after(); clear(); });
  const doDelete = async () => { try { await api.del(`/leaves/${del.id}`); toast('Leave deleted'); setDel(null); after(); } catch (e: any) { toast(e.message, true); } };
  const cancel = async (id: number) => { try { await api.post(`/leaves/${id}/cancel`); toast('Leave cancelled'); after(); } catch (e: any) { toast(e.message, true); } };
  const s = summary.data;
  const typeOpts = (types.data ?? []).map((t: any) => ({ id: t.id, name: t.name }));

  return (
    <>
      <div className="page-actions" style={{ display: 'flex', gap: 8 }}>
        {can('leave.create') && <button className="btn primary" onClick={() => setApply(true)}><Ic k="plus" />Apply for leave</button>}
        <button className="btn" onClick={() => setShowBalances(true)}><Ic k="shield" />Leave balances</button>
        {can('leave.manage') && <button className="btn" onClick={() => setShowTypes(true)}><Ic k="doc" />Leave types</button>}
      </div>
      <Kpis items={[
        { lab: 'Pending', val: String(s?.pending ?? 0), ic: 'clock' },
        { lab: 'Approved', val: String(s?.approved ?? 0), ic: 'check' },
        { lab: 'Rejected', val: String(s?.rejected ?? 0), ic: 'x' },
        { lab: 'Total', val: String(s?.total ?? 0), ic: 'list' },
      ]} />
      <div className="filters">
        <FilterMulti label="Branch" icon="branch" value={fB} options={rd.branches} onChange={setFB} />
        <FilterMulti label="Type" icon="doc" value={fType as any} options={typeOpts as any} onChange={setFType as any} />
        <FilterMulti label="Status" icon="shield" value={fStatus as any} options={asOpts(['pending', 'approved', 'rejected', 'cancelled']) as any} onChange={setFStatus as any} />
      </div>
      <BulkBar count={count} entityLabel="Leave application" onDelete={() => openBulk(selected)} onClear={clear} />
      <TableCard fill title="Leave applications" icon="cal"
        select={can('leave.delete') ? tableSelect : undefined}
        more={<ListActions onExport={() => downloadObjectsCsv('leaves.csv', rows.map((r: any) => ({
          employee: r.employee_name, employee_code: r.employee_code, type: r.type_name, from: r.from_date, to: r.to_date,
          days: r.days, status: r.status, reason: r.reason, branch: r.branch_name, decided_by: r.decided_by_name,
        })))} onRefresh={after} />}
        cols={['Employee', 'Type', 'From', 'To', 'Days', 'Status', 'Actions']}
        empty="No leave applications yet."
        rows={rows.map((r: any) => [
          { node: <div><b className="nm">{r.employee_name}</b><div className="sub mono">{r.employee_code}</div></div> } as Cell,
          r.type_name,
          fmtDate(r.from_date),
          fmtDate(r.to_date),
          String(r.days),
          { b: LEAVE_STATUS[r.status] ?? [r.status, 'b-gray'] } as Cell,
          rowActions({
            onView: undefined,
            extra: r.status === 'pending' ? [
              ...(can('leave.approve') ? [
                { k: 'check', title: 'Approve', onClick: () => setDecide({ app: r, action: 'approve' }) },
                { k: 'x', title: 'Reject', onClick: () => setDecide({ app: r, action: 'reject' }) },
              ] : []),
              ...(can('leave.create') ? [{ k: 'undo', title: 'Cancel', onClick: () => cancel(r.id) }] : []),
            ] : [],
            onDelete: can('leave.delete') ? () => setDel(r) : undefined,
          }),
        ])} />
      {apply && <ApplyLeaveModal types={types.data ?? []} onClose={() => setApply(false)} onSaved={() => { setApply(false); after(); }} />}
      {decide && <DecideLeaveModal app={decide.app} action={decide.action} onClose={() => setDecide(null)} onSaved={() => { setDecide(null); after(); }} />}
      {showTypes && <LeaveTypesModal types={types.data ?? []} onClose={() => { setShowTypes(false); after(); }} />}
      {showBalances && <LeaveBalancesModal onClose={() => setShowBalances(false)} />}
      {del && <ConfirmModal title="Delete leave application?" body={`Delete ${del.employee_name}'s ${del.type_name}?`} danger confirmLabel="Delete" onConfirm={doDelete} onClose={() => setDel(null)} />}
      {bulkModal}
    </>
  );
}

function ApplyLeaveModal({ types, onClose, onSaved }: { types: any[]; onClose: () => void; onSaved: () => void }) {
  const employees = useFetch<any[]>('/employees?status=active', []);
  const [f, setF] = useState<any>({ employee_id: '', leave_type_id: '', from_date: isoToday(), to_date: isoToday(), reason: '' });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const days = useMemo(() => {
    if (!f.from_date || !f.to_date) return 0;
    const a = new Date(f.from_date + 'T00:00:00Z').getTime(); const b = new Date(f.to_date + 'T00:00:00Z').getTime();
    return b >= a ? Math.floor((b - a) / 86400000) + 1 : 0;
  }, [f.from_date, f.to_date]);
  const save = async () => {
    if (!f.employee_id) { toast('Choose the employee.', true); return; }
    if (!f.leave_type_id) { toast('Choose a leave type.', true); return; }
    setBusy(true);
    try {
      await api.post('/leaves', { ...f, employee_id: Number(f.employee_id), leave_type_id: Number(f.leave_type_id), days });
      toast('Leave applied — sent for approval.'); onSaved();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <DetailModal title="Apply for leave" icon="cal" width={560} onClose={onClose}
      footer={<div style={{ display: 'flex', gap: 8 }}><button className="btn" onClick={onClose} disabled={busy}>Cancel</button><button className="btn primary" onClick={save} disabled={busy}><Ic k="check" />Submit</button></div>}>
      <div className="form-grid">
        <div className="fld"><label>Employee *</label><select className="ainp" value={f.employee_id} onChange={(e) => set('employee_id', e.target.value)}><option value="">Select</option>{(employees.data ?? []).map((e: any) => <option key={e.id} value={e.id}>{e.name} ({e.employee_code})</option>)}</select></div>
        <div className="fld"><label>Leave type *</label><select className="ainp" value={f.leave_type_id} onChange={(e) => set('leave_type_id', e.target.value)}><option value="">Select</option>{types.map((t: any) => <option key={t.id} value={t.id}>{t.name}{t.is_paid ? '' : ' (unpaid)'}</option>)}</select></div>
        <div className="fld"><label>From *</label><input className="ainp" type="date" value={f.from_date} onChange={(e) => set('from_date', e.target.value)} /></div>
        <div className="fld"><label>To *</label><input className="ainp" type="date" value={f.to_date} onChange={(e) => set('to_date', e.target.value)} /></div>
        <div className="fld"><label>Days</label><input className="ainp" value={days} disabled /></div>
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Reason</label><input className="ainp" value={f.reason} onChange={(e) => set('reason', e.target.value)} /></div>
      </div>
    </DetailModal>
  );
}

function DecideLeaveModal({ app, action, onClose, onSaved }: { app: any; action: 'approve' | 'reject'; onClose: () => void; onSaved: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await api.post(`/leaves/${app.id}/${action}`, { note });
      toast(action === 'approve' ? 'Leave approved — balance deducted, days marked as leave.' : 'Leave rejected.'); onSaved();
    } catch (e: any) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <DetailModal title={`${action === 'approve' ? 'Approve' : 'Reject'} leave — ${app.employee_name}`} icon={action === 'approve' ? 'check' : 'x'} width={520} onClose={onClose}
      footer={<div style={{ display: 'flex', gap: 8 }}><button className="btn" onClick={onClose} disabled={busy}>Cancel</button><button className={`btn ${action === 'approve' ? 'primary' : 'danger'}`} onClick={go} disabled={busy}><Ic k={action === 'approve' ? 'check' : 'x'} />{action === 'approve' ? 'Approve' : 'Reject'}</button></div>}>
      <Section title="Request"><KV rows={[
        ['Employee', `${app.employee_name} (${app.employee_code})`], ['Type', app.type_name],
        ['Dates', `${fmtDate(app.from_date)} → ${fmtDate(app.to_date)} (${app.days} day${app.days === 1 ? '' : 's'})`],
        ['Reason', app.reason || '—'],
      ]} /></Section>
      <div className="fld"><label>{action === 'approve' ? 'Note (optional)' : 'Reason for rejection'}</label><input className="ainp" value={note} onChange={(e) => setNote(e.target.value)} /></div>
    </DetailModal>
  );
}

function LeaveTypesModal({ types, onClose }: { types: any[]; onClose: () => void }) {
  const [tick, setTick] = useState(0);
  const live = useFetch<any[]>('/leaves/types?all=1', [tick]);
  const [edit, setEdit] = useState<any | null>(null);
  const rows = live.data ?? types;
  const save = async (t: any) => { try { await api.post('/leaves/types', t); toast('Saved'); setEdit(null); setTick((x) => x + 1); } catch (e: any) { toast(e.message, true); } };
  const remove = async (id: number) => { try { await api.del(`/leaves/types/${id}`); toast('Deleted'); setTick((x) => x + 1); } catch (e: any) { toast(e.message, true); } };
  return (
    <DetailModal title="Leave types" icon="doc" width={640} onClose={onClose}
      footer={<button className="btn primary" onClick={() => setEdit({ is_paid: true, is_active: true, default_annual_quota: 0 })}><Ic k="plus" />Add type</button>}>
      <TableCard title="" cols={['Name', 'Code', 'Paid', 'Quota/yr', 'Active', 'Actions']}
        empty="No leave types."
        rows={rows.map((t: any) => [
          t.name, { node: <span className="mono">{t.code}</span> } as Cell, t.is_paid ? 'Paid' : 'Unpaid', String(t.default_annual_quota),
          { b: [t.is_active ? 'Active' : 'Inactive', t.is_active ? 'b-green' : 'b-gray'] } as Cell,
          rowActions({ onEdit: () => setEdit(t), onDelete: () => remove(t.id) }),
        ])} />
      {edit && <TypeEditor t={edit} onClose={() => setEdit(null)} onSave={save} />}
    </DetailModal>
  );
}

function TypeEditor({ t, onClose, onSave }: { t: any; onClose: () => void; onSave: (t: any) => void }) {
  const [f, setF] = useState<any>({ id: t.id, name: t.name ?? '', code: t.code ?? '', is_paid: t.is_paid ?? true, default_annual_quota: t.default_annual_quota ?? 0, is_active: t.is_active ?? true });
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  return (
    <DetailModal title={t.id ? 'Edit leave type' : 'Add leave type'} icon="doc" width={480} onClose={onClose}
      footer={<div style={{ display: 'flex', gap: 8 }}><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => onSave({ ...f, default_annual_quota: Number(f.default_annual_quota || 0) })}><Ic k="check" />Save</button></div>}>
      <div className="form-grid">
        <div className="fld"><label>Name *</label><input className="ainp" value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
        <div className="fld"><label>Code *</label><input className="ainp" value={f.code} onChange={(e) => set('code', e.target.value)} placeholder="CL / SL / EL" /></div>
        <div className="fld"><label>Default quota / year</label><input className="ainp" type="number" value={f.default_annual_quota} onChange={(e) => set('default_annual_quota', e.target.value)} /></div>
        <div className="fld"><label>Paid?</label><select className="ainp" value={f.is_paid ? '1' : '0'} onChange={(e) => set('is_paid', e.target.value === '1')}><option value="1">Paid</option><option value="0">Unpaid</option></select></div>
        <div className="fld"><label>Active?</label><select className="ainp" value={f.is_active ? '1' : '0'} onChange={(e) => set('is_active', e.target.value === '1')}><option value="1">Active</option><option value="0">Inactive</option></select></div>
      </div>
    </DetailModal>
  );
}

function LeaveBalancesModal({ onClose }: { onClose: () => void }) {
  const employees = useFetch<any[]>('/employees?status=active', []);
  const [empId, setEmpId] = useState<string>('');
  const [tick, setTick] = useState(0);
  const bal = useFetch<any[]>(empId ? `/leaves/balances?employee_id=${empId}` : null, [empId, tick]);
  return (
    <DetailModal title="Leave balances" icon="shield" width={640} onClose={onClose}>
      <div className="fld"><label>Employee</label><select className="ainp" value={empId} onChange={(e) => setEmpId(e.target.value)}><option value="">Select an employee</option>{(employees.data ?? []).map((e: any) => <option key={e.id} value={e.id}>{e.name} ({e.employee_code})</option>)}</select></div>
      {empId ? (
        <TableCard title={`Balances — ${new Date().getFullYear()}`} cols={['Type', 'Allocated', 'Used', 'Available']}
          empty="No balances yet."
          rows={(bal.data ?? []).map((b: any) => [b.type_name, String(b.allocated), String(b.used), String(b.available)])} />
      ) : <div className="notice"><Ic k="shield" /><div>Pick an employee to see their leave balances.</div></div>}
    </DetailModal>
  );
}
