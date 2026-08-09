/**
 * Students & Academics — ERP Batch 1 UI: Attendance, Tests & Scores, Assignments, plus the
 * Batch Roster / Transfer / Waitlist modal (opened from the Batches list).
 *
 * Self-contained (no ScreenCtx) like support.tsx / crosssell.tsx: each screen owns its filters
 * and refresh. Every API route has a caller here (route-reachability guard).
 */
import { useMemo, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, Kpis, TableCard } from './renderer';
import { toast, useFetch, useRef_, selectableUsers } from './refdata';
import { rowActions, fmtFull, ConfirmModal, DetailModal } from './rowactions';
import { DateRange } from './daterange';
import { useScope } from './scope';
import { FilterMulti } from './dyn';
import { ListActions, downloadObjectsCsv } from './listtools';

/* ------------------------------------------------------------ shared bits -- */

function useBatches(branchIds: number[], verticalIds: number[], dep: any[] = []) {
  const p = new URLSearchParams();
  if (branchIds.length) p.set('branch_id', branchIds.join(','));
  if (verticalIds.length) p.set('vertical_id', verticalIds.join(','));
  return useFetch<any[]>(`/batches?${p.toString()}`, [p.toString(), ...dep]);
}

/** Branch + Vertical + Batch filter row shared by all three screens. */
function ScopeFilters({ ref, fB, setFB, fV, setFV, batchId, setBatchId, batches, extra }: any) {
  const vOpts = ref.verticals.filter((vt: any) => !fB.length || fB.includes(Number(vt.branch_id)));
  return (
    <div className="filters">
      <FilterMulti label="Branch" icon="branch" value={fB} options={ref.branches}
        onChange={(v: number[]) => { setFB(v); setFV((cur: number[]) => cur.filter((id) => ref.verticals.some((vt: any) => Number(vt.id) === id && v.includes(Number(vt.branch_id))))); setBatchId(''); }} />
      <FilterMulti label="Vertical" icon="grid" value={fV} options={vOpts} onChange={(v: number[]) => { setFV(v); setBatchId(''); }} />
      <label className="fchip"><Ic k="grid" />
        <select value={batchId} onChange={(e) => setBatchId(e.target.value)}
          style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }}>
          <option value="">All batches</option>
          {(batches ?? []).map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </label>
      {extra}
    </div>
  );
}

const isoToday = () => new Date().toISOString().slice(0, 10);

/* ==========================================================================
 * 1) ATTENDANCE
 * ======================================================================== */
