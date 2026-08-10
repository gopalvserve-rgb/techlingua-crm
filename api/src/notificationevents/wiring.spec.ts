import { createHmac } from 'crypto';
import { NotificationEventService } from './notification-event.service';
import { FeeService } from '../fees/fee.service';
import { InvoiceService } from '../invoices/invoice.service';
import { PaymentService } from '../payments/payment.service';
import { RefundService } from '../refunds/refund.service';
import { AttendanceService } from '../academics/attendance.service';
import { TransferService } from '../academics/transfer.service';
import { CertificateService } from '../learning/certificate.service';

/**
 * TASK 108 — WIRING TESTS. Each business trigger site must fire its mapped Notification
 * Event with the right event key + subject + ₹/merge context, and NEVER let a notification
 * failure roll back the money/academic action (safeFire is fire-and-forget + swallows).
 *
 * The deep fire() behaviour (only enabled+mapped channels send, disabled does not, idempotent,
 * degrades when a channel is unconfigured, recipient resolution) is pinned in
 * notification-event.spec.ts. Here we prove the CALL happens at each newly-wired site.
 */

const SCOPE = { permissionKey: 'x', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [] } as never;
const resolver = { buildScopeWhere: () => '1=1' } as never;
const spyEvents = () => ({ safeFire: jest.fn(async (_k: string, _ctx: any) => {}) });

/* ------------------------------------------------------------------ Fees */
describe('FeeService.collect fires receipt_generated + payment_successful (+ fee_fully_paid)', () => {
  const ENR = { id: 1, enrolment_no: 'ENR-1', net_fee_minor: 4_500_000, branch_id: 9, vertical_id: 7, lead_id: 31, status: 'active', paid_minor: 0 };
  const feeSvc = (enr: any) => {
    const db = {
      one: async (sql: string) => (/FROM organisation/.test(sql) ? { id: 1 } : /FROM enrolment e/.test(sql) ? { id: 1, status: 'active', enrolment_no: 'ENR-1' } : null),
      query: async () => [],
      tx: async (fn: any) => fn({ query: async (sql: string) => (/FOR UPDATE/.test(sql) ? { rows: [enr] } : /RETURNING id/.test(sql) ? { rows: [{ id: 99 }] } : { rows: [] }) }),
    };
    const numbering = { allocate: async () => 'RCP-1' };
    const ev = spyEvents();
    return { svc: new FeeService(db as never, resolver, numbering as never, undefined, ev as never), ev };
  };

  it('a partial payment fires receipt + payment_successful with ₹ vars, not fee_fully_paid', async () => {
    const { svc, ev } = feeSvc({ ...ENR, paid_minor: 0 });
    await svc.collect({ enrolment_id: 1, amount: '10000', mode: 'cash' }, { id: 3 }, SCOPE);
    const keys = ev.safeFire.mock.calls.map((c: any[]) => c[0]);
    expect(keys).toEqual(expect.arrayContaining(['receipt_generated', 'payment_successful']));
    expect(keys).not.toContain('fee_fully_paid');
    const ctx: any = ev.safeFire.mock.calls[0][1];
    expect(ctx.lead_id).toBe(31);
    expect(ctx.vars.amount).toMatch(/₹/);
    expect(ctx.vars.receipt_no).toBe('RCP-1');
  });

  it('the balance-clearing payment ALSO fires fee_fully_paid', async () => {
    const { svc, ev } = feeSvc({ ...ENR, paid_minor: 4_000_000 });
    await svc.collect({ enrolment_id: 1, amount: '5000', mode: 'cash' }, { id: 3 }, SCOPE);
    expect(ev.safeFire.mock.calls.map((c: any[]) => c[0])).toContain('fee_fully_paid');
  });

  it('a notification failure never breaks the collection (fire-and-forget)', async () => {
    const { svc } = feeSvc({ ...ENR });
    // real fire path can throw internally; safeFire swallows — here the spy just resolves.
    const r = await svc.collect({ enrolment_id: 1, amount: '1000', mode: 'cash' }, { id: 3 }, SCOPE);
    expect(r.receipt_no).toBe('RCP-1');   // money path unaffected
  });
});

/* --------------------------------------------------------------- Invoices */
describe('InvoiceService.issue fires fee_invoice_generated', () => {
  it('fires with the fresh invoice number + ₹ amount + student subject', async () => {
    const gi = { id: 5, status: 'draft', seller_gstin: '07AAA', branch_id: 2, vertical_id: 7, student_id: 88, lead_id: 31, total_minor: 1_180_000, enrolment_no: 'ENR-1' };
    const db = {
      one: async (sql: string) => (/FROM gst_invoice gi/.test(sql) ? gi : null),
      query: async () => [],
      tx: async (fn: any) => fn({ query: async () => ({ rows: [] }) }),
    };
    const numbering = { allocate: async () => 'INV/26-27/0001' };
    const ev = spyEvents();
    const svc = new InvoiceService(db as never, resolver, numbering as never, undefined, ev as never);
    await svc.issue(5, { id: 3 }, SCOPE);
    expect(ev.safeFire).toHaveBeenCalledWith('fee_invoice_generated', expect.objectContaining({
      student_id: 88, vertical_id: 7,
      vars: expect.objectContaining({ invoice_no: 'INV/26-27/0001', amount: expect.stringContaining('₹') }),
    }));
  });
});

