import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import {
  CounsellorPerformance, FeeCollection, MonthlyTargets, Quotations, SaleClosure,
  CollectModal, EnrolmentModal, SendQuoteModal,
} from './sprint5';
import { CONVERSION_LABEL_COUNSELLOR, CONVERSION_LABEL_LEAD_WON } from './metrics';

/**
 * SPRINT 5 — every new screen RENDERED in jsdom.
 *
 * The point is not coverage arithmetic. It is that Sprint 3 shipped a dashboard whose
 * SQL only Postgres could falsify, and Sprint 4 shipped a "Send test" that tested the
 * wrong SMTP — both invisible to a suite that never rendered the thing. So: render every
 * screen, with data and empty, and assert the sentences the CLIENT will read — especially
 * the ones that stop him believing something untrue about Phase 3.
 */

const can = vi.fn((_k: string) => true);
vi.mock('./auth', () => ({ useAuth: () => ({ can: (k: string) => can(k), me: { user: { id: 3, name: 'Asha Rao' } } }) }));

const REF = {
  branches: [{ id: 9, name: 'Vikaspuri' }],
  verticals: [{ id: 1, name: 'BCL', branch_id: 9 }],
  pipelines: [], campaigns: [], sources: [], masterSources: [],
  courses: [{ id: 21, name: 'IELTS', meta: { fee: 45000 } }, { id: 22, name: 'PTE', meta: { fee: 38000 } }],
  statuses: [], followupTypes: [], dispositions: [], budgets: [],
  users: [{ id: 3, name: 'Asha Rao', status: 'active' }, { id: 4, name: 'Ravi Nair', status: 'active' }],
  states: [], cities: [], loaded: true, reload: () => undefined,
};
vi.mock('./refdata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refdata')>();
  return { ...actual, useRef_: () => REF, toast: vi.fn() };
});

const QUOTES = [{
  id: 1, quote_no: 'QT-2026/0001', version: 1, status: 'sent', valid_until: '2026-08-15',
  subtotal_minor: 6_625_000, discount_minor: 500_000, tax_minor: 1_021_500, total_minor: 7_146_500,
  created_at: '2026-07-16T10:00:00Z', lead_id: 31, lead_name: 'Priya Sharma', lead_phone: '+919810000011',
  branch_name: 'Vikaspuri', vertical_name: 'BCL', owner_name: 'Asha Rao',
  course_names: 'IELTS', item_count: 3,
}];
const ENROLMENTS = [{
  id: 61, enrolment_no: 'ENR-2026/0001', status: 'active', start_date: '2026-08-01',
  payment_plan: 'emi_3', fee_minor: 4_500_000, discount_minor: 450_000, net_fee_minor: 4_050_000,
  first_payment_minor: 2_000_000, created_at: '2026-07-16T10:00:00Z', lead_id: 31, quotation_id: 1,
  course_id: 21, lead_name: 'Priya Sharma', lead_phone: '+919810000011', course_name: 'IELTS',
  branch_name: 'Vikaspuri', vertical_name: 'BCL', counsellor_name: 'Asha Rao', quote_no: 'QT-2026/0001',
  paid_minor: 2_000_000, balance_minor: 2_050_000,
}];
const RECEIPTS = [{
  id: 71, receipt_no: 'RCP-2026/0001', amount_minor: 2_000_000, mode: 'upi', reference: 'UTR9876543210',
  received_at: '2026-07-16T11:30:00Z', note: null, enrolment_id: 61, enrolment_no: 'ENR-2026/0001',
  net_fee_minor: 4_050_000, lead_name: 'Priya Sharma', course_name: 'IELTS',
  branch_name: 'Vikaspuri', vertical_name: 'BCL', received_by_name: 'Asha Rao',
}];

let empty = false;
const post = vi.fn().mockResolvedValue({ id: 99, receipt_no: 'RCP-2026/0002', balance_minor: 50_000, fully_paid: false });
const del = vi.fn().mockResolvedValue({ ok: true });

