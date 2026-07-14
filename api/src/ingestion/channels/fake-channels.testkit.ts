/**
 * Test double for the capture-channel tables, layered on the ingestion fake DB
 * (fake-db.testkit.ts). Same philosophy: NOT a mock of our services — the real
 * ChannelService / WebhookService SQL runs against a tiny in-memory interpreter,
 * so a webhook test really does drive LeadIngestionService end to end and a lead
 * really does appear in `st.leads`.
 *
 * Excluded from the production build (tsconfig.build.json: *.testkit.ts).
 */
import { DatabaseService } from '../../database/database.service';
import { ScopeEnforcerService } from '../../rbac/scope-enforcer.service';
import { FakeState, allScopeResolver, makeFakeDb, makeIngestion } from '../fake-db.testkit';
import { encryptSecret, randomToken } from '../../common/crypto.util';
import { ChannelRow, ChannelService } from './channel.service';
import { WebhookService } from './webhook.service';

export interface FakeChannelState {
  channels: any[];
  events: any[];
}

/** Build a capture_channel row with its secrets already encrypted at rest. */
export function makeChannel(over: Partial<ChannelRow> & { secrets?: Record<string, string> } = {}): any {
  const secrets: Record<string, string> = {};
  for (const [k, v] of Object.entries(over.secrets ?? {})) secrets[k] = encryptSecret(String(v));
  return {
    id: 1, org_id: 1, provider: 'meta', name: 'Test channel',
    branch_id: 2, vertical_id: 3, pipeline_id: 4, campaign_id: 5, source_id: 7,
    public_key: over.public_key ?? randomToken(9),
    config: {}, is_active: true, cursor: {},
    next_poll_at: null, last_event_at: null, last_lead_at: null, last_lead_id: null, last_error: null,
    deleted_at: null,
    ...over,
    secrets,
  };
}

/** The ingestion fake DB + capture_channel / webhook_event handling on top. */
export function makeChannelDb(channels: any[], init: Partial<FakeState> = {}) {
  const { db, st } = makeFakeDb(init);
  const cst: FakeChannelState = { channels, events: [] };
  let eventSeq = 900;

  const exec = async (sql: string, params: unknown[] = []): Promise<any[]> => {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('SELECT * FROM capture_channel WHERE public_key')) {
      const hit = cst.channels.find((c) => c.public_key === params[0] && !c.deleted_at);
      return hit ? [hit] : [];
    }
    if (s.startsWith('SELECT * FROM capture_channel WHERE id')) {
      const hit = cst.channels.find((c) => Number(c.id) === Number(params[0]) && !c.deleted_at);
      return hit ? [hit] : [];
    }
    if (s.startsWith('INSERT INTO webhook_event')) {
      const [org_id, channel_id, provider, public_key, method, ip, origin, raw, signature_ok,
        status, reason, external_key, lead_id, duration_ms] = params as any[];
      const row = {
        id: ++eventSeq, org_id, channel_id, provider, public_key, method, ip, origin,
        raw: typeof raw === 'string' ? JSON.parse(raw) : raw,
        signature_ok, status, reason, external_key, lead_id, duration_ms,
        created_at: new Date().toISOString(),
      };
      cst.events.push(row);
      return [{ id: row.id }];
    }
    if (s.startsWith('UPDATE capture_channel SET last_event_at')) {
      const ch = cst.channels.find((c) => Number(c.id) === Number(params[0]));
      if (ch) {
        ch.last_event_at = new Date().toISOString();
        if (params[1] != null) { ch.last_lead_id = params[1]; ch.last_lead_at = ch.last_event_at; }
        ch.last_error = ['rejected', 'failed'].includes(String(params[2])) ? params[3] : null;
      }
      return [];
    }
    if (s.startsWith('UPDATE capture_channel SET last_error')) {
      const ch = cst.channels.find((c) => Number(c.id) === Number(params[0]));
      if (ch) ch.last_error = params[1];
      return [];
    }
    if (s.startsWith('UPDATE capture_channel SET cursor')) {
      const ch = cst.channels.find((c) => Number(c.id) === Number(params[0]));
      if (ch) {
        ch.cursor = typeof params[1] === 'string' ? JSON.parse(params[1] as string) : params[1];
        ch.next_poll_at = new Date(Date.now() + Number(params[2]) * 60_000).toISOString();
      }
      return [];
    }
    return (db as any).query(sql, params);
  };

  const wrapped = {
    query: exec,
    one: async (sql: string, params: unknown[] = []) => (await exec(sql, params))[0] ?? null,
    tx: (db as any).tx.bind(db),
    pool: null,
  } as unknown as DatabaseService;

  return { db: wrapped, st, cst };
}

/** An enforcer stub — record-scope refusal itself is covered by channel-rbac.spec. */
export const passEnforcer = {
  assertRefInScope: async () => undefined,
  assertInScope: async () => undefined,
} as unknown as ScopeEnforcerService;

export function makeWebhook(channels: any[], init: Partial<FakeState> = {}) {
  const { db, st, cst } = makeChannelDb(channels, init);
  const channelSvc = new ChannelService(db, passEnforcer, allScopeResolver);
  const { svc: ingestion } = makeIngestion(db);
  const hooks = new WebhookService(db, channelSvc, ingestion);
  return { db, st, cst, hooks, channelSvc, ingestion };
}

/** Sign a body exactly the way Meta does: HMAC-SHA256 over the RAW bytes. */
export function metaSign(appSecret: string, body: unknown): { raw: Buffer; signature: string } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHmac } = require('crypto');
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  return { raw, signature: 'sha256=' + createHmac('sha256', appSecret).update(raw).digest('hex') };
}
