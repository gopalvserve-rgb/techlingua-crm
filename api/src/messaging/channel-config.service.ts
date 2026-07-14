import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { NotConfiguredException } from '../common/not-configured.exception';
import { decryptSecret, encryptSecret, maskSecret, randomToken } from '../common/crypto.util';
import { MSG_PROVIDERS, MsgChannel, MsgProviderSpec, missingRequirements, providersFor } from './providers';

export interface ChannelConfigRow {
  id: number; org_id: number; channel: string; provider: string;
  vertical_id: number | null;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  is_active: boolean;
}

/** A resolved, DECRYPTED configuration — only ever exists in memory, never on the wire. */
export interface ResolvedConfig {
  id: number;
  channel: MsgChannel;
  provider: string;
  vertical_id: number | null;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
}

/**
 * THE SETTINGS FRAMEWORK'S CREDENTIAL STORE.
 *
 * One table (`channel_config`), one rule: **most specific wins**. `resolve('email', 7)`
 * looks for the vertical-7 SMTP row and falls back to the org-wide row. That single rule
 * is what makes "SMTP per vertical" (non-negotiable, project rules) work without a second
 * code path — WhatsApp and SMS simply never have a vertical row.
 *
 * SECRETS: AES-256-GCM at rest (`crypto.util.ts`), decrypted ONLY inside `resolve()`
 * (which no HTTP handler returns), masked on every read, admin-only (`settings.*`),
 * never in the repo, never in `audit_log` (the redactor already strips them).
 *
 * NOT CONFIGURED: `require()` throws NotConfiguredException — a 503 carrying the exact
 * list of missing fields. That is an expected state while we wait for the client's
 * credentials, so it never lands in the Error Log.
 */
@Injectable()
export class ChannelConfigService {
  constructor(private readonly db: DatabaseService) {}

  providers(channel?: MsgChannel): MsgProviderSpec[] {
    return channel ? providersFor(channel) : Object.values(MSG_PROVIDERS);
  }

