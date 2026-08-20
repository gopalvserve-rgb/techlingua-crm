/**
 * FINANCE › DISCOUNT MASTER (dev/103) — the manageable discount caps + the over-cap approval
 * queue, on one screen.
 *
 *   1) Discount rules — named caps by max PERCENT and/or max AMOUNT (₹), optionally scoped by
 *      branch / vertical / course (most-specific-wins). Full list treatment. discount.create/
 *      update/delete manage them.
 *   2) Over-cap approvals — enrolments where a counsellor entered a discount ABOVE the cap: the
 *      excess is held pending. An authorized user (discount.approve = Academic Admin / Org /
 *      Super Admin) APPROVES (the full discount applies, Net/Due recompute) or REJECTS (the
 *      discount stays at the cap).
 */
import { useMemo, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, TableCard } from './renderer';
import { toast, useFetch, useRef_ } from './refdata';
import { rowActions, ConfirmModal, Section } from './rowactions';
import { FilterMulti } from './dyn';
import { ListActions, downloadObjectsCsv, useTableSelect, BulkBar, useBulkDelete } from './listtools';
import { fmtINR, minorToInput } from './money';

interface Rule {
  id: number; name: string; branch_id: number | null; vertical_id: number | null; course_id: number | null;
  course_level_id?: number | null;
  max_percent: number | null; max_amount_minor: number | null; active: boolean;
  branch_name?: string | null; vertical_name?: string | null; course_name?: string | null; course_code?: string | null;
  course_level_code?: string | null; course_level_label?: string | null;
}

const capText = (r: { max_percent: number | null; max_amount_minor: number | null }): string => {
  const parts: string[] = [];
  if (r.max_percent != null) parts.push(`${r.max_percent}%`);
  if (r.max_amount_minor != null) parts.push(fmtINR(r.max_amount_minor));
  return parts.length ? parts.join(' and ') : 'no limit';
};

