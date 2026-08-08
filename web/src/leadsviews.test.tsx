/**
 * UAT-R3b #11 — the Leads list has three switchable views (Classic / Modern / Inbox),
 * ported from the SaaS tenant. These tests pin the client-visible contract:
 *   · the switcher renders all three options;
 *   · switching changes the LAYOUT (classic <table> ↔ modern cards ↔ inbox split);
 *   · every view renders the leads from the SAME one /leads fetch;
 *   · the shared filters still reach the API in every view (no regression);
 *   · the Inbox left-click populates the right reading pane via /leads/:id.
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

let ROUTES: Record<string, unknown> = {};
const paths: string[] = [];
const get = vi.fn(async (p: string) => {
  paths.push(p);
  // longest key first so '/leads/100' wins over '/leads?'
  const key = Object.keys(ROUTES).sort((a, b) => b.length - a.length).find((k) => p.startsWith(k));
  return key === undefined ? [] : ROUTES[key];
});
vi.mock('./api', () => ({
  api: {
    get: (p: string) => get(p),
    post: vi.fn().mockResolvedValue({}), patch: vi.fn().mockResolvedValue({}),
    del: vi.fn(), put: vi.fn(),
  },
}));

const CTX = { go: vi.fn(), openLead: vi.fn(), openAdd: vi.fn(), refreshTick: 0, bump: vi.fn() };
const draw = (key: string) => render(<ScreenCtx.Provider value={CTX}>{(() => { const C = DYN[key]; return <C />; })()}</ScreenCtx.Provider>);

const LEADS = {
  total: 2,
  rows: [
    { id: 100, full_name: 'Asha Rao', phone: '+919810000001', temperature: 'hot', score: 82,
      stage_name: 'Qualified', stage_type: 'open', vertical_name: 'BCL', pipeline_name: 'Admissions',
      source_name: 'Meta Ads', owner_name: 'Neha', course_name: 'IELTS', sla_breached: true, is_flagged: true },
    { id: 101, full_name: 'Ravi Kumar', phone: '+919810000002', temperature: 'cold', score: 20,
      stage_name: 'New', stage_type: 'open', vertical_name: 'BCL', pipeline_name: 'Admissions',
      source_name: 'Meta Ads', owner_name: 'Neha', course_name: 'PTE', sla_breached: false },
  ],
};
const LEAD_100 = {
  id: 100, full_name: 'Asha Rao', phone: '+919810000001', email: 'asha@x.com', temperature: 'hot', score: 82,
  stage_name: 'Qualified', stage_type: 'open', vertical_name: 'BCL', pipeline_name: 'Admissions',
  source_name: 'Meta Ads', owner_name: 'Neha', course_name: 'IELTS', sla_breached: true, stages: [],
  activities: [{ id: 1, type: 'create', note: 'Lead captured from Meta Ads', occurred_at: '2026-07-20T10:00:00Z', actor_name: 'System' }],
};

beforeEach(() => { paths.length = 0; ROUTES = { '/leads/100': LEAD_100, '/leads?': LEADS, '/leads': LEADS }; try { localStorage.clear(); } catch { /* jsdom */ } });
afterEach(() => cleanup());

describe('#11 — Leads list three views (Classic / Modern / Inbox)', () => {
  it('the switcher renders all three options and Classic (default) is a real table', async () => {
    draw('leadsAll');
    expect(await screen.findByText('Asha Rao')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Classic/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Modern/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Inbox/ })).toBeTruthy();
    // default is Classic → the dense data table is present
    expect(document.querySelector('table.tbl')).toBeTruthy();
    expect(screen.queryByTestId('leads-modern')).toBeNull();
    expect(screen.getByRole('tab', { name: /Classic/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('switching to Modern changes the layout to cards and still shows the same leads', async () => {
    draw('leadsAll');
    fireEvent.click(await screen.findByRole('tab', { name: /Modern/ }));
    expect(await screen.findByTestId('leads-modern')).toBeTruthy();
    expect(document.querySelector('table.tbl')).toBeNull();          // no classic table anymore
    expect(screen.getByText('Asha Rao')).toBeTruthy();               // same data, new layout
    expect(screen.getByText('Ravi Kumar')).toBeTruthy();
    expect(screen.getByText('Hot 82')).toBeTruthy();                 // score chip surfaced
    expect(screen.getAllByTitle('SLA breached').length).toBeGreaterThan(0);
  });

  it('the shared filters still reach the API when a non-Classic view is active', async () => {
    draw('leadsAll');
    fireEvent.click(await screen.findByRole('tab', { name: /Modern/ }));
    await screen.findByTestId('leads-modern');
    fireEvent.click(screen.getByRole('button', { name: 'Hot' }));
    await waitFor(() => expect(paths.some((p) => p.includes('bands=hot'))).toBe(true));
  });

  it('Inbox shows a split list; a left-click populates the right pane from /leads/:id', async () => {
    draw('leadsAll');
    fireEvent.click(await screen.findByRole('tab', { name: /Inbox/ }));
    const inbox = await screen.findByTestId('leads-inbox');
    // both leads listed on the left; right pane starts empty
    expect(within(inbox).getByText('Select a lead to see its details')).toBeTruthy();
    // click Asha on the left → detail endpoint fetched, reading pane populated
    fireEvent.click(within(inbox).getByLabelText(/Open Asha Rao in the reading pane/));
    await waitFor(() => expect(paths.some((p) => p.startsWith('/leads/100'))).toBe(true));
    expect(await within(inbox).findByText('Open full')).toBeTruthy();
    expect(within(inbox).getByText('Lead captured from Meta Ads')).toBeTruthy();  // activity timeline
  });

  it('the chosen view is remembered (localStorage tl_leads_view)', async () => {
    draw('leadsAll');
    fireEvent.click(await screen.findByRole('tab', { name: /Modern/ }));
    await screen.findByTestId('leads-modern');
    expect(localStorage.getItem('tl_leads_view')).toBe('modern');
    cleanup();
    // a fresh mount reads the remembered choice
    draw('leadsAll');
    expect(await screen.findByTestId('leads-modern')).toBeTruthy();
  });
});
