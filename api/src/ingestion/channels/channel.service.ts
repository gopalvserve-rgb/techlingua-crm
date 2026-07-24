import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { ScopeEnforcerService } from '../../rbac/scope-enforcer.service';
import { ScopeResolverService } from '../../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../../rbac/rbac.types';
import { decryptSecret, encryptSecret, maskSecret, randomToken } from '../../common/crypto.util';
import { PROVIDERS, ProviderSpec, missingRequirements } from './providers';

/** Channels scope through their denormalised path — the same columns as leads. */
export const CHANNEL_SCOPE_COLS: ScopeColumnMap = {
  branch: 'c.branch_id', vertical: 'c.vertical_id', pipeline: 'c.pipeline_id', campaign: 'c.campaign_id',
};

export type ChannelStatus = 'connected' | 'not_configured' | 'inactive';

export interface ChannelRow {
  id: number; org_id: number; provider: string; name: string;
  branch_id: number; vertical_id: number; pipeline_id: number; campaign_id: number; source_id: number;
  public_key: string; config: Record<string, unknown>; secrets: Record<string, string>;
  is_active: boolean; cursor: Record<string, unknown>;
}

export interface WebhookEventInput {
  channel_id?: number | null;
  org_id?: number | null;
  provider: string;
  public_key?: string | null;
  method?: string;
  ip?: string | null;
  origin?: string | null;
  raw?: unknown;
  signature_ok?: boolean | null;
  status: 'verified' | 'rejected' | 'ingested' | 'duplicate' | 'skipped' | 'failed';
  reason?: string | null;
  external_key?: string | null;
  lead_id?: number | null;
  duration_ms?: number | null;
}

/**
 * Lead-capture channel administration + the durable inbound event log.
 *
 * SECRETS: written encrypted (AES-256-GCM), read back MASKED. `secretsOf()` is the
 * only decrypting path and is used exclusively by the webhook/poll code — no HTTP
 * response ever carries a plaintext credential, and `audit_log` never sees one
 * (the audit redactor already strips key names containing secret/token/api_key,
 * and the whole `secrets` object is replaced with a mask before it leaves here).
 */
@Injectable()
export class ChannelService {
  constructor(
    private readonly db: DatabaseService,
    private readonly enforcer: ScopeEnforcerService,
    private readonly resolver: ScopeResolverService,
  ) {}

  // ---------------------------------------------------------------- registry

  /** Drives the admin UI's Configure form — one place to add a provider. */
  providers(): ProviderSpec[] {
    return Object.values(PROVIDERS);
  }

  // ------------------------------------------------------------------- reads

  private scopeWhere(scope: ResolvedScope, params: unknown[]): string {
    return this.resolver.buildScopeWhere(scope, CHANNEL_SCOPE_COLS, params);
  }

  async list(scope: ResolvedScope) {
    const params: unknown[] = [];
    const where = this.scopeWhere(scope, params);
    const rows = await this.db.query<any>(
      `SELECT c.*, b.name AS branch_name, v.name AS vertical_name, p.name AS pipeline_name,
              ca.name AS campaign_name, s.name AS source_name, l.full_name AS last_lead_name,
              (SELECT count(*) FROM webhook_event e
                WHERE e.channel_id = c.id AND e.created_at > now() - INTERVAL '24 hours') AS events_24h,
              (SELECT count(*) FROM webhook_event e
                WHERE e.channel_id = c.id AND e.status IN ('rejected','failed')
                  AND e.created_at > now() - INTERVAL '24 hours') AS failures_24h,
              (SELECT count(*) FROM lead_ingest_record r
                WHERE r.source_id = c.source_id AND r.channel IN ('webhook','form','sheet')
                  AND r.created_at > now() - INTERVAL '30 days') AS leads_30d
         FROM capture_channel c
         JOIN branch b   ON b.id = c.branch_id
         JOIN vertical v ON v.id = c.vertical_id
         JOIN pipeline p ON p.id = c.pipeline_id
         JOIN campaign ca ON ca.id = c.campaign_id
         JOIN source s   ON s.id = c.source_id
         LEFT JOIN lead l ON l.id = c.last_lead_id
        WHERE c.deleted_at IS NULL AND (${where})
        ORDER BY c.id DESC`,
      params,
    );
    return rows.map((r) => this.present(r));
  }

