import { CustomFieldsService, slugKey } from './custom-fields.service';
import { DatabaseService } from '../database/database.service';

/**
 * Custom-field DEFINITIONS (client, Aug 2026). The service turns admin input into rows in
 * custom_field_def; those definitions then drive the lead Add/Edit form and persist values into
 * lead.custom_fields. Here we prove the SQL/mapping with a stubbed DatabaseService.
 */
function build(rows: Record<string, unknown>[] = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return rows; },
    one: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/FROM organisation/i.test(sql)) return { id: '1' };
      if (/SELECT id FROM custom_field_def WHERE org_id/i.test(sql)) return null; // no dup
      if (/INSERT INTO custom_field_def/i.test(sql)) return { id: 5, field_key: (params as any[])[2], label: (params as any[])[3] };
      if (/UPDATE custom_field_def/i.test(sql)) return { id: (params as any[])[params.length - 1] };
      if (/SELECT id FROM custom_field_def WHERE id/i.test(sql)) return { id: (params as any[])[0] };
      return null;
    },
  } as unknown as DatabaseService;
  return { svc: new CustomFieldsService(db), calls };
}

describe('slugKey', () => {
  it('lower snake_cases and strips punctuation', () => {
    expect(slugKey('Preferred Batch!')).toBe('preferred_batch');
    expect(slugKey('  Fee / Due Date ')).toBe('fee_due_date');
  });
});

describe('CustomFieldsService', () => {
  it('list — active lead defs only, ordered', async () => {
    const { svc, calls } = build();
    await svc.list('lead', false);
    const sql = calls[0].sql.replace(/\s+/g, ' ');
    expect(sql).toContain("entity = $1 AND deleted_at IS NULL AND is_active");
    expect(sql).toContain('ORDER BY sort_order ASC, id ASC');
    expect(calls[0].params).toEqual(['lead']);
  });

  it('list all=true — includes inactive', async () => {
    const { svc, calls } = build();
    await svc.list('lead', true);
    expect(calls[0].sql.replace(/\s+/g, ' ')).toContain('deleted_at IS NULL ORDER BY');
  });

  it('create — derives field_key from label, persists options for select', async () => {
    const { svc, calls } = build();
    await svc.create({ label: 'Preferred Batch', data_type: 'select', options: ['Morning', 'Evening'], required: true }, 42);
    const insert = calls.find((c) => /INSERT INTO custom_field_def/i.test(c.sql))!;
    const p = insert.params as any[];
    expect(p[2]).toBe('preferred_batch');       // field_key slug
    expect(p[3]).toBe('Preferred Batch');        // label
    expect(p[4]).toBe('select');                 // data_type
    expect(JSON.parse(p[5])).toEqual(['Morning', 'Evening']); // options JSON
    expect(p[6]).toBe(true);                     // required
    expect(p[10]).toBe(42);                      // created_by
  });

  it('create — rejects an invalid data_type', async () => {
    const { svc } = build();
    await expect(svc.create({ label: 'X', data_type: 'money' }, 1)).rejects.toThrow(/invalid data_type/);
  });

  it('update — builds a dynamic SET and bumps updated_at', async () => {
    const { svc, calls } = build();
    await svc.update(5, { label: 'New Label', required: false });
    const upd = calls.find((c) => /UPDATE custom_field_def SET/i.test(c.sql))!;
    expect(upd.sql).toContain('label = $1');
    expect(upd.sql).toContain('required = $2');
    expect(upd.sql).toContain('updated_at = now()');
  });

  it('remove — soft-deletes (is_active FALSE + deleted_at)', async () => {
    const { svc, calls } = build();
    const res = await svc.remove(5);
    expect(res).toEqual({ deleted: true, id: 5 });
    const del = calls.find((c) => /UPDATE custom_field_def SET is_active = FALSE, deleted_at = now\(\)/i.test(c.sql));
    expect(del).toBeTruthy();
  });
});
