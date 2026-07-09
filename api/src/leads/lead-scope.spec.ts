import { ENTITY_SCOPE } from '../rbac/scope-enforcer.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { FOLLOWUP_SCOPE_COLS, LEAD_SCOPE_COLS } from './leads.service';

/**
 * Sprint-2 QA gate (docs/qa/02-sprint1-test-report.md sign-off):
 * lead and follow_up MUST be registered in the @ScopedEntity registry so
 * by-ID routes 404 for out-of-scope ids, and list queries must scope on the
 * lead's full path columns.
 */
describe('lead / follow_up record-scope registration', () => {
  it('registers lead in ENTITY_SCOPE with full-path columns', () => {
    const def = ENTITY_SCOPE.lead;
    expect(def).toBeDefined();
    expect(def.from).toContain('lead');
    expect(def.cols).toEqual({
      owner: 'e.owner_id', team: 'e.team_id', branch: 'e.branch_id',
      vertical: 'e.vertical_id', pipeline: 'e.pipeline_id', campaign: 'e.campaign_id',
    });
  });

  it('registers follow_up in ENTITY_SCOPE scoped through its lead', () => {
    const def = ENTITY_SCOPE.follow_up;
    expect(def).toBeDefined();
    expect(def.from).toContain('follow_up');
    expect(def.from).toContain('JOIN lead');
    expect(def.cols.owner).toBe('fu.owner_id'); // own = my follow-ups
    expect(def.cols.branch).toBe('e.branch_id');
    expect(def.cols.campaign).toBe('e.campaign_id');
  });

  const resolver = new ScopeResolverService();

  it("counsellor 'own' scope filters lead lists to owner_id", () => {
    const scope: ResolvedScope = {
      permissionKey: 'lead.read', allowed: true, all: false,
      filters: [{ kind: 'own', userId: 42 }], allowedFields: null, deniedFields: [],
    };
    const params: unknown[] = [];
    const where = resolver.buildScopeWhere(scope, LEAD_SCOPE_COLS, params);
    expect(where).toBe('(l.owner_id = $1)');
    expect(params).toEqual([42]);
  });

  it("branch-manager 'branch' scope filters lead lists to branch_id", () => {
    const scope: ResolvedScope = {
      permissionKey: 'lead.read', allowed: true, all: false,
      filters: [{ kind: 'branch', branchId: 7 }], allowedFields: null, deniedFields: [],
    };
    const params: unknown[] = [];
    const where = resolver.buildScopeWhere(scope, LEAD_SCOPE_COLS, params);
    expect(where).toBe('(l.branch_id = $1)');
    expect(params).toEqual([7]);
  });

  it('follow-up scope columns route own -> follow_up.owner_id and units -> lead path', () => {
    const scope: ResolvedScope = {
      permissionKey: 'followup.read', allowed: true, all: false,
      filters: [{ kind: 'own', userId: 5 }, { kind: 'vertical', verticalId: 3 }],
      allowedFields: null, deniedFields: [],
    };
    const params: unknown[] = [];
    const where = resolver.buildScopeWhere(scope, FOLLOWUP_SCOPE_COLS, params);
    expect(where).toBe('(f.owner_id = $1 OR l.vertical_id = $2)');
    expect(params).toEqual([5, 3]);
  });

  it('denies (1=0) when no filter maps onto the entity', () => {
    const scope: ResolvedScope = {
      permissionKey: 'lead.read', allowed: true, all: false,
      filters: [], allowedFields: null, deniedFields: [],
    };
    expect(resolver.buildScopeWhere(scope, LEAD_SCOPE_COLS, [])).toBe('1=0');
  });
});
