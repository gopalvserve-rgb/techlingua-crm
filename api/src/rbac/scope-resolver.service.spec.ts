import { ScopeResolverService } from './scope-resolver.service';
import { Assignment, RolePermissionGrant, UserGrantData } from './rbac.types';

const svc = new ScopeResolverService();

const asg = (roleId: number, units: Partial<Assignment> = {}): Assignment => ({
  roleId, branchId: null, verticalId: null, pipelineId: null, campaignId: null, teamId: null, ...units,
});
const rp = (roleId: number, key: string, recordScope: RolePermissionGrant['recordScope'],
  fieldScope: RolePermissionGrant['fieldScope'] = null): RolePermissionGrant =>
  ({ roleId, permissionKey: key, recordScope, fieldScope });

const data = (assignments: Assignment[], rolePermissions: RolePermissionGrant[], teamIds: number[] = []): UserGrantData =>
  ({ userId: 42, assignments, rolePermissions, teamIds });

describe('ScopeResolverService.resolve', () => {
  it('denies when the user has no grant for the permission', () => {
    const r = svc.resolve(data([asg(1)], [rp(1, 'lead.read', 'own')]), 'lead.delete');
    expect(r.allowed).toBe(false);
    expect(r.filters).toEqual([]);
  });

  it('denies when a role has the permission but the user holds no assignment for that role', () => {
    const r = svc.resolve(data([asg(1)], [rp(2, 'lead.read', 'all')]), 'lead.read');
    expect(r.allowed).toBe(false);
  });

  it('grants unrestricted access when any grant has record_scope=all', () => {
    const r = svc.resolve(
      data([asg(1, { branchId: 10 }), asg(2)], [rp(1, 'lead.read', 'branch'), rp(2, 'lead.read', 'all')]),
      'lead.read',
    );
    expect(r.allowed).toBe(true);
    expect(r.all).toBe(true);
    expect(r.filters).toEqual([]);
  });

  it('resolves own scope to the user id', () => {
    const r = svc.resolve(data([asg(1)], [rp(1, 'lead.update', 'own')]), 'lead.update');
    expect(r.all).toBe(false);
    expect(r.filters).toEqual([{ kind: 'own', userId: 42 }]);
  });

  it('binds branch scope to the assignment branch', () => {
    const r = svc.resolve(data([asg(1, { branchId: 7 })], [rp(1, 'lead.read', 'branch')]), 'lead.read');
    expect(r.filters).toEqual([{ kind: 'branch', branchId: 7 }]);
  });

  it('unions filters across multiple assignments (multi-unit user)', () => {
    const r = svc.resolve(
      data(
        [asg(1, { branchId: 7 }), asg(1, { branchId: 8 }), asg(2, { verticalId: 30 })],
        [rp(1, 'lead.read', 'branch'), rp(2, 'lead.read', 'vertical')],
      ),
      'lead.read',
    );
    expect(r.all).toBe(false);
    expect(r.filters).toEqual(expect.arrayContaining([
      { kind: 'branch', branchId: 7 },
      { kind: 'branch', branchId: 8 },
      { kind: 'vertical', verticalId: 30 },
    ]));
    expect(r.filters).toHaveLength(3);
  });

  it('deduplicates identical filters from overlapping assignments', () => {
    const r = svc.resolve(
      data([asg(1, { branchId: 7 }), asg(2, { branchId: 7 })],
        [rp(1, 'lead.read', 'branch'), rp(2, 'lead.read', 'branch')]),
      'lead.read',
    );
    expect(r.filters).toEqual([{ kind: 'branch', branchId: 7 }]);
  });

  it('falls back to the nearest defined ancestor unit (pipeline scope, only branch set)', () => {
    const r = svc.resolve(data([asg(1, { branchId: 5 })], [rp(1, 'lead.read', 'pipeline')]), 'lead.read');
    expect(r.filters).toEqual([{ kind: 'branch', branchId: 5 }]);
  });

  describe('FB-2026-003 — an assignment that names a vertical narrows a branch-level grant to it', () => {
    // Priyanka (Branch Manager, grants at branch level): Janakpuri and Najafgarh whole, Vikaspuri with
    // only BCL VKP (30) and INSTA VKP (31) ticked. Vikaspuri (7) also has TechnoPaat — not hers.
    const priyanka = data(
      [asg(1, { branchId: 5 }), asg(1, { branchId: 6 }), asg(1, { branchId: 7, verticalId: 30 }), asg(1, { branchId: 7, verticalId: 31 })],
      [rp(1, 'lead.read', 'branch')],
    );

    it('whole branches stay whole; the ticked verticals replace their branch', () => {
      const r = svc.resolve(priyanka, 'lead.read');
      expect(r.all).toBe(false);
      expect(r.filters).toEqual([
        { kind: 'branch', branchId: 5 },
        { kind: 'branch', branchId: 6 },
        { kind: 'vertical', verticalId: 30, within: { kind: 'branch', id: 7 } },
        { kind: 'vertical', verticalId: 31, within: { kind: 'branch', id: 7 } },
      ]);
      expect(r.filters).not.toContainEqual({ kind: 'branch', branchId: 7 });
    });

    it('SQL: a lead table filters by vertical — the branch-wide clause for Vikaspuri is gone', () => {
      const params: unknown[] = [];
      const sql = svc.buildScopeWhere(svc.resolve(priyanka, 'lead.read'),
        { owner: 'l.owner_id', branch: 'l.branch_id', vertical: 'l.vertical_id' }, params);
      expect(sql).toBe('(l.branch_id = $1 OR l.branch_id = $2 OR l.vertical_id = $3 OR l.vertical_id = $4)');
      expect(params).toEqual([5, 6, 30, 31]);
    });

    it('SQL: an entity with no vertical column (stock, the branch row) still gets the branch — never less than before', () => {
      const params: unknown[] = [];
      const sql = svc.buildScopeWhere(svc.resolve(priyanka, 'lead.read'), { branch: 's.branch_id' }, params);
      expect(sql).toBe('(s.branch_id = $1 OR s.branch_id = $2 OR s.branch_id = $3 OR s.branch_id = $4)');
      expect(params).toEqual([5, 6, 7, 7]);
    });

    it('an assignment naming only the branch keeps the whole branch (no change)', () => {
      expect(svc.resolve(data([asg(1, { branchId: 7 })], [rp(1, 'lead.read', 'branch')]), 'lead.read').filters)
        .toEqual([{ kind: 'branch', branchId: 7 }]);
    });

    it('own-scoped and vertical-scoped grants are unchanged', () => {
      const a = [asg(1, { branchId: 7, verticalId: 30 })];
      expect(svc.resolve(data(a, [rp(1, 'lead.read', 'own')]), 'lead.read').filters).toEqual([{ kind: 'own', userId: 42 }]);
      expect(svc.resolve(data(a, [rp(1, 'lead.read', 'vertical')]), 'lead.read').filters).toEqual([{ kind: 'vertical', verticalId: 30 }]);
    });

    it('a pipeline (or campaign) named under the grant narrows further, falling back one level at a time', () => {
      const r = svc.resolve(data([asg(1, { branchId: 7, verticalId: 30, pipelineId: 9 })], [rp(1, 'lead.read', 'branch')]), 'lead.read');
      expect(r.filters).toEqual([{ kind: 'pipeline', pipelineId: 9, verticalId: 30, within: { kind: 'branch', id: 7 } }]);
      const p1: unknown[] = [];
      expect(svc.buildScopeWhere(r, { branch: 'x.branch_id', vertical: 'x.vertical_id' }, p1)).toBe('(x.vertical_id = $1)');
      expect(p1).toEqual([30]);
      const p2: unknown[] = [];
      expect(svc.buildScopeWhere(r, { branch: 'x.branch_id' }, p2)).toBe('(x.branch_id = $1)');
      expect(p2).toEqual([7]);
      const p3: unknown[] = [];
      expect(svc.buildScopeWhere(r, {}, p3)).toBe('1=0');
    });

    it('a vertical-level grant on an assignment with a pipeline narrows to the pipeline', () => {
      const r = svc.resolve(data([asg(1, { branchId: 7, verticalId: 30, pipelineId: 9 })], [rp(1, 'lead.read', 'vertical')]), 'lead.read');
      expect(r.filters).toEqual([{ kind: 'pipeline', pipelineId: 9, within: { kind: 'vertical', id: 30 } }]);
    });
  });

  it('treats a scoped grant with no unit at all as org-wide (single tenant)', () => {
    const r = svc.resolve(data([asg(1)], [rp(1, 'lead.read', 'branch')]), 'lead.read');
    expect(r.all).toBe(true);
  });

  it('team scope uses the assignment team, else all teams the user leads/belongs to', () => {
    const withTeam = svc.resolve(data([asg(1, { teamId: 3 })], [rp(1, 'lead.read', 'team')]), 'lead.read');
    expect(withTeam.filters).toEqual([{ kind: 'team', teamIds: [3] }]);

    const noTeam = svc.resolve(data([asg(1)], [rp(1, 'lead.read', 'team')], [4, 5]), 'lead.read');
    expect(noTeam.filters).toEqual([{ kind: 'team', teamIds: [4, 5] }]);
  });

  it('degrades team scope to own when the user has no team at all', () => {
    const r = svc.resolve(data([asg(1)], [rp(1, 'lead.read', 'team')], []), 'lead.read');
    expect(r.filters).toEqual([{ kind: 'own', userId: 42 }]);
  });

  it('campaign scope binds to the assignment campaign', () => {
    const r = svc.resolve(data([asg(1, { campaignId: 99, pipelineId: 9 })], [rp(1, 'lead.read', 'campaign')]), 'lead.read');
    expect(r.filters).toEqual([{ kind: 'campaign', campaignId: 99 }]);
  });

  describe('field scope', () => {
    it('any unrestricted grant wins (allowedFields=null)', () => {
      const r = svc.resolve(
        data([asg(1), asg(2)],
          [rp(1, 'lead.read', 'own', { allow: ['phone'] }), rp(2, 'lead.read', 'own', null)]),
        'lead.read',
      );
      expect(r.allowedFields).toBeNull();
      expect(r.deniedFields).toEqual([]);
    });

    it('unions allow lists across grants', () => {
      const r = svc.resolve(
        data([asg(1), asg(2)],
          [rp(1, 'lead.read', 'own', { allow: ['phone'] }), rp(2, 'lead.read', 'own', { allow: ['email'] })]),
        'lead.read',
      );
      expect(r.allowedFields?.sort()).toEqual(['email', 'phone']);
    });

    it('a deny only sticks when every restricted grant denies the field', () => {
      const r = svc.resolve(
        data([asg(1), asg(2)],
          [rp(1, 'lead.read', 'own', { deny: ['budget', 'phone'] }), rp(2, 'lead.read', 'own', { deny: ['budget'] })]),
        'lead.read',
      );
      expect(r.deniedFields).toEqual(['budget']);
    });
  });
});

