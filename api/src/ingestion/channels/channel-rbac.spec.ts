import { NotFoundException } from '@nestjs/common';
import { ScopeEnforcerService } from '../../rbac/scope-enforcer.service';
import { ResolvedScope } from '../../rbac/rbac.types';
import { resetSecretKeyCache } from '../../common/crypto.util';
import { allScopeResolver } from '../fake-db.testkit';
import { ChannelService } from './channel.service';
import { makeChannel, makeChannelDb, passEnforcer } from './fake-channels.testkit';
import { DatabaseService } from '../../database/database.service';

const ALL: ResolvedScope = { allowed: true, all: true, filters: [] } as unknown as ResolvedScope;

/** A DB double for the ADMIN surface (create/update/present) — separate from the webhook one. */
function adminDb(rows: any[] = []) {
  const channels = [...rows];
  let seq = 10;
  const exec = async (sql: string, params: unknown[] = []): Promise<any[]> => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT org_id, branch_id, vertical_id, pipeline_id FROM campaign')) {
      return Number(params[0]) === 5 ? [{ org_id: 1, branch_id: 2, vertical_id: 3, pipeline_id: 4 }] : [];
    }
    if (s.startsWith('SELECT id FROM source WHERE id')) {
      return Number(params[1]) === 5 && Number(params[0]) === 7 ? [{ id: 7 }] : [];
    }
    if (s.startsWith('INSERT INTO capture_channel')) {
      const row = {
        id: ++seq, org_id: params[0], provider: params[1], name: params[2],
        branch_id: params[3], vertical_id: params[4], pipeline_id: params[5],
        campaign_id: params[6], source_id: params[7], public_key: params[8],
        config: JSON.parse(String(params[9])), secrets: JSON.parse(String(params[10])),
        is_active: params[11], next_poll_at: params[12], cursor: {}, deleted_at: null,
      };
      channels.push(row);
      return [row];
    }
    if (s.startsWith('UPDATE capture_channel SET name')) {
      const row = channels.find((c) => Number(c.id) === Number(params[0]));
      if (!row) return [];
      if (params[1]) row.name = params[1];
      row.config = JSON.parse(String(params[2]));
      row.secrets = JSON.parse(String(params[3]));
      if (params[4] !== null) row.is_active = params[4];
      return [row];
    }
    if (s.startsWith('SELECT * FROM capture_channel WHERE id')) {
      const hit = channels.find((c) => Number(c.id) === Number(params[0]) && !c.deleted_at);
      return hit ? [hit] : [];
    }
    if (s.startsWith('SELECT campaign_id FROM capture_channel')) {
      const hit = channels.find((c) => Number(c.id) === Number(params[0]) && !c.deleted_at);
      return hit ? [{ campaign_id: hit.campaign_id }] : [];
    }
    throw new Error(`unhandled SQL: ${s.slice(0, 60)}`);
  };
  const db = {
    query: exec,
    one: async (sql: string, p: unknown[] = []) => (await exec(sql, p))[0] ?? null,
  } as unknown as DatabaseService;
  return { db, channels };
}

/** A scoped admin whose scope does NOT contain campaign 5 (the enforcer 404s). */
const denyEnforcer = {
  assertRefInScope: async (_s: unknown, kind: string) => {
    throw new NotFoundException(`${kind} not found`);
  },
} as unknown as ScopeEnforcerService;

