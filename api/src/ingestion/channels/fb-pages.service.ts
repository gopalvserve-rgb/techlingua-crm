import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { NotConfiguredException } from '../../common/not-configured.exception';
import { ChannelRow, ChannelService } from './channel.service';
import { WebhookService } from './webhook.service';
import { parseFieldMap } from './providers';
import { FB_GRAPH_BASE } from './source-adapters';
import {
  FbForm, FbPageEntry, FbQuestion, IGNORE_TARGET, META_CRM_FIELDS,
  cleanFormFieldMap, isLeadgenSubscribed, isPageTokenKey, mappedCount, pageTokenKey,
  parseFbForms, parseFbQuestions, storedPages, suggestFieldMap,
} from './fb-pages.util';

/** What the Page Monitor table shows for one Page. NEVER carries a token. */
export interface FbPageView extends FbPageEntry {
  has_token: boolean;
  is_primary: boolean;
  leads: number;
  last_lead_at: string | null;
}

const FORMS_CAP = 200;          // forms listed per Page (paginated 100 at a time)
const FORMS_PAGE = 100;

/**
 * FACEBOOK PAGE MONITOR + FORM MAPPING (admin surface of a Meta capture channel).
 *
 * The OAuth callback (WebhookService.fbCallback) stores EVERY Page the admin granted;
 * this service lets them choose which ones are monitored, see the live subscription
 * status, and map each Lead Ad form's questions onto CRM fields.
 *
 *  · Every Graph call goes through `WebhookService.http` — the one injectable seam — so
 *    tests never touch the network.
 *  · Page tokens are read with ChannelService.secretsOf() at the moment of the call and
 *    are NEVER part of any return value, log line or webhook_event row.
 *  · The caller (ChannelController) has ALREADY done the record-scope check; every method
 *    here re-checks only that the channel exists and is a Meta channel.
 */
@Injectable()
export class FbPagesService {
  private readonly log = new Logger('FbPagesService');

  constructor(
    private readonly db: DatabaseService,
    private readonly channels: ChannelService,
    private readonly hooks: WebhookService,
  ) {}

  // ------------------------------------------------------------------ pages

  /** Stored Pages + lead stats from the inbound event log. No Graph call. */
  async listPages(channelId: number): Promise<{ connected: boolean; pages: FbPageView[] }> {
    const ch = await this.metaChannel(channelId);
    return this.view(ch);
  }

  /** Ask Facebook, per Page, whether our app is subscribed to `leadgen`. */
  async refresh(channelId: number) {
    const ch = await this.metaChannel(channelId);
    const secrets = this.channels.secretsOf(ch);
    const { appId } = await this.hooks.fbAppCreds();
    const pages = this.effectivePages(ch);
    const now = new Date().toISOString();

    for (const p of pages) {
      const token = this.tokenFor(ch, secrets, p.page_id);
      p.checked_at = now;
      if (!token) { p.subscribed = null; p.last_error = 'No Page token stored — re-authorise with Facebook.'; continue; }
      try {
        const json = await this.graph('GET',
          `${FB_GRAPH_BASE}/${encodeURIComponent(p.page_id)}/subscribed_apps?access_token=${encodeURIComponent(token)}`);
        p.subscribed = isLeadgenSubscribed(json, appId);
        p.last_error = null;
        if (p.subscribed && !p.subscribed_at) p.subscribed_at = now;
      } catch (e) {
        // `monitored` (the ingestion gate) is deliberately NOT touched: a transient
        // Graph error must never start dropping leads.
        p.subscribed = null;
        p.last_error = this.clean(e);
      }
    }
    if (pages.length) await this.channels.mergeConfig(channelId, { pages });
    return this.view(await this.metaChannel(channelId));
  }

