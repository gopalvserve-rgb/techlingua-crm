import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { PERMISSION_KEY, IS_PUBLIC_KEY } from '../rbac/rbac.decorators';
import { PERMISSION_CATALOG } from '../rbac/permission-catalog';
import { ResolvedScope } from '../rbac/rbac.types';
import { readFileSync } from 'fs';
import { join } from 'path';
import { TransferController } from './transfer.controller';
import { AttendanceController } from './attendance.controller';
import { AssessmentController } from './assessment.controller';
import { CourseworkController } from './coursework.controller';
import { TransferService } from './transfer.service';
import { AttendanceService } from './attendance.service';
import { AssessmentService, gradeFor } from './assessment.service';
import { CourseworkService } from './coursework.service';

/* --------------------------------------------------------------- RBAC census */
function routesOf(ctrl: any) {
  const proto = ctrl.prototype; const base = Reflect.getMetadata(PATH_METADATA, ctrl) ?? '';
  return Object.getOwnPropertyNames(proto).filter((m) => m !== 'constructor' && typeof proto[m] === 'function'
    && Reflect.getMetadata(METHOD_METADATA, proto[m]) !== undefined).map((m) => ({
    handler: m, base,
    permission: Reflect.getMetadata(PERMISSION_KEY, proto[m]) as string | undefined,
    public: Reflect.getMetadata(IS_PUBLIC_KEY, proto[m]) === true,
  }));
}
const CATALOG_KEYS = new Set(PERMISSION_CATALOG.flatMap((m) => m.actions.map((a) => `${m.module}.${a}`)));
const ALL = [TransferController, AttendanceController, AssessmentController, CourseworkController].flatMap(routesOf);

const scopeAll: ResolvedScope = { permissionKey: 'x', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [] };
const scopeOwn = (u: number): ResolvedScope => ({ permissionKey: 'x', allowed: true, all: false, filters: [{ kind: 'own', userId: u }], allowedFields: null, deniedFields: [] });
const resolver = {
  buildScopeWhere: (scope: ResolvedScope, cols: any, params: unknown[]) => {
    if (scope.all) return '1=1';
    const f = scope.filters[0];
    if (f?.kind === 'own' && cols.owner) { params.push(f.userId); return `${cols.owner} = $${params.length}`; }
    return '1=1';
  },
};

describe('Academics RBAC census', () => {
  it('every route requires a permission — none unguarded/public', () => {
    expect(ALL.filter((r) => !r.permission || r.public).map((r) => r.handler)).toEqual([]);
  });
  it('every permission a route names exists in the catalog', () => {
    expect(ALL.filter((r) => r.permission && !CATALOG_KEYS.has(r.permission!)).map((r) => r.permission)).toEqual([]);
  });
  it('migration 047 seeds + grants every attendance./test./coursework. permission the catalog declares', () => {
    const sql = readFileSync(join(__dirname, '..', '..', 'db', 'migrations', '047_academics_core.sql'), 'utf8');
    const keys = PERMISSION_CATALOG.filter((m) => ['attendance', 'test', 'coursework'].includes(m.module))
      .flatMap((m) => m.actions.map((a) => `${m.module}.${a}`));
    const ungranted = keys.filter((k) => !new RegExp(`'${k.replace('.', '\\.')}'\\s*,\\s*'`).test(sql));
    expect(ungranted).toEqual([]);
  });
});

/* -------------------------------------------------------------- Transfer svc */
function txDb(state: { filled: number; waiting?: number; student?: any; batch?: any }) {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    one: async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      if (/FROM organisation/.test(sql)) return { id: 1 };
      if (/FROM student s WHERE s\.id/.test(sql)) return state.student ?? { id: 7, full_name: 'A', batch_id: 2, branch_id: 9, vertical_id: 3, course_id: 100 };
      if (/FROM batch bt/.test(sql)) return state.batch ?? { id: 5, name: 'B', capacity: 2, branch_id: 9, vertical_id: 3, course_id: 100 };
      if (/count\(\*\)::int AS n FROM student WHERE batch_id/.test(sql)) return { n: state.filled };
      if (/count\(\*\)::int AS n FROM batch_waitlist/.test(sql)) return { n: state.waiting ?? 0 };
      if (/COALESCE\(max\(position\)/.test(sql)) return { n: 1 };
      if (/FROM batch_waitlist w WHERE w\.id/.test(sql)) return { batch_id: 5, status: 'waiting', student_id: 7 };
      return null;
    },
    query: async (sql: string, params: unknown[] = []) => { issued.push({ sql, params }); return [{ id: 900 }]; },
    tx: async (fn: any) => fn({ query: async (sql: string, params: unknown[] = []) => { issued.push({ sql, params }); return { rows: [{ id: 900 }] }; } }),
  };
  return { db, issued };
}
const has = (issued: any[], re: RegExp) => issued.some((i) => re.test(i.sql));

