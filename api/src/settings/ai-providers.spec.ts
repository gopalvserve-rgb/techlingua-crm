import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { ChannelConfigService } from '../messaging/channel-config.service';
import { isMultiProvider, MULTI_PROVIDER_CHANNELS } from '../messaging/providers';

/**
 * DEF-S5-04 — SAVING GEMINI SILENTLY DISCARDED THE DEEPSEEK KEY.
 *
 * `channel_config` was one row per (channel, vertical); DeepSeek and Gemini both live on
 * `channel='ai'`, so the second save UPDATED the first row in place (live: both returned
 * `id: 17`). PROJECT_STATUS §4.8 promises "DeepSeek **and/or** Gemini". It was strictly OR.
 */

/** A db double that behaves like the real unique key: one row per (channel, provider?, vertical). */
function fakeStore() {
  const rows: any[] = [];
  let seq = 16;
  const db = {
    one: async (sql: string, p: unknown[]) => {
      if (/FROM organisation/.test(sql)) return { id: 1 };
      if (/SELECT \* FROM channel_config/.test(sql)) {
        const [, channel, verticalId, provider] = p as any[];
        return rows.find((r) => r.channel === channel
          && (r.vertical_id ?? -1) === (verticalId ?? -1)
          && (provider == null || r.provider === provider)) ?? null;
      }
      if (/UPDATE channel_config/.test(sql)) {
        const r = rows.find((x) => x.id === (p as any[])[0])!;
        Object.assign(r, { provider: (p as any[])[1], config: JSON.parse((p as any[])[2]), secrets: JSON.parse((p as any[])[3]) });
        return r;
      }
      if (/INSERT INTO channel_config/.test(sql)) {
        const a = p as any[];
        const r = { id: ++seq, org_id: 1, channel: a[1], provider: a[2], vertical_id: a[3],
          config: JSON.parse(a[4]), secrets: JSON.parse(a[5]), is_active: true };
        rows.push(r); return r;
      }
      if (/SELECT c\.\*/.test(sql)) return rows.find((r) => r.id === (p as any[])[0]) ?? null;
      return null;
    },
    // `list()` reads through query() — the same rows, so the spec sees what the screen sees.
    query: async (sql: string) => (/FROM channel_config c/.test(sql) ? rows : []),
  };
  return { svc: new ChannelConfigService(db as never), rows };
}

const KEY = (provider: string, api_key: string) => ({ provider, config: {}, secrets: { api_key } });

describe('DeepSeek and Gemini are INDEPENDENT credentials', () => {
  it('saving Gemini does not touch the DeepSeek row — two rows, two ids', async () => {
    const { svc, rows } = fakeStore();
    const ds = await svc.save(KEY('deepseek', 'sk-canary-DEEPSEEK1'), 1);
    const gm = await svc.save(KEY('gemini', 'AIza-canary-GEMINI2'), 1);

    expect(rows).toHaveLength(2);                 // was 1 — Gemini overwrote DeepSeek
    expect(ds.id).not.toBe(gm.id);                // live, both were id 17
    expect(rows.map((r) => r.provider).sort()).toEqual(['deepseek', 'gemini']);
  });

  it('the DeepSeek key SURVIVES a Gemini save — the actual data loss', async () => {
    const { svc } = fakeStore();
    await svc.save(KEY('deepseek', 'sk-canary-DEEPSEEK1'), 1);
    await svc.save(KEY('gemini', 'AIza-canary-GEMINI2'), 1);

    const list = await svc.list();
    const deepseek = list.find((r: any) => r.provider === 'deepseek');
    const gemini = list.find((r: any) => r.provider === 'gemini');
    expect(deepseek).toBeTruthy();
    expect(gemini).toBeTruthy();
    // both still set, and MASKED — never readable back
    // Masked, never readable back — and the two masks differ, which is the proof that two
    // DIFFERENT secrets are stored rather than one row wearing two labels.
    expect(deepseek.secrets_masked.api_key).toBe('••••••EEK1');
    expect(gemini.secrets_masked.api_key).toBe('••••••INI2');
    expect(deepseek.secrets_masked.api_key).not.toBe(gemini.secrets_masked.api_key);
    // and the plaintext is nowhere in the HTTP shape
    expect(JSON.stringify(list)).not.toContain('sk-canary-DEEPSEEK1');
    expect(JSON.stringify(list)).not.toContain('AIza-canary-GEMINI2');
  });

  it('re-saving DeepSeek updates DeepSeek, not Gemini — and adds no third row', async () => {
    const { svc, rows } = fakeStore();
    const first = await svc.save(KEY('deepseek', 'sk-one'), 1);
    await svc.save(KEY('gemini', 'AIza-two'), 1);
    const again = await svc.save(KEY('deepseek', 'sk-three'), 1);
    expect(again.id).toBe(first.id);
    expect(rows).toHaveLength(2);
  });
});

