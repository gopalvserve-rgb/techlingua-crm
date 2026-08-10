import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { CrossSell } from './crosssell';

/**
 * CROSS-SELL — the screen rendered in jsdom (the rule Add form is covered by the qa10
 * matrix). Asserts candidates + KPIs render, a filter drives the query, and the Act modal
 * posts the right body for each of the three actions (follow-up / new lead / dismiss).
 */

const can = vi.fn((_k: string) => true);
vi.mock('./auth', () => ({ useAuth: () => ({ can: (k: string) => can(k), me: { user: { id: 3, name: 'Asha Rao' } } }) }));

const REF = {
  branches: [{ id: 9, name: 'Vikaspuri' }], verticals: [{ id: 1, name: 'BCL', branch_id: 9 }],
  pipelines: [], campaigns: [], sources: [], masterSources: [],
  courses: [{ id: 100, name: 'IELTS' }, { id: 200, name: 'PTE' }],
  statuses: [], followupTypes: [], dispositions: [], budgets: [], trainings: [], visitPurposes: [], walkinStatuses: [],
  ticketCategories: [],
  users: [{ id: 3, name: 'Asha Rao', status: 'active' }, { id: 4, name: 'Ravi Nair', status: 'active' }],
  states: [], cities: [], loaded: true, reload: () => undefined,
};
vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, useRef_: () => REF, toast: vi.fn() };
});

const CANDIDATES = [{
  lead_id: 10, full_name: 'Meera K', phone: '+919812345678', email: 'm@x.io',
  branch_id: 9, vertical_id: 1, owner_id: 3, from_course_id: 100,
  branch_name: 'Vikaspuri', vertical_name: 'BCL', owner_name: 'Asha Rao',
  current_course_name: 'IELTS', suggested_course_id: 200, suggested_course_name: 'PTE', basis: 'rule',
}];

let lastGet = '';
const post = vi.fn().mockResolvedValue({ ok: true, id: 900, action: 'followup', follow_up_id: 900 });
const patch = vi.fn().mockResolvedValue({ id: 1, ok: true });
const getRoute = (path: string): Promise<unknown> => {
  lastGet = path;
  if (path.startsWith('/cross-sell/summary')) return Promise.resolve({ suggestions: 1, contacts: 1, followups: 0, leads: 0, dismissed: 0 });
  if (path.startsWith('/cross-sell/meta')) return Promise.resolve({ courses: REF.courses, actions: ['followup', 'lead', 'dismissed'] });
  if (path.startsWith('/cross-sell/candidates')) return Promise.resolve(CANDIDATES);
  if (path.startsWith('/cross-sell/attempts')) return Promise.resolve([]);
  if (path.startsWith('/cross-sell/rules')) return Promise.resolve([]);
  return Promise.resolve([]);
};

vi.mock('./api', () => ({
  api: {
    get: (p: string) => getRoute(p),
    post: (p: string, b?: unknown) => post(p, b),
    patch: (p: string, b?: unknown) => patch(p, b),
    del: vi.fn().mockResolvedValue({ ok: true }),
    put: vi.fn(),
  },
}));

beforeEach(() => { cleanup(); post.mockClear(); patch.mockClear(); can.mockReturnValue(true); });

describe('Cross-Sell — candidates', () => {
  it('renders the KPIs and a candidate row with its suggested course + basis', async () => {
    render(<CrossSell />);
    expect(await screen.findByText('Meera K')).toBeTruthy();
    expect(screen.getAllByText('IELTS').length).toBeGreaterThan(0);
    expect(screen.getAllByText('PTE').length).toBeGreaterThan(0);
    expect(screen.getByText('Rule')).toBeTruthy();
    expect(screen.getByText('Open suggestions')).toBeTruthy();
  });

  it('a branch filter drives the candidate query string', async () => {
    render(<CrossSell />);
    await screen.findByText('Meera K');
    // Branch is now a multi-select (FilterMulti/UserPicker): open the Branch picker and pick one.
    const box = screen.getByTestId('fm-branch');
    fireEvent.focus(within(box).getByRole('combobox'));
    fireEvent.mouseDown(await within(box).findByRole('option', { name: /Vikaspuri/ }));
    await waitFor(() => expect(lastGet).toContain('branch_ids=9'));
  });
});

describe('Cross-Sell — act on a suggestion', () => {
  it('Create follow-up posts action=followup for the (lead, suggested course) pair', async () => {
    render(<CrossSell />);
    fireEvent.click(await screen.findByText('Act'));
    fireEvent.click(await screen.findByText('Create follow-up'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/cross-sell/act',
      expect.objectContaining({ lead_id: 10, suggested_course_id: 200, action: 'followup' })));
  });

  it('Create new lead posts action=lead (routes through ingestion server-side)', async () => {
    render(<CrossSell />);
    fireEvent.click(await screen.findByText('Act'));
    fireEvent.click(await screen.findByText('Create new lead'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/cross-sell/act',
      expect.objectContaining({ lead_id: 10, suggested_course_id: 200, action: 'lead' })));
  });

  it('Dismiss posts action=dismissed so the pair drops off', async () => {
    render(<CrossSell />);
    fireEvent.click(await screen.findByText('Act'));
    fireEvent.click(await screen.findByText('Dismiss'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/cross-sell/act',
      expect.objectContaining({ lead_id: 10, suggested_course_id: 200, action: 'dismissed' })));
  });
});

describe('Cross-Sell — rules tab (admin)', () => {
  it('shows the Rules tab only with crosssell.manage', async () => {
    can.mockImplementation((k: string) => k !== 'crosssell.manage');
    render(<CrossSell />);
    await screen.findByText('Meera K');
    expect(screen.queryByText('Rules')).toBeNull();
  });
});