export function DiscountMaster() {
  const { can } = useAuth();
  const rd = useRef_();
  const mayCreate = can('discount.create');
  const mayUpdate = can('discount.update');
  const mayDelete = can('discount.delete');
  const mayApprove = can('discount.approve');

  const [fB, setFB] = useState<number[]>([]);
  const [fV, setFV] = useState<number[]>([]);
  const [tick, setTick] = useState(0);
  const [add, setAdd] = useState(false);
  const [edit, setEdit] = useState<Rule | null>(null);
  const [del, setDel] = useState<Rule | null>(null);

  const list = useFetch<Rule[]>('/discounts', [tick]);
  const after = () => setTick((t) => t + 1);
  const allRows = list.data ?? [];
  // A rule with a NULL scope column applies to all — so it stays visible under any filter.
  const shown = allRows.filter((r) =>
    (!fB.length || r.branch_id == null || fB.includes(Number(r.branch_id)))
    && (!fV.length || r.vertical_id == null || fV.includes(Number(r.vertical_id))));
  const ids = shown.map((r) => Number(r.id));
  const { selected, count, tableSelect, clear } = useTableSelect(ids);
  const { openBulk, bulkModal } = useBulkDelete('Discount rules', '/discounts/bulk-delete/impact', '/discounts/bulk-delete', () => { after(); clear(); });
  const doDelete = async () => { try { await api.del(`/discounts/${del!.id}`); toast('Deleted'); setDel(null); after(); } catch (e: any) { toast(e.message, true); } };

  const exportRows = shown.map((r) => ({
    Name: r.name, 'Max %': r.max_percent ?? '', 'Max ₹': r.max_amount_minor != null ? (r.max_amount_minor / 100) : '',
    Branch: r.branch_name ?? 'All', Vertical: r.vertical_name ?? 'All', Course: r.course_name ?? 'All',
    Level: r.course_level_code ? (r.course_level_label || r.course_level_code) : 'All',
    Active: r.active ? 'Yes' : 'No',
  }));

  return (
    <>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-pad">
          <p className="sub" style={{ marginTop: 0 }}>
            Cap the discount a counsellor may apply — <b>by percentage AND by amount (₹)</b> — optionally scoped by
            <b> branch / vertical / course</b> (the most specific rule wins). If a counsellor enters a discount
            <b> above the cap</b>, the over-cap portion is <b>held for approval</b> — an authorized user
            (<code>discount.approve</code> — Academic Admin / Org / Super Admin) approves or rejects it below.
          </p>
        </div>
      </div>

      {mayCreate && <div className="page-actions"><button className="btn primary" onClick={() => setAdd(true)} data-testid="dm-add"><Ic k="plus" />New discount rule</button></div>}
      <div className="filters">
        <FilterMulti label="Branch" icon="branch" value={fB} options={rd.branches}
          onChange={(v: number[]) => { setFB(v); setFV((cur: number[]) => cur.filter((id: number) => rd.verticals.some((vt: any) => Number(vt.id) === id && v.includes(Number(vt.branch_id))))); }} />
        <FilterMulti label="Vertical" icon="grid" value={fV} options={rd.verticals.filter((vt: any) => !fB.length || fB.includes(Number(vt.branch_id)))} onChange={setFV} />
      </div>
      <BulkBar count={count} entityLabel="Discount rules" onDelete={() => openBulk(selected)} onClear={clear} />
      <TableCard fill title="Discount rules" icon="rupee" listKey="discount-master"
        select={mayDelete ? tableSelect : undefined}
        more={<ListActions onExport={() => downloadObjectsCsv('discount-master.csv', exportRows)} onRefresh={after} />}
        cols={['Name', 'Max %', 'Max amount', 'Scope', 'Status', 'Actions']}
        empty="No discount rules yet — add one to cap discounts."
        rows={shown.map((r) => [
          { node: <b className="nm">{r.name}</b> } as Cell,
          r.max_percent != null ? `${r.max_percent}%` : '—',
          r.max_amount_minor != null ? fmtINR(r.max_amount_minor) : '—',
          { node: <span className="sub">{r.branch_name ? r.branch_name : 'All branches'}{r.vertical_name ? ` › ${r.vertical_name}` : ''}{r.course_name ? ` › ${r.course_name}` : ''}{r.course_level_code ? ` › ${r.course_level_label || r.course_level_code}` : ''}</span> } as Cell,
          { b: [r.active ? 'Active' : 'Inactive', r.active ? 'b-green' : 'b-gray'] } as Cell,
          rowActions({
            onEdit: mayUpdate ? () => setEdit(r) : undefined,
            onDelete: mayDelete ? () => setDel(r) : undefined,
          }),
        ])} />

      <DiscountApprovals canApprove={mayApprove} />

      {add && <RuleModal onClose={() => setAdd(false)} onSaved={after} rd={rd} />}
      {edit && <RuleModal initial={edit} onClose={() => setEdit(null)} onSaved={after} rd={rd} />}
      {del && <ConfirmModal title="Delete discount rule?" body={`Delete "${del.name}"?`} danger confirmLabel="Delete" onConfirm={doDelete} onClose={() => setDel(null)} />}
      {bulkModal}
    </>
  );
}

