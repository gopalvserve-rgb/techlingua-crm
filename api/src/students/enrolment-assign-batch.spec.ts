import 'reflect-metadata';
import { StudentService } from './student.service';
import { ResolvedScope } from '../rbac/rbac.types';

/**
 * 27aug Batch C items 4 & 5 — assign a batch to ONE enrolment (per-course, from the student side),
 * NOT hard-blocked by an incomplete admission step (returns a warning), and rejecting a batch that
 * is for a DIFFERENT course than the enrolment.
 */
const scopeAll: ResolvedScope = { permissionKey: 'student.update', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [] };
const resolver = { buildScopeWhere: () => '1=1' } as any;

function make(opts: { enr?: any; batch?: any } = {}) {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    one: async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      if (/FROM enrolment e/.test(sql)) return opts.enr ?? null;
      if (/FROM batch bt/.test(sql)) return opts.batch ?? null;
      return null;
    },
    query: async (sql: string, params: unknown[] = []) => { issued.push({ sql, params }); return []; },
    tx: async (fn: any) => fn({ query: async (sql: string, params: unknown[] = []) => { issued.push({ sql, params }); return { rows: [] }; } }),
  } as any;
  return { svc: new StudentService(db, resolver, {} as any), issued };
}

const enr = { id: 50, enrolment_no: 'ENR-1', status: 'active', course_id: 4, branch_id: 2, vertical_id: 3, linked_student_id: 100, admission_stage: 'payment', org_id: 1 };
const batchSameCourse = { id: 9, name: 'IELTS A', batch_code: 'BAT-0009', course_id: 4, status: 'active', branch_id: 2, vertical_id: 3 };

describe('StudentService.assignEnrolmentBatch (items 4 & 5)', () => {
  it('assigns a batch even when the admission step is incomplete — returns a warning, not an error', async () => {
    const { svc, issued } = make({ enr, batch: batchSameCourse });
    const res: any = await svc.assignEnrolmentBatch(50, { batch_id: 9 }, { id: 7 }, scopeAll, 100);
    expect(res.batch_id).toBe(9);
    expect(res.warning).toMatch(/not yet complete/i);
    expect(issued.some((q) => /UPDATE enrolment SET batch_id/.test(q.sql))).toBe(true);
  });

  it('rejects a batch that belongs to a different course', async () => {
    const { svc } = make({ enr, batch: { ...batchSameCourse, course_id: 999 } });
    await expect(svc.assignEnrolmentBatch(50, { batch_id: 9 }, { id: 7 }, scopeAll, 100))
      .rejects.toThrow(/different course/i);
  });

  it('unassigns (clears) the batch when batch_id is null', async () => {
    const { svc, issued } = make({ enr });
    const res: any = await svc.assignEnrolmentBatch(50, { batch_id: null }, { id: 7 }, scopeAll, 100);
    expect(res.batch_id).toBeNull();
    expect(issued.some((q) => /UPDATE enrolment SET batch_id/.test(q.sql))).toBe(true);
  });
});
