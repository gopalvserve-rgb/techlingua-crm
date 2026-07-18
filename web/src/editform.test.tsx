/**
 * DEF-2 regression — client UAT bug: "Edit branch is not editable — only readonly
 * columns are showing." He opened Branches › Edit and could not change the address.
 *
 * Root cause: the Edit modal's `lock` list had become a dumping ground for every
 * field the backend did not persist, so 6 of the 10 Branch fields rendered as grey
 * read-only <div>s instead of inputs.
 *
 * These tests assert what the USER SEES: the Edit form must render real, editable,
 * prefilled controls for every field the Add form defines, and saving must submit
 * the edited value. Only genuinely immutable parent links may stay locked.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AddModal, SPEC_FORMS, EditSpec } from './forms';

/* --- stub the two contexts AddModal reads (no network in a unit test) --- */
vi.mock('./auth', () => ({
  useAuth: () => ({ can: () => true, me: { user: { id: 1, name: 'Super Admin' } } }),
}));

const REF = {
  branches: [{ id: 9, name: 'Vikaspuri' }],
  verticals: [{ id: 1, name: 'BCL', branch_id: 9 }],
  pipelines: [{ id: 1, name: 'Admissions', vertical_id: 1 }],
  campaigns: [{ id: 1, name: 'Meta Jul', pipeline_id: 1 }],
  sources: [], courses: [], statuses: [], followupTypes: [], dispositions: [], budgets: [],
  users: [{ id: 3, name: 'Asha Rao', status: 'active' }],
  states: [{ id: 1, name: 'Delhi' }],
  cities: [{ id: 2, name: 'New Delhi', parent_id: 1 }],
  loaded: true,
  reload: () => undefined,
};

vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, useRef_: () => REF, toast: vi.fn() };
});

vi.mock('./api', () => ({
  api: { get: vi.fn().mockResolvedValue([]), post: vi.fn(), patch: vi.fn(), del: vi.fn(), put: vi.fn() },
}));

/** The control rendered for a field label, or null when it's a read-only div. */
function controlFor(label: string): HTMLElement | null {
  const fld = [...document.querySelectorAll('.add-modal .fld')].find(
    (f) => f.querySelector('label')?.textContent?.trim().startsWith(label),
  );
  if (!fld) throw new Error(`field "${label}" is not rendered at all`);
  return fld.querySelector('input, select, textarea');
}

const editable = (label: string) => controlFor(label) !== null;

/** tel fields render <country select> + <input type=tel>; grab the number input. */
function telInput(label: string): HTMLInputElement {
  const fld = [...document.querySelectorAll('.add-modal .fld')].find(
    (f) => f.querySelector('label')?.textContent?.trim().startsWith(label),
  )!;
  return fld.querySelector('input[type=tel]') as HTMLInputElement;
}

beforeEach(cleanup);

/* ------------------------------- BRANCH -------------------------------- */

describe('Edit Branch modal (the reported bug)', () => {
  /** mirrors dyn.tsx <Branches> edit spec for the live "Vikaspuri" row */
  const branchEdit = (submit = vi.fn()): EditSpec => ({
    title: 'Edit Branch — Vikaspuri',
    initialVals: {
      'Branch Name': 'Vikaspuri', 'Branch Code': 'VKP', 'Branch Type': 'Company Branch',
      'Address': 'A-11 2nd Floor Vikaspuri', 'State': 'Delhi', 'City': 'New Delhi',
      'Contact Number': '+911140001234', 'Branch Email': 'vkp@techlingua.in',
      'Branch Head': 'Asha Rao', 'Status': 'Active',
    },
    initialIds: { State: 1, City: 2, 'Branch Head': 3 },
    submit,
  });

  it('renders EVERY Add-Branch field as an editable control (none read-only)', () => {
    render(<AddModal formKey="admin.branches" onClose={() => {}} edit={branchEdit()} />);
    for (const f of SPEC_FORMS['admin.branches'].fields) {
      expect(editable(f.label), `"${f.label}" must be editable in the Edit form`).toBe(true);
    }
  });

  it('prefills the current values (address included)', () => {
    render(<AddModal formKey="admin.branches" onClose={() => {}} edit={branchEdit()} />);
    expect((controlFor('Branch Name') as HTMLInputElement).value).toBe('Vikaspuri');
    expect((controlFor('Branch Code') as HTMLInputElement).value).toBe('VKP');
    expect((controlFor('Address') as HTMLTextAreaElement).value).toBe('A-11 2nd Floor Vikaspuri');
    expect(telInput('Contact Number').value).toBe('1140001234');
    expect((controlFor('Branch Email') as HTMLInputElement).value).toBe('vkp@techlingua.in');
    // id-backed selects prefill by id
    expect((controlFor('State') as HTMLSelectElement).value).toBe('1');
    expect((controlFor('City') as HTMLSelectElement).value).toBe('2');
    expect((controlFor('Branch Head') as HTMLSelectElement).value).toBe('3');
  });

  it('the Address is a real textarea and editing it reaches submit()', async () => {
    const submit = vi.fn().mockResolvedValue('Branch updated');
    render(<AddModal formKey="admin.branches" onClose={() => {}} edit={branchEdit(submit)} />);

    const address = controlFor('Address') as HTMLTextAreaElement;
    expect(address.tagName).toBe('TEXTAREA');
    expect(address.disabled).toBe(false);
    expect(address.readOnly).toBe(false);

    fireEvent.change(address, { target: { value: 'B-22 Ground Floor, Vikaspuri' } });
    expect(address.value).toBe('B-22 Ground Floor, Vikaspuri');

    fireEvent.click(screen.getByText('Save changes'));
    await vi.waitFor(() => expect(submit).toHaveBeenCalled());
    const [vals] = submit.mock.calls[0];
    expect(vals['Address']).toBe('B-22 Ground Floor, Vikaspuri');
    // and the untouched fields still go along
    expect(vals['Branch Name']).toBe('Vikaspuri');
  });
});

