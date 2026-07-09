import { Injectable } from '@nestjs/common';
import {
  Assignment, RecordScope, ResolvedScope, ScopeColumnMap, ScopeFilter, UserGrantData,
} from './rbac.types';

/**
 * THE central RBAC policy service (TECH_ARCH §4 — "the crux").
 *
 * Resolution rules:
 *  1. A user may hold many assignments (role × unit). For a permission key, every
 *     (assignment, role_permission) pair contributes one grant.
 *  2. Grants are UNIONED — the user sees the union of everything any grant allows.
 *     If any grant has record_scope 'all', the result is unrestricted.
 *  3. A scoped grant is narrowed by its assignment's unit columns. If the grant's
 *     scope level is missing on the assignment we fall back to the nearest defined
 *     ANCESTOR (pipeline -> vertical -> branch). An assignment with no unit at all
 *     grants org-wide access at that scope (single-tenant: org == everything).
 *  4. 'own'  -> rows owned by the user.  'team' -> rows of the assignment's team,
 *     or all teams the user leads/belongs to if the assignment has no team.
 *  5. Field scope: most-permissive union. Any grant with NULL field_scope => all
 *     fields. Otherwise allow-lists union; a deny only survives if every grant denies.
 *
 * The service is pure/deterministic over UserGrantData so it is unit-testable
 * without a database (see scope-resolver.service.spec.ts).
 */
@Injectable()
export class ScopeResolverService {
  resolve(data: UserGrantData, permissionKey: string): ResolvedScope {
    const notAllowed: ResolvedScope = {
      permissionKey, allowed: false, all: false, filters: [], allowedFields: null, deniedFields: [],
    };

    const byRole = new Map<number, { recordScope: RecordScope; fieldScope: { allow?: string[]; deny?: string[] } | null }[]>();
    for (const rp of data.rolePermissions) {
      if (rp.permissionKey !== permissionKey) continue;
      const list = byRole.get(rp.roleId) ?? [];
      list.push({ recordScope: rp.recordScope, fieldScope: rp.fieldScope });
      byRole.set(rp.roleId, list);
    }
    if (byRole.size === 0) return notAllowed;

    const filters: ScopeFilter[] = [];
    let all = false;
    let anyGrant = false;

    // field-scope union
    let unrestrictedFields = false;
    const allowUnion = new Set<string>();
    const denyLists: string[][] = [];

    for (const a of data.assignments) {
      const grants = byRole.get(a.roleId);
      if (!grants) continue;
      for (const g of grants) {
        anyGrant = true;

        // record scope
        const f = this.toFilter(g.recordScope, a, data);
        if (f === 'all') all = true;
        else if (f) filters.push(f);

        // field scope
        if (!g.fieldScope || (!g.fieldScope.allow && !g.fieldScope.deny)) unrestrictedFields = true;
        else {
          (g.fieldScope.allow ?? []).forEach((k) => allowUnion.add(k));
          denyLists.push(g.fieldScope.deny ?? []);
        }
      }
    }
    if (!anyGrant) return notAllowed; // role has the permission but user holds no assignment for that role

    // deny sticks only if unanimous across restricted grants and no unrestricted grant exists
    const deniedFields = unrestrictedFields || denyLists.length === 0
      ? []
      : denyLists.reduce((acc, list) => acc.filter((k) => list.includes(k)));

    return {
      permissionKey,
      allowed: true,
      all,
      filters: all ? [] : this.dedupe(filters),
      allowedFields: unrestrictedFields ? null : (allowUnion.size ? [...allowUnion] : null),
      deniedFields,
    };
  }

  /** Map one (recordScope × assignment) to a filter. Returns 'all' when unrestricted. */
  private toFilter(scope: RecordScope, a: Assignment, data: UserGrantData): ScopeFilter | 'all' | null {
    switch (scope) {
      case 'all':
        return 'all';
      case 'own':
        return { kind: 'own', userId: data.userId };
      case 'team': {
        const teamIds = a.teamId != null ? [a.teamId] : data.teamIds;
        if (!teamIds.length) return { kind: 'own', userId: data.userId }; // no team -> degrade to own
        return { kind: 'team', teamIds };
      }
      case 'campaign':
        if (a.campaignId != null) return { kind: 'campaign', campaignId: a.campaignId };
        return this.toFilter('pipeline', a, data);
      case 'pipeline':
        if (a.pipelineId != null) return { kind: 'pipeline', pipelineId: a.pipelineId };
        return this.toFilter('vertical', a, data);
      case 'vertical':
        if (a.verticalId != null) return { kind: 'vertical', verticalId: a.verticalId };
        return this.toFilter('branch', a, data);
      case 'branch':
        if (a.branchId != null) return { kind: 'branch', branchId: a.branchId };
        return 'all'; // no unit on the assignment -> org-wide
    }
  }

  private dedupe(filters: ScopeFilter[]): ScopeFilter[] {
    const seen = new Set<string>();
    return filters.filter((f) => {
      const key = JSON.stringify(f);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Translate a ResolvedScope into a parameterised SQL WHERE fragment.
   * `params` is mutated (push) so the fragment composes with an existing query.
   * Filters for which the entity has no matching column are skipped conservatively
   * (i.e. they do NOT widen access; if nothing matches, access is denied).
   */
  buildScopeWhere(scope: ResolvedScope, cols: ScopeColumnMap, params: unknown[]): string {
    if (!scope.allowed) return '1=0';
    if (scope.all) return '1=1';

    const parts: string[] = [];
    for (const f of scope.filters) {
      switch (f.kind) {
        case 'own':
          if (cols.owner) { params.push(f.userId); parts.push(`${cols.owner} = $${params.length}`); }
          break;
        case 'team':
          if (cols.team) { params.push(f.teamIds); parts.push(`${cols.team} = ANY($${params.length}::bigint[])`); }
          break;
        case 'branch':
          if (cols.branch) { params.push(f.branchId); parts.push(`${cols.branch} = $${params.length}`); }
          break;
        case 'vertical':
          if (cols.vertical) { params.push(f.verticalId); parts.push(`${cols.vertical} = $${params.length}`); }
          break;
        case 'pipeline':
          if (cols.pipeline) { params.push(f.pipelineId); parts.push(`${cols.pipeline} = $${params.length}`); }
          break;
        case 'campaign':
          if (cols.campaign) { params.push(f.campaignId); parts.push(`${cols.campaign} = $${params.length}`); }
          break;
      }
    }
    if (!parts.length) return '1=0';
    return `(${parts.join(' OR ')})`;
  }
}
