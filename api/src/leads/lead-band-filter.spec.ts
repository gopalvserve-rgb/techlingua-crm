import { LeadsService } from './leads.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { DatabaseService } from '../database/database.service';

/**
 * Sprint 3 — "Show the band on the lead list / Kanban / lead sheet, and make it
 * FILTERABLE and SORTABLE" (client, 14 Jul).
 *
 * The sort string lands in an ORDER BY, so the whitelist is a security control, not a
 * convenience: an unlisted value must fall back, never interpolate.
 */

const ALL: ResolvedScope = {
  permissionKey: 'lead.read', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [],
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
  const listSql = () => calls.find((c) => /FROM lead l\s+JOIN branch/.test(c.sql))!.sql;
  return { svc, calls, listSql };
}

describe('the Hot/Warm/Cold band is FILTERABLE', () => {
  it('?temperature=hot narrows to hot leads', async () => {
    const { svc, calls } = build();
    await svc.list(ALL, { temperature: 'hot' });
    const c = calls.find((x) => /FROM lead l\s+JOIN branch/.test(x.sql))!;
    expect(c.sql).toContain('l.temperature = $1');
    expect(c.params[0]).toBe('hot');
  });

  it('?sla_breached=1 narrows to leads with an OPEN breach', async () => {
    const { svc, listSql } = build();
    await svc.list(ALL, { sla_breached: true });
    expect(listSql().replace(/\s+/g, ' '))
      .toContain('EXISTS (SELECT 1 FROM lead_sla s WHERE s.lead_id = l.id AND s.satisfied_at IS NULL AND s.due_at <= now())');
  });

  it('?flagged=1 narrows to escalation-flagged leads', async () => {
    const { svc, listSql } = build();
    await svc.list(ALL, { flagged: true });
    expect(listSql()).toContain('l.is_flagged');
  });
});

describe('the band is SORTABLE — and the sort param cannot inject SQL', () => {
  it('sort=score orders by score, highest first', async () => {
    const { svc, listSql } = build();
    await svc.list(ALL, { sort: 'score' });
    expect(listSql()).toContain('ORDER BY l.score DESC NULLS LAST, l.created_at DESC');
  });

  it.each(['recent', 'oldest', 'score', 'score_asc', 'name', 'followup'])('sort=%s is accepted', async (sort) => {
    const { svc, listSql } = build();
    await svc.list(ALL, { sort });
    expect(listSql()).toMatch(/ORDER BY l\./);
  });

  it('an UNKNOWN sort silently falls back to `recent` — it is never interpolated', async () => {
    const { svc, listSql } = build();
    await svc.list(ALL, { sort: 'created_at; DROP TABLE lead;--' });
    const sql = listSql();
    expect(sql).toContain('ORDER BY l.created_at DESC');
    expect(sql).not.toContain('DROP TABLE');
  });

  it('no sort at all = newest first (unchanged behaviour)', async () => {
    const { svc, listSql } = build();
    await svc.list(ALL, {});
    expect(listSql()).toContain('ORDER BY l.created_at DESC');
  });
});

describe('the list carries what the badges need', () => {
  it('selects the score breakdown, the flag and the SLA-breach state', async () => {
    const { svc, listSql } = build();
    await svc.list(ALL, {});
    const sql = listSql();
    expect(sql).toContain('l.score_breakdown');
    expect(sql).toContain('l.is_flagged');
    expect(sql).toContain('AS sla_breached');
  });
});

/**
 * UAT-R2 #26 — the Lead list carries a created-date RANGE filter. `to` is inclusive of the
 * whole day (built as `< next day`), and both bounds are BOUND parameters, never inlined.
 */
describe('UAT-R2 #26 — the created-date range is filterable', () => {
  it('?created_from narrows to leads created on/after the date (bound param)', async () => {
    const { svc, calls } = build();
    await svc.list(ALL, { created_from: '2026-07-01' });
    const c = calls.find((x) => /FROM lead l\s+JOIN branch/.test(x.sql))!;
    expect(c.sql).toContain('l.created_at >= $1::date');
    expect(c.params[0]).toBe('2026-07-01');
  });

  it('?created_to is inclusive of the whole day (< next day) and bound', async () => {
    const { svc, calls } = build();
    await svc.list(ALL, { created_to: '2026-07-31' });
    const c = calls.find((x) => /FROM lead l\s+JOIN branch/.test(x.sql))!;
    expect(c.sql.replace(/\s+/g, ' ')).toContain("l.created_at < ($1::date + INTERVAL '1 day')");
    expect(c.params[0]).toBe('2026-07-31');
  });

  it('both bounds together narrow to the closed range', async () => {
    const { svc, listSql, calls } = build();
    await svc.list(ALL, { created_from: '2026-07-01', created_to: '2026-07-31' });
    const sql = listSql().replace(/\s+/g, ' ');
    expect(sql).toContain('l.created_at >= $1::date');
    expect(sql).toContain("l.created_at < ($2::date + INTERVAL '1 day')");
    const c = calls.find((x) => /FROM lead l\s+JOIN branch/.test(x.sql))!;
    expect(c.params.slice(0, 2)).toEqual(['2026-07-01', '2026-07-31']);
  });
});
