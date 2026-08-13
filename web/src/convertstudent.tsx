/**
 * CONVERT TO STUDENT — the shared modal used by the lead sheet AND the leads list (⋮).
 *
 * It is IDEMPOTENT by design: on open it asks the API whether this lead is already a
 * student and, if so, shows the existing record instead of offering to make a second one.
 * Converting POSTs /students/convert, which creates the student from the lead and moves
 * the lead to its pipeline's WON stage (server-side). A leaf module — imports nothing that
 * imports it — so both the sheet and the list can use it without an import cycle.
 */
import { useEffect, useState } from 'react';
import { api } from './api';
import { Ic } from './icons';
import { toast, useRef_ } from './refdata';

interface ExistingStudent { id: number; student_no: string; full_name: string; status: string }

export function ConvertStudentModal({ leadId, leadName, onDone, onClose, onOpenJourney }: {
  leadId: number; leadName?: string; onDone?: () => void; onClose: () => void;
  onOpenJourney?: (studentId: number, studentNo?: string, name?: string) => void;
}) {
  const ref = useRef_();
  const [loading, setLoading] = useState(true);
  const [existing, setExisting] = useState<ExistingStudent | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [lead, setLead] = useState<any>(null);
  // Multi-course rows: each is a {vertical → course (→ fee, discount)} selection. Item 1.
  const [rows, setRows] = useState<Array<{ vertical_id: string; course_id: string; fee: string; discount: string }>>([]);
  const [result, setResult] = useState<any>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [byLead, ld] = await Promise.all([
          api.get<{ student: ExistingStudent | null }>(`/students/by-lead/${leadId}`).catch(() => ({ student: null })),
          api.get<any>(`/leads/${leadId}`).catch(() => null),
        ]);
        if (!live) return;
        setExisting(byLead?.student ?? null);
        setLead(ld);
        // seed one row from the lead's own vertical + course (editable / removable).
        const v = ld?.vertical_id ? String(ld.vertical_id) : '';
        const cid = ld?.course_id ? String(ld.course_id) : '';
        const course = cid ? (ref.courses ?? []).find((c: any) => Number(c.id) === Number(cid)) : null;
        const fee = course ? String((course.meta as any)?.fee ?? '') : '';
        setRows([{ vertical_id: v, course_id: cid, fee, discount: '' }]);
      } catch (e) { if (live) setErr((e as Error).message); }
      finally { if (live) setLoading(false); }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  const branchId = lead?.branch_id ? Number(lead.branch_id) : null;
  const verticals = (ref.verticals ?? []).filter((v: any) => branchId == null || Number(v.branch_id) === branchId);
  const coursesFor = (vid: string) => (ref.courses ?? []).filter((c: any) =>
    !vid || String((c.meta as any)?.vertical_id ?? '') === String(vid));

  const setRow = (i: number, patch: Partial<{ vertical_id: string; course_id: string; fee: string; discount: string }>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows((rs) => [...rs, { vertical_id: '', course_id: '', fee: '', discount: '' }]);
  const removeRow = (i: number) => setRows((rs) => rs.filter((_, idx) => idx !== i));
  // Choosing a course prefills the fee from the Course master (editable).
  const chooseCourse = (i: number, cid: string) => {
    const course = (ref.courses ?? []).find((c: any) => Number(c.id) === Number(cid));
    setRow(i, { course_id: cid, fee: course ? String((course.meta as any)?.fee ?? '') : '' });
  };

  const validRows = rows.filter((r) => r.course_id);
  const convert = async () => {
    setErr(''); setBusy(true);
    try {
      const courses = validRows.map((r) => ({
        vertical_id: r.vertical_id ? Number(r.vertical_id) : undefined,
        course_id: Number(r.course_id),
        fee_minor: r.fee !== '' ? Math.round(Number(r.fee) * 100) : undefined,
        discount_minor: r.discount !== '' ? Math.round(Number(r.discount) * 100) : undefined,
      }));
      const r = await api.post<any>('/students/convert', { lead_id: leadId, courses });
      if (r?.already) {
        toast(`Already a student (${r.student_no ?? ''})`);
        onDone?.(); onClose(); return;
      }
      setResult(r);
      toast(`Converted to student ${r?.student_no ?? ''} — ${(r?.enrolments?.length ?? 0)} course enrollment(s) created, lead marked WON`);
      onDone?.();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const money = (m: number) => '₹' + (Number(m ?? 0) / 100).toLocaleString('en-IN');

  return (
    <div className="add-scrim" style={{ zIndex: 320 }}>
      <div className="add-modal" style={{ width: result ? 520 : 620 }}>
        <div className="ah">
          <h3><Ic k="students" />Convert to Student</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody" style={{ fontSize: 13 }}>
          {loading ? (
            <div className="empty-note">Checking…</div>
          ) : result ? (
            <div data-testid="convert-result">
              <div className="notice" style={{ marginBottom: 10 }}>
                <Ic k="check" />
                <div><b>{leadName || 'Lead'}</b> converted to student{' '}
                  <b className="mono">{result.student_no}</b>. The lead is marked <b>WON</b>.</div>
              </div>
              <b style={{ fontSize: 12 }}>Course enrollments created — Admission Journey started</b>
              <div style={{ marginTop: 6 }}>
                {(result.enrolments ?? []).map((e: any) => (
                  <div key={e.id} className="notice" style={{ marginBottom: 6, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                    <Ic k="grid" />
                    <div>
                      <div><b>{e.course_name}</b> · <span className="mono">{e.enrolment_no}</span> · {money(e.net_fee_minor)}</div>
                      <div className="sub" style={{ fontSize: 12 }}>
                        Admission stage: <b>Course Selected</b> — awaiting Payment → Invoice → Approval → Confirmation → Admit
                      </div>
                    </div>
                  </div>
                ))}
                {(!result.enrolments || result.enrolments.length === 0) && (
                  <div className="empty-note">No extra course selected — the student was linked to its existing enrolment (if any).</div>
                )}
              </div>
            </div>
          ) : existing ? (
            <div className="notice">
              <Ic k="check" />
              <div><b>{existing.full_name}</b> is already a student
                {' '}(<b className="mono">{existing.student_no}</b>, {existing.status}).
                A lead converts to a student once.</div>
            </div>
          ) : (
            <div>
              <div style={{ marginBottom: 10 }}>
                Convert <b>{leadName || 'this lead'}</b> to a student. The student carries the lead's
                name, phone, email, branch{lead?.branch_name ? <> (<b>{lead.branch_name}</b>)</> : null} and owner.
                Pick <b>one or more courses</b> — each becomes a separate course enrollment, and you can mix
                <b> different verticals</b>.
              </div>
              <b style={{ fontSize: 12 }}>Courses to enroll</b>
              <table className="tbl" style={{ width: '100%', marginTop: 6 }}>
                <thead><tr>
                  <th style={{ textAlign: 'left' }}>Vertical</th>
                  <th style={{ textAlign: 'left' }}>Course</th>
                  <th style={{ textAlign: 'left' }}>Fee (₹)</th>
                  <th style={{ textAlign: 'left' }}>Discount (₹)</th>
                  <th />
                </tr></thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <td>
                        <select className="ainp" data-testid={`conv-vertical-${i}`} value={r.vertical_id}
                          onChange={(e) => setRow(i, { vertical_id: e.target.value, course_id: '', fee: '' })}>
                          <option value="">— Vertical —</option>
                          {verticals.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}
                        </select>
                      </td>
                      <td>
                        <select className="ainp" data-testid={`conv-course-${i}`} value={r.course_id}
                          onChange={(e) => chooseCourse(i, e.target.value)}>
                          <option value="">— Course —</option>
                          {coursesFor(r.vertical_id).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      </td>
                      <td><input className="ainp" type="number" style={{ width: 90 }} value={r.fee}
                        onChange={(e) => setRow(i, { fee: e.target.value })} placeholder="0" /></td>
                      <td><input className="ainp" type="number" style={{ width: 90 }} value={r.discount}
                        onChange={(e) => setRow(i, { discount: e.target.value })} placeholder="0" /></td>
                      <td>{rows.length > 1 && (
                        <button className="ax" title="Remove" onClick={() => removeRow(i)}><Ic k="x" /></button>
                      )}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button className="btn" style={{ marginTop: 8 }} data-testid="conv-add-course" onClick={addRow}>
                <Ic k="plus" />Add another course
              </button>
            </div>
          )}
          {err && <div className="form-err" style={{ marginTop: 8 }}>{err}</div>}
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>{(existing || result) ? 'Close' : 'Cancel'}</button>
          {!loading && !existing && !result && (
            <button className="btn primary" data-testid="convert-submit" disabled={busy || validRows.length === 0} onClick={convert}>
              <Ic k="students" />{busy ? 'Converting…' : `Convert${validRows.length ? ` (${validRows.length} course${validRows.length === 1 ? '' : 's'})` : ''}`}
            </button>
          )}
          {result && onOpenJourney && (
            <button className="btn primary" data-testid="open-journey" onClick={() => { onOpenJourney(Number(result.id), result.student_no, leadName); onClose(); }}>
              <Ic k="grid" />Open Admission Journey
            </button>
          )}
          {existing && onOpenJourney && (
            <button className="btn primary" onClick={() => { onOpenJourney(Number(existing.id), existing.student_no, existing.full_name); onClose(); }}>
              <Ic k="grid" />Open Admission Journey
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * BULK CONVERT TO STUDENTS — the Leads-list multi-select action.
 *
 * Confirms how many leads will be converted, then POSTs /students/bulk-convert { ids }.
 * The server reuses the SAME single-convert per lead (own transaction each) so mapping,
 * dedupe, scope and the lead-WIN side effect are identical to the one-at-a-time path;
 * each lead carries its OWN branch/vertical/course/owner (no shared picker needed). One
 * bad lead never rolls back the others. On completion it shows a per-lead summary
 * (converted / skipped "already converted" / failed with reason).
 */
interface BulkConvertResult {
  converted: Array<{ lead_id: number; student_id: number; student_no: string }>;
  skipped: Array<{ lead_id: number; reason: string; student_id?: number }>;
  failed: Array<{ lead_id: number; error: string }>;
  counts: { requested: number; converted: number; skipped: number; failed: number };
}

export function BulkConvertStudentsModal({ ids, onDone, onClose }: {
  ids: number[]; onDone?: () => void; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<BulkConvertResult | null>(null);

  const run = async () => {
    setErr(''); setBusy(true);
    try {
      const r = await api.post<BulkConvertResult>('/students/bulk-convert', { ids });
      setResult(r);
      const c = r?.counts;
      toast(`Converted ${c?.converted ?? 0} of ${c?.requested ?? ids.length} — `
        + `${c?.skipped ?? 0} skipped, ${c?.failed ?? 0} failed`, (c?.failed ?? 0) > 0);
      onDone?.();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim" style={{ zIndex: 320 }}>
      <div className="add-modal" style={{ width: 480 }}>
        <div className="ah">
          <h3><Ic k="students" />Convert to students</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody" style={{ fontSize: 13 }}>
          {!result ? (
            <div>
              Convert the <b>{ids.length}</b> selected lead{ids.length === 1 ? '' : 's'} to
              students? Each becomes a student record from its own lead (name, phone, email,
              branch, vertical, course, owner) and its lead is marked <b>WON</b>. Leads already
              converted are skipped (no duplicate student). Enrolments, if any, are linked.
            </div>
          ) : (
            <div data-testid="bulk-convert-result">
              <div className="notice" style={{ marginBottom: 10 }}>
                <Ic k="check" />
                <div><b>{result.counts.converted}</b> converted ·
                  {' '}<b>{result.counts.skipped}</b> skipped ·
                  {' '}<b>{result.counts.failed}</b> failed
                  {' '}(of {result.counts.requested}).</div>
              </div>
              {result.skipped.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <b style={{ fontSize: 12 }}>Skipped</b>
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                    {result.skipped.map((s) => (
                      <li key={s.lead_id}>Lead #{s.lead_id} — {s.reason}</li>
                    ))}
                  </ul>
                </div>
              )}
              {result.failed.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <b style={{ fontSize: 12, color: 'var(--red)' }}>Failed</b>
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                    {result.failed.map((f) => (
                      <li key={f.lead_id}>Lead #{f.lead_id} — {f.error}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          {err && <div className="form-err" style={{ marginTop: 8 }}>{err}</div>}
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>{result ? 'Close' : 'Cancel'}</button>
          {!result && (
            <button className="btn primary" disabled={busy} onClick={run}>
              <Ic k="students" />{busy ? 'Converting…' : `Convert ${ids.length} to students`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