const getRoute = (path: string): Promise<unknown> => {
  const E = <T,>(v: T, e: T) => Promise.resolve(empty ? e : v);
  if (path.startsWith('/quotations/summary')) return E({ draft: 1, sent: 2, accepted: 3, rejected: 0, expired: 0, accepted_minor: 12_000_000, open_minor: 7_146_500 }, { draft: 0, sent: 0, accepted: 0, accepted_minor: 0, open_minor: 0 });
  if (/^\/quotations\/\d+$/.test(path)) {
    return Promise.resolve({
      ...QUOTES[0], notes: 'Weekend batch', terms: '50% on enrolment',
      items: [{ line_no: 1, description: 'IELTS Academic', course_name: 'IELTS', qty: 1, unit_price_minor: 4_500_000, discount_type: 'percent', discount_value: '10', discount_minor: 450_000, tax_pct: '18', tax_minor: 729_000, total_minor: 4_779_000 }],
      versions: [{ id: 1, quote_no: 'QT-2026/0001', version: 1, status: 'sent', total_minor: 7_146_500, created_at: '2026-07-16T10:00:00Z', is_current: true }],
    });
  }
  if (path.startsWith('/quotations')) return E(QUOTES, []);
  if (path.startsWith('/enrolments/summary')) return E({ mtd_count: 4, mtd_revenue_minor: 16_200_000, pending_approval: 1, avg_discount_pct: 8.5 }, { mtd_count: 0, mtd_revenue_minor: 0, pending_approval: 0, avg_discount_pct: 0 });
  if (path.startsWith('/enrolments/meta')) return Promise.resolve({ payment_plans: [{ key: 'full', label: 'Full payment' }, { key: 'emi_3', label: '3 installments' }], approvals: { enabled: false, steps: [] } });
  if (path.startsWith('/enrolments/approval-policy')) return Promise.resolve({ enabled: false, steps: [] });
  if (path.startsWith('/enrolments/approvals')) return Promise.resolve([]);
  if (path.startsWith('/enrolments')) return E(ENROLMENTS, []);
  if (path.startsWith('/fees/summary')) return E({ mtd_minor: 2_000_000, today_minor: 2_000_000, receipts: 1, outstanding_minor: 2_050_000, by_mode: [{ mode: 'upi', label: 'UPI', total_minor: 2_000_000, n: 1 }] }, { mtd_minor: 0, today_minor: 0, receipts: 0, outstanding_minor: 0, by_mode: [] });
  if (path.startsWith('/fees/meta')) return Promise.resolve({ modes: [{ key: 'cash', label: 'Cash' }, { key: 'upi', label: 'UPI' }], online: { gateway_capture: false, phase: 3, note: 'Phase 3' } });
  if (path.startsWith('/fees/receipts')) return E(RECEIPTS, []);
  if (path.startsWith('/performance/leaderboard')) {
    return E([{ user_id: 3, user_name: 'Asha Rao', leads: 20, enrolments: 5, conversion_pct: 25, revenue_minor: 22_500_000, collected_minor: 5_000_000, activities: 42, followups_due: 10, followups_ontime: 8, adherence_pct: 80, tat_median_minutes: 30 }], []);
  }
  if (path.startsWith('/performance/summary')) return E({ counsellors: 1, leads: 20, enrolments: 5, conversion_pct: 25, revenue_minor: 22_500_000, collected_minor: 5_000_000, best: { user_name: 'Asha Rao', enrolments: 5 } }, { counsellors: 0, leads: 0, enrolments: 0, conversion_pct: 0, revenue_minor: 0, collected_minor: 0, best: null });
  if (path.startsWith('/performance/targets')) {
    return E([
      { id: 1, scope_type: 'user', user_id: 3, label: 'Asha Rao', enrolment_target: 10, actual_enrolments: 5, revenue_target_minor: 50_000_000, actual_revenue_minor: 22_500_000, enrolment_pct: 50, revenue_pct: 45 },
      { id: 2, scope_type: 'branch', branch_id: 9, label: 'Vikaspuri', enrolment_target: 40, actual_enrolments: 30, revenue_target_minor: 100_000_000, actual_revenue_minor: 90_000_000, enrolment_pct: 75, revenue_pct: 90 },
    ], []);
  }
  if (path.startsWith('/templates')) return Promise.resolve([{ id: 50, channel: 'email', name: 'Quote email' }]);
  return Promise.resolve([]);
};

vi.mock('./api', () => ({
  api: {
    get: (p: string) => getRoute(p),
    post: (p: string, b?: unknown) => post(p, b),
    patch: vi.fn().mockResolvedValue({ id: 1 }),
    del: (p: string) => del(p),
    put: vi.fn(),
  },
}));

beforeEach(() => { cleanup(); empty = false; post.mockClear(); del.mockClear(); can.mockReturnValue(true); });

/* ==================================================================== */

