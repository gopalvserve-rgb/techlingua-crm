import { BadRequestException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { LeadIngestionService } from '../ingestion/lead-ingestion.service';
import { IngestPayload } from '../ingestion/ingestion.types';
import { RateLimiter } from '../ingestion/channels/rate-limit.util';
import {
  generateApiKey, hashApiKey, keyMatchesHash, maskApiKey,
} from './api-key.util';

/**
 * A request-authentication failure. Extends HttpException so Nest returns the
 * right status (401 / 429), and carries the matched key's id/org when we know it
 * (a disabled/revoked key IS known) so the rejection can be logged against it.
 */
export class ApiKeyRejected extends HttpException {
  constructor(
    readonly http: number,
    message: string,
    readonly ctx: { keyId?: number; orgId?: number; keyPrefix?: string } = {},
  ) { super(message, http); }
}

/** The authenticated caller a valid key resolves to (attached to the request). */
export interface ApiCaller {
  id: number;
  org_id: number;
  name: string;
  key_prefix: string;
  scopes: string[];
  record_scope: string;
  default_campaign_id: number | null;
  default_source_id: number | null;
}

export interface ApiRequestLogInput {
  org_id?: number | null;
  api_key_id?: number | null;
  key_prefix?: string | null;
  method?: string;
  endpoint: string;
  status_code: number;
  outcome: 'ok' | 'duplicate' | 'skipped' | 'rejected' | 'failed';
  reason?: string | null;
  ip?: string | null;
  lead_id?: number | null;
  duration_ms?: number | null;
}

/** create-lead result the controller returns and the interceptor logs. */
export interface CreateLeadResult {
  http: number;
  body: Record<string, unknown>;
  outcome: 'ok' | 'duplicate' | 'skipped' | 'failed';
  lead_id: number | null;
  reason: string | null;
}

const PER_KEY_PER_MINUTE = 60;

/**
 * The Developer / API module's engine:
 *   · API-KEY LIFECYCLE  — generate (plaintext once, hash stored), list (masked),
 *                          enable/disable, revoke.
 *   · AUTHENTICATION     — hash lookup + constant-time compare; disabled/revoked/
 *                          unknown keys are rejected (401); a per-key rate limit.
 *   · CREATE-LEAD        — goes through the ONE LeadIngestionService, so dedup,
 *                          distribution and audit are inherited (never a 2nd insert path).
 *   · REQUEST LOG        — every inbound call recorded (accepted and rejected).
 */
@Injectable()
export class ApiKeyService {
  /** Per-key fixed-window limiter — reuses the capture-channel limiter class. */
  readonly limiter = new RateLimiter();
  readonly perKeyLimit = PER_KEY_PER_MINUTE;

  constructor(
    private readonly db: DatabaseService,
    private readonly ingestion: LeadIngestionService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    return r ? Number(r.id) : 1;
  }

  // ------------------------------------------------------------------- reads

  /** Every key, masked. NEVER returns key_hash or anything replayable. */
  async list() {
    const rows = await this.db.query<any>(
      `SELECT k.id, k.name, k.key_prefix, k.key_last4, k.scopes, k.record_scope,
              k.default_campaign_id, k.default_source_id, k.is_active, k.last_used_at,
              k.revoked_at, k.created_at,
              ca.name AS default_campaign_name, s.name AS default_source_name,
              (SELECT count(*) FROM api_request_log l WHERE l.api_key_id = k.id) AS calls_total,
              (SELECT count(*) FROM api_request_log l
                 WHERE l.api_key_id = k.id AND l.status_code >= 400) AS calls_failed
         FROM api_key k
         LEFT JOIN campaign ca ON ca.id = k.default_campaign_id
         LEFT JOIN source   s  ON s.id  = k.default_source_id
        ORDER BY k.id DESC`,
    );
    return rows.map((r) => this.present(r));
  }

  /** Request-log view for the UI, with optional date + status filters. */
  async requestLogs(opts: { keyId?: number; status?: 'ok' | 'failed'; since?: string; limit?: number } = {}) {
    const params: unknown[] = [];
    const where: string[] = [];
    if (opts.keyId) { params.push(opts.keyId); where.push(`l.api_key_id = $${params.length}`); }
    if (opts.status === 'ok') where.push(`l.status_code < 400`);
    if (opts.status === 'failed') where.push(`l.status_code >= 400`);
    if (opts.since) { params.push(opts.since); where.push(`l.created_at >= $${params.length}`); }
    params.push(Math.min(Number(opts.limit) || 100, 500));
    return this.db.query<any>(
      `SELECT l.id, l.method, l.endpoint, l.status_code, l.outcome, l.reason, l.ip,
              l.lead_id, l.duration_ms, l.created_at, l.key_prefix, l.api_key_id,
              k.name AS key_name
         FROM api_request_log l
         LEFT JOIN api_key k ON k.id = l.api_key_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT $${params.length}`,
      params,
    );
  }

  // ------------------------------------------------------------------ writes

  /**
   * Mint a key. The plaintext is in the RESPONSE ONCE and is never stored or
   * retrievable again — only its SHA-256 hash lands in the database.
   */
  async generate(dto: any, userId: number) {
    const name = String(dto?.name ?? '').trim();
    if (!name) throw new BadRequestException('Give the key a name.');
    const org = await this.orgId();
    const gen = generateApiKey();

    // validate an optional default target belongs together
    const campaignId = dto?.default_campaign_id ? Number(dto.default_campaign_id) : null;
    let sourceId = dto?.default_source_id ? Number(dto.default_source_id) : null;
    if (campaignId && sourceId) {
      const src = await this.db.one<{ id: string }>(
        `SELECT id FROM source WHERE id = $1 AND campaign_id = $2 AND deleted_at IS NULL`,
        [sourceId, campaignId],
      );
      if (!src) throw new BadRequestException('That default source does not belong to the chosen default campaign.');
    } else if (sourceId && !campaignId) {
      sourceId = null; // a source without its campaign is meaningless as a default
    }

    const row = await this.db.one<any>(
      `INSERT INTO api_key
         (org_id, name, key_prefix, key_last4, key_hash, default_campaign_id, default_source_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [org, name, gen.key_prefix, gen.key_last4, gen.key_hash, campaignId, sourceId, userId],
    );
    // the ONLY time the plaintext leaves this process
    return { ...this.present(row), plaintext: gen.plaintext };
  }

  /** Enable / disable a key. A disabled key is rejected at authentication (401). */
  async setActive(id: number, active: boolean, _userId: number) {
    const existing = await this.db.one<any>(`SELECT * FROM api_key WHERE id = $1`, [id]);
    if (!existing) throw new NotFoundException('API key not found');
    if (existing.revoked_at) throw new BadRequestException('This key is revoked and cannot be re-enabled. Generate a new one.');
    const row = await this.db.one<any>(
      `UPDATE api_key SET is_active = $2 WHERE id = $1 RETURNING *`, [id, !!active],
    );
    return this.present(row);
  }

  /** Revoke a key for good. Kept (not hard-deleted) so its request log survives. */
  async revoke(id: number, userId: number) {
    const existing = await this.db.one<any>(`SELECT * FROM api_key WHERE id = $1`, [id]);
    if (!existing) throw new NotFoundException('API key not found');
    await this.db.query(
      `UPDATE api_key SET is_active = FALSE, revoked_at = COALESCE(revoked_at, now()), revoked_by = $2 WHERE id = $1`,
      [id, userId],
    );
    return { id, revoked: true };
  }

  // ------------------------------------------------------------- authenticate

  /**
   * Resolve a presented key to a caller, or throw ApiKeyRejected (401).
   * Rejects: unknown · disabled · revoked. The final accept is a constant-time
   * hash compare so the hash cannot be walked via a timing side channel.
   */
  async authenticate(rawKey: string): Promise<ApiCaller> {
    if (!rawKey) throw new ApiKeyRejected(401, 'No API key supplied (use Authorization: Bearer or X-API-Key).');
    const hash = hashApiKey(rawKey);
    const row = await this.db.one<any>(`SELECT * FROM api_key WHERE key_hash = $1`, [hash]);
    if (!row || !keyMatchesHash(rawKey, row.key_hash)) {
      throw new ApiKeyRejected(401, 'Unknown API key.');
    }
    const kctx = { keyId: Number(row.id), orgId: Number(row.org_id), keyPrefix: row.key_prefix };
    if (row.revoked_at) throw new ApiKeyRejected(401, 'This API key has been revoked.', kctx);
    if (!row.is_active) throw new ApiKeyRejected(401, 'This API key is disabled.', kctx);
    // touch last_used_at (best-effort; never blocks the request)
    this.db.query(`UPDATE api_key SET last_used_at = now() WHERE id = $1`, [row.id]).catch(() => undefined);
    return {
      id: Number(row.id), org_id: Number(row.org_id), name: row.name, key_prefix: row.key_prefix,
      scopes: Array.isArray(row.scopes) ? row.scopes : [],
      record_scope: row.record_scope,
      default_campaign_id: row.default_campaign_id ? Number(row.default_campaign_id) : null,
      default_source_id: row.default_source_id ? Number(row.default_source_id) : null,
    };
  }

  // --------------------------------------------------------------- the log

  /** Durable request log — called for EVERY inbound call. Never throws. */
  async logRequest(e: ApiRequestLogInput): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO api_request_log
           (org_id, api_key_id, key_prefix, method, endpoint, status_code, outcome, reason, ip, lead_id, duration_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          e.org_id ?? null, e.api_key_id ?? null, e.key_prefix ?? null,
          (e.method ?? 'POST').slice(0, 8), String(e.endpoint).slice(0, 200),
          e.status_code, e.outcome, e.reason ? String(e.reason).slice(0, 2000) : null,
          (e.ip ?? '').slice(0, 64) || null, e.lead_id ?? null, e.duration_ms ?? null,
        ],
      );
    } catch {
      // a lost log line must never take the API call down
    }
  }

  // --------------------------------------------------------- the API surface

  /** POST /public-api/leads — create a lead through the shared ingestion pipeline. */
  async createLead(caller: ApiCaller, body: any, _meta: { ip?: string }): Promise<CreateLeadResult> {
    if (!caller.scopes.includes('lead:create')) {
      return { http: 403, body: { ok: false, error: 'This key cannot create leads.' }, outcome: 'failed', lead_id: null, reason: 'scope lead:create missing' };
    }
    const campaignId = body?.campaign_id ? Number(body.campaign_id) : caller.default_campaign_id;
    const sourceId = body?.source_id ? Number(body.source_id) : caller.default_source_id;
    if (!campaignId || !sourceId) {
      return {
        http: 400,
        body: { ok: false, error: 'No target. Supply campaign_id and source_id, or give the key a default campaign + source.' },
        outcome: 'failed', lead_id: null, reason: 'no campaign/source target',
      };
    }
    // the source must belong to the campaign, or ingestion would mis-file the lead
    const src = await this.db.one<{ id: string }>(
      `SELECT id FROM source WHERE id = $1 AND campaign_id = $2 AND deleted_at IS NULL`, [sourceId, campaignId],
    );
    if (!src) {
      return {
        http: 400, body: { ok: false, error: 'source_id does not belong to campaign_id.' },
        outcome: 'failed', lead_id: null, reason: 'source not in campaign',
      };
    }

    const payload: IngestPayload = {
      full_name: body?.name ?? body?.full_name,
      phone: body?.phone,
      email: body?.email,
      alt_phone: body?.alt_phone,
      whatsapp_phone: body?.whatsapp_phone,
      dob: body?.dob,
      state: body?.state,
      city: body?.city,
      course: body?.course,
      qualification: body?.qualification,
      budget: body?.budget,
      priority: body?.priority,
      note: body?.note,
      tags: body?.tags,
      external_id: body?.external_id != null ? String(body.external_id) : undefined,
      custom_fields: body?.custom_fields && typeof body.custom_fields === 'object' ? body.custom_fields : undefined,
    };

    try {
      const outcome = await this.ingestion.ingest(payload, {
        channel: 'api',
        campaign_id: campaignId,
        source_id: sourceId,
        actor_id: null,
        external_key: payload.external_id ?? null,
        duplicate_policy: 'campaign',
      });
      const map: Record<string, { http: number; oc: CreateLeadResult['outcome']; msg: string }> = {
        created:   { http: 201, oc: 'ok',        msg: 'Lead created.' },
        duplicate: { http: 200, oc: 'duplicate', msg: 'Matched an existing lead; the campaign duplicate rule was applied.' },
        skipped:   { http: 200, oc: 'skipped',   msg: 'Already ingested (idempotent replay) — no new lead.' },
        failed:    { http: 422, oc: 'failed',    msg: outcome.reason || 'Lead could not be created.' },
      };
      const m = map[outcome.status] ?? map.failed;
      return {
        http: m.http,
        body: { ok: outcome.status !== 'failed', status: outcome.status, lead_id: outcome.lead_id ?? null, duplicate_of: outcome.duplicate_of ?? null, message: m.msg },
        outcome: m.oc, lead_id: outcome.lead_id ?? null, reason: outcome.reason ?? m.msg,
      };
    } catch (e) {
      const msg = (e as Error).message || 'Invalid lead';
      return { http: 400, body: { ok: false, error: msg }, outcome: 'failed', lead_id: null, reason: msg };
    }
  }

  /** GET /public-api/leads — recent leads for the key's org. */
  async listLeads(caller: ApiCaller, limit: number, offset: number) {
    if (!caller.scopes.includes('lead:read')) {
      return { http: 403, body: { ok: false, error: 'This key cannot read leads.' }, count: 0 };
    }
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const off = Math.max(Number(offset) || 0, 0);
    const rows = await this.db.query<any>(
      `SELECT l.id, l.full_name, l.phone, l.email, l.created_at,
              st.name AS stage, ms.name AS status, ca.name AS campaign, s.name AS source
         FROM lead l
         LEFT JOIN pipeline_stage st ON st.id = l.stage_id
         LEFT JOIN m_status ms       ON ms.id = l.status_id
         LEFT JOIN campaign ca       ON ca.id = l.campaign_id
         LEFT JOIN source s          ON s.id  = l.source_id
        WHERE l.org_id = $1 AND l.deleted_at IS NULL
        ORDER BY l.id DESC
        LIMIT $2 OFFSET $3`,
      [caller.org_id, lim, off],
    );
    return {
      http: 200,
      count: rows.length,
      body: { count: rows.length, leads: rows.map((r) => ({ ...r, id: Number(r.id) })) },
    };
  }

  // ----------------------------------------------------------------- present

  private present(row: any) {
    return {
      id: Number(row.id),
      name: row.name,
      key_masked: maskApiKey(row.key_prefix, row.key_last4),
      key_prefix: row.key_prefix,
      scopes: Array.isArray(row.scopes) ? row.scopes : [],
      record_scope: row.record_scope,
      default_campaign_id: row.default_campaign_id ? Number(row.default_campaign_id) : null,
      default_source_id: row.default_source_id ? Number(row.default_source_id) : null,
      default_campaign_name: row.default_campaign_name ?? null,
      default_source_name: row.default_source_name ?? null,
      is_active: !!row.is_active,
      revoked: !!row.revoked_at,
      status: row.revoked_at ? 'revoked' : row.is_active ? 'active' : 'disabled',
      last_used_at: row.last_used_at ?? null,
      created_at: row.created_at,
      calls_total: row.calls_total === undefined ? undefined : Number(row.calls_total),
      calls_failed: row.calls_failed === undefined ? undefined : Number(row.calls_failed),
    };
  }
}