describe('TransferService', () => {
  it('moves the student + writes history when a seat is free', async () => {
    const { db, issued } = txDb({ filled: 1, batch: { id: 5, name: 'B', capacity: 2, branch_id: 9, vertical_id: 3, course_id: 100 } });
    const svc = new TransferService(db as never, resolver as never);
    const out = await svc.transfer({ student_id: 7, to_batch_id: 5, reason: 'x' }, { id: 1 }, scopeAll);
    expect(out.moved).toBe(true);
    expect(has(issued, /UPDATE student SET batch_id/)).toBe(true);
    expect(has(issued, /INSERT INTO batch_transfer/)).toBe(true);
  });
  it('WAITLISTS instead of moving when the batch is at capacity', async () => {
    const { db, issued } = txDb({ filled: 2, batch: { id: 5, name: 'B', capacity: 2, branch_id: 9, vertical_id: 3, course_id: 100 } });
    const svc = new TransferService(db as never, resolver as never);
    const out = await svc.transfer({ student_id: 7, to_batch_id: 5 }, { id: 1 }, scopeAll);
    expect(out.waitlisted).toBe(true);
    expect(out.moved).toBe(false);
    expect(has(issued, /UPDATE student SET batch_id/)).toBe(false);
    expect(has(issued, /INSERT INTO batch_waitlist/)).toBe(true);
  });
  it('promote fills a freed seat (moves the student)', async () => {
    const { db, issued } = txDb({ filled: 0, batch: { id: 5, name: 'B', capacity: 2, branch_id: 9, vertical_id: 3, course_id: 100 } });
    const svc = new TransferService(db as never, resolver as never);
    const out = await svc.promote(3, { id: 1 }, scopeAll);
    expect(out.moved).toBe(true);
    expect(has(issued, /INSERT INTO batch_transfer/)).toBe(true);
  });
  it('rejects a self-transfer to the same batch', async () => {
    const { db } = txDb({ filled: 0, student: { id: 7, full_name: 'A', batch_id: 5, branch_id: 9, vertical_id: 3, course_id: 100 } });
    const svc = new TransferService(db as never, resolver as never);
    await expect(svc.transfer({ student_id: 7, to_batch_id: 5 }, { id: 1 }, scopeAll)).rejects.toThrow();
  });
});

/* ------------------------------------------------------------ Attendance svc */
function attDb() {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    one: async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      if (/FROM organisation/.test(sql)) return { id: 1 };
      if (/FROM batch bt/.test(sql)) return { id: 5, name: 'Morning', branch_id: 9, vertical_id: 3 };
      if (/guardian_mobile, father_mobile, phone, guardian_name FROM student/.test(sql)) return { full_name: 'A', guardian_mobile: '+919812345678', guardian_name: 'Parent' };
      return null;
    },
    query: async (sql: string, params: unknown[] = []) => { issued.push({ sql, params }); return []; },
    tx: async (fn: any) => fn({ query: async (sql: string, params: unknown[] = []) => { issued.push({ sql, params }); if (/SELECT 1 FROM student/.test(sql)) return { rowCount: 1, rows: [{}] }; return { rows: [] }; } }),
  };
  return { db, issued };
}

describe('AttendanceService.mark', () => {
  it('marks + fires a parent alert on ABSENT (via messaging)', async () => {
    const { db, issued } = attDb();
    const sent: any[] = [];
    const messaging = { queue: async (m: any) => { sent.push(m); return { id: 1, status: 'queued' }; } };
    const svc = new AttendanceService(db as never, resolver as never, messaging as never);
    const out = await svc.mark({ batch_id: 5, date: '2026-08-05', entries: [{ student_id: 7, status: 'absent' }] }, { id: 1 }, scopeAll);
    expect(out.marked).toBe(1);
    expect(out.parent_notified).toBe(1);
    expect(sent[0].channel).toBe('sms');
    expect(has(issued, /INSERT INTO attendance/)).toBe(true);
  });
  it('DEGRADES cleanly when no messaging is configured (still marks)', async () => {
    const { db } = attDb();
    const svc = new AttendanceService(db as never, resolver as never, undefined);
    const out = await svc.mark({ batch_id: 5, date: '2026-08-05', entries: [{ student_id: 7, status: 'absent' }] }, { id: 1 }, scopeAll);
    expect(out.marked).toBe(1);
    expect(out.parent_notified).toBe(0);
  });
});