describe('Quotations', () => {
  it('renders the list, the KPIs and Indian-grouped money', async () => {
    render(<Quotations />);
    expect(await screen.findByText('QT-2026/0001')).toBeTruthy();
    expect(screen.getByText('Priya Sharma')).toBeTruthy();
    // the total appears in the row AND in the "Value in play" KPI — both are correct
    expect(screen.getAllByText('₹71,465.00').length).toBeGreaterThan(0);   // 2,2,3 grouping
    expect(screen.getByText('Sent')).toBeTruthy();
    expect(screen.getByText('Value accepted')).toBeTruthy();
  });

  it('shows a clean empty state, never a fake row', async () => {
    empty = true;
    render(<Quotations />);
    expect(await screen.findByText(/No quotations yet/)).toBeTruthy();
  });

  it('hides "New quotation" from a user without quotation.create', async () => {
    can.mockImplementation((k: string) => k !== 'quotation.create');
    render(<Quotations />);
    await screen.findByText('QT-2026/0001');
    expect(screen.queryByText('New quotation')).toBeNull();
  });

  it('the quotation sheet shows the lines, the totals and the revision history', async () => {
    render(<Quotations />);
    fireEvent.click(await screen.findByText('QT-2026/0001'));
    expect(await screen.findByText('IELTS Academic')).toBeTruthy();
    expect(screen.getByText('Line items')).toBeTruthy();
    expect(screen.getAllByText('₹45,000.00').length).toBeGreaterThan(0);
    expect(screen.getByText('Subtotal')).toBeTruthy();
    expect(screen.getByText('-₹5,000.00')).toBeTruthy();       // the discount, shown negative
  });

  /**
   * THE LIVE SMOKE FOUND THIS. With no channel configured, `Send` always fails, so a
   * DRAFT was a dead end — no accept, no enrolment, no revenue, until the client pastes
   * an SMTP password. "Mark as sent" is the offline despatch a counsellor actually uses.
   */
  it('a DRAFT offers "Mark as sent" — the conversion flow is NOT blocked on a credential', async () => {
    render(<Quotations />);
    fireEvent.click(await screen.findByText('QT-2026/0001'));
    await screen.findByText('Line items');
    // the fixture quote is `sent`, so re-check against a draft
    cleanup();
    const draft = { ...QUOTES[0], status: 'draft' };
    QUOTES[0] = draft as never;
    render(<Quotations />);
    fireEvent.click(await screen.findByText('QT-2026/0001'));
    await screen.findByText('Line items');
    const footer = document.querySelector('.add-modal .af')!;
    expect(footer.textContent).toContain('Mark as sent');
    QUOTES[0] = { ...draft, status: 'sent' } as never;
  });

  /**
   * DEF-S16-01 — THE TEST THIS FILE SHOULD ALWAYS HAVE HAD.
   *
   * The version below used to end at `not.toContain('Edit')`, with the comment
   * "a SENT quote is revised, not edited" — and NEVER ASSERTED THAT REVISE EXISTED.
   * It encoded the intention and pinned the absence of the wrong button, so it stayed
   * green for the entire life of the defect: the API refused to edit a sent quote and
   * told the counsellor to "create a revision instead", and there was no Revise button
   * anywhere in the app. A sent quotation whose price had to change was a dead end.
   *
   * Asserting the absence of a button is worth almost nothing on its own. Assert the DOOR.
   */
  it('a SENT quotation offers Accepted / Rejected and REVISE, not Edit', async () => {
    render(<Quotations />);
    fireEvent.click(await screen.findByText('QT-2026/0001'));
    await screen.findByText('Line items');
    // the two decision buttons live in the modal footer; "Accepted" also appears as a
    // KPI label on the list behind it, so scope the query to the footer.
    const footer = document.querySelector('.add-modal .af')!;
    expect(footer.textContent).toContain('Accepted');
    expect(footer.textContent).toContain('Rejected');
    expect(footer.textContent).toContain('PDF');
    expect(footer.textContent).not.toContain('Edit');    // a SENT quote is revised, not edited
    expect(footer.textContent).toContain('Revise');      // ...and REVISE is how (DEF-S16-01)
  });

  it('Revise opens the quotation prefilled — the counsellor renegotiates, he does not retype', async () => {
    render(<Quotations />);
    fireEvent.click(await screen.findByText('QT-2026/0001'));
    await screen.findByText('Line items');
    fireEvent.click(screen.getByText('Revise'));
    // the form is the quotation form, titled as a revision, carrying v1's lines
    expect(await screen.findByText('Revise QT-2026/0001')).toBeTruthy();
    expect((document.getElementById('q-valid') as HTMLInputElement).value).toBe('2026-08-15');
    expect((document.querySelector('.add-modal input[value="IELTS Academic"]') as HTMLInputElement)
      ?? screen.getByDisplayValue('IELTS Academic')).toBeTruthy();
  });

  it('Revise POSTs to /revise — NOT to PATCH, which the API refuses on a sent quote', async () => {
    render(<Quotations />);
    fireEvent.click(await screen.findByText('QT-2026/0001'));
    await screen.findByText('Line items');
    fireEvent.click(screen.getByText('Revise'));
    await screen.findByText('Revise QT-2026/0001');
    // "Create revision", not "Save changes" — the button says what actually happens.
    fireEvent.click(screen.getByText('Create revision'));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, body] = post.mock.calls[post.mock.calls.length - 1];
    expect(path).toBe('/quotations/1/revise');
    // and the revision does NOT carry a lead_id: revise() inherits the parent's lead and
    // path, so a revision can never be moved to a different customer.
    expect((body as any).lead_id).toBeUndefined();
    expect((body as any).items.length).toBeGreaterThan(0);
  });

  it('the lead is LOCKED on a revision — a revision is the same customer, a new version', async () => {
    render(<Quotations />);
    fireEvent.click(await screen.findByText('QT-2026/0001'));
    await screen.findByText('Line items');
    fireEvent.click(screen.getByText('Revise'));
    await screen.findByText('Revise QT-2026/0001');
    expect((document.getElementById('q-lead') as HTMLInputElement).disabled).toBe(true);
  });

  it('Revise is RBAC-gated on quotation.create — the same permission the API asks for', async () => {
    // a button that 403s is worse than no button.
    can.mockImplementation((k: string) => k !== 'quotation.create');
    render(<Quotations />);
    fireEvent.click(await screen.findByText('QT-2026/0001'));
    await screen.findByText('Line items');
    expect(document.querySelector('.add-modal .af')!.textContent).not.toContain('Revise');
  });

  it('a DRAFT is edited, not revised — there is nothing to preserve yet', async () => {
    cleanup();
    const draft = { ...QUOTES[0], status: 'draft' };
    QUOTES[0] = draft as never;
    render(<Quotations />);
    fireEvent.click(await screen.findByText('QT-2026/0001'));
    await screen.findByText('Line items');
    const footer = document.querySelector('.add-modal .af')!;
    expect(footer.textContent).toContain('Edit');
    expect(footer.textContent).not.toContain('Revise');
    QUOTES[0] = { ...draft, status: 'sent' } as never;
  });
});

