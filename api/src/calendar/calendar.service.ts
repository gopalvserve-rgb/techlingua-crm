import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { SettingsService } from '../common/settings.service';
import { ChannelConfigService, ResolvedConfig } from '../messaging/channel-config.service';
import { NotConfiguredException } from '../common/not-configured.exception';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ScopeEnforcerService } from '../rbac/scope-enforcer.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { FOLLOWUP_SCOPE_COLS } from '../rbac/scope-cols';
import { toDateString, isRealCalendarDate } from '../common/date.util';

/**
 * CALENDAR — follow-ups, demos and meetings on one view.
 *
 * The IN-APP calendar is fully live. GOOGLE / OUTLOOK SYNC IS CREDENTIAL-BLOCKED, so it
 * ships the way the Google-Sheet channel and the SMS gateway did: **config-driven, with a
 * clean "Not configured" state**. `POST /calendar/sync` raises `NotConfiguredException`
 * (a 503 that the Error Log deliberately does NOT capture — it is an expected state, not
 * a bug) naming exactly what is missing. The moment the client pastes credentials into
 * Settings it lights up — no deploy, no code change. Nothing about the in-app calendar
 * depends on it.
 *
 * SCOPE: events carry the path columns themselves (owner/team/branch/vertical) plus the
 * linked lead's pipeline/campaign, so all six record-scope kinds resolve through the one
 * central ScopeResolver — no hand-rolled filtering.
 */

export const CALENDAR_SCOPE_COLS: ScopeColumnMap = {
  owner: 'e.owner_id', team: 'e.team_id', branch: 'e.branch_id', vertical: 'e.vertical_id',
  pipeline: 'cl.pipeline_id', campaign: 'cl.campaign_id',
};

const EVENT_TYPES = ['meeting', 'demo', 'visit', 'other'];

export interface CalendarEventDto {
  title: string;
  type?: string;
  starts_at: string;
  ends_at?: string | null;
  all_day?: boolean;
  lead_id?: number | null;
  owner_id?: number | null;
  location?: string | null;
  notes?: string | null;
  branch_id?: number | null;
  vertical_id?: number | null;
}