/* --------------------------------------------------------- Assessment + grade */
describe('gradeFor', () => {
  it('computes percentage + letter band', () => {
    expect(gradeFor(90, 100, null)).toEqual({ pct: 90, grade: 'A+' });
    expect(gradeFor(55, 100, null).grade).toBe('D');
    expect(gradeFor(20, 100, 33).grade).toBe('F');   // below pass mark
    expect(gradeFor(null, 100, null)).toEqual({ pct: null, grade: null });
  });
});

describe('AssessmentService', () => {
  function db(test: any) {
    const issued: Array<{ sql: string; params: unknown[] }> = [];
    const d = {
      one: async (sql: string) => { issued.push({ sql, params: [] });
        if (/FROM organisation/.test(sql)) return { id: 1 };
        if (/FROM batch bt/.test(sql)) return { id: 5, name: 'B', branch_id: 9, vertical_id: 3, course_id: 100 };
        if (/FROM assessment_test t/.test(sql)) return test; return null; },
      query: async (sql: string) => { issued.push({ sql, params: [] }); return [{ id: 55 }]; },
      tx: async (fn: any) => fn({ query: async (sql: string) => { issued.push({ sql, params: [] }); if (/SELECT 1 FROM student/.test(sql)) return { rowCount: 1, rows: [{}] }; return { rows: [] }; } }),
    };
    return { d, issued };
  }
  it('creates a test bound to its batch', async () => {
    const { d, issued } = db(null);
    const svc = new AssessmentService(d as never, resolver as never);
    await svc.create({ batch_id: 5, name: 'Quiz 1', max_marks: 50 }, { id: 1 }, scopeAll);
    expect(has(issued, /INSERT INTO assessment_test/)).toBe(true);
  });
  it('saveScores upserts a per-student score with computed grade', async () => {
    const { d, issued } = db({ id: 11, batch_id: 5, max_marks: 100, pass_marks: 33 });
    const svc = new AssessmentService(d as never, resolver as never);
    const out = await svc.saveScores(11, { entries: [{ student_id: 7, marks_obtained: 82 }] }, { id: 1 }, scopeAll);
    expect(out.saved).toBe(1);
    expect(has(issued, /INSERT INTO assessment_score/)).toBe(true);
  });
});

/* -------------------------------------------------------------- Coursework */
describe('CourseworkService', () => {
  function db(assignment: any) {
    const issued: Array<{ sql: string; params: unknown[] }> = [];
    const d = {
      one: async (sql: string) => { issued.push({ sql, params: [] });
        if (/FROM organisation/.test(sql)) return { id: 1 };
        if (/FROM batch bt/.test(sql)) return { id: 5, name: 'B', branch_id: 9, vertical_id: 3, course_id: 100 };
        if (/FROM coursework_assignment a/.test(sql)) return assignment;
        if (/SELECT 1 FROM student/.test(sql)) return { ok: 1 };
        return null; },
      query: async (sql: string) => { issued.push({ sql, params: [] }); return [{ id: 55 }]; },
      tx: async (fn: any) => fn({ query: async () => ({ rows: [] }) }),
    };
    return { d, issued };
  }
  it('creates an assignment bound to its batch', async () => {
    const { d, issued } = db(null);
    const svc = new CourseworkService(d as never, resolver as never);
    await svc.create({ batch_id: 5, title: 'Essay' }, { id: 1 }, scopeAll);
    expect(has(issued, /INSERT INTO coursework_assignment/)).toBe(true);
  });
  it('records a submission then grades it', async () => {
    const { d, issued } = db({ id: 21, batch_id: 5, max_marks: 20 });
    const svc = new CourseworkService(d as never, resolver as never);
    await svc.saveSubmission(21, { student_id: 7, submission_url: 'http://x', status: 'submitted' }, { id: 1 }, scopeAll);
    await svc.grade(21, { student_id: 7, marks: 18, feedback: 'good' }, { id: 1 }, scopeAll);
    expect(has(issued, /INSERT INTO coursework_submission/)).toBe(true);
    expect(has(issued, /status = 'graded'/)).toBe(true);
  });
});