  private spec(provider: unknown): MsgProviderSpec {
    const s = MSG_PROVIDERS[String(provider ?? '')];
    if (!s) throw new BadRequestException(`Unknown provider "${provider}"`);
    return s;
  }

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    return Number(r!.id);
  }

  // ------------------------------------------------------------------ reads

  async list(channel?: string) {
    const params: unknown[] = [];
    let where = `c.deleted_at IS NULL`;
    if (channel) { params.push(channel); where += ` AND c.channel = $${params.length}`; }
    const rows = await this.db.query<any>(
      `SELECT c.*, v.name AS vertical_name
         FROM channel_config c
         LEFT JOIN vertical v ON v.id = c.vertical_id
        WHERE ${where}
        ORDER BY c.channel, c.vertical_id NULLS FIRST`,
      params,
    );
    return rows.map((r) => this.present(r));
  }

  /**
   * THE RESOLUTION RULE — vertical row, else org row. Returns null when nothing is stored
   * at all (a channel the client has never touched).
   */
  async resolve(channel: MsgChannel, verticalId?: number | null): Promise<ResolvedConfig | null> {
    const row = await this.db.one<any>(
      `SELECT * FROM channel_config
        WHERE channel = $1 AND deleted_at IS NULL AND is_active
          AND (vertical_id = $2::bigint OR vertical_id IS NULL)
        ORDER BY vertical_id NULLS LAST      -- the vertical row wins over the org row
        LIMIT 1`,
      [channel, verticalId ?? null],
    );
    if (!row) return null;
    return {
      id: Number(row.id),
      channel: row.channel,
      provider: row.provider,
      vertical_id: row.vertical_id == null ? null : Number(row.vertical_id),
      config: row.config ?? {},
      secrets: this.secretsOf(row),
    };
  }

  /**
   * Resolve or explain, in the client's words, exactly what is missing.
   * Every caller that actually SENDS uses this — so "not configured" is impossible to
   * forget and impossible to mistake for a bug.
   */
  async require(channel: MsgChannel, verticalId?: number | null): Promise<ResolvedConfig> {
    const cfg = await this.resolve(channel, verticalId);
    const label = { email: 'Email (SMTP)', sms: 'SMS', whatsapp: 'WhatsApp', payment: 'Payment gateway', ai: 'AI' }[channel];
    if (!cfg) {
      throw new NotConfiguredException(
        `${label} is not configured — add it in Administration › Settings › Channels.`,
      );
    }
    const missing = missingRequirements(cfg.provider, cfg.config, Object.keys(cfg.secrets));
    if (missing.length) {
      throw new NotConfiguredException(
        `${label} is not configured — missing: ${missing.join(', ')}. Add it in Administration › Settings › Channels.`,
      );
    }
    return cfg;
  }

  /** Status for the UI, per channel — without ever decrypting into a response. */
  async status(): Promise<Array<{ channel: string; provider: string | null; vertical_id: number | null; configured: boolean; missing: string[] }>> {
    const rows = await this.db.query<any>(`SELECT * FROM channel_config WHERE deleted_at IS NULL`);
    return rows.map((r) => {
      const secrets = this.secretsOf(r);
      const missing = missingRequirements(r.provider, r.config ?? {}, Object.keys(secrets));
      return {
        channel: r.channel,
        provider: r.provider,
        vertical_id: r.vertical_id == null ? null : Number(r.vertical_id),
        configured: r.is_active && missing.length === 0,
        missing,
      };
    });
  }

  // ----------------------------------------------------------------- writes

  /** Create or update the row for (channel, vertical) — one row per pair, by design. */
  async save(dto: any, actorId: number) {
    const spec = this.spec(dto?.provider);
    const verticalId = spec.perVertical && dto?.vertical_id ? Number(dto.vertical_id) : null;
    if (!spec.perVertical && dto?.vertical_id) {
      throw new BadRequestException(`${spec.label} is configured once for the whole organisation, not per vertical.`);
    }
    const orgId = await this.orgId();

    const existing = await this.db.one<any>(
      `SELECT * FROM channel_config
        WHERE org_id = $1 AND channel = $2 AND COALESCE(vertical_id, -1) = COALESCE($3::bigint, -1)
          AND deleted_at IS NULL`,
      [orgId, spec.channel, verticalId],
    );

    const secrets = this.encryptIncoming(spec, dto?.secrets ?? {}, existing?.secrets ?? {});
    const config = this.cleanConfig(spec, { ...(existing?.config ?? {}), ...(dto?.config ?? {}) });

    const row = existing
      ? await this.db.one<any>(
        `UPDATE channel_config
            SET provider = $2, config = $3::jsonb, secrets = $4::jsonb,
                is_active = COALESCE($5, is_active), updated_at = now(), updated_by = $6
          WHERE id = $1 RETURNING *`,
        [existing.id, spec.key, JSON.stringify(config), JSON.stringify(secrets),
          dto?.is_active === undefined ? null : !!dto.is_active, actorId],
      )
      : await this.db.one<any>(
        `INSERT INTO channel_config (org_id, channel, provider, vertical_id, config, secrets, is_active, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$8) RETURNING *`,
        [orgId, spec.channel, spec.key, verticalId, JSON.stringify(config), JSON.stringify(secrets),
          dto?.is_active === false ? false : true, actorId],
      );
    return this.present(row);
  }

  async remove(id: number, actorId: number) {
    const row = await this.db.one<any>(`SELECT id FROM channel_config WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!row) throw new NotFoundException('configuration not found');
    await this.db.query(
      `UPDATE channel_config SET deleted_at = now(), deleted_by = $2, is_active = FALSE WHERE id = $1`,
      [id, actorId],
    );
    return { id, deleted: true };
  }

  async recordTest(id: number, ok: boolean, error?: string | null) {
    await this.db.query(
      `UPDATE channel_config SET last_test_at = now(), last_test_ok = $2, last_test_error = $3 WHERE id = $1`,
      [id, ok, error ? String(error).slice(0, 500) : null],
    );
  }

  // ---------------------------------------------------------------- helpers

  /** The ONLY decrypting path. Never called from an HTTP response builder. */
  secretsOf(row: { secrets?: Record<string, string> }): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(row?.secrets ?? {})) {
      const p = decryptSecret(v);
      if (p) out[k] = p;
    }
    return out;
  }

  private cleanConfig(spec: MsgProviderSpec, incoming: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of spec.config) {
      const v = incoming?.[f.key];
      if (v === undefined || v === null || v === '') continue;
      out[f.key] = f.type === 'bool' ? !!v : f.type === 'number' ? Number(v) : v;
    }
    return out;
  }

  /** Blank or still-masked => keep what is stored. A `generated` secret is minted once. */
  private encryptIncoming(
    spec: MsgProviderSpec, incoming: Record<string, unknown>, existing: Record<string, string>,
  ): Record<string, string> {
    const out: Record<string, string> = { ...existing };
    for (const f of spec.secrets) {
      const v = incoming?.[f.key];
      const s = v === undefined || v === null ? '' : String(v).trim();
      if (s && !s.startsWith('•')) { out[f.key] = encryptSecret(s); continue; }
      if (!out[f.key] && f.generated) out[f.key] = encryptSecret(randomToken(18));
    }
    return out;
  }

  /**
   * The HTTP shape. Secrets are MASKED — an admin sees that a credential is set and can
   * replace it, never read it back. The single exception is the WhatsApp `verify_token`,
   * which WE generate and he MUST paste into Meta: it is revealed on this admin-only
   * (settings.read) response, exactly like the Meta lead-ads verify token in Sprint 2.
   */
  present(row: any) {
    if (!row) return row;
    const spec = MSG_PROVIDERS[row.provider];
    const plain = this.secretsOf(row);
    const missing = missingRequirements(row.provider, row.config ?? {}, Object.keys(plain));
    const masked: Record<string, string> = {};
    for (const f of spec?.secrets ?? []) masked[f.key] = plain[f.key] ? maskSecret(plain[f.key]) : '';
    return {
      id: Number(row.id),
      channel: row.channel,
      provider: row.provider,
      provider_label: spec?.label ?? row.provider,
      vertical_id: row.vertical_id == null ? null : Number(row.vertical_id),
      vertical_name: row.vertical_name ?? null,
      config: row.config ?? {},
      secrets_masked: masked,
      /** generated-by-us, must be copied INTO Meta — the only readable secret here */
      verify_token: row.channel === 'whatsapp' ? (plain.verify_token ?? '') : undefined,
      is_active: !!row.is_active,
      status: !row.is_active ? 'inactive' : missing.length ? 'not_configured' : 'connected',
      missing,
      last_test_at: row.last_test_at ?? null,
      last_test_ok: row.last_test_ok ?? null,
      last_test_error: row.last_test_error ?? null,
      updated_at: row.updated_at,
    };
  }
}
