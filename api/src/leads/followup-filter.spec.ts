import { LeadsService } from './leads.service';
import { FollowUpsService } from './followups.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { DatabaseService } from '../database/database.service';
import { assertFollowupPreset, followupWindowSql, FOLLOWUP_PRESETS } from '../common/date.util';
import { BadRequestException } from '@nestjs/common';

/**
 * FOLLOW-UP DATE FILTER (client #3) — No Followup · Missed · Today · Tomorrow · Next 7 · Next 30
 * · Custom, computed in IST. Each preset must produce the RIGHT SQL window on BOTH the Leads list
 * (over the lead's pending follow-ups) and the follow-ups list (over the row's scheduled_at).
 */

const ALL: ResolvedScope = {
  permissionKey: 'lead.read', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [],
};
const IST_TODAY = "(now() AT TIME ZONE 'Asia/Kolkata')::date";

function buildLeads() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return []; },
    one: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return { n: 0 }; },
  } as unknown as DatabaseService;
  const svc = new LeadsService(db, new ScopeResolverService(),
    { assertRefInScope: async () => undefined } as any, {} as any,
    { safeRescore: async () => undefined } as any, { safe: async () => undefined } as any);
  const listSql = () => calls.find((c) => /FROM lead l\s+JOIN branch/.test(c.sql))!.sql.replace(/\s+/g, ' ');
  return { svc, calls, listSql };
}

function buildFollowups() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return []; },
    one: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return {}; },
  } as unknown as DatabaseService;
  const svc = new FollowUpsService(db, new ScopeResolverService(),
    { assertRefInScope: async () => undefined } as any,
    { safeRescore: async () => undefined } as any, { safe: async () => undefined } as any,
    { get: async (_k: string, d: any) => d } as any);
  const listSql = () => calls.find((c) => /FROM follow_up f/.test(c.sql))!.sql.replace(/\s+/g, ' ');
  return { svc, calls, listSql };
}

describe('assertFollowupPreset — validates the query param', () => {
  it('accepts every documented preset', () => {
    for (const p of FOLLOWUP_PRESETS) expect(assertFollowupPreset(p)).toBe(p);
  });
  it('treats empty / missing as undefined (no filter)', () => {
    expect(assertFollowupPreset(undefined)).toBeUndefined();
    expect(assertFollowupPreset('')).toBeUndefined();
  });
  it('rejects an unknown value with a 400', () => {
    expect(() => assertFollowupPreset('last-week')).toThrow(BadRequestException);
  });
});

describe('followupWindowSql — the IST day windows (pure)', () => {
  it('today = IST today', () => { expect(followupWindowSql('today', 'c', [])).toBe(`(c AT TIME ZONE 'Asia/Kolkata')::date = ${IST_TODAY}`); });
  it('tomorrow = IST today + 1', () => { expect(followupWindowSql('tomorrow', 'c', [])).toBe(`(c AT TIME ZONE 'Asia/Kolkata')::date = ${IST_TODAY} + 1`); });
  it('next7 = today .. today+7', () => { expect(followupWindowSql('next7', 'c', [])).toContain(`BETWEEN ${IST_TODAY} AND ${IST_TODAY} + 7`); });
  it('next30 = today .. today+30', () => { expect(followupWindowSql('next30', 'c', [])).toContain(`+ 30`); });
  it('custom binds from/to as params', () => {
    const params: unknown[] = [];
    const sql = followupWindowSql('custom', 'c', params, '2026-08-01', '2026-08-10');
    expect(sql).toContain('>= $1::date'); expect(sql).toContain('<= $2::date');
    expect(params).toEqual(['2026-08-01', '2026-08-10']);
  });
});

