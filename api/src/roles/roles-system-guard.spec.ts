import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RolesService } from './roles.service';

/**
 * OBS-01 (backlog #17): system-role permission matrices are locked at the API
 * level — PUT /roles/:id/permissions on a system role must 400 even though the
 * UI hides the editor. Custom roles keep working.
 */

function makeDb(role: { id: string; is_system: boolean } | null) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const clientQuery = jest.fn(async (sql: string, p: unknown[] = []) => {
    calls.push({ sql, params: p });
    if (sql.includes('FROM permission WHERE key')) return { rowCount: 1, rows: [{ id: 101 }] };
    return { rowCount: 0, rows: [] };
  });
  return {
    calls,
    one: jest.fn(async (sql: string, p: unknown[] = []) => { calls.push({ sql, params: p }); return sql.includes('FROM role') ? role : null; }),
    query: jest.fn(async (sql: string, p: unknown[] = []) => { calls.push({ sql, params: p }); return []; }),
    tx: jest.fn(async (fn: (c: { query: typeof clientQuery }) => Promise<unknown>) => fn({ query: clientQuery })),
  };
}

describe('RolesService.setMatrix — system-role lock (OBS-01)', () => {
  const ENTRIES = [{ permission_key: 'lead.read', record_scope: 'all' as const }];

  it('system role -> 400, matrix untouched', async () => {
    const db = makeDb({ id: '1', is_system: true });
    const svc = new RolesService(db as any);
    const err = await svc.setMatrix(1, ENTRIES).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toMatch(/System role .* locked/i);
    expect(db.tx).not.toHaveBeenCalled(); // no DELETE/INSERT ever ran
  });

  it('custom role -> matrix replaced atomically', async () => {
    const db = makeDb({ id: '20', is_system: false });
    const svc = new RolesService(db as any);
    await expect(svc.setMatrix(20, ENTRIES)).resolves.toEqual({ role_id: 20, granted: 1 });
    expect(db.tx).toHaveBeenCalled();
  });

  it('deleted / unknown role -> 404', async () => {
    const svc = new RolesService(makeDb(null) as any);
    await expect(svc.setMatrix(9, ENTRIES)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('non-array entries -> 400', async () => {
    const svc = new RolesService(makeDb({ id: '20', is_system: false }) as any);
    await expect(svc.setMatrix(20, 'nope' as any)).rejects.toBeInstanceOf(BadRequestException);
  });
});
