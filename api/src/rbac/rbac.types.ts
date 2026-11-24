/** Shared RBAC types used by the scope resolver, guard and query builders. */

export type RecordScope = 'own' | 'team' | 'branch' | 'vertical' | 'pipeline' | 'campaign' | 'all';

/** One active user_assignment row (a role granted on a unit). */
export interface Assignment {
  roleId: number;
  branchId: number | null;
  verticalId: number | null;
  pipelineId: number | null;
  campaignId: number | null;
  teamId: number | null;
}

/** One role_permission row. */
export interface RolePermissionGrant {
  roleId: number;
  permissionKey: string;
  recordScope: RecordScope;
  /** { allow: [...] } or { deny: [...] } — NULL = all fields */
  fieldScope: { allow?: string[]; deny?: string[] } | null;
}

/** Everything the resolver needs about one user, loaded once per request. */
export interface UserGrantData {
  userId: number;
  assignments: Assignment[];
  rolePermissions: RolePermissionGrant[];
  /** Teams the user belongs to or leads (used when a grant is team-scoped but the assignment has no team_id). */
  teamIds: number[];
}

/** A single OR-branch of the record filter (one per contributing grant). */
export interface ScopeFilter {
  kind: 'own' | 'team' | 'branch' | 'vertical' | 'pipeline' | 'campaign';
  userId?: number;
  teamIds?: number[];
  branchId?: number;
  verticalId?: number;
  pipelineId?: number;
  campaignId?: number;
  /**
   * FB-2026-003 — set when a branch/vertical/pipeline-level grant was NARROWED to a more specific
   * unit named on the assignment (a Branch Manager added to Vikaspuri with only two of its verticals
   * gets those two verticals, not the whole branch). `within` is the unit the grant itself is at:
   * an entity that has no column for the narrower unit (stock, the branch row itself) is filtered
   * by `within` instead — exactly what it got before, never more.
   */
  within?: { kind: 'branch' | 'vertical' | 'pipeline'; id: number };
}

/** Result of resolving a permission for a user: allowed + the unioned record scope + field scope. */
export interface ResolvedScope {
  permissionKey: string;
  allowed: boolean;
  /** true = unrestricted (some grant had record_scope 'all', or a scoped grant had no narrowing unit). */
  all: boolean;
  /** OR-united filters when not `all`. */
  filters: ScopeFilter[];
  /** null = all fields readable/writable; otherwise the union of allowed field keys. */
  allowedFields: string[] | null;
  /** fields denied by every contributing grant (deny only sticks if unanimous). */
  deniedFields: string[];
  /**
   * FRANCHISE-OWNER LAYER (Phase 4 Batch 3). When the caller is a franchise owner this
   * holds their franchise's mapped branch_ids and every branch-bearing query is AND-narrowed
   * to it (see buildScopeWhere). `null`/undefined = not an owner -> no effect (zero regression).
   * `[]` = an owner whose franchise maps no branches -> branch entities resolve to no rows.
   */
  franchiseBranchIds?: number[] | null;
}

/** Column names used to translate ScopeFilters into SQL for a given entity/alias. */
export interface ScopeColumnMap {
  owner?: string;     // e.g. 'l.owner_id'  (own)
  team?: string;      // e.g. 'l.team_id'   (team)
  branch?: string;    // e.g. 'l.branch_id'
  vertical?: string;
  pipeline?: string;
  campaign?: string;
}
