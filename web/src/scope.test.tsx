/**
 * GLOBAL SCOPE SELECTOR (top bar) — now MULTI-SELECT per level (client, Aug 2026): pick several
 * Branches / Verticals / Pipelines / Campaigns.
 *
 * These tests assert what makes it safe and useful:
 *   1. it emits the *_ids ARRAYS the lists honour (CSV), plus the singular *_id when EXACTLY one
 *      unit is picked at a level (back-compat);
 *   2. it CASCADES across the multiple selections — a child under ANY selected parent survives;
 *      narrowing a parent PRUNES orphaned children (no stale cross-branch child);
 *   3. CLEAR resets to the whole scope;
 *   4. RBAC — a persisted scope not in the RBAC-limited RefData (or whose parent no longer matches)
 *      is PRUNED on load, and the old single-value shape is migrated — the selector can never claim
 *      a unit the user isn't allowed to see.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import { GlobalScopeProvider, useScope, ScopeLevel } from './scope';

const REF = {
  branches: [{ id: 9, name: 'Vikaspuri' }, { id: 10, name: 'Rohini' }],
  verticals: [{ id: 1, name: 'BCL', branch_id: 9 }, { id: 2, name: 'IELTS', branch_id: 10 }],
  pipelines: [{ id: 4, name: 'Admissions', vertical_id: 1 }, { id: 7, name: 'Coaching', vertical_id: 2 }],
  campaigns: [{ id: 5, name: 'Meta Jul', pipeline_id: 4 }, { id: 6, name: 'Google', pipeline_id: 7 }],
  sources: [], courses: [], statuses: [], followupTypes: [], dispositions: [], budgets: [],
  users: [], states: [], cities: [], loaded: true, reload: () => undefined,
};
vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, useRef_: () => REF, toast: vi.fn() };
});

// Capture the live scope API so tests can drive set()/clear() directly and read the params.
let ctl: { set: (l: ScopeLevel, ids: number[]) => void; clear: () => void };
function Probe() {
  const s = useScope();
  ctl = { set: s.set, clear: s.clear };
  return <div data-testid="probe" data-params={JSON.stringify(s.params)} data-active={String(s.active)}
    data-branches={s.scope.branches.join(',')} data-verticals={s.scope.verticals.join(',')} />;
}
const draw = () => render(<GlobalScopeProvider><Probe /></GlobalScopeProvider>);
const params = () => JSON.parse(screen.getByTestId('probe').getAttribute('data-params') || '{}');
const attr = (k: string) => screen.getByTestId('probe').getAttribute(k) || '';
const set = (l: ScopeLevel, ids: number[]) => act(() => ctl.set(l, ids));

beforeEach(() => { cleanup(); localStorage.clear(); });

describe('multi-select params', () => {
  it('MULTIPLE branches emit branch_ids CSV and NO singular branch_id', () => {
    draw();
    set('branch', [9, 10]);
    expect(params()).toEqual({ branch_ids: '9,10' });
    expect(attr('data-active')).toBe('true');
  });

  it('EXACTLY ONE unit emits both the array and the back-compat singular', () => {
    draw();
    set('branch', [9]);
    expect(params()).toEqual({ branch_ids: '9', branch_id: '9' });
  });

  it('a full single chain emits every level (array + singular)', () => {
    draw();
    set('branch', [9]); set('vertical', [1]); set('pipeline', [4]); set('campaign', [5]);
    expect(params()).toEqual({
      branch_ids: '9', branch_id: '9', vertical_ids: '1', vertical_id: '1',
      pipeline_ids: '4', pipeline_id: '4', campaign_ids: '5', campaign_id: '5',
    });
  });
});

describe('cascade across multiple selections', () => {
  it('a child under ANY selected parent survives', () => {
    draw();
    set('branch', [9, 10]);
    set('vertical', [1, 2]); // 1∈9, 2∈10 — both allowed
    expect(attr('data-verticals')).toBe('1,2');
  });

  it('narrowing a parent PRUNES orphaned children', () => {
    draw();
    set('branch', [9, 10]); set('vertical', [1, 2]);
    set('branch', [9]);      // vertical 2 (branch 10) is now orphaned
    expect(attr('data-verticals')).toBe('1');
    expect(params()).toEqual({ branch_ids: '9', branch_id: '9', vertical_ids: '1', vertical_id: '1' });
  });

  it('changing a parent clears deeper descendants', () => {
    draw();
    set('branch', [9]); set('vertical', [1]); set('pipeline', [4]);
    set('branch', [10]);
    expect(params()).toEqual({ branch_ids: '10', branch_id: '10' });
  });
});

describe('clear', () => {
  it('resets to the whole scope', () => {
    draw();
    set('branch', [9, 10]);
    act(() => ctl.clear());
    expect(params()).toEqual({});
    expect(attr('data-active')).toBe('false');
  });
});

describe('persistence + RBAC', () => {
  it('migrates the legacy single-value shape and restores it', () => {
    localStorage.setItem('tl_global_scope', JSON.stringify({ branch: 9, vertical: 1 }));
    draw();
    expect(attr('data-branches')).toBe('9');
    expect(params()).toMatchObject({ branch_id: '9', vertical_id: '1' });
  });

  it('restores a multi-select selection from localStorage', () => {
    localStorage.setItem('tl_global_scope', JSON.stringify({ branches: [9, 10], verticals: [1, 2] }));
    draw();
    expect(attr('data-branches')).toBe('9,10');
    expect(params()).toMatchObject({ branch_ids: '9,10', vertical_ids: '1,2' });
  });

  it('RBAC: an out-of-scope id is pruned on load', async () => {
    localStorage.setItem('tl_global_scope', JSON.stringify({ branches: [999] }));
    draw();
    await waitFor(() => expect(attr('data-branches')).toBe(''));
    expect(params().branch_ids).toBeUndefined();
  });

  it('RBAC: a child whose parent does not match is pruned (no cross-branch scope)', async () => {
    localStorage.setItem('tl_global_scope', JSON.stringify({ branches: [9], verticals: [2] }));
    draw();
    await waitFor(() => expect(attr('data-verticals')).toBe(''));
    expect(attr('data-branches')).toBe('9');
    expect(params()).toEqual({ branch_ids: '9', branch_id: '9' });
  });
});
