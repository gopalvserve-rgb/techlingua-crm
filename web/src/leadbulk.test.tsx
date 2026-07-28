/**
 * Bulk actions on the Leads list (client request, Jul 2026):
 *   · the Classic view renders per-row + select-all checkboxes;
 *   · selecting rows reveals the bulk-action toolbar with a live count;
 *   · Bulk Pause posts the selected ids to /leads/bulk/pause;
 *   · Bulk Transfer opens the target cascade and posts /leads/bulk/transfer with the campaign;
 *   · a single-lead Transfer row action posts /leads/:id/transfer.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { DYN, ScreenCtx } from './dyn';

vi.mock('./auth', () => ({
  useAuth: () => ({ can: () => true, me: { user: { id: 3, name: 'Asha Rao' } } }),
}));

const REF = {
  branches: [{ id: 9, name: 'Vikaspuri' }], verticals: [{ id: 1, name: 'BCL', branch_id: 9 }],
  pipelines: [{ id: 4, name: 'Admissions', vertical_id: 1 }],
  campaigns: [{ id: 5, name: 'Meta Jul', pipeline_id: 4 }],
  sources: [], courses: [], statuses: [], followupTypes: [], dispositions: [], budgets: [],
  users: [], states: [], cities: [], loaded: true, reload: () => undefined,
};
vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, useRef_: () => REF, toast: vi.fn() };
});

const post = vi.fn().mockResolvedValue({ transferred: 2, reassigned: 2, paused: 2, resumed: 2, skipped: 0, already: 0 });
let ROUTES: Record<string, unknown> = {};
const get = vi.fn(async (p: string) => {
  const key = Object.keys(ROUTES).sort((a, b) => b.length - a.length).find((k) => p.startsWith(k));
  return key === undefined ? [] : ROUTES[key];
});
vi.mock('./api', () => ({
  api: { get: (p: string) => get(p), post: (p: string, b: unknown) => post(p, b), patch: vi.fn(), del: vi.fn(), put: vi.fn() },
}));

const CTX = { go: vi.fn(), openLead: vi.fn(), openAdd: vi.fn(), refreshTick: 0, bump: vi.fn() };
const draw = (key: string) => render(<ScreenCtx.Provider value={CTX}>{(() => { const C = DYN[key]; return <C />; })()}</ScreenCtx.Provider>);

const LEADS = {
  total: 2,
  rows: [
    { id: 100, full_name: 'Asha Rao', phone: '+919810000001', stage_name: 'New', stage_type: 'open' },
    { id: 101, full_name: 'Ravi Kumar', phone: '+919810000002', stage_name: 'New', stage_type: 'open' },
  ],
};

beforeEach(() => { post.mockClear(); ROUTES = { '/leads?': LEADS, '/leads': LEADS }; try { localStorage.clear(); } catch { /* jsdom */ } });
afterEach(() => cleanup());

describe('Leads bulk actions', () => {
  it('renders checkboxes; selecting a row shows the bulk toolbar with a count', async () => {
    draw('leadsAll');
    await screen.findByText('Asha Rao');
    // per-row checkbox for row 1
    const cb = screen.getByLabelText('Select row 1');
    fireEvent.click(cb);
    const bar = await screen.findByTestId('bulk-bar');
    expect(bar.textContent).toMatch(/1 selected/);
  });

  it('Bulk Pause posts the selected ids to /leads/bulk/pause', async () => {
    draw('leadsAll');
    await screen.findByText('Asha Rao');
    fireEvent.click(screen.getByLabelText('Select all rows on this page'));
    fireEvent.click(await screen.findByText('Pause'));
    // ConfirmModal
    fireEvent.click(await screen.findByText('Pause leads'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/leads/bulk/pause', expect.objectContaining({ lead_ids: [100, 101] })));
  });

  it('Bulk Transfer posts to /leads/bulk/transfer with the chosen campaign', async () => {
    draw('leadsAll');
    await screen.findByText('Asha Rao');
    fireEvent.click(screen.getByLabelText('Select all rows on this page'));
    fireEvent.click(await screen.findByText('Transfer'));
    // cascade lives INSIDE the modal (.add-modal) — scope to it so the list filters don't match
    const heading = await screen.findByText(/Transfer 2 leads/);
    const modal = heading.closest('.add-modal') as HTMLElement;
    const combos = within(modal).getAllByRole('combobox'); // Branch, Vertical, Pipeline, Campaign
    fireEvent.change(combos[0], { target: { value: '9' } });
    fireEvent.change(within(modal).getAllByRole('combobox')[1], { target: { value: '1' } });
    fireEvent.change(within(modal).getAllByRole('combobox')[2], { target: { value: '4' } });
    fireEvent.change(within(modal).getAllByRole('combobox')[3], { target: { value: '5' } });
    fireEvent.click(within(modal).getByText('Transfer all'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/leads/bulk/transfer', expect.objectContaining({ lead_ids: [100, 101], campaign_id: 5, owner_mode: 'keep' })));
  });

  it('single-lead Transfer row action posts /leads/:id/transfer', async () => {
    draw('leadsAll');
    await screen.findByText('Asha Rao');
    // the row Transfer icon button (title="Transfer")
    fireEvent.click(screen.getAllByTitle('Transfer')[0]);
    const heading = await screen.findByText(/Transfer lead/);
    const modal = heading.closest('.add-modal') as HTMLElement;
    fireEvent.change(within(modal).getAllByRole('combobox')[0], { target: { value: '9' } });
    fireEvent.change(within(modal).getAllByRole('combobox')[1], { target: { value: '1' } });
    fireEvent.change(within(modal).getAllByRole('combobox')[2], { target: { value: '4' } });
    fireEvent.change(within(modal).getAllByRole('combobox')[3], { target: { value: '5' } });
    fireEvent.click(within(modal).getByText('Transfer'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/leads/100/transfer', expect.objectContaining({ campaign_id: 5, owner_mode: 'keep' })));
  });
});
