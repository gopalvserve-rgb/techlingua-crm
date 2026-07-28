import { BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { UsersService } from './users.service';

/**
 * Users row actions #2/#8/#9 + the #3/#4/#5 "View …" reads — unit-tested against
 * hand-built db doubles (no Postgres), the house style for this service.
 */
const makeSvc = (overrides: Partial<Record<'one' | 'query', jest.Mock>> = {}) => {
  const one = overrides.one ?? jest.fn().mockResolvedValue({ id: '7', status: 'active', lead_assignment_enabled: true });
  const query = overrides.query ?? jest.fn().mockResolvedValue([]);
  const db = { one, query, tx: jest.fn(async (cb: any) => cb({ query })) } as any;
  const resolver = {} as any;
  const enforcer = {} as any;
  const svc = new UsersService(db, resolver, enforcer);
  return { svc, db, one, query };
};

describe('UsersService.setLeadAssignment (row action #8 — global per-user switch)', () => {
  it('flips the flag OFF and returns the new value', async () => {
    const one = jest.fn()
      .mockResolvedValueOnce({ id: '7', status: 'active', lead_assignment_enabled: true }) // get()
      .mockResolvedValueOnce({ id: '7', lead_assignment_enabled: false });                 // UPDATE RETURNING
    const { svc, query } = makeSvc({ one });
    const out = await svc.setLeadAssignment(7, false);
    expect(out).toEqual({ id: 7, lead_assignment_enabled: false });
    // the UPDATE targets the column with the boolean bound as a param
    expect(one.mock.calls[1][0]).toMatch(/UPDATE "user" SET lead_assignment_enabled = \$2/);
    expect(one.mock.calls[1][1]).toEqual([7, false]);
  });

  it('rejects a non-boolean', async () => {
    const { svc } = makeSvc();
    await expect(svc.setLeadAssignment(7, 'yes' as any)).rejects.toThrow(BadRequestException);
  });
});

describe('UsersService.changePassword (row action #9)', () => {
  it('rejects a weak password and NEVER hits the DB write', async () => {
    const { svc, query } = makeSvc();
    await expect(svc.changePassword(7, 'short')).rejects.toThrow(/at least 8 characters/);
    await expect(svc.changePassword(7, 'alllettersnodigit')).rejects.toThrow(/letter and one number/);
    expect(query).not.toHaveBeenCalled();
  });

  it('hashes a strong password, stores the hash, and returns nothing about the password', async () => {
    const { svc, query } = makeSvc();
    const out = await svc.changePassword(7, 'GoodPass9');
    expect(out).toEqual({ ok: true });
    // exactly one UPDATE, setting password_hash
    const call = query.mock.calls.find((c: any[]) => /password_hash = \$2/.test(c[0]));
    expect(call).toBeTruthy();
    const stored = call[1][1] as string;
    // it is a bcrypt hash, NOT the plaintext, and verifies against the plaintext
    expect(stored).not.toContain('GoodPass9');
    expect(await bcrypt.compare('GoodPass9', stored)).toBe(true);
    // the plaintext appears in NO returned value
    expect(JSON.stringify(out)).not.toContain('GoodPass9');
  });
});

describe('UsersService.setStatus (row action #2 — Activate / Deactivate)', () => {
  it('rejects an invalid status', async () => {
    const { svc } = makeSvc();
    await expect(svc.setStatus(7, 'zombie' as any)).rejects.toThrow(BadRequestException);
  });
});

describe('UsersService.access (rows #3/#4/#5 — branches / verticals / campaigns)', () => {
  it('returns the three scoped groupings read from active assignments', async () => {
    const one = jest.fn().mockResolvedValue({ id: '7', status: 'active', lead_assignment_enabled: true });
    const query = jest.fn()
      .mockResolvedValueOnce([])                                             // get(): assignments
      .mockResolvedValueOnce([])                                             // get(): teams
      .mockResolvedValueOnce([{ id: 1, name: 'HSR Branch' }])                 // branches
      .mockResolvedValueOnce([{ id: 2, name: 'Study Abroad', branch_id: 1 }]) // verticals
      .mockResolvedValueOnce([{ id: 3, name: 'Meta Jul', branch_id: 1, vertical_id: 2 }]); // campaigns
    const { svc } = makeSvc({ one, query });
    const out = await svc.access(7);
    expect(out.branches).toHaveLength(1);
    expect(out.verticals[0].name).toBe('Study Abroad');
    expect(out.campaigns[0].name).toBe('Meta Jul');
  });
});
