import { LeadsService } from './leads.service';

/**
 * Users row action #7 — BULK hand-off. reassignAllOwned moves EVERY in-scope lead owned
 * by X to Y: target must be active + in scope, per-lead reassign path is reused (update),
 * one audit_log 'transfer' row is written per lead, and the moved count is returned.
 */
const make = (ownedRows: any[], activeUserRow: any = { id: '12' }) => {
  const one = jest.fn().mockResolvedValue(activeUserRow); // assertActiveUser
  const query = jest.fn()
    .mockResolvedValueOnce(ownedRows)          // scoped owned-leads select
    .mockResolvedValue([]);                    // per-lead audit inserts
  const db = { one, query, tx: jest.fn() } as any;
  const resolver = { buildScopeWhere: jest.fn().mockReturnValue('TRUE') } as any;
  const enforcer = { assertRefInScope: jest.fn().mockResolvedValue(undefined) } as any;
  const svc = new LeadsService(db, resolver, enforcer, null as any, null as any, null as any);
  // isolate the orchestration from update()'s own (separately tested) internals
  const update = jest.spyOn(svc, 'update').mockResolvedValue({ id: 1 } as any);
  return { svc, db, query, enforcer, update };
};

describe('LeadsService.reassignAllOwned (bulk reassign)', () => {
  it('rejects when source and target are the same user', async () => {
    const { svc } = make([]);
    await expect(svc.reassignAllOwned(5, 5, 9, {} as any)).rejects.toThrow(/different from from_user_id/);
  });

  it('rejects a disabled / unknown target (active-user guard)', async () => {
    const { svc } = make([{ id: '1', org_id: '1' }], null); // user row null => not active
    await expect(svc.reassignAllOwned(5, 12, 9, {} as any)).rejects.toThrow(/to_user_id must be an active user/);
  });

  it('moves every owned lead to the target and writes one audit row per lead', async () => {
    const owned = [{ id: '101', org_id: '1' }, { id: '102', org_id: '1' }, { id: '103', org_id: '1' }];
    const { svc, query, update, enforcer } = make(owned);
    const out = await svc.reassignAllOwned(5, 12, 9, {} as any);
    expect(out).toEqual({ moved: 3, from_user_id: 5, to_user_id: 12 });
    expect(enforcer.assertRefInScope).toHaveBeenCalledWith({}, 'user', 12, 9);
    // update() called once per lead with the new owner
    expect(update).toHaveBeenCalledTimes(3);
    expect(update).toHaveBeenCalledWith(101, { owner_id: 12 }, 9, {});
    // one 'transfer' audit insert per lead (plus the initial owned-leads select)
    const auditInserts = query.mock.calls.filter((c: any[]) => /INSERT INTO audit_log/.test(c[0]) && /'transfer'/.test(c[0]));
    expect(auditInserts).toHaveLength(3);
  });

  it('returns moved:0 when the user owns nothing in scope', async () => {
    const { svc, update } = make([]);
    const out = await svc.reassignAllOwned(5, 12, 9, {} as any);
    expect(out.moved).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });
});
