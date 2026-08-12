/**
 * STUDENT PROFILE — creative Facebook-style shell (docs/dev/59). Proves on StudentDetailModal:
 *   1. the enlarged modal carries the FB shell (cover, avatar, KPI stats, left rail);
 *   2. the left rail lists the tabs and DEFAULTS to "Fees Payment";
 *   3. the header shows the student name + avatar initials + attendance/fees stat chips;
 *   4. a "Transfer student" action is offered; the Academics tab shows Branch Transfers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor, within } from '@testing-library/react';
import { StudentDetailModal } from './dyn';

vi.mock('./auth', () => ({ useAuth: () => ({ can: () => true, me: { user: { id: 3, name: 'Asha Rao' } } }) }));

const PROFILE = {
  student: { id: 1, student_no: 'STU-0001', enrollment_no: 'ENR-1', full_name: 'Neha Verma', status: 'active',
    branch_name: 'Vikaspuri', vertical_name: 'BCL', course_name: 'IELTS',
    branch_id: 9, vertical_id: 1, batch_id: 5, batch_name: 'IELTS-Morning', admission_date: '2026-07-01' },
  photo_url: null,
  siblings: [],
  academics: {
    current_batch: { id: 5, name: 'IELTS-Morning' }, transfers: [], waitlist: [],
    branch_transfers: [
      { id: 1, created_at: '2026-08-01', from_branch_name: 'Janakpuri', to_branch_name: 'Vikaspuri',
        from_vertical_name: 'BCL', to_vertical_name: 'BCL', to_batch_name: 'IELTS-Morning',
        transferred_by_name: 'Asha Rao', reason: 'Closer to home' },
    ],
    attendance: { summary: { total: 10, present: 8, absent: 1, late: 1, excused: 0, half_day: 0, present_pct: 80 }, records: [] },
    tests: [], assignments: [],
  },
  certificates: [], report_cards: [],
  fees: { enrolments: [], receipts: [], summary: { net_fee_minor: 5000000, collected_minor: 2000000, balance_minor: 3000000, receipt_count: 1 } },
};

const get = vi.fn((...a: any[]) => {
  const url = String(a[0] ?? '');
  if (url.includes('/profile')) return Promise.resolve(PROFILE);
  if (url.includes('/batches')) return Promise.resolve([]);
  return Promise.resolve([]);
});
vi.mock('./api', () => ({ api: { get: (...a: any[]) => get(...a), post: vi.fn(), patch: vi.fn(), del: vi.fn(), put: vi.fn() } }));
vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, toast: vi.fn() };
});

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const railBtn = (label: string) =>
  [...document.querySelectorAll('.fbp-rail button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;

beforeEach(() => { cleanup(); get.mockClear(); });

describe('Student profile — creative FB-style shell', () => {
  it('renders the FB shell (cover, avatar, stats, left rail) inside the enlarged modal', async () => {
    render(<StudentDetailModal student={PROFILE.student} onClose={() => undefined} onChanged={() => undefined} />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    await flush();
    expect(document.querySelector('.add-modal.add-modal--xl')).toBeTruthy();
    expect(document.querySelector('.fbp-cover')).toBeTruthy();
    expect(document.querySelector('.fbp-avatar')).toBeTruthy();
    expect(document.querySelector('.fbp-stats')).toBeTruthy();
    expect(document.querySelector('.fbp-rail')).toBeTruthy();
  });

  it('shows the name, avatar initials and stat chips', async () => {
    render(<StudentDetailModal student={PROFILE.student} onClose={() => undefined} onChanged={() => undefined} />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    await flush();
    expect(screen.getByText('Neha Verma')).toBeTruthy();
    // initials fallback (no photo)
    expect(document.querySelector('.fbp-avatar')!.textContent).toBe('NV');
    // stat chips: attendance % and outstanding (₹ Indian)
    const stats = document.querySelector('.fbp-stats')! as HTMLElement;
    expect(within(stats).getByText('80%')).toBeTruthy();
    expect(within(stats).getByText('Attendance')).toBeTruthy();
    expect(within(stats).getByText('Outstanding')).toBeTruthy();
  });

  it('defaults to the Fees Payment tab (first in the rail)', async () => {
    render(<StudentDetailModal student={PROFILE.student} onClose={() => undefined} onChanged={() => undefined} />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    await flush();
    const fees = railBtn('Fees Payment');
    expect(fees).toBeTruthy();
    expect(fees!.className).toContain('on');
    expect(screen.getByText('Collection Summary')).toBeTruthy();
  });

  it('offers a Transfer student action and shows Branch Transfers on Academics', async () => {
    render(<StudentDetailModal student={PROFILE.student} onClose={() => undefined} onChanged={() => undefined} onEdit={() => undefined} />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    await flush();
    expect(screen.getByText('Transfer student')).toBeTruthy();
    fireEvent.click(railBtn('Academics')!);
    await flush();
    expect(screen.getByText('Branch Transfers')).toBeTruthy();
    expect(screen.getByText('Closer to home')).toBeTruthy();
  });
});
