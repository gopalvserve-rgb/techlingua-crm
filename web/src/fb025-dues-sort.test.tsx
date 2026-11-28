/**
 * FB-2026-025 (client, 27 Nov 2026) — "put the sorting option here too, in Fee Management, like
 * the Leads list; it will be the newest-first system. Today it goes anywhere."
 *
 * Two things made the order look random: there was no Sort control, and the grouping that turns
 * one row per instalment into one row per enrolment re-ordered the list by next due date,
 * whatever the server had sent.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { groupDuesByEnrolment, FeeDuesScreen } from './paymentplans';

vi.mock('./auth', () => ({ useAuth: () => ({ can: () => true, me: { user: { id: 3, name: 'Asha Rao' } } }) }));
vi.mock('./scope', () => ({ useScope: () => ({ scope: {} }) }));

const REF = {
  branches: [{ id: 9, name: 'Vikaspuri' }], verticals: [{ id: 1, name: 'BCL', branch_id: 9 }],
  courses: [], users: [], loaded: true, reload: () => undefined,
};
vi.mock('./refdata', async (orig) => {
  const actual = await orig<typeof import('./refdata')>();
  return { ...actual, useRef_: () => REF, toast: vi.fn() };
});

const paths: string[] = [];
vi.mock('./api', () => ({
  api: {
    get: (p: string) => { paths.push(p); return Promise.resolve(p.startsWith('/fee-dues/summary') ? {} : []); },
    post: vi.fn().mockResolvedValue({}), patch: vi.fn().mockResolvedValue({}), del: vi.fn(), put: vi.fn(),
  },
  getToken: () => 't',
}));

beforeEach(() => { cleanup(); paths.length = 0; });

describe('Fee Management — Sort', () => {
  it('offers the Leads-list Sort control and asks the server for the newest first', async () => {
    render(<FeeDuesScreen />);
    await waitFor(() => expect(paths.some((p) => p.startsWith('/fee-dues?'))).toBe(true));
    expect(paths.some((p) => p.startsWith('/fee-dues?') && p.includes('sort=recent'))).toBe(true);
    const sel = screen.getByLabelText('Sort fee dues') as HTMLSelectElement;
    expect([...sel.options].map((o) => o.textContent)).toEqual([
      'Newest first', 'Oldest first', 'Most overdue first', 'Next due date',
      'Due fee: high to low', 'Due fee: low to high', 'Student (A-Z)', 'Enrolment no.',
    ]);
  });

  it('changing the sort re-asks the server (so the row cap keeps the right rows)', async () => {
    render(<FeeDuesScreen />);
    await waitFor(() => expect(paths.some((p) => p.startsWith('/fee-dues?'))).toBe(true));
    paths.length = 0;
    fireEvent.change(screen.getByLabelText('Sort fee dues'), { target: { value: 'amount' } });
    await waitFor(() => expect(paths.some((p) => p.startsWith('/fee-dues?') && p.includes('sort=amount'))).toBe(true));
  });
});

describe('groupDuesByEnrolment keeps the order the server sent', () => {
  const inst = (enrolment_id: number, seq_no: number, due_date: string, outstanding_minor = 1000) =>
    ({ enrolment_id, seq_no, due_date, outstanding_minor, overdue_days: 0, bucket: 'not_due', student_name: `S${enrolment_id}` });

  it('one row per enrolment, in the order the enrolments first appear', () => {
    const rows = groupDuesByEnrolment([
      inst(7, 1, '2027-03-01'),          // newest enrolment first, as the server sorted it
      inst(3, 2, '2026-12-02'),
      inst(3, 1, '2026-11-02'),          // an earlier instalment of an enrolment already placed
      inst(4, 1, '2026-10-01'),
    ]);
    expect(rows.map((r) => r.enrolment_id)).toEqual([7, 3, 4]);
    // the row shown for an enrolment is still its EARLIEST instalment
    const r3 = rows.find((r) => r.enrolment_id === 3)!;
    expect(r3.seq_no).toBe(1);
    expect(r3.due_date).toBe('2026-11-02');
    expect(r3.due_count).toBe(2);
    expect(r3.outstanding_minor).toBe(2000);
  });
});