describe('ScopeResolverService.buildScopeWhere', () => {
  const cols = { owner: 'l.owner_id', team: 'l.team_id', branch: 'l.branch_id', vertical: 'l.vertical_id', pipeline: 'l.pipeline_id', campaign: 'l.campaign_id' };

  it('returns 1=0 when not allowed and 1=1 when unrestricted', () => {
    const params: unknown[] = [];
    expect(svc.buildScopeWhere({ permissionKey: 'x', allowed: false, all: false, filters: [], allowedFields: null, deniedFields: [] }, cols, params)).toBe('1=0');
    expect(svc.buildScopeWhere({ permissionKey: 'x', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [] }, cols, params)).toBe('1=1');
    expect(params).toEqual([]);
  });

  it('renders OR-united parameterised fragments, appending to existing params', () => {
    const params: unknown[] = ['pre-existing'];
    const sql = svc.buildScopeWhere({
      permissionKey: 'lead.read', allowed: true, all: false,
      filters: [
        { kind: 'branch', branchId: 7 },
        { kind: 'own', userId: 42 },
        { kind: 'team', teamIds: [4, 5] },
      ],
      allowedFields: null, deniedFields: [],
    }, cols, params);
    expect(sql).toBe('(l.branch_id = $2 OR l.owner_id = $3 OR l.team_id = ANY($4::bigint[]))');
    expect(params).toEqual(['pre-existing', 7, 42, [4, 5]]);
  });

  it('never widens access when the entity lacks a scoped column (denies instead)', () => {
    const params: unknown[] = [];
    const sql = svc.buildScopeWhere({
      permissionKey: 'branch.read', allowed: true, all: false,
      filters: [{ kind: 'own', userId: 42 }],
      allowedFields: null, deniedFields: [],
    }, { branch: 'b.id' }, params);
    expect(sql).toBe('1=0');
  });
});
