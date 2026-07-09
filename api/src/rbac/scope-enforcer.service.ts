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
  | 'team' | 'user' | 'assignment' | 'master' | 'lead' | 'follow_up';

export interface EntityScopeDef {
  /** FROM clause; the scope-bearing alias must expose the path columns used in `cols`. */
  from: string;
  /** Column the :id route param matches. */
  idCol: string;
  cols: ScopeColumnMap;
}

/** How each by-ID entity maps onto the hierarchy path (single registry). */
export const ENTITY_SCOPE: Record<Exclude<ScopedEntityKind, 'user' | 'master'>, EntityScopeDef> = {
  // Sprint 2: leads carry the full path; follow-ups scope through their lead
  // (own = the follow-up's owner, so agents always see their own follow-ups).
  lead: {
    from: 'lead e', idCol: 'e.id',
    cols: {
      owner: 'e.owner_id', team: 'e.team_id', branch: 'e.branch_id',
      vertical: 'e.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id',
    },
  },
  follow_up: {
    from: 'follow_up fu JOIN lead e ON e.id = fu.lead_id', idCol: 'fu.id',
    cols: {
      owner: 'fu.owner_id', team: 'e.team_id', branch: 'e.branch_id',
      vertical: 'e.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id',
    },
  },
  branch: { from: 'branch e', idCol: 'e.id', cols: { branch: 'e.id' } },
  vertical: { from: 'vertical e', idCol: 'e.id', cols: { branch: 'e.branch_id', vertical: 'e.id' } },
  pipeline: {
    from: 'pipeline e', idCol: 'e.id',
    cols: { branch: 'e.branch_id', vertical: 'e.vertical_id', pipeline: 'e.id' },
  },
  stage: {
    from: 'pipeline_stage st JOIN pipeline e ON e.id = st.pipeline_id', idCol: 'st.id',
    cols: { branch: 'e.branch_id', vertical: 'e.vertical_id', pipeline: 'e.id' },
  },
  campaign: {
    from: 'campaign e', idCol: 'e.id',
    cols: { branch: 'e.branch_id', vertical: 'e.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.id' },
  },
  source: {
    from: 'source e', idCol: 'e.id',
    cols: { branch: 'e.branch_id', vertical: 'e.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id' },
  },
  team: { from: 'team e', idCol: 'e.id', cols: { team: 'e.id', branch: 'e.branch_id', vertical: 'e.vertical_id' } },
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
   */
  async assertInScope(scope: ResolvedScope, kind: ScopedEntityKind, id: number, requesterId?: number): Promise<void> {
    if (!scope || !scope.allowed) throw this.notFound(kind); // defensive; PermissionsGuard already 403s
    if (scope.all) return;

    // Masters are org-level (no branch/vertical columns). Consistent with the
    // resolver's rule — entities lacking a scoped column DENY rather than widen —
    // a non-'all' grant cannot touch a master by id.
    if (kind === 'master') throw this.notFound(kind);

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
          WHERE u.id = $${idIdx} AND ((${where}) OR u.id = $${params.length})
          LIMIT 1`,
        params,
      );
      if (!row) throw this.notFound(kind);
      return;
    }

    const def = ENTITY_SCOPE[kind];
    const params: unknown[] = [];
    const where = this.resolver.buildScopeWhere(scope, def.cols, params);
    if (where === '1=0') throw this.notFound(kind); // no filter maps onto this entity -> deny
    params.push(id);
    const row = await this.db.one(
      `SELECT 1 AS ok FROM ${def.from} WHERE ${def.idCol} = $${params.length} AND (${where}) LIMIT 1`,
      params,
    );
    if (!row) throw this.notFound(kind);
  }

  private notFound(kind: ScopedEntityKind): NotFoundException {
    // Same message whether the row is missing or out of scope (no existence oracle).
    return new NotFoundException(`${kind} not found`);
  }
}
