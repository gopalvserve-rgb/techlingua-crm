import { NotFoundException } from '@nestjs/common';
import { ScopeEnforcerService } from './scope-enforcer.service';
import { ScopeResolverService } from './scope-resolver.service';
import { ResolvedScope } from './rbac.types';

/** Unit tests for the by-ID record-scope enforcement (QA DEF-1). */

const scope = (over: Partial<ResolvedScope>): ResolvedScope => ({
  permissionKey: 'campaign.update', allowed: true, all: false,
  filters: [], allowedFields: null, deniedFields: [], ...over,
});

const branchScope = (branchId: number) => scope({ filters: [{ kind: 'branch', branchId }] });

function makeService(oneResult: unknown) {
  const db = { one: jest.fn().mockResolvedValue(oneResult) } as any;
  return { svc: new ScopeEnforcerService(db, new ScopeResolverService()), db };
}

describe('ScopeEnforcerService.assertInScope', () => {
  it('passes without querying when scope is all', async () => {
    const { svc, db } = makeService(null);
    await expect(svc.assertInScope(scope({ all: true }), 'campaign', 42)).resolves.toBeUndefined();
    expect(db.one).not.toHaveBeenCalled();
  });

  it('denies (404) when scope is not allowed at all', async () => {
    const { svc } = makeService({ ok: 1 });
    await expect(svc.assertInScope(scope({ allowed: false }), 'campaign', 42))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('passes when the row matches the branch filter', async () => {
    const { svc, db } = makeService({ ok: 1 });
    await svc.assertInScope(branchScope(1), 'campaign', 42);
    const [sql, params] = db.one.mock.calls[0];
    expect(sql).toContain('FROM campaign e');
    expect(sql).toContain('e.branch_id = $1');
    expect(params).toEqual([1, 42]);
  });

  it('throws 404 when the row is outside the scope (or missing) — no existence oracle', async () => {
    const { svc } = makeService(null);
    await expect(svc.assertInScope(branchScope(1), 'campaign', 42))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('resolves stages through their pipeline path', async () => {
    const { svc, db } = makeService({ ok: 1 });
    await svc.assertInScope(branchScope(1), 'stage', 7);
    const [sql] = db.one.mock.calls[0];
    expect(sql).toContain('pipeline_stage st JOIN pipeline e');
    expect(sql).toContain('st.id =');
  });

  it('user check unions scope with self (requester can always read themself)', async () => {
    const { svc, db } = makeService({ ok: 1 });
    await svc.assertInScope(branchScope(1), 'user', 9, 9);
    const [sql, params] = db.one.mock.calls[0];
    expect(sql).toContain('user_assignment ua');
    expect(sql).toContain('OR u.id =');
    expect(params).toContain(9);
  });

  it('denies scoped (non-all) access to org-level masters without querying', async () => {
    const { svc, db } = makeService({ ok: 1 });
    await expect(svc.assertInScope(branchScope(1), 'master', 3))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(db.one).not.toHaveBeenCalled();
  });

  it('denies when no filter maps onto the entity (deny rather than widen)', async () => {
    const { svc, db } = makeService({ ok: 1 });
    // own-scoped grant cannot address a branch by id (branch has no owner column)
    const own = scope({ filters: [{ kind: 'own', userId: 5 }] });
    await expect(svc.assertInScope(own, 'branch', 1)).rejects.toBeInstanceOf(NotFoundException);
    expect(db.one).not.toHaveBeenCalled();
  });
});

/** QA DEF-QA4-03 — body-referenced entity ids (follow-up lead_id, lead owner/campaign, ...). */
describe('ScopeEnforcerService.assertRefInScope', () => {
  const ownScope = (userId: number) => scope({ filters: [{ kind: 'own', userId }] });

  it('skips null/undefined references (required-field validation stays in services)', async () => {
    const { svc, db } = makeService(null);
    await expect(svc.assertRefInScope(scope({}), 'lead', undefined)).resolves.toBeUndefined();
    await expect(svc.assertRefInScope(scope({}), 'user', null)).resolves.toBeUndefined();
    expect(db.one).not.toHaveBeenCalled();
  });

  it('passes without querying when scope is all', async () => {
    const { svc, db } = makeService(null);
    await expect(svc.assertRefInScope(scope({ all: true }), 'lead', 42)).resolves.toBeUndefined();
    expect(db.one).not.toHaveBeenCalled();
  });

  it('404s when an own-scoped caller references a lead they do not own (FU-08)', async () => {
    const { svc, db } = makeService(null); // no row inside scope
    await expect(svc.assertRefInScope(ownScope(5), 'lead', 42, 5))
      .rejects.toBeInstanceOf(NotFoundException);
    const [sql, params] = db.one.mock.calls[0];
    expect(sql).toContain('e.owner_id = $1');
    expect(params).toEqual([5, 42]);
  });

  it('passes when the referenced lead IS inside the caller scope', async () => {
    const { svc } = makeService({ ok: 1 });
    await expect(svc.assertRefInScope(ownScope(5), 'lead', 42, 5)).resolves.toBeUndefined();
  });

  it('ALLOWS a reference when no filter maps onto the entity (own-scoped agent -> campaign)', async () => {
    // Deliberate difference vs assertInScope: the caller's scope does not
    // constrain that dimension, so lead creation stays possible for own-scoped agents.
    const { svc, db } = makeService(null);
    await expect(svc.assertRefInScope(ownScope(5), 'campaign', 3, 5)).resolves.toBeUndefined();
    expect(db.one).not.toHaveBeenCalled();
  });

  it('404s when a branch-scoped caller references a campaign of another branch', async () => {
    const { svc } = makeService(null);
    await expect(svc.assertRefInScope(branchScope(1), 'campaign', 99))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('user reference: requester referencing themself always passes the SQL union', async () => {
    const { svc, db } = makeService({ ok: 1 });
    await svc.assertRefInScope(ownScope(5), 'user', 5, 5);
    const [sql] = db.one.mock.calls[0];
    expect(sql).toContain('OR u.id =');
  });
});
