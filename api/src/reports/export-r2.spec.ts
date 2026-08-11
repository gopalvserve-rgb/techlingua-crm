import { ExportService } from './export.service';

/**
 * Report exports are stored in R2 (docs/dev/57), not as a DB blob. This locks the READ path:
 * when a report_export row carries an r2_key, download() fetches the bytes from R2 (mocked).
 */
describe('ExportService — R2-backed download', () => {
  it('fetches export bytes from R2 when r2_key is set (no bytea in the row)', async () => {
    const db: any = {
      one: async () => ({ id: 5, status: 'ready', format: 'xlsx', file_name: 'r.xlsx', bytes: null, r2_key: 'exports/5-r.xlsx' }),
    };
    const gets: string[] = [];
    const storage: any = { getObject: async (k: string) => { gets.push(k); return { body: Buffer.from('R2-XLSX'), contentType: 'x' }; } };
    const svc = new ExportService(db, {} as any, storage);
    const out = await svc.download(5, { id: 1 } as any);
    expect(gets).toEqual(['exports/5-r.xlsx']);
    expect(out.buffer.toString()).toBe('R2-XLSX');
    expect(out.filename).toBe('r.xlsx');
  });
});