/* ------------------------------------------------------------- add/edit form */
function RuleModal({ initial, onClose, onSaved, rd }: { initial?: Rule; onClose: () => void; onSaved: () => void; rd: any }) {
  const isEdit = !!initial?.id;
  const [name, setName] = useState(initial?.name ?? '');
  const [branchId, setBranchId] = useState(String(initial?.branch_id ?? ''));
  const [verticalId, setVerticalId] = useState(String(initial?.vertical_id ?? ''));
  const [courseId, setCourseId] = useState(String(initial?.course_id ?? ''));
  const [courseLevelId, setCourseLevelId] = useState(String(initial?.course_level_id ?? ''));
  const [maxPct, setMaxPct] = useState(initial?.max_percent != null ? String(initial.max_percent) : '');
  const [maxAmt, setMaxAmt] = useState(minorToInput(initial?.max_amount_minor ?? null));
  const [active, setActive] = useState(initial?.active ?? true);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');

  const vOpts = rd.verticals.filter((v: any) => !branchId || Number(v.branch_id) === Number(branchId));
  // #2 (dev/107) — the Course dropdown is filtered by the chosen Branch/Vertical (a course's
  // meta carries branch_id/vertical_id, the same mapping convert/enroll use). Blank = all courses.
  const cOpts = rd.courses.filter((c: any) =>
    (!branchId || Number(c.meta?.branch_id) === Number(branchId))
    && (!verticalId || Number(c.meta?.vertical_id) === Number(verticalId)));
  // #1 (dev/107) — when the chosen course HAS levels, offer a LEVEL (optional) scope.
  const levelsQ = useFetch<any[]>(courseId ? `/courses/${courseId}/levels` : null, [courseId]);
  const courseLevels = levelsQ.data ?? [];

  // Keep the scope coherent: changing Branch/Vertical clears a now-invalid Course; changing
  // Course clears a now-invalid Level.
  const pickBranch = (v: string) => { setBranchId(v); setVerticalId(''); setCourseId(''); setCourseLevelId(''); };
  const pickVertical = (v: string) => { setVerticalId(v); setCourseId(''); setCourseLevelId(''); };
  const pickCourse = (v: string) => { setCourseId(v); setCourseLevelId(''); };

  const save = async () => {
    setErr('');
    if (!name.trim()) return setErr('Give the rule a name.');
    if (!maxPct.trim() && !maxAmt.trim()) return setErr('Set at least one cap — a max % and/or a max amount.');
    setBusy(true);
    const body: any = {
      name: name.trim(),
      branch_id: branchId ? Number(branchId) : null,
      vertical_id: verticalId ? Number(verticalId) : null,
      course_id: courseId ? Number(courseId) : null,
      course_level_id: courseId && courseLevelId ? Number(courseLevelId) : null,
      max_percent: maxPct.trim() === '' ? null : maxPct,
      max_amount: maxAmt.trim() === '' ? null : maxAmt,
      active,
    };
    try {
      if (isEdit) await api.patch(`/discounts/${initial!.id}`, body);
      else await api.post('/discounts', body);
      toast(isEdit ? 'Saved' : 'Discount rule added'); onSaved(); onClose();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim"><div className="add-modal" style={{ maxWidth: 620 }}>
      <div className="ah"><h3><Ic k="rupee" />{isEdit ? 'Edit' : 'New'} discount rule</h3><button className="ax" onClick={onClose}><Ic k="x" /></button></div>
      <div className="abody"><div className="form-grid">
        <div className="fld" style={{ gridColumn: '1 / -1' }}><label>Name <span className="star">*</span></label>
          <input className="ainp" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Standard cap / Early-bird cap" data-testid="dm-name" /></div>
        <div className="fld"><label>Max discount %</label>
          <input className="ainp" type="number" min={0} max={100} step="0.001" value={maxPct} onChange={(e) => setMaxPct(e.target.value)} placeholder="e.g. 20 (blank = off)" data-testid="dm-pct" /></div>
        <div className="fld"><label>Max discount amount (₹)</label>
          <input className="ainp" type="text" value={maxAmt} onChange={(e) => setMaxAmt(e.target.value)} placeholder="e.g. 5000 (blank = off)" data-testid="dm-amt" /></div>
        <div className="fld"><label>Branch (optional)</label>
          <select className="ainp" value={branchId} onChange={(e) => pickBranch(e.target.value)}>
            <option value="">All branches</option>{rd.branches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select></div>
        <div className="fld"><label>Vertical (optional)</label>
          <select className="ainp" value={verticalId} onChange={(e) => pickVertical(e.target.value)}>
            <option value="">All verticals</option>{vOpts.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select></div>
        <div className="fld"><label>Course (optional)</label>
          <select className="ainp" value={courseId} onChange={(e) => pickCourse(e.target.value)} data-testid="dm-course">
            <option value="">All courses</option>{cOpts.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></div>
        {courseId && courseLevels.length > 0 && (
          <div className="fld"><label>Level (optional)</label>
            <select className="ainp" value={courseLevelId} onChange={(e) => setCourseLevelId(e.target.value)} data-testid="dm-level">
              <option value="">All levels</option>{courseLevels.map((l: any) => <option key={l.id} value={l.id}>{l.label || l.code}</option>)}
            </select></div>
        )}
        <div className="fld"><label>Status</label>
          <select className="ainp" value={active ? '1' : '0'} onChange={(e) => setActive(e.target.value === '1')}>
            <option value="1">Active</option><option value="0">Inactive</option>
          </select></div>
      </div>{err && <div className="form-err" style={{ marginTop: 8 }}>{err}</div>}</div>
      <div className="af"><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={save} data-testid="dm-save"><Ic k="check" />{busy ? 'Saving…' : 'Save'}</button></div>
    </div></div>
  );
}

/* --------------------------------------------------- over-cap approvals queue */
export function DiscountApprovals({ canApprove }: { canApprove: boolean }) {
  const [tick, setTick] = useState(0);
  const [reject, setReject] = useState<any | null>(null);
  const q = useFetch<any[]>(canApprove ? '/enrolments/discount-approvals' : null, [tick]);
  const rows = useMemo(() => q.data ?? [], [q.data]);
  const after = () => setTick((t) => t + 1);

  if (!canApprove) return null;

  const approve = async (r: any) => {
    try { await api.post(`/enrolments/${r.id}/discount/approve`, {}); toast('Over-cap discount approved — full discount applied.'); after(); }
    catch (e: any) { toast(e.message, true); }
  };

  return (
    <div style={{ marginTop: 18 }}>
      <Section title="Over-cap discount approvals">
        <div className="notice" style={{ marginBottom: 10 }}><Ic k="bolt" /><div>
          Enrolments where the discount entered <b>exceeds the applicable cap</b>. The discount is applied only up to
          the cap until you <b>approve</b> the excess (then the full discount applies and Net/Due update) or <b>reject</b> it.
        </div></div>
        {rows.length ? (
          <table className="tbl" data-testid="dm-approvals"><thead><tr>
            <th>Enrolment</th><th>Student / Lead</th><th>Course</th><th>Requested</th><th>Applied (cap)</th><th>Net now</th><th>Requested by</th><th>Action</th>
          </tr></thead>
            <tbody>{rows.map((r: any) => (
              <tr key={r.id} data-testid={`dm-approval-${r.id}`}>
                <td><b>{r.enrolment_no}</b><div className="sub">{r.branch_name} › {r.vertical_name}</div></td>
                <td>{r.lead_name}<div className="sub">{r.lead_phone ?? ''}</div></td>
                <td className="sub">{r.course_name ?? '—'}</td>
                <td><b style={{ color: 'var(--red, #b91c1c)' }}>{fmtINR(r.discount_requested_minor)}</b></td>
                <td className="sub">{fmtINR(r.discount_minor)}{r.discount_cap_minor != null ? ` (cap ${fmtINR(r.discount_cap_minor)})` : ''}</td>
                <td>{fmtINR(r.net_fee_minor)}</td>
                <td className="sub">{r.requested_by_name ?? '—'}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn primary" style={{ marginRight: 6 }} onClick={() => approve(r)} data-testid={`dm-approve-${r.id}`}><Ic k="check" />Approve</button>
                  <button className="btn" onClick={() => setReject(r)} data-testid={`dm-reject-${r.id}`}><Ic k="x" />Reject</button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        ) : <div className="empty-note">No over-cap discounts awaiting approval.</div>}
      </Section>
      {reject && <RejectModal row={reject} onClose={() => setReject(null)} onDone={() => { setReject(null); after(); }} />}
    </div>
  );
}

function RejectModal({ row, onClose, onDone }: { row: any; onClose: () => void; onDone: () => void }) {
  const [remarks, setRemarks] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const go = async () => {
    if (!remarks.trim()) return setErr('A reason is required to reject.');
    setBusy(true);
    try { await api.post(`/enrolments/${row.id}/discount/reject`, { remarks: remarks.trim() }); toast('Over-cap discount rejected — discount stays at the cap.'); onDone(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="add-scrim"><div className="add-modal" style={{ maxWidth: 460 }}>
      <div className="ah"><h3><Ic k="x" />Reject over-cap discount — {row.enrolment_no}</h3><button className="ax" onClick={onClose}><Ic k="x" /></button></div>
      <div className="abody"><div className="fld"><label>Reason <span className="star">*</span></label>
        <textarea className="ainp" rows={3} value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Why is the over-cap discount declined?" data-testid="dm-reject-reason" /></div>
        {err && <div className="form-err">{err}</div>}</div>
      <div className="af"><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={go} data-testid="dm-reject-confirm"><Ic k="check" />{busy ? 'Rejecting…' : 'Reject'}</button></div>
    </div></div>
  );
}

export default DiscountMaster;
