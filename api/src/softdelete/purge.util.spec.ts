import { ConflictException, NotFoundException } from '@nestjs/common';
import { PurgeRunner } from './purge.util';
import { SoftDeleteService } from './softdelete.service';

/**
 * Permanent delete (client, Oct 2026): "if any data is linked with these, delete them all".
 * A tiny in-memory schema stands in for Postgres: tables, rows and the FK catalog.
 *   branch <- vertical.branch_id <- campaign.vertical_id <- lead.campaign_id
 *   branch <- user_assignment.branch_id (no id col), api_key.default_branch_id (detach),
 *   campaign <- campaign_manager.campaign_id (CASCADE — left to the DB)
 */
type Rows = Record<string, Array<Record<string, any>>>;
const FKS: Record<string, Array<{ tbl: string; col: string; rule: string; notnull: boolean; has_id: boolean }>> = {
  branch: [
    { tbl: 'api_key', col: 'default_branch_id', rule: 'a', notnull: false, has_id: true },
    { tbl: 'user_assignment', col: 'branch_id', rule: 'a', notnull: false, has_id: false },
    { tbl: 'vertical', col: 'branch_id', rule: 'a', notnull: true, has_id: true },
  ],
  vertical: [{ tbl: 'campaign', col: 'vertical_id', rule: 'a', notnull: true, has_id: true }],
  campaign: [
    { tbl: 'campaign_manager', col: 'campaign_id', rule: 'c', notnull: true, has_id: false },
    { tbl: 'lead', col: 'campaign_id', rule: 'a', notnull: true, has_id: true },
  ],
  lead: [], api_key: [], user_assignment: [],
};

function fakeClient(rows: Rows) {
  const issued: string[] = [];
  const client = {
    issued,
    query: async (sql: string, p: unknown[] = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      issued.push(s);
      if (s.includes('FROM pg_constraint')) return { rows: FKS[String(p[0])] ?? [] };
      let m = /^SELECT count\(\*\)::int AS n FROM (\w+) WHERE "(\w+)" = \$1/.exec(s);
      if (m) return { rows: [{ n: (rows[m[1]] ?? []).filter((r) => r[m![2]] === p[0]).length }] };
      m = /^SELECT id FROM (\w+) WHERE "(\w+)" = \$1/.exec(s);
      if (m) return { rows: (rows[m[1]] ?? []).filter((r) => r[m![2]] === p[0]).map((r) => ({ id: r.id })) };
      m = /^UPDATE (\w+) SET "(\w+)" = NULL WHERE "\w+" = \$1/.exec(s);
      if (m) { (rows[m[1]] ?? []).forEach((r) => { if (r[m![2]] === p[0]) r[m![2]] = null; }); return { rows: [] }; }
      m = /^DELETE FROM (\w+) WHERE "(\w+)" = \$1/.exec(s);
      if (m) { rows[m[1]] = (rows[m[1]] ?? []).filter((r) => r[m![2]] !== p[0]); return { rows: [] }; }
      m = /^DELETE FROM (\w+) WHERE id = \$1/.exec(s);
      if (m) { rows[m[1]] = (rows[m[1]] ?? []).filter((r) => r.id !== p[0]); return { rows: [] }; }
      return { rows: [] };
    },
  };
  return client;
}

const seed = (): Rows => ({
  branch: [{ id: 1, name: 'Delhi', deleted_at: '2026-10-01' }],
  vertical: [{ id: 10, branch_id: 1, name: 'BCL', deleted_at: null }, { id: 11, branch_id: 1, name: 'IT', deleted_at: '2026-10-01' }],
  campaign: [{ id: 100, vertical_id: 10, name: 'Web' }],
  lead: [{ id: 1000, campaign_id: 100 }, { id: 1001, campaign_id: 100 }],
  user_assignment: [{ branch_id: 1 }, { branch_id: 2 }],
  api_key: [{ id: 5, default_branch_id: 1 }],
});

describe('PurgeRunner — permanent delete removes everything linked', () => {
  it('walks branch -> verticals (live AND deleted) -> campaigns -> leads, then link rows, then the branch', async () => {
    const rows = seed();
    const c = fakeClient(rows);
    const r = new PurgeRunner(c);
    await r.purge('branch', 1);
    expect(rows.branch).toEqual([]);
    expect(rows.vertical).toEqual([]);            // the live one too — client rule
    expect(rows.campaign).toEqual([]);
    expect(rows.lead).toEqual([]);
    expect(rows.user_assignment).toEqual([{ branch_id: 2 }]);   // only this branch's access rows
    expect(rows.api_key).toEqual([{ id: 5, default_branch_id: null }]);   // detached, not deleted
    expect(r.removedSummary()).toBe('1 user assignment, 2 lead, 1 campaign, 2 vertical');
  });

  it('leaves ON DELETE CASCADE links to the database (no explicit delete of campaign_manager)', async () => {
    const rows = seed();
    const c = fakeClient(rows);
    await new PurgeRunner(c).purge('campaign', 100);
    expect(c.issued.some((s) => s.includes('campaign_manager'))).toBe(false);
    expect(rows.lead).toEqual([]);
  });
});

describe('SoftDeleteService.purge / purgePreview', () => {
  const svcWith = (row: any, rows = seed()) => {
    const c = fakeClient(rows);
    const db = {
      one: jest.fn(async () => row),
      query: jest.fn(async () => []),
      tx: jest.fn(async (fn: any) => fn(c)),
    };
    return { svc: new SoftDeleteService(db as any, {} as any), db, rows };
  };

  it('only an item already in Deleted Items can be purged (live row -> 404)', async () => {
    const { svc, db } = svcWith({ id: '1', name: 'Delhi', deleted_at: null });
    await expect(svc.purge('branch', 1, 9)).rejects.toBeInstanceOf(NotFoundException);
    expect(db.tx).not.toHaveBeenCalled();
  });

  it('purge removes the item + everything linked and reports it; audited', async () => {
    const { svc, db, rows } = svcWith({ id: '1', name: 'Delhi', deleted_at: '2026-10-01' });
    const out = await svc.purge('branch', 1, 9);
    expect(out).toMatchObject({ purged: true, name: 'Delhi' });
    expect(out.also_removed).toMatch(/2 vertical/);
    expect(rows.branch).toEqual([]);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO audit_log'), expect.any(Array));
  });

  it('preview reports the same list but changes nothing (rolled back)', async () => {
    const { svc } = svcWith({ id: '1', name: 'Delhi', deleted_at: '2026-10-01' });
    const out = await svc.purgePreview('branch', 1);
    expect(out.also_removed).toBe('1 user assignment, 2 lead, 1 campaign, 2 vertical');
    expect(out.blocked).toBeNull();
  });

  it('a leftover FK error from the database still becomes a clear 409', async () => {
    const fk = Object.assign(new Error('fk'), { code: '23503', detail: 'Key (id)=(1) is still referenced from table "walk_in".' });
    const db = { one: jest.fn(async () => ({ id: '1', name: 'Delhi', deleted_at: '2026-10-01' })), query: jest.fn(async () => []), tx: jest.fn(async () => { throw fk; }) };
    const err = await new SoftDeleteService(db as any, {} as any).purge('branch', 1, 9).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toMatch(/"walk in" records/);
  });
});
