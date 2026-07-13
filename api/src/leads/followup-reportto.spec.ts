import { BadRequestException } from '@nestjs/common';
import { FollowUpsService } from './followups.service';
import { ResolvedScope } from '../rbac/rbac.types';

/**
 * Client update #5 — task "Report To" — plus DEF-1 (deactivated users are not assignable).
 *
 * The mock DB does NOT hand back a canned "is this user active?" answer: it holds user ROWS
 * and *evaluates the predicates the service actually emits* against them. A guard that only
 * checks the legacy `is_active` boolean therefore passes a disabled user through (exactly as
 * it did in prod, where nothing ever sets is_active=FALSE) and the DEF-1 tests fail.
 */
const ALL: ResolvedScope = {
  permissionKey: 'followup.create', allowed: true, all: true,
  filters: [], allowedFields: null, deniedFields: [],
};

type Row = { id: number; status: 'active' | 'disabled'; is_active: boolean; deleted_at: string | null };

/** Mirrors the live `user` table: is_active is legacy and always TRUE; `status` is the real flag. */
const USERS: Row[] = [
  { id: 1, status: 'active', is_active: true, deleted_at: null },
  { id: 7, status: 'active', is_active: true, deleted_at: null },
  { id: 9, status: 'disabled', is_active: true, deleted_at: null },          // deactivated (DEF-1)
  { id: 8, status: 'active', is_active: true, deleted_at: '2026-07-01' },    // soft-deleted
];

/** Apply exactly the WHERE predicates present in the emitted SQL — a poor man's planner. */
function runUserLookup(sql: string, id: number): { id: string } | null {
  const row = USERS.find((u) => u.id === Number(id));
  if (!row) return null;
  if (/deleted_at IS NULL/.test(sql) && row.deleted_at !== null) return null;
  if (/status\s*=\s*'active'/.test(sql) && row.status !== 'active') return null;
  if (/AND\s+is_active\b/.test(sql) && !row.is_active) return null;
  return { id: String(row.id) };
}

function build() {
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
      if (/FROM "user" WHERE id/.test(sql)) return runUserLookup(sql, Number(params[0]));
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

const userLookups = (calls: Array<{ sql: string }>) => calls.filter((c) => /FROM "user" WHERE id/.test(c.sql));
const base = { lead_id: 5, scheduled_at: '2026-07-20T10:00:00Z' };

describe('follow-up report_to_id (client update #5)', () => {
  it('persists report_to_id on create', async () => {
    const { svc, calls } = build();
    await svc.create({ ...base, owner_id: 1, report_to_id: 7 }, 1, ALL);
    const ins = calls.find((c) => /INSERT INTO follow_up/.test(c.sql));
    expect(ins).toBeDefined();
    expect(ins!.sql).toContain('report_to_id');
    expect(ins!.params[9]).toBe(7); // last positional = report_to_id
  });

  it('stores NULL when Report To is omitted (no silent server-side default)', async () => {
    const { svc, calls } = build();
    await svc.create(base, 1, ALL);
    const ins = calls.find((c) => /INSERT INTO follow_up/.test(c.sql))!;
    expect(ins.params[9]).toBeNull();
    expect(ins.params[8]).toBe(1); // created_by is still the actor
  });

  it('rejects a report_to_id that does not exist', async () => {
    const { svc } = build();
    await expect(svc.create({ ...base, report_to_id: 4242 }, 1, ALL)).rejects.toBeInstanceOf(BadRequestException);
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

describe('DEF-1 — deactivated users are not assignable (owner_id / report_to_id)', () => {
  it('guards on status, not the legacy is_active flag', async () => {
    const { svc, calls } = build();
    await svc.create({ ...base, owner_id: 1, report_to_id: 7 }, 1, ALL);
    const lookups = userLookups(calls);
    expect(lookups.length).toBe(2); // owner + report-to
    for (const c of lookups) {
      expect(c.sql).toMatch(/status\s*=\s*'active'/);   // the real deactivation flag
      expect(c.sql).toMatch(/deleted_at IS NULL/);      // soft delete still honoured
      expect(c.sql).not.toMatch(/AND\s+is_active\b/);   // the no-op guard is gone
    }
  });

  it('rejects a deactivated user (status=disabled) as report_to_id with 400', async () => {
    const { svc } = build();
    await expect(svc.create({ ...base, owner_id: 1, report_to_id: 9 }, 1, ALL))
      .rejects.toThrow(/report_to_id must be an active user/);
    await expect(svc.create({ ...base, owner_id: 1, report_to_id: 9 }, 1, ALL))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a deactivated user as owner_id with 400 (create)', async () => {
    const { svc, calls } = build();
    await expect(svc.create({ ...base, owner_id: 9 }, 1, ALL))
      .rejects.toThrow(/owner_id must be an active user/);
    expect(calls.some((c) => /INSERT INTO follow_up/.test(c.sql))).toBe(false); // nothing was written
  });

  it('rejects a deactivated user as owner_id with 400 (update / reassign)', async () => {
    const { svc, calls } = build();
    await expect(svc.update(99, { owner_id: 9 }, 1, ALL)).rejects.toBeInstanceOf(BadRequestException);
    expect(calls.some((c) => /UPDATE follow_up SET/.test(c.sql))).toBe(false);
  });

  it('rejects a deactivated user as report_to_id on update', async () => {
    const { svc } = build();
    await expect(svc.update(99, { report_to_id: 9 }, 1, ALL)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a soft-deleted user for both fields', async () => {
    const a = build();
    await expect(a.svc.create({ ...base, report_to_id: 8 }, 1, ALL)).rejects.toBeInstanceOf(BadRequestException);
    const b = build();
    await expect(b.svc.create({ ...base, owner_id: 8 }, 1, ALL)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('still accepts active users for both fields', async () => {
    const { svc, calls } = build();
    await svc.create({ ...base, owner_id: 7, report_to_id: 1 }, 1, ALL);
    const ins = calls.find((c) => /INSERT INTO follow_up/.test(c.sql))!;
    expect(ins.params[1]).toBe(7);  // owner_id
    expect(ins.params[9]).toBe(1);  // report_to_id
  });
});
