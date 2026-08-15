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

  // Course descriptors (client feedback #12, Aug 2026) — Course / Status / Type / Delivery filters.
  it('courseTypes + deliveryModes -> meta->>key IN (...)', async () => {
    const { svc, calls } = build();
    await svc.list('course', false, { courseTypes: ['Diploma', 'Certificate'], deliveryModes: ['Online'] });
    const c = calls[0]; const sql = c.sql.replace(/\s+/g, ' ');
    expect(sql).toContain("m.meta->>'course_type' IN (");
    expect(sql).toContain("m.meta->>'delivery_mode' IN (");
    expect(c.params).toEqual(expect.arrayContaining(['Diploma', 'Certificate', 'Online']));
  });

  it('courseIds -> m.id IN (...) with numeric params', async () => {
    const { svc, calls } = build();
    await svc.list('course', false, { courseIds: ['7', '9', 'bad', '0'] });
    const c = calls[0]; const sql = c.sql.replace(/\s+/g, ' ');
    expect(sql).toContain('m.id IN (');
    expect(c.params).toEqual(expect.arrayContaining([7, 9]));
    expect(c.params).not.toContain(0);        // 0 / non-numeric dropped
  });

  it('status: only-active vs only-inactive vs both', async () => {
    const active = build(); await active.svc.list('course', false, { statuses: ['active'] });
    expect(active.calls[0].sql.replace(/\s+/g, ' ')).toContain('m.is_active');
    const inactive = build(); await inactive.svc.list('course', false, { statuses: ['inactive'] });
    expect(inactive.calls[0].sql.replace(/\s+/g, ' ')).toContain('m.is_active = FALSE');
    const both = build(); await both.svc.list('course', false, { statuses: ['active', 'inactive'] });
    // both selected -> no is_active predicate at all (show all)
    expect(both.calls[0].sql.replace(/\s+/g, ' ')).not.toContain('m.is_active');
  });

  it('create() serialises the four course descriptors into the INSERT meta', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return sql.includes('organisation') ? [{ id: '1' }] : [{ id: 1 }]; },
      one: async () => ({ id: '1' }),
    } as unknown as DatabaseService;
    const svc = new MastersService(db);
    await svc.create('course', { name: 'ZZ', code: 'ZZ', meta: { level: 'A2', course_type: 'Diploma', delivery_mode: 'Online', description: 'hi' } }, 1);
    const ins = calls.find((c) => c.sql.includes('INSERT INTO'))!;
    const metaJson = ins.params.find((x) => typeof x === 'string' && x.includes('delivery_mode')) as string;
    const meta = JSON.parse(metaJson);
    expect(meta).toMatchObject({ level: 'A2', course_type: 'Diploma', delivery_mode: 'Online', description: 'hi' });
  });
});
