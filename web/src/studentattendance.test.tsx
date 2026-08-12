/**
 * STUDENT PROFILE — dedicated ATTENDANCE tab + enlarged modal (client request, docs/dev/58).
 * Proves, directly on StudentDetailModal:
 *   1. the profile modal uses the enlarged size class (.add-modal--xl);
 *   2. there is a dedicated "Attendance" tab (separate from "Academics");
 *   3. that tab renders the attendance SUMMARY (present %, present/absent/late counts) and the
 *      attendance RECORDS list (date India-formatted DD-MM-YYYY, batch, status).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor, within } from '@testing-library/react';
import { StudentDetailModal } from './dyn';

vi.mock('./auth', () => ({ useAuth: () => ({ can: () => true, me: { user: { id: 3, name: 'Asha Rao' } } }) }));

const PROFILE = {
  student: { id: 1, student_no: 'STU-0001', full_name: 'Neha Verma', status: 'active',
    branch_name: 'Vikaspuri', vertical_name: 'BCL', course_name: 'IELTS',
    branch_id: 9, vertical_id: 1, batch_id: 5, batch_name: 'IELTS-Morning' },
  siblings: [],
  academics: {
    current_batch: { id: 5, name: 'IELTS-Morning' }, transfers: [], waitlist: [],
    attendance: {
      summary: { total: 10, present: 8, absent: 1, late: 1, excused: 0, present_pct: 80 },
      records: [
        { id: 101, session_date: '2026-08-10', status: 'present', mode: 'online', batch_name: 'IELTS-Morning' },
        { id: 102, session_date: '2026-08-09', status: 'absent', mode: 'offline', batch_name: 'IELTS-Morning' },
      ],
    },
    tests: [], assignments: [],
  },
  certificates: [], report_cards: [],
  fees: { enrolments: [], receipts: [], summary: { net_fee_minor: 0, collected_minor: 0, balance_minor: 0, receipt_count: 0 } },
};

const get = vi.fn((...a: any[]) => {
  const url = String(a[0] ?? '');
  if (String(url).includes('/profile')) return Promise.resolve(PROFILE);
  if (String(url).includes('/batches')) return Promise.resolve([]);
  return Promise.resolve([]);
});
vi.mock('./api', () => ({ api: { get: (...a: any[]) => get(...a), post: vi.fn(), patch: vi.fn(), del: vi.fn(), put: vi.fn() } }));
vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, toast: vi.fn() };
});

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const tabBtn = (label: string) =>
  [...document.querySelectorAll('.fbp-rail button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;

beforeEach(() => { cleanup(); get.mockClear(); });

describe('Student profile — Attendance tab + enlarged modal', () => {
  it('the profile modal uses the enlarged size class', async () => {
    render(<StudentDetailModal student={PROFILE.student} onClose={() => undefined} onChanged={() => undefined} />);
    await flush();
    expect(document.querySelector('.add-modal.add-modal--xl')).toBeTruthy();
  });

  it('has a dedicated Attendance tab, separate from Academics', async () => {
    render(<StudentDetailModal student={PROFILE.student} onClose={() => undefined} onChanged={() => undefined} />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    await flush();
    expect(tabBtn('Attendance')).toBeTruthy();
    expect(tabBtn('Academics')).toBeTruthy();
  });

  it('the Attendance tab renders the summary and the India-formatted records', async () => {
    render(<StudentDetailModal student={PROFILE.student} onClose={() => undefined} onChanged={() => undefined} />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    await flush();
    fireEvent.click(tabBtn('Attendance')!);
    await flush();

    // Summary (scope to the section — the header stat chip also shows 80%)
    const sumSec = screen.getByText('Attendance Summary').closest('.sheet-sec') as HTMLElement;
    expect(sumSec).toBeTruthy();
    expect(within(sumSec).getByText('80%')).toBeTruthy();

    // Records table: India-formatted date (DD-MM-YYYY), batch, status
    const recSec = screen.getByText('Attendance Records').closest('.sheet-sec') as HTMLElement;
    expect(recSec).toBeTruthy();
    const scope = within(recSec);
    expect(scope.getByText('10-08-2026')).toBeTruthy();
    expect(scope.getByText('09-08-2026')).toBeTruthy();
    expect(scope.getAllByText('IELTS-Morning').length).toBeGreaterThan(0);
    expect(scope.getByText('present')).toBeTruthy();
    expect(scope.getByText('absent')).toBeTruthy();
  });
});
