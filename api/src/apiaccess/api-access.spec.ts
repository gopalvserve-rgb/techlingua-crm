import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ApiKeyService, ApiKeyRejected } from './api-key.service';
import { ApiKeyGuard } from './api-key.guard';
import { API_ENDPOINT_DOCS } from './api-docs';
import { PublicApiController } from './public-api.controller';
import { ApiKeysController } from './api-keys.controller';
import {
  extractApiKey, generateApiKey, hashApiKey, keyMatchesHash, maskApiKey, isApiKeyShaped, KEY_PREFIX,
} from './api-key.util';

/* ============================================================ the pure util */

describe('api-key.util — the plaintext exists once, only a hash is stored', () => {
  it('generates a tlk_live_ key, a masked prefix and a sha-256 hash that is NOT the key', () => {
    const g = generateApiKey();
    expect(g.plaintext.startsWith(KEY_PREFIX)).toBe(true);
    expect(g.key_prefix.startsWith(KEY_PREFIX)).toBe(true);
    expect(g.key_hash).toHaveLength(64);
    expect(g.key_hash).toMatch(/^[0-9a-f]{64}$/);
    // the stored hash must never equal or contain the plaintext
    expect(g.key_hash).not.toEqual(g.plaintext);
    expect(g.plaintext.includes(g.key_hash)).toBe(false);
    expect(hashApiKey(g.plaintext)).toEqual(g.key_hash);
  });

  it('every generated key is unique', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateApiKey().plaintext));
    expect(seen.size).toBe(50);
  });

  it('masks to a prefix + last4, never the whole key', () => {
    const g = generateApiKey();
    const masked = maskApiKey(g.key_prefix, g.key_last4);
    expect(masked).toContain('…');
    expect(masked.length).toBeLessThan(g.plaintext.length);
  });

  it('constant-time match: the real key passes, a tampered key fails', () => {
    const g = generateApiKey();
    expect(keyMatchesHash(g.plaintext, g.key_hash)).toBe(true);
    expect(keyMatchesHash(g.plaintext + 'x', g.key_hash)).toBe(false);
    expect(keyMatchesHash('tlk_live_wrong', g.key_hash)).toBe(false);
  });

  it('extracts the key from Authorization: Bearer OR X-API-Key', () => {
    expect(extractApiKey({ authorization: 'Bearer abc' })).toBe('abc');
    expect(extractApiKey({ 'x-api-key': 'abc' })).toBe('abc');
    expect(extractApiKey({ 'x-api-key': 'Bearer abc' })).toBe('abc');
    expect(extractApiKey({})).toBe('');
    expect(isApiKeyShaped(generateApiKey().plaintext)).toBe(true);
    expect(isApiKeyShaped('nope')).toBe(false);
  });
});

/* ==================================================== an in-memory pg double */

/** Recognises exactly the SQL ApiKeyService emits. Not a mock of the service. */
class FakeDb {
  keys: any[] = [];
  logs: any[] = [];
  sources = [{ id: 7, campaign_id: 3, deleted_at: null }];
  seq = 100;

