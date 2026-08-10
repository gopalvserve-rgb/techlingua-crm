import { createHmac } from 'crypto';
import { PaymentService } from './payment.service';
import { NotConfiguredException } from '../common/not-configured.exception';

/**
 * RAZORPAY ONLINE COLLECTION — the whole contract, WITHOUT touching the real gateway.
 * The HTTP fn and FeeService are doubles; the webhook is exercised with a genuinely
 * HMAC-signed payload built with a test secret, so signature verification is real.
 */

const CONFIGURED = {
  id: 1, channel: 'payment', provider: 'razorpay', vertical_id: 5,
  config: { key_id: 'rzp_test_abcd', currency: 'INR' },
  secrets: { key_secret: 'test_secret', webhook_secret: 'whsec_123' },
};

/** Build a service with a scripted db + stub collaborators. `paidFlag` toggles idempotency. */
function build(opts: {
  enrolment?: Record<string, unknown> | null;
  config?: any;
  paymentRow?: Record<string, unknown> | null;
} = {}) {
  const state = { paid: false };
  const collectCalls: any[] = [];
  const notifyCalls: any[] = [];

  const enrolment = opts.enrolment === undefined
    ? { id: 9, enrolment_no: 'ENR-1', net_fee_minor: 4_500_000, branch_id: 2, vertical_id: 5, lead_id: 31,
        status: 'active', student_name: 'A', student_phone: '9', student_email: 'a@b.c', paid_minor: 0 }
    : opts.enrolment;

  const db = {
    one: async (sql: string) => {
      if (/FROM organisation/.test(sql)) return { id: 1 };
      if (/FROM enrolment e JOIN lead/.test(sql)) return enrolment;
      if (/INSERT INTO payment/.test(sql)) return { id: 77 };
      if (/FROM payment WHERE deleted_at IS NULL/.test(sql)) return opts.paymentRow ?? null;
      if (/counsellor_id, enrolment_no FROM enrolment/.test(sql)) return { counsellor_id: 3, enrolment_no: 'ENR-1' };
      return null;
    },
    query: async (sql: string, _p?: unknown[]) => {
      if (/UPDATE payment SET status='paid'/.test(sql)) {
        if (state.paid) return [];                 // replay — nothing to claim
        state.paid = true;
        return [{ id: 77, enrolment_id: 9, installment_id: null, created_by: 3 }];
      }
      if (/UPDATE payment SET status='failed', failed_reason=\$2, gateway_payment_id/.test(sql)) {
        if (state.paid) return [];
        state.paid = true;
        return [{ id: 77 }];
      }
      return [];
    },
  };
  const resolver = { buildScopeWhere: () => '1=1' };
  const configs = { resolve: async () => (opts.config === undefined ? CONFIGURED : opts.config) };
  const fees = {
    collect: async (dto: any) => { collectCalls.push(dto); return { id: 501, receipt_no: 'RCP-1', lead_id: 31, paid_minor: dto.amount_minor, balance_minor: 0, fully_paid: false }; },
    pdf: async () => ({ buffer: Buffer.from('%PDF'), filename: 'RCP-1.pdf' }),
  };
  const notifier = { notify: async (m: any) => { notifyCalls.push(m); } };

  const svc = new PaymentService(db as never, resolver as never, configs as never, fees as never, notifier as never);
  return { svc, collectCalls, notifyCalls, state };
}

const SCOPE = { permissionKey: 'payment.create', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [] } as never;

function signedWebhook(event: string, entity: Record<string, unknown>, secret = 'whsec_123', linkEntity?: Record<string, unknown>) {
  const payload: any = { event, payload: {} };
  if (/^payment\./.test(event)) payload.payload.payment = { entity };
  if (linkEntity) payload.payload.payment_link = { entity: linkEntity };
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = createHmac('sha256', secret).update(raw).digest('hex');
  return { raw, signature };
}

