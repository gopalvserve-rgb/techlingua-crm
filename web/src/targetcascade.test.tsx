import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { TargetModal } from './targetincentive';

/** dev/143 item 4 — Target scope cascade. Target For = Vertical / Course / Individual Employee
 *  must pick a Branch first, then the entity list is filtered to that branch. */
const REF = {
  branches: [{ id: 9, name: 'Delhi' }, { id: 10, name: 'Mumbai' }],
  verticals: [
    { id: 1, name: 'IELTS', branch_id: 9 }, { id: 2, name: 'PTE', branch_id: 9 },
    { id: 3, name: 'Spoken', branch_id: 10 },
  ],
  courses: [
    { id: 100, name: 'IELTS A1', meta: { branch_id: '9', vertical_id: '1' } },
    { id: 101, name: 'Spoken B1', meta: { branch_id: '10', vertical_id: '3' } },
  ],
  users: [{ id: 5, name: 'Asha', status: 'active' }],
};

vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, useRef_: () => REF, toast: vi.fn(),
    useFetch: () => ({ data: [], loading: false, reload: vi.fn() }) };
});
vi.mock('./auth', () => ({ useAuth: () => ({ can: () => true, me: null }) }));
vi.mock('./api', () => ({ api: { get: vi.fn().mockResolvedValue([]), post: vi.fn(), put: vi.fn() } }));

const fld = (name: string) =>
  [...document.querySelectorAll('.add-modal .fld')].find((f) => f.querySelector('label')?.textContent?.trim().startsWith(name)) as HTMLElement;
const sel = (id: string) => document.getElementById(id) as HTMLSelectElement;
const opts = (s: HTMLSelectElement) => [...s.options].filter((o) => o.value).map((o) => o.value);

beforeEach(() => cleanup());

describe('Target scope Branch -> Vertical cascade', () => {
  it('Target For = Vertical shows a Branch selector and filters verticals by branch', () => {
    render(<TargetModal onClose={() => {}} />);
    fireEvent.change(sel('ti-for'), { target: { value: 'vertical' } });
    // a Branch selector appears
    expect(sel('ti-scope-branch')).toBeTruthy();
    // entity disabled until a branch is picked
    expect(sel('ti-entity').disabled).toBe(true);
    fireEvent.change(sel('ti-scope-branch'), { target: { value: '9' } });
    expect(opts(sel('ti-entity'))).toEqual(['1', '2']); // only Delhi verticals
    cleanup();
    render(<TargetModal onClose={() => {}} />);
    fireEvent.change(sel('ti-for'), { target: { value: 'vertical' } });
    fireEvent.change(sel('ti-scope-branch'), { target: { value: '10' } });
    expect(opts(sel('ti-entity'))).toEqual(['3']); // only Mumbai vertical
  });

  it('Target For = Course filters courses by the chosen branch (meta.branch_id)', () => {
    render(<TargetModal onClose={() => {}} />);
    fireEvent.change(sel('ti-for'), { target: { value: 'course' } });
    fireEvent.change(sel('ti-scope-branch'), { target: { value: '9' } });
    expect(opts(sel('ti-entity'))).toEqual(['100']); // only the Delhi course
  });

  it('Target For = Branch needs NO cascade (no scope-branch selector)', () => {
    render(<TargetModal onClose={() => {}} />);
    fireEvent.change(sel('ti-for'), { target: { value: 'branch' } });
    expect(document.getElementById('ti-scope-branch')).toBeNull();
    expect(fld('Branch')).toBeTruthy(); // the entity label is "Branch"
  });
});
