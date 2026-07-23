import { LeadsService } from './leads.service';
import { assertActiveUser } from './active-user.util';

/**
 * DEF-R3-01 — the reassign / owner-update target must be an ACTIVE user.
 *
 * The real deactivation flag is `status` ('active' | 'disabled'); the legacy `is_active`
 * boolean is never written FALSE, so it is a no-op. The guard is the shared
 * `assertActiveUser`, whose single SQL (`status='active' AND deleted_at IS NULL`) rejects
 * disabled, soft-deleted and unknown targets identically — a 400 that NAMES the field.
 */
describe('DEF-R3-01 — assertActiveUser (shared guard)', () => {
  const dbReturning = (row: any) => ({ one: jest.fn().mockResolvedValue(row) } as any);

  it('rejects a DISABLED / soft-deleted / unknown user (SQL filters all three) with a 400 naming the field', async () => {
    // The SQL keys on status='active' AND deleted_at IS NULL, so a disabled row,
    // a soft-deleted row and a non-existent id all come back as null → same 400.
    const db = dbReturning(null);
    await expect(assertActiveUser(db, 67, 'owner_id')).rejects.toThrow(/owner_id must be an active user/);
    expect(db.one).toHaveBeenCalledWith(
      expect.stringMatching(/status = 'active' AND deleted_at IS NULL/),
      [67],
    );
  });

  it('rejects a non-positive / non-integer id before hitting the DB', async () => {
    const db = dbReturning({ id: '5' });
    await expect(assertActiveUser(db, 0, 'owner_id')).rejects.toThrow(/invalid owner_id/);
    expect(db.one).not.toHaveBeenCalled();
  });

  it('accepts an active, non-deleted user', async () => {
    const db = dbReturning({ id: '12' });
    await expect(assertActiveUser(db, 12, 'owner_id')).resolves.toBeUndefined();
  });
});

describe('DEF-R3-01 — LeadsService.reassign enforces the active-user guard', () => {
  const before = {
    id: 340, owner_id: 1, org_id: 1, branch_id: 9, pipeline_id: 10,
    stage_id: 100, status_id: 200,
  };

  const make = (userRow: any) => {
    // db.one is called: (1) SELECT * FROM lead  (2) the active-user guard
    //                   (3) post-tx rescore read
    const one = jest.fn()
      .mockResolvedValueOnce(before)      // before
      .mockResolvedValueOnce(userRow)     // assertActiveUser
      .mockResolvedValue({ score: 0, temperature: 'cold', score_breakdown: {}, is_flagged: false, flag_reason: null });
    const client = { query: jest.fn().mockResolvedValue({ rows: [{ ...before, owner_id: 12 }] }) };
    const db = { one, tx: jest.fn(async (cb: any) => cb(client)) } as any;
    const enforcer = { assertRefInScope: jest.fn().mockResolvedValue(undefined) } as any;
    const sla = { safe: jest.fn().mockResolvedValue(undefined) } as any;
    const scoring = { safeRescore: jest.fn().mockResolvedValue(undefined) } as any;
    const svc = new LeadsService(db, null as any, enforcer, null as any, scoring, sla);
    return { svc, db, client };
  };

  it('reassigning to a DISABLED / unknown user → 400 (never a silent 201), and NO write happens', async () => {
    const { svc, db, client } = make(null); // user row null = disabled/soft-deleted/unknown
    await expect(svc.reassign(340, 67, 9, {} as any)).rejects.toThrow(/owner_id must be an active user/);
    expect(db.tx).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
  });

  it('reassigning to an ACTIVE, in-scope user → succeeds and writes the assign', async () => {
    const { svc, db, client } = make({ id: '12' });
    const out = await svc.reassign(340, 12, 9, {} as any);
    expect(out).toBeDefined();
    expect(db.tx).toHaveBeenCalled();
    // the UPDATE + the 'assign' lead_activity ran
    const sqls = client.query.mock.calls.map((c: any[]) => String(c[0]));
    expect(sqls.some((s: string) => /UPDATE lead SET/.test(s))).toBe(true);
    expect(sqls.some((s: string) => /INSERT INTO lead_activity/.test(s))).toBe(true);
  });

  it('still rejects a missing / zero target with 400 (unchanged)', async () => {
    const { svc } = make({ id: '12' });
    await expect(svc.reassign(340, undefined as any, 9, {} as any)).rejects.toThrow(/required/);
    await expect(svc.reassign(340, 0, 9, {} as any)).rejects.toThrow(/required/);
  });
});