describe('Leads list — followup filter over the lead\'s PENDING follow-ups', () => {
  it('No Followup → NOT EXISTS a pending follow-up', async () => {
    const { svc, listSql } = buildLeads();
    await svc.list(ALL, { followup: 'no_followup' });
    expect(listSql()).toContain("NOT EXISTS (SELECT 1 FROM follow_up fu WHERE fu.lead_id = l.id AND fu.status = 'pending'");
  });
  it('Missed → EXISTS a pending follow-up in the past', async () => {
    const { svc, listSql } = buildLeads();
    await svc.list(ALL, { followup: 'missed' });
    const sql = listSql();
    expect(sql).toContain("EXISTS (SELECT 1 FROM follow_up fu WHERE fu.lead_id = l.id AND fu.status = 'pending'");
    expect(sql).toContain('fu.scheduled_at < now()');
  });
  it('Today → EXISTS a pending follow-up on IST today', async () => {
    const { svc, listSql } = buildLeads();
    await svc.list(ALL, { followup: 'today' });
    expect(listSql()).toContain(`(fu.scheduled_at AT TIME ZONE 'Asia/Kolkata')::date = ${IST_TODAY}`);
  });
  it('Tomorrow → IST today + 1', async () => {
    const { svc, listSql } = buildLeads();
    await svc.list(ALL, { followup: 'tomorrow' });
    expect(listSql()).toContain(`(fu.scheduled_at AT TIME ZONE 'Asia/Kolkata')::date = ${IST_TODAY} + 1`);
  });
  it('Next 7 Days → today .. today + 7', async () => {
    const { svc, listSql } = buildLeads();
    await svc.list(ALL, { followup: 'next7' });
    expect(listSql()).toContain(`BETWEEN ${IST_TODAY} AND ${IST_TODAY} + 7`);
  });
  it('Next 30 Days → today .. today + 30', async () => {
    const { svc, listSql } = buildLeads();
    await svc.list(ALL, { followup: 'next30' });
    expect(listSql()).toContain(`BETWEEN ${IST_TODAY} AND ${IST_TODAY} + 30`);
  });
  it('Custom → binds fu_from / fu_to into the EXISTS', async () => {
    const { svc, calls } = buildLeads();
    await svc.list(ALL, { followup: 'custom', fu_from: '2026-08-01', fu_to: '2026-08-31' });
    const c = calls.find((x) => /FROM lead l\s+JOIN branch/.test(x.sql))!;
    expect(c.params).toContain('2026-08-01');
    expect(c.params).toContain('2026-08-31');
    expect(c.sql.replace(/\s+/g, ' ')).toContain('(fu.scheduled_at AT TIME ZONE \'Asia/Kolkata\')::date >= $');
  });
  it('an invalid preset is a 400', async () => {
    const { svc } = buildLeads();
    await expect(svc.list(ALL, { followup: 'whenever' as any })).rejects.toThrow(BadRequestException);
  });
});

describe('Follow-ups list — followup filter over the row scheduled_at', () => {
  it('Missed → pending row now in the past', async () => {
    const { svc, listSql } = buildFollowups();
    await svc.list(ALL, { followup: 'missed' }, 1);
    expect(listSql()).toContain("f.status = 'pending' AND f.scheduled_at < now()");
  });
  it('Today → pending row on IST today', async () => {
    const { svc, listSql } = buildFollowups();
    await svc.list(ALL, { followup: 'today' }, 1);
    expect(listSql()).toContain(`(f.scheduled_at AT TIME ZONE 'Asia/Kolkata')::date = ${IST_TODAY}`);
  });
  it('Next 7 Days → pending row today .. today + 7', async () => {
    const { svc, listSql } = buildFollowups();
    await svc.list(ALL, { followup: 'next7' }, 1);
    expect(listSql()).toContain(`BETWEEN ${IST_TODAY} AND ${IST_TODAY} + 7`);
  });
  it('No Followup selects nothing (a follow-up row IS a follow-up)', async () => {
    const { svc, listSql } = buildFollowups();
    await svc.list(ALL, { followup: 'no_followup' }, 1);
    expect(listSql()).toContain('FALSE');
  });
  it('Custom → binds fu_from / fu_to', async () => {
    const { svc, calls } = buildFollowups();
    await svc.list(ALL, { followup: 'custom', fu_from: '2026-08-05', fu_to: '2026-08-09' }, 1);
    const c = calls.find((x) => /FROM follow_up f/.test(x.sql))!;
    expect(c.params).toContain('2026-08-05');
    expect(c.params).toContain('2026-08-09');
  });
  it('an invalid preset is a 400', async () => {
    const { svc } = buildFollowups();
    await expect(svc.list(ALL, { followup: 'soon' as any }, 1)).rejects.toThrow(BadRequestException);
  });
});
