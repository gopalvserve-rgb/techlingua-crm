/**
 * DEF-05 — a top-bar shortcut (Upcoming / Due Today) that re-navigates to Today's Follow-ups
 * while the screen is ALREADY mounted only changes the query string; the screen must re-seed its
 * follow-up preset from the new query (it used to seed on mount only, so the chip/header stayed on
 * the previous preset). We drive it exactly as the Shell does: the live location.search is fed in
 * through ScreenCtx, and changing it must move the active chip.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { DYN, ScreenCtx } from './dyn';

vi.mock('./auth', () => ({
  useAuth: () => ({ can: () => true, me: { user: { id: 3, name: 'Asha Rao' } } }),
}));

const REF = {
  branches: [], verticals: [], pipelines: [], campaigns: [], sources: [], courses: [],
  statuses: [], followupTypes: [], dispositions: [], budgets: [], users: [], states: [], cities: [],
  loaded: true, reload: () => undefined,
};
vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, useRef_: () => REF, toast: vi.fn() };
});

vi.mock('./api', () => ({
  api: {
    get: vi.fn(async (p: string) => (p.startsWith('/follow-ups/summary') ? {} : [])),
    post: vi.fn().mockResolvedValue({}), patch: vi.fn().mockResolvedValue({}), del: vi.fn(), put: vi.fn(),
  },
}));

const BASE_CTX = { go: vi.fn(), openLead: vi.fn(), openAdd: vi.fn(), refreshTick: 0, bump: vi.fn() };
function Harness({ search }: { search: string }) {
  const C = DYN['todayFollowups'];
  return <ScreenCtx.Provider value={{ ...BASE_CTX, search }}><C /></ScreenCtx.Provider>;
}
const chip = (name: string) => screen.getByRole('button', { name, pressed: true });

beforeEach(() => cleanup());
afterEach(() => cleanup());

describe('DEF-05 — Today’s Follow-ups re-seeds when the query changes on the open screen', () => {
  it('seeds the preset from the URL on mount', async () => {
    render(<Harness search="?followup=missed" />);
    expect(await waitFor(() => chip('Missed'))).toBeTruthy();
  });

  it('Missed -> Upcoming (next7): re-navigating with a new query moves the active chip', async () => {
    const { rerender } = render(<Harness search="?followup=missed" />);
    await waitFor(() => chip('Missed'));
    // simulate the top-bar "Upcoming" shortcut firing while already on this screen
    rerender(<Harness search="?followup=next7" />);
    expect(await waitFor(() => chip('Next 7 Days'))).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Missed' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('then Due Today (today): a second in-app re-nav re-seeds again', async () => {
    const { rerender } = render(<Harness search="?followup=next7" />);
    await waitFor(() => chip('Next 7 Days'));
    rerender(<Harness search="?followup=today" />);
    expect(await waitFor(() => chip('Today'))).toBeTruthy();
  });
});
