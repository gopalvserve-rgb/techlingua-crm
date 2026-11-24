/**
 * FB-2026-003 (client, 23 Nov 2026) — "Arman is added to Vikaspuri. When he logs in he should not know
 * about any other branch; in Vikaspuri he sees only the verticals he is added to. The pipeline list
 * shows nothing — fix it."
 *
 * The Branch / Vertical / Pipeline / Campaign lists feed the top-bar pickers and every dropdown. They
 * now show only the units the caller is ADDED to (Users › Edit user), on top of the role's read scope;
 * an "own"-scoped list (no owner on a pipeline) no longer comes back empty.
 */
import { HierarchyService } from './hierarchy.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope } from '../rbac/rbac.types';

const resolver = new ScopeResolverService();
const ALL: ResolvedScope = { permissionKey: 'x', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [] };
const OWN: ResolvedScope = { ...ALL, all: false, filters: [{ kind: 'own', userId: 115 }] };
const VERT: ResolvedScope = { ...ALL, all: false, filters: [{ kind: 'vertical', verticalId: 30 }, { kind: 'vertical', verticalId: 31 }] };

/** A db fake: user_assignment rows per user; records the list query it was asked to run. */
function harness(assignments: Record<number, any[]>) {
  const seen: { sql: string; params: unknown[] }[] = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      if (/FROM user_assignment/.test(sql)) return assignments[Number(params[0])] ?? [];
      seen.push({ sql, params });
      return [];
    },
  };
  return { svc: new HierarchyService(db as any, resolver, {} as any), seen, last: () => seen[seen.length - 1] };
}

// Arman: Vikaspuri (7) with BCL VKP (30) and INSTA VKP (31) ticked.
const ARMAN = [
  { branch_id: '7', vertical_id: '30', pipeline_id: null, campaign_id: null },
  { branch_id: '7', vertical_id: '31', pipeline_id: null, campaign_id: null },
];
// Md Alam: Super Admin, added org-wide (no unit).
const ADMIN = [{ branch_id: null, vertical_id: null, pipeline_id: null, campaign_id: null }];

describe('FB-2026-003 — the pick-lists show only the units the user is added to', () => {
  it('Branches: a counsellor whose role reads ALL branches sees only Vikaspuri', async () => {
    const h = harness({ 115: ARMAN });
    await h.svc.listBranches(ALL, false, undefined, 115);
    expect(h.last().sql).toMatch(/WHERE \(b\.id = \$1 OR b\.id = \$2\) AND b\.deleted_at IS NULL/);
    expect(h.last().params).toEqual([7, 7]);
  });

  it('Verticals: only the ticked verticals, not the rest of Vikaspuri (TechnoPaat)', async () => {
    const h = harness({ 115: ARMAN });
    await h.svc.listVerticals(VERT, undefined, false, undefined, undefined, 115);
    expect(h.last().sql).toContain('AND (v.id = $3 OR v.id = $4)');
    expect(h.last().params).toEqual([30, 31, 30, 31]);
  });

  it('Pipelines: an "own" read scope used to list NOTHING — now the pipelines of his verticals', async () => {
    const before = harness({ 115: ARMAN });
    await before.svc.listPipelines(OWN);                           // no user id = the old behaviour
    expect(before.last().sql).toMatch(/WHERE 1=0/);

    const h = harness({ 115: ARMAN });
    await h.svc.listPipelines(OWN, undefined, false, undefined, undefined, undefined, 115);
    expect(h.last().sql).toMatch(/WHERE \(p\.vertical_id = \$1 OR p\.vertical_id = \$2\) AND p\.deleted_at IS NULL/);
    expect(h.last().params).toEqual([30, 31]);
  });

  it('Campaigns: a role that reads ALL campaigns sees only the campaigns of his verticals', async () => {
    const h = harness({ 115: ARMAN });
    await h.svc.listCampaigns(ALL, undefined, false, undefined, undefined, undefined, undefined, 115);
    expect(h.last().sql).toMatch(/WHERE \(c\.vertical_id = \$1 OR c\.vertical_id = \$2\) AND c\.deleted_at IS NULL/);
  });

  it('someone added org-wide (Super Admin) is not narrowed', async () => {
    const h = harness({ 1: ADMIN });
    await h.svc.listBranches(ALL, false, undefined, 1);
    expect(h.last().sql).toMatch(/WHERE 1=1 AND b\.deleted_at IS NULL/);
    expect(h.last().params).toEqual([]);
  });

  it('a whole branch stays whole: added to Najafgarh with no vertical → every Najafgarh vertical', async () => {
    const h = harness({ 116: [{ branch_id: '6', vertical_id: null, pipeline_id: null, campaign_id: null }] });
    await h.svc.listVerticals(ALL, undefined, false, undefined, undefined, 116);
    expect(h.last().sql).toMatch(/WHERE \(v\.branch_id = \$1\)/);
    expect(h.last().params).toEqual([6]);
  });

  it('the read scope still applies on top: a role with no grant lists nothing, whatever the units', async () => {
    const h = harness({ 115: ARMAN });
    await h.svc.listBranches({ ...ALL, allowed: false, all: false }, false, undefined, 115);
    expect(h.last().sql).toMatch(/WHERE 1=0/);
  });

  it('a user with no active assignment at all sees no units', async () => {
    const h = harness({ 200: [] });
    await h.svc.listBranches(ALL, false, undefined, 200);
    expect(h.last().sql).toMatch(/WHERE 1=0/);
  });
});