  async get(id: number, scope: ResolvedScope, userId: number) {
    await this.enforcer.assertRefInScope(scope, 'campaign', await this.campaignOf(id), userId);
    const params: unknown[] = [id];
    const rows = await this.db.query<any>(
      `SELECT c.*, b.name AS branch_name, v.name AS vertical_name, p.name AS pipeline_name,
              ca.name AS campaign_name, s.name AS source_name, l.full_name AS last_lead_name
         FROM capture_channel c
         JOIN branch b   ON b.id = c.branch_id
         JOIN vertical v ON v.id = c.vertical_id
         JOIN pipeline p ON p.id = c.pipeline_id
         JOIN campaign ca ON ca.id = c.campaign_id
         JOIN source s   ON s.id = c.source_id
         LEFT JOIN lead l ON l.id = c.last_lead_id
        WHERE c.id = $1 AND c.deleted_at IS NULL`,
      params,
    );
    if (!rows[0]) throw new NotFoundException('channel not found');
    return this.present(rows[0]);
  }

  /** Recent inbound events — the "why did this lead not arrive?" screen. */
  async events(scope: ResolvedScope, channelId?: number, limit = 50) {
    const params: unknown[] = [];
    const where = this.scopeWhere(scope, params);
    let extra = '';
    if (channelId) { params.push(channelId); extra = ` AND e.channel_id = $${params.length}`; }
    params.push(Math.min(Number(limit) || 50, 200));
    return this.db.query<any>(
      `SELECT e.id, e.provider, e.status, e.reason, e.external_key, e.lead_id, e.ip, e.origin,
              e.signature_ok, e.created_at, e.duration_ms, e.channel_id, c.name AS channel_name,
              l.full_name AS lead_name, l.phone AS lead_phone
         FROM webhook_event e
         JOIN capture_channel c ON c.id = e.channel_id
         LEFT JOIN lead l ON l.id = e.lead_id
        WHERE (${where})${extra}
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT $${params.length}`,
      params,
    );
  }

  // ------------------------------------------------------------------ writes

  async create(dto: any, scope: ResolvedScope, userId: number) {
    const spec = this.specOf(dto?.provider);
    const campaignId = Number(dto?.campaign_id);
    const sourceId = Number(dto?.source_id);
    if (!campaignId || !sourceId) throw new BadRequestException('Choose a target Campaign and Source.');
    if (!String(dto?.name ?? '').trim()) throw new BadRequestException('Give the channel a name.');

    // RBAC: a scoped admin may only wire up campaigns/sources inside their own units.
    await this.enforcer.assertRefInScope(scope, 'campaign', campaignId, userId);
    await this.enforcer.assertRefInScope(scope, 'source', sourceId, userId);

    const camp = await this.db.one<any>(
      `SELECT org_id, branch_id, vertical_id, pipeline_id FROM campaign
        WHERE id = $1 AND deleted_at IS NULL`, [campaignId],
    );
    if (!camp) throw new NotFoundException('campaign not found');
    const src = await this.db.one<any>(
      `SELECT id FROM source WHERE id = $1 AND campaign_id = $2 AND deleted_at IS NULL`, [sourceId, campaignId],
    );
    if (!src) throw new BadRequestException('That source does not belong to the chosen campaign.');

    const secrets = this.encryptIncoming(spec, dto?.secrets ?? {}, {});
    const row = await this.db.one<any>(
      `INSERT INTO capture_channel
         (org_id, provider, name, branch_id, vertical_id, pipeline_id, campaign_id, source_id,
          public_key, config, secrets, is_active, next_poll_at, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
       RETURNING *`,
      [
        Number(camp.org_id), spec.key, String(dto.name).trim(),
        Number(camp.branch_id), Number(camp.vertical_id), Number(camp.pipeline_id), campaignId, sourceId,
        randomToken(18), JSON.stringify(this.cleanConfig(spec, dto?.config ?? {})), JSON.stringify(secrets),
        dto?.is_active === false ? false : true,
        spec.kind === 'poll' ? new Date() : null,
        userId,
      ],
    );
    return this.present(row);
  }

