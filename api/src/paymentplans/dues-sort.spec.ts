import { DuesService, DUES_SORTS, DUES_SORT_DEFAULT } from './dues.service';

/**
 * FB-2026-025 (client, 27 Nov 2026) — "put the sorting option here too, like the Leads list;
 * it will be the newest-first system". Fee Management had no Sort control and came back ordered
 * by how overdue each instalment was. The order is chosen on the SERVER, because the row cap
 * must keep the rows the chosen order puts first — and it is a WHITELIST, never a passthrough.
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
const orderOf = (sql: string) => sql.slice(sql.lastIndexOf('ORDER BY'));

describe('DuesService.list — sort', () => {
  it('defaults to the newest enrolment first', async () => {
    const { svc, calls } = capture();
    await svc.list(SCOPE, {});
    expect(DUES_SORT_DEFAULT).toBe('recent');
    expect(orderOf(calls[0].sql)).toContain('d.enrolment_date DESC');
  });

  it('every offered sort reaches the ORDER BY', async () => {
    for (const [key, expr] of Object.entries(DUES_SORTS)) {
      const { svc, calls } = capture();
      await svc.list(SCOPE, { sort: key });
      expect(orderOf(calls[0].sql)).toContain(expr);
    }
  });

  it('an unknown or injected sort falls back to the default (whitelist, not passthrough)', async () => {
    for (const bad of ['', 'nonsense', 'd.id; DROP TABLE enrolment', '1=1']) {
      const { svc, calls } = capture();
      await svc.list(SCOPE, { sort: bad });
      expect(orderOf(calls[0].sql)).toBe(`ORDER BY ${DUES_SORTS[DUES_SORT_DEFAULT]}\n        LIMIT $1`);
    }
  });

  it('sorts only by columns the dues CTE actually exposes', async () => {
    const { svc, calls } = capture();
    await svc.list(SCOPE, {});
    // both arms of the UNION must carry every sortable column, or one source of a due sorts as NULL
    const [inst, unplanned] = calls[0].sql.split('UNION ALL');
    for (const expr of Object.values(DUES_SORTS)) {
      for (const col of expr.match(/d\.\w+/g) ?? []) {
        expect(inst).toContain(col.slice(2));
        expect(unplanned).toContain(col.slice(2));
      }
    }
  });
});