  async query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/FROM organisation/i.test(s)) return [{ id: 1 }] as any;
    if (/^INSERT INTO api_key/i.test(s)) {
      const [org, name, key_prefix, key_last4, key_hash, dc, ds, cb] = params;
      const row = {
        id: this.seq++, org_id: org, name, key_prefix, key_last4, key_hash,
        scopes: ['lead:create', 'lead:read'], record_scope: 'all',
        default_campaign_id: dc ?? null, default_source_id: ds ?? null,
        is_active: true, last_used_at: null, revoked_at: null, revoked_by: null,
        created_by: cb, created_at: new Date().toISOString(),
      };
      this.keys.push(row);
      return [row] as any;
    }
    if (/SELECT \* FROM api_key WHERE key_hash/i.test(s)) return this.keys.filter((k) => k.key_hash === params[0]) as any;
    if (/SELECT \* FROM api_key WHERE id/i.test(s)) return this.keys.filter((k) => k.id === Number(params[0])) as any;
    if (/UPDATE api_key SET last_used_at/i.test(s)) return [] as any;
    if (/UPDATE api_key SET is_active = \$2/i.test(s)) {
      const k = this.keys.find((x) => x.id === Number(params[0])); if (k) k.is_active = params[1];
      return k ? ([k] as any) : ([] as any);
    }
    if (/UPDATE api_key SET is_active = FALSE, revoked_at/i.test(s)) {
      const k = this.keys.find((x) => x.id === Number(params[0])); if (k) { k.is_active = false; k.revoked_at = new Date().toISOString(); k.revoked_by = params[1]; }
      return [] as any;
    }
    if (/^INSERT INTO api_request_log/i.test(s)) {
      const [org_id, api_key_id, key_prefix, method, endpoint, status_code, outcome, reason, ip, lead_id, duration_ms] = params;
      this.logs.push({ id: this.seq++, org_id, api_key_id, key_prefix, method, endpoint, status_code, outcome, reason, ip, lead_id, duration_ms, created_at: new Date().toISOString() });
      return [] as any;
    }
    if (/SELECT l\.id, l\.method/i.test(s)) return [...this.logs].reverse() as any;
    if (/SELECT id FROM source WHERE id/i.test(s)) {
      return this.sources.filter((x) => x.id === Number(params[0]) && x.campaign_id === Number(params[1])) as any;
    }
    if (/SELECT k\.id, k\.name/i.test(s)) return this.keys.map((k) => ({ ...k, calls_total: this.logs.filter((l) => l.api_key_id === k.id).length, calls_failed: this.logs.filter((l) => l.api_key_id === k.id && l.status_code >= 400).length })) as any;
    if (/FROM lead l/i.test(s)) return [{ id: 1, full_name: 'A', phone: '+91', email: null, created_at: 'x', stage: 'New', status: null, campaign: 'C', source: 'S' }] as any;
    throw new Error(`FakeDb: unrecognised SQL: ${s.slice(0, 80)}`);
  }
  async one<T = any>(sql: string, params: any[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }
}

function makeService() {
  const db = new FakeDb();
  const ingest = jest.fn(async (_p: any, ctx: any) => ({ status: 'created', lead_id: 555, duplicate_of: null, ...(ctx.__out ?? {}) }));
  const svc = new ApiKeyService(db as any, { ingest } as any);
  return { db, ingest, svc };
}
const ADMIN = 1;

/* ============================================================ the service */

describe('ApiKeyService — generate / authenticate / reject / create-lead / log', () => {
  it('generate returns the plaintext ONCE and stores only a hash', async () => {
    const { db, svc } = makeService();
    const out = await svc.generate({ name: 'Partner' }, ADMIN);
    expect(out.plaintext.startsWith(KEY_PREFIX)).toBe(true);
    expect(out.key_masked).toContain('…');
    // what landed in the DB is the hash of the plaintext, not the plaintext
    expect(db.keys[0].key_hash).toBe(hashApiKey(out.plaintext));
    expect(JSON.stringify(db.keys[0])).not.toContain(out.plaintext);
  });

  it('a valid ENABLED key authenticates', async () => {
    const { svc } = makeService();
    const out = await svc.generate({ name: 'K' }, ADMIN);
    const caller = await svc.authenticate(out.plaintext);
    expect(caller.name).toBe('K');
    expect(caller.scopes).toContain('lead:create');
  });

  it('an UNKNOWN key is rejected (401)', async () => {
    const { svc } = makeService();
    await expect(svc.authenticate('tlk_live_does_not_exist')).rejects.toMatchObject({ http: 401 });
  });

  it('a DISABLED key is rejected (401)', async () => {
    const { svc } = makeService();
    const out = await svc.generate({ name: 'K' }, ADMIN);
    await svc.setActive(out.id, false, ADMIN);
    await expect(svc.authenticate(out.plaintext)).rejects.toMatchObject({ http: 401 });
  });

  it('a REVOKED key is rejected (401) and cannot be re-enabled', async () => {
    const { svc } = makeService();
    const out = await svc.generate({ name: 'K' }, ADMIN);
    await svc.revoke(out.id, ADMIN);
    await expect(svc.authenticate(out.plaintext)).rejects.toBeInstanceOf(ApiKeyRejected);
    await expect(svc.setActive(out.id, true, ADMIN)).rejects.toBeTruthy();
  });

  it('create-lead flows through the ONE ingestion pipeline (channel api, dedup policy, external_id)', async () => {
    const { svc, ingest } = makeService();
    const out = await svc.generate({ name: 'K', default_campaign_id: 3, default_source_id: 7 }, ADMIN);
    const caller = await svc.authenticate(out.plaintext);
    const r = await svc.createLead(caller, { name: 'Asha', phone: '+919000012345', external_id: 'x-1' }, {});
    expect(r.http).toBe(201);
    expect(r.lead_id).toBe(555);
    expect(ingest).toHaveBeenCalledTimes(1);
    const [payload, ctx] = ingest.mock.calls[0];
    expect(ctx.channel).toBe('api');
    expect(ctx.campaign_id).toBe(3);
    expect(ctx.source_id).toBe(7);
    expect(ctx.duplicate_policy).toBe('campaign');
    expect(ctx.external_key).toBe('x-1');
    expect(payload.full_name).toBe('Asha');
  });

  it('a duplicate/replay maps to a NON-created status, not a second lead', async () => {
    const { svc, ingest } = makeService();
    ingest.mockResolvedValueOnce({ status: 'skipped', lead_id: 1, duplicate_of: 1 });
    const out = await svc.generate({ name: 'K', default_campaign_id: 3, default_source_id: 7 }, ADMIN);
    const caller = await svc.authenticate(out.plaintext);
    const r = await svc.createLead(caller, { name: 'Asha', phone: '+91', external_id: 'x-1' }, {});
    expect(r.http).toBe(200);
    expect(r.outcome).toBe('skipped');
  });

  it('create-lead with no target campaign/source is a clean 400, not a crash', async () => {
    const { svc } = makeService();
    const out = await svc.generate({ name: 'K' }, ADMIN); // no defaults
    const caller = await svc.authenticate(out.plaintext);
    const r = await svc.createLead(caller, { name: 'Asha', phone: '+91' }, {});
    expect(r.http).toBe(400);
    expect(r.outcome).toBe('failed');
  });

  it('the request log records a call', async () => {
    const { db, svc } = makeService();
    await svc.logRequest({ endpoint: '/api/public-api/leads', status_code: 201, outcome: 'ok', method: 'POST' });
    expect(db.logs).toHaveLength(1);
    const view = await svc.requestLogs({});
    expect(view.length).toBe(1);
  });

  it('list never leaks a hash or a plaintext', async () => {
    const { svc } = makeService();
    await svc.generate({ name: 'K' }, ADMIN);
    const list = await svc.list();
    expect(JSON.stringify(list)).not.toMatch(/key_hash/);
    expect(list[0].key_masked).toContain('…');
  });
});

