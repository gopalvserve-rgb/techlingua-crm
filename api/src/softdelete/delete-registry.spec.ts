import { ALIVE, DELETE_REGISTRY, registryEntry } from './delete-registry';
import { MASTER_TYPES } from '../masters/masters.service';
import { PERMISSION_CATALOG } from '../rbac/permission-catalog';

/**
 * Soft delete — central registry contract. Every module the client can see a
 * Delete button on must be here, every dependent count must exclude deleted
 * rows, and every permission key must exist in the catalog.
 */
describe('DELETE_REGISTRY coverage', () => {
  const CORE = ['branch', 'vertical', 'pipeline', 'campaign', 'source', 'lead', 'follow_up', 'user', 'team', 'role'];

  it.each(CORE)('registers core entity %s', (key) => {
    expect(registryEntry(key)).toBeDefined();
  });

  it('registers every master type as master:<type>', () => {
    for (const type of Object.keys(MASTER_TYPES)) {
      expect(registryEntry(`master:${type}`)).toBeDefined();
    }
  });

  it('unknown keys return undefined', () => {
    expect(registryEntry('organisation')).toBeUndefined(); // the org is NOT deletable
    expect(registryEntry('nope')).toBeUndefined();
  });

  it('every permission key is <module>.<action> and exists in the catalog', () => {
    const catalogKeys = new Set(
      PERMISSION_CATALOG.flatMap((m) => m.actions.map((a) => `${m.module}.${a}`)),
    );
    for (const def of Object.values(DELETE_REGISTRY)) {
      expect(def.permission).toMatch(/^[a-z_]+\.delete$/);
      expect(catalogKeys.has(def.permission)).toBe(true);
    }
    expect(catalogKeys.has('deleted.manage')).toBe(true); // restore + Deleted Items screen
  });

  it('every dependent count filters live rows only (deleted children excluded)', () => {
    for (const def of Object.values(DELETE_REGISTRY)) {
      for (const d of def.dependents) {
        expect(`${d.from} ${d.where}`).toContain(ALIVE);
        expect(`${d.from} ${d.where}`).toContain('$1'); // users/roles filter inside a subselect FROM
      }
    }
  });

  it('branch impact spans the full association hierarchy', () => {
    const keys = DELETE_REGISTRY.branch.dependents.map((d) => d.key);
    expect(keys).toEqual(
      expect.arrayContaining(['verticals', 'pipelines', 'campaigns', 'sources', 'leads', 'users', 'teams', 'follow_ups']),
    );
  });

  it('vertical impact covers pipelines → campaigns → sources + leads/users/teams/follow-ups', () => {
    const keys = DELETE_REGISTRY.vertical.dependents.map((d) => d.key);
    expect(keys).toEqual(expect.arrayContaining(['pipelines', 'campaigns', 'sources', 'leads', 'users', 'teams', 'follow_ups']));
    expect(keys).not.toContain('verticals');
  });

  it('campaign + source impact narrows correctly', () => {
    expect(DELETE_REGISTRY.campaign.dependents.map((d) => d.key))
      .toEqual(expect.arrayContaining(['sources', 'leads', 'users', 'follow_ups']));
    expect(DELETE_REGISTRY.source.dependents.map((d) => d.key))
      .toEqual(expect.arrayContaining(['leads', 'follow_ups']));
  });

  it('parent chains block restore up the path (child lists its full ancestry)', () => {
    expect(DELETE_REGISTRY.branch.parents).toHaveLength(0);
    expect(DELETE_REGISTRY.vertical.parents.map((p) => p.label)).toEqual(['Branch']);
    expect(DELETE_REGISTRY.pipeline.parents.map((p) => p.label)).toEqual(['Branch', 'Vertical']);
    expect(DELETE_REGISTRY.campaign.parents.map((p) => p.label)).toEqual(['Branch', 'Vertical', 'Pipeline']);
    expect(DELETE_REGISTRY.source.parents.map((p) => p.label)).toEqual(['Branch', 'Vertical', 'Pipeline', 'Campaign']);
    expect(DELETE_REGISTRY.lead.parents.map((p) => p.label)).toEqual(['Branch', 'Vertical', 'Pipeline', 'Campaign', 'Source']);
    expect(DELETE_REGISTRY.follow_up.parents.map((p) => p.label)).toEqual(['Lead']);
    expect(DELETE_REGISTRY['master:city'].parents.map((p) => p.label)).toEqual(['State']);
  });

  it('parent SQL exposes (name, deleted) for the 409 message', () => {
    for (const def of Object.values(DELETE_REGISTRY)) {
      for (const p of def.parents) {
        expect(p.sql).toContain('AS name');
        expect(p.sql).toContain('deleted_at IS NOT NULL');
        expect(p.sql).toContain('$1');
      }
    }
  });

  it('scoped entities carry a scope kind; org-level ones (role) do not', () => {
    expect(DELETE_REGISTRY.branch.scopedKind).toBe('branch');
    expect(DELETE_REGISTRY.lead.scopedKind).toBe('lead');
    expect(DELETE_REGISTRY.follow_up.scopedKind).toBe('follow_up');
    expect(DELETE_REGISTRY['master:course'].scopedKind).toBe('master');
    expect(DELETE_REGISTRY.role.scopedKind).toBeUndefined();
  });

  // DEF-S2-06 — the Deleted Items screen said "Citie" and "Lead Statuse"
  it('master entity labels are properly singular (no naive de-pluralising)', () => {
    expect(DELETE_REGISTRY['master:city'].label).toBe('City');
    expect(DELETE_REGISTRY['master:status'].label).toBe('Lead Status');
    expect(DELETE_REGISTRY['master:course'].label).toBe('Course');
    expect(DELETE_REGISTRY['master:followup_type'].label).toBe('Follow-up Type');
    // the two the client would have seen: "Citie" (Cities) and "Lead Statuse" (Lead Statuses)
    for (const key of Object.keys(DELETE_REGISTRY).filter((k) => k.startsWith('master:'))) {
      const label = DELETE_REGISTRY[key].label;
      expect(label).not.toMatch(/ie$/);        // Citie
      expect(label).not.toMatch(/use$/);       // Statuse
      expect(label.trim()).toBe(label);
      expect(label.length).toBeGreaterThan(0);
    }
  });
});