describe('SendQuoteModal — the not-configured path is VISIBLE', () => {
  it('says NOT SENT and quotes the provider\'s own reason', async () => {
    post.mockResolvedValueOnce({ sent: false, status: 'failed', reason: 'Email is not configured for this vertical — add SMTP in Settings › Channels.' });
    render(<SendQuoteModal quote={{ id: 1, quote_no: 'QT-2026/0001' }} onClose={() => undefined} onSent={() => undefined} />);
    fireEvent.click(screen.getByText('Send'));
    // THE POINT: the client is never told "sent" when a credential is missing.
    expect(await screen.findByText(/Not sent\./)).toBeTruthy();
    expect(screen.getByText(/not configured for this vertical/)).toBeTruthy();
  });

  it('says SENT when it really went', async () => {
    post.mockResolvedValueOnce({ sent: true, status: 'sent', message_id: 7 });
    render(<SendQuoteModal quote={{ id: 1, quote_no: 'QT-2026/0001' }} onClose={() => undefined} onSent={() => undefined} />);
    fireEvent.click(screen.getByText('Send'));
    expect(await screen.findByText(/Sent by email/)).toBeTruthy();
  });
});

describe('Sale Closure', () => {
  it('renders the enrolment list with net fee, collected and balance as separate columns', async () => {
    render(<SaleClosure />);
    expect(await screen.findByText('ENR-2026/0001')).toBeTruthy();
    expect(screen.getByText('₹40,500.00')).toBeTruthy();     // net fee
    expect(screen.getByText('₹20,000.00')).toBeTruthy();     // collected
    expect(screen.getByText('₹20,500.00')).toBeTruthy();     // balance
    expect(screen.getByText('3 EMI')).toBeTruthy();
  });

  it('tells the client plainly that approvals are OFF, and where to switch them on', async () => {
    render(<SaleClosure />);
    expect(await screen.findByText(/a counsellor closes a sale and it is closed/)).toBeTruthy();
    expect(screen.getByText(/Administration › Settings › Enrolment approvals/)).toBeTruthy();
  });

  it('empty state', async () => {
    empty = true;
    render(<SaleClosure />);
    expect(await screen.findByText(/No enrolments yet/)).toBeTruthy();
  });
});