export function AttendanceScreen() {
  const ref = useRef_();
  const { scope: gScope } = useScope();
  const { can } = useAuth();
  const [fB, setFB] = useState<number[]>(gScope.branch ? [gScope.branch] : []);
  const [fV, setFV] = useState<number[]>(gScope.vertical ? [gScope.vertical] : []);
  const [batchId, setBatchId] = useState<string>('');
  const [date, setDate] = useState<string>(isoToday());
  const [mode, setMode] = useState<'staff' | 'self'>('staff');
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const [tick, setTick] = useState(0);
  const batches = useBatches(fB, fV);
  const canMark = can('attendance.mark');

  const roster = useFetch<any>(batchId && date ? `/academics/attendance/roster?batch_id=${batchId}&date=${date}` : null, [batchId, date, tick]);
  const [marks, setMarks] = useState<Record<number, string>>({});
  const rosterRows = roster.data?.roster ?? [];
  // seed marks from existing rows whenever the roster loads
  useMemo(() => {
    const m: Record<number, string> = {};
    for (const r of rosterRows) m[r.student_id] = r.status ?? 'present';
    setMarks(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roster.data]);

  const sumQs = new URLSearchParams();
  if (batchId) sumQs.set('batch_id', batchId);
  if (range.from) sumQs.set('from', range.from);
  if (range.to) sumQs.set('to', range.to);
  const summary = useFetch<any>(`/academics/attendance/summary?${sumQs.toString()}`, [sumQs.toString(), tick]);

  const listQs = new URLSearchParams();
  if (batchId) listQs.set('batch_id', batchId);
  if (fB.length) listQs.set('branch_id', fB.join(','));
  if (fV.length) listQs.set('vertical_id', fV.join(','));
  if (range.from) listQs.set('from', range.from);
  if (range.to) listQs.set('to', range.to);
  const list = useFetch<any[]>(`/academics/attendance?${listQs.toString()}`, [listQs.toString(), tick]);

  const save = async () => {
    if (!batchId || !date) { toast('Pick a batch and a date first.', true); return; }
    const entries = rosterRows.map((r: any) => ({ student_id: r.student_id, status: marks[r.student_id] ?? 'present' }));
    try {
      const res = await api.post<any>('/academics/attendance/mark', { batch_id: Number(batchId), date, mode, entries });
      toast(`Attendance saved (${res.marked} marked${res.parent_notified ? `, ${res.parent_notified} parent alert(s) sent` : ''}).`);
      setTick((t) => t + 1);
    } catch (e: any) { toast(e.message, true); }
  };

  const k = summary.data?.kpis;
  const statusOpts = ['present', 'absent', 'late', 'excused'];

  return (
    <>
      <ScopeFilters ref={ref} fB={fB} setFB={setFB} fV={fV} setFV={setFV} batchId={batchId} setBatchId={setBatchId} batches={batches.data}
        extra={<>
          <label className="fchip"><Ic k="cal" /><input type="date" value={date} onChange={(e) => setDate(e.target.value)}
            style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }} /></label>
          <label className="fchip"><Ic k="users" />
            <select value={mode} onChange={(e) => setMode(e.target.value as any)}
              style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }}>
              <option value="staff">Staff marking</option>
              <option value="self">Self marking</option>
            </select>
          </label>
          <DateRange value={range} onChange={setRange} idPrefix="att-dr" style={{ marginLeft: 'auto' }} />
        </>} />

      <Kpis items={[
        { lab: 'Present', val: String(k?.present ?? 0), ic: 'check' },
        { lab: 'Absent', val: String(k?.absent ?? 0), ic: 'clock' },
        { lab: 'Attendance %', val: k?.present_pct != null ? `${k.present_pct}%` : '—', ic: 'perf' },
        { lab: 'Parent alerts', val: String(k?.parent_alerts ?? 0), ic: 'wa' },
      ]} />

      {batchId ? (
        <TableCard title={`Mark session — ${roster.data?.batch?.name ?? ''} · ${date}`} icon="check"
          more={canMark ? <button className="btn primary" onClick={save} data-testid="att-save"><Ic k="check" />Save attendance</button> : null}
          cols={['Student', 'Status', 'Guardian']}
          empty="No students in this batch yet."
          rows={rosterRows.map((r: any) => [
            { node: <div><b className="nm">{r.full_name}</b><div className="sub mono">{r.student_no ?? '—'}</div></div> } as Cell,
            {
              node: (
                <select className="ainp" style={{ maxWidth: 150 }} disabled={!canMark}
                  value={marks[r.student_id] ?? 'present'} onChange={(e) => setMarks((m) => ({ ...m, [r.student_id]: e.target.value }))}>
                  {statusOpts.map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
                </select>
              ),
            } as Cell,
            r.guardian_mobile || r.father_mobile || '—',
          ])} />
      ) : (
        <div className="notice"><Ic k="cal" /><div>Pick a <b>batch</b> and a <b>date</b> above to mark a session. Records below reflect your filters.</div></div>
      )}

      <TableCard fill title="Attendance records" icon="list"
        more={<ListActions onExport={() => downloadObjectsCsv('attendance.csv', list.data ?? [])} onRefresh={() => setTick((t) => t + 1)} />}
        cols={['Date', 'Student', 'Batch', 'Status', 'Mode', 'Parent alert', 'Marked by']}
        empty="No attendance records for these filters."
        rows={(list.data ?? []).map((a: any) => [
          fmtFull(a.session_date),
          a.student_name,
          a.batch_name,
          a.status,
          a.mode,
          a.parent_notified ? 'Sent' : '—',
          a.marked_by_name ?? '—',
        ])} />
    </>
  );
}

