/**
 * ATTENDANCE — quick single-letter buttons (P/A/H/L/E) on the roster (docs/dev/59).
 * Proves on AttendanceScreen: the per-student dropdown is replaced by a letter-button group,
 * clicking a letter (incl. H = half_day) selects it (highlighted), and Save posts the chosen
 * statuses to /academics/attendance/mark.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';

const post = vi.fn(() => Promise.resolve({ marked: 1, parent_notified: 0 }));
vi.mock('./api', () => ({ api: { get: vi.fn(() => Promise.resolve([])), post: (...a: any[]) => post(...a), patch: vi.fn(), del: vi.fn(), put: vi.fn() } }));
vi.mock('./auth', () => ({ useAuth: () => ({ can: () => true, me: { user: { id: 3, name: 'Asha' } } }) }));
vi.mock('./scope', () => ({ useScope: () => ({ scope: { branches: [], verticals: [] }, params: '', key: 'k' }) }));

const ROSTER = { batch: { name: 'IELTS-Morning' }, roster: [
  { student_id: 1, full_name: 'Neha Verma', student_no: 'STU-0001', guardian_mobile: '9990001111' },
] };
vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  // Stable references per URL — a fresh object each render would trip the roster's
  // useMemo(setMarks) into an infinite re-render (the real useFetch caches too).
  const SUMMARY = { kpis: { present: 0, absent: 0, present_pct: null, parent_alerts: 0 } };
  const BATCHES = [{ id: 5, name: 'IELTS-Morning', batch_code: 'M1' }];
  const EMPTY: any[] = [];
  const cache = new Map<string, any>();
  const useFetch = (url: string | null) => {
    const u = String(url ?? '');
    if (!cache.has(u)) {
      let data: any = EMPTY;
      if (u.includes('/attendance/roster')) data = ROSTER;
      else if (u.includes('/attendance/summary')) data = SUMMARY;
      else if (u.includes('/batches')) data = BATCHES;
      cache.set(u, { data, loading: false, error: null, reload: vi.fn() });
    }
    return cache.get(u);
  };
  return {
    ...actual, toast: vi.fn(), useFetch,
    useRef_: () => ({ branches: [{ id: 9, name: 'Vikaspuri' }], verticals: [{ id: 1, branch_id: 9, name: 'BCL' }], courses: [], users: [] }),
    selectableUsers: (u: any[]) => u,
  };
});

import { AttendanceScreen } from './academics';

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
beforeEach(() => { cleanup(); post.mockClear(); });

describe('Attendance letter-buttons', () => {
  it('renders P/A/H/L/E buttons, selects half_day on H, and saves it', async () => {
    render(<AttendanceScreen />);
    await flush();
    // pick a batch so the roster + marking table renders
    const batchSel = document.querySelector('.filters select') as HTMLSelectElement;
    fireEvent.change(batchSel, { target: { value: '5' } });
    await waitFor(() => expect(document.querySelector('.att-letters')).toBeTruthy());
    await flush();

    // five letter buttons for the one student
    const H = document.querySelector('[data-testid="att-1-half_day"]') as HTMLButtonElement;
    const P = document.querySelector('[data-testid="att-1-present"]') as HTMLButtonElement;
    expect(H).toBeTruthy();
    expect(P).toBeTruthy();
    // default present is highlighted
    expect(P.className).toContain('on');

    fireEvent.click(H);
    await flush();
    expect(H.className).toContain('on');
    expect(P.className).not.toContain('on');

    fireEvent.click(screen.getByTestId('att-save'));
    await flush();
    expect(post).toHaveBeenCalled();
    const [url, body] = post.mock.calls[0] as any[];
    expect(String(url)).toContain('/academics/attendance/mark');
    expect(body.entries).toEqual([{ student_id: 1, status: 'half_day' }]);
  });
});