/* --------------------------------------------------------------- Payments */
describe('PaymentService webhook fires payment_failed', () => {
  it('a payment.failed webhook fires payment_failed to the student', async () => {
    const paymentRow = { id: 77, vertical_id: 5, lead_id: 31, amount_minor: 250_000, gateway_order_id: null, gateway_link_id: null };
    const db = {
      one: async (sql: string) => (/FROM payment WHERE deleted_at IS NULL/.test(sql) ? paymentRow : /counsellor_id, enrolment_no FROM enrolment/.test(sql) ? { counsellor_id: 3, enrolment_no: 'ENR-1' } : null),
      query: async (sql: string) => (/UPDATE payment SET status='failed'/.test(sql) ? [{ id: 77 }] : []),
    };
    const configs = { resolve: async () => ({ secrets: { webhook_secret: 'whsec_123' } }) };
    const fees = {}; const notifier = { notify: async () => {} };
    const ev = spyEvents();
    const svc = new PaymentService(db as never, resolver, configs as never, fees as never, notifier as never, ev as never);
    const payload: any = { event: 'payment.failed', payload: { payment: { entity: { id: 'pay_1', notes: { payment_id: '77' }, error_description: 'card declined' } } } };
    const raw = Buffer.from(JSON.stringify(payload), 'utf8');
    const sig = createHmac('sha256', 'whsec_123').update(raw).digest('hex');
    await svc.handleWebhook(raw, sig);
    expect(ev.safeFire).toHaveBeenCalledWith('payment_failed', expect.objectContaining({
      lead_id: 31, vertical_id: 5, vars: expect.objectContaining({ amount: expect.stringContaining('₹') }),
    }));
  });
});

/* ---------------------------------------------------------------- Refunds */
describe('RefundService fires refund_initiated + refund_completed', () => {
  const numbering = { allocate: async () => 'REF/26-27/0003' } as never;
  const settings = { get: async (_k: string, d: any) => d, set: async () => undefined } as never;

  it('request() fires refund_initiated with the ₹ amount', async () => {
    const db = {
      one: async (sql: string) => (/FROM organisation/.test(sql) ? { id: 1 } : /sum\(x\.amount_minor\)/.test(sql) ? { collected: 1_000_000, approved: 0, pending: 0 } : /FROM enrolment e/.test(sql) ? { id: 5, enrolment_no: 'ENR-1', branch_id: 2, vertical_id: 7, lead_id: 9 } : null),
      query: async (sql: string) => (/INSERT INTO refund/.test(sql) ? [{ id: 77 }] : []),
    };
    const ev = spyEvents();
    const svc = new RefundService(db as never, resolver, settings, numbering, undefined, ev as never);
    await svc.request({ enrolment_id: 5, amount_minor: 400_000, mode: 'cash', reason: 'x' }, { id: 1 }, SCOPE);
    expect(ev.safeFire).toHaveBeenCalledWith('refund_initiated', expect.objectContaining({
      lead_id: 9, vertical_id: 7, vars: expect.objectContaining({ refund_amount: expect.stringContaining('₹') }),
    }));
  });

  it('decide(approve) fires refund_completed with the voucher number', async () => {
    const rf = { id: 77, status: 'pending', requested_by: 2, requires_high: false, amount_minor: 400_000, enrolment_id: 5, enrolment_no: 'ENR-1', branch_id: 2, vertical_id: 7, lead_id: 9, mode: 'cash' };
    const db = {
      one: async (sql: string) => (/FROM refund rf/.test(sql) ? rf : null),
      query: async () => [],
      tx: async (fn: any) => fn({ query: async (sql: string) => (/sum\(x\.amount_minor\)/.test(sql) ? { rows: [{ collected: 1_000_000, approved: 0 }] } : /RETURNING id/.test(sql) ? { rows: [{ id: 77 }] } : { rows: [] }) }),
    };
    const ev = spyEvents();
    const svc = new RefundService(db as never, resolver, settings, numbering, undefined, ev as never);
    await svc.decide(77, true, null, { id: 4 }, SCOPE, true);
    expect(ev.safeFire).toHaveBeenCalledWith('refund_completed', expect.objectContaining({
      lead_id: 9, vertical_id: 7, vars: expect.objectContaining({ refund_no: 'REF/26-27/0003' }),
    }));
  });
});