  async update(id: number, dto: any, scope: ResolvedScope, userId: number) {
    const existing = await this.raw(id);
    if (!existing) throw new NotFoundException('channel not found');
    await this.enforcer.assertRefInScope(scope, 'campaign', existing.campaign_id, userId);

    const spec = this.specOf(existing.provider);
    // a blank secret means "leave it alone" — an admin can never accidentally wipe
    // a credential by opening the form (they only ever see a mask).
    const secrets = this.encryptIncoming(spec, dto?.secrets ?? {}, existing.secrets ?? {});
    const config = dto?.config === undefined
      ? existing.config
      : this.cleanConfig(spec, { ...(existing.config ?? {}), ...(dto.config ?? {}) });

    const row = await this.db.one<any>(
      `UPDATE capture_channel
          SET name = COALESCE($2, name),
              config = $3,
              secrets = $4,
              is_active = COALESCE($5, is_active),
              next_poll_at = CASE WHEN $6 THEN COALESCE(next_poll_at, now()) ELSE next_poll_at END,
              updated_at = now(), updated_by = $7
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING *`,
      [
        id, dto?.name ? String(dto.name).trim() : null, JSON.stringify(config), JSON.stringify(secrets),
        dto?.is_active === undefined ? null : !!dto.is_active, spec.kind === 'poll', userId,
      ],
    );
    return this.present(row);
  }

  /** Soft delete (project convention): the event history survives for audit. */
  async remove(id: number, scope: ResolvedScope, userId: number) {
    const existing = await this.raw(id);
    if (!existing) throw new NotFoundException('channel not found');
    await this.enforcer.assertRefInScope(scope, 'campaign', existing.campaign_id, userId);
    await this.db.query(
      `UPDATE capture_channel SET deleted_at = now(), deleted_by = $2, is_active = FALSE WHERE id = $1`,
      [id, userId],
    );
    return { id, deleted: true };
  }

