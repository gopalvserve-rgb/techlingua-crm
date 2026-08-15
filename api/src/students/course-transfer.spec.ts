import 'reflect-metadata';
import { StudentService } from './student.service';
import { ResolvedScope } from '../rbac/rbac.types';

/**
 * ITEM 7 — the Student Management list Course column now sources the CONVERTED course(s)
 *          (every enrolment course, single OR multiple), NOT the stale lead course_id.
 * ITEM 8 — COURSE TRANSFER re-points an enrolment to a new course, recomputes the fee from
 *          the target Course master (carrying the discount), preserves payments (outstanding
 *          recomputes), keeps the OTHER enrolments untouched, writes an
 *          enrolment_course_transfer history row, and is scope-enforced + idempotent.
 */

const scopeAll: ResolvedScope = { permissionKey: 'x', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [] };
const resolver = { buildScopeWhere: () => '1=1' };

const ENROL = (over: any = {}) => ({
  id: 900, org_id: 1, branch_id: 9, vertical_id: 3, course_id: 100, batch_id: 55,
  course_status: 'active', admission_stage: 'admitted',
  fee_minor: 5000000, gross_fee_minor: 5000000, net_fee_minor: 4500000,
  discount_type: 'amount', discount_value: 500000, discount_amount_minor: 500000, discount_minor: 500000,
  linked_student_id: 7, course_name: 'French A1', ...over,
});

function make(opts: { enrol?: any; listRows?: any[]; scope?: ResolvedScope } = {}) {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    one: async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      if (/FROM organisation/.test(sql)) return { id: 1 };
      if (/FROM enrolment e/.test(sql) && /LIMIT 1/.test(sql)) return opts.enrol === null ? null : (opts.enrol ?? ENROL());
      if (/SELECT id, name, meta FROM m_course WHERE id/.test(sql)) return { id: 200, name: 'Data Analytics', meta: { fee: 30000 } };
      if (/FROM vertical WHERE id/.test(sql)) return { id: 7, branch_id: 9 };
      if (/outstanding_minor/.test(sql)) return { outstanding_minor: '2500000' };
      return null;
    },
    query: async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      if (/FROM student s/.test(sql) && /string_agg/.test(sql)) return opts.listRows ?? [];
      return [];
    },
    tx: async (fn: any) => fn({
      query: async (sql: string, params: unknown[] = []) => {
        issued.push({ sql, params });
        if (/INSERT INTO enrolment_course_transfer/.test(sql)) return { rows: [{ id: 42 }] };
        if (/FROM student_vertical_id/.test(sql)) return { rows: [{ id: 950, student_vertical_no: 'SID-2026-27/0007' }] };
        return { rows: [{ id: 1 }] };
      },
    }),
  };
  const numbering = { allocate: async () => 'SID-2026-27/0007' };
  const notif = { safeFire: async () => undefined };
  const rbacData = { loadUserGrants: async () => ({}) };
  const svc = new StudentService(db as never, resolver as never, numbering as never, notif as never, undefined as never, rbacData as never);
  return { svc, issued };
}
const has = (issued: any[], re: RegExp) => issued.some((i) => re.test(i.sql));
const find = (issued: any[], re: RegExp) => issued.find((i) => re.test(i.sql));

describe('ITEM 7 — student list Course column = enrolment course(s), not the lead course', () => {
  it('aggregates the enrolment course NAMES (string_agg over the student\'s enrolments)', async () => {
    const { svc, issued } = make({ listRows: [{ id: 501, full_name: 'Asha', course_name: 'French A1', courses: 'Data Analytics, French A1' }] });
    const rows: any = await svc.list(scopeAll, {});
    // the row carries the aggregated converted course(s), single OR multiple
    expect(rows[0].courses).toBe('Data Analytics, French A1');
    // and it is sourced from enrolment→m_course, NOT s.course_id alone
    expect(has(issued, /string_agg\(DISTINCT co\.name/)).toBe(true);
    expect(has(issued, /FROM enrolment en JOIN m_course co/)).toBe(true);
  });

  it('a single-course student still shows that one course', async () => {
    const { svc } = make({ listRows: [{ id: 502, full_name: 'Ravi', course_name: 'French A1', courses: 'French A1' }] });
    const rows: any = await svc.list(scopeAll, {});
    expect(rows[0].courses).toBe('French A1');
  });
});

describe('ITEM 8 — StudentService.transferEnrolmentCourse', () => {
  it('re-points the enrolment, recomputes fee from the target course master (carrying discount), writes history', async () => {
    const { svc, issued } = make();
    const out: any = await svc.transferEnrolmentCourse(900, { to_course_id: 200, reason: 'switched track' }, { id: 5 }, scopeAll, 7);
    expect(out.transferred).toBe(true);
    expect(out.to_course_id).toBe(200);
    expect(out.to_course_name).toBe('Data Analytics');
    // gross from master 30000 -> 3000000 paise; discount 500000 carried -> net 2500000
    expect(out.gross_fee_minor).toBe(3000000);
    expect(out.net_fee_minor).toBe(2500000);
    // the enrolment row is re-pointed and history written
    const upd = find(issued, /UPDATE enrolment\s+SET course_id/);
    expect(upd).toBeTruthy();
    expect(Number(upd.params[0])).toBe(900);          // ONLY this enrolment is touched
    expect(has(issued, /INSERT INTO enrolment_course_transfer/)).toBe(true);
    // payments preserved -> outstanding recomputed from the new net
    expect(out.outstanding_minor).toBe(2500000);
    // old batch (belonged to the old course) is cleared on transfer
    expect(out.batch_cleared).toBe(true);
  });

  it('is idempotent — transferring to the SAME course (same branch/vertical) is refused', async () => {
    const { svc } = make({ enrol: ENROL({ course_id: 200 }) });
    await expect(svc.transferEnrolmentCourse(900, { to_course_id: 200 }, { id: 5 }, scopeAll, 7))
      .rejects.toThrow(/already on that course/);
  });

  it('is scope-enforced — an out-of-scope enrolment is a 404', async () => {
    const { svc } = make({ enrol: null });
    await expect(svc.transferEnrolmentCourse(900, { to_course_id: 200 }, { id: 5 }, scopeAll, 7))
      .rejects.toThrow(/Enrolment not found/);
  });

  it('rejects when the enrolment does not belong to the expected student', async () => {
    const { svc } = make({ enrol: ENROL({ linked_student_id: 999 }) });
    await expect(svc.transferEnrolmentCourse(900, { to_course_id: 200 }, { id: 5 }, scopeAll, 7))
      .rejects.toThrow(/not found for this student/);
  });

  it('requires a target course', async () => {
    const { svc } = make();
    await expect(svc.transferEnrolmentCourse(900, {}, { id: 5 }, scopeAll, 7))
      .rejects.toThrow(/Choose a course/);
  });
});