/* --------------- the same contract across the other modules --------------- */

/** Locking is legitimate ONLY for immutable hierarchy parent links / the stage set. */
const ALLOWED_LOCKS = ['Branch', 'Vertical', 'Campaign', 'Pipeline Stages'];

const CASES: Array<{ name: string; formKey: string; spec: EditSpec }> = [
  {
    name: 'Vertical', formKey: 'admin.verticals',
    spec: {
      title: 'Edit Vertical', lock: ['Branch'], submit: vi.fn(),
      initialVals: { 'Vertical Name': 'BCL', 'Vertical Code': 'BCL', Branch: 'Vikaspuri', Description: 'Bootcamp', Status: 'Active' },
      initialIds: { 'Vertical Head': 3 },
    },
  },
  {
    name: 'Pipeline', formKey: 'leads.pipelinemaster',
    spec: {
      title: 'Edit Pipeline', lock: ['Branch', 'Vertical', 'Pipeline Stages'], submit: vi.fn(),
      initialVals: { 'Pipeline Name': 'Admissions', 'Pipeline Code': 'ADM', Status: 'Active' },
      initialIds: { 'Pipeline Owner': 3 },
    },
  },
  {
    name: 'Source', formKey: 'leads.sources',
    spec: {
      title: 'Edit Source', lock: ['Campaign'], submit: vi.fn(),
      initialVals: { 'Source Name': 'Meta Ads', Status: 'Active' },  // UAT-R2 #4 — Category + Cost removed
    },
  },
  {
    name: 'Course', formKey: 'students.courses',
    spec: {
      title: 'Edit Course', submit: vi.fn(),
      initialVals: { 'Course Name': 'Java', 'Course Code': 'JV', 'Eligibility Criteria': 'Graduate', Status: 'Active' },
      initialIds: { Branch: 9, Vertical: 1 },
    },
  },
  {
    name: 'User', formKey: 'admin.users',
    spec: {
      title: 'Edit User', optional: ['Password / Login Method'], submit: vi.fn(),
      initialVals: { 'Full Name': 'Asha Rao', 'Email ID': 'asha@techlingua.in', 'Mobile Number': '+919000000002', Status: 'Active' },
      initialIds: { 'System Role': 2, 'Branch Access': 9 },
    },
  },
];

describe.each(CASES)('Edit $name modal', ({ formKey, spec }) => {
  it('locks nothing beyond immutable parent links, and everything else is editable', () => {
    for (const l of spec.lock ?? []) {
      expect(ALLOWED_LOCKS, `"${l}" is locked but is not an immutable parent link`).toContain(l);
    }
    render(<AddModal formKey={formKey} onClose={() => {}} edit={spec} />);
    for (const f of SPEC_FORMS[formKey].fields) {
      if (spec.lock?.includes(f.label)) continue;
      // 'auto' fields are system-generated placeholders in the Add form too — parity, not a bug
      if (f.type === 'auto' || f.type === 'table' || f.type === 'lookup') continue;
      expect(editable(f.label), `"${f.label}" must be editable in Edit ${formKey}`).toBe(true);
    }
  });
});