describe('EnrolmentModal', () => {
  it('DERIVES the net fee — it is never typed', async () => {
    render(<EnrolmentModal onClose={() => undefined} />);
    fireEvent.change(await screen.findByLabelText(/Total fee/), { target: { value: '45000' } });
    fireEvent.change(screen.getByLabelText(/^Discount/), { target: { value: '5000' } });
    const net = screen.getByLabelText('Net fee') as HTMLInputElement;
    expect(net.value).toBe('₹40,000.00');
    expect(net.disabled).toBe(true);
  });

  it('a course fills its fee from the Course master, and stays editable', async () => {
    render(<EnrolmentModal onClose={() => undefined} />);
    fireEvent.change(await screen.findByLabelText('Course'), { target: { value: '21' } });
    await waitFor(() => expect((screen.getByLabelText(/Total fee/) as HTMLInputElement).value).toBe('45000'));
    fireEvent.change(screen.getByLabelText(/Total fee/), { target: { value: '42000' } });
    expect((screen.getByLabelText(/Total fee/) as HTMLInputElement).value).toBe('42000');
  });

  it('a negative net is floored at zero rather than shown as -₹5,000', async () => {
    render(<EnrolmentModal onClose={() => undefined} />);
    fireEvent.change(await screen.findByLabelText(/Total fee/), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText(/^Discount/), { target: { value: '5000' } });
    expect((screen.getByLabelText('Net fee') as HTMLInputElement).value).toBe('₹0.00');
  });

  it('a converted enrolment says that tax is NOT carried across', async () => {
    render(<EnrolmentModal prefill={{ quote_no: 'QT-2026/0001', quotation_id: 1, lead_id: 31, fee_minor: 4_500_000, discount_minor: 450_000 }} onClose={() => undefined} />);
    expect(await screen.findByText(/Tax is not carried across/)).toBeTruthy();
    expect((screen.getByLabelText(/Total fee/) as HTMLInputElement).value).toBe('45000');
  });
});

describe('Fee Collection — LITE, and it says so', () => {
  it('renders the receipts, the modes and the outstanding total', async () => {
    render(<FeeCollection />);
    expect(await screen.findByText('RCP-2026/0001')).toBeTruthy();
    expect(screen.getByText('UTR9876543210')).toBeTruthy();
    expect(screen.getByText('UPI')).toBeTruthy();
    expect(screen.getByText('Collection by mode')).toBeTruthy();
  });

  it('states the Phase-3 boundary on the face of the screen', async () => {
    render(<FeeCollection />);
    expect(await screen.findByText(/lite fee collection/)).toBeTruthy();
    expect(screen.getByText(/Razorpay capture are Phase 3/)).toBeTruthy();
  });

  it('hides Record payment from a user without fee.collect', async () => {
    can.mockImplementation((k: string) => k !== 'fee.collect');
    render(<FeeCollection />);
    await screen.findByText('RCP-2026/0001');
    expect(screen.queryByText('Record payment')).toBeNull();
  });
});

describe('CollectModal', () => {
  it('shows the outstanding balance of the chosen enrolment, and warns about over-collection', async () => {
    render(<CollectModal onClose={() => undefined} />);
    fireEvent.change(await screen.findByLabelText(/Enrolment/), { target: { value: '61' } });
    expect(await screen.findByText(/More than the outstanding balance is refused/)).toBeTruthy();
  });

  it('demands a reference for UPI / cheque / online — and not for cash', async () => {
    render(<CollectModal onClose={() => undefined} />);
    const mode = await screen.findByLabelText(/Mode/);
    fireEvent.change(mode, { target: { value: 'upi' } });
    expect(await screen.findByText(/Required for upi/)).toBeTruthy();
    fireEvent.change(mode, { target: { value: 'cash' } });
    await waitFor(() => expect(screen.queryByText(/Required for cash/)).toBeNull());
  });

  it('surfaces the API\'s refusal verbatim — over-collection must reach the clerk', async () => {
    post.mockRejectedValueOnce(new Error('That is more than the outstanding balance. Net fee ₹40,500.00, already paid ₹20,000.00, outstanding ₹20,500.00.'));
    render(<CollectModal onClose={() => undefined} />);
    fireEvent.change(await screen.findByLabelText(/Enrolment/), { target: { value: '61' } });
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '99999' } });
    fireEvent.click(screen.getByText('Record payment'));
    expect(await screen.findByText(/more than the outstanding balance/)).toBeTruthy();
  });
});