  /** Rotate the public URL key (and the generated verify/webhook token with it). */
  async regenerate(id: number, scope: ResolvedScope, userId: number) {
    const existing = await this.raw(id);
    if (!existing) throw new NotFoundException('channel not found');
    await this.enforcer.assertRefInScope(scope, 'campaign', existing.campaign_id, userId);
    const spec = this.specOf(existing.provider);
    const secrets = { ...(existing.secrets ?? {}) };
    for (const f of spec.secrets) {
      if (f.generated) secrets[f.key] = encryptSecret(randomToken(18));
    }
    const row = await this.db.one<any>(
      `UPDATE capture_channel SET public_key = $2, secrets = $3, updated_at = now(), updated_by = $4
        WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [id, randomToken(18), JSON.stringify(secrets), userId],
    );
    return this.present(row);
  }

  // ------------------------------------------------- internals for the channels

  /** Raw row incl. ciphertexts — internal use only, NEVER returned over HTTP. */
  async raw(id: number): Promise<ChannelRow | null> {
    return this.db.one<any>(`SELECT * FROM capture_channel WHERE id = $1 AND deleted_at IS NULL`, [id]);
  }

  /** Resolve a public endpoint hit. Inactive/unknown keys resolve to null (404). */
  async byPublicKey(publicKey: string, provider?: string): Promise<ChannelRow | null> {
    if (!publicKey) return null;
    const row = await this.db.one<any>(
      `SELECT * FROM capture_channel WHERE public_key = $1 AND deleted_at IS NULL`, [publicKey],
    );
    if (!row) return null;
    if (provider && row.provider !== provider) return null;
    return row;
  }

  /** Decrypt this channel's credentials — the ONLY place plaintext exists. */
  secretsOf(row: ChannelRow): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(row.secrets ?? {})) {
      const p = decryptSecret(v);
      if (p) out[k] = p;
    }
    return out;
  }

  /** Which required credentials are still missing (drives "not configured"). */
  missing(row: ChannelRow): string[] {
    return missingRequirements(row.provider, row.config ?? {}, Object.keys(this.secretsOf(row)));
  }

  isConfigured(row: ChannelRow): boolean {
    return this.missing(row).length === 0;
  }

  /** Durable inbound log — called for EVERY request, accepted or rejected. */
  async logEvent(e: WebhookEventInput): Promise<number | null> {
    try {
      const row = await this.db.one<{ id: string }>(
        `INSERT INTO webhook_event
           (org_id, channel_id, provider, public_key, method, ip, origin, raw, signature_ok,
            status, reason, external_key, lead_id, duration_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [
          e.org_id ?? null, e.channel_id ?? null, e.provider, e.public_key ?? null,
          e.method ?? 'POST', (e.ip ?? '').slice(0, 64) || null, (e.origin ?? '').slice(0, 255) || null,
          JSON.stringify(e.raw ?? {}), e.signature_ok ?? null, e.status,
          e.reason ? String(e.reason).slice(0, 2000) : null,
          e.external_key ? String(e.external_key).slice(0, 160) : null,
          e.lead_id ?? null, e.duration_ms ?? null,
        ],
      );
      if (e.channel_id) {
        await this.db.query(
          `UPDATE capture_channel
              SET last_event_at = now(),
                  last_lead_at  = CASE WHEN $2::bigint IS NOT NULL THEN now() ELSE last_lead_at END,
                  last_lead_id  = COALESCE($2::bigint, last_lead_id),
                  last_error    = CASE WHEN $3 IN ('rejected','failed') THEN $4 ELSE NULL END
            WHERE id = $1`,
          [e.channel_id, e.lead_id ?? null, e.status, e.reason ?? null],
        );
      }
      return row ? Number(row.id) : null;
    } catch {
      // the log must never take the webhook down — a lost log line beats a lost lead
      return null;
    }
  }

  /**
   * The two read-back credentials (Meta verify token, Google webhook key), for a
   * `channel.manage` admin only — this is the sole endpoint that reveals anything.
   */
  async credentials(id: number, scope: ResolvedScope, userId: number) {
    const row = await this.raw(id);
    if (!row) throw new NotFoundException('channel not found');
    await this.enforcer.assertRefInScope(scope, 'campaign', row.campaign_id, userId);
    const p = this.present(row, true);
    return { id: p.id, provider: p.provider, verify_token: p.verify_token, google_key: p.google_key, webhook_key: p.webhook_key };
  }

  // ----------------------------------------------------------------- helpers

  private specOf(provider: unknown): ProviderSpec {
    const spec = PROVIDERS[String(provider ?? '')];
    if (!spec) throw new BadRequestException(`Unknown channel provider "${provider}"`);
    return spec;
  }

  private async campaignOf(id: number): Promise<number | null> {
    const r = await this.db.one<{ campaign_id: string }>(
      `SELECT campaign_id FROM capture_channel WHERE id = $1 AND deleted_at IS NULL`, [id],
    );
    if (!r) throw new NotFoundException('channel not found');
    return Number(r.campaign_id);
  }

