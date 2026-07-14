/**
 * SOFT DELETE — central entity registry (one place, every module).
 *
 * SEMANTICS (deleted != inactive — see migration 015):
 *  - Soft delete marks ONLY the row itself (`deleted_at`/`deleted_by`); children
 *    and related records are never touched. Deleted rows are excluded from all
 *    lists, dropdowns, KPIs, summaries, dedupe checks and scoping lookups by
 *    default; display joins keep them so a child can render "(deleted)" in its
 *    path. By-ID GET of a deleted row -> 404.
 *  - Impact preview: every dependent below is counted (live rows only) and
 *    sampled by name BEFORE deletion so the user sees the full association
 *    hierarchy ("where this id is used").
 *  - Restore is blocked (409) while any ancestor in `parents` is itself deleted.
 *
 * Registering an entity here gives it /impact, DELETE and /restore uniformly.
 */
import { MASTER_TYPES } from '../masters/masters.service';
import type { ScopedEntityKind } from '../rbac/scope-enforcer.service';

/** Live-rows condition — the ONE fragment every dependent count must carry. */
export const ALIVE = 'deleted_at IS NULL';

export interface DependentDef {
  /** stable key in the impact payload, e.g. 'verticals' */
  key: string;
  label: string;
  /** SELECT COUNT(*) source — `FROM …[ JOIN …] WHERE …$1…` (must filter ALIVE) */
  from: string;
  where: string;
  /** expression yielding a display name for samples */
  nameExpr: string;
}

export interface ParentDef {
  label: string;
  /** SQL returning (name, deleted) for this ancestor of row $1 */
  sql: string;
}

export interface DeletableDef {
  key: string;
  label: string;
  table: string;             // quoted where needed ("user")
  nameExpr: string;          // display-name column/expression on the table
  permission: string;        // '<module>.delete' — required for impact + delete
  scopedKind?: ScopedEntityKind; // record-scope enforcement on by-ID routes
  parents: ParentDef[];      // ancestors that block restore while deleted
  dependents: DependentDef[];
}

const dep = (key: string, label: string, from: string, where: string, nameExpr: string): DependentDef =>
  ({ key, label, from, where, nameExpr });

/** Dependents shared by the hierarchy levels — `col` is the denormalised path
 *  column on each child table (full-path denormalisation = no recursive joins). */
function hierarchyDeps(col: string, levelsBelow: Array<'vertical' | 'pipeline' | 'campaign' | 'source'>): DependentDef[] {
  const out: DependentDef[] = [];
  if (levelsBelow.includes('vertical')) out.push(dep('verticals', 'Verticals', 'vertical d', `d.${col} = $1 AND d.${ALIVE}`, 'd.name'));
  if (levelsBelow.includes('pipeline')) out.push(dep('pipelines', 'Pipelines', 'pipeline d', `d.${col} = $1 AND d.${ALIVE}`, 'd.name'));
  if (levelsBelow.includes('campaign')) out.push(dep('campaigns', 'Campaigns', 'campaign d', `d.${col} = $1 AND d.${ALIVE}`, 'd.name'));
  if (levelsBelow.includes('source')) out.push(dep('sources', 'Sources', 'source d', `d.${col} = $1 AND d.${ALIVE}`, 'd.name'));
  out.push(
    dep('leads', 'Leads', 'lead d', `d.${col} = $1 AND d.${ALIVE}`, 'd.full_name'),
    dep('users', 'Users assigned', `(SELECT DISTINCT u.id, u.name FROM "user" u JOIN user_assignment ua ON ua.user_id = u.id AND ua.is_active WHERE ua.${col} = $1 AND u.deleted_at IS NULL) d`, 'TRUE', 'd.name'),
    dep('follow_ups', 'Follow-ups', 'follow_up d JOIN lead l ON l.id = d.lead_id', `l.${col} = $1 AND d.${ALIVE}`, `l.full_name || ' · ' || to_char(d.scheduled_at, 'DD Mon')`),
  );
  return out;
}

const teamDep = (col: string) =>
  dep('teams', 'Teams', 'team d', `d.${col} = $1 AND d.${ALIVE}`, 'd.name');

/** Ancestor chain rows for restore-blocking + path display, via the row's FKs. */
const parentVia = (childTable: string, joins: Array<[label: string, table: string, fk: string]>): ParentDef[] =>
  joins.map(([label, table, fk]) => ({
    label,
    sql: `SELECT p.name AS name, (p.deleted_at IS NOT NULL) AS deleted
            FROM ${childTable} c JOIN ${table} p ON p.id = c.${fk} WHERE c.id = $1`,
  }));

