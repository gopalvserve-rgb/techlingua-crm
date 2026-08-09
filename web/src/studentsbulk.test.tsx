/**
 * OBS-2 — the Student Management list carries the full-list treatment: per-row + select-all
 * checkboxes (bulk-select) and, once rows are selected, the bulk-delete toolbar that posts the
 * chosen ids to /students/bulk-delete. Mirrors the leadbulk.test.tsx harness.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { DYN, ScreenCtx } from './dyn';

vi.mock('./auth', () => ({
  useAuth: () => ({ can: () => true, me: { user: { id: 3, name: 'Asha Rao' } } }),
}));

const REF = {
  branches: [{ id: 9, name: 'Vikaspuri' }], verticals: [{ id: 1, name: 'BCL', branch_id: 9 }],
  courses: [], users: [{ id: 3, name: 'Asha Rao', status: 'active' }],
  pipelines: [], campaigns: [], sources: [], statuses: [], followupTypes: [], dispositions: [],
  budgets: [], states: [], cities: [], loaded: true, reload: () => undefined,
};
vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, useRef_: () => REF, toast: vi.fn() };
});

const post = vi.fn().mockResolvedValue({ deleted: 2, skipped: 0 });
let ROUTES: Record<string, unknown> = {};
const get = vi.fn(async (p: string) => {
  const key = Object.keys(ROUTES).sort((a, b) => b.length - a.length).find((k) => p.startsWith(k));
  return key === undefined ? [] : ROUTES[key];
});
vi.mock('./api', () => ({
  api: { get: (p: string) => get(p), post: (p: string, b: unknown) => post(p, b), patch: vi.fn(), del: vi.fn(), put: vi.fn() },
}));

const CTX = { go: vi.fn(), openLead: vi.fn(), openAdd: vi.fn(), refreshTick: 0, bump: vi.fn(), search: '' };
const draw = (key: string) => render(
  <ScreenCtx.Provider value={CTX as never}>{(() => { const C = DYN[key]; return <C />; })()}</ScreenCtx.Provider>,
);

const STUDENTS = [
  { id: 501, full_name: 'Asha Rao', student_no: 'STU-0001', phone: '+919810000001', status: 'active', created_at: '2026-08-01T04:00:00Z' },
  { id: 502, full_name: 'Ravi Kumar', student_no: 'STU-0002', phone: '+919810000002', status: 'active', created_at: '2026-08-02T04:00:00Z' },
];

beforeEach(() => { post.mockClear(); ROUTES = { '/students?': STUDENTS, '/students': STUDENTS }; try { localStorage.clear(); } catch { /* jsdom */ } });
afterEach(() => cleanup());

describe('Student Management list — bulk-select + bulk-delete (OBS-2)', () => {
  it('renders select-all + per-row checkboxes and the bulk toolbar on selection', async () => {
    draw('studentsList');
    await screen.findByText('Asha Rao');
    expect(screen.getByLabelText('Select all rows on this page')).toBeTruthy();
    const cb = screen.getByLabelText('Select row 1');
    fireEvent.click(cb);
    const bar = await screen.findByTestId('bulk-bar');
    expect(bar.textContent).toContain('1 selected');
    // the bulk-delete affordance is present (the actual POST goes through the confirm modal).
    expect(screen.getByTestId('bulk-delete')).toBeTruthy();
  });
});
