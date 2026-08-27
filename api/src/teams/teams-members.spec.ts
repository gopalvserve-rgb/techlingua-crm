import 'reflect-metadata';
import { TeamsService } from './teams.service';
import { ResolvedScope } from '../rbac/rbac.types';

/**
 * 27aug Batch C item 7 — proper team creation: name a team + add multiple members (multi-select),
 * and edit membership. Asserts the create/update paths write team_member rows.
 */
const scopeAll: ResolvedScope = { permissionKey: 'team.create', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [] };
const resolver = { buildScopeWhere: () => '1=1' } as any;
const enforcer = { assertRefInScope: async () => undefined } as any;

function make() {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    one: async (sql: string) => { if (/FROM organisation/.test(sql)) return { id: 1 }; if (/FROM team WHERE id/.test(sql)) return { id: 5, name: 'T' }; return null; },
    query: async (sql: string, params: unknown[] = []) => { issued.push({ sql, params }); return []; },
    tx: async (fn: any) => fn({ query: async (sql: string, params: unknown[] = []) => { issued.push({ sql, params }); return { rows: [{ id: 5 }] }; } }),
  } as any;
  return { svc: new TeamsService(db, resolver, enforcer), issued };
}

describe('TeamsService — create/edit team with members (item 7)', () => {
  it('creates a team and inserts each member', async () => {
    const { svc, issued } = make();
    await svc.create({ name: 'North Counsellors', member_ids: [11, 12, 13] }, 9, scopeAll);
    const memberInserts = issued.filter((q) => /INSERT INTO team_member/.test(q.sql));
    expect(memberInserts.length).toBe(3);
    expect(memberInserts.map((q) => q.params[1])).toEqual([11, 12, 13]);
  });

  it('replaces membership on update (delete then re-insert)', async () => {
    const { svc, issued } = make();
    await svc.update(5, { member_ids: [20, 21] }, scopeAll, 9);
    expect(issued.some((q) => /DELETE FROM team_member/.test(q.sql))).toBe(true);
    expect(issued.filter((q) => /INSERT INTO team_member/.test(q.sql)).length).toBe(2);
  });

  it('rejects a team with no name', async () => {
    const { svc } = make();
    await expect(svc.create({ name: '' } as any, 9, scopeAll)).rejects.toThrow(/name is required/i);
  });
});
