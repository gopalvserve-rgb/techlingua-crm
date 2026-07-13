import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { deleteGuardError, SoftDeleteService } from './softdelete.service';

/**
 * Soft delete engine: guards (system role / Super Admin / self-delete), the
 * deleted_at/deleted_by write, impact aggregation and the restore 409 when an
 * ancestor is itself deleted. DatabaseService mocked.
 */

type Row = Record<string, any> | null;

function makeDb(handlers: {
  onOne?: (sql: string, p: unknown[]) => Row;
  onQuery?: (sql: string, p: unknown[]) => Record<string, any>[];
}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    one: jest.fn(async (sql: string, p: unknown[] = []) => { calls.push({ sql, params: p }); return handlers.onOne ? handlers.onOne(sql, p) : null; }),
    query: jest.fn(async (sql: string, p: unknown[] = []) => { calls.push({ sql, params: p }); return handlers.onQuery ? handlers.onQuery(sql, p) : []; }),
  };
}

describe('deleteGuardError (pure)', () => {
  it('system role -> blocked', () => {
    expect(deleteGuardError('role', { targetId: 1, actorId: 9, isSystemRole: true })).toMatch(/System roles/);
  });
  it('custom role -> allowed', () => {
    expect(deleteGuardError('role', { targetId: 1, actorId: 9, isSystemRole: false })).toBeNull();
  });
  it('self-delete -> blocked', () => {
    expect(deleteGuardError('user', { targetId: 7, actorId: 7 })).toMatch(/own user/);
  });
  it('Super Admin user -> blocked', () => {
    expect(deleteGuardError('user', { targetId: 3, actorId: 9, isSuperAdminUser: true })).toMatch(/Super Admin/);
  });
  it('ordinary user by another actor -> allowed', () => {
    expect(deleteGuardError('user', { targetId: 3, actorId: 9, isSuperAdminUser: false })).toBeNull();
  });
});

