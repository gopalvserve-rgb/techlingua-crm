import { DocTemplateService } from './doc-template.service';

/** A tiny in-memory fake of DatabaseService for the document_template table. */
function fakeDb(seed: Record<string, any> = {}) {
  const rows: any[] = Object.entries(seed).map(([type, settings], i) => ({
    id: i + 1, org_id: 1, type, name: type, settings, is_active: true, updated_at: '2026-08-28T00:00:00Z',
  }));
  return {
    rows,
    async one<T>(sql: string, params: any[] = []): Promise<T | null> {
      if (/FROM organisation/i.test(sql)) return { id: '1' } as any;
      if (/FROM document_template/i.test(sql)) {
        const type = params[1];
        return (rows.find((r) => r.type === type) ?? null) as any;
      }
      return null;
    },
    async query<T>(sql: string, params: any[] = []): Promise<T[]> {
      if (/INSERT INTO document_template/i.test(sql)) {
        const [, type, name, settings] = params;
        if (!rows.find((r) => r.type === type)) rows.push({ id: rows.length + 1, org_id: 1, type, name, settings: JSON.parse(settings), is_active: true, updated_at: '2026-08-28T00:00:00Z' });
        return [] as any;
      }
      if (/UPDATE document_template/i.test(sql)) {
        const type = params[1];
        const r = rows.find((x) => x.type === type);
        if (!r) return [] as any;
        if (params[3] != null) r.settings = JSON.parse(params[3]);
        return [r] as any;
      }
      if (/FROM document_template/i.test(sql)) return rows as any;
      return [] as any;
    },
  };
}

describe('DocTemplateService (dev/143 item 5)', () => {
  it('list() seeds all 7 default templates and returns them in canonical order', async () => {
    const db = fakeDb();
    const svc = new DocTemplateService(db as any);
    const out = await svc.list();
    expect(out.map((r: any) => r.type)).toEqual([
      'fee_invoice', 'fee_receipt', 'student_id', 'employee_id', 'quotation', 'certificate', 'marksheet',
    ]);
  });

  it('update() writes the settings JSON and get() reads it back', async () => {
    const db = fakeDb();
    const svc = new DocTemplateService(db as any);
    await svc.update('fee_receipt', { settings: { header_title: 'Payment Receipt', show_logo: false, footer_text: 'Ta' } }, 9);
    const r = await svc.get('fee_receipt');
    expect(r.settings.header_title).toBe('Payment Receipt');
    expect(r.settings.show_logo).toBe(false);
  });

  it('overridesFor() maps stored settings to the generator override shape (never throws)', async () => {
    const db = fakeDb({ fee_invoice: { header_title: 'Tax Bill', show_logo: true, footer_text: 'F', terms: 'T' } });
    const svc = new DocTemplateService(db as any);
    const ov = await svc.overridesFor('fee_invoice');
    expect(ov).toMatchObject({ header_title: 'Tax Bill', show_logo: true, footer_text: 'F', terms: 'T' });
  });

  it('overridesFor() returns {} on any DB error (generator falls back to defaults)', async () => {
    const svc = new DocTemplateService({ one: async () => { throw new Error('db down'); } } as any);
    await expect(svc.overridesFor('student_id')).resolves.toEqual({});
  });

  it('rejects an unknown template type', async () => {
    const svc = new DocTemplateService(fakeDb() as any);
    await expect(svc.get('nope')).rejects.toThrow(/Unknown template type/);
  });
});
