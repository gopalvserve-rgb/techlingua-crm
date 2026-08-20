import { DuesService } from './dues.service';

/**
 * FEE MANAGEMENT — LEVEL column (dev/107, #3). Every dues row must carry the enrolment's
 * level list so the Fee Management table can render the "Level" column (e.g. "A1, A2, B1");
 * a no-level enrolment yields NULL (the front-end shows "—"). Both dues branches — the
 * installment dues and the unplanned-balance dues — must aggregate `enrolment_level.code`
 * into `level_summary`, ordered by the level ordering. The list() SQL is what the DB runs,
 * so we assert the CTE emits it on BOTH branches.
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

describe('DuesService — Fee Management Level column shows each enrolment\'s level list', () => {
  it('aggregates enrolment_level.code into level_summary, ordered by level ordering', async () => {
    const { svc, calls } = capture();
    await svc.list(SCOPE, {});
    const sql = calls[0].sql;
    // the aggregated, ordered level list aliased as level_summary
    expect(sql).toMatch(/string_agg\(el\.code, ', ' ORDER BY el\.ordering, el\.id\)[\s\S]*?AS level_summary/);
    expect(sql).toMatch(/FROM enrolment_level el WHERE el\.enrolment_id = e\.id/);
  });

  it('emits level_summary on BOTH the installment AND the unplanned dues branch', async () => {
    const { svc, calls } = capture();
    await svc.list(SCOPE, {});
    const sql = calls[0].sql;
    const occurrences = (sql.match(/AS level_summary/g) || []).length;
    expect(occurrences).toBe(2); // one per UNION branch — no enrolment loses its Level column
  });

  it('selects the full CTE row (d.*) so level_summary reaches the API response', async () => {
    const { svc, calls } = capture();
    await svc.list(SCOPE, {});
    const sql = calls[0].sql;
    expect(sql).toMatch(/SELECT d\.\*/); // d.* carries level_summary straight to the row
  });
});