describe('Monthly Targets', () => {
  it('renders progress bars and the counsellor table', async () => {
    render(<MonthlyTargets />);
    expect(await screen.findByText(/Vikaspuri — 30\/40 admissions/)).toBeTruthy();
    expect(screen.getByText('Asha Rao')).toBeTruthy();
    expect(screen.getByText('₹5,00,000.00')).toBeTruthy();      // the revenue target, Indian-grouped
    expect(screen.getByText('50%')).toBeTruthy();
  });

  it('empty state points at the thing that fixes it', async () => {
    empty = true;
    render(<MonthlyTargets />);
    expect(await screen.findByText(/Branch targets appear once monthly targets are set/)).toBeTruthy();
  });

  it('hides "Set a target" from a user without target.manage', async () => {
    can.mockImplementation((k: string) => k !== 'target.manage');
    render(<MonthlyTargets />);
    await screen.findByText('Asha Rao');
    expect(screen.queryByText('Set a target')).toBeNull();
  });
});

describe('Counsellor Performance', () => {
  it('renders the leaderboard with every column the prototype promises', async () => {
    render(<CounsellorPerformance />);
    expect(await screen.findByText('Asha Rao')).toBeTruthy();
    expect(screen.getAllByText('25%').length).toBeGreaterThan(0);   // conversion (row + KPI)
    expect(screen.getByText('30m')).toBeTruthy();               // TAT, humanised
    expect(screen.getByText('80%')).toBeTruthy();               // adherence
    // revenue booked appears in the row AND the KPI strip; collected only in the row.
    // The assertion that matters is that they are DIFFERENT numbers, both rendered.
    expect(screen.getAllByText('₹2,25,000.00').length).toBeGreaterThan(0);   // revenue booked
    expect(screen.getByText('₹50,000.00')).toBeTruthy();                     // collected
  });

  it('explains that "Activity" is not a call count — telephony is out of scope', async () => {
    render(<CounsellorPerformance />);
    expect(await screen.findByText(/telephony is out of scope/)).toBeTruthy();
    expect(screen.getByText(/is not a call count/)).toBeTruthy();
  });

  it('separates BOOKED revenue from COLLECTED cash in words, not just columns', async () => {
    render(<CounsellorPerformance />);
    expect(await screen.findByText(/They are different numbers and are shown separately on purpose/)).toBeTruthy();
  });

  it('empty leaderboard', async () => {
    empty = true;
    render(<CounsellorPerformance />);
    expect(await screen.findByText(/Leaderboard fills as leads & closures accumulate/)).toBeTruthy();
  });
});

/**
 * OBS-S16-05 — THE CLIENT MUST NOT SEE TWO NUMBERS CALLED THE SAME THING.
 *
 * QA-16, live, at one moment: the funnel report said 50% and Counsellor Performance said
 * 100%, both captioned "Conversion". Both were correct — they answer different questions
 * — so the fix is not to make them agree, it is to stop calling them the same thing.
 * A shared server-side definition with two different captions on it is still two
 * different numbers as far as Gopal is concerned.
 *
 * The label is pinned HERE, next to the screen that renders it: deleting the distinction
 * fails a test, exactly as deleting the MSG91 caveat now does.
 */
describe('OBS-S16-05 — conversion is NAMED, not just "Conversion"', () => {
  it('Counsellor Performance says COUNSELLOR conversion, and names its denominator', async () => {
    render(<CounsellorPerformance />);
    expect(await screen.findByText(CONVERSION_LABEL_COUNSELLOR)).toBeTruthy();
    expect(CONVERSION_LABEL_COUNSELLOR).toMatch(/own leads/i);
    // and it is NOT the funnel's caption
    expect(screen.queryByText(CONVERSION_LABEL_LEAD_WON)).toBeNull();
  });

  it('the two labels are different — the whole point', () => {
    expect(CONVERSION_LABEL_COUNSELLOR).not.toBe(CONVERSION_LABEL_LEAD_WON);
  });
});