/* ============================================================ the guard */

function ctxFor(req: any) {
  return { switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }) } as any;
}

describe('ApiKeyGuard — auth + rate limit + reject logging', () => {
  it('accepts a valid key and attaches the caller', async () => {
    const { svc } = makeService();
    const out = await svc.generate({ name: 'K' }, ADMIN);
    const guard = new ApiKeyGuard(svc);
    const req: any = { headers: { authorization: `Bearer ${out.plaintext}` }, method: 'GET', url: '/api/public-api/health', ip: '1.2.3.4' };
    expect(await guard.canActivate(ctxFor(req))).toBe(true);
    expect(req.apiCaller.name).toBe('K');
  });

  it('rejects an unknown key with 401 AND writes a rejected log row', async () => {
    const { db, svc } = makeService();
    const guard = new ApiKeyGuard(svc);
    const req: any = { headers: { 'x-api-key': 'tlk_live_bad' }, method: 'POST', url: '/api/public-api/leads', ip: '9.9.9.9' };
    await expect(guard.canActivate(ctxFor(req))).rejects.toMatchObject({ http: 401 });
    expect(db.logs.some((l) => l.outcome === 'rejected' && l.status_code === 401)).toBe(true);
  });

  it('a rejection is a real HttpException with the right status (not a 500) — the live-smoke bug', async () => {
    const { svc } = makeService();
    const out = await svc.generate({ name: 'K' }, ADMIN);
    await svc.setActive(out.id, false, ADMIN);
    const guard = new ApiKeyGuard(svc);
    const req: any = { headers: { authorization: `Bearer ${out.plaintext}` }, method: 'POST', url: '/api/public-api/leads', ip: '2.2.2.2' };
    await guard.canActivate(ctxFor(req)).then(
      () => { throw new Error('should have rejected'); },
      (e) => { expect(typeof e.getStatus).toBe('function'); expect(e.getStatus()).toBe(401); },
    );
  });

  it('a DISABLED key rejection is logged AGAINST that key (api_key_id set, so the per-key filter finds it)', async () => {
    const { db, svc } = makeService();
    const out = await svc.generate({ name: 'K' }, ADMIN);
    await svc.setActive(out.id, false, ADMIN);
    const guard = new ApiKeyGuard(svc);
    const req: any = { headers: { authorization: `Bearer ${out.plaintext}` }, method: 'POST', url: '/api/public-api/leads', ip: '2.2.2.2' };
    await expect(guard.canActivate(ctxFor(req))).rejects.toBeTruthy();
    const row = db.logs.find((l) => l.outcome === 'rejected');
    expect(row.api_key_id).toBe(out.id);
    expect(row.status_code).toBe(401);
  });

  it('rate limiting FIRES — the 61st call in a window is 429 and logged', async () => {
    const { db, svc } = makeService();
    const out = await svc.generate({ name: 'K' }, ADMIN);
    const guard = new ApiKeyGuard(svc);
    const mk = () => ({ headers: { authorization: `Bearer ${out.plaintext}` }, method: 'GET', url: '/api/public-api/health', ip: '1.1.1.1' } as any);
    for (let i = 0; i < svc.perKeyLimit; i++) expect(await guard.canActivate(ctxFor(mk()))).toBe(true);
    await expect(guard.canActivate(ctxFor(mk()))).rejects.toMatchObject({ http: 429 });
    expect(db.logs.some((l) => l.status_code === 429)).toBe(true);
  });
});