describe('SoftDeleteService.remove', () => {
  it('soft-deletes the ONE row: sets deleted_at + deleted_by, never touches children', async () => {
    const db = makeDb({ onQuery: (sql) => (sql.includes('UPDATE branch') ? [{ id: '3', name: 'Delhi' }] : []) });
    const svc = new SoftDeleteService(db as any);
    const res = await svc.remove('branch', 3, 42);
    expect(res).toMatchObject({ ok: true, deleted: true, entity: 'branch', id: 3, name: 'Delhi' });
    const upd = db.calls.find((c) => c.sql.includes('UPDATE branch'))!;
    expect(upd.sql).toContain('SET deleted_at = now(), deleted_by = $2');
    expect(upd.sql).toContain('deleted_at IS NULL'); // repeat delete -> 404
    expect(upd.params).toEqual([3, 42]);
    // exactly one UPDATE — no cascading writes to verticals/leads/etc.
    expect(db.calls.filter((c) => c.sql.trimStart().startsWith('UPDATE')).length).toBe(1);
  });

  it('already-deleted (or missing) row -> 404', async () => {
    const svc = new SoftDeleteService(makeDb({ onQuery: () => [] }) as any);
    await expect(svc.remove('campaign', 99, 1)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('system role -> 400 before any UPDATE', async () => {
    const db = makeDb({ onOne: (sql) => (sql.includes('is_system FROM role') ? { is_system: true } : null) });
    const svc = new SoftDeleteService(db as any);
    await expect(svc.remove('role', 1, 42)).rejects.toBeInstanceOf(BadRequestException);
    expect(db.calls.some((c) => c.sql.includes('UPDATE role'))).toBe(false);
  });

  it('custom role -> deletable', async () => {
    const db = makeDb({
      onOne: (sql) => (sql.includes('is_system FROM role') ? { is_system: false } : null),
      onQuery: (sql) => (sql.includes('UPDATE role') ? [{ id: '20', name: 'Campus Lead' }] : []),
    });
    await expect(new SoftDeleteService(db as any).remove('role', 20, 42)).resolves.toMatchObject({ deleted: true });
  });

  it('self-delete -> 400', async () => {
    const svc = new SoftDeleteService(makeDb({}) as any);
    await expect(svc.remove('user', 42, 42)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('the Super Admin user -> 400', async () => {
    const db = makeDb({ onOne: (sql) => (sql.includes("r.name = 'Super Admin'") ? { '?column?': 1 } : null) });
    const svc = new SoftDeleteService(db as any);
    await expect(svc.remove('user', 1, 42)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('unknown entity -> 400 (the organisation is not registered as deletable)', async () => {
    const svc = new SoftDeleteService(makeDb({}) as any);
    await expect(svc.remove('organisation', 1, 42)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('SoftDeleteService.impact', () => {
  it('aggregates counts + sample names per dependent and totals them', async () => {
    const counts: Record<string, number> = { vertical: 3, pipeline: 7, campaign: 12, source: 20, lead: 450, '"user"': 15, follow_up: 230, team: 4 };
    const db = makeDb({
      onOne: (sql) => {
        if (sql.includes('FROM branch WHERE id')) return { id: '3', name: 'Delhi', deleted_at: null };
        const hit = Object.keys(counts).find((t) => sql.includes(`FROM ${t} d`) || sql.includes(`FROM (SELECT DISTINCT u.id`) && t === '"user"');
        if (sql.startsWith('SELECT COUNT(*)')) {
          if (sql.includes('FROM vertical d')) return { n: 3 };
          if (sql.includes('FROM pipeline d')) return { n: 7 };
          if (sql.includes('FROM campaign d')) return { n: 12 };
          if (sql.includes('FROM source d')) return { n: 20 };
          if (sql.includes('FROM lead d')) return { n: 450 };
          if (sql.includes('SELECT DISTINCT u.id')) return { n: 15 };
          if (sql.includes('FROM follow_up d')) return { n: 230 };
          if (sql.includes('FROM team d')) return { n: 4 };
        }
        return hit ? { n: 0 } : null;
      },
      onQuery: () => [{ nm: 'Sample A' }, { nm: 'Sample B' }],
    });
    const rep = await new SoftDeleteService(db as any).impact('branch', 3);
    expect(rep.entity).toBe('branch');
    expect(rep.name).toBe('Delhi');
    expect(rep.deleted).toBe(false);
    const byKey = Object.fromEntries(rep.impact.map((e) => [e.key, e.count]));
    expect(byKey).toMatchObject({ verticals: 3, pipelines: 7, campaigns: 12, sources: 20, leads: 450, users: 15, follow_ups: 230, teams: 4 });
    expect(rep.total_associations).toBe(3 + 7 + 12 + 20 + 450 + 15 + 230 + 4);
    expect(rep.impact.find((e) => e.key === 'leads')!.sample).toEqual(['Sample A', 'Sample B']);
  });

  it('missing row -> 404', async () => {
    const svc = new SoftDeleteService(makeDb({}) as any);
    await expect(svc.impact('branch', 999)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('zero-count dependents skip the sample query', async () => {
    const db = makeDb({
      onOne: (sql) => (sql.includes('FROM follow_up WHERE id') ? { id: '9', name: '01 Jan 2026 10:00', deleted_at: null } : { n: 0 }),
      onQuery: () => { throw new Error('sample query must not run for zero counts'); },
    });
    const rep = await new SoftDeleteService(db as any).impact('follow_up', 9);
    expect(rep.total_associations).toBe(0);
  });
});

describe('SoftDeleteService.restore', () => {
  it('restores a deleted row (clears deleted_at/by)', async () => {
    const db = makeDb({
      onOne: (sql) => {
        if (sql.includes('SELECT deleted_at FROM vertical')) return { deleted_at: '2026-07-14' };
        if (sql.includes('JOIN branch p')) return { name: 'Delhi', deleted: false };
        return null;
      },
      onQuery: (sql) => (sql.includes('UPDATE vertical SET deleted_at = NULL') ? [{ id: '5', name: 'TLA' }] : []),
    });
    const res = await new SoftDeleteService(db as any).restore('vertical', 5);
    expect(res).toMatchObject({ ok: true, restored: true, id: 5, name: 'TLA' });
  });

  it('409 while an ancestor in the path is itself deleted (restore parent first)', async () => {
    const db = makeDb({
      onOne: (sql) => {
        if (sql.includes('SELECT deleted_at FROM vertical')) return { deleted_at: '2026-07-14' };
        if (sql.includes('JOIN branch p')) return { name: 'Delhi', deleted: true };
        return null;
      },
    });
    const err = await new SoftDeleteService(db as any).restore('vertical', 5).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toMatch(/branch "Delhi" is deleted/i);
  });

  it('restoring a row that is not deleted -> 404', async () => {
    const db = makeDb({ onOne: () => ({ deleted_at: null }) });
    await expect(new SoftDeleteService(db as any).restore('branch', 3)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deleted-lead restore checks the whole 5-level path', async () => {
    const seen: string[] = [];
    const db = makeDb({
      onOne: (sql) => {
        if (sql.includes('SELECT deleted_at FROM lead')) return { deleted_at: '2026-07-14' };
        if (sql.includes('JOIN')) { seen.push(sql); return { name: 'X', deleted: false }; }
        return null;
      },
      onQuery: (sql) => (sql.includes('UPDATE lead SET deleted_at = NULL') ? [{ id: '77', name: 'Asha' }] : []),
    });
    await new SoftDeleteService(db as any).restore('lead', 77);
    expect(seen).toHaveLength(5); // branch, vertical, pipeline, campaign, source
  });
});

describe('SoftDeleteService.deletedItems / entities', () => {
  it('entities() lists every registry entry for the Deleted Items tabs', () => {
    const list = new SoftDeleteService(makeDb({}) as any).entities();
    const keys = list.map((e) => e.key);
    expect(keys).toEqual(expect.arrayContaining(['branch', 'lead', 'user', 'role', 'master:course']));
  });

  it('deletedItems lists only deleted rows, newest first, with deleted_by name', async () => {
    const db = makeDb({ onQuery: () => [{ id: '3', name: 'Delhi', deleted_at: 't', deleted_by: '42', deleted_by_name: 'Admin' }] });
    const res = await new SoftDeleteService(db as any).deletedItems('branch');
    expect(res.entity).toBe('branch');
    expect(res.rows).toHaveLength(1);
    const q = db.calls.find((c) => c.sql.includes('FROM branch t'))!;
    expect(q.sql).toContain('deleted_at IS NOT NULL');
    expect(q.sql).toContain('ORDER BY t.deleted_at DESC');
  });
});
