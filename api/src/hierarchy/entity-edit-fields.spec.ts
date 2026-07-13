import { BadRequestException } from '@nestjs/common';
import { HierarchyService } from './hierarchy.service';

/**
 * DEF-2 regression (client UAT: "Edit branch is not editable — only readonly
 * columns are showing").
 *
 * Root cause was that Branch Type / City / State / Contact Number / Branch Email /
 * Branch Head had NO columns and NO PATCH whitelist entries, so the web Edit modal
 * dumped them into its read-only `lock` list. These tests pin the server contract:
 * every field the Add form shows must survive create AND update.
 */

type Call = { sql: string; params: unknown[] };

function mkDb() {
  const calls: Call[] = [];
  const exec = (sql: string, params: unknown[] = []) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return [{ id: 1 }];
  };
  return {
    calls,
    query: async (sql: string, params: unknown[] = []) => exec(sql, params),
    one: async (sql: string, params: unknown[] = []) => (exec(sql, params) as any[])[0] ?? null,
    tx: async (fn: (c: any) => Promise<unknown>) =>
      fn({ query: async (sql: string, params: unknown[] = []) => ({ rows: exec(sql, params) }) }),
  };
}

const svc = (db: any) => new HierarchyService(db as any, { buildScopeWhere: () => 'TRUE' } as any, {} as any);

describe('DEF-2 — branch edit fields are persisted', () => {
  it('updateBranch whitelists every editable Add-Branch field (incl. address)', async () => {
    const db = mkDb();
    await svc(db).updateBranch(7, {
      name: 'Vikaspuri', code: 'VKP', address: 'A-11 2nd Floor, Vikaspuri',
      branch_type: 'Franchise Branch', contact_number: '+911140001234',
      email: 'vkp@techlingua.in', head_user_id: 3, state_id: 1, city_id: 2, is_active: true,
    });
    const upd = db.calls.find((c) => c.sql.startsWith('UPDATE branch'))!;
    expect(upd).toBeDefined();
    for (const col of ['name', 'code', 'address', 'branch_type', 'contact_number', 'email', 'head_user_id', 'state_id', 'city_id', 'is_active']) {
      expect(upd.sql).toContain(`${col} = $`);
    }
    // the address the client typed must actually reach the DB
    expect(upd.params).toContain('A-11 2nd Floor, Vikaspuri');
    // label -> enum
    expect(upd.params).toContain('franchise');
  });

  it('address-only PATCH works (the exact thing the client tried)', async () => {
    const db = mkDb();
    await svc(db).updateBranch(7, { address: 'New Address 42' } as any);
    const upd = db.calls.find((c) => c.sql.startsWith('UPDATE branch'))!;
    expect(upd.sql).toContain('address = $1');
    expect(upd.params[0]).toBe('New Address 42');
  });

  it('createBranch stores type / contact / email / head / city / state', async () => {
    const db = mkDb();
    await svc(db).createBranch({
      name: 'Janakpuri', code: 'jnp', address: 'Janakpuri', branch_type: 'Company Branch',
      contact_number: '+919000000009', email: 'jnp@techlingua.in', head_user_id: 4, state_id: 1, city_id: 2,
    }, 1);
    const ins = db.calls.find((c) => c.sql.startsWith('INSERT INTO branch'))!;
    expect(ins.sql).toContain('branch_type, contact_number, email, head_user_id');
    expect(ins.params).toEqual(expect.arrayContaining([
      'Janakpuri', 'JNP', 'company', '+919000000009', 'jnp@techlingua.in', 4,
    ]));
  });

  it('branchType maps the prototype labels and rejects junk', () => {
    expect(HierarchyService.branchType('Company Branch')).toBe('company');
    expect(HierarchyService.branchType('Franchise Branch')).toBe('franchise');
    expect(HierarchyService.branchType('franchise')).toBe('franchise');
    expect(HierarchyService.branchType('')).toBeNull();
    expect(HierarchyService.branchType(null)).toBeNull();
    expect(() => HierarchyService.branchType('Nope')).toThrow(BadRequestException);
  });
});

describe('DEF-2 — the same gap in the other hierarchy modules', () => {
  it('updateVertical accepts head + description', async () => {
    const db = mkDb();
    await svc(db).updateVertical(2, { name: 'BCL', head_user_id: 5, description: 'Bootcamp Learning' });
    const upd = db.calls.find((c) => c.sql.startsWith('UPDATE vertical'))!;
    expect(upd.sql).toContain('head_user_id = $');
    expect(upd.sql).toContain('description = $');
    expect(upd.params).toContain('Bootcamp Learning');
  });

  it('updatePipeline accepts owner', async () => {
    const db = mkDb();
    await svc(db).updatePipeline(3, { name: 'Admissions', owner_user_id: 6 });
    const upd = db.calls.find((c) => c.sql.startsWith('UPDATE pipeline'))!;
    expect(upd.sql).toContain('owner_user_id = $');
    expect(upd.params).toContain(6);
  });

  it('updateSource accepts cost per lead', async () => {
    const db = mkDb();
    await svc(db).updateSource(4, { name: 'Meta Ads', cost_per_lead: 250 });
    const upd = db.calls.find((c) => c.sql.startsWith('UPDATE source'))!;
    expect(upd.sql).toContain('cost_per_lead = $');
    expect(upd.params).toContain(250);
  });
});
