/**
 * COURSE LEVELS (enrollment re-model, batch 1).
 *
 * A course can have MANY levels (A1, A2, …), each with its OWN fee. The Course form's repeatable
 * Levels editor (＋ Add level) collects them; the saver PUTs them to /courses/:id/levels after the
 * course is created/updated. A course with no levels keeps its single Standard Fee (meta.fee).
 *
 * This proves: add 3 levels → the course POST fires AND a PUT /courses/:id/levels carries all three
 * with their fees; an Edit fetches the course's stored levels and re-PUTs them on save.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { AddModal, EditSpec, parseLevelRows, levelsPayload } from './forms';

vi.mock('./auth', () => ({ useAuth: () => ({ can: () => true, me: { user: { id: 1, name: 'Super Admin' } } }) }));

const REF = {
  branches: [{ id: 9, name: 'Vikaspuri' }, { id: 10, name: 'Janakpuri' }],
  verticals: [{ id: 1, name: 'BCL', branch_id: 9 }, { id: 2, name: 'IELTS', branch_id: 9 }, { id: 3, name: 'PTE', branch_id: 10 }],
  pipelines: [], campaigns: [], sources: [], masterSources: [], courses: [],
  statuses: [], followupTypes: [], dispositions: [], budgets: [], users: [],
  trainings: [], visitPurposes: [], walkinStatuses: [], states: [], cities: [], ticketCategories: [], stages: [],
  courseTypes: [], deliveryModes: [],
  courseLevels: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].map((c) => ({ id: c, name: c })),
  loaded: true, reload: () => undefined,
};
vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, useRef_: () => REF, toast: vi.fn() };
});

const post = vi.fn().mockResolvedValue({ id: 99, name: 'ZZTEST French' });
const patch = vi.fn().mockResolvedValue({ id: 99 });
const put = vi.fn().mockResolvedValue({});
const get = vi.fn().mockResolvedValue([]);
vi.mock('./api', () => ({ api: {
  get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a),
  patch: (...a: unknown[]) => patch(...a), put: (...a: unknown[]) => put(...a), del: vi.fn(),
} }));

const fld = (name: string) =>
  [...document.querySelectorAll('.add-modal .fld')].find((f) => f.querySelector('label')?.textContent?.trim().startsWith(name)) as HTMLElement;
const sel = (name: string) => fld(name).querySelector('select') as HTMLSelectElement;
const primary = () => document.querySelector('.add-modal .af .btn.primary') as HTMLElement;
const tid = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;

beforeEach(() => { cleanup(); post.mockClear(); patch.mockClear(); put.mockClear(); get.mockClear(); });

describe('pure helpers', () => {
  it('parseLevelRows round-trips code+fee, mapping fee_minor→rupees', () => {
    expect(parseLevelRows(JSON.stringify([{ code: 'A1', fee_minor: 1000000 }]))).toEqual([{ code: 'A1', label: undefined, fee: '10000', exam: '', duration: undefined }]);
    // dev/140 item 3 — an exam_fee_minor round-trips into the rupee `exam` string
    expect(parseLevelRows(JSON.stringify([{ code: 'A1', fee_minor: 1000000, exam_fee_minor: 100000 }]))).toEqual([{ code: 'A1', label: undefined, fee: '10000', exam: '1000', duration: undefined }]);
    expect(parseLevelRows('')).toEqual([]);
  });
  it('levelsPayload drops blank-code rows and numbers the ordering', () => {
    const out = levelsPayload(JSON.stringify([{ code: 'A1', fee: '10000' }, { code: '', fee: '5' }, { code: 'A2', fee: '12000' }]));
    expect(out).toEqual([
      { code: 'A1', label: undefined, fee: '10000', duration: undefined, ordering: 0 },
      { code: 'A2', label: undefined, fee: '12000', duration: undefined, ordering: 1 },
    ]);
  });
});

describe('Course form — Levels editor', () => {
  it('renders the repeatable Levels editor (＋ Add level), not a single Course Level select', () => {
    render(<AddModal formKey="students.courses" onClose={() => {}} />);
    expect(fld('Levels')).toBeTruthy();
    expect(tid('level-add')).toBeTruthy();
    // no single "Course Level" descriptor field anymore
    expect(fld('Course Level')).toBeFalsy();
  });

  it('adds 3 levels with fees → PUTs all three to /courses/:id/levels after the course POST', async () => {
    render(<AddModal formKey="students.courses" onClose={() => {}} />);
    fireEvent.change(fld('Course Name').querySelector('input')!, { target: { value: 'ZZTEST French' } });
    fireEvent.change(fld('Course Code').querySelector('input')!, { target: { value: 'ZZFR' } });
    fireEvent.change(sel('Branch'), { target: { value: '9' } });
    fireEvent.change(sel('Vertical'), { target: { value: '1' } });
    fireEvent.change(fld('Duration').querySelector('input')!, { target: { value: '6 Months' } });
    // three levels
    const levels = [['A1', '10000'], ['A2', '12000'], ['B1', '15000']];
    levels.forEach(([code, fee], i) => {
      fireEvent.click(tid('level-add'));
      fireEvent.change(tid(`level-code-${i}`), { target: { value: code } });
      fireEvent.change(tid(`level-fee-${i}`), { target: { value: fee } });
    });
    fireEvent.click(primary());
    await waitFor(() => expect(post).toHaveBeenCalled());
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(post.mock.calls[0][0]).toBe('/masters/course');
    const [path, body] = put.mock.calls[0] as [string, any];
    expect(path).toBe('/courses/99/levels');
    expect(body.levels.map((l: any) => [l.code, l.fee])).toEqual([['A1', '10000'], ['A2', '12000'], ['B1', '15000']]);
  });

  it('no levels → the course still saves; PUT sends an empty levels array (keeps Standard Fee)', async () => {
    render(<AddModal formKey="students.courses" onClose={() => {}} />);
    fireEvent.change(fld('Course Name').querySelector('input')!, { target: { value: 'ZZTEST Plain' } });
    fireEvent.change(fld('Course Code').querySelector('input')!, { target: { value: 'ZZPL' } });
    fireEvent.change(sel('Branch'), { target: { value: '9' } });
    fireEvent.change(sel('Vertical'), { target: { value: '1' } });
    fireEvent.change(fld('Standard Fee').querySelector('input')!, { target: { value: '20000' } });
    fireEvent.click(primary());
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect((post.mock.calls[0][1] as any).meta.fee).toBe('20000');
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect((put.mock.calls[0][1] as any).levels).toEqual([]);
  });

  it('Edit fetches the course levels (GET) and re-PUTs them on save', async () => {
    get.mockResolvedValueOnce([
      { code: 'A1', label: 'A1', fee_minor: 1000000, duration: null, ordering: 0 },
      { code: 'A2', label: 'A2', fee_minor: 1200000, duration: null, ordering: 1 },
    ]);
    const spec: EditSpec = {
      title: 'Edit Course — French', levelsCourseId: 99,
      initialVals: { 'Course Name': 'French', 'Course Code': 'FR', Status: 'Active' },
      initialIds: { Branch: 9, Vertical: 1 },
      submit: async (vals) => { await put('/courses/99/levels', { levels: levelsPayload(vals['Levels']) }); return 'Course updated'; },
    };
    render(<AddModal formKey="students.courses" onClose={() => {}} edit={spec} />);
    await waitFor(() => expect(get).toHaveBeenCalledWith('/courses/99/levels'));
    // the two fetched levels populate the editor
    await waitFor(() => expect((tid('level-code-0') as HTMLSelectElement).value).toBe('A1'));
    expect((tid('level-fee-1') as HTMLInputElement).value).toBe('12000');
    fireEvent.click(primary());
    await waitFor(() => expect(put).toHaveBeenCalledWith('/courses/99/levels', expect.objectContaining({
      levels: [
        { code: 'A1', label: 'A1', fee: '10000', duration: undefined, ordering: 0 },
        { code: 'A2', label: 'A2', fee: '12000', duration: undefined, ordering: 1 },
      ],
    })));
  });
});