describe('createLink — per-vertical Razorpay key + clean degradation', () => {
  it('mints a payment link using the vertical key (amount in PAISE) when configured', async () => {
    const { svc } = build();
    const httpCalls: any[] = [];
    svc.http = async (url, init) => { httpCalls.push({ url, init }); return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'plink_1', short_url: 'https://rzp.io/i/abc', order_id: null }) }; };
    const out = await svc.createLink({ enrolment_id: 9, amount: '5000' }, { id: 3 }, SCOPE);
    expect(out.short_url).toBe('https://rzp.io/i/abc');
    expect(out.amount_minor).toBe(500_000);          // ₹5,000 -> paise
    expect(httpCalls[0].url).toContain('api.razorpay.com/v1/payment_links');
    expect(JSON.parse(httpCalls[0].init.body).amount).toBe(500_000);
  });

  it('returns a clean 503 (NotConfigured) when the vertical has no Razorpay key — never a 500', async () => {
    const { svc } = build({ config: null });
    let hit = false;
    svc.http = async () => { hit = true; return { ok: true, status: 200, text: async () => '{}' }; };
    await expect(svc.createLink({ enrolment_id: 9, amount: '5000' }, { id: 3 }, SCOPE))
      .rejects.toBeInstanceOf(NotConfiguredException);
    expect(hit).toBe(false);                          // the gateway is never called
  });

  it('refuses more than the outstanding balance (partial allowed, over-collection not)', async () => {
    const { svc } = build();
    svc.http = async () => ({ ok: true, status: 200, text: async () => '{}' });
    await expect(svc.createLink({ enrolment_id: 9, amount: '50000' }, { id: 3 }, SCOPE))
      .rejects.toThrow(/more than the outstanding/);
  });
});

describe('webhook — HMAC verified, collect + auto-receipt, idempotent', () => {
  const ROW = { id: 77, vertical_id: 5, enrolment_id: 9, amount_minor: 100_000, created_by: 3, installment_id: null, lead_id: 31, gateway_order_id: null };

  it('payment.captured -> payment paid + fee collection recorded + receipt', async () => {
    const { svc, collectCalls } = build({ paymentRow: ROW });
    const { raw, signature } = signedWebhook('payment.captured', { id: 'pay_x', order_id: 'order_1', amount: 100_000, notes: { payment_id: '77' } });
    const out = await svc.handleWebhook(raw, signature);
    expect(out.http).toBe(200);
    expect(out.body.paid).toBe(true);
    expect(out.body.fee_receipt_id).toBe(501);
    expect(collectCalls).toHaveLength(1);
    expect(collectCalls[0].mode).toBe('online');
    expect(collectCalls[0].amount_minor).toBe(100_000);   // partial passes straight through
    expect(collectCalls[0].gateway_payment_id).toBe('pay_x');
  });

  it('a REPLAY of the same captured webhook does not double-collect', async () => {
    const { svc, collectCalls } = build({ paymentRow: ROW });
    const { raw, signature } = signedWebhook('payment.captured', { id: 'pay_x', order_id: 'order_1', amount: 100_000, notes: { payment_id: '77' } });
    await svc.handleWebhook(raw, signature);
    const again = await svc.handleWebhook(raw, signature);
    expect(again.body.idempotent).toBe(true);
    expect(collectCalls).toHaveLength(1);                  // still once
  });

  it('a BAD signature is rejected (401) and nothing is collected', async () => {
    const { svc, collectCalls } = build({ paymentRow: ROW });
    const { raw } = signedWebhook('payment.captured', { id: 'pay_x', order_id: 'order_1', amount: 100_000, notes: { payment_id: '77' } });
    const out = await svc.handleWebhook(raw, 'deadbeef');
    expect(out.http).toBe(401);
    expect(collectCalls).toHaveLength(0);
  });

  it('payment.failed -> a failed record, no collection', async () => {
    const { svc, collectCalls } = build({ paymentRow: ROW });
    const { raw, signature } = signedWebhook('payment.failed', { id: 'pay_y', amount: 100_000, error_description: 'card declined', notes: { payment_id: '77' } });
    const out = await svc.handleWebhook(raw, signature);
    expect(out.http).toBe(200);
    expect(out.body.failed).toBe(true);
    expect(collectCalls).toHaveLength(0);
  });

  it('an unknown payment is ignored (200), never processed', async () => {
    const { svc } = build({ paymentRow: null });
    const { raw, signature } = signedWebhook('payment.captured', { id: 'pay_z', amount: 1, notes: { payment_id: '999' } });
    const out = await svc.handleWebhook(raw, signature);
    expect(out.http).toBe(200);
    expect(out.body.ignored).toBe('unknown payment');
  });
});
