/**
 * UAT-R3b — fast focused web tests for this round's changes.
 *   #16 — the Course dropdown is GATED on Branch + Vertical: empty + a message until BOTH are
 *          chosen, then only that Branch+Vertical's courses; it resets when either changes.
 *   #24 — the Campaign detail carries a dedicated Agents / Managed toggle; agents have a
 *          working Pause/Resume that calls PATCH /campaigns/:id/agents/:userId/pause, and
 *          managers are shown as a visibility-only list with no pause control.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { AddModal } from './forms';
import { CampaignView } from './dyn';

vi.mock('./auth', () => ({ useAuth: () => ({ can: () => true, me: { user: { id: 1, name: 'Super Admin' } } }) }));

const REF = {
  branches: [{ id: 9, name: 'Vikaspuri' }, { id: 10, name: 'Janakpuri' }],
  verticals: [
    { id: 1, name: 'BCL', branch_id: 9 },
    { id: 3, name: 'PTE', branch_id: 10 },
  ],
  pipelines: [{ id: 4, name: 'Admissions', vertical_id: 1, branch_id: 9 }],
  campaigns: [{ id: 5, name: 'Meta Jul', pipeline_id: 4, vertical_id: 1, branch_id: 9 }],
  sources: [{ id: 7, name: 'Meta', campaign_id: 5 }],
  courses: [
    { id: 21, name: 'IELTS A1', meta: { branch_id: 9, vertical_id: 1, fee: 10000 } },
    { id: 22, name: 'PTE Pro',  meta: { branch_id: 10, vertical_id: 3, fee: 12000 } },
  ],
  masterSources: [], statuses: [], followupTypes: [], dispositions: [], budgets: [],
  users: [
    { id: 11, name: 'AGENT ONE', is_active: true }, { id: 12, name: 'AGENT TWO', is_active: true },
    { id: 13, name: 'AGENT THREE', is_active: true }, { id: 21, name: 'MGR ONE', is_active: true },
    { id: 22, name: 'MGR TWO', is_active: true },
  ],
  trainings: [], visitPurposes: [], walkinStatuses: [],
  states: [], cities: [], loaded: true, reload: () => undefined,
};
vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, useRef_: () => REF, toast: vi.fn() };
});
const patch = vi.fn().mockResolvedValue({ ok: true });
vi.mock('./api', () => ({ api: {
  get: vi.fn().mockResolvedValue([]), post: vi.fn().mockResolvedValue({ id: 1 }),
  patch: (...a: unknown[]) => patch(...a), del: vi.fn(), put: vi.fn(),
} }));

const flds = () => [...document.querySelectorAll('.add-modal .fld')];
const fldExact = (name: string) =>
  flds().find((f) => f.querySelector('label')?.textContent?.trim().startsWith(name)) as HTMLElement;
const sel = (name: string) => fldExact(name).querySelector('select') as HTMLSelectElement;
const courseVals = (name: string) => [...sel(name).options].filter((o) => o.value).map((o) => o.value);

beforeEach(() => { cleanup(); patch.mockClear(); });

describe('#16 — Course dropdown gates on Branch + Vertical (Add Lead)', () => {
  it('shows NO course options and a "choose Branch and Vertical first" message before selection', () => {
    render(<AddModal formKey="leads.all" onClose={() => undefined} />);
    expect(sel('Course').disabled).toBe(true);
    expect(courseVals('Course')).toEqual([]);
    expect(fldExact('Course').textContent).toContain('Please choose Branch and Vertical first');
  });

  it('still gates after ONLY Branch is chosen', () => {
    render(<AddModal formKey="leads.all" onClose={() => undefined} />);
    fireEvent.change(sel('Branch'), { target: { value: '9' } });
    expect(sel('Course').disabled).toBe(true);
    expect(courseVals('Course')).toEqual([]);
  });

  it('once BOTH are chosen, offers only that Branch+Vertical course', () => {
    render(<AddModal formKey="leads.all" onClose={() => undefined} />);
    fireEvent.change(sel('Branch'), { target: { value: '9' } });
    fireEvent.change(sel('Vertical'), { target: { value: '1' } });
    expect(sel('Course').disabled).toBe(false);
    expect(courseVals('Course')).toEqual(['21']);          // branch 9 / vertical 1 only, not PTE
  });

  it('resets the chosen Course when the Vertical changes', () => {
    render(<AddModal formKey="leads.all" onClose={() => undefined} />);
    fireEvent.change(sel('Branch'), { target: { value: '9' } });
    fireEvent.change(sel('Vertical'), { target: { value: '1' } });
    fireEvent.change(sel('Course'), { target: { value: '21' } });
    expect(sel('Course').value).toBe('21');
    fireEvent.change(sel('Branch'), { target: { value: '10' } });   // Branch change resets Vertical + Course
    expect(sel('Course').value).toBe('');
  });

  it('also gates on the Walk-in form (Course Interested)', () => {
    render(<AddModal formKey="dash.walkins" onClose={() => undefined} />);
    expect(sel('Course Interested').disabled).toBe(true);
    expect(fldExact('Course Interested').textContent).toContain('Please choose Branch and Vertical first');
    fireEvent.change(sel('Branch'), { target: { value: '10' } });
    fireEvent.change(sel('Vertical'), { target: { value: '3' } });
    expect(courseVals('Course Interested')).toEqual(['22']);       // branch 10 / vertical 3
  });
});

const campaign = {
  id: 5, name: 'Meta Jul', is_active: true,
  distribution_config: { mode: 'equal', batch_size: 10, agent_user_ids: [11, 12, 13] },
  duplicacy_config: {}, utm: {},
  manager_user_ids: [21, 22],
  paused_agent_user_ids: [12],
  created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z',
};
const btnByText = (t: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === t) as HTMLButtonElement;
const secBody = (title: string) => {
  const h = [...document.querySelectorAll('.sheet-sec h5')].find((x) => x.textContent?.trim() === title);
  return h?.parentElement as HTMLElement;
};

describe('#24 — Campaign Agents / Managed toggle with Pause/Resume', () => {
  it('renders an Agents / Managed toggle and shows agents by default with active/paused state', () => {
    render(<CampaignView campaign={campaign} leadCount={0} onClose={() => undefined} />);
    const sec = secBody('Agents / Managed');
    expect(sec).toBeTruthy();
    expect(btnByText('Agents (3)')).toBeTruthy();
    expect(btnByText('Managed (2)')).toBeTruthy();
    // three agents listed; agent 12 is paused (Resume), others active (Pause)
    expect(sec.textContent).toContain('AGENT ONE');
    expect(sec.textContent).toContain('AGENT TWO');
    expect(btnByText('Resume')).toBeTruthy();     // agent 12 paused
    expect([...document.querySelectorAll('button')].filter((b) => b.textContent === 'Pause').length).toBe(2);
  });

  it('Pause calls PATCH /campaigns/:id/agents/:userId/pause with paused:true', async () => {
    render(<CampaignView campaign={campaign} leadCount={0} onClose={() => undefined} />);
    const sec = secBody('Agents / Managed');
    // first agent row (AGENT ONE, active) → its Pause button
    const pauseBtns = [...sec.querySelectorAll('button')].filter((b) => b.textContent === 'Pause');
    fireEvent.click(pauseBtns[0]);
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch).toHaveBeenCalledWith('/campaigns/5/agents/11/pause', { paused: true });
  });

  it('Resume calls the endpoint with paused:false for a paused agent', async () => {
    render(<CampaignView campaign={campaign} leadCount={0} onClose={() => undefined} />);
    fireEvent.click(btnByText('Resume'));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch).toHaveBeenCalledWith('/campaigns/5/agents/12/pause', { paused: false });
  });

  it('Managed tab lists managers as visibility-only, with NO pause control', () => {
    render(<CampaignView campaign={campaign} leadCount={0} onClose={() => undefined} />);
    fireEvent.click(btnByText('Managed (2)'));
    const sec = secBody('Agents / Managed');
    expect(sec.textContent).toContain('MGR ONE');
    expect(sec.textContent).toContain('MGR TWO');
    expect(sec.textContent?.toLowerCase()).toContain('visibility');
    // no Pause/Resume buttons while on the Managed tab
    expect([...sec.querySelectorAll('button')].some((b) => /Pause|Resume/.test(b.textContent || ''))).toBe(false);
  });
});
