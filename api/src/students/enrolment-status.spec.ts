import 'reflect-metadata';
import { StudentService } from './student.service';
import { combineAccess, ENROLMENT_STATUSES } from './lms-access';
import { ResolvedScope } from '../rbac/rbac.types';

/**
 * PER-ENROLMENT (per-course) STATUS — unit coverage mirroring the student-status lifecycle:
 *  · each enrolment carries its OWN status, independent of the overall student + other enrolments
 *  · SENSITIVE enrolment statuses need approved_by (400) + the status_manage permission (403)
 *  · a revenue-cancelling enrolment status flips ONLY that enrolment.status to 'cancelled'
 *  · the combined LMS access is the more restrictive of overall-student and per-enrolment
 *  · the student syllabus/content read is published-only and blocked for a NONE-access course
 *  · the approved_by fix now applies to the STUDENT status endpoint too.
 */

const scopeAll: ResolvedScope = { permissionKey: 'x', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [] };
const resolver = {
  buildScopeWhere: () => '1=1',
  resolve: (_grants: any, _key: string) => ({ allowed: !!_grants?.canManage }),
};

const STUDENT = (over: any = {}) => ({
  id: 7, org_id: 1, branch_id: 9, vertical_id: 3, status: 'active', status_label: 'Active',
  enrolment_id: 900, lead_id: 10, owner_id: 5, course_id: 100, ...over,
});
const ENROL = (over: any = {}) => ({
  id: 900, org_id: 1, branch_id: 9, vertical_id: 3, course_id: 100, batch_id: null,
  course_status: 'active', net_fee_minor: 5000000, linked_student_id: 7, course_name: 'French A1', ...over,
});

function make(opts: { enrol?: any; student?: any; canManage?: boolean; enrolRows?: any[] } = {}) {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    one: async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      if (/FROM organisation/.test(sql)) return { id: 1 };
      if (/FROM student s/.test(sql)) return opts.student === null ? null : (opts.student ?? STUDENT());
      if (/FROM enrolment e/.test(sql) && /LIMIT 1/.test(sql)) return opts.enrol === null ? null : (opts.enrol ?? ENROL());
      if (/FROM student_status_def WHERE code/.test(sql)) {
        const code = String(params[0]);
        const map: any = {
          active: { code: 'active', label: 'Active', lms_access: 'full', requires_approval: false },
          completed: { code: 'completed', label: 'Completed', lms_access: 'alumni', requires_approval: false },
          cancelled: { code: 'cancelled', label: 'Cancelled', lms_access: 'none', requires_approval: true },
          on_hold: { code: 'on_hold', label: 'On Hold', lms_access: 'limited', requires_approval: true },
        };
        return map[code] ?? null;
      }
      if (/FROM "user" WHERE id/.test(sql)) return { id: Number(params[0]) };
      if (/outstanding_minor/.test(sql)) return { outstanding_minor: '1500000' };
      return null;
    },
    query: async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      if (/FROM enrolment e/.test(sql)) return opts.enrolRows ?? [];
      if (/FROM syllabus/.test(sql)) return [{ id: 1, title: 'Syllabus v1' }];
      if (/FROM course_content/.test(sql)) return [{ id: 2, title: 'Module 1' }];
      if (/FROM study_material/.test(sql)) return [{ id: 3, title: 'PDF' }];
      return [];
    },
    tx: async (fn: any) => fn({
      query: async (sql: string, params: unknown[] = []) => { issued.push({ sql, params }); return { rows: [{ id: 950 }] }; },
    }),
  };
  const numbering = { allocate: async () => 'ENR-0002' };
  const notif = { safeFire: async () => undefined };
  const rbacData = { loadUserGrants: async () => ({ canManage: !!opts.canManage }) };
  const svc = new StudentService(db as never, resolver as never, numbering as never, notif as never, undefined as never, rbacData as never);
  return { svc, issued };
}
const has = (issued: any[], re: RegExp) => issued.some((i) => re.test(i.sql));

describe('combineAccess (overall + per-enrolment → the more restrictive)', () => {
  it('active overall + completed course → alumni (view only)', () => expect(combineAccess('full', 'alumni')).toBe('alumni'));
  it('active overall + cancelled course → none (blocked)', () => expect(combineAccess('full', 'none')).toBe('none'));
  it('active overall + active course → full', () => expect(combineAccess('full', 'full')).toBe('full'));
  it('on-hold overall (limited) + active course → limited', () => expect(combineAccess('limited', 'full')).toBe('limited'));
});

