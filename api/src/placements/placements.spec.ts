import 'reflect-metadata';
import { PATH_METADATA } from '@nestjs/common/constants';
import { PERMISSION_KEY } from '../rbac/rbac.decorators';
import { JobOpeningController, PlacementApplicationController, StudentPlacementsController } from './job-opening.controller';
import { JobOpeningService } from './job-opening.service';

function permOf(ctrl: any, method: string): string | undefined {
  return Reflect.getMetadata(PERMISSION_KEY, ctrl.prototype[method]);
}
function pathOf(ctrl: any, method: string): string {
  return Reflect.getMetadata(PATH_METADATA, ctrl.prototype[method]);
}

describe('Placement Support — route permission wiring', () => {
  it('staff CRUD routes require placement.*', () => {
    expect(permOf(JobOpeningController, 'list')).toBe('placement.read');
    expect(permOf(JobOpeningController, 'get')).toBe('placement.read');
    expect(permOf(JobOpeningController, 'create')).toBe('placement.create');
    expect(permOf(JobOpeningController, 'update')).toBe('placement.update');
    expect(permOf(JobOpeningController, 'remove')).toBe('placement.delete');
    expect(permOf(JobOpeningController, 'uploadUrl')).toBe('placement.create');
    expect(permOf(JobOpeningController, 'bulkDelete')).toBe('placement.delete');
  });
  it('applicant view + advance require placement_application.*', () => {
    expect(permOf(JobOpeningController, 'applications')).toBe('placement_application.read');
    expect(permOf(PlacementApplicationController, 'advance')).toBe('placement_application.update');
  });
  it('student-facing routes are guarded by student.read/update (not the staff placement perms)', () => {
    expect(permOf(StudentPlacementsController, 'placements')).toBe('student.read');
    expect(permOf(StudentPlacementsController, 'myApplications')).toBe('student.read');
    expect(permOf(StudentPlacementsController, 'apply')).toBe('student.update');
    expect(pathOf(StudentPlacementsController, 'apply')).toBe(':id/placements/:jobId/apply');
  });
});

/** A fake db/resolver/storage harness. `oneRouter` maps SQL → row so the service's control flow runs. */
function harness(oneRouter: (sql: string, params: any[]) => any, queryRouter?: (sql: string, params: any[]) => any) {
  const queries: Array<{ sql: string; params: any[] }> = [];
  const db: any = {
    one: async (sql: string, params: any[] = []) => oneRouter(sql, params),
    query: async (sql: string, params: any[] = []) => { queries.push({ sql, params }); return queryRouter ? queryRouter(sql, params) : []; },
  };
  const buildScopeWhere = jest.fn(() => 'TRUE');
  const resolver: any = { buildScopeWhere };
  const storage: any = { presignGet: async () => 'https://r2/get', presignPut: async () => 'https://r2/put', materialKey: () => 'placement-jd/k' };
  return { db, resolver, storage, queries, buildScopeWhere };
}
const me = { id: 7, name: 'T' };
const scope: any = { permissionKey: 'x', allowed: true, all: true, filters: [] };