  /** Only keys the provider declares survive — no arbitrary JSON blobs in config. */
  private cleanConfig(spec: ProviderSpec, incoming: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of spec.config) {
      const v = incoming?.[f.key];
      if (v === undefined || v === null || v === '') continue;
      out[f.key] = f.type === 'bool' ? !!v : f.type === 'number' ? Number(v) : v;
    }
    return out;
  }

  /**
   * Encrypt the secrets an admin submitted.
   *  - a value that is blank or still the MASK  -> keep whatever is stored
   *  - a `generated` secret with nothing stored -> mint one
   */
  private encryptIncoming(
    spec: ProviderSpec, incoming: Record<string, unknown>, existing: Record<string, string>,
  ): Record<string, string> {
    const out: Record<string, string> = { ...existing };
    for (const f of spec.secrets) {
      const v = incoming?.[f.key];
      const s = v === undefined || v === null ? '' : String(v).trim();
      if (s && !s.startsWith('••')) { out[f.key] = encryptSecret(s); continue; }
      if (!out[f.key] && f.generated) out[f.key] = encryptSecret(randomToken(18));
    }
    return out;
  }

  /** The HTTP shape: masked secrets, computed status, the webhook URL to paste. */
  present(row: any, reveal = false) {
    if (!row) return row;
    const spec = PROVIDERS[row.provider];
    const plain = this.secretsOf(row);
    const missing = this.missing(row);
    const status: ChannelStatus = !row.is_active ? 'inactive' : missing.length ? 'not_configured' : 'connected';
    const masked: Record<string, string> = {};
    for (const f of spec?.secrets ?? []) masked[f.key] = plain[f.key] ? maskSecret(plain[f.key]) : '';

    return {
      id: Number(row.id),
      provider: row.provider,
      provider_label: spec?.label ?? row.provider,
      kind: spec?.kind ?? 'webhook',
      name: row.name,
      branch_id: Number(row.branch_id), vertical_id: Number(row.vertical_id),
      pipeline_id: Number(row.pipeline_id), campaign_id: Number(row.campaign_id), source_id: Number(row.source_id),
      branch_name: row.branch_name, vertical_name: row.vertical_name, pipeline_name: row.pipeline_name,
      campaign_name: row.campaign_name, source_name: row.source_name,
      public_key: row.public_key,
      /** the path the client pastes into Meta / Google / their website */
      webhook_path: spec?.endpoint ? `/api/webhooks/${spec.endpoint}/${row.public_key}` : null,
      config: row.config ?? {},
      secrets_masked: masked,
      /**
       * The Meta verify token and the Google webhook key are the only two
       * credentials an admin must READ BACK (to paste them into Meta / Google).
       * They are revealed ONLY on the `channel.manage` credentials endpoint —
       * `reveal` is false for every list/read response, so a `channel.read` user
       * (Branch/Vertical Manager) sees status and events but no credential at all.
       */
      verify_token: reveal && row.provider === 'meta' ? (plain.verify_token ?? '') : undefined,
      google_key: reveal && row.provider === 'google_ads' ? (plain.google_key ?? '') : undefined,
      /** the optional shared key for a push integration (marketplace / custom / webhook) */
      webhook_key: reveal && spec?.endpoint === 'push' ? (plain.webhook_key ?? '') : undefined,
      is_active: !!row.is_active,
      status,
      missing,
      cursor: row.cursor ?? {},
      next_poll_at: row.next_poll_at,
      last_event_at: row.last_event_at,
      last_lead_at: row.last_lead_at,
      last_lead_id: row.last_lead_id ? Number(row.last_lead_id) : null,
      last_lead_name: row.last_lead_name ?? null,
      last_error: row.last_error ?? null,
      events_24h: row.events_24h === undefined ? undefined : Number(row.events_24h),
      failures_24h: row.failures_24h === undefined ? undefined : Number(row.failures_24h),
      leads_30d: row.leads_30d === undefined ? undefined : Number(row.leads_30d),
      created_at: row.created_at,
    };
  }
}
