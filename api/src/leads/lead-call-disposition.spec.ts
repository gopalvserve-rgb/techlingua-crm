import { LeadsService } from './leads.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { DatabaseService } from '../database/database.service';

/**
 * dev/139 — Last Call Disposition on the lead: a Leads-list column + filter, and a lightweight
 * "Log disposition" control that stamps lead.last_call_disposition_id + a timeline row.
 */
const ALL: ResolvedScope = {
  permissionKey: 'lead.read', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [],
};

function build(oneImpl?: (sql: string, p: unknown[]) => unknown) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const txQueries: string[] = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return []; },
    one: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return oneImpl ? oneImpl(sql, params) : { n: 0 };
    },
    tx: async (fn: (c: any) => Promise<unknown>) =>
      fn({ query: async (sql: string) => { txQueries.push(sql); return { rows: [] }; } }),
  } as unknown as DatabaseService;
  const enforcer = { assertRefInScope: async () => undefined } as any;
  const svc = new LeadsService(db, new ScopeResolverService(), enforcer, {} as any,
    { safeRescore: async () => undefined } as any, { safe: async () => undefined } as any);
  const listSql = () => calls.find((c) => /FROM lead l\s+JOIN branch/.test(c.sql))!.sql;
  return { svc, calls, txQueries, listSql };
}

describe('Last Call Disposition — Leads list column + filter', () => {
  it('LEAD_SELECT joins m_call_disposition and returns the last call disposition', async () => {
    const { svc, listSql } = build();
    await svc.list(ALL, {});
    const sql = listSql();
    expect(sql).toContain('l.last_call_disposition_id');
    expect(sql).toContain('lcd.name AS last_call_disposition_name');
    expect(sql).toContain('LEFT JOIN m_call_disposition lcd');
  });

  it('?call_disposition_ids=1,2 narrows to those dispositions (IN clause)', async () => {
    const { svc, listSql } = build();
    await svc.list(ALL, { call_disposition_ids: [1, 2] } as any);
    expect(listSql()).toContain('l.last_call_disposition_id IN');
  });
});

describe('logCallDisposition — the "Log disposition" control', () => {
  it('rejects an unknown call disposition', async () => {
    // lead SELECT ok; the m_call_disposition validation returns null (unknown).
    const svc = build((sql) => (/FROM m_call_disposition/.test(sql) ? null : { org_id: 1, branch_id: 2 })).svc;
    await expect(svc.logCallDisposition(7, { call_disposition_id: 999 }, 3)).rejects.toBeTruthy();
  });

  it('sets last_call_disposition_id + timestamp and writes a disposition activity', async () => {
    const b = build((sql) => (/FROM m_call_disposition/.test(sql) ? { id: 5 } : { org_id: 1, branch_id: 2 }));
    await b.svc.logCallDisposition(7, { call_disposition_id: 5, note: 'hi' }, 3);
    const joined = b.txQueries.join(' ');
    expect(joined).toMatch(/UPDATE lead SET last_call_disposition_id/);
    expect(joined).toMatch(/last_call_disposition_at = now\(\)/);
    expect(joined).toMatch(/INSERT INTO lead_activity/);
  });
});