  /** Monitor a Page: subscribe our app to its `leadgen` field. */
  async subscribe(channelId: number, pageId: string) {
    const ch = await this.metaChannel(channelId);
    const pages = this.effectivePages(ch);
    const page = pages.find((p) => p.page_id === String(pageId));
    if (!page) throw new NotFoundException('That Facebook Page is not connected to this channel.');
    const token = this.tokenFor(ch, this.channels.secretsOf(ch), page.page_id);
    if (!token) throw new BadRequestException('No Page token stored for this Page — re-authorise with Facebook first.');

    const now = new Date().toISOString();
    try {
      const out = await this.graph('POST',
        `${FB_GRAPH_BASE}/${encodeURIComponent(page.page_id)}/subscribed_apps?subscribed_fields=leadgen&access_token=${encodeURIComponent(token)}`);
      if (!out?.success) throw new Error('Facebook did not confirm the subscription');
    } catch (e) {
      const msg = this.clean(e);
      page.last_error = msg; page.checked_at = now;
      await this.channels.mergeConfig(channelId, { pages });
      await this.event(ch, 'failed', `Could not subscribe Page "${page.page_name}" (${page.page_id}) to leadgen: ${msg}`,
        { action: 'fb_subscribe', page_id: page.page_id, page_name: page.page_name });
      throw new BadRequestException(`Facebook refused the subscription: ${msg}`);
    }
    Object.assign(page, { monitored: true, subscribed: true, subscribed_at: now, checked_at: now, last_error: null });
    await this.channels.mergeConfig(channelId, { pages });
    await this.event(ch, 'verified', `Facebook Page "${page.page_name}" (${page.page_id}) is now monitored — subscribed to leadgen`,
      { action: 'fb_subscribe', page_id: page.page_id, page_name: page.page_name });
    return this.view(await this.metaChannel(channelId));
  }

  /**
   * Stop monitoring a Page. Our own gate flips FIRST-CLASS (monitored:false -> deliveries
   * are skipped), so the admin's intent holds even if Facebook's unsubscribe call fails.
   */
  async unsubscribe(channelId: number, pageId: string) {
    const ch = await this.metaChannel(channelId);
    const pages = this.effectivePages(ch);
    const page = pages.find((p) => p.page_id === String(pageId));
    if (!page) throw new NotFoundException('That Facebook Page is not connected to this channel.');
    const token = this.tokenFor(ch, this.channels.secretsOf(ch), page.page_id);

    const now = new Date().toISOString();
    let warning: string | null = null;
    if (token) {
      try {
        await this.graph('DELETE',
          `${FB_GRAPH_BASE}/${encodeURIComponent(page.page_id)}/subscribed_apps?access_token=${encodeURIComponent(token)}`);
      } catch (e) { warning = this.clean(e); }
    } else {
      warning = 'No Page token stored — could not tell Facebook to unsubscribe.';
    }
    Object.assign(page, {
      monitored: false, subscribed: warning ? page.subscribed : false, checked_at: now, last_error: warning,
    });
    await this.channels.mergeConfig(channelId, { pages });
    await this.event(ch, warning ? 'failed' : 'verified',
      `Facebook Page "${page.page_name}" (${page.page_id}) is no longer monitored`
        + (warning ? ` — leads for it are now skipped, but Facebook's unsubscribe failed: ${warning}` : ' — unsubscribed from leadgen'),
      { action: 'fb_unsubscribe', page_id: page.page_id, page_name: page.page_name });
    return { ...(await this.view(await this.metaChannel(channelId))), warning };
  }

  /**
   * Disconnect Facebook: best-effort unsubscribe of every monitored Page, then wipe ALL
   * Page tokens (incl. the legacy one) and the Page list. Form mappings are KEPT, so a
   * re-connect picks up where the admin left off.
   */
  async disconnect(channelId: number) {
    const ch = await this.metaChannel(channelId);
    const secrets = this.channels.secretsOf(ch);
    const pages = this.effectivePages(ch);
    const failures: string[] = [];
    for (const p of pages.filter((x) => x.monitored)) {
      const token = this.tokenFor(ch, secrets, p.page_id);
      if (!token) continue;
      try {
        await this.graph('DELETE',
          `${FB_GRAPH_BASE}/${encodeURIComponent(p.page_id)}/subscribed_apps?access_token=${encodeURIComponent(token)}`);
      } catch (e) { failures.push(`${p.page_name || p.page_id}: ${this.clean(e)}`); }
    }
    const tokenKeys = Object.keys(ch.secrets ?? {}).filter(isPageTokenKey);
    await this.channels.dropSecrets(channelId, ['page_access_token', ...tokenKeys]);
    await this.channels.dropConfig(channelId, ['pages', 'page_id', 'page_name']);
    await this.event(ch, 'verified',
      `Facebook disconnected — ${pages.length} Page(s) removed and every Page token deleted`
        + (failures.length ? ` (Facebook unsubscribe failed for: ${failures.join('; ')})` : ''),
      { action: 'fb_disconnect', pages: pages.map((p) => p.page_id) });
    return { disconnected: true, pages_removed: pages.length, unsubscribe_failures: failures };
  }

  // ------------------------------------------------------------------ forms

