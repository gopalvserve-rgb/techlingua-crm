import * as fs from 'fs';
import * as path from 'path';
import { MastersService, MASTER_TYPES } from './masters.service';
import { DatabaseService } from '../database/database.service';

/**
 * dev/131 (task #213 item 4) — Campaign Type is now a self-manageable generic master
 * (m_campaign_type). These tests pin: it's registered in the shared framework, POST create ->
 * list round-trips through m_campaign_type, and migration 100 seeds the 5 original values.
 */
function fakeDb() {
  const store: Record<string, any[]> = {};
  let seq = 1;
  const db = {
    one: async () => ({ id: '1' }),
    query: async (sql: string, params: unknown[] = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      const mIns = s.match(/INSERT INTO (\w+)/);
      if (mIns) {
        const row = { id: seq++, name: params[1], code: params[2], sort_order: params[3] ?? 0, is_active: true, meta: {} };
        (store[mIns[1]] ||= []).push(row);
        return [row];
      }
      const mSel = s.match(/FROM (\w+) m/);
      if (mSel) return store[mSel[1]] ?? [];
      if (s.includes('organisation')) return [{ id: '1' }];
      return [];
    },
  } as unknown as DatabaseService;
  return { db };
}

describe('Campaign Type master (dev/131)', () => {
  it('is registered in the shared masters framework -> m_campaign_type', () => {
    expect(MASTER_TYPES.campaign_type).toBeDefined();
    expect(MASTER_TYPES.campaign_type.table).toBe('m_campaign_type');
    const svc = new MastersService(fakeDb().db);
    expect(svc.types().some((t) => t.type === 'campaign_type' && t.label === 'Campaign Types')).toBe(true);
  });

  it('POST create then list round-trips through m_campaign_type', async () => {
    const svc = new MastersService(fakeDb().db);
    const created = await svc.create('campaign_type', { name: 'ZZTEST Webinar', code: 'ZZWEB' }, 1);
    expect(created.name).toBe('ZZTEST Webinar');
    const list = await svc.list('campaign_type', false);
    expect(list.map((r: any) => r.name)).toContain('ZZTEST Webinar');
  });

  it('migration 100 creates the table and seeds the 5 original values', () => {
    const sql = fs.readFileSync(path.resolve(__dirname, '../../db/migrations/100_campaign_type_master.sql'), 'utf8');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS m_campaign_type');
    for (const v of ['Digital', 'Print', 'Event', 'Referral Drive', 'Tele-calling']) expect(sql).toContain(`'${v}'`);
  });
});
