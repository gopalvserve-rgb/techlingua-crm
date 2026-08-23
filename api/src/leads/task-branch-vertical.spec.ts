import { FollowUpsService } from './followups.service';
import { ResolvedScope } from '../rbac/rbac.types';

/**
 * Client Aug 2026 (#2) — Branch + Vertical are first-class on a Task (follow_up).
 * They must persist on create and on update, and the list SELECT must expose the
 * effective branch/vertical (task's own, falling back to the lead's path).
 */
const ALL: ResolvedScope = {
  permissionKey: 'followup.create', allowed: true, all: true,
  filters: [], allowedFields: null, deniedFields: [],
};

function build() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: [{ id: 99, status: 'pending' }] };
    },
  };
  const db: any = {
    query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return []; },
    one: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/FROM "user" WHERE id/.test(sql)) return { id: String(params[0]) };
      if (/FROM lead WHERE id/.test(sql)) return { org_id: '1', branch_id: '1', owner_id: '1' };
      if (/FROM follow_up f JOIN lead/.test(sql)) {
        return { id: 99, lead_id: 5, owner_id: 1, status: 'pending', org_id: '1', branch_id: '1' };
      }
      return null;
    },
    tx: async (cb: (c: unknown) => Promise<unknown>) => cb(client),
  };
  const resolver: any = { buildScopeWhere: () => '1=1' };
  const enforcer: any = { assertRefInScope: async () => undefined };
  const scoring: any = { safeRescore: async () => undefined };
  const sla: any = { safe: async (fn: () => Promise<void>) => fn().catch(() => undefined), onLeadTouched: async () => undefined };
  const settings: any = { get: async (_k: string, d: any) => d };
  return { svc: new FollowUpsService(db, resolver, enforcer, scoring, sla, settings), calls };
}

const base = { lead_id: 5, scheduled_at: '2030-07-20T10:00:00Z' };

describe('task branch/vertical (client #2)', () => {
  it('persists branch_id + vertical_id on create', async () => {
    const { svc, calls } = build();
    await svc.create({ ...base, owner_id: 1, branch_id: 3, vertical_id: 8 }, 1, ALL);
    const ins = calls.find((c) => /INSERT INTO follow_up/.test(c.sql))!;
    expect(ins.sql).toContain('branch_id');
    expect(ins.sql).toContain('vertical_id');
    // positional params: report_to_id=$10 (idx 9), branch_id=$11 (idx 10), vertical_id=$12 (idx 11)
    expect(ins.params[10]).toBe(3);
    expect(ins.params[11]).toBe(8);
  });

  it('stores NULL branch/vertical when omitted', async () => {
    const { svc, calls } = build();
    await svc.create(base, 1, ALL);
    const ins = calls.find((c) => /INSERT INTO follow_up/.test(c.sql))!;
    expect(ins.params[10]).toBeNull();
    expect(ins.params[11]).toBeNull();
  });

  it('updates branch_id + vertical_id (and can clear them)', async () => {
    const set = build();
    await set.svc.update(99, { branch_id: 4, vertical_id: 9 }, 1, ALL);
    const upd = set.calls.find((c) => /UPDATE follow_up SET/.test(c.sql))!;
    expect(upd.sql).toContain('branch_id =');
    expect(upd.sql).toContain('vertical_id =');
    expect(upd.params).toContain(4);
    expect(upd.params).toContain(9);

    const clr = build();
    await clr.svc.update(99, { branch_id: null, vertical_id: null }, 1, ALL);
    const uc = clr.calls.find((c) => /UPDATE follow_up SET/.test(c.sql))!;
    expect(uc.params[0]).toBeNull();
    expect(uc.params[1]).toBeNull();
  });

  it('exposes effective branch_id/vertical_id + names in the list SELECT', async () => {
    const { svc, calls } = build();
    await svc.list(ALL, { view: 'assigned' }, 1);
    const sel = calls.find((c) => /SELECT f\.id/.test(c.sql))!;
    expect(sel.sql).toContain('COALESCE(f.branch_id, l.branch_id) AS branch_id');
    expect(sel.sql).toContain('COALESCE(f.vertical_id, l.vertical_id) AS vertical_id');
    expect(sel.sql).toContain('AS branch_name');
    expect(sel.sql).toContain('AS vertical_name');
  });
});
