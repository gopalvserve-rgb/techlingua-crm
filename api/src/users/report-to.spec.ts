import { BadRequestException } from '@nestjs/common';
import { UsersService } from './users.service';

/**
 * User "Reports To" (client, Aug 2026) — a user's reporting MANAGER on the user record,
 * DISTINCT from the task-level report_to (follow_up.report_to_id, migration 016). Create /
 * update persist report_to_id, and a non-null target must be an ACTIVE user (no-deactivated
 * rule); a user may not report to themselves. Unit-tested against hand-built db doubles.
 */
// route db.one by the SQL it receives, so call-order does not make the test brittle.
const router = (opts: { activeUser?: any } = {}) => (sql: string) => {
  if (/status = 'active'/.test(sql)) return Promise.resolve(opts.activeUser === undefined ? { id: '12' } : opts.activeUser);
  if (/FROM organisation/.test(sql)) return Promise.resolve({ id: '1' });
  if (/WHERE phone =/.test(sql)) return Promise.resolve(null);           // no dup phone
  if (/lower\(email\)/.test(sql)) return Promise.resolve(null);          // no dup email
  if (/FROM "user" u LEFT JOIN "user" m/.test(sql)) return Promise.resolve({ id: '7', name: 'X', status: 'active' }); // get()
  return Promise.resolve(null);
};

const make = (opts: { activeUser?: any } = {}) => {
  const one = jest.fn().mockImplementation((sql: string) => router(opts)(sql));
  const cQuery = jest.fn().mockResolvedValue({ rows: [{ id: '7', name: 'New', report_to_id: '12' }] });
  const query = jest.fn().mockResolvedValue([]);
  const db = { one, query, tx: jest.fn(async (cb: any) => cb({ query: cQuery })) } as any;
  const enforcer = { assertRefInScope: jest.fn().mockResolvedValue(undefined) } as any;
  const svc = new UsersService(db, {} as any, enforcer);
  return { svc, db, one, query, cQuery };
};

describe('UsersService.create — report_to_id', () => {
  it('persists report_to_id in the INSERT when the target is active', async () => {
    const { svc, cQuery } = make();
    await svc.create({ name: 'New', phone: '+919810000009', report_to_id: 12 } as any, 1);
    const ins = cQuery.mock.calls.find((c: any[]) => /INSERT INTO "user"/.test(c[0]));
    expect(ins[0]).toMatch(/report_to_id/);
    // params order: org,name,email,phone,hash,status,report_to_id,actor
    expect(ins[1][6]).toBe(12);
  });

  it('rejects a DEACTIVATED / unknown report_to target (active-user guard)', async () => {
    const { svc, cQuery } = make({ activeUser: null }); // guard query finds no active user
    await expect(svc.create({ name: 'New', phone: '+919810000009', report_to_id: 99 } as any, 1))
      .rejects.toThrow(/report_to_id must be an active user/);
    expect(cQuery).not.toHaveBeenCalled(); // never inserted
  });

  it('leaves report_to_id null when not provided', async () => {
    const { svc, cQuery } = make();
    await svc.create({ name: 'New', phone: '+919810000009' } as any, 1);
    const ins = cQuery.mock.calls.find((c: any[]) => /INSERT INTO "user"/.test(c[0]));
    expect(ins[1][6]).toBeNull();
  });
});

describe('UsersService.update — report_to_id', () => {
  it('sets report_to_id when the target is active', async () => {
    const { svc, cQuery } = make();
    await svc.update(7, { report_to_id: 12 } as any, 1);
    const upd = cQuery.mock.calls.find((c: any[]) => /UPDATE "user" SET/.test(c[0]));
    expect(upd[0]).toMatch(/report_to_id = \$/);
    expect(upd[1]).toContain(12);
  });

  it('clears report_to_id on null (no active-user check)', async () => {
    const { svc, cQuery } = make({ activeUser: null });
    await svc.update(7, { report_to_id: null } as any, 1);
    const upd = cQuery.mock.calls.find((c: any[]) => /UPDATE "user" SET/.test(c[0]));
    expect(upd[0]).toMatch(/report_to_id = \$/);
    expect(upd[1]).toContain(null);
  });

  it('rejects a user reporting to themselves', async () => {
    const { svc } = make();
    await expect(svc.update(7, { report_to_id: 7 } as any, 1)).rejects.toThrow(/cannot report to themselves/);
  });

  it('rejects a deactivated report_to target on update', async () => {
    const { svc } = make({ activeUser: null });
    await expect(svc.update(7, { report_to_id: 99 } as any, 1)).rejects.toThrow(/report_to_id must be an active user/);
  });
});