describe('every OTHER channel still replaces its provider — one gateway, not two', () => {
  it('switching SMS from MSG91 to Twilio REPLACES the row (two live gateways is a bug)', async () => {
    const { svc, rows } = fakeStore();
    const a = await svc.save({ provider: 'msg91', config: { sender_id: 'TLINGA', route: '4' }, secrets: { authkey: 'k1' } }, 1);
    const b = await svc.save({ provider: 'twilio', config: { from: '+1555' }, secrets: { auth_token: 'k2', account_sid: 's' } }, 1);
    expect(rows).toHaveLength(1);
    expect(a.id).toBe(b.id);
    expect(rows[0].provider).toBe('twilio');
  });

  it('only `ai` is multi-provider — this list is the whole rule', () => {
    expect(MULTI_PROVIDER_CHANNELS).toEqual(['ai']);
    expect(isMultiProvider('ai')).toBe(true);
    for (const c of ['sms', 'email', 'whatsapp', 'payment', 'calendar', 'storage']) {
      expect(isMultiProvider(c)).toBe(false);
    }
  });
});

describe('the migration backs the code up — a unique index, not a convention', () => {
  const sql = readdirSync(join(__dirname, '..', '..', 'db', 'migrations'))
    .filter((f) => f.endsWith('.sql')).sort()
    .map((f) => readFileSync(join(__dirname, '..', '..', 'db', 'migrations', f), 'utf8')).join('\n');

  it('030 excludes `ai` from the one-row-per-channel index', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_config ON channel_config[\s\S]*?WHERE deleted_at IS NULL AND channel <> 'ai'/);
  });

  it('030 adds a provider-keyed index for `ai`', () => {
    expect(sql).toMatch(/uq_channel_config_ai[\s\S]*?\(org_id, channel, provider, COALESCE\(vertical_id, -1\)\)[\s\S]*?channel = 'ai'/);
  });

  it('the migration is idempotent — it can run on every boot', () => {
    const raw = readFileSync(join(__dirname, '..', '..', 'db', 'migrations', '030_def_s5_fixes.sql'), 'utf8');
    // STRIP THE COMMENTS FIRST — the header quotes migration 026's old index verbatim, and
    // a guard that reads a comment as code is a guard that lies.
    const m = raw.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
    expect(m).toMatch(/DROP INDEX IF EXISTS/);
    const creates = m.match(/CREATE UNIQUE INDEX[^\n]*/g) ?? [];
    expect(creates).toHaveLength(2);
    for (const create of creates) expect(create).toMatch(/IF NOT EXISTS/);
  });
});

describe('the AI test button probes the provider it was pressed on', () => {
  it('resolve() filters by provider when one is given', async () => {
    const seen: unknown[][] = [];
    const db = { one: async (_s: string, p: unknown[]) => { seen.push(p); return null; }, query: async () => [] };
    const svc = new ChannelConfigService(db as never);
    await svc.resolve('ai', null, 'gemini');
    expect(seen[0]).toEqual(['ai', null, 'gemini']);
  });

  it('resolve() with no provider is deterministic, not arbitrary', async () => {
    const sqls: string[] = [];
    const db = { one: async (s: string) => { sqls.push(s); return null; }, query: async () => [] };
    await new ChannelConfigService(db as never).resolve('ai', null);
    expect(sqls[0]).toMatch(/ORDER BY[\s\S]*updated_at DESC/);
  });
});
