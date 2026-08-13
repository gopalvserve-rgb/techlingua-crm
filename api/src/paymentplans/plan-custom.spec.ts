import { BadRequestException } from '@nestjs/common';
import { PlanService } from './plan.service';

/** ITEM 4 — a CUSTOM plan's user-typed installment amounts must sum to the net (after any
 *  down payment). A schedule that does not add up is a 400, never a silently-wrong plan. */
function svcForEnrolment(net: number) {
  const db = {
    one: async (sql: string) => {
      if (/FROM enrolment/.test(sql)) {
        return { id: 1, org_id: 1, net_fee_minor: net, status: 'active', enrolment_no: 'ENR-2026/0009', start_date: '2026-09-01', paid_minor: 0 };
      }
      return { id: 1 };
    },
    query: async () => [],
    tx: async (fn: any) => fn({ query: async () => ({ rows: [{ id: 99 }] }) }),
  };
  const resolver = { buildScopeWhere: () => '1=1' };
  return new PlanService(db as never, resolver as never);
}

describe('payment plan — custom amounts (item 4)', () => {
  it('rejects custom amounts that do NOT sum to (net − down) => 400', async () => {
    const svc = svcForEnrolment(1800000);   // ₹18,000 net
    await expect(svc.create(
      { enrolment_id: 1, plan_type: 'custom', down_payment_minor: 600000, custom_amounts_minor: [500000, 400000] },  // 900000 != 1200000
      { id: 1 }, {} as never,
    )).rejects.toThrow(BadRequestException);
  });

  it('accepts custom amounts that DO sum to (net − down)', async () => {
    const svc = svcForEnrolment(1800000);
    const r = await svc.create(
      { enrolment_id: 1, plan_type: 'custom', down_payment_minor: 600000,
        custom_amounts_minor: [500000, 400000, 300000], custom_dates: ['2026-10-01', '2026-11-01', '2026-12-01'] },
      { id: 1 }, {} as never,
    );
    // down payment + 3 installments = 4 rows
    expect(r.installments).toBe(4);
  });
});