  /** A Page's Lead Ad forms from the Graph API, merged with the saved mapping state. */
  async forms(channelId: number, pageId: string) {
    const ch = await this.metaChannel(channelId);
    const page = this.effectivePages(ch).find((p) => p.page_id === String(pageId));
    if (!page) throw new NotFoundException('That Facebook Page is not connected to this channel.');
    const token = this.tokenFor(ch, this.channels.secretsOf(ch), page.page_id);
    if (!token) throw new BadRequestException('No Page token stored for this Page — re-authorise with Facebook first.');

    const forms: FbForm[] = [];
    let url: string | null = `${FB_GRAPH_BASE}/${encodeURIComponent(page.page_id)}/leadgen_forms`
      + `?fields=id,name,status,locale,questions&limit=${FORMS_PAGE}&access_token=${encodeURIComponent(token)}`;
    let truncated = false;
    try {
      while (url) {
        const json: any = await this.graph('GET', url);
        forms.push(...parseFbForms(json));
        const next: string = String(json?.paging?.next ?? '');
        // only ever follow a paging link back to the Graph API host, and never in a circle
        url = next.startsWith('https://graph.facebook.com/') && next !== url ? next : null;
        if (forms.length >= FORMS_CAP) { truncated = !!url; url = null; }
      }
    } catch (e) {
      throw new BadRequestException(`Could not read this Page's lead forms from Facebook: ${this.clean(e)}`);
    }
    const list = forms.slice(0, FORMS_CAP);

    // cache the question lists (so the mapping editor + ingestion need no Graph call)
    if (list.length) {
      await this.db.query(
        `INSERT INTO fb_form_mapping (org_id, channel_id, page_id, form_id, form_name, questions)
         SELECT $1, $2, $3, x.form_id, x.form_name, x.questions
           FROM jsonb_to_recordset($4::jsonb) AS x(form_id text, form_name text, questions jsonb)
         ON CONFLICT (channel_id, form_id) DO UPDATE
           SET page_id = EXCLUDED.page_id, form_name = EXCLUDED.form_name,
               questions = EXCLUDED.questions, updated_at = now()`,
        [ch.org_id, ch.id, page.page_id,
          JSON.stringify(list.map((f) => ({ form_id: f.form_id, form_name: f.form_name, questions: f.questions })))],
      );
    }
    const saved = await this.db.query<any>(
      `SELECT form_id, is_enabled, field_map FROM fb_form_mapping WHERE channel_id = $1 AND page_id = $2`,
      [ch.id, page.page_id],
    );
    const byForm = new Map<string, any>(saved.map((r) => [String(r.form_id), r]));
    const channelMap = parseFieldMap((ch.config as any)?.field_map);

    return {
      page_id: page.page_id, page_name: page.page_name, truncated,
      forms: list.map((f) => {
        const row = byForm.get(f.form_id);
        const map = parseFieldMap(row?.field_map);
        return {
          form_id: f.form_id, form_name: f.form_name, status: f.status, locale: f.locale,
          total_fields: f.questions.length,
          mapped_fields: mappedCount(f.questions, map, channelMap),
          has_custom_mapping: Object.keys(map).length > 0,
          is_enabled: row ? row.is_enabled !== false : true,
        };
      }),
    };
  }

  /** The mapping editor's payload for one form. */
  async getMapping(channelId: number, formId: string, pageIdHint?: string) {
    const ch = await this.metaChannel(channelId);
    let row = await this.mappingRow(ch.id, formId);
    let questions: FbQuestion[] = parseFbQuestions(row?.questions);
    let form = {
      form_id: String(formId), form_name: String(row?.form_name ?? formId), page_id: String(row?.page_id ?? pageIdHint ?? ''),
    };

    // never listed (deep link / cache miss): read the form node itself, if we can tell which Page
    if (!questions.length && form.page_id) {
      const token = this.tokenFor(ch, this.channels.secretsOf(ch), form.page_id);
      if (token) {
        try {
          const json: any = await this.graph('GET',
            `${FB_GRAPH_BASE}/${encodeURIComponent(String(formId))}?fields=id,name,status,locale,questions&access_token=${encodeURIComponent(token)}`);
          questions = parseFbQuestions(json?.questions);
          form = { ...form, form_name: String(json?.name ?? form.form_name) };
        } catch (e) { this.log.warn(`form ${formId} read failed: ${this.clean(e)}`); }
      }
    }
    row = row ?? null;

    const crmFields = await this.crmFields(ch.org_id);
    const allowed = new Set(crmFields.map((f) => f.key));
    const stored = parseFieldMap(row?.field_map);
    // "— ignore —" is stored as IGNORE_TARGET; the editor sees it as a blank choice
    const fieldMap: Record<string, string> = {};
    for (const [k, v] of Object.entries(stored)) fieldMap[k] = v === IGNORE_TARGET ? '' : String(v);

    return {
      form, questions,
      field_map: fieldMap,
      saved: Object.keys(stored).length > 0,
      is_enabled: row ? row.is_enabled !== false : true,
      crm_fields: crmFields,
      suggested: suggestFieldMap(questions, allowed),
      channel_field_map: parseFieldMap((ch.config as any)?.field_map),
    };
  }

