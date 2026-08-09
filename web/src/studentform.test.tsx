/**
 * STUDENT ADMISSION FORM — the behaviours the generic qa10 differential probe cannot drive,
 * proven directly (the coursecascade.test.tsx / pipeline-stages.test.tsx pattern):
 *   1. "Same as Permanent" copies Permanent -> Current and disables the Current field;
 *   2. Current Address persists independently when the box is unticked;
 *   3. State -> City cascade (City options are filtered by the chosen State; changing State
 *      clears City);
 *   4. Edit prefills every section and the PATCH carries the changes;
 *   5. every section's value reaches POST /students (a focused phantom-field check).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { StudentModal } from './dyn';

const REF = {
  branches: [{ id: 9, name: 'Vikaspuri' }, { id: 10, name: 'Rohini' }],
  verticals: [{ id: 1, name: 'BCL', branch_id: 9 }, { id: 2, name: 'PTE', branch_id: 9 }, { id: 3, name: 'Coaching', branch_id: 10 }],
  courses: [{ id: 21, name: 'IELTS', meta: { branch_id: 9, vertical_id: 1 } }],
  users: [{ id: 3, name: 'Asha Rao', status: 'active' }, { id: 4, name: 'Ravi Nair', status: 'active' }],
  states: [{ id: 1, name: 'Delhi' }, { id: 2, name: 'Maharashtra' }],
  cities: [{ id: 11, name: 'New Delhi', parent_id: 1 }, { id: 12, name: 'Dwarka', parent_id: 1 }, { id: 21, name: 'Mumbai', parent_id: 2 }],
  pipelines: [], campaigns: [], sources: [], masterSources: [], stages: [],
  statuses: [], followupTypes: [], dispositions: [], budgets: [],
  trainings: [], visitPurposes: [], walkinStatuses: [], ticketCategories: [],
  loaded: true, reload: () => undefined,
};

vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, useRef_: () => REF, toast: vi.fn() };
});

const post = vi.fn().mockResolvedValue({ id: 501, student_no: 'STU-0001', enrollment_no: 'EN-0001' });
const patch = vi.fn().mockResolvedValue({ id: 501 });
const get = vi.fn();
vi.mock('./api', () => ({ api: { get: (...a: any[]) => get(...a), post: (...a: any[]) => post(...a), patch: (...a: any[]) => patch(...a), del: vi.fn(), put: vi.fn() } }));

const flush = async () => { await act(async () => { await Promise.resolve(); }); };
const fldByLabel = (label: string): HTMLElement => {
  const flds = [...document.querySelectorAll('.add-modal .fld')] as HTMLElement[];
  const el = flds.find((f) => (f.querySelector('label')?.textContent ?? '').replace(/\*/g, '').trim().startsWith(label));
  if (!el) throw new Error(`no field "${label}"`);
  return el;
};
const ctl = (label: string): any => fldByLabel(label).querySelector("input, select, textarea");
const setV = (label: string, v: string) => fireEvent.change(ctl(label), { target: { value: v } });
const setTel = (label: string, v: string) => fireEvent.change(fldByLabel(label).querySelector('input[type=tel]') as HTMLInputElement, { target: { value: v } });
const saveBtn = () => document.querySelector('.add-modal .af .btn.primary') as HTMLButtonElement;

beforeEach(() => { cleanup(); post.mockClear(); patch.mockClear(); get.mockReset(); });

