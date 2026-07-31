/**
 * GLOBAL SCOPE SELECTOR (top bar) — the client's ask: "a global scope selector
 * (Branch › Vertical › Pipeline › Campaign) that filters the whole app, driven by real data
 * and respecting the user's access."
 *
 * These tests assert the four things that make it safe and useful:
 *   1. it CASCADES — a child level only offers units under the chosen parent;
 *   2. changing a parent RESETS its descendants (no stale child can survive);
 *   3. the selection is exposed as branch_id/vertical_id/... (the SAME ids the lists honour),
 *      and CLEAR resets it to the whole scope;
 *   4. RBAC — a persisted scope that is not in the RBAC-limited RefData is PRUNED on load, so
 *      the selector can never claim a unit the user isn't allowed to see.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { GlobalScopeProvider, ScopeSelector, useScope } from './scope';

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

/** Reads the live scope params so a test can assert what would be sent to the API. */
function ScopeProbe() {
  const { params, active, key } = useScope();
  return <div data-testid="probe" data-params={JSON.stringify(params)} data-active={String(active)} data-key={key} />;
}

const draw = () => render(
  <GlobalScopeProvider>
    <ScopeSelector />
    <ScopeProbe />
  </GlobalScopeProvider>,
);

const sel = (label: string) => screen.getByLabelText(label) as HTMLSelectElement;
const optionValues = (label: string) => Array.from(sel(label).options).map((o) => o.value);
const probeParams = () => JSON.parse(screen.getByTestId('probe').getAttribute('data-params') || '{}');

beforeEach(() => { cleanup(); localStorage.clear(); });

describe('cascade + reset', () => {
  it('a child only offers units under the chosen parent', () => {
    draw();
    // no branch chosen yet → Vertical offers ALL verticals (All + both)
    expect(optionValues('Vertical')).toEqual(['', '1', '2']);
    fireEvent.change(sel('Branch'), { target: { value: '9' } });
    // now Vertical is limited to branch 9's verticals (BCL only)
    expect(optionValues('Vertical')).toEqual(['', '1']);
    expect(screen.queryByRole('option', { name: 'IELTS' })).toBeNull();
  });

  it('choosing the full chain sets branch_id/vertical_id/pipeline_id/campaign_id', () => {
    draw();
    fireEvent.change(sel('Branch'), { target: { value: '9' } });
    fireEvent.change(sel('Vertical'), { target: { value: '1' } });
    fireEvent.change(sel('Pipeline'), { target: { value: '4' } });
    fireEvent.change(sel('Campaign'), { target: { value: '5' } });
    expect(probeParams()).toEqual({ branch_id: '9', vertical_id: '1', pipeline_id: '4', campaign_id: '5' });
    expect(screen.getByTestId('probe').getAttribute('data-active')).toBe('true');
  });

  it('changing a parent RESETS every descendant', () => {
    draw();
    fireEvent.change(sel('Branch'), { target: { value: '9' } });
    fireEvent.change(sel('Vertical'), { target: { value: '1' } });
    fireEvent.change(sel('Pipeline'), { target: { value: '4' } });
    expect(probeParams()).toEqual({ branch_id: '9', vertical_id: '1', pipeline_id: '4' });
    // switch Branch → Vertical + Pipeline must clear
    fireEvent.change(sel('Branch'), { target: { value: '10' } });
    expect(probeParams()).toEqual({ branch_id: '10' });
    expect(sel('Vertical').value).toBe('');
    expect(sel('Pipeline').value).toBe('');
  });
});

describe('clear', () => {
  it('the Clear affordance resets to the whole scope', () => {
    draw();
    fireEvent.change(sel('Branch'), { target: { value: '9' } });
    expect(probeParams()).toEqual({ branch_id: '9' });
    fireEvent.click(screen.getByLabelText('Clear scope'));
    expect(probeParams()).toEqual({});
    expect(screen.getByTestId('probe').getAttribute('data-active')).toBe('false');
  });
});

describe('persistence + RBAC', () => {
  it('a valid selection is restored from localStorage', () => {
    localStorage.setItem('tl_global_scope', JSON.stringify({ branch: 9, vertical: 1 }));
    draw();
    expect(sel('Branch').value).toBe('9');
    expect(sel('Vertical').value).toBe('1');
  });

  it('RBAC: an out-of-scope id in a persisted scope is pruned on load', async () => {
    // branch 999 is not something this user can see — it must not survive (no widening).
    localStorage.setItem('tl_global_scope', JSON.stringify({ branch: 999, vertical: 1 }));
    draw();
    await waitFor(() => expect(sel('Branch').value).toBe(''));
    // every surviving level is genuinely inside the user's RBAC-limited RefData; the
    // out-of-scope branch is gone, so it can never be sent to the API.
    const p = probeParams();
    expect(p.branch_id).toBeUndefined();
    expect(Object.values(p)).not.toContain('999');
  });

  it('RBAC: a child whose parent does not match is pruned (no cross-branch scope)', async () => {
    // vertical 2 belongs to branch 10, not branch 9 → the pair is inconsistent, so vertical drops
    localStorage.setItem('tl_global_scope', JSON.stringify({ branch: 9, vertical: 2 }));
    draw();
    await waitFor(() => expect(sel('Vertical').value).toBe(''));
    expect(sel('Branch').value).toBe('9');
    expect(probeParams()).toEqual({ branch_id: '9' });
  });
});
