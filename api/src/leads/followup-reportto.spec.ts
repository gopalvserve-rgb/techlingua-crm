import { BadRequestException } from '@nestjs/common';
import { FollowUpsService } from './followups.service';
import { ResolvedScope } from '../rbac/rbac.types';

/**
 * Client update #5 — task "Report To".
 * Covers: report_to_id persists on create/update, an unknown/inactive user is rejected,
 * and the My Tasks tabs keep their meaning (assigned -> owner_id, reported -> created_by).
 */
const ALL: ResolvedScope = {
  permissionKey: 'followup.create', allowed: true, all: true,
  filters: [], allowedFields: null, deniedFields: [],
};

function build(opts: { activeUsers?: number[] } = {}) {
  const active = opts.activeUsers ?? [1, 7];
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: [{ id: 99, status: 'pending', report_to_id: params?.[9] ?? null }] };
    },
  };
  const db: any = {
    query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return []; },
    one: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/FROM "user" WHERE id/.test(sql)) {
        return active.includes(Number(params[0])) ? { id: String(params[0]) } : null;
      }
      if (/FROM lead WHERE id/.test(sql)) return { org_id: '1', branch_id: '1', owner_id: '1' };
      if (/FROM follow_up f JOIN lead/.test(sql)) {
        return { id: 99, lead_id: 5, owner_id: 1, status: 'pending', org_id: '1', branch_id: '1', report_to_id: null };
      }
      return null;
    },
    tx: async (cb: (c: unknown) => Promise<unknown>) => cb(client),
  };
  const resolver: any = { buildScopeWhere: () => '1=1' };
  const enforcer: any = { assertRefInScope: async () => undefined };
  return { svc: new FollowUpsService(db, resolver, enforcer), calls };
}

describe('follow-up report_to_id (client update #5)', () => {
  it('persists report_to_id on create', async () => {
    const { svc, calls } = build();
    await svc.create({ lead_id: 5, scheduled_at: '2026-07-20T10:00:00Z', owner_id: 1, report_to_id: 7 }, 1, ALL);
    const ins = calls.find((c) => /INSERT INTO follow_up/.test(c.sql));
    expect(ins).toBeDefined();
    expect(ins!.sql).toContain('report_to_id');
    expect(ins!.params[9]).toBe(7); // last positional = report_to_id
  });

  it('stores NULL when Report To is omitted (no silent server-side default)', async () => {
    const { svc, calls } = build();
    await svc.create({ lead_id: 5, scheduled_at: '2026-07-20T10:00:00Z' }, 1, ALL);
    const ins = calls.find((c) => /INSERT INTO follow_up/.test(c.sql))!;
    expect(ins.params[9]).toBeNull();
    expect(ins.params[8]).toBe(1); // created_by is still the actor
  });

  it('rejects a report_to_id that is not an active user', async () => {
    const { svc } = build({ activeUsers: [1] });
    await expect(
      svc.create({ lead_id: 5, scheduled_at: '2026-07-20T10:00:00Z', report_to_id: 4242 }, 1, ALL),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('updates report_to_id and can clear it', async () => {
    const { svc, calls } = build();
    await svc.update(99, { report_to_id: 7 }, 1, ALL);
    let upd = calls.find((c) => /UPDATE follow_up SET/.test(c.sql))!;
    expect(upd.sql).toContain('report_to_id =');
    expect(upd.params[0]).toBe(7);

    const cleared = build();
    await cleared.svc.update(99, { report_to_id: null }, 1, ALL);
    upd = cleared.calls.find((c) => /UPDATE follow_up SET/.test(c.sql))!;
    expect(upd.params[0]).toBeNull();
  });

  it('exposes report_to_id + report_to_name in the list SELECT', async () => {
    const { svc, calls } = build();
    await svc.list(ALL, { view: 'assigned' }, 1);
    const sel = calls.find((c) => /SELECT f\.id/.test(c.sql))!;
    expect(sel.sql).toContain('f.report_to_id');
    expect(sel.sql).toContain('ru.name AS report_to_name');
  });

  it('view=reported still keys off created_by, view=assigned off owner_id (unchanged)', async () => {
    const rep = build();
    await rep.svc.list(ALL, { view: 'reported' }, 42);
    const rSql = rep.calls.find((c) => /SELECT f\.id/.test(c.sql))!;
    expect(rSql.sql).toContain('f.created_by = $');
    expect(rSql.sql).not.toContain('f.report_to_id = $');
    expect(rSql.params).toContain(42);

    const asg = build();
    await asg.svc.list(ALL, { view: 'assigned' }, 42);
    const aSql = asg.calls.find((c) => /SELECT f\.id/.test(c.sql))!;
    expect(aSql.sql).toContain('f.owner_id = $');
  });
});
