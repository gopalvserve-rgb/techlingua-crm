import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { RbacDataService } from '../rbac/rbac-data.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { REPORT_ENTITIES, ReportEntity, entityByKey } from './entities';
import { BuiltQuery, ReportConfig, buildReportQuery, shapeRow } from './query-builder';
import { toDateString } from '../common/date.util';

export interface Me { id: number; name?: string }

export interface RunResult {
  report?: { id: number; name: string; entity: string } | null;
  entity: string;
  entity_label: string;
  columns: BuiltQuery['columns'];
  rows: unknown[][];
  row_count: number;
  grouped: boolean;
  truncated: boolean;
  /** WHOSE scope the rows were rendered in — echoed back so the UI can SAY it. */
  scope: { user_id: number; unrestricted: boolean; note: string };
  generated_at: string;
}

/**
 * THE REPORT SERVICE.
 *
 * =============================================================================
 * HOW A SHARED REPORT CANNOT LEAK — the one paragraph to read
 * =============================================================================
 * `run()` takes a `me`, not a scope. It then does, in this order:
 *
 *   1. `visible()`  — may this person SEE this definition? (owner, or shared to them
 *                     or to a role they hold, or they have report.read at 'all'.)
 *   2. `scopeFor()` — resolve the ENTITY'S OWN permission FOR THIS PERSON, right now,
 *                     from their live grants. Not from the definition. Not from the
 *                     sharer. Not cached across users.
 *   3. `buildReportQuery()` — which puts that scope INSIDE the WHERE clause.
 *
 * Step 2 is why a Branch Manager can share "Won leads this month" with a counsellor
 * and the counsellor sees his own three, not the branch's forty. The definition never
 * carries a scope; there is nothing to inherit. And if the counsellor lacks the
 * entity's permission entirely (a receipts report shared to a telecaller with no
 * `fee.read`), `buildScopeWhere` returns `1=0` and the report is EMPTY WITH A REASON —
 * not a 500, and not a leak.
 */
@Injectable()
export class ReportService {
  constructor(
    private readonly db: DatabaseService,
    private readonly grants: RbacDataService,
    private readonly resolver: ScopeResolverService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    return Number(r?.id ?? 1);
  }

  /** THE line. Resolve an arbitrary permission for an arbitrary user, live. */
  async scopeFor(userId: number, permission: string): Promise<ResolvedScope> {
    const data = await this.grants.loadUserGrants(userId);
    return this.resolver.resolve(data, permission);
  }

  private async roleIdsOf(userId: number): Promise<number[]> {
    const rows = await this.db.query<{ role_id: string }>(
      `SELECT DISTINCT ua.role_id FROM user_assignment ua WHERE ua.user_id = $1 AND ua.is_active`, [userId],
    );
    return rows.map((r) => Number(r.role_id));
  }

  // ------------------------------------------------------------------ catalog

  /** The entities THIS user may actually build a report on — an entity whose
   *  permission they do not hold is not offered, because offering it and then
   *  returning an empty grid is how a client files a bug against a working rule. */
  async entitiesFor(me: Me): Promise<string[]> {
    const out: string[] = [];
    for (const e of REPORT_ENTITIES) {
      const s = await this.scopeFor(me.id, e.permission);
      if (s.allowed) out.push(e.key);
    }
    return out;
  }

  // -------------------------------------------------------------------- CRUD

  /** Definitions this user may see: their own, shared to them, shared to a role they
   *  hold, or everything if they hold report.read at 'all'. */
  async list(me: Me, scope: ResolvedScope) {
    const roleIds = await this.roleIdsOf(me.id);
    const rows = await this.db.query<any>(
      `SELECT r.id, r.name, r.description, r.entity, r.config, r.owner_id, r.is_standard,
              r.created_at, r.updated_at,
              ow.name AS owner_name,
              (r.owner_id = $1) AS is_mine,
              EXISTS (SELECT 1 FROM report_share s
                       WHERE s.report_id = r.id
                         AND (s.user_id = $1 OR s.role_id = ANY($2::bigint[]))) AS is_shared_to_me,
              (SELECT count(*) FROM report_share s2 WHERE s2.report_id = r.id)::int AS share_count,
              (SELECT count(*) FROM report_schedule sc
                WHERE sc.report_id = r.id AND sc.deleted_at IS NULL AND sc.is_active)::int AS schedule_count
         FROM report_definition r
         LEFT JOIN "user" ow ON ow.id = r.owner_id
        WHERE r.deleted_at IS NULL
          AND ($3::boolean
               OR r.owner_id = $1
               OR r.is_standard
               OR EXISTS (SELECT 1 FROM report_share s3
                           WHERE s3.report_id = r.id
                             AND (s3.user_id = $1 OR s3.role_id = ANY($2::bigint[]))))
        ORDER BY r.is_standard DESC, r.name ASC`,
      [me.id, roleIds, scope.all === true],
    );
    return rows.map((r) => ({
      ...r,
      id: Number(r.id),
      owner_id: r.owner_id == null ? null : Number(r.owner_id),
      entity_label: entityByKey(r.entity)?.label ?? r.entity,
    }));
  }