export const DELETE_REGISTRY: Record<string, DeletableDef> = {
  branch: {
    key: 'branch', label: 'Branch', table: 'branch', nameExpr: 'name',
    permission: 'branch.delete', scopedKind: 'branch', parents: [],
    dependents: [...hierarchyDeps('branch_id', ['vertical', 'pipeline', 'campaign', 'source']), teamDep('branch_id')],
  },
  vertical: {
    key: 'vertical', label: 'Vertical', table: 'vertical', nameExpr: 'name',
    permission: 'vertical.delete', scopedKind: 'vertical',
    parents: parentVia('vertical', [['Branch', 'branch', 'branch_id']]),
    dependents: [...hierarchyDeps('vertical_id', ['pipeline', 'campaign', 'source']), teamDep('vertical_id')],
  },
  pipeline: {
    key: 'pipeline', label: 'Pipeline', table: 'pipeline', nameExpr: 'name',
    permission: 'pipeline.delete', scopedKind: 'pipeline',
    parents: parentVia('pipeline', [['Branch', 'branch', 'branch_id'], ['Vertical', 'vertical', 'vertical_id']]),
    dependents: [
      dep('stages', 'Stages', 'pipeline_stage d', `d.pipeline_id = $1 AND d.${ALIVE}`, 'd.name'),
      ...hierarchyDeps('pipeline_id', ['campaign', 'source']),
    ],
  },
  campaign: {
    key: 'campaign', label: 'Campaign', table: 'campaign', nameExpr: 'name',
    permission: 'campaign.delete', scopedKind: 'campaign',
    parents: parentVia('campaign', [['Branch', 'branch', 'branch_id'], ['Vertical', 'vertical', 'vertical_id'], ['Pipeline', 'pipeline', 'pipeline_id']]),
    dependents: hierarchyDeps('campaign_id', ['source']),
  },
  source: {
    key: 'source', label: 'Source', table: 'source', nameExpr: 'name',
    permission: 'source.delete', scopedKind: 'source',
    parents: parentVia('source', [['Branch', 'branch', 'branch_id'], ['Vertical', 'vertical', 'vertical_id'], ['Pipeline', 'pipeline', 'pipeline_id'], ['Campaign', 'campaign', 'campaign_id']]),
    dependents: [
      dep('leads', 'Leads', 'lead d', `d.source_id = $1 AND d.${ALIVE}`, 'd.full_name'),
      dep('follow_ups', 'Follow-ups', 'follow_up d JOIN lead l ON l.id = d.lead_id', `l.source_id = $1 AND d.${ALIVE}`, 'l.full_name'),
    ],
  },
  lead: {
    key: 'lead', label: 'Lead', table: 'lead', nameExpr: 'full_name',
    permission: 'lead.delete', scopedKind: 'lead',
    parents: parentVia('lead', [['Branch', 'branch', 'branch_id'], ['Vertical', 'vertical', 'vertical_id'], ['Pipeline', 'pipeline', 'pipeline_id'], ['Campaign', 'campaign', 'campaign_id'], ['Source', 'source', 'source_id']]),
    dependents: [
      dep('follow_ups', 'Follow-ups', 'follow_up d', `d.lead_id = $1 AND d.${ALIVE}`, `to_char(d.scheduled_at, 'DD Mon YYYY') || ' · ' || d.status`),
      dep('activities', 'Timeline activities', 'lead_activity d', `d.lead_id = $1 AND 'deleted_at IS NULL' = '${ALIVE}'`, `d.type`),
    ],
  },
  follow_up: {
    key: 'follow_up', label: 'Follow-up', table: 'follow_up', nameExpr: `to_char(scheduled_at, 'DD Mon YYYY HH24:MI')`,
    permission: 'followup.delete', scopedKind: 'follow_up',
    parents: [{
      label: 'Lead',
      sql: `SELECT p.full_name AS name, (p.deleted_at IS NOT NULL) AS deleted
              FROM follow_up c JOIN lead p ON p.id = c.lead_id WHERE c.id = $1`,
    }],
    dependents: [],
  },
  user: {
    key: 'user', label: 'User', table: '"user"', nameExpr: 'name',
    permission: 'user.delete', scopedKind: 'user', parents: [],
    dependents: [
      dep('leads_owned', 'Leads owned', 'lead d', `d.owner_id = $1 AND d.${ALIVE}`, 'd.full_name'),
      dep('follow_ups_owned', 'Follow-ups owned', 'follow_up d', `d.owner_id = $1 AND d.${ALIVE}`, `to_char(d.scheduled_at, 'DD Mon')`),
      dep('teams_led', 'Teams led', 'team d', `d.leader_id = $1 AND d.${ALIVE}`, 'd.name'),
      dep('team_memberships', 'Team memberships', 'team_member tm JOIN team d ON d.id = tm.team_id', `tm.user_id = $1 AND d.${ALIVE}`, 'd.name'),
      dep('assignments', 'Role assignments', 'user_assignment ua JOIN role d ON d.id = ua.role_id', `ua.user_id = $1 AND ua.is_active AND d.${ALIVE}`, 'd.name'),
    ],
  },
  team: {
    key: 'team', label: 'Team', table: 'team', nameExpr: 'name',
    permission: 'team.delete', scopedKind: 'team', parents: [],
    dependents: [
      dep('members', 'Members', 'team_member tm JOIN "user" d ON d.id = tm.user_id', `tm.team_id = $1 AND d.${ALIVE}`, 'd.name'),
      dep('leads', 'Leads', 'lead d', `d.team_id = $1 AND d.${ALIVE}`, 'd.full_name'),
      dep('assignments', 'User assignments', 'user_assignment ua JOIN "user" d ON d.id = ua.user_id', `ua.team_id = $1 AND ua.is_active AND d.${ALIVE}`, 'd.name'),
    ],
  },
  role: {
    key: 'role', label: 'Role', table: 'role', nameExpr: 'name',
    permission: 'role.delete', parents: [],
    dependents: [
      dep('users', 'Users holding this role', '(SELECT DISTINCT u.id, u.name FROM "user" u JOIN user_assignment ua ON ua.user_id = u.id AND ua.is_active WHERE ua.role_id = $1 AND u.deleted_at IS NULL) d', 'TRUE', 'd.name'),
      dep('grants', 'Permission grants', 'role_permission rp JOIN permission d ON d.id = rp.permission_id', `rp.role_id = $1 AND 'deleted_at IS NULL' = '${ALIVE}'`, 'd.key'),
    ],
  },
};

