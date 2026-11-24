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
 *     The other way round, an assignment that names a unit BELOW the grant's level narrows
 *     it to that unit (branch grant + "Vertical access: BCL VKP" = BCL VKP only — FB-2026-003).
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

  /**
   * Map one (recordScope × assignment) to a filter. Returns 'all' when unrestricted.
   *
   * FB-2026-003 — a unit-level grant is NARROWED by the assignment: a grant at branch level on an
   * assignment that also names a vertical (or a pipeline / campaign) covers that unit only. "Branch
   * access: Vikaspuri · Vertical access: BCL VKP, INSTA VKP" means those two verticals — not every
   * vertical in Vikaspuri (the client: "in the branch of Vikaspuri he should access only as much as
   * he is added to"). An assignment that names only the branch still gets the whole branch.
   */
  private toFilter(scope: RecordScope, a: Assignment, data: UserGrantData): ScopeFilter | 'all' | null {
    const f = this.toFilterAtLevel(scope, a, data);
    if (f === 'all' || f === null) return f;
    const level = f.kind;
    if (level !== 'branch' && level !== 'vertical' && level !== 'pipeline') return f;
    const id = level === 'branch' ? f.branchId! : level === 'vertical' ? f.verticalId! : f.pipelineId!;
    const within = { kind: level, id };
    // the units named on the assignment BELOW the grant's level — the most specific one is the
    // filter; the ones in between are kept so an entity without that column falls back one level
    // at a time (campaign → pipeline → vertical → the grant's own unit), never further.
    const vert = level === 'branch' && a.verticalId != null ? a.verticalId : undefined;
    const pipe = level !== 'pipeline' && a.pipelineId != null ? a.pipelineId : undefined;
    if (a.campaignId != null) {
      return { kind: 'campaign', campaignId: a.campaignId, ...(pipe != null ? { pipelineId: pipe } : {}), ...(vert != null ? { verticalId: vert } : {}), within };
    }
    if (pipe != null) return { kind: 'pipeline', pipelineId: pipe, ...(vert != null ? { verticalId: vert } : {}), within };
    if (vert != null) return { kind: 'vertical', verticalId: vert, within };
    return f;
  }

  private toFilterAtLevel(scope: RecordScope, a: Assignment, data: UserGrantData): ScopeFilter | 'all' | null {
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
        return this.toFilterAtLevel('pipeline', a, data);
      case 'pipeline':
        if (a.pipelineId != null) return { kind: 'pipeline', pipelineId: a.pipelineId };
        return this.toFilterAtLevel('vertical', a, data);
      case 'vertical':
        if (a.verticalId != null) return { kind: 'vertical', verticalId: a.verticalId };
        return this.toFilterAtLevel('branch', a, data);
      case 'branch':
        if (a.branchId != null) return { kind: 'branch', branchId: a.branchId };
        return 'all'; // no unit on the assignment -> org-wide
    }
  }

  private static hasCol(kind: ScopeFilter['kind'], cols: ScopeColumnMap): boolean {
    return !!(kind === 'campaign' ? cols.campaign : kind === 'pipeline' ? cols.pipeline : kind === 'vertical' ? cols.vertical
      : kind === 'branch' ? cols.branch : kind === 'own' ? cols.owner : cols.team);
  }

  /** For a narrowed filter: the closest unit above it (on the same assignment) that the entity has a column for. */
  static fallback(f: ScopeFilter, cols: ScopeColumnMap): { col: string; id: number } | null {
    if (f.kind === 'campaign' && f.pipelineId != null && cols.pipeline) return { col: cols.pipeline, id: f.pipelineId };
    if ((f.kind === 'campaign' || f.kind === 'pipeline') && f.verticalId != null && cols.vertical) return { col: cols.vertical, id: f.verticalId };
    const w = f.within;
    if (!w) return null;
    const col = w.kind === 'branch' ? cols.branch : w.kind === 'vertical' ? cols.vertical : cols.pipeline;
    return col ? { col, id: w.id } : null;
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

    // Base fragment from the caller's role grants (the pre-existing behaviour).
    let base: string;
    if (scope.all) {
      base = '1=1';
    } else {
      const parts: string[] = [];
      for (const f of scope.filters) {
        // FB-2026-003 — a narrowed filter on an entity without that unit's column: the next unit up
        // that the entity has (pipeline → vertical → the grant's own unit). Never wider than before.
        if (f.within && !ScopeResolverService.hasCol(f.kind, cols)) {
          const up = ScopeResolverService.fallback(f, cols);
          if (up) { params.push(up.id); parts.push(`${up.col} = $${params.length}`); }
          continue;
        }
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
      base = parts.length ? `(${parts.join(' OR ')})` : '1=0';
    }

    // FRANCHISE-OWNER LAYER (Phase 4 Batch 3). When the caller is a franchise owner,
    // every branch-bearing query is additionally AND-narrowed to their franchise's
    // branch_ids — so an owner sees ONLY their franchise's data across leads / students
    // / finance / everything that carries a branch. Non-owners (franchiseBranchIds is
    // null/undefined) are entirely unaffected: base is returned verbatim (zero regression).
    const fb = scope.franchiseBranchIds;
    if (!Array.isArray(fb)) return base;
    if (!cols.branch) return base;         // org-level entity (masters, etc.) — cannot narrow by branch; leave as-is
    if (base === '1=0') return '1=0';
    if (fb.length === 0) return '1=0';     // owner whose franchise maps no branches -> no rows
    params.push(fb);
    const clause = `${cols.branch} = ANY($${params.length}::bigint[])`;
    return base === '1=1' ? `(${clause})` : `(${base} AND ${clause})`;
  }
}