describe('StudentService.changeEnrolmentStatus', () => {
  it('rejects a SENSITIVE status without approved_by → 400 "Approved By is required"', async () => {
    const { svc } = make({ canManage: true });
    await expect(svc.changeEnrolmentStatus(900,
      { to_status: 'cancelled', reason: 'x', last_attendance_date: '2026-08-01', effective_date: '2026-08-10' },
      { id: 5 }, scopeAll)).rejects.toThrow(/Approved By is required/);
  });

  it('rejects a SENSITIVE status without the status_manage permission → 403', async () => {
    const { svc } = make({ canManage: false });
    await expect(svc.changeEnrolmentStatus(900,
      { to_status: 'cancelled', reason: 'x', last_attendance_date: '2026-08-01', effective_date: '2026-08-10', approved_by: 5 },
      { id: 5 }, scopeAll)).rejects.toThrow(/Manage student status/);
  });

  it('CANCEL flips ONLY this enrolment.status to cancelled (revenue exclusion) + writes history', async () => {
    const { svc, issued } = make({ canManage: true });
    const out = await svc.changeEnrolmentStatus(900,
      { to_status: 'cancelled', reason: 'moved city', last_attendance_date: '2026-08-01', effective_date: '2026-08-10', approved_by: 5 },
      { id: 5 }, scopeAll);
    expect(out.to_status).toBe('cancelled');
    expect((out as any).revenue_excluded).toBe(true);
    expect(has(issued, /UPDATE enrolment SET status = 'cancelled'/)).toBe(true);
    expect(has(issued, /INSERT INTO enrolment_status_history/)).toBe(true);
    // independence: the STUDENT row is never touched by a per-enrolment change.
    expect(has(issued, /UPDATE student SET status/)).toBe(false);
  });

  it('COMPLETING one enrolment (non-sensitive) needs no status_manage and does NOT cancel revenue or touch the student', async () => {
    const { svc, issued } = make({ canManage: false });
    const out = await svc.changeEnrolmentStatus(900,
      { to_status: 'completed' }, { id: 5 }, scopeAll);
    expect(out.to_status).toBe('completed');
    expect((out as any).revenue_excluded).toBe(false);
    expect(has(issued, /UPDATE enrolment SET status = 'cancelled'/)).toBe(false);
    expect(has(issued, /UPDATE student SET status/)).toBe(false);
    expect(has(issued, /INSERT INTO enrolment_status_history/)).toBe(true);
  });

  it('is idempotent — same status is a no-op', async () => {
    const { svc, issued } = make({ canManage: true });
    const out = await svc.changeEnrolmentStatus(900, { to_status: 'active' }, { id: 5 }, scopeAll);
    expect((out as any).unchanged).toBe(true);
    expect(has(issued, /INSERT INTO enrolment_status_history/)).toBe(false);
  });

  it('rejects a status outside the enrolment set', async () => {
    const { svc } = make({ canManage: true });
    await expect(svc.changeEnrolmentStatus(900, { to_status: 'suspended' }, { id: 5 }, scopeAll)).rejects.toThrow(/Unknown enrolment status/);
    expect(ENROLMENT_STATUSES.has('suspended')).toBe(false);
  });
});

describe('StudentService.learning (student syllabus/content access)', () => {
  it('serves published syllabus/content for an ACTIVE enrolled course', async () => {
    const { svc } = make({ enrolRows: [{ id: 900, enrolment_no: 'ENR-1', course_id: 100, course_status: 'active', course_name: 'French A1' }] });
    const out: any = await svc.learning(7, scopeAll);
    expect(out.courses).toHaveLength(1);
    expect(out.courses[0].blocked).toBe(false);
    expect(out.courses[0].syllabus.length).toBeGreaterThan(0);
    expect(out.courses[0].course_content.length).toBeGreaterThan(0);
  });

  it('BLOCKS a cancelled course — no content leaked even when the student is overall active', async () => {
    const { svc } = make({ enrolRows: [{ id: 901, enrolment_no: 'ENR-2', course_id: 200, course_status: 'cancelled', course_name: 'French A2' }] });
    const out: any = await svc.learning(7, scopeAll);
    expect(out.courses[0].blocked).toBe(true);
    expect(out.courses[0].effective_lms_access).toBe('none');
    expect(out.courses[0].syllabus).toHaveLength(0);
    expect(out.courses[0].course_content).toHaveLength(0);
  });
});

describe('StudentService.changeStatus (STUDENT overall) — approved_by fix', () => {
  it('now REQUIRES approved_by for a sensitive status → 400 (no silent default to the actor)', async () => {
    const { svc } = make({ canManage: true });
    await expect(svc.changeStatus(7,
      { to_status: 'on_hold', reason: 'pause', last_attendance_date: '2026-08-01', effective_date: '2026-08-05' },
      { id: 5 }, scopeAll)).rejects.toThrow(/Approved By is required/);
  });
});