describe('Channel admin — RBAC + secret handling', () => {
  beforeEach(() => { process.env.SECRETS_KEY = 'unit-test-key'; resetSecretKeyCache(); });
  afterEach(() => { delete process.env.SECRETS_KEY; resetSecretKeyCache(); });

  it('RBAC: a channel targeting an OUT-OF-SCOPE campaign 404s and nothing is written', async () => {
    const { db, channels } = adminDb();
    const svc = new ChannelService(db, denyEnforcer, allScopeResolver);
    await expect(svc.create(
      { provider: 'meta', name: 'X', campaign_id: 5, source_id: 7 }, ALL, 1,
    )).rejects.toBeInstanceOf(NotFoundException);
    expect(channels).toHaveLength(0);
  });

  it('a source that does not belong to the campaign is refused', async () => {
    const { db } = adminDb();
    const svc = new ChannelService(db, passEnforcer, allScopeResolver);
    await expect(svc.create(
      { provider: 'meta', name: 'X', campaign_id: 5, source_id: 99 }, ALL, 1,
    )).rejects.toThrow(/does not belong to the chosen campaign/);
  });

  it('an unknown provider is refused (the registry is the allow-list)', async () => {
    const { db } = adminDb();
    const svc = new ChannelService(db, passEnforcer, allScopeResolver);
    await expect(svc.create(
      { provider: 'justdial', name: 'X', campaign_id: 5, source_id: 7 }, ALL, 1,
    )).rejects.toThrow(/Unknown channel provider/);
  });

  it('SECRETS: are encrypted at rest and NEVER returned in plaintext', async () => {
    const { db, channels } = adminDb();
    const svc = new ChannelService(db, passEnforcer, allScopeResolver);
    const out = await svc.create({
      provider: 'meta', name: 'Meta Jul', campaign_id: 5, source_id: 7,
      secrets: { app_secret: 'THE-APP-SECRET', page_access_token: 'THE-PAGE-TOKEN' },
    }, ALL, 1);

    // stored: ciphertext only
    const stored = JSON.stringify(channels[0].secrets);
    expect(stored).not.toContain('THE-APP-SECRET');
    expect(stored).not.toContain('THE-PAGE-TOKEN');
    expect(channels[0].secrets.app_secret).toMatch(/^enc:v1:/);

    // returned: masked only
    const asJson = JSON.stringify(out);
    expect(asJson).not.toContain('THE-APP-SECRET');
    expect(asJson).not.toContain('THE-PAGE-TOKEN');
    expect(out.secrets_masked.app_secret).toBe('••••••CRET');
    expect(out.verify_token).toBeUndefined();          // list/read NEVER reveals
  });

  it('the Meta verify token is auto-generated and only readable on the credentials endpoint', async () => {
    const { db } = adminDb();
    const svc = new ChannelService(db, passEnforcer, allScopeResolver);
    const created = await svc.create({
      provider: 'meta', name: 'Meta Jul', campaign_id: 5, source_id: 7,
      secrets: { app_secret: 'S', page_access_token: 'T' },
    }, ALL, 1);
    expect(created.verify_token).toBeUndefined();

    const creds = await svc.credentials(created.id, ALL, 1);
    expect(creds.verify_token).toMatch(/^[A-Za-z0-9_-]{20,}$/);   // generated, unguessable
  });

  it('a blank secret on update means "leave it alone" — a credential is never wiped by accident', async () => {
    const { db, channels } = adminDb();
    const svc = new ChannelService(db, passEnforcer, allScopeResolver);
    const created = await svc.create({
      provider: 'meta', name: 'M', campaign_id: 5, source_id: 7,
      secrets: { app_secret: 'ORIGINAL', page_access_token: 'T' },
    }, ALL, 1);
    const before = channels[0].secrets.app_secret;

    // the admin re-opens the form (which shows a mask) and saves without retyping
    await svc.update(created.id, { name: 'M2', secrets: { app_secret: '', page_access_token: '••••••XXXX' } }, ALL, 1);

    expect(channels[0].secrets.app_secret).toBe(before);
    expect(channels[0].name).toBe('M2');
  });

  it('a channel is "not configured" until its required credentials exist, then "connected"', async () => {
    const { db } = adminDb();
    const svc = new ChannelService(db, passEnforcer, allScopeResolver);
    const partial = await svc.create({ provider: 'meta', name: 'M', campaign_id: 5, source_id: 7, secrets: {} }, ALL, 1);
    expect(partial.status).toBe('not_configured');
    expect(partial.missing).toEqual(expect.arrayContaining(['App secret', 'Page access token']));

    const done = await svc.update(partial.id, { secrets: { app_secret: 'S', page_access_token: 'T' } }, ALL, 1);
    expect(done.status).toBe('connected');
    expect(done.missing).toEqual([]);
  });

  it('the webhook URL to paste into Meta / Google is exposed on the channel', async () => {
    const { db } = adminDb();
    const svc = new ChannelService(db, passEnforcer, allScopeResolver);
    const m = await svc.create({ provider: 'meta', name: 'M', campaign_id: 5, source_id: 7 }, ALL, 1);
    const g = await svc.create({ provider: 'google_ads', name: 'G', campaign_id: 5, source_id: 7 }, ALL, 1);
    const w = await svc.create({ provider: 'website', name: 'W', campaign_id: 5, source_id: 7 }, ALL, 1);
    const s = await svc.create({ provider: 'google_sheet', name: 'S', campaign_id: 5, source_id: 7 }, ALL, 1);

    expect(m.webhook_path).toBe(`/api/webhooks/meta/${m.public_key}`);
    expect(g.webhook_path).toBe(`/api/webhooks/google/${g.public_key}`);
    expect(w.webhook_path).toBe(`/api/webhooks/form/${w.public_key}`);
    expect(s.webhook_path).toBeNull();                 // polled, not pushed
    expect(s.next_poll_at).toBeTruthy();               // ...and scheduled on creation
  });

  it('only registry-declared config keys survive — no arbitrary JSON is stored', async () => {
    const { db, channels } = adminDb();
    const svc = new ChannelService(db, passEnforcer, allScopeResolver);
    await svc.create({
      provider: 'website', name: 'W', campaign_id: 5, source_id: 7,
      config: { allowed_origins: 'https://techlingua.in', evil: 'drop table', __proto__: {} },
    }, ALL, 1);
    expect(Object.keys(channels[0].config)).toEqual(['allowed_origins']);
  });
});
