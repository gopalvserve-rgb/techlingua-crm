import * as fs from 'fs';
import * as path from 'path';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { Assignment, RolePermissionGrant, UserGrantData } from '../rbac/rbac.types';

/**
 * OBS-2 (dev/105) — a Counsellor could not enroll / create a student because the Branch and
 * Vertical dropdowns were empty: the system Counsellor role held student.create / enrolment.create
 * but NOT branch.read / vertical.read, so both the web RefData gate (can('branch.read')) and the
 * GET /branches | /verticals endpoints (403) denied it. Migration 094 + seed.ts now grant
 * read-only branch.read@branch + vertical.read@vertical to Counsellor and Team Leader.
 */
const svc = new ScopeResolverService();
const asg = (roleId: number, u: Partial<Assignment> = {}): Assignment =>
  ({ roleId, branchId: null, verticalId: null, pipelineId: null, campaignId: null, teamId: null, ...u });
const rp = (roleId: number, key: string, recordScope: RolePermissionGrant['recordScope']): RolePermissionGrant =>
  ({ roleId, permissionKey: key, recordScope, fieldScope: null });
const data = (a: Assignment[], p: RolePermissionGrant[]): UserGrantData => ({ userId: 7, assignments: a, rolePermissions: p, teamIds: [] });

describe('OBS-2 — Counsellor can read the branches/verticals it belongs to', () => {
  it('branch.read@branch resolves to the counsellor branch (allowed, not denied)', () => {
    const r = svc.resolve(data([asg(6, { branchId: 3 })], [rp(6, 'branch.read', 'branch')]), 'branch.read');
    expect(r.allowed).toBe(true);
    expect(r.filters).toEqual([{ kind: 'branch', branchId: 3 }]);
  });

  it('vertical.read@vertical resolves to the counsellor vertical', () => {
    const r = svc.resolve(data([asg(6, { branchId: 3, verticalId: 12 })], [rp(6, 'vertical.read', 'vertical')]), 'vertical.read');
    expect(r.allowed).toBe(true);
    expect(r.filters).toEqual([{ kind: 'vertical', verticalId: 12 }]);
  });

  it('without the grant the counsellor is denied (the pre-fix bug)', () => {
    const r = svc.resolve(data([asg(6, { branchId: 3 })], [rp(6, 'student.create', 'own')]), 'branch.read');
    expect(r.allowed).toBe(false);
  });

  it('migration 094 grants branch.read + vertical.read to Counsellor and Team Leader', () => {
    const sql = fs.readFileSync(path.resolve(__dirname, '../../db/migrations/094_counsellor_enroll_refdata.sql'), 'utf8');
    for (const role of ['Counsellor', 'Team Leader']) {
      expect(sql).toMatch(new RegExp(`'branch\\.read',\\s*'${role}'`));
      expect(sql).toMatch(new RegExp(`'vertical\\.read',\\s*'${role}'`));
    }
    // read-only: no create/update/delete of branches/verticals
    expect(sql).not.toMatch(/branch\.(create|update|delete)/);
    expect(sql).not.toMatch(/vertical\.(create|update|delete)/);
  });

  it('seed.ts also grants them (fresh-DB path, where migrations run before roles exist)', () => {
    const seed = fs.readFileSync(path.resolve(__dirname, '../database/seed.ts'), 'utf8');
    expect(seed).toMatch(/grant\('Counsellor', \['branch\.read'\], 'branch'\)/);
    expect(seed).toMatch(/grant\('Counsellor', \['vertical\.read'\], 'vertical'\)/);
    expect(seed).toMatch(/grant\('Team Leader', \['branch\.read'\], 'branch'\)/);
    expect(seed).toMatch(/grant\('Team Leader', \['vertical\.read'\], 'vertical'\)/);
  });
});