/** Master-type registry entries (state, city, m_*) — keyed `master:<type>`. */
const MASTER_DEPS: Record<string, DependentDef[]> = {
  state: [
    dep('cities', 'Cities', 'city d', `d.parent_id = $1 AND d.${ALIVE}`, 'd.name'),
    dep('branches', 'Branches', 'branch d', `d.state_id = $1 AND d.${ALIVE}`, 'd.name'),
    dep('leads', 'Leads', 'lead d', `d.state_id = $1 AND d.${ALIVE}`, 'd.full_name'),
  ],
  city: [
    dep('branches', 'Branches', 'branch d', `d.city_id = $1 AND d.${ALIVE}`, 'd.name'),
    dep('leads', 'Leads', 'lead d', `d.city_id = $1 AND d.${ALIVE}`, 'd.full_name'),
  ],
  source: [
    dep('sources', 'Connected sources', 'source d', `d.master_source_id = $1 AND d.${ALIVE}`, 'd.name'),
  ],
  course: [dep('leads', 'Leads', 'lead d', `d.course_id = $1 AND d.${ALIVE}`, 'd.full_name')],
  qualification: [dep('leads', 'Leads', 'lead d', `d.qualification_id = $1 AND d.${ALIVE}`, 'd.full_name')],
  budget: [dep('leads', 'Leads', 'lead d', `d.budget_id = $1 AND d.${ALIVE}`, 'd.full_name')],
  status: [dep('leads', 'Leads', 'lead d', `d.status_id = $1 AND d.${ALIVE}`, 'd.full_name')],
  tag: [],
  followup_type: [dep('follow_ups', 'Follow-ups', 'follow_up d', `d.type_id = $1 AND d.${ALIVE}`, `to_char(d.scheduled_at, 'DD Mon')`)],
  disposition: [dep('follow_ups', 'Follow-ups', 'follow_up d', `d.disposition_id = $1 AND d.${ALIVE}`, `to_char(d.scheduled_at, 'DD Mon')`)],
};

for (const [type, def] of Object.entries(MASTER_TYPES)) {
  DELETE_REGISTRY[`master:${type}`] = {
    key: `master:${type}`,
    // DEF-S2-06: an explicit singular — naive de-pluralising produced "Citie" / "Lead Statuse"
    label: def.singular,
    table: def.table,
    nameExpr: 'name',
    permission: 'master.delete',
    scopedKind: 'master',
    parents: type === 'city'
      ? [{ label: 'State', sql: `SELECT p.name AS name, (p.deleted_at IS NOT NULL) AS deleted FROM city c JOIN state p ON p.id = c.parent_id WHERE c.id = $1` }]
      : [],
    dependents: MASTER_DEPS[type] ?? [],
  };
}

export function registryEntry(key: string): DeletableDef | undefined {
  return DELETE_REGISTRY[key];
}