describe('Placement Support — eligibility rule (SQL wiring)', () => {
  it('student-facing list applies the eligibility gate: open + not past deadline + EXISTS enrolment match on course/vertical/min_status', async () => {
    let captured = '';
    const h = harness(
      (sql) => (/FROM student/.test(sql) ? { id: 11, full_name: 'S', enrolment_id: 99, vertical_id: 3, branch_id: 2 } : null),
      (sql) => { if (/FROM job_opening/.test(sql)) captured = sql; return []; },
    );
    const svc = new JobOpeningService(h.db, h.resolver, h.storage);
    await svc.studentPlacements(11, scope);
    expect(captured).toMatch(/j\.status = 'open'/);
    expect(captured).toMatch(/j\.deadline IS NULL OR j\.deadline >= CURRENT_DATE/);
    expect(captured).toMatch(/EXISTS \(/);
    expect(captured).toMatch(/eligible_course_ids/);
    expect(captured).toMatch(/eligible_vertical_ids/);
    expect(captured).toMatch(/j\.min_status IS NULL OR e\.course_status = j\.min_status/);
    // cancelled/withdrawn/dropped-out enrolments must not count toward eligibility
    expect(captured).toMatch(/course_status <> ALL/);
  });

  it('student-facing list is scope-enforced on the student (buildScopeWhere invoked)', async () => {
    const h = harness((sql) => (/FROM student/.test(sql) ? { id: 11, full_name: 'S', enrolment_id: 99 } : null));
    const svc = new JobOpeningService(h.db, h.resolver, h.storage);
    await svc.studentPlacements(11, scope);
    expect(h.buildScopeWhere).toHaveBeenCalled();
  });
});

describe('Placement Support — apply is idempotent (UNIQUE + ON CONFLICT DO NOTHING)', () => {
  const oneFor = (opts: { insertConflict: boolean }) => (sql: string) => {
    if (/FROM student/.test(sql)) return { id: 11, full_name: 'S', enrolment_id: 99, vertical_id: 3, branch_id: 2 };
    if (/FROM job_opening j\s+LEFT JOIN branch/.test(sql) || /SELECT j\.\*, b\.name/.test(sql)) return { id: 5, status: 'open' }; // getRow
    if (/SELECT 1 FROM job_opening j\s+WHERE j\.id/.test(sql)) return { one: 1 }; // isEligible
    if (/FROM organisation/.test(sql)) return { id: '1' };
    if (/SELECT id, status FROM placement_application/.test(sql)) return opts.insertConflict ? { id: 42, status: 'applied' } : null;
    return null;
  };

  it('first apply creates the application', async () => {
    const h = harness(oneFor({ insertConflict: false }), (sql) => (/INSERT INTO placement_application/.test(sql) ? [{ id: '77' }] : []));
    const svc = new JobOpeningService(h.db, h.resolver, h.storage);
    const res: any = await svc.apply(11, 5, {}, me, scope);
    expect(res.created).toBe(true);
    expect(res.id).toBe(77);
    const ins = h.queries.find((q) => /INSERT INTO placement_application/.test(q.sql));
    expect(ins?.sql).toMatch(/ON CONFLICT \(job_opening_id, student_id\)/);
    expect(ins?.sql).toMatch(/DO NOTHING/);
  });

  it('re-apply is idempotent — no duplicate, returns the existing application', async () => {
    const h = harness(oneFor({ insertConflict: true }), (sql) => (/INSERT INTO placement_application/.test(sql) ? [] : []));
    const svc = new JobOpeningService(h.db, h.resolver, h.storage);
    const res: any = await svc.apply(11, 5, {}, me, scope);
    expect(res.created).toBe(false);
    expect(res.idempotent).toBe(true);
    expect(res.id).toBe(42);
  });

  it('an ineligible student is refused (400) before any insert', async () => {
    const one = (sql: string) => {
      if (/FROM student/.test(sql)) return { id: 11, full_name: 'S', enrolment_id: 99 };
      if (/SELECT j\.\*, b\.name/.test(sql)) return { id: 5, status: 'open' };
      if (/SELECT 1 FROM job_opening j\s+WHERE j\.id/.test(sql)) return null; // NOT eligible
      return null;
    };
    const h = harness(one);
    const svc = new JobOpeningService(h.db, h.resolver, h.storage);
    await expect(svc.apply(11, 5, {}, me, scope)).rejects.toThrow(/not eligible/i);
    expect(h.queries.find((q) => /INSERT INTO placement_application/.test(q.sql))).toBeUndefined();
  });
});

describe('Placement Support — staff CRUD is scope-enforced', () => {
  it('create validates the branch+vertical is within scope, then inserts', async () => {
    const h = harness(
      (sql) => {
        if (/FROM vertical v/.test(sql)) return { id: 3 };          // in-scope vertical
        if (/FROM organisation/.test(sql)) return { id: '1' };
        return null;
      },
      (sql) => (/INSERT INTO job_opening/.test(sql) ? [{ id: '5' }] : []),
    );
    const svc = new JobOpeningService(h.db, h.resolver, h.storage);
    const res: any = await svc.create({ title: 'ZZTEST Job', branch_id: 2, vertical_id: 3, eligible_course_ids: [4] }, me, scope);
    expect(res.id).toBe(5);
    expect(h.buildScopeWhere).toHaveBeenCalled();
  });

  it('create is refused (400) when the branch+vertical is outside scope', async () => {
    const h = harness((sql) => (/FROM organisation/.test(sql) ? { id: '1' } : null)); // vertical lookup returns null
    const svc = new JobOpeningService(h.db, h.resolver, h.storage);
    await expect(svc.create({ title: 'X', branch_id: 2, vertical_id: 3 }, me, scope)).rejects.toThrow(/within your access/i);
  });

  it('create requires a title', async () => {
    const h = harness(() => null);
    const svc = new JobOpeningService(h.db, h.resolver, h.storage);
    await expect(svc.create({ branch_id: 2, vertical_id: 3 }, me, scope)).rejects.toThrow(/title/i);
  });

  it('list is scope-enforced (buildScopeWhere) and filters by status/job_type', async () => {
    let captured = '';
    const h = harness(() => null, (sql) => { if (/FROM job_opening/.test(sql)) captured = sql; return []; });
    const svc = new JobOpeningService(h.db, h.resolver, h.storage);
    await svc.list(scope, { status: 'open', job_type: 'internship' });
    expect(h.buildScopeWhere).toHaveBeenCalled();
    expect(captured).toMatch(/j\.status = \$/);
    expect(captured).toMatch(/j\.job_type = \$/);
  });

  it('advanceApplication rejects an invalid status', async () => {
    const h = harness((sql) => (/FROM placement_application pa/.test(sql) ? { id: 42 } : null));
    const svc = new JobOpeningService(h.db, h.resolver, h.storage);
    await expect(svc.advanceApplication(42, { status: 'bogus' }, me, scope)).rejects.toThrow(/Invalid application status/i);
  });

  it('advanceApplication accepts a valid status and updates', async () => {
    const h = harness((sql) => (/FROM placement_application pa/.test(sql) ? { id: 42 } : null));
    const svc = new JobOpeningService(h.db, h.resolver, h.storage);
    const res: any = await svc.advanceApplication(42, { status: 'shortlisted' }, me, scope);
    expect(res.status).toBe('shortlisted');
    expect(h.queries.find((q) => /UPDATE placement_application SET status/.test(q.sql))).toBeTruthy();
  });
});
