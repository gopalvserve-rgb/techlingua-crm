import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from './scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from './rbac.types';

/**
 * Central record-scope enforcement for BY-ID reads and mutations (QA DEF-1).
 *
 * List endpoints already filter through buildScopeWhere; this service applies the
 * SAME resolved scope to single-row access so a scoped user cannot read or mutate
 * a record outside their scope by guessing its id.
 *
 * POLICY (documented, deliberate): out-of-scope ids return **404 Not Found** — the
 * same status as a nonexistent id — so responses never disclose whether a record
 * exists outside the caller's scope (no existence oracle). The QA harness accepts
 * 403 or 404; we standardise on 404.
 *
 * Entities are registered once in ENTITY_SCOPE below; controllers opt in with the
 * @ScopedEntity(kind) decorator (see RecordScopeGuard) — no per-endpoint patches.
 */

export type ScopedEntityKind =
  | 'branch' | 'vertical' | 'pipeline' | 'stage' | 'campaign' | 'source'
  | 'team' | 'user' | 'assignment' | 'master' | 'lead' | 'follow_up' | 'error_log';

export interface EntityScopeDef {
  /** FROM clause; the scope-bearing alias must expose the path columns used in `cols`. */
  from: string;
  /** Column the :id route param matches. */
  idCol: string;
  cols: ScopeColumnMap;
  /** Soft delete (015): extra live-rows condition; deleted rows fall out of
   *  scoping lookups so scoped by-ID access to them 404s like nonexistent ids. */
  alive?: string;
}

/** How each by-ID entity maps onto the hierarchy path (single registry). */
export const ENTITY_SCOPE: Record<Exclude<ScopedEntityKind, 'user' | 'master' | 'error_log'>, EntityScopeDef> = {
  // Sprint 2: leads carry the full path; follow-ups scope through their lead
  // (own = the follow-up's owner, so agents always see their own follow-ups).
  lead: {
    from: 'lead e', idCol: 'e.id', alive: 'e.deleted_at IS NULL',
    cols: {
      owner: 'e.owner_id', team: 'e.team_id', branch: 'e.branch_id',
      vertical: 'e.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id',
    },
  },
  follow_up: {
    from: 'follow_up fu JOIN lead e ON e.id = fu.lead_id', idCol: 'fu.id', alive: 'fu.deleted_at IS NULL',
    cols: {
      owner: 'fu.owner_id', team: 'e.team_id', branch: 'e.branch_id',
      vertical: 'e.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id',
    },
  },
  branch: { from: 'branch e', idCol: 'e.id', alive: 'e.deleted_at IS NULL', cols: { branch: 'e.id' } },
  vertical: { from: 'vertical e', idCol: 'e.id', alive: 'e.deleted_at IS NULL', cols: { branch: 'e.branch_id', vertical: 'e.id' } },
  pipeline: {
    from: 'pipeline e', idCol: 'e.id', alive: 'e.deleted_at IS NULL',
    cols: { branch: 'e.branch_id', vertical: 'e.vertical_id', pipeline: 'e.id' },
  },
  stage: {
    from: 'pipeline_stage st JOIN pipeline e ON e.id = st.pipeline_id', idCol: 'st.id',
    alive: 'e.deleted_at IS NULL',
    cols: { branch: 'e.branch_id', vertical: 'e.vertical_id', pipeline: 'e.id' },
  },
  campaign: {
    from: 'campaign e', idCol: 'e.id', alive: 'e.deleted_at IS NULL',
    cols: { branch: 'e.branch_id', vertical: 'e.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.id' },
  },
  source: {
    from: 'source e', idCol: 'e.id', alive: 'e.deleted_at IS NULL',
    cols: { branch: 'e.branch_id', vertical: 'e.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id' },
  },
  team: { from: 'team e', idCol: 'e.id', alive: 'e.deleted_at IS NULL', cols: { team: 'e.id', branch: 'e.branch_id', vertical: 'e.vertical_id' } },
  assignment: {
    from: 'user_assignment e', idCol: 'e.id',
    cols: {
      owner: 'e.user_id', branch: 'e.branch_id', vertical: 'e.vertical_id',
      pipeline: 'e.pipeline_id', campaign: 'e.campaign_id',
    },
  },
};

@Injectable()
export class ScopeEnforcerService {
  constructor(private readonly db: DatabaseService, private readonly resolver: ScopeResolverService) {}

  /**
   * Throws NotFoundException (404) unless `id` of `kind` falls inside the resolved scope.
   * `requesterId` is used for the users entity (a user is always in their own scope,
   * mirroring the users-list semantics).
   *
   * STRICT variant (by-ID routes): if none of the caller's filters map onto the
   * entity (e.g. an own-scoped grant touching an org-level master), access is DENIED.
   */
  async assertInScope(scope: ResolvedScope, kind: ScopedEntityKind, id: number, requesterId?: number): Promise<void> {
    const r = await this.check(scope, kind, id, requesterId);
    if (r !== 'ok') throw this.notFound(kind);
  }

