/**
 * FB-2026-019 (Arman Khan, 27 Nov 2026) — "it should be searched here too, in Quick Contact".
 *
 * The Leads screen found his lead (through "search any lead", lead.search); the Dashboard's
 * Quick Contact answered "no matching" for the very same number. Quick Contact now runs the
 * same wider lookup and offers the leads its own search could not return.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { DYN, ScreenCtx } from './dyn';

let CAN = true;
vi.mock('./auth', () => ({
  useAuth: () => ({ can: (p: string) => (p === 'lead.search' ? CAN : true), me: { user: { id: 3, name: 'Arman Khan' } } }),
}));

const REF = {
  branches: [{ id: 9, name: 'Vikaspuri' }], verticals: [{ id: 1, name: 'BCL', branch_id: 9 }],
  pipelines: [{ id: 4, name: 'Admissions', vertical_id: 1 }],
  campaigns: [{ id: 5, name: 'Meta Jul', pipeline_id: 4 }],
  sources: [], courses: [], statuses: [], followupTypes: [], dispositions: [], budgets: [],
  users: [], states: [], cities: [], loaded: true, reload: () => undefined,
};
vi.mock('./refdata', async (orig) => {
  const actual = await orig<typeof import('./refdata')>();
  return { ...actual, useRef_: () => REF, toast: vi.fn() };
});

let ROUTES: Record<string, unknown> = {};
const paths: string[] = [];
vi.mock('./api', () => ({
  api: {
    get: (p: string) => {
      paths.push(p);
      const key = Object.keys(ROUTES).find((k) => p.startsWith(k));
      return Promise.resolve(key === undefined ? [] : ROUTES[key]);
    },
    post: vi.fn().mockResolvedValue({}), patch: vi.fn().mockResolvedValue({}), del: vi.fn(), put: vi.fn(),
  },
}));

const CTX = { go: vi.fn(), openLead: vi.fn(), openNotes: vi.fn(), openAdd: vi.fn(), refreshTick: 0, bump: vi.fn() };
const draw = () => {
  const C = DYN.quickContact;
  return render(<ScreenCtx.Provider value={CTX as any}><C /></ScreenCtx.Provider>);
};

const HITS = [
  { id: 460, full_name: 'Shivani Rao', phone: '+919811100001', in_scope: false, owner_name: 'Jeny Gabriel' },
  { id: 461, full_name: 'Shivani K', phone: '+919811100002', in_scope: false, owner_name: 'Rupesh Rana' },
];

beforeEach(() => { cleanup(); CAN = true; paths.length = 0; ROUTES = {}; });

describe('Quick Contact search reaches the same leads as the Leads search', () => {
  it('a number nobody of mine owns: the wider lookup runs and offers the leads it found', async () => {
    ROUTES = { '/leads/search-all': HITS, '/leads': { total: 0, rows: [] } };
    draw();
    fireEvent.change(screen.getByPlaceholderText('Contact Name'), { target: { value: 'Shivani' } });
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));
    const notice = await screen.findByTestId('qc-search-all-notice');
    expect(notice.textContent).toContain('2 more leads match “Shivani”');
    expect(paths).toContain('/leads/search-all?q=Shivani');
    fireEvent.click(notice);
    expect(await screen.findByTestId('lead-search-results')).toBeTruthy();  // searched already
    expect((screen.getByTestId('lead-search-input') as HTMLInputElement).value).toBe('Shivani');
  });

  it('a lead the search already returned is not counted twice', async () => {
    ROUTES = { '/leads/search-all': HITS, '/leads': { total: 1, rows: [{ id: 460, full_name: 'Shivani Rao' }] } };
    draw();
    fireEvent.change(screen.getByPlaceholderText('Contact Name'), { target: { value: 'Shivani' } });
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));
    const notice = await screen.findByTestId('qc-search-all-notice');
    expect(notice.textContent).toContain('1 more lead match');
  });

  it('without lead.search nothing extra is fetched and no chip appears', async () => {
    CAN = false;
    ROUTES = { '/leads/search-all': HITS, '/leads': { total: 0, rows: [] } };
    draw();
    fireEvent.change(screen.getByPlaceholderText('Contact Name'), { target: { value: 'Shivani' } });
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));
    await waitFor(() => expect(screen.queryByText('Matching contacts')).toBeTruthy());
    expect(paths.some((p) => p.startsWith('/leads/search-all'))).toBe(false);
    expect(screen.queryByTestId('qc-search-all-notice')).toBeNull();
    expect(screen.queryByTestId('qc-search-all')).toBeNull();
  });

  it('typed number: Quick Contact searches by what is in the phone box, not the name', async () => {
    ROUTES = { '/leads/search-all': [], '/leads': { total: 0, rows: [] } };
    draw();
    fireEvent.change(screen.getByPlaceholderText('Contact Number'), { target: { value: '9811100001' } });
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));
    await waitFor(() => expect(paths.some((p) => p.startsWith('/leads?') && p.includes('q=%2B919811100001'))).toBe(true));
    // and the "Search all leads" chip stays available when nothing of mine matched
    expect(await screen.findByTestId('qc-search-all')).toBeTruthy();
  });
});