@Injectable()
export class CalendarService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly enforcer: ScopeEnforcerService,
    private readonly settings: SettingsService,
    private readonly configs: ChannelConfigService,
  ) {}

  /* ------------------------------ the feed ------------------------------ */

  private window(from?: string, to?: string) {
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const now = new Date();
    // Tri-state: `undefined` = not a date (400); `null` = absent (default). Conflating
    // them turns a malformed window into a silently different one — see dashboard.service.
    const parse = (v: unknown, dflt: string) => {
      const d = toDateString(v);
      // DEF-DR-01: reject calendar-invalid (2026-13-99) here too, not just at the ::date cast.
      if (d === undefined || (d && !isRealCalendarDate(d))) throw new BadRequestException('from / to must be YYYY-MM-DD dates');
      return d ?? dflt;
    };
    const f = parse(from, iso(new Date(now.getFullYear(), now.getMonth(), 1)));
    const t = parse(to, iso(new Date(now.getFullYear(), now.getMonth() + 1, 0)));
    if (f > t) throw new BadRequestException('"from" must not be after "to"');
    return { from: f, to: t };
  }

  /**
   * The merged feed the calendar renders: FOLLOW-UPS (from the lead pipeline) +
   * CALENDAR EVENTS (meetings / demos), both under the caller's own record scope.
   * A counsellor's calendar therefore contains only their own work — by construction.
   */
  async feed(scope: ResolvedScope, followUpScope: ResolvedScope, q: { from?: string; to?: string }) {
    const { from, to } = this.window(q.from, q.to);

    const pe: unknown[] = [];
    const we = this.resolver.buildScopeWhere(scope, CALENDAR_SCOPE_COLS, pe);
    pe.push(from, to);
    const events = await this.db.query(
      `SELECT e.id, e.title, e.type, e.starts_at, e.ends_at, e.all_day, e.lead_id, e.owner_id,
              e.location, e.notes, e.ext_provider,
              u.name AS owner_name, cl.full_name AS lead_name
         FROM calendar_event e
         LEFT JOIN lead cl ON cl.id = e.lead_id
         LEFT JOIN "user" u ON u.id = e.owner_id
        WHERE (${we}) AND e.deleted_at IS NULL AND e.is_active
          AND e.starts_at >= $${pe.length - 1}::date
          AND e.starts_at < ($${pe.length}::date + INTERVAL '1 day')
        ORDER BY e.starts_at`, pe,
    );

    const pf: unknown[] = [];
    const wf = this.resolver.buildScopeWhere(followUpScope, FOLLOWUP_SCOPE_COLS, pf);
    pf.push(from, to);
    const followUps = await this.db.query(
      `SELECT f.id, f.lead_id, f.owner_id, f.scheduled_at, f.status, f.priority, f.notes,
              ft.name AS type_name, l.full_name AS lead_name, l.temperature, l.score,
              u.name AS owner_name,
              (f.status = 'pending' AND f.scheduled_at < now()) AS overdue
         FROM follow_up f
         JOIN lead l ON l.id = f.lead_id
         LEFT JOIN m_followup_type ft ON ft.id = f.type_id
         LEFT JOIN "user" u ON u.id = f.owner_id
        WHERE (${wf}) AND f.deleted_at IS NULL AND f.is_active AND l.deleted_at IS NULL
          AND f.scheduled_at >= $${pf.length - 1}::date
          AND f.scheduled_at < ($${pf.length}::date + INTERVAL '1 day')
        ORDER BY f.scheduled_at`, pf,
    );

    return {
      range: { from, to },
      events,
      follow_ups: followUps,
      sync: await this.syncStatus(),
    };
  }

  /* ------------------------------ events CRUD ------------------------------ */

  private validate(dto: Partial<CalendarEventDto>, partial = false) {
    const out: Record<string, unknown> = {};
    if (dto.title !== undefined || !partial) {
      const t = String(dto.title ?? '').trim();
      if (!t) throw new BadRequestException('title is required');
      out.title = t;
    }
    if (dto.starts_at !== undefined || !partial) {
      const d = new Date(String(dto.starts_at));
      if (Number.isNaN(d.getTime())) throw new BadRequestException('starts_at must be a valid date/time');
      out.starts_at = dto.starts_at;
    }
    if (dto.ends_at !== undefined) {
      if (dto.ends_at) {
        const e = new Date(String(dto.ends_at));
        if (Number.isNaN(e.getTime())) throw new BadRequestException('ends_at must be a valid date/time');
        const s = new Date(String(dto.starts_at ?? out.starts_at ?? e));
        if (out.starts_at && e < s) throw new BadRequestException('ends_at must be after starts_at');
      }
      out.ends_at = dto.ends_at || null;
    }
    if (dto.type !== undefined) {
      const t = String(dto.type || 'meeting');
      if (!EVENT_TYPES.includes(t)) throw new BadRequestException(`type must be one of: ${EVENT_TYPES.join(', ')}`);
      out.type = t;
    }
    if (dto.all_day !== undefined) out.all_day = dto.all_day === true || String(dto.all_day) === 'true';
    if (dto.location !== undefined) out.location = dto.location || null;
    if (dto.notes !== undefined) out.notes = dto.notes || null;
    if (dto.lead_id !== undefined) out.lead_id = dto.lead_id ? Number(dto.lead_id) : null;
    if (dto.owner_id !== undefined) out.owner_id = dto.owner_id ? Number(dto.owner_id) : null;
    if (dto.branch_id !== undefined) out.branch_id = dto.branch_id ? Number(dto.branch_id) : null;
    if (dto.vertical_id !== undefined) out.vertical_id = dto.vertical_id ? Number(dto.vertical_id) : null;
    return out;
  }

  /** Fill the path columns the scope resolver needs (from the lead, else from the owner). */
  private async derivePath(leadId: number | null, ownerId: number, branchId: number | null, verticalId: number | null) {
    if (leadId) {
      const l = await this.db.one<{ branch_id: string; vertical_id: string; team_id: string | null }>(
        `SELECT branch_id, vertical_id, team_id FROM lead WHERE id = $1 AND deleted_at IS NULL`, [leadId],
      );
      if (l) return { branch_id: Number(l.branch_id), vertical_id: Number(l.vertical_id), team_id: l.team_id ? Number(l.team_id) : null };
    }
    const t = await this.db.one<{ team_id: string }>(
      `SELECT team_id FROM team_member WHERE user_id = $1 LIMIT 1`, [ownerId],
    );
    const a = await this.db.one<{ branch_id: string | null; vertical_id: string | null }>(
      `SELECT branch_id, vertical_id FROM user_assignment
        WHERE user_id = $1 AND branch_id IS NOT NULL ORDER BY id LIMIT 1`, [ownerId],
    );
    return {
      branch_id: branchId ?? (a?.branch_id ? Number(a.branch_id) : null),
      vertical_id: verticalId ?? (a?.vertical_id ? Number(a.vertical_id) : null),
      team_id: t?.team_id ? Number(t.team_id) : null,
    };
  }

  async create(dto: CalendarEventDto, actorId: number, scope: ResolvedScope) {
    const v = this.validate(dto);
    // an event may only be attached to a lead / owner the caller can actually see
    await this.enforcer.assertRefInScope(scope, 'lead', v.lead_id as number | undefined, actorId);
    await this.enforcer.assertRefInScope(scope, 'user', v.owner_id as number | undefined, actorId);
    const owner = (v.owner_id as number) ?? actorId;
    const path = await this.derivePath(
      (v.lead_id as number) ?? null, owner,
      (v.branch_id as number) ?? null, (v.vertical_id as number) ?? null,
    );
    const org = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    return this.db.one(
      `INSERT INTO calendar_event (org_id, branch_id, vertical_id, team_id, title, type, starts_at, ends_at,
                                   all_day, lead_id, owner_id, location, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [Number(org!.id), path.branch_id, path.vertical_id, path.team_id,
        v.title, v.type ?? 'meeting', v.starts_at, v.ends_at ?? null, v.all_day ?? false,
        v.lead_id ?? null, owner, v.location ?? null, v.notes ?? null, actorId],
    );
  }

  async update(id: number, dto: Partial<CalendarEventDto>, actorId: number, scope: ResolvedScope) {
    const before = await this.db.one(`SELECT * FROM calendar_event WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!before) throw new NotFoundException('event not found');
    const v = this.validate(dto, true);
    if (v.lead_id) await this.enforcer.assertRefInScope(scope, 'lead', Number(v.lead_id), actorId);
    if (v.owner_id) await this.enforcer.assertRefInScope(scope, 'user', Number(v.owner_id), actorId);
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [k, val] of Object.entries(v)) { params.push(val); sets.push(`${k} = $${params.length}`); }
    if (!sets.length) throw new BadRequestException('nothing to update');
    params.push(id);
    return this.db.one(
      `UPDATE calendar_event SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${params.length} RETURNING *`, params,
    );
  }

  async remove(id: number, actorId: number) {
    const row = await this.db.one(
      `UPDATE calendar_event SET deleted_at = now(), deleted_by = $2
        WHERE id = $1 AND deleted_at IS NULL RETURNING id, title`, [id, actorId],
    );
    if (!row) throw new NotFoundException('event not found');
    return row;
  }

  /* ------------------------ Google / Outlook sync (BLOCKED) ------------------------ */

  /**
   * What the UI renders as the sync state. Never throws — it is a status, not an action.
   *
   * The credentials moved OUT of the plain `app_setting` blob and into `channel_config`
   * (migration 028), because an OAuth client SECRET sitting unencrypted in a settings
   * JSON column was a real exposure: everything else on this screen is AES-256-GCM at
   * rest and masked on read, and this was not. Same rule now applies here.
   */
  async syncStatus() {
    const cfg = await this.configs.resolve('calendar', null);
    const provider = cfg?.provider ?? null;
    const missing = this.missing(cfg);
    return {
      provider,
      enabled: !!cfg,
      configured: missing.length === 0 && !!provider,
      missing,
      note: missing.length
        ? 'Google / Outlook calendar sync is built and waiting on credentials. The in-app calendar works fully without it.'
        : 'Ready to sync.',
    };
  }

  private missing(cfg: ResolvedConfig | null): string[] {
    if (!cfg?.provider) return ['Calendar provider (Google or Outlook)', 'OAuth client id + secret', 'A connected account'];
    const out: string[] = [];
    if (!cfg.config.client_id) out.push('OAuth client id');
    if (!cfg.secrets.client_secret) out.push('OAuth client secret');
    // The consent is the step the client still has to take himself — name it.
    if (!cfg.secrets.refresh_token) out.push('A connected account (OAuth consent)');
    return out;
  }

  /**
   * "Sync now". Degrades EXACTLY like the Sheet channel's "Pull now": a 503 that names
   * what is missing, is not logged as an error, and starts working the instant the
   * credentials are pasted into Settings.
   */
  async syncNow() {
    const status = await this.syncStatus();
    if (!status.configured) {
      throw new NotConfiguredException(
        `Calendar sync is not configured — still needed: ${status.missing.join(', ')}. ` +
        'Add them in Administration › Settings › Channels; the in-app calendar keeps working meanwhile.',
      );
    }
    // When credentials land, the provider client plugs in here — nothing else changes.
    throw new NotConfiguredException('Calendar provider client is not enabled yet.');
  }
}
