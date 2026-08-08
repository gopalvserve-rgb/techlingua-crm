import { LeadsService } from './leads.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { DatabaseService } from '../database/database.service';

/**
 * Multi-select list filters (client, Aug 2026): every Leads-list filter accepts an ARRAY of ids
 * — `col IN (...)` (OR within a filter), ANDed across filters, on top of RBAC scope + the global
 * scope. The old singular params still work (card links / back-compat) and fold into the same IN.
 * The band (Hot/Warm/Cold) is whitelisted before it reaches the WHERE.
 */

const ALL: ResolvedScope = {
  permissionKey: 'lead.read', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [],
};
const BRANCH7: ResolvedScope = {
  permissionKey: 'lead.read', allowed: true, all: false,
  filters: [{ kind: 'branch', branchId: 7 }], allowedFields: null, deniedFields: [],
};

function build() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return []; },
    one: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return { n: 0 }; },
  } as unknown as DatabaseService;
  const enforcer = { assertRefInScope: async () => undefined } as any;
  const ingestion = {} as any;
  const scoring = { safeRescore: async () => undefined } as any;
  const sla = { safe: async () => undefined } as any;
  const svc = new LeadsService(db, new ScopeResolverService(), enforcer, ingestion, scoring, sla);
  const listSql = () => calls.find((c) => /FROM lead l\s+JOIN branch/.test(c.sql))!;
  const selSql = () => calls.find((c) => /SELECT l\.id FROM lead l WHERE/.test(c.sql))!;
  return { svc, calls, listSql, selSql };
}

describe('OR within a filter — a filter array becomes `col IN (...)`', () => {
  it('two status_ids -> leads in EITHER status (IN, both bound)', async () => {
    const { svc, listSql } = build();
    await svc.list(ALL, { status_ids: [5, 8] });
    const c = listSql();
    expect(c.sql.replace(/\s+/g, ' ')).toContain('l.status_id IN ($1,$2)');
    expect(c.params.slice(0, 2)).toEqual([5, 8]);
  });

  it('two owner_ids -> leads of EITHER owner (IN, both bound)', async () => {
    const { svc, listSql } = build();
    await svc.list(ALL, { owner_ids: [3, 4] });
    const c = listSql();
    expect(c.sql.replace(/\s+/g, ' ')).toContain('l.owner_id IN ($1,$2)');
    expect(c.params.slice(0, 2)).toEqual([3, 4]);
  });

  it('two bands -> `l.temperature IN (...)`, whitelisted', async () => {
    const { svc, listSql } = build();
    await svc.list(ALL, { bands: ['hot', 'warm'] });
    const c = listSql();
    expect(c.sql.replace(/\s+/g, ' ')).toContain('l.temperature IN ($1,$2)');
    expect(c.params.slice(0, 2)).toEqual(['hot', 'warm']);
  });
});

describe('AND across filters — different filters intersect', () => {
  it('status_ids + owner_ids together -> the INTERSECTION (both IN clauses, ANDed)', async () => {
    const { svc, listSql } = build();
    await svc.list(ALL, { status_ids: [5, 8], owner_ids: [3, 4] });
    const sql = listSql().sql.replace(/\s+/g, ' ');
    expect(sql).toContain('l.status_id IN ($1,$2)');
    expect(sql).toContain('l.owner_id IN ($3,$4)');
    expect(sql).toContain(' AND ');
    expect(listSql().params.slice(0, 4)).toEqual([5, 8, 3, 4]);
  });

  it('arrays combine with the RBAC scope (narrow-only) AND a date range', async () => {
    const { svc, listSql } = build();
    await svc.list(BRANCH7, { branch_ids: [9, 10], created_from: '2026-07-01', created_to: '2026-07-31' });
    const sql = listSql().sql.replace(/\s+/g, ' ');
    expect(sql).toContain('(l.branch_id = $1)');       // RBAC scope, cannot widen
    expect(sql).toContain('l.branch_id IN ($2,$3)');   // the user-chosen branches (within scope)
    expect(sql).toContain('l.created_at >= $4::date');
    expect(sql).toContain("l.created_at < ($5::date + INTERVAL '1 day')");
    expect(listSql().params.slice(0, 5)).toEqual([7, 9, 10, '2026-07-01', '2026-07-31']);
  });
});

describe('back-compat — the singular params still work and fold into the IN', () => {
  it('singular status_id still narrows (folds into IN)', async () => {
    const { svc, listSql } = build();
    await svc.list(ALL, { status_id: 8 });
    const c = listSql();
    expect(c.sql.replace(/\s+/g, ' ')).toContain('l.status_id IN ($1)');
    expect(c.params[0]).toBe(8);
  });

  it('singular ?temperature= still emits `= $` (existing card links / tests)', async () => {
    const { svc, listSql } = build();
    await svc.list(ALL, { temperature: 'hot' });
    expect(listSql().sql).toContain('l.temperature = $1');
    expect(listSql().params[0]).toBe('hot');
  });

  it('a singular id and an array on the SAME filter are unioned into one IN', async () => {
    const { svc, listSql } = build();
    await svc.list(ALL, { owner_id: 3, owner_ids: [4, 5] });
    const c = listSql();
    expect(c.sql.replace(/\s+/g, ' ')).toMatch(/l\.owner_id IN \(\$1,\$2,\$3\)/);
    expect((c.params.slice(0, 3) as number[]).slice().sort((a, b) => a - b)).toEqual([3, 4, 5]);
  });
});

describe('bad input is ignored (never interpolated) — ints only, band whitelist', () => {
  it('non-positive / non-int ids are dropped from the IN', async () => {
    const { svc, listSql } = build();
    await svc.list(ALL, { owner_ids: [4, 0, -1, NaN as unknown as number] });
    const c = listSql();
    expect(c.sql.replace(/\s+/g, ' ')).toContain('l.owner_id IN ($1)');
    expect(c.params[0]).toBe(4);
  });

  it('an all-invalid array adds no clause at all', async () => {
    const { svc, listSql } = build();
    await svc.list(ALL, { status_ids: [0, -3] });
    expect(listSql().sql).not.toContain('l.status_id IN');
  });

  it('a non-whitelisted band value is dropped', async () => {
    const { svc, listSql } = build();
    await svc.list(ALL, { bands: ['hot', "x'; DROP TABLE lead;--"] });
    const c = listSql();
    expect(c.sql.replace(/\s+/g, ' ')).toContain('l.temperature IN ($1)');
    expect(c.params[0]).toBe('hot');
    expect(c.sql).not.toContain('DROP TABLE');
  });
});

describe('select-ids honours the SAME arrays as the list (bulk over the whole filter)', () => {
  it('status_ids reach the select-ids WHERE identically', async () => {
    const { svc, selSql } = build();
    await svc.selectIds(ALL, { status_ids: [5, 8] });
    const c = selSql();
    expect(c.sql.replace(/\s+/g, ' ')).toContain('l.status_id IN ($1,$2)');
    expect(c.params.slice(0, 2)).toEqual([5, 8]);
  });
});
