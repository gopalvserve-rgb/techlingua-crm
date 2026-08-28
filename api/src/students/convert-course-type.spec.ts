import 'reflect-metadata';
import { StudentService } from './student.service';
import { ResolvedScope } from '../rbac/rbac.types';

/** dev/143 item 6 — the convert / new-enrolment flow records COURSE TYPE on the enrolment:
 *  the row's explicit choice, else the course master's own meta.course_type. */
const scopeAll: ResolvedScope = { permissionKey: 'x', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [] };
const resolver = { buildScopeWhere: () => '1=1' };
const numbering = { allocate: async () => 'SID', allocateCoded: async () => 'FR-2026-27/001' };

function makeConvert(courseMeta: any) {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    one: async (sql: string) => {
      if (/FROM organisation/.test(sql)) return { id: 1 };
      if (/FROM m_course WHERE id/.test(sql)) return { id: 100, name: 'French', code: 'FR', meta: courseMeta };
      return null;
    },
    query: async (sql: string) => { if (/FROM course_level/.test(sql)) return []; return []; },
    tx: async (fn: any) => fn({
      query: async (sql: string, params: unknown[] = []) => {
        issued.push({ sql, params });
        if (/INSERT INTO enrolment \(/.test(sql)) return { rows: [{ id: 900 }] };
        if (/student_vertical_id/.test(sql)) return { rows: [{ id: 950, student_vertical_no: 'RID' }] };
        return { rows: [{ id: 1 }] };
      },
    }),
  };
  const svc = new StudentService(db as never, resolver as never, numbering as never);
  return { svc, issued };
}
const LEAD = { vertical_id: 3, branch_id: 9, owner_id: 5 };
const lastParam = (issued: any[]) => { const ins = issued.find((i) => /INSERT INTO enrolment \(/.test(i.sql)); return ins.params[ins.params.length - 1]; };

describe('convert — course_type persisted on the enrolment', () => {
  it('uses the row\'s explicit course_type', async () => {
    const { svc, issued } = makeConvert({ fee: 30000, course_type: 'Certificate' });
    const out: any = await svc.createConvertEnrolments(7, 31, LEAD, [{ course_id: 100, course_type: 'Diploma' }], { id: 5 });
    expect(lastParam(issued)).toBe('Diploma');
    expect(out[0].course_type).toBe('Diploma');
  });

  it('falls back to the course master meta.course_type when the row omits it', async () => {
    const { svc, issued } = makeConvert({ fee: 30000, course_type: 'Certificate' });
    const out: any = await svc.createConvertEnrolments(7, 31, LEAD, [{ course_id: 100 }], { id: 5 });
    expect(lastParam(issued)).toBe('Certificate');
    expect(out[0].course_type).toBe('Certificate');
  });

  it('is NULL when neither the row nor the master carry a course type', async () => {
    const { svc, issued } = makeConvert({ fee: 30000 });
    await svc.createConvertEnrolments(7, 31, LEAD, [{ course_id: 100 }], { id: 5 });
    expect(lastParam(issued)).toBeNull();
  });
});