/* ==========================================================================
 * 2) TESTS & SCORES
 * ======================================================================== */
export function TestsScreen() {
  const ref = useRef_();
  const { scope: gScope } = useScope();
  const { can } = useAuth();
  const [fB, setFB] = useState<number[]>(gScope.branch ? [gScope.branch] : []);
  const [fV, setFV] = useState<number[]>(gScope.vertical ? [gScope.vertical] : []);
  const [batchId, setBatchId] = useState<string>('');
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const [tick, setTick] = useState(0);
  const batches = useBatches(fB, fV);
  const [add, setAdd] = useState(false);
  const [edit, setEdit] = useState<any | null>(null);
  const [view, setView] = useState<any | null>(null);
  const [del, setDel] = useState<any | null>(null);

  const qs = new URLSearchParams();
  if (batchId) qs.set('batch_id', batchId);
  if (fB.length) qs.set('branch_id', fB.join(','));
  if (fV.length) qs.set('vertical_id', fV.join(','));
  if (range.from) qs.set('from', range.from);
  if (range.to) qs.set('to', range.to);
  const list = useFetch<any[]>(`/academics/tests?${qs.toString()}`, [qs.toString(), tick]);
  const after = () => setTick((t) => t + 1);
  const rows = list.data ?? [];

  const doDelete = async () => { try { await api.del(`/academics/tests/${del.id}`); toast('Test deleted'); setDel(null); after(); } catch (e: any) { toast(e.message, true); } };

  return (
    <>
      {can('test.create') && <div className="page-actions"><button className="btn primary" onClick={() => setAdd(true)}><Ic k="plus" />New test</button></div>}
      <ScopeFilters ref={ref} fB={fB} setFB={setFB} fV={fV} setFV={setFV} batchId={batchId} setBatchId={setBatchId} batches={batches.data}
        extra={<DateRange value={range} onChange={setRange} idPrefix="test-dr" style={{ marginLeft: 'auto' }} />} />
      <TableCard fill title="Tests" icon="doc"
        more={<ListActions onExport={() => downloadObjectsCsv('tests.csv', rows)} onRefresh={after} />}
        cols={['Test', 'Type', 'Batch', 'Date', 'Max', 'Avg', 'Scored', 'Actions']}
        empty="No tests yet — create one for a batch."
        onRowClick={(i) => setView(rows[i])}
        rows={rows.map((t: any) => [
          { node: <b className="nm">{t.name}</b> } as Cell,
          t.test_type,
          t.batch_name,
          t.test_date ? fmtFull(t.test_date) : '—',
          String(t.max_marks),
          t.avg_marks != null ? String(t.avg_marks) : '—',
          String(t.scored ?? 0),
          rowActions({
            onView: () => setView(t),
            onEdit: can('test.update') ? () => setEdit(t) : undefined,
            onDelete: can('test.delete') ? () => setDel(t) : undefined,
          }),
        ])} />
      {add && <TestModal onClose={() => setAdd(false)} onSaved={after} batches={batches.data ?? []} />}
      {edit && <TestModal initial={edit} onClose={() => setEdit(null)} onSaved={after} batches={batches.data ?? []} />}
      {view && <TestDetailModal test={view} onClose={() => setView(null)} onChanged={after} />}
      {del && <ConfirmModal title="Delete test?" body={`Delete "${del.name}"? Its scores are hidden with it.`} danger confirmLabel="Delete"
        onConfirm={doDelete} onClose={() => setDel(null)} />}
    </>
  );
}

