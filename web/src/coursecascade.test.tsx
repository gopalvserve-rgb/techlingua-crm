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
 *
 * Oct 2026 (client) — on ADD, Branch and Vertical are MULTI-select pickers: the course is created
 * once under every picked Branch › Vertical. On EDIT they stay the single cascading selects.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { AddModal, EditSpec } from './forms';

vi.mock('./auth', () => ({ useAuth: () => ({ can: () => true, me: { user: { id: 1, name: 'Super Admin' } } }) }));

const REF = {
  branches: [{ id: 9, name: 'Vikaspuri' }, { id: 10, name: 'Janakpuri' }],
  verticals: [
    { id: 1, name: 'BCL', branch_id: 9 },
    { id: 2, name: 'IELTS Prep', branch_id: 9 },
    { id: 3, name: 'PTE', branch_id: 10 },
  ],
  pipelines: [
    { id: 41, name: 'Admissions', vertical_id: 1 },
    { id: 42, name: 'Registrations', vertical_id: 1 },
    { id: 43, name: 'PTE-Pipe', vertical_id: 3 },
  ],
  campaigns: [
    { id: 51, name: 'Meta Jul', pipeline_id: 41 },
    { id: 52, name: 'Google Jul', pipeline_id: 41 },
  ],
  sources: [], masterSources: [], courses: [],
  statuses: [], followupTypes: [], dispositions: [], budgets: [], users: [],
  trainings: [], visitPurposes: [], walkinStatuses: [],
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
/** Edit mode only — the single cascading <select>s. */
const sel = (name: string) => fld(name).querySelector('select') as HTMLSelectElement;
const vertOpts = () => [...sel('Vertical').options].filter((o) => o.value).map((o) => o.value);
// dev/100 (client): the ERP course form carries NO Campaign/Pipeline (CRM-only concepts).
const hasField = (name: string) => Boolean(fld(name));

/** Add mode — open a multi-select picker and return its option rows. */
const pickRows = async (name: string) => {
  const el = fld(name);
  fireEvent.click(el.querySelector('.upick-ctl') as HTMLElement);
  await waitFor(() => expect(el.querySelectorAll('.upick-row').length).toBeGreaterThan(0));
  return [...el.querySelectorAll('.upick-row')] as HTMLElement[];
};
/** Add mode — tick one option (by its label) in a multi-select picker. */
const pick = async (name: string, label: string) => {
  const row = (await pickRows(name)).find((r) => r.querySelector('.upick-name')?.textContent === label);
  expect(row, `${name} option "${label}"`).toBeTruthy();
  fireEvent.mouseDown(row!);
};
const chips = (name: string) => [...fld(name).querySelectorAll('.upick-chip')].map((x) => x.textContent?.trim());
const save = () => fireEvent.click(document.querySelector('.add-modal .af .btn.primary') as HTMLElement);

beforeEach(() => { cleanup(); post.mockClear(); patch.mockClear(); });

describe('Course configuration — Branch › Vertical cascade', () => {
  it('Vertical is disabled and empty until a Branch is picked', () => {
    render(<AddModal formKey="students.courses" onClose={() => {}} />);
    expect(fld('Vertical').querySelector('.upick.dis')).toBeTruthy();
    expect(chips('Vertical')).toEqual([]);
  });

  it('Vertical lists only the chosen Branch\'s verticals', async () => {
    render(<AddModal formKey="students.courses" onClose={() => {}} />);
    await pick('Branch', 'Vikaspuri');
    expect(fld('Vertical').querySelector('.upick.dis')).toBeFalsy();
    const names = (await pickRows('Vertical')).map((r) => r.querySelector('.upick-name')?.textContent);
    expect(names).toEqual(['Vikaspuri → BCL', 'Vikaspuri → IELTS Prep']);   // branch 9 only, not PTE (branch 10)
  });

  it('un-ticking a Branch drops its now-invalid Verticals', async () => {
    render(<AddModal formKey="students.courses" onClose={() => {}} />);
    await pick('Branch', 'Vikaspuri');
    await pick('Vertical', 'Vikaspuri → IELTS Prep');
    expect(chips('Vertical')).toHaveLength(1);
    fireEvent.click(fld('Branch').querySelector('.upick-chip button') as HTMLElement);   // remove the branch
    expect(chips('Vertical')).toEqual([]);                                               // stale vertical cleared
  });

  it('saves branch_id + vertical_id on the course master', async () => {
    render(<AddModal formKey="students.courses" onClose={() => {}} />);
    fireEvent.change(fld('Course Name').querySelector('input')!, { target: { value: 'Java' } });
    fireEvent.change(fld('Course Code').querySelector('input')!, { target: { value: 'JV' } });
    await pick('Branch', 'Janakpuri');
    await pick('Vertical', 'Janakpuri → PTE');
    save();
    await waitFor(() => expect(post).toHaveBeenCalled());
    const body = post.mock.calls[0][1] as any;
    expect(body.meta.branch_id).toBe(10);
    expect(body.meta.vertical_id).toBe(3);
  });

  it('MULTI-select: one course is created under EVERY picked Branch › Vertical', async () => {
    render(<AddModal formKey="students.courses" onClose={() => {}} />);
    fireEvent.change(fld('Course Name').querySelector('input')!, { target: { value: 'French' } });
    fireEvent.change(fld('Course Code').querySelector('input')!, { target: { value: 'FR' } });
    await pick('Branch', 'Vikaspuri');
    await pick('Branch', 'Janakpuri');
    await pick('Vertical', 'Vikaspuri → BCL');
    await pick('Vertical', 'Janakpuri → PTE');
    save();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    const made = post.mock.calls.map((x) => [(x[1] as any).name, (x[1] as any).meta.branch_id, (x[1] as any).meta.vertical_id]);
    expect(made).toEqual([['French', 9, 1], ['French', 10, 3]]);
  });

  it('will NOT save with a Branch but no Vertical (the model requires both)', async () => {
    render(<AddModal formKey="students.courses" onClose={() => {}} />);
    fireEvent.change(fld('Course Name').querySelector('input')!, { target: { value: 'Java' } });
    fireEvent.change(fld('Course Code').querySelector('input')!, { target: { value: 'JV' } });
    await pick('Branch', 'Vikaspuri');
    save();
    await new Promise((r) => setTimeout(r, 30));
    expect(post).not.toHaveBeenCalled();
  });

  it('will NOT save when one of the picked Branches has no Vertical', async () => {
    render(<AddModal formKey="students.courses" onClose={() => {}} />);
    fireEvent.change(fld('Course Name').querySelector('input')!, { target: { value: 'Java' } });
    fireEvent.change(fld('Course Code').querySelector('input')!, { target: { value: 'JV' } });
    await pick('Branch', 'Vikaspuri');
    await pick('Branch', 'Janakpuri');
    await pick('Vertical', 'Janakpuri → PTE');          // Vikaspuri is left without a vertical
    save();
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
    save();
    await waitFor(() => expect(patch).toHaveBeenCalled());
    const body = patch.mock.calls[0][1] as any;
    expect(body.meta.branch_id).toBe(9);
    expect(body.meta.vertical_id).toBe(1);
  });

  // dev/100 (client): Campaign & Pipeline are CRM-only concepts and were REMOVED from the ERP
  // course form. It must walk Branch > Vertical only — no Pipeline / Campaign selector at all.
  it('does NOT render a Pipeline or Campaign field (ERP forms are CRM-concept-free)', () => {
    render(<AddModal formKey="students.courses" onClose={() => {}} />);
    expect(hasField('Branch')).toBe(true);
    expect(hasField('Vertical')).toBe(true);
    expect(hasField('Pipeline')).toBe(false);
    expect(hasField('Campaign')).toBe(false);
  });

  it('a course with only Branch+Vertical saves WITHOUT pipeline_id / campaign_id', async () => {
    render(<AddModal formKey="students.courses" onClose={() => {}} />);
    fireEvent.change(fld('Course Name').querySelector('input')!, { target: { value: 'French' } });
    fireEvent.change(fld('Course Code').querySelector('input')!, { target: { value: 'FR' } });
    await pick('Branch', 'Vikaspuri');
    await pick('Vertical', 'Vikaspuri → IELTS Prep');
    save();
    await waitFor(() => expect(post).toHaveBeenCalled());
    const body = post.mock.calls[0][1] as any;
    expect(body.meta.branch_id).toBe(9);
    expect(body.meta.vertical_id).toBe(2);
    expect(body.meta.pipeline_id).toBeUndefined();
    expect(body.meta.campaign_id).toBeUndefined();
    // dev/100: Delivery Mode also dropped from the course UI — not written from the form.
    expect(body.meta.delivery_mode).toBeUndefined();
  });

  it('does NOT render a Delivery Mode field (dropped from the course UI)', () => {
    render(<AddModal formKey="students.courses" onClose={() => {}} />);
    expect(hasField('Delivery Mode')).toBe(false);
    expect(hasField('Levels')).toBe(true);         // the repeatable per-level fee editor
    expect(hasField('Course Type')).toBe(true);
    expect(hasField('Description')).toBe(true);
  });
});
