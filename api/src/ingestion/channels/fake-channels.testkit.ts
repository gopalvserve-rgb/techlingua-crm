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
import { FbPagesService } from './fb-pages.service';

export interface FakeChannelState {
  channels: any[];
  events: any[];
  /** fb_form_mapping rows (migration 120) */
  formMappings: any[];
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
  const cst: FakeChannelState = { channels, events: [], formMappings: [] };
  let eventSeq = 900;
  let mappingSeq = 500;

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
    // ---- new-feature statements (WhatsApp lead match + OAuth setters) ----
    if (s.startsWith('SELECT id, org_id, branch_id FROM lead WHERE org_id')) {
      const last10 = String(params[1] ?? '');
      const d = (v: unknown) => String(v ?? '').replace(/\D/g, '').slice(-10);
      const hit = [...st.leads].reverse().find((l: any) => !l.deleted_at && Number(l.org_id) === Number(params[0])
        && (d(l.phone) === last10 || d(l.alt_phone) === last10 || d(l.whatsapp_phone) === last10));
      return hit ? [{ id: hit.id, org_id: hit.org_id, branch_id: hit.branch_id }] : [];
    }
    if (s.startsWith('SELECT id, org_id, branch_id FROM lead WHERE id')) {
      const hit = st.leads.find((l: any) => Number(l.id) === Number(params[0]) && !l.deleted_at);
      return hit ? [{ id: hit.id, org_id: hit.org_id, branch_id: hit.branch_id }] : [];
    }
    if (s.startsWith('UPDATE capture_channel SET secrets')) {
      const ch = cst.channels.find((c) => Number(c.id) === Number(params[0]));
      if (ch) ch.secrets = typeof params[1] === 'string' ? JSON.parse(params[1] as string) : params[1];
      return [];
    }
    if (s.startsWith('UPDATE capture_channel SET config')) {
      const ch = cst.channels.find((c) => Number(c.id) === Number(params[0]));
      if (ch) ch.config = typeof params[1] === 'string' ? JSON.parse(params[1] as string) : params[1];
      return [];
    }
    if (s.startsWith('UPDATE capture_channel SET cursor = $2, updated_at')) {
      const ch = cst.channels.find((c) => Number(c.id) === Number(params[0]));
      if (ch) ch.cursor = typeof params[1] === 'string' ? JSON.parse(params[1] as string) : params[1];
      return [];
    }
    // ---- Facebook Form Mapping (fb_form_mapping, migration 120) ----
    if (s.startsWith('SELECT is_enabled, field_map, form_name FROM fb_form_mapping')
      || s.startsWith('SELECT page_id, form_id, form_name, is_enabled, field_map, questions FROM fb_form_mapping')) {
      const hit = cst.formMappings.find((m) => Number(m.channel_id) === Number(params[0]) && String(m.form_id) === String(params[1]));
      return hit ? [hit] : [];
    }
    if (s.startsWith('SELECT form_id, is_enabled, field_map FROM fb_form_mapping WHERE channel_id = $1 AND page_id')) {
      return cst.formMappings.filter((m) => Number(m.channel_id) === Number(params[0]) && String(m.page_id) === String(params[1]));
    }
    if (s.startsWith('INSERT INTO fb_form_mapping (org_id, channel_id, page_id, form_id, form_name, questions)')) {
      // the cache upsert from the forms listing: jsonb_to_recordset($4)
      const rows = JSON.parse(String(params[3])) as Array<{ form_id: string; form_name: string; questions: unknown }>;
      for (const r of rows) {
        const cur = cst.formMappings.find((m) => Number(m.channel_id) === Number(params[1]) && String(m.form_id) === String(r.form_id));
        if (cur) { cur.page_id = params[2]; cur.form_name = r.form_name; cur.questions = r.questions; continue; }
        cst.formMappings.push({
          id: ++mappingSeq, org_id: params[0], channel_id: params[1], page_id: params[2], form_id: r.form_id,
          form_name: r.form_name, is_enabled: true, field_map: {}, questions: r.questions,
        });
      }
      return [];
    }
    if (s.startsWith('INSERT INTO fb_form_mapping (org_id, channel_id, page_id, form_id, form_name, is_enabled, field_map, updated_by)')) {
      const [org_id, channel_id, page_id, form_id, form_name, is_enabled, field_map, updated_by] = params as any[];
      const map = typeof field_map === 'string' ? JSON.parse(field_map) : field_map;
      const cur = cst.formMappings.find((m) => Number(m.channel_id) === Number(channel_id) && String(m.form_id) === String(form_id));
      if (cur) {
        if (page_id) cur.page_id = page_id;
        if (form_name != null) cur.form_name = form_name;
        cur.is_enabled = is_enabled; cur.field_map = map; cur.updated_by = updated_by;
      } else {
        cst.formMappings.push({ id: ++mappingSeq, org_id, channel_id, page_id, form_id, form_name, is_enabled, field_map: map, questions: null, updated_by });
      }
      return [];
    }
    if (s.startsWith('SELECT DISTINCT ON (field_key) field_key, label FROM custom_field_def')) {
      return [{ field_key: 'batch', label: 'Batch' }];
    }
    // per-Page lead stats (FbPagesService.leadStats) — the JS twin of the SQL
    if (s.includes('FROM webhook_event e CROSS JOIN LATERAL jsonb_array_elements')) {
      const acc = new Map<string, { page_id: string; leads: number; last_lead_at: string }>();
      for (const e of cst.events) {
        if (Number(e.channel_id) !== Number(params[0]) || e.provider !== 'meta' || e.method !== 'POST') continue;
        if (!['ingested', 'duplicate'].includes(String(e.status))) continue;
        for (const en of (Array.isArray(e.raw?.entry) ? e.raw.entry : [])) {
          for (const c of (Array.isArray(en?.changes) ? en.changes : [])) {
            if (c?.field !== 'leadgen') continue;
            const pid = String(c?.value?.page_id || en?.id || '');
            if (!pid) continue;
            const cur = acc.get(pid) ?? { page_id: pid, leads: 0, last_lead_at: e.created_at };
            cur.leads++; if (e.created_at > cur.last_lead_at) cur.last_lead_at = e.created_at;
            acc.set(pid, cur);
          }
        }
      }
      return [...acc.values()];
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
  const fb = new FbPagesService(db, channelSvc, hooks);
  return { db, st, cst, hooks, channelSvc, ingestion, fb };
}

/** Sign a body exactly the way Meta does: HMAC-SHA256 over the RAW bytes. */
export function metaSign(appSecret: string, body: unknown): { raw: Buffer; signature: string } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHmac } = require('crypto');
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  return { raw, signature: 'sha256=' + createHmac('sha256', appSecret).update(raw).digest('hex') };
}