describe('Student Admission form', () => {
  it('"Same as Permanent" copies Permanent -> Current and DISABLES the Current field', async () => {
    render(<StudentModal onClose={() => undefined} onSaved={() => undefined} />);
    setV('Permanent Address', '221B Baker Street');
    const box = fldByLabel('Same as Permanent').querySelector('input[type=checkbox]') as HTMLInputElement;
    fireEvent.click(box);
    const current = ctl('Current Address') as HTMLTextAreaElement;
    expect(current.value).toBe('221B Baker Street');
    expect(current.disabled).toBe(true);
  });

  it('Current Address persists independently when NOT ticked', async () => {
    render(<StudentModal onClose={() => undefined} onSaved={() => undefined} />);
    setV('Student Full Name', 'Neha Verma');
    setV('Branch', '9'); await flush(); setV('Vertical', '1'); await flush();
    setV('Permanent Address', 'PERM-ADDR');
    setV('Current Address', 'CURR-ADDR');
    fireEvent.click(saveBtn());
    await waitFor(() => expect(post).toHaveBeenCalled());
    const body = post.mock.calls[0][1] as any;
    expect(body.permanent_address).toBe('PERM-ADDR');
    expect(body.current_address).toBe('CURR-ADDR');
  });

  it('State -> City cascade: City options follow the chosen State, and change of State clears City', async () => {
    render(<StudentModal onClose={() => undefined} onSaved={() => undefined} />);
    setV('State', '1'); await flush();
    let cityOpts = [...(ctl('City') as HTMLSelectElement).options].map((o) => o.textContent);
    expect(cityOpts).toContain('New Delhi');
    expect(cityOpts).toContain('Dwarka');
    expect(cityOpts).not.toContain('Mumbai');
    setV('City', '11'); await flush();
    expect((ctl('City') as HTMLSelectElement).value).toBe('11');
    setV('State', '2'); await flush();
    // City reset + now shows Maharashtra's cities only
    expect((ctl('City') as HTMLSelectElement).value).toBe('');
    cityOpts = [...(ctl('City') as HTMLSelectElement).options].map((o) => o.textContent);
    expect(cityOpts).toContain('Mumbai');
    expect(cityOpts).not.toContain('New Delhi');
  });

  it('POST carries every section (Identity/Contact/Guardian/Address/ID/Education) to /students', async () => {
    render(<StudentModal onClose={() => undefined} onSaved={() => undefined} />);
    setV('Student Full Name', 'Neha Verma');
    setV('Branch', '9'); await flush(); setV('Vertical', '1'); await flush();
    setV('Enrollment No.', 'EN-MANUAL-1');
    setV('Date of Birth', '2001-05-04');
    setV('Gender', 'Female');
    setTel('Primary Mobile', '9810000001');
    setTel('WhatsApp Number', '9810000002');
    setV('Father Name', 'Mr Verma');
    setV('Guardian Relation', 'Mother');
    setV('State', '1'); await flush(); setV('City', '11'); await flush();
    setV('Pincode', '110018');
    setV('ID Proof Type', 'Aadhaar');
    setV('Aadhaar Number', '123412341234');
    setV('Passing Year', '2022');
    fireEvent.click(saveBtn());
    await waitFor(() => expect(post).toHaveBeenCalledWith('/students', expect.anything()));
    const body = post.mock.calls[0][1] as any;
    expect(body).toMatchObject({
      full_name: 'Neha Verma', enrollment_no: 'EN-MANUAL-1', dob: '2001-05-04', gender: 'Female',
      branch_id: 9, vertical_id: 1, father_name: 'Mr Verma', guardian_relation: 'Mother',
      state_id: 1, city_id: 11, pincode: '110018', id_proof_type: 'Aadhaar', aadhaar: '123412341234',
      passing_year: '2022',
    });
    expect(body.phone).toBe('+919810000001');
    expect(body.whatsapp_phone).toBe('+919810000002');
  });

  it('Edit prefills the profile and PATCHes to /students/:id', async () => {
    const initial = {
      id: 501, student_no: 'STU-0007', enrollment_no: 'EN-0007', full_name: 'Old Name',
      dob: '2000-01-01T00:00:00.000Z', gender: 'Male', branch_id: 9, vertical_id: 1, course_id: 21,
      father_name: 'Papa', state_id: 1, city_id: 12, permanent_address: 'P', current_address: 'C',
      aadhaar: '999988887777', qualification: 'B.Sc',
    };
    render(<StudentModal initial={initial} onClose={() => undefined} onSaved={() => undefined} />);
    expect((ctl('Student Full Name')).value).toBe('Old Name');
    expect((ctl('Gender') as HTMLSelectElement).value).toBe('Male');
    expect((ctl('Date of Birth')).value).toBe('2000-01-01');
    expect((ctl('Father Name')).value).toBe('Papa');
    expect((ctl('Aadhaar Number')).value).toBe('999988887777');
    expect((ctl('Highest Qualification')).value).toBe('B.Sc');
    setV('Student Full Name', 'New Name');
    fireEvent.click(saveBtn());
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/students/501', expect.anything()));
    expect((patch.mock.calls[0][1] as any).full_name).toBe('New Name');
  });
});