function TestModal({ initial, onClose, onSaved, batches }: { initial?: any; onClose: () => void; onSaved: () => void; batches: any[] }) {
  const isEdit = !!initial?.id;
  const [batchId, setBatchId] = useState<string>(String(initial?.batch_id ?? ''));
  const [name, setName] = useState<string>(initial?.name ?? '');
  const [type, setType] = useState<string>(initial?.test_type ?? 'quiz');
  const [testDate, setTestDate] = useState<string>(initial?.test_date ? String(initial.test_date).slice(0, 10) : '');
  const [max, setMax] = useState<string>(String(initial?.max_marks ?? '100'));
  const [pass, setPass] = useState<string>(initial?.pass_marks != null ? String(initial.pass_marks) : '');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');

  const save = async () => {
    setErr('');
    if (!isEdit && !batchId) return setErr('Choose a batch.');
    if (!name.trim()) return setErr('Give the test a name.');
    if (!(Number(max) > 0)) return setErr('Max marks must be greater than zero.');
    setBusy(true);
    const body: any = { name: name.trim(), test_type: type, test_date: testDate || null, max_marks: Number(max), pass_marks: pass === '' ? null : Number(pass) };
    if (!isEdit) body.batch_id = Number(batchId);
    try {
      if (isEdit) await api.patch(`/academics/tests/${initial.id}`, body);
      else await api.post('/academics/tests', body);
      toast(isEdit ? 'Test updated' : 'Test created'); onSaved(); onClose();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim"><div className="add-modal" style={{ maxWidth: 560 }}>
      <div className="ah"><h3><Ic k="doc" />{isEdit ? 'Edit test' : 'New test'}</h3><button className="ax" onClick={onClose}><Ic k="x" /></button></div>
      <div className="abody"><div className="form-grid">
        {!isEdit && (
          <div className="fld"><label>Batch <span className="star">*</span></label>
            <select className="ainp" value={batchId} onChange={(e) => setBatchId(e.target.value)}>
              <option value="">— Select batch —</option>
              {batches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select></div>
        )}
        <div className="fld"><label>Name <span className="star">*</span></label><input className="ainp" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="fld"><label>Type</label>
          <select className="ainp" value={type} onChange={(e) => setType(e.target.value)}>
            {['quiz', 'mock', 'exam', 'assignment', 'other'].map((t) => <option key={t} value={t}>{t}</option>)}
          </select></div>
        <div className="fld"><label>Test date</label><input className="ainp" type="date" value={testDate} onChange={(e) => setTestDate(e.target.value)} /></div>
        <div className="fld"><label>Max marks <span className="star">*</span></label><input className="ainp" type="number" value={max} onChange={(e) => setMax(e.target.value)} /></div>
        <div className="fld"><label>Pass marks</label><input className="ainp" type="number" value={pass} onChange={(e) => setPass(e.target.value)} /></div>
      </div>{err && <div className="form-err" style={{ marginTop: 8 }}>{err}</div>}</div>
      <div className="af"><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={save}><Ic k="check" />{busy ? 'Saving…' : 'Save'}</button></div>
    </div></div>
  );
}

function TestDetailModal({ test, onClose, onChanged }: { test: any; onClose: () => void; onChanged: () => void }) {
  const { can } = useAuth();
  const detail = useFetch<any>(`/academics/tests/${test.id}`, [test.id]);
  const [scores, setScores] = useState<Record<number, string>>({});
  const rows = detail.data?.results ?? [];
  useMemo(() => {
    const m: Record<number, string> = {};
    for (const r of rows) if (r.marks_obtained != null) m[r.student_id] = String(r.marks_obtained);
    setScores(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data]);
  const canGrade = can('test.grade');
  const save = async () => {
    const entries = rows.filter((r: any) => scores[r.student_id] !== undefined && scores[r.student_id] !== '')
      .map((r: any) => ({ student_id: r.student_id, marks_obtained: Number(scores[r.student_id]) }));
    if (!entries.length) { toast('Enter at least one score.', true); return; }
    try { const res = await api.post<any>(`/academics/tests/${test.id}/scores`, { entries }); toast(`${res.saved} score(s) saved`); detail.reload(); onChanged(); }
    catch (e: any) { toast(e.message, true); }
  };
  return (
    <DetailModal title={`${test.name} — results`} icon="doc" width={640} onClose={onClose}
      footer={canGrade ? <button className="btn primary" onClick={save} data-testid="save-scores"><Ic k="check" />Save scores</button> : undefined}>
      <div className="page-sub" style={{ marginBottom: 10 }}>Max {detail.data?.max_marks ?? test.max_marks} · {detail.data?.batch_name}</div>
      <TableCard title="Score sheet" icon="perf"
        more={<ListActions onExport={() => downloadObjectsCsv('scores.csv', rows)} />}
        cols={['Student', 'Marks', 'Grade']}
        empty="No students in this batch."
        rows={rows.map((r: any) => [
          { node: <div><b className="nm">{r.full_name}</b><div className="sub mono">{r.student_no ?? '—'}</div></div> } as Cell,
          { node: <input className="ainp" style={{ maxWidth: 100 }} type="number" disabled={!canGrade}
            value={scores[r.student_id] ?? ''} onChange={(e) => setScores((s) => ({ ...s, [r.student_id]: e.target.value }))} /> } as Cell,
          r.grade ?? '—',
        ])} />
    </DetailModal>
  );
}

/* ==========================================================================
 * 3) ASSIGNMENTS (coursework)
 * ======================================================================== */
export function AssignmentsScreen() {
  const ref = useRef_();
  const { scope: gScope } = useScope();
  const { can } = useAuth();
  const [fB, setFB] = useState<number[]>(gScope.branch ? [gScope.branch] : []);
  const [fV, setFV] = useState<number[]>(gScope.vertical ? [gScope.vertical] : []);
  const [batchId, setBatchId] = useState<string>('');
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const [tick, setTick] = useState(0);
  const batches = useBatches(fB, fV);
  const [add, setAdd] = useState(false);
  const [edit, setEdit] = useState<any | null>(null);
  const [view, setView] = useState<any | null>(null);
  const [del, setDel] = useState<any | null>(null);

  const qs = new URLSearchParams();
  if (batchId) qs.set('batch_id', batchId);
  if (fB.length) qs.set('branch_id', fB.join(','));
  if (fV.length) qs.set('vertical_id', fV.join(','));
  if (range.from) qs.set('from', range.from);
  if (range.to) qs.set('to', range.to);
  const list = useFetch<any[]>(`/academics/coursework?${qs.toString()}`, [qs.toString(), tick]);
  const after = () => setTick((t) => t + 1);
  const rows = list.data ?? [];
  const doDelete = async () => { try { await api.del(`/academics/coursework/${del.id}`); toast('Assignment deleted'); setDel(null); after(); } catch (e: any) { toast(e.message, true); } };

  return (
    <>
      {can('coursework.create') && <div className="page-actions"><button className="btn primary" onClick={() => setAdd(true)}><Ic k="plus" />New assignment</button></div>}
      <ScopeFilters ref={ref} fB={fB} setFB={setFB} fV={fV} setFV={setFV} batchId={batchId} setBatchId={setBatchId} batches={batches.data}
        extra={<DateRange value={range} onChange={setRange} idPrefix="cw-dr" style={{ marginLeft: 'auto' }} />} />
      <TableCard fill title="Assignments" icon="doc"
        more={<ListActions onExport={() => downloadObjectsCsv('assignments.csv', rows)} onRefresh={after} />}
        cols={['Assignment', 'Batch', 'Due', 'Submitted', 'Graded', 'Actions']}
        empty="No assignments yet — create one for a batch."
        onRowClick={(i) => setView(rows[i])}
        rows={rows.map((a: any) => [
          { node: <b className="nm">{a.title}</b> } as Cell,
          a.batch_name,
          a.due_date ? fmtFull(a.due_date) : '—',
          String(a.submitted ?? 0),
          String(a.graded ?? 0),
          rowActions({
            onView: () => setView(a),
            onEdit: can('coursework.update') ? () => setEdit(a) : undefined,
            onDelete: can('coursework.delete') ? () => setDel(a) : undefined,
          }),
        ])} />
      {add && <AssignmentModal onClose={() => setAdd(false)} onSaved={after} batches={batches.data ?? []} />}
      {edit && <AssignmentModal initial={edit} onClose={() => setEdit(null)} onSaved={after} batches={batches.data ?? []} />}
      {view && <AssignmentDetailModal assignment={view} onClose={() => setView(null)} onChanged={after} />}
      {del && <ConfirmModal title="Delete assignment?" body={`Delete "${del.title}"? Its submissions are hidden with it.`} danger confirmLabel="Delete"
        onConfirm={doDelete} onClose={() => setDel(null)} />}
    </>
  );
}

function AssignmentModal({ initial, onClose, onSaved, batches }: { initial?: any; onClose: () => void; onSaved: () => void; batches: any[] }) {
  const isEdit = !!initial?.id;
  const [batchId, setBatchId] = useState<string>(String(initial?.batch_id ?? ''));
  const [title, setTitle] = useState<string>(initial?.title ?? '');
  const [desc, setDesc] = useState<string>(initial?.description ?? '');
  const [due, setDue] = useState<string>(initial?.due_date ? String(initial.due_date).slice(0, 10) : '');
  const [url, setUrl] = useState<string>(initial?.attachment_url ?? '');
  const [max, setMax] = useState<string>(initial?.max_marks != null ? String(initial.max_marks) : '');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const save = async () => {
    setErr('');
    if (!isEdit && !batchId) return setErr('Choose a batch.');
    if (!title.trim()) return setErr('Give the assignment a title.');
    setBusy(true);
    const body: any = { title: title.trim(), description: desc || null, due_date: due || null, attachment_url: url || null, max_marks: max === '' ? null : Number(max) };
    if (!isEdit) body.batch_id = Number(batchId);
    try {
      if (isEdit) await api.patch(`/academics/coursework/${initial.id}`, body);
      else await api.post('/academics/coursework', body);
      toast(isEdit ? 'Assignment updated' : 'Assignment created'); onSaved(); onClose();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="add-scrim"><div className="add-modal" style={{ maxWidth: 600 }}>
      <div className="ah"><h3><Ic k="doc" />{isEdit ? 'Edit assignment' : 'New assignment'}</h3><button className="ax" onClick={onClose}><Ic k="x" /></button></div>
      <div className="abody"><div className="form-grid">
        {!isEdit && (
          <div className="fld"><label>Batch <span className="star">*</span></label>
            <select className="ainp" value={batchId} onChange={(e) => setBatchId(e.target.value)}>
              <option value="">— Select batch —</option>
              {batches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select></div>
        )}
        <div className="fld"><label>Title <span className="star">*</span></label><input className="ainp" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
        <div className="fld"><label>Due date</label><input className="ainp" type="date" value={due} onChange={(e) => setDue(e.target.value)} /></div>
        <div className="fld"><label>Max marks</label><input className="ainp" type="number" value={max} onChange={(e) => setMax(e.target.value)} /></div>
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Attachment link</label><input className="ainp" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" /></div>
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Description</label><textarea className="ainp" rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} /></div>
      </div>{err && <div className="form-err" style={{ marginTop: 8 }}>{err}</div>}</div>
      <div className="af"><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={save}><Ic k="check" />{busy ? 'Saving…' : 'Save'}</button></div>
    </div></div>
  );
}

function AssignmentDetailModal({ assignment, onClose, onChanged }: { assignment: any; onClose: () => void; onChanged: () => void }) {
  const { can } = useAuth();
  const detail = useFetch<any>(`/academics/coursework/${assignment.id}`, [assignment.id]);
  const rows = detail.data?.submissions ?? [];
  const [gm, setGm] = useState<Record<number, { marks: string; feedback: string }>>({});
  const canUpdate = can('coursework.update');
  const canGrade = can('coursework.grade');
  const setField = (sid: number, k: 'marks' | 'feedback', v: string) => setGm((s) => ({ ...s, [sid]: { marks: s[sid]?.marks ?? '', feedback: s[sid]?.feedback ?? '', [k]: v } }));

  const markSubmitted = async (sid: number) => {
    try { await api.post(`/academics/coursework/${assignment.id}/submissions`, { student_id: sid, status: 'submitted' }); toast('Marked submitted'); detail.reload(); onChanged(); }
    catch (e: any) { toast(e.message, true); }
  };
  const grade = async (sid: number) => {
    const g = gm[sid] ?? { marks: '', feedback: '' };
    try { await api.post(`/academics/coursework/${assignment.id}/grade`, { student_id: sid, marks: g.marks === '' ? null : Number(g.marks), feedback: g.feedback || null }); toast('Graded'); detail.reload(); onChanged(); }
    catch (e: any) { toast(e.message, true); }
  };
  return (
    <DetailModal title={`${assignment.title} — submissions`} icon="doc" width={720} onClose={onClose}>
      <div className="page-sub" style={{ marginBottom: 10 }}>{detail.data?.batch_name}{detail.data?.max_marks != null ? ` · Max ${detail.data.max_marks}` : ''}</div>
      <TableCard title="Submission tracker" icon="list"
        more={<ListActions onExport={() => downloadObjectsCsv('submissions.csv', rows)} />}
        cols={['Student', 'Status', 'Marks', 'Feedback', 'Actions']}
        empty="No students in this batch."
        rows={rows.map((r: any) => [
          { node: <b className="nm">{r.full_name}</b> } as Cell,
          r.status,
          { node: <input className="ainp" style={{ maxWidth: 80 }} type="number" disabled={!canGrade}
            value={gm[r.student_id]?.marks ?? (r.marks ?? '')} onChange={(e) => setField(r.student_id, 'marks', e.target.value)} /> } as Cell,
          { node: <input className="ainp" disabled={!canGrade} value={gm[r.student_id]?.feedback ?? (r.feedback ?? '')} onChange={(e) => setField(r.student_id, 'feedback', e.target.value)} /> } as Cell,
          {
            node: (
              <span style={{ display: 'inline-flex', gap: 6 }}>
                {canUpdate && r.status === 'assigned' && <button className="btn" onClick={() => markSubmitted(r.student_id)}>Submitted</button>}
                {canGrade && <button className="btn primary" onClick={() => grade(r.student_id)}>Grade</button>}
              </span>
            ),
          } as Cell,
        ])} />
    </DetailModal>
  );
}

/* ==========================================================================
 * 4) BATCH ROSTER / TRANSFER / WAITLIST  (opened from the Batches list)
 * ======================================================================== */
export function BatchRosterModal({ batch, onClose, onChanged }: { batch: any; onClose: () => void; onChanged: () => void }) {
  const { can } = useAuth();
  const [tick, setTick] = useState(0);
  const roster = useFetch<any>(`/academics/batches/${batch.id}/roster`, [batch.id, tick]);
  const [transferFor, setTransferFor] = useState<any | null>(null);
  const canManage = can('student.update');
  const seats = roster.data?.seats;
  const members = roster.data?.members ?? [];
  const waitlist = roster.data?.waitlist ?? [];
  const history = roster.data?.history ?? [];
  const after = () => { setTick((t) => t + 1); onChanged(); };

  const promote = async (id: number) => { try { await api.post(`/academics/waitlist/${id}/promote`, {}); toast('Promoted from waitlist'); after(); } catch (e: any) { toast(e.message, true); } };
  const removeW = async (id: number) => { try { await api.del(`/academics/waitlist/${id}`); toast('Removed from waitlist'); after(); } catch (e: any) { toast(e.message, true); } };

  return (
    <DetailModal title={`Roster — ${batch.name}`} icon="grid" width={760} onClose={onClose}>
      <Kpis items={[
        { lab: 'Capacity', val: seats?.capacity ? String(seats.capacity) : '∞', ic: 'grid' },
        { lab: 'Seats filled', val: String(seats?.filled ?? 0), ic: 'users' },
        { lab: 'Free', val: seats?.free == null ? '∞' : String(seats.free), ic: 'check' },
        { lab: 'Waitlisted', val: String(seats?.waitlist ?? 0), ic: 'clock' },
      ]} />

      <TableCard title="Students in this batch" icon="students"
        cols={['Student', 'Phone', 'Owner', 'Actions']}
        empty="No students assigned to this batch yet."
        rows={members.map((s: any) => [
          { node: <div><b className="nm">{s.full_name}</b><div className="sub mono">{s.student_no ?? '—'}</div></div> } as Cell,
          s.phone ?? '—',
          s.owner_name ?? '—',
          canManage ? { node: <button className="btn" onClick={() => setTransferFor(s)}><Ic k="swap" />Transfer</button> } as Cell : '—',
        ])} />

      {waitlist.length > 0 && (
        <TableCard title="Waitlist" icon="clock"
          cols={['#', 'Student', 'Note', 'Actions']}
          empty="Empty"
          rows={waitlist.map((w: any) => [
            String(w.position),
            { node: <b className="nm">{w.full_name}</b> } as Cell,
            w.note ?? '—',
            canManage ? {
              node: <span style={{ display: 'inline-flex', gap: 6 }}>
                <button className="btn primary" onClick={() => promote(w.id)}>Promote</button>
                <button className="btn" onClick={() => removeW(w.id)}>Remove</button>
              </span>,
            } as Cell : '—',
          ])} />
      )}

      <TableCard title="Transfer history" icon="swap"
        cols={['When', 'Student', 'From', 'To', 'By']}
        empty="No transfers recorded."
        rows={history.map((h: any) => [
          fmtFull(h.created_at),
          h.student_name,
          h.from_batch_name ?? '—',
          h.to_batch_name ?? '—',
          h.by_name ?? '—',
        ])} />

      {transferFor && <TransferModal student={transferFor} fromBatch={batch} onClose={() => setTransferFor(null)} onDone={() => { setTransferFor(null); after(); }} />}
    </DetailModal>
  );
}

function TransferModal({ student, fromBatch, onClose, onDone }: { student: any; fromBatch: any; onClose: () => void; onDone: () => void }) {
  // Target batches: same branch+vertical by default (the common case); a wider move re-places the student.
  const batches = useFetch<any[]>(`/batches?branch_id=${fromBatch.branch_id}&vertical_id=${fromBatch.vertical_id}`, []);
  const [toId, setToId] = useState<string>('');
  const [reason, setReason] = useState<string>('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const opts = (batches.data ?? []).filter((b) => Number(b.id) !== Number(fromBatch.id));
  const go = async () => {
    setErr(''); if (!toId) return setErr('Choose a target batch.');
    setBusy(true);
    try {
      const res = await api.post<any>('/academics/transfer', { student_id: student.id, to_batch_id: Number(toId), reason: reason || null });
      toast(res.waitlisted ? 'Target batch is full — student added to its waitlist.' : 'Student transferred.');
      onDone();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="add-scrim" style={{ zIndex: 320 }}><div className="add-modal" style={{ maxWidth: 480 }}>
      <div className="ah"><h3><Ic k="swap" />Transfer {student.full_name}</h3><button className="ax" onClick={onClose}><Ic k="x" /></button></div>
      <div className="abody">
        <div className="fld"><label>Target batch <span className="star">*</span></label>
          <select className="ainp" value={toId} onChange={(e) => setToId(e.target.value)}>
            <option value="">— Select batch —</option>
            {opts.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.enrolled ?? 0}/{b.capacity || '∞'})</option>)}
          </select></div>
        <div className="fld"><label>Reason</label><input className="ainp" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional note" /></div>
        <div className="empty-note" style={{ marginTop: 8 }}>If the target batch is full, the student joins its <b>waitlist</b> instead of moving.</div>
        {err && <div className="form-err" style={{ marginTop: 8 }}>{err}</div>}
      </div>
      <div className="af"><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={go}><Ic k="swap" />{busy ? 'Working…' : 'Transfer'}</button></div>
    </div></div>
  );
}