  private async row(id: number): Promise<any> {
    const r = await this.db.one<any>(
      `SELECT * FROM report_definition WHERE id = $1 AND deleted_at IS NULL`, [id],
    );
    if (!r) throw new NotFoundException('Report not found.');
    return r;
  }

  /** May this user SEE this definition? (Not: which rows.) */
  private async visible(id: number, me: Me, scope: ResolvedScope): Promise<any> {
    const r = await this.row(id);
    if (scope.all === true) return r;
    if (Number(r.owner_id) === me.id) return r;
    if (r.is_standard === true) return r;
    const roleIds = await this.roleIdsOf(me.id);
    const s = await this.db.one<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM report_share s
                       WHERE s.report_id = $1 AND (s.user_id = $2 OR s.role_id = ANY($3::bigint[]))) AS ok`,
      [id, me.id, roleIds],
    );
    if (!s?.ok) throw new NotFoundException('Report not found.');
    return r;
  }

  /** May this user EDIT it? Owner, or an admin with report.update at 'all'. A standard
   *  report is nobody's to edit — "Save as" makes a copy. */
  private mayEdit(r: any, me: Me, scope: ResolvedScope) {
    if (r.is_standard === true) {
      throw new ForbiddenException('This is a standard report. Use "Save as" to make your own copy and change that.');
    }
    if (scope.all === true) return;
    if (Number(r.owner_id) === me.id) return;
    throw new ForbiddenException('Only the report\'s owner can change it. Use "Save as" to make your own copy.');
  }

  async get(id: number, me: Me, scope: ResolvedScope) {
    const r = await this.visible(id, me, scope);
    const shares = await this.db.query<any>(
      `SELECT s.id, s.user_id, s.role_id, u.name AS user_name, ro.name AS role_name
         FROM report_share s
         LEFT JOIN "user" u ON u.id = s.user_id
         LEFT JOIN role ro  ON ro.id = s.role_id
        WHERE s.report_id = $1 ORDER BY s.id`, [id],
    );
    return {
      ...r, id: Number(r.id), owner_id: r.owner_id == null ? null : Number(r.owner_id),
      entity_label: entityByKey(r.entity)?.label ?? r.entity,
      is_mine: Number(r.owner_id) === me.id,
      can_edit: r.is_standard !== true && (scope.all === true || Number(r.owner_id) === me.id),
      shares: shares.map((s) => ({ ...s, id: Number(s.id) })),
    };
  }

  /** VALIDATE THE DEFINITION AT SAVE TIME, not only at run time.
   *  A saved report with a typo in a column key that only fails at 08:00 next Monday,
   *  inside a scheduled email, is a support call. Building the query here (and throwing
   *  it away) means every key, operator and type combination is checked before the row
   *  is written. */
  private validate(entity: ReportEntity, config: ReportConfig, scope: ResolvedScope) {
    buildReportQuery(entity, config, scope, this.resolver);
  }

  async create(dto: any, me: Me, scope: ResolvedScope) {
    const entity = entityByKey(String(dto?.entity ?? ''));
    if (!entity) throw new BadRequestException(`Unknown report data source "${dto?.entity}".`);
    const name = String(dto?.name ?? '').trim();
    if (!name) throw new BadRequestException('A report needs a name.');

    const entScope = await this.scopeFor(me.id, entity.permission);
    if (!entScope.allowed) throw new ForbiddenException(`You do not have access to ${entity.label}.`);

    const config = this.cleanConfig(dto?.config ?? {});
    this.validate(entity, config, entScope);

    const r = await this.db.one<{ id: string }>(
      `INSERT INTO report_definition (org_id, name, description, entity, config, owner_id, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6) RETURNING id`,
      [await this.orgId(), name.slice(0, 160), dto?.description ?? null, entity.key, JSON.stringify(config), me.id],
    );
    return this.get(Number(r!.id), me, scope);
  }

  async update(id: number, dto: any, me: Me, scope: ResolvedScope) {
    const r = await this.visible(id, me, scope);
    this.mayEdit(r, me, scope);
    const entity = entityByKey(String(dto?.entity ?? r.entity));
    if (!entity) throw new BadRequestException(`Unknown report data source "${dto?.entity}".`);
    const entScope = await this.scopeFor(me.id, entity.permission);
    const config = dto?.config === undefined ? (r.config ?? {}) : this.cleanConfig(dto.config);
    this.validate(entity, config, entScope);

    await this.db.query(
      `UPDATE report_definition
          SET name = COALESCE($2, name), description = $3, entity = $4,
              config = $5::jsonb, updated_at = now()
        WHERE id = $1`,
      [id, dto?.name ? String(dto.name).slice(0, 160) : null, dto?.description ?? null, entity.key, JSON.stringify(config)],
    );
    return this.get(id, me, scope);
  }

  async remove(id: number, me: Me, scope: ResolvedScope) {
    const r = await this.visible(id, me, scope);
    this.mayEdit(r, me, scope);
    await this.db.query(
      `UPDATE report_definition SET deleted_at = now(), deleted_by = $2 WHERE id = $1 AND deleted_at IS NULL`, [id, me.id],
    );
    return { id, deleted: true };
  }

  /** Strip anything that is not part of the config contract. Whatever the client sends,
   *  only these keys are ever stored — a `config` blob is not a place to smuggle. */
  private cleanConfig(raw: any): ReportConfig {
    const arr = (v: unknown) => (Array.isArray(v) ? v : []);
    return {
      columns: arr(raw?.columns).map((x) => String(x)),
      filters: arr(raw?.filters).map((f: any) => ({
        col: String(f?.col ?? ''), op: f?.op, value: f?.value ?? null, value2: f?.value2 ?? null,
      })),
      group_by: arr(raw?.group_by).map((x) => String(x)),
      sort: arr(raw?.sort).map((s: any) => ({ col: String(s?.col ?? ''), dir: s?.dir === 'asc' ? 'asc' : 'desc' })),
      date_field: raw?.date_field ? String(raw.date_field) : undefined,
      date_preset: raw?.date_preset ?? 'all',
      date_from: toDateString(raw?.date_from) ?? undefined,
      date_to: toDateString(raw?.date_to) ?? undefined,
      limit: raw?.limit ? Number(raw.limit) : undefined,
    };
  }

  // --------------------------------------------------------------------- share

  async share(id: number, dto: any, me: Me, scope: ResolvedScope) {
    const r = await this.visible(id, me, scope);
    if (r.is_standard !== true) this.mayEdit(r, me, scope);
    const userIds: number[] = (dto?.user_ids ?? []).map(Number).filter(Boolean);
    const roleIds: number[] = (dto?.role_ids ?? []).map(Number).filter(Boolean);

    await this.db.tx(async (c) => {
      await c.query(`DELETE FROM report_share WHERE report_id = $1`, [id]);
      for (const uid of userIds) {
        await c.query(
          `INSERT INTO report_share (report_id, user_id, created_by) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`, [id, uid, me.id],
        );
      }
      for (const rid of roleIds) {
        await c.query(
          `INSERT INTO report_share (report_id, role_id, created_by) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`, [id, rid, me.id],
        );
      }
    });
    return this.get(id, me, scope);
  }

  // ----------------------------------------------------------------------- run

  /**
   * Run a SAVED report as `me`. See the class header for why this is safe.
   */
  async run(id: number, me: Me, scope: ResolvedScope, override?: Partial<ReportConfig>): Promise<RunResult> {
    const r = await this.visible(id, me, scope);
    const entity = entityByKey(r.entity);
    if (!entity) throw new BadRequestException(`This report points at "${r.entity}", which no longer exists.`);
    const config: ReportConfig = { ...(r.config ?? {}), ...(override ?? {}) };
    const out = await this.execute(entity, config, me);
    out.report = { id: Number(r.id), name: r.name, entity: r.entity };
    return out;
  }

  /** Run an UNSAVED definition (the builder's Preview). Same path, same scoping. */
  async preview(dto: any, me: Me): Promise<RunResult> {
    const entity = entityByKey(String(dto?.entity ?? ''));
    if (!entity) throw new BadRequestException(`Unknown report data source "${dto?.entity}".`);
    return this.execute(entity, this.cleanConfig(dto?.config ?? {}), me);
  }

  /** THE one execution path. Every caller — the screen, an export, a scheduled email —
   *  comes through here, so there is exactly one place where scope meets SQL. */
  async execute(entity: ReportEntity, config: ReportConfig, me: Me): Promise<RunResult> {
    const entScope = await this.scopeFor(me.id, entity.permission);
    const q = buildReportQuery(entity, config, entScope, this.resolver);
    const raw = await this.db.query<any>(q.sql, q.params);
    const rows = raw.map((row) => shapeRow(row, q.columns));
    return {
      report: null,
      entity: entity.key,
      entity_label: entity.label,
      columns: q.columns,
      rows,
      row_count: rows.length,
      grouped: q.grouped,
      truncated: rows.length >= Math.min(Number(config.limit) || 500, 50_000),
      scope: {
        user_id: me.id,
        unrestricted: entScope.all === true,
        // The UI prints this sentence under the grid. A report the client cannot
        // attribute is a report he argues with.
        note: !entScope.allowed
          ? `You do not have access to ${entity.label}, so this report is empty.`
          : entScope.all === true
            ? 'Showing all records — your role is not restricted for this data.'
            : 'Showing only the records your role gives you access to.',
      },
      generated_at: new Date().toISOString(),
    };
  }
}
