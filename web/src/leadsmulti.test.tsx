/**
 * Multi-select list filters (client, Aug 2026): every Leads-list filter accepts MULTIPLE values.
 *   · the filters render as the searchable multi-select (UserPicker generic mode), not a <select>;
 *   · selecting TWO values sends the array param (status_ids=a,b) and refetches;
 *   · the hierarchy cascade still narrows child options — now across MULTIPLE selected parents.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { DYN, ScreenCtx } from './dyn';

vi.mock('./auth', () => ({
  useAuth: () => ({ can: () => true, me: { user: { id: 3, name: 'Asha Rao' } } }),
}));

const REF = {
  branches: [{ id: 9, name: 'Vikaspuri' }, { id: 10, name: 'Janakpuri' }],
  verticals: [
    { id: 1, name: 'BCL', branch_id: 9 }, { id: 2, name: 'INSTA', branch_id: 9 },
    { id: 3, name: 'JPVert', branch_id: 10 },
  ],
  pipelines: [], campaigns: [], sources: [],
  statuses: [{ id: 11, name: 'New' }, { id: 12, name: 'Contacted' }, { id: 13, name: 'Won' }],
  users: [{ id: 3, name: 'Asha' }, { id: 4, name: 'Neha' }],
  courses: [], followupTypes: [], dispositions: [], budgets: [], states: [], cities: [],
  loaded: true, reload: () => undefined,
};
vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, useRef_: () => REF, toast: vi.fn() };
});

const paths: string[] = [];
const get = vi.fn(async (p: string) => { paths.push(p); return { total: 0, rows: [] }; });
vi.mock('./api', () => ({
  api: { get: (p: string) => get(p), post: vi.fn().mockResolvedValue({}), patch: vi.fn().mockResolvedValue({}), del: vi.fn(), put: vi.fn() },
}));

const CTX = { go: vi.fn(), openLead: vi.fn(), openAdd: vi.fn(), refreshTick: 0, bump: vi.fn() } as any;
const draw = () => render(<ScreenCtx.Provider value={CTX}>{(() => { const C = DYN.leadsAll; return <C />; })()}</ScreenCtx.Provider>);

// open a FilterMulti's dropdown and return its container
const openFm = (testid: string) => {
  const box = screen.getByTestId(testid);
  fireEvent.focus(within(box).getByRole('combobox'));
  return box;
};

beforeEach(() => { paths.length = 0; try { localStorage.clear(); } catch { /* jsdom */ } });
afterEach(cleanup);

describe('the list filters are MULTI-SELECT (not single <select>)', () => {
  it('renders the reusable searchable multi-select for Status/Owner/Branch (no band <select>)', async () => {
    draw();
    await waitFor(() => expect(paths.length).toBeGreaterThan(0));
    expect(screen.getByTestId('fm-status')).toBeTruthy();
    expect(screen.getByTestId('fm-owner')).toBeTruthy();
    expect(screen.getByTestId('fm-branch')).toBeTruthy();
    // the old single-select band control is gone (band is the Hot/Warm/Cold multi-toggle now)
    expect(screen.queryByLabelText('Filter by score band')).toBeNull();
  });

  it('selecting TWO statuses sends status_ids=<a>,<b> and refetches', async () => {
    draw();
    await waitFor(() => expect(paths.length).toBeGreaterThan(0));
    const box = openFm('fm-status');
    fireEvent.mouseDown(await within(box).findByText('New'));
    fireEvent.mouseDown(within(box).getByText('Contacted'));
    await waitFor(() =>
      expect(paths.map((p) => decodeURIComponent(p)).some((p) => p.includes('status_ids=11,12'))).toBe(true));
  });

  it('selecting TWO owners sends owner_ids=<a>,<b>', async () => {
    draw();
    await waitFor(() => expect(paths.length).toBeGreaterThan(0));
    const box = openFm('fm-owner');
    fireEvent.mouseDown(await within(box).findByText('Asha'));
    fireEvent.mouseDown(within(box).getByText('Neha'));
    await waitFor(() =>
      expect(paths.map((p) => decodeURIComponent(p)).some((p) => p.includes('owner_ids=3,4'))).toBe(true));
  });

  it('the Hot band quick-chip is a multi-toggle -> bands=hot', async () => {
    draw();
    await waitFor(() => expect(paths.length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: 'Hot' }));
    await waitFor(() => expect(paths.some((p) => p.includes('bands=hot'))).toBe(true));
  });
});

describe('the hierarchy cascade still narrows child options — across MULTIPLE parents', () => {
  it('one branch shows only its verticals; adding a second branch reveals the other branch’s verticals', async () => {
    draw();
    await waitFor(() => expect(paths.length).toBeGreaterThan(0));
    // pick Vikaspuri only
    let bbox = openFm('fm-branch');
    fireEvent.mouseDown(await within(bbox).findByText('Vikaspuri'));
    // vertical options now = BCL, INSTA (branch 9) — NOT JPVert (branch 10)
    let vbox = openFm('fm-vertical');
    expect(await within(vbox).findByText('BCL')).toBeTruthy();
    expect(within(vbox).getByText('INSTA')).toBeTruthy();
    expect(within(vbox).queryByText('JPVert')).toBeNull();
    // add Janakpuri -> JPVert appears in the vertical options (verticals under ANY selected branch)
    bbox = openFm('fm-branch');
    fireEvent.mouseDown(await within(bbox).findByText('Janakpuri'));
    vbox = openFm('fm-vertical');
    expect(await within(vbox).findByText('JPVert')).toBeTruthy();
  });
});
