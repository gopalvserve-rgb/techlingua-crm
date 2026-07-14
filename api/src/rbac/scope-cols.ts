import { ScopeColumnMap } from './rbac.types';

/**
 * Scope-column maps for the lead-shaped entities, in a LEAF module.
 *
 * They used to live in leads.service.ts, but Sprint 3 made leads.service depend on
 * ScoringService and SlaService, which themselves need these maps — a circular import
 * whose only symptom would be an `undefined` const at module-init time (i.e. a scope
 * fragment of `1=0`, or worse). Hoisting them here breaks the cycle for good.
 * leads.service.ts re-exports them, so every existing import site keeps working.
 */

/** `lead l` */
export const LEAD_SCOPE_COLS: ScopeColumnMap = {
  owner: 'l.owner_id', team: 'l.team_id', branch: 'l.branch_id',
  vertical: 'l.vertical_id', pipeline: 'l.pipeline_id', campaign: 'l.campaign_id',
};

/** `follow_up f` joined to its `lead l` */
export const FOLLOWUP_SCOPE_COLS: ScopeColumnMap = {
  owner: 'f.owner_id', team: 'l.team_id', branch: 'l.branch_id',
  vertical: 'l.vertical_id', pipeline: 'l.pipeline_id', campaign: 'l.campaign_id',
};