/* ============================================================ the docs */

describe('API documentation cannot drift from the real routes', () => {
  it('every documented endpoint key matches a REAL PublicApiController route', () => {
    const proto = PublicApiController.prototype as unknown as Record<string, unknown>;
    const routes = new Set<string>();
    const { PATH_METADATA, METHOD_METADATA } = require('@nestjs/common/constants');
    const { RequestMethod } = require('@nestjs/common');
    const VERB: Record<number, string> = { [RequestMethod.GET]: 'GET', [RequestMethod.POST]: 'POST' };
    const base = Reflect.getMetadata(PATH_METADATA, PublicApiController);
    for (const m of Object.getOwnPropertyNames(proto)) {
      if (m === 'constructor' || typeof proto[m] !== 'function') continue;
      const verb = Reflect.getMetadata(METHOD_METADATA, proto[m] as object);
      if (verb === undefined) continue;
      const sub = Reflect.getMetadata(PATH_METADATA, proto[m] as object) ?? '/';
      routes.add(`${VERB[verb as number]} /api/${base}/${sub}`.replace(/\/+/g, '/'));
    }
    for (const key of Object.keys(API_ENDPOINT_DOCS)) {
      expect([...routes]).toContain(key);
    }
    // and every real route is documented
    for (const r of routes) expect(API_ENDPOINT_DOCS[r]).toBeTruthy();
  });
});

/* ============================================================ the SQL schema */

describe('the API tables carry the columns the service reads/writes', () => {
  const sql = readFileSync(join(__dirname, '..', '..', 'db', 'migrations', '034_api_access.sql'), 'utf8');
  it('api_key has the credential columns', () => {
    for (const c of ['key_hash', 'key_prefix', 'key_last4', 'is_active', 'revoked_at', 'default_campaign_id', 'default_source_id', 'scopes']) {
      expect(sql).toMatch(new RegExp(`\\b${c}\\b`));
    }
  });
  it('api_request_log has the log columns', () => {
    for (const c of ['status_code', 'outcome', 'endpoint', 'key_prefix', 'duration_ms', 'lead_id']) {
      expect(sql).toMatch(new RegExp(`\\b${c}\\b`));
    }
  });
  it('grants api.read + api.manage to the admin roles only', () => {
    expect(sql).toMatch(/'api\.read',\s*'Organization Admin'/);
    expect(sql).toMatch(/'api\.manage',\s*'Super Admin'/);
  });
});

/* ====================================================== RBAC on the mgmt API */

describe('every management route is permission-guarded', () => {
  it('ApiKeysController routes all carry @RequirePermission', () => {
    const { PERMISSION_KEY } = require('../rbac/rbac.decorators');
    const proto = ApiKeysController.prototype as unknown as Record<string, unknown>;
    const { METHOD_METADATA } = require('@nestjs/common/constants');
    for (const m of Object.getOwnPropertyNames(proto)) {
      if (m === 'constructor' || typeof proto[m] !== 'function') continue;
      if (Reflect.getMetadata(METHOD_METADATA, proto[m] as object) === undefined) continue;
      expect(Reflect.getMetadata(PERMISSION_KEY, proto[m] as object)).toMatch(/^api\.(read|manage)$/);
    }
  });
});
