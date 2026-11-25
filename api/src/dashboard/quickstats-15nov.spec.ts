/**
 * FB-2026-016 (client's 15 Nov feedback document, point 11) — "in Quick Stats the Follow-ups done card
 * filters wrong data: it should filter follow-ups done according to whatever date is selected. Date
 * range needs an All time option also."
 */
import { BadRequestException } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { FollowUpsService } from '../leads/followups.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { DatabaseService } from '../database/database.service';
import { ResolvedScope } from '../rbac/rbac.types';

const ALL: ResolvedScope = { permissionKey: 'lead.read', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [] };

function fakeDb() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return []; },
    one: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return {}; },
  } as unknown as DatabaseService;
  return { db, calls };
}

describe('Quick Stats — All time (FB-2026-016)', () => {
  it('all=true counts every date (lead and follow-up queries), and says so in the range', async () => {
    const { db, calls } = fakeDb();
    const res: any = await new DashboardService(db, new ScopeResolverService()).quickStats(ALL, { all: true });
    expect(res.range).toEqual({ from: null, to: null });
    const withDates = calls.filter((c) => c.params.includes('1900-01-01'));
    expect(withDates).toHaveLength(2);
    for (const c of withDates) expect(c.params).toContain('2999-12-31');
  });

  it('without all, a missing range is still this month (unchanged)', async () => {
    const { db, calls } = fakeDb();
    await new DashboardService(db, new ScopeResolverService()).quickStats(ALL, {});
    expect(calls.some((c) => c.params.includes('1900-01-01'))).toBe(false);
  });
});

describe('Follow-ups list — done between (FB-2026-016)', () => {
  const build = () => {
    const { db, calls } = fakeDb();
    const svc = new FollowUpsService(db, new ScopeResolverService(),
      { assertRefInScope: async () => undefined } as any,
      { safeRescore: async () => undefined } as any, { safe: async () => undefined } as any,
      { get: async (_k: string, d: any) => d } as any);
    const list = () => calls.find((c) => /FROM follow_up f/.test(c.sql))!;
    return { svc, list };
  };

  it('done_from/done_to = status Done AND completed in the window (the rows the card counts)', async () => {
    const { svc, list } = build();
    await svc.list(ALL, { done_from: '2026-11-01', done_to: '2026-11-25' }, 1);
    const sql = list().sql.replace(/\s+/g, ' ');
    expect(sql).toContain(`f.status = 'done'`);
    expect(sql).toMatch(/f\.completed_at::date >= \$\d+::date/);
    expect(sql).toMatch(/f\.completed_at::date <= \$\d+::date/);
    expect(list().params).toEqual(expect.arrayContaining(['2026-11-01', '2026-11-25']));
  });

  it('no window → no completed_at filter (unchanged)', async () => {
    const { svc, list } = build();
    await svc.list(ALL, {}, 1);
    expect(list().sql).not.toContain('completed_at::date');
  });

  it('a bad date is a 400, not a silently different list', async () => {
    const { svc } = build();
    await expect(svc.list(ALL, { done_from: 'last-week' }, 1)).rejects.toBeInstanceOf(BadRequestException);
  });
});
