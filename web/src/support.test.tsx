import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { SupportTickets } from './support';

/**
 * SUPPORT & TICKETS — the screen rendered in jsdom (the Add form itself is covered by the
 * generic qa10 matrix). Asserts the list + KPIs render, the filters drive the query, and
 * the detail view shows the thread and drives the lifecycle (close / reopen).
 */

const can = vi.fn((_k: string) => true);
vi.mock('./auth', () => ({ useAuth: () => ({ can: (k: string) => can(k), me: { user: { id: 3, name: 'Asha Rao' } } }) }));

const REF = {
  branches: [{ id: 9, name: 'Vikaspuri' }], verticals: [{ id: 1, name: 'BCL', branch_id: 9 }],
  pipelines: [], campaigns: [], sources: [], masterSources: [], courses: [],
  statuses: [], followupTypes: [], dispositions: [], budgets: [], trainings: [], visitPurposes: [], walkinStatuses: [],
  ticketCategories: [{ id: 91, name: 'Technical' }, { id: 92, name: 'Billing' }],
  users: [{ id: 3, name: 'Asha Rao', status: 'active' }, { id: 4, name: 'Ravi Nair', status: 'active' }],
  states: [], cities: [], loaded: true, reload: () => undefined,
};
vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, useRef_: () => REF, toast: vi.fn() };
});

const TICKETS = [{
  id: 77, ticket_no: 'SUP-0001', subject: 'Projector down in Room 3', category: 'Technical',
  priority: 'high', status: 'open', assignee_name: 'Ravi Nair', assignee_id: 4, created_by: 3,
  created_at: '2026-07-20T10:00:00Z', comment_count: 2, overdue: true,
  resolution_due_at: '2026-07-20T18:00:00Z',
}];
const DETAIL = {
  ...TICKETS[0], org_id: 1, description: 'The HDMI port is dead.', branch_name: 'Vikaspuri',
  vertical_name: 'BCL', reporter_name: 'Asha Rao', first_response_at: null, resolved_at: null, closed_at: null,
  comments: [
    { id: 1, body: 'Logged with facilities', is_internal: false, created_at: '2026-07-20T10:30:00Z', author_id: 4, author_name: 'Ravi Nair' },
    { id: 2, body: 'Spare projector on the way', is_internal: true, created_at: '2026-07-20T11:00:00Z', author_id: 4, author_name: 'Ravi Nair' },
  ],
};

let lastGet = '';
const post = vi.fn().mockResolvedValue({ id: 77, status: 'closed' });
const patch = vi.fn().mockResolvedValue({ id: 77, ok: true });
const getRoute = (path: string): Promise<unknown> => {
  lastGet = path;
  if (path.startsWith('/support-tickets/summary')) return Promise.resolve({ open: 1, in_progress: 0, resolved: 0, closed: 0, overdue: 1 });
  if (/^\/support-tickets\/\d+$/.test(path)) return Promise.resolve({ ...DETAIL, status: currentStatus });
  if (path.startsWith('/support-tickets')) return Promise.resolve(TICKETS);
  return Promise.resolve([]);
};
let currentStatus = 'resolved';

vi.mock('./api', () => ({
  api: {
    get: (p: string) => getRoute(p),
    post: (p: string, b?: unknown) => post(p, b),
    patch: (p: string, b?: unknown) => patch(p, b),
    del: vi.fn().mockResolvedValue({ ok: true }),
    put: vi.fn(),
  },
}));

beforeEach(() => { cleanup(); post.mockClear(); patch.mockClear(); can.mockReturnValue(true); currentStatus = 'resolved'; });

describe('Support Tickets — list', () => {
  it('renders the KPIs and a ticket row with its SLA overdue flag', async () => {
    render(<SupportTickets />);
    expect(await screen.findByText('SUP-0001')).toBeTruthy();
    expect(screen.getByText('Projector down in Room 3')).toBeTruthy();
    expect(screen.getAllByText('Overdue').length).toBeGreaterThan(0);
    expect(screen.getByText('Raise a ticket')).toBeTruthy();
  });

  it('a status filter drives the query string', async () => {
    render(<SupportTickets />);
    await screen.findByText('SUP-0001');
    const statusSel = screen.getByDisplayValue('All statuses') as HTMLSelectElement;
    fireEvent.change(statusSel, { target: { value: 'open' } });
    await waitFor(() => expect(lastGet).toContain('status=open'));
  });
});

describe('Support Tickets — detail + lifecycle', () => {
  it('opens the detail, shows the comment thread and can reopen a resolved ticket', async () => {
    currentStatus = 'resolved';
    render(<SupportTickets />);
    fireEvent.click(await screen.findByText('SUP-0001'));
    // thread renders
    expect(await screen.findByText('Logged with facilities')).toBeTruthy();
    expect(screen.getByText('Internal note')).toBeTruthy();
    // a resolved ticket offers Reopen and Mark Closed
    const reopen = await screen.findByText('Reopen');
    fireEvent.click(reopen);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/support-tickets/77/transition', { status: 'in_progress' }));
  });

  it('adds a comment through the thread box', async () => {
    render(<SupportTickets />);
    fireEvent.click(await screen.findByText('SUP-0001'));
    const box = await screen.findByPlaceholderText('Add a comment or reply…');
    fireEvent.change(box, { target: { value: 'Fixed now' } });
    fireEvent.click(screen.getByText('Add comment'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/support-tickets/77/comments', { body: 'Fixed now', is_internal: false }));
  });
});