  /**
   * Body-reference scope check (QA DEF-QA4-03): validates an entity id referenced in
   * a request BODY (follow-up lead_id, lead owner_id/campaign_id/team_id, team
   * member ids, assignment units, ...) against the caller's resolved scope. Same
   * 404 policy as assertInScope, with ONE deliberate difference: when none of the
   * caller's filters map onto the referenced entity kind (e.g. an 'own'-scoped
   * counsellor referencing a campaign — campaigns have no owner column), the
   * reference is ALLOWED: the caller's scope does not constrain that dimension,
   * and denying would make lead creation impossible for own-scoped agents.
   * By-ID route access keeps the strict deny (assertInScope). `null`/`undefined`
   * ids are skipped — required-field validation stays in the services.
   */
  async assertRefInScope(
    scope: ResolvedScope, kind: ScopedEntityKind, id: number | null | undefined, requesterId?: number,
  ): Promise<void> {
    if (id == null) return;
    const r = await this.check(scope, kind, Number(id), requesterId);
    if (r === 'miss') throw this.notFound(kind);
  }

  /**
   * Bulk record-scope filter (bulk delete, Aug 2026): the subset of `ids` (all of `kind`)
   * that fall INSIDE the resolved scope, in ONE query. Mirrors assertInScope semantics:
   * scope.all -> every id; org-level kinds (master/error_log) -> [] for any non-'all' grant
   * (strict deny, same as the by-ID routes); unmapped hierarchy filter -> []. Ids absent from
   * the result were out of scope / gone and are reported as "skipped" by the caller.
   */
  async filterInScope(
    scope: ResolvedScope, kind: ScopedEntityKind, ids: number[], requesterId?: number,
  ): Promise<number[]> {
    const uniq = [...new Set((ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!uniq.length) return [];
    if (!scope || !scope.allowed) return [];
    if (scope.all) return uniq;
    if (kind === 'master' || kind === 'error_log') return [];

    if (kind === 'user') {
      const params: unknown[] = [];
      const where = this.resolver.buildScopeWhere(scope, {
        owner: 'u.id', team: 'tm.team_id', branch: 'ua.branch_id',
        vertical: 'ua.vertical_id', pipeline: 'ua.pipeline_id', campaign: 'ua.campaign_id',
      }, params);
      params.push(uniq);
      const idsIdx = params.length;
      params.push(requesterId ?? -1);
      const rows = await this.db.query<{ id: string }>(
        `SELECT DISTINCT u.id FROM "user" u
           LEFT JOIN user_assignment ua ON ua.user_id = u.id AND ua.is_active
           LEFT JOIN team_member tm ON tm.user_id = u.id
          WHERE u.id = ANY($${idsIdx}::bigint[]) AND u.deleted_at IS NULL AND ((${where}) OR u.id = $${params.length})`,
        params,
      );
      return rows.map((r) => Number(r.id));
    }

    const def = ENTITY_SCOPE[kind];
    const params: unknown[] = [];
    const where = this.resolver.buildScopeWhere(scope, def.cols, params);
    if (where === '1=0') return [];
    params.push(uniq);
    const alive = def.alive ? ` AND ${def.alive}` : '';
    const rows = await this.db.query<{ id: string }>(
      `SELECT ${def.idCol} AS id FROM ${def.from} WHERE ${def.idCol} = ANY($${params.length}::bigint[])${alive} AND (${where})`,
      params,
    );
    return rows.map((r) => Number(r.id));
  }

  /** Shared core: 'ok' in scope · 'miss' out of scope/nonexistent · 'unmapped' scope has no filter for this kind. */
  private async check(
    scope: ResolvedScope, kind: ScopedEntityKind, id: number, requesterId?: number,
  ): Promise<'ok' | 'miss' | 'unmapped'> {
    if (!scope || !scope.allowed) return 'miss'; // defensive; PermissionsGuard already 403s
    if (scope.all) return 'ok';

    // Masters & error logs are org-level (no branch/vertical columns). Consistent with the
    // resolver's rule — entities lacking a scoped column can't be narrowed —
    // they are 'unmapped' for any non-'all' grant (strict deny for by-ID access).
    if (kind === 'master' || kind === 'error_log') return 'unmapped';

    if (kind === 'user') {
      // Same semantics as UsersService.list: in scope if the target holds >=1 active
      // assignment inside scope, is a member of an in-scope team, or is the requester.
      const params: unknown[] = [];
      const where = this.resolver.buildScopeWhere(scope, {
        owner: 'u.id', team: 'tm.team_id', branch: 'ua.branch_id',
        vertical: 'ua.vertical_id', pipeline: 'ua.pipeline_id', campaign: 'ua.campaign_id',
      }, params);
      params.push(id);
      const idIdx = params.length;
      params.push(requesterId ?? -1);
      const row = await this.db.one(
        `SELECT 1 AS ok FROM "user" u
           LEFT JOIN user_assignment ua ON ua.user_id = u.id AND ua.is_active
           LEFT JOIN team_member tm ON tm.user_id = u.id
          WHERE u.id = $${idIdx} AND u.deleted_at IS NULL AND ((${where}) OR u.id = $${params.length})
          LIMIT 1`,
        params,
      );
      return row ? 'ok' : 'miss';
    }

    const def = ENTITY_SCOPE[kind];
    const params: unknown[] = [];
    const where = this.resolver.buildScopeWhere(scope, def.cols, params);
    if (where === '1=0') return 'unmapped'; // no filter maps onto this entity
    params.push(id);
    const alive = def.alive ? ` AND ${def.alive}` : '';
    const row = await this.db.one(
      `SELECT 1 AS ok FROM ${def.from} WHERE ${def.idCol} = $${params.length}${alive} AND (${where}) LIMIT 1`,
      params,
    );
    return row ? 'ok' : 'miss';
  }

  private notFound(kind: ScopedEntityKind): NotFoundException {
    // Same message whether the row is missing or out of scope (no existence oracle).
    return new NotFoundException(`${kind} not found`);
  }
}