/* -------------------------------------------------------------- Academics */
describe('AttendanceService.mark fires student_absent per absent student', () => {
  it('fires student_absent with the batch + date, once per absent student', async () => {
    const db = {
      one: async (sql: string) => (/FROM organisation/.test(sql) ? { id: 1 } : /FROM batch bt/.test(sql) ? { id: 10, name: 'IELTS AM', branch_id: 2, vertical_id: 7 } : /FROM student/.test(sql) ? { id: 55, full_name: 'A', guardian_name: 'P' } : null),
      query: async () => [],
      tx: async (fn: any) => fn({ query: async (sql: string) => (/SELECT 1 FROM student/.test(sql) ? { rowCount: 1, rows: [{}] } : { rows: [] }) }),
    };
    const ev = spyEvents();
    const svc = new AttendanceService(db as never, resolver, undefined, ev as never);
    await svc.mark({ batch_id: 10, date: '2026-08-11', entries: [{ student_id: 55, status: 'absent' }] }, { id: 3 }, SCOPE);
    expect(ev.safeFire).toHaveBeenCalledWith('student_absent', expect.objectContaining({
      student_id: 55, vertical_id: 7, vars: expect.objectContaining({ batch_name: 'IELTS AM', date: '2026-08-11' }),
    }));
  });
});

describe('TransferService.transfer fires batch_assigned / batch_changed', () => {
  const build = (studentBatchId: number | null) => {
    const student = { id: 55, full_name: 'A', batch_id: studentBatchId, branch_id: 2, vertical_id: 7, course_id: 3 };
    const target = { id: 20, name: 'IELTS PM', batch_code: 'B2', capacity: 0, branch_id: 2, vertical_id: 7, course_id: 3, course_name: 'IELTS' };
    const db = {
      one: async (sql: string) => (/FROM organisation/.test(sql) ? { id: 1 } : /FROM batch bt/.test(sql) ? target : /FROM student s/.test(sql) ? student : /count\(\*\)::int AS n FROM student/.test(sql) ? { n: 0 } : /batch_waitlist/.test(sql) ? { n: 0 } : null),
      query: async () => [],
      tx: async (fn: any) => fn({ query: async () => ({ rows: [] }) }),
    };
    const ev = spyEvents();
    return { svc: new TransferService(db as never, resolver, ev as never), ev };
  };

  it('a first placement (no current batch) fires batch_assigned', async () => {
    const { svc, ev } = build(null);
    await svc.transfer({ student_id: 55, to_batch_id: 20 }, { id: 3 }, SCOPE);
    expect(ev.safeFire).toHaveBeenCalledWith('batch_assigned', expect.objectContaining({ student_id: 55, vertical_id: 7, vars: expect.objectContaining({ batch_name: 'IELTS PM' }) }));
  });

  it('a move (had a batch) fires batch_changed', async () => {
    const { svc, ev } = build(9);
    await svc.transfer({ student_id: 55, to_batch_id: 20 }, { id: 3 }, SCOPE);
    expect(ev.safeFire).toHaveBeenCalledWith('batch_changed', expect.objectContaining({ student_id: 55, vertical_id: 7 }));
  });
});

/* ----------------------------------------------------------- Certificates */
describe('CertificateService.issue fires certificate_generated + certificate_issued', () => {
  it('fires both events with the serial number', async () => {
    const student = { id: 55, full_name: 'A', student_no: 'S1', branch_id: 2, vertical_id: 7, course_id: 3, batch_id: 4 };
    const db = {
      one: async (sql: string) => (/FROM organisation/.test(sql) ? { id: 1 } : /FROM student s/.test(sql) ? student : null),
      query: async () => [],
      tx: async (fn: any) => fn({ query: async () => ({ rows: [{ id: 900 }] }) }),
    };
    const numbering = { allocate: async () => 'CERT/26-27/0011' };
    const ev = spyEvents();
    const svc = new CertificateService(db as never, resolver, numbering as never, ev as never);
    await svc.issue({ student_id: 55, title: 'Completion', cert_type: 'completion' }, { id: 3 }, SCOPE);
    const keys = ev.safeFire.mock.calls.map((c: any[]) => c[0]);
    expect(keys).toEqual(expect.arrayContaining(['certificate_generated', 'certificate_issued']));
    expect((ev.safeFire.mock.calls[0][1] as any).vars.certificate_no).toBe('CERT/26-27/0011');
  });
});

/* ------------------------------------- safeFire is a true no-throw sink */
describe('safeFire never throws into the business path even when fire() blows up', () => {
  it('swallows an internal error and resolves', async () => {
    const db = { one: async () => { throw new Error('db down'); }, query: async () => [] };
    const templates = { build: async () => ({}) };
    const messaging = { queue: async () => ({ id: 1, status: 'queued' }) };
    const svc = new NotificationEventService(db as never, templates as never, messaging as never);
    await expect(svc.safeFire('payment_successful', { lead_id: 1 })).resolves.toBeUndefined();
  });
});
