import { NotFoundException } from '@nestjs/common';
import { LeadsController } from './leads.controller';
import { PERMISSION_KEY, SCOPED_ENTITY_KEY } from '../rbac/rbac.decorators';
import { ResolvedScope } from '../rbac/rbac.types';

/**
 * RBAC on the merge endpoints.
 *
 * A merge REWRITES a lead, so it may only ever touch leads inside the caller's
 * record scope — and BOTH leads matter: the survivor (:id, guarded by
 * @ScopedEntity) and the lead being merged away (from_lead_id, guarded by the
 * STRICT ScopeEnforcer inside the handler). Merging an out-of-scope lead into
 * one you own would be a data-exfiltration hole; this suite is the guard.
 */

const OWN: ResolvedScope = {
  permissionKey: 'lead.merge', allowed: true, all: false,
  filters: [{ kind: 'own', userId: 9 }], allowedFields: null, deniedFields: [],
};

describe('LeadsController — merge RBAC', () => {
  const meta = (method: string, key: string) =>
    Reflect.getMetadata(key, (LeadsController.prototype as Record<string, any>)[method]);

  it('every merge route demands the lead.merge permission', () => {
    expect(meta('mergeLeads', PERMISSION_KEY)).toBe('lead.merge');
    expect(meta('mergePreview', PERMISSION_KEY)).toBe('lead.merge');
    // reading the duplicates panel only needs lead.read
    expect(meta('duplicates', PERMISSION_KEY)).toBe('lead.read');
  });

  it('every merge route passes :id through the record-scope guard', () => {
    for (const m of ['mergeLeads', 'mergePreview', 'duplicates']) {
      expect(meta(m, SCOPED_ENTITY_KEY)).toEqual({ kind: 'lead', param: 'id' });
    }
  });

  it('the SOURCE lead is scope-checked too (out of scope -> 404, never merged)', async () => {
    const merged: unknown[] = [];
    const merge = {
      mergeLeads: async (t: number, s: number) => { merged.push([t, s]); return { ok: true }; },
    } as any;
    // the enforcer sees lead #202 as out of the caller's scope
    const enforcer = {
      assertInScope: async (_s: ResolvedScope, kind: string, id: number) => {
        if (id === 202) throw new NotFoundException(`${kind} not found`);
      },
    } as any;
    const c = new LeadsController({} as any, merge, enforcer);

    await expect(c.mergeLeads(201, { from_lead_id: 202 }, OWN, { id: 9 }))
      .rejects.toThrow(NotFoundException);
    expect(merged).toHaveLength(0);          // nothing was merged

    await expect(c.mergePreview(201, '202', OWN, { id: 9 }))
      .rejects.toThrow(NotFoundException);
  });

  it('an in-scope source lead merges normally', async () => {
    const merged: unknown[] = [];
    const merge = {
      mergeLeads: async (t: number, s: number, actor: number, reopen: boolean) => {
        merged.push([t, s, actor, reopen]); return { ok: true };
      },
    } as any;
    const enforcer = { assertInScope: async () => undefined } as any;
    const c = new LeadsController({} as any, merge, enforcer);

    await c.mergeLeads(201, { from_lead_id: 202, reopen: true }, OWN, { id: 9 });
    expect(merged).toEqual([[201, 202, 9, true]]);
  });

  it('rejects a missing / malformed from_lead_id', async () => {
    const enforcer = { assertInScope: async () => undefined } as any;
    const c = new LeadsController({} as any, {} as any, enforcer);
    await expect(c.mergeLeads(201, {} as any, OWN, { id: 9 })).rejects.toThrow(/from_lead_id is required/);
    await expect(c.mergeLeads(201, { from_lead_id: 0 }, OWN, { id: 9 })).rejects.toThrow(/from_lead_id is required/);
    await expect(c.mergePreview(201, 'abc', OWN, { id: 9 })).rejects.toThrow(/source lead id/);
  });
});
