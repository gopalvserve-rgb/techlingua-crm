import { MastersService } from './masters.service';
import { DatabaseService } from '../database/database.service';

/**
 * Course master list filters (client, Aug 2026): Branch/Vertical (via meta jsonb, multi-select
 * IN) + name/code search. Harmless for other master types (they carry no meta.branch_id).
 */
function build() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return []; },
  } as unknown as DatabaseService;
  return { svc: new MastersService(db), calls };
}

describe('masters list — Course Branch/Vertical/search filters', () => {
  it('branchIds + verticalIds -> meta->>key IN (...), name search -> ILIKE', async () => {
    const { svc, calls } = build();
    await svc.list('course', false, { branchIds: ['9', '10'], verticalIds: ['1'], q: 'java' });
    const c = calls[0]; const sql = c.sql.replace(/\s+/g, ' ');
    expect(sql).toContain("m.meta->>'branch_id' IN (");
    expect(sql).toContain("m.meta->>'vertical_id' IN (");
    expect(sql).toContain('m.name ILIKE');
    expect(c.params).toEqual(expect.arrayContaining(['%java%', '9', '10', '1']));
  });

  it('no filters -> just the deleted/active guard (back-compat)', async () => {
    const { svc, calls } = build();
    await svc.list('course', false);
    const sql = calls[0].sql.replace(/\s+/g, ' ');
    expect(sql).toContain('m.deleted_at IS NULL AND m.is_active');
    expect(sql).not.toContain("meta->>'branch_id'");
  });
});
