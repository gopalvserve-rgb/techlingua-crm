import { MASTER_TYPES, MastersService } from './masters.service';
import { DatabaseService } from '../database/database.service';

/**
 * dev/139 — the NEW self-manageable Call Disposition master (m_call_disposition), distinct
 * from the older generic `disposition`. It must be registered so /api/masters/call_disposition
 * CRUD works and it auto-appears in the Masters admin list.
 */
describe('call_disposition master (dev/139)', () => {
  it('is registered and mapped to the m_call_disposition table', () => {
    expect(MASTER_TYPES.call_disposition).toBeDefined();
    expect(MASTER_TYPES.call_disposition.table).toBe('m_call_disposition');
    expect(MASTER_TYPES.call_disposition.label).toBe('Call Dispositions');
  });

  it('is exposed by types() so the Masters admin auto-lists it', () => {
    const svc = new MastersService({} as unknown as DatabaseService);
    expect(svc.types().some((t) => t.type === 'call_disposition')).toBe(true);
  });

  it('list() queries the m_call_disposition table', async () => {
    let sql = '';
    const db = { query: async (s: string) => { sql = s; return []; } } as unknown as DatabaseService;
    await new MastersService(db).list('call_disposition');
    expect(sql).toMatch(/FROM m_call_disposition/);
  });

  it('create() inserts into m_call_disposition', async () => {
    const seen: string[] = [];
    const db = {
      one: async () => ({ id: '1' }),
      query: async (s: string) => { seen.push(s); return [{ id: 1, name: 'Connected' }]; },
    } as unknown as DatabaseService;
    await new MastersService(db).create('call_disposition', { name: 'Connected' }, 1);
    expect(seen.some((s) => /INSERT INTO m_call_disposition/.test(s))).toBe(true);
  });
});
