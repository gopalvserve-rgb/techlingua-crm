import { DuesService } from './dues.service';

/**
 * FEE MANAGEMENT dues list — Trainer + Status filters (client feedback item 3).
 * TRAINER = the trainer of the student's batch (dev/81); STATUS = the per-course enrolment
 * status (dev/72 course_status). This asserts the CTE now exposes both fields and that the
 * list() query genuinely narrows by them (adds a scoped ANY(...) predicate + the value param).
 */
function capture() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    async query(sql: string, params: unknown[]) { calls.push({ sql, params }); return []; },
    async one() { return {}; },
  };
  const resolver = { buildScopeWhere: () => 'TRUE' };
  const svc = new DuesService(db as never, resolver as never, {} as never, {} as never);
  return { svc, calls };
}

const SCOPE = {} as never;

describe('DuesService.list — Trainer + Status filters', () => {
  it('the dues CTE exposes trainer + course_status (joined from batch → trainer + status catalog)', async () => {
    const { svc, calls } = capture();
    await svc.list(SCOPE, {});
    const sql = calls[0].sql;
    expect(sql).toMatch(/LEFT JOIN batch bt ON bt\.id = e\.batch_id/);
    expect(sql).toMatch(/LEFT JOIN "user" tr ON tr\.id = bt\.trainer_id/);
    expect(sql).toMatch(/LEFT JOIN student_status_def ssd ON ssd\.code = e\.course_status/);
    expect(sql).toMatch(/bt\.trainer_id/);
    expect(sql).toMatch(/e\.course_status/);
  });

  it('filters by trainer_ids — adds a scoped d.trainer_id = ANY(...) predicate + the id array', async () => {
    const { svc, calls } = capture();
    await svc.list(SCOPE, { trainer_ids: [4, 9] });
    const { sql, params } = calls[0];
    expect(sql).toMatch(/d\.trainer_id = ANY\(\$\d+::bigint\[\]\)/);
    expect(params).toContainEqual([4, 9]);
  });

  it('filters by course_status — adds a scoped d.course_status = ANY(...) predicate + the codes', async () => {
    const { svc, calls } = capture();
    await svc.list(SCOPE, { course_status: ['active', 'completed'] });
    const { sql, params } = calls[0];
    expect(sql).toMatch(/d\.course_status = ANY\(\$\d+::varchar\[\]\)/);
    expect(params).toContainEqual(['active', 'completed']);
  });

  it('with no trainer/status filter it adds neither predicate', async () => {
    const { svc, calls } = capture();
    await svc.list(SCOPE, {});
    const { sql } = calls[0];
    expect(sql).not.toMatch(/d\.trainer_id = ANY/);
    expect(sql).not.toMatch(/d\.course_status = ANY/);
  });
});