  /** Save one form's mapping. Unknown CRM targets are a 400, never silently dropped. */
  async saveMapping(channelId: number, formId: string, body: any, userId: number) {
    const ch = await this.metaChannel(channelId);
    const fid = String(formId ?? '').trim();
    if (!fid) throw new BadRequestException('form id is required');

    const crmFields = await this.crmFields(ch.org_id);
    const { map, unknown } = cleanFormFieldMap(body?.field_map, new Set(crmFields.map((f) => f.key)));
    if (unknown.length) {
      throw new BadRequestException(`Unknown CRM field(s): ${[...new Set(unknown)].join(', ')}. Choose one of the listed lead fields.`);
    }
    const existing = await this.mappingRow(ch.id, fid);
    const enabled = body?.is_enabled === undefined ? (existing ? existing.is_enabled !== false : true) : !!body.is_enabled;
    const fieldMap = body?.field_map === undefined ? parseFieldMap(existing?.field_map) : map;
    const pageId = String(body?.page_id ?? existing?.page_id ?? '').trim().slice(0, 64);
    const formName = String(body?.form_name ?? existing?.form_name ?? '').trim().slice(0, 255) || null;

    await this.db.query(
      `INSERT INTO fb_form_mapping (org_id, channel_id, page_id, form_id, form_name, is_enabled, field_map, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (channel_id, form_id) DO UPDATE
         SET page_id = CASE WHEN EXCLUDED.page_id <> '' THEN EXCLUDED.page_id ELSE fb_form_mapping.page_id END,
             form_name = COALESCE(EXCLUDED.form_name, fb_form_mapping.form_name),
             is_enabled = EXCLUDED.is_enabled, field_map = EXCLUDED.field_map,
             updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [ch.org_id, ch.id, pageId, fid, formName, enabled, JSON.stringify(fieldMap), userId],
    );
    await this.event(ch, 'verified',
      `Form mapping saved for "${formName ?? fid}" — ${Object.values(fieldMap).filter((t) => t !== IGNORE_TARGET).length} field(s) mapped, ${enabled ? 'enabled' : 'DISABLED'}`,
      { action: 'fb_form_mapping', form_id: fid, page_id: pageId, is_enabled: enabled, field_map: fieldMap });
    return this.getMapping(channelId, fid, pageId);
  }

  // ---------------------------------------------------------------- helpers

  private async metaChannel(id: number): Promise<ChannelRow> {
    const row = await this.channels.raw(id);
    if (!row) throw new NotFoundException('channel not found');
    if (row.provider !== 'meta') throw new NotConfiguredException('This channel is not a Meta Lead Ads channel.');
    return row;
  }

  /**
   * config.pages — or, for a channel connected BEFORE multi-Page support (only the legacy
   * page_id + page_access_token), that one Page presented as a monitored entry.
   */
  private effectivePages(ch: ChannelRow): FbPageEntry[] {
    const pages = storedPages(ch.config);
    if (pages.length) return pages;
    const legacyId = String((ch.config as any)?.page_id ?? '').trim();
    const hasLegacyToken = !!(ch.secrets ?? {})['page_access_token'];
    if (!legacyId || !hasLegacyToken) return [];
    return [{
      page_id: legacyId, page_name: String((ch.config as any)?.page_name ?? '').trim() || legacyId,
      monitored: true, subscribed: null, subscribed_at: null, checked_at: null, last_error: null,
    }];
  }

  /** This Page's token; the legacy token only ever stands in for the PRIMARY Page. */
  private tokenFor(ch: ChannelRow, secrets: Record<string, string>, pageId: string): string {
    const own = secrets[pageTokenKey(pageId)];
    if (own) return own;
    const primary = String((ch.config as any)?.page_id ?? '').trim();
    return primary && primary === pageId ? (secrets.page_access_token ?? '') : '';
  }

  private async view(ch: ChannelRow): Promise<{ connected: boolean; pages: FbPageView[] }> {
    const pages = this.effectivePages(ch);
    const stats = pages.length ? await this.leadStats(ch.id) : new Map<string, { leads: number; last: string | null }>();
    const primary = String((ch.config as any)?.page_id ?? '').trim();
    const keys = Object.keys(ch.secrets ?? {});
    return {
      connected: pages.length > 0,
      pages: pages.map((p) => ({
        ...p,
        has_token: keys.includes(pageTokenKey(p.page_id)) || (p.page_id === primary && keys.includes('page_access_token')),
        is_primary: p.page_id === primary,
        leads: stats.get(p.page_id)?.leads ?? 0,
        last_lead_at: stats.get(p.page_id)?.last ?? null,
      })),
    };
  }

  /**
   * Leads received per Page, from the durable inbound log. webhook_event.raw IS the Meta
   * delivery verbatim, so the Page id is already on every row (changes[].value.page_id,
   * else entry[].id) — nothing new had to be recorded. Counts leadgen changes on deliveries
   * that reached the pipeline (lead created, or merged as a duplicate).
   */
  private async leadStats(channelId: number): Promise<Map<string, { leads: number; last: string | null }>> {
    const out = new Map<string, { leads: number; last: string | null }>();
    try {
      const rows = await this.db.query<any>(
        `SELECT COALESCE(NULLIF(c->'value'->>'page_id', ''), en->>'id') AS page_id,
                count(*) AS leads, max(e.created_at) AS last_lead_at
           FROM webhook_event e
          CROSS JOIN LATERAL jsonb_array_elements(
                  CASE WHEN jsonb_typeof(e.raw->'entry') = 'array' THEN e.raw->'entry' ELSE '[]'::jsonb END) en
          CROSS JOIN LATERAL jsonb_array_elements(
                  CASE WHEN jsonb_typeof(en->'changes') = 'array' THEN en->'changes' ELSE '[]'::jsonb END) c
          WHERE e.channel_id = $1 AND e.provider = 'meta' AND e.method = 'POST'
            AND e.status IN ('ingested','duplicate') AND c->>'field' = 'leadgen'
          GROUP BY 1`,
        [channelId],
      );
      for (const r of rows) {
        if (!r.page_id) continue;
        out.set(String(r.page_id), {
          leads: Number(r.leads) || 0,
          last: r.last_lead_at ? new Date(r.last_lead_at).toISOString() : null,
        });
      }
    } catch (e) { this.log.warn(`page lead stats failed: ${(e as Error).message}`); }
    return out;
  }

  private async mappingRow(channelId: number, formId: string): Promise<any | null> {
    return this.db.one<any>(
      `SELECT page_id, form_id, form_name, is_enabled, field_map, questions
         FROM fb_form_mapping WHERE channel_id = $1 AND form_id = $2`,
      [channelId, String(formId)],
    );
  }

  /** Built-in lead fields + this org's active lead custom fields (as `cf:<field_key>`). */
  private async crmFields(orgId: number): Promise<Array<{ key: string; label: string }>> {
    let custom: Array<{ field_key: string; label: string }> = [];
    try {
      custom = await this.db.query<any>(
        `SELECT DISTINCT ON (field_key) field_key, label FROM custom_field_def
          WHERE org_id = $1 AND entity = 'lead' AND is_active AND deleted_at IS NULL
          ORDER BY field_key, id`,
        [orgId],
      );
    } catch (e) { this.log.warn(`custom fields unavailable: ${(e as Error).message}`); }
    return [
      ...META_CRM_FIELDS,
      ...custom.map((c) => ({ key: `cf:${c.field_key}`, label: `${c.label} (custom)` })),
    ];
  }

  /** One Graph call through the shared, test-overridable HTTP seam. */
  private async graph(method: 'GET' | 'POST' | 'DELETE', url: string): Promise<any> {
    const res = await this.hooks.http(url, method === 'GET' ? undefined : { method });
    const text = await res.text();
    if (!res.ok) throw new Error(`Facebook API ${res.status}: ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return {}; }
  }

  /** An error message that can never carry a token. */
  private clean(e: unknown): string {
    return String((e as Error)?.message ?? e).replace(/access_token=[^&\s"']+/gi, 'access_token=***').slice(0, 300);
  }

  /** Admin actions land in the same event log the client already reads. Token-free. */
  private event(ch: ChannelRow, status: 'verified' | 'failed', reason: string, raw: Record<string, unknown>) {
    return this.channels.logEvent({
      channel_id: ch.id, org_id: ch.org_id, provider: 'meta', public_key: ch.public_key,
      method: 'ADMIN', raw, status, reason,
    });
  }
}
