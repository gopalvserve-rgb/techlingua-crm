import { LeadsService } from './leads.service';

/**
 * UAT-R3 #23 — reassign() reassigns a lead's owner. It delegates to the tested update()
 * path (owner-in-scope check, 'assign' activity, SLA touch, audit via interceptor) and
 * validates the target before doing so. The controller gates it on `lead.assign`.
 */
describe('#23 — LeadsService.reassign', () => {
  const make = () =>
    new LeadsService(null as any, null as any, null as any, null as any, null as any, null as any);

  it('delegates to update() with only owner_id set', async () => {
    const svc = make();
    const spy = jest.spyOn(svc, 'update').mockResolvedValue({ id: 1, owner_id: 5 } as any);
    const scope = {} as any;
    const out = await svc.reassign(1, 5, 9, scope);
    expect(spy).toHaveBeenCalledWith(1, { owner_id: 5 }, 9, scope);
    expect(out).toEqual({ id: 1, owner_id: 5 });
  });

  it('rejects a missing / invalid target user with 400 (never a silent no-op)', async () => {
    const svc = make();
    jest.spyOn(svc, 'update').mockResolvedValue({} as any);
    await expect(svc.reassign(1, undefined as any, 9, {} as any)).rejects.toThrow(/required/);
    await expect(svc.reassign(1, 0, 9, {} as any)).rejects.toThrow(/required/);
  });
});
