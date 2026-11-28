/**
 * FB-2026-017 (client, 27 Nov 2026) — "there is a French Language in the course; now I don't know
 * which branch it is, which is vertical … I have to go to the edit and see it again and again.
 * So here you show it: branch, vertical, then course."
 *
 * Administration › Masters now says where each row belongs: a Course shows Branch + Vertical, a
 * Level shows Branch + Vertical + Course, read from the master's own meta.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { DYN, ScreenCtx } from './dyn';
import { masterScopeLabel } from './mastermodal';

vi.mock('./auth', () => ({ useAuth: () => ({ can: () => true, me: { user: { id: 3, name: 'Asha Rao' } } }) }));

const REF = {
  branches: [{ id: 9, name: 'Vikaspuri' }, { id: 10, name: 'Rohini' }],
  verticals: [{ id: 1, name: 'BCL', branch_id: 9 }, { id: 2, name: 'Spoken English', branch_id: 10 }],
  pipelines: [], campaigns: [], sources: [], statuses: [], followupTypes: [], dispositions: [], budgets: [],
  courses: [{ id: 21, name: 'French Language' }, { id: 22, name: 'German A1' }],
  users: [], states: [], cities: [], loaded: true, reload: () => undefined,
};
vi.mock('./refdata', async (orig) => {
  const actual = await orig<typeof import('./refdata')>();
  return { ...actual, useRef_: () => REF, toast: vi.fn() };
});

const TYPES = [
  { type: 'course', label: 'Courses', parent: null },
  { type: 'level', label: 'Levels', parent: null },
  { type: 'city', label: 'Cities', parent: 'state' },
];
const COURSES = [
  { id: 21, name: 'French Language', code: 'FRENCH', sort_order: 0, is_active: true, meta: { branch_id: 9, vertical_id: 1 } },
  { id: 22, name: 'German A1', code: 'GER_A1', sort_order: 1, is_active: true, meta: {} },
];
const LEVELS = [
  { id: 31, name: 'A1', code: 'A1', sort_order: 0, is_active: true,
    meta: { branch_ids: [9, 10], vertical_ids: [1], course_ids: [21, 22] } },
  { id: 32, name: 'Beginner', code: 'BEG', sort_order: 1, is_active: true, meta: {} },
];

let ROUTES: Record<string, unknown> = {};
vi.mock('./api', () => ({
  api: {
    get: (p: string) => {
      const key = Object.keys(ROUTES).sort((a, b) => b.length - a.length).find((k) => p.startsWith(k));
      return Promise.resolve(key === undefined ? [] : ROUTES[key]);
    },
    post: vi.fn().mockResolvedValue({}), patch: vi.fn().mockResolvedValue({}), del: vi.fn(), put: vi.fn(),
  },
}));

const CTX = { go: vi.fn(), openLead: vi.fn(), openAdd: vi.fn(), refreshTick: 0, bump: vi.fn() };
const draw = (initialType?: string) => {
  const C = DYN.mastersAdmin as any;
  return render(<ScreenCtx.Provider value={CTX as any}><C initialType={initialType} /></ScreenCtx.Provider>);
};
// a sortable column header carries a sort arrow — compare the label itself
const headers = () => [...document.querySelectorAll('th')].map((th) => (th.textContent ?? '').replace(/[^A-Za-z ]/g, '').trim());

beforeEach(() => {
  cleanup();
  ROUTES = { '/masters/course': COURSES, '/masters/level': LEVELS, '/masters': TYPES };
});

describe('Masters list says where a row belongs', () => {
  it('the Course master shows Branch and Vertical columns, filled from the course', async () => {
    draw('course');
    await waitFor(() => expect(screen.getByText('French Language')).toBeTruthy());
    expect(headers()).toContain('Branch');
    expect(headers()).toContain('Vertical');
    const row = screen.getByText('French Language').closest('tr')!;
    expect(row.textContent).toContain('Vikaspuri');
    expect(row.textContent).toContain('BCL');
    // a course with nothing picked shows a dash, not "All branches"
    const bare = screen.getByText('German A1').closest('tr')!;
    expect(bare.textContent).not.toContain('All branches');
  });

  it('the Level master shows Branch, Vertical and Course — every one it serves', async () => {
    draw('level');
    await waitFor(() => expect(screen.getAllByText('A1').length).toBeGreaterThan(0));
    expect(headers()).toContain('Course');
    const row = screen.getAllByText('A1')[0].closest('tr')!;   // the name cell; the code says A1 too
    expect(row.textContent).toContain('Vikaspuri, Rohini');
    expect(row.textContent).toContain('BCL');
    expect(row.textContent).toContain('French Language, German A1');
    // an unscoped LEVEL genuinely serves everything — say so, don't leave a dash
    const all = screen.getByText('Beginner').closest('tr')!;
    expect(all.textContent).toContain('All branches');
    expect(all.textContent).toContain('All courses');
  });

  it('a master with no hierarchy keeps the plain columns', async () => {
    draw('city');
    await waitFor(() => expect(headers()).toContain('Parent'));
    expect(headers()).not.toContain('Branch');
    expect(headers()).not.toContain('Vertical');
  });

  it('the Columns control is there, so the new columns can be arranged or hidden', async () => {
    draw('course');
    await waitFor(() => expect(screen.getByText('French Language')).toBeTruthy());
    expect(screen.getByText(/Columns/)).toBeTruthy();
  });

  it('opening a course row shows the same Branch / Vertical', async () => {
    draw('course');
    await waitFor(() => expect(screen.getByText('French Language')).toBeTruthy());
    fireEvent.click(screen.getByText('French Language').closest('tr')!.querySelector('[title="View"], button')!);
    await waitFor(() => expect(screen.getByText(/Course — French Language/)).toBeTruthy());
  });
});

describe('masterScopeLabel', () => {
  const opts = [{ id: 9, name: 'Vikaspuri' }, { id: 10, name: 'Rohini' }];
  it('reads the multi-select ids, the single legacy id, and says when it is unset', () => {
    expect(masterScopeLabel({ branch_ids: [9, 10] }, 'branch', opts)).toBe('Vikaspuri, Rohini');
    expect(masterScopeLabel({ branch_id: 10 }, 'branch', opts)).toBe('Rohini');
    expect(masterScopeLabel({}, 'branch', opts)).toBe('—');
    expect(masterScopeLabel(null, 'branch', opts, 'All branches')).toBe('All branches');
    // an id whose branch is gone must not render as an empty cell
    expect(masterScopeLabel({ branch_ids: [999] }, 'branch', opts, 'All branches')).toBe('All branches');
  });
});
