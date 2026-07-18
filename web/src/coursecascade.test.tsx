/**
 * Client update #7 — Course configuration follows Branch › Vertical.
 *
 * The client reported: "in course configuration module select verticals and applicable
 * branch is not working — fix it in order to Branch>Vertical." The old Course form put
 * Vertical FIRST and offered a lone "Applicable Branch(es)" select that never filtered it,
 * so the two dropdowns were unrelated. This pins the fix:
 *   1. Vertical is DISABLED and empty until a Branch is chosen.
 *   2. Vertical is filtered to the chosen Branch's verticals only.
 *   3. Changing the Branch RESETS a now-invalid Vertical (no stale child id can submit).
 *   4. branch_id + vertical_id both persist, and prefill + cascade on Edit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { AddModal, SAVERS, EditSpec } from './forms';

vi.mock('./auth', () => ({ useAuth: () => ({ can: () => true, me: { user: { id: 1, name: 'Super Admin' } } }) }));

const REF = {
  branches: [{ id: 9, name: 'Vikaspuri' }, { id: 10, name: 'Janakpuri' }],
  verticals: [
    { id: 1, name: 'BCL', branch_id: 9 },
    { id: 2, name: 'IELTS Prep', branch_id: 9 },
    { id: 3, name: 'PTE', branch_id: 10 },
  ],
  pipelines: [], campaigns: [], sources: [], masterSources: [], courses: [],
  statuses: [], followupTypes: [], dispositions: [], budgets: [], users: [],
  states: [], cities: [], loaded: true, reload: () => undefined,
};
vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, useRef_: () => REF, toast: vi.fn() };
});
const post = vi.fn().mockResolvedValue({ id: 99, name: 'Java' });
const patch = vi.fn().mockResolvedValue({ id: 99 });
vi.mock('./api', () => ({ api: { get: vi.fn().mockResolvedValue([]), post: (...a: unknown[]) => post(...a), patch: (...a: unknown[]) => patch(...a), del: vi.fn(), put: vi.fn() } }));

const fld = (name: string) =>
  [...document.querySelectorAll('.add-modal .fld')].find((f) => f.querySelector('label')?.textContent?.trim().startsWith(name)) as HTMLElement;
const sel = (name: string) => fld(name).querySelector('select') as HTMLSelectElement;
const vertOpts = () => [...sel('Vertical').options].filter((o) => o.value).map((o) => o.value);

beforeEach(() => { cleanup(); post.mockClear(); patch.mockClear(); });

describe('Course configuration — Branch › Vertical cascade', () => {
  it('Vertical is disabled and empty until a Branch is picked', () => {
    render(<AddModal formKey="students.courses" onClose={() => {}} />);
    expect(sel('Vertical').disabled).toBe(true);
    expect(vertOpts()).toEqual([]);
  });

  it('Vertical lists only the chosen Branch\'s verticals', () => {
    render(<AddModal formKey="students.courses" onClose={() => {}} />);
    fireEvent.change(sel('Branch'), { target: { value: '9' } });
    expect(sel('Vertical').disabled).toBe(false);
    expect(vertOpts()).toEqual(['1', '2']);          // branch 9 only, not PTE (branch 10)
    cleanup();
    render(<AddModal formKey="students.courses" onClose={() => {}} />);
    fireEvent.change(sel('Branch'), { target: { value: '10' } });
    expect(vertOpts()).toEqual(['3']);
  });

  it('changing the Branch resets a now-invalid Vertical', () => {
    render(<AddModal formKey="students.courses" onClose={() => {}} />);
    fireEvent.change(sel('Branch'), { target: { value: '9' } });
    fireEvent.change(sel('Vertical'), { target: { value: '2' } });
    expect(sel('Vertical').value).toBe('2');
    fireEvent.change(sel('Branch'), { target: { value: '10' } });   // switch branch
    expect(sel('Vertical').value).toBe('');                          // stale vertical cleared
    expect(vertOpts()).toEqual(['3']);
  });

  it('saves branch_id + vertical_id on the course master', async () => {
    render(<AddModal formKey="students.courses" onClose={() => {}} />);
    fireEvent.change(fld('Course Name').querySelector('input')!, { target: { value: 'Java' } });
    fireEvent.change(fld('Course Code').querySelector('input')!, { target: { value: 'JV' } });
    fireEvent.change(sel('Branch'), { target: { value: '10' } });
    fireEvent.change(sel('Vertical'), { target: { value: '3' } });
    fireEvent.click(document.querySelector('.add-modal .af .btn.primary') as HTMLElement);
    await waitFor(() => expect(post).toHaveBeenCalled());
    const body = post.mock.calls[0][1] as any;
    expect(body.meta.branch_id).toBe(10);
    expect(body.meta.vertical_id).toBe(3);
  });

  it('will NOT save with a Branch but no Vertical (the model requires both)', async () => {
    render(<AddModal formKey="students.courses" onClose={() => {}} />);
    fireEvent.change(fld('Course Name').querySelector('input')!, { target: { value: 'Java' } });
    fireEvent.change(fld('Course Code').querySelector('input')!, { target: { value: 'JV' } });
    fireEvent.change(sel('Branch'), { target: { value: '9' } });
    fireEvent.click(document.querySelector('.add-modal .af .btn.primary') as HTMLElement);
    await new Promise((r) => setTimeout(r, 30));
    expect(post).not.toHaveBeenCalled();
  });

  it('Edit prefills BOTH Branch and Vertical, still cascading', async () => {
    // mirrors dyn.tsx courseEditSpec built from meta.branch_id / meta.vertical_id
    const spec: EditSpec = {
      title: 'Configure Course — Java',
      initialVals: { 'Course Name': 'Java', 'Course Code': 'JV', Status: 'Active' },
      initialIds: { Branch: 10, Vertical: 3 },
      submit: async (_v, ids) => { await patch('/masters/course/99', { meta: { branch_id: ids['Branch'], vertical_id: ids['Vertical'] } }); return 'Course updated'; },
    };
    render(<AddModal formKey="students.courses" onClose={() => {}} edit={spec} />);
    expect(sel('Branch').value).toBe('10');
    expect(sel('Vertical').value).toBe('3');
    expect(vertOpts()).toEqual(['3']);                    // filtered to branch 10
    // change branch → vertical resets, new branch's list appears
    fireEvent.change(sel('Branch'), { target: { value: '9' } });
    expect(sel('Vertical').value).toBe('');
    expect(vertOpts()).toEqual(['1', '2']);
    fireEvent.change(sel('Vertical'), { target: { value: '1' } });
    fireEvent.click(document.querySelector('.add-modal .af .btn.primary') as HTMLElement);
    await waitFor(() => expect(patch).toHaveBeenCalled());
    const body = patch.mock.calls[0][1] as any;
    expect(body.meta.branch_id).toBe(9);
    expect(body.meta.vertical_id).toBe(1);
  });
});
