import 'reflect-metadata';
import { AttendanceService } from './attendance.service';
import { ResolvedScope } from '../rbac/rbac.types';

/**
 * 27aug Batch C item 6 — Attendance list filters (Course / Trainer / multi-STATUS) + free-text
 * search (student name / roll no / enrolment). Asserts the composed WHERE carries each clause.
 */
const scopeAll: ResolvedScope = { permissionKey: 'attendance.read', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [] };
const resolver = { buildScopeWhere: () => '1=1' } as any;

function make() {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const db = { query: async (sql: string, params: unknown[] = []) => { issued.push({ sql, params }); return []; } } as any;
  return { svc: new AttendanceService(db, resolver), issued };
}

describe('AttendanceService.list — filters + search (item 6)', () => {
  it('applies Course, Trainer, multi-status and the q search', async () => {
    const { svc, issued } = make();
    await svc.list(scopeAll, { course_id: '3,4', trainer_id: '9', status: 'present,late', q: 'Riya' });
    const sql = issued[issued.length - 1].sql;
    expect(sql).toMatch(/bt\.course_id = ANY/);
    expect(sql).toMatch(/bt\.trainer_id = ANY/);
    expect(sql).toMatch(/a\.status = ANY/);
    expect(sql).toMatch(/s\.full_name ILIKE/);
    expect(sql).toMatch(/e2\.enrolment_no ILIKE/);
  });

  it('omits the search/status clauses when not supplied', async () => {
    const { svc, issued } = make();
    await svc.list(scopeAll, {});
    const sql = issued[issued.length - 1].sql;
    expect(sql).not.toMatch(/e2\.enrolment_no ILIKE/);
    expect(sql).not.toMatch(/a\.status = ANY/);
  });
});
