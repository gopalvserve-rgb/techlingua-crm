import { FollowUpsService, FOLLOWUP_BUCKETS, followupBucketSql } from './followups.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { DatabaseService } from '../database/database.service';
import { BadRequestException } from '@nestjs/common';

/**
 * TODAY'S FOLLOW-UPS KPI STATS (client Aug 2026) — /follow-ups/stats returns 8 buckets
 *   Overdue · Due Today · Next 7 Days · No-Shows · Done Today · Rescheduled · Hot Leads · Unreachable
 * computed in IST, scope-enforced. Each bucket predicate is shared with the /follow-ups?bucket=…
 * list filter (followupBucketSql), so a card's count equals the length of the list it opens.
 */

const ALL: ResolvedScope = {
  permissionKey: 'followup.read', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [],
};
// A NON-all scope must add a scope WHERE fragment (branch-limited).
const SCOPED: ResolvedScope = {
  permissionKey: 'followup.read', allowed: true, all: false,
  filters: [{ kind: 'branch', branchId: 7 } as any], allowedFields: null, deniedFields: [],
};
const IST_TODAY = "(now() AT TIME ZONE 'Asia/Kolkata')::date";

function build() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return []; },
    one: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return {}; },
  } as unknown as DatabaseService;
  const svc = new FollowUpsService(db, new ScopeResolverService(),
    { assertRefInScope: async () => undefined } as any,
    { safeRescore: async () => undefined } as any, { safe: async () => undefined } as any,
    { get: async (_k: string, d: any) => d } as any);
  const statsSql = () => calls.find((c) => /COUNT\(\*\) FILTER/.test(c.sql))!.sql.replace(/\s+/g, ' ');
  const listSql = () => calls.find((c) => /FROM follow_up f/.test(c.sql) && !/COUNT/.test(c.sql))!.sql.replace(/\s+/g, ' ');
  return { svc, calls, statsSql, listSql };
}

describe('followupBucketSql — the 8 KPI predicates (pure)', () => {
  it('overdue = pending, IST scheduled day < today', () => {
    expect(followupBucketSql('overdue')).toBe(`f.status = 'pending' AND (f.scheduled_at AT TIME ZONE 'Asia/Kolkata')::date < ${IST_TODAY}`);
  });
  it('due_today = pending, IST scheduled day = today', () => {
    expect(followupBucketSql('due_today')).toContain(`= ${IST_TODAY}`);
  });
  it('next7 = pending, today .. today + 7 (IST)', () => {
    expect(followupBucketSql('next7')).toContain(`BETWEEN ${IST_TODAY} AND ${IST_TODAY} + 7`);
  });
  it('done_today = done + IST completed day = today', () => {
    expect(followupBucketSql('done_today')).toContain("f.status = 'done'");
    expect(followupBucketSql('done_today')).toContain(`(f.completed_at AT TIME ZONE 'Asia/Kolkata')::date = ${IST_TODAY}`);
  });
  it('hot_leads = pending on a hot lead', () => {
    expect(followupBucketSql('hot_leads')).toBe("f.status = 'pending' AND l.temperature = 'hot'");
  });
  it('no_shows / unreachable / rescheduled match on the disposition NAME', () => {
    expect(followupBucketSql('no_shows')).toContain("d.name ILIKE '%no show%'");
    expect(followupBucketSql('unreachable')).toContain("d.name ILIKE '%not reachable%'");
    expect(followupBucketSql('rescheduled')).toContain("d.name ILIKE '%reschedul%'");
  });
  it('an unknown bucket returns null', () => {
    expect(followupBucketSql('nonsense')).toBeNull();
  });
});

describe('stats() — one scoped query with all 8 buckets', () => {
  it('emits a COUNT FILTER column for every bucket', async () => {
    const { svc, statsSql } = build();
    await svc.stats(ALL, 1);
    const sql = statsSql();
    for (const b of FOLLOWUP_BUCKETS) expect(sql).toContain(`AS ${b}`);
    expect(FOLLOWUP_BUCKETS.length).toBe(8);
  });
  it('joins the disposition master so the name-based buckets resolve', async () => {
    const { svc, statsSql } = build();
    await svc.stats(ALL, 1);
    expect(statsSql()).toContain('LEFT JOIN m_disposition d ON d.id = f.disposition_id');
  });
  it('excludes soft-deleted / inactive follow-ups and leads', async () => {
    const { svc, statsSql } = build();
    await svc.stats(ALL, 1);
    const sql = statsSql();
    expect(sql).toContain('f.is_active AND l.is_active');
    expect(sql).toContain('f.deleted_at IS NULL AND l.deleted_at IS NULL');
  });
  it('is scope-enforced — a branch-limited scope narrows the WHERE', async () => {
    const { svc, statsSql, calls } = build();
    await svc.stats(SCOPED, 1);
    // The resolver pushes the branch id(s) as bind params for the scoped fragment.
    const c = calls.find((x) => /COUNT\(\*\) FILTER/.test(x.sql))!;
    expect(c.params.length).toBeGreaterThan(0);
    expect(statsSql()).toMatch(/l\.branch_id|branch_id/);
  });
});

describe('list(bucket) — the card opens exactly its bucket list', () => {
  it('bucket=overdue applies the overdue predicate', async () => {
    const { svc, listSql } = build();
    await svc.list(ALL, { bucket: 'overdue' }, 1);
    expect(listSql()).toContain(`(f.scheduled_at AT TIME ZONE 'Asia/Kolkata')::date < ${IST_TODAY}`);
  });
  it('bucket=hot_leads applies the hot-lead predicate', async () => {
    const { svc, listSql } = build();
    await svc.list(ALL, { bucket: 'hot_leads' }, 1);
    expect(listSql()).toContain("l.temperature = 'hot'");
  });
  it('an invalid bucket is a 400', async () => {
    const { svc } = build();
    await expect(svc.list(ALL, { bucket: 'whoops' }, 1)).rejects.toThrow(BadRequestException);
  });
});
