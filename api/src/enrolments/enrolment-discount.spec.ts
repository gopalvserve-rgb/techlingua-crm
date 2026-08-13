import { BadRequestException } from '@nestjs/common';
import { EnrolmentService } from './enrolment.service';

/** ITEM 4 — enrolment discount by amount AND percentage, with a computed net that drives
 *  the plan, and the finance discount cap enforced (over-cap => 400). */
describe('enrolment discount (item 4)', () => {
  const svc = new EnrolmentService(null as never, null as never, null as never, null as never);

  it('percent: 10% off ₹20,000 => discount ₹2,000, net ₹18,000', () => {
    const m = svc.normaliseMoney({ fee_minor: 2000000, discount_type: 'percent', discount_value: 10 });
    expect(m.discount_amount_minor).toBe(200000);
    expect(m.net_fee_minor).toBe(1800000);
    expect(m.discount_type).toBe('percent');
    expect(m.discount_value).toBe(10);
    expect(m.gross_fee_minor).toBe(2000000);
  });

  it('amount: ₹2,000 off ₹20,000 => the SAME net ₹18,000', () => {
    const m = svc.normaliseMoney({ fee_minor: 2000000, discount_type: 'amount', discount_value: 200000 });
    expect(m.discount_amount_minor).toBe(200000);
    expect(m.net_fee_minor).toBe(1800000);
    expect(m.discount_type).toBe('amount');
  });

  it('the NET drives the plan: net === gross − discount', () => {
    const m = svc.normaliseMoney({ fee_minor: 2000000, discount_type: 'percent', discount_value: 10 });
    expect(m.net_fee_minor).toBe(m.gross_fee_minor - m.discount_amount_minor);
  });

  it('a legacy discount_minor (no type) is read as an amount', () => {
    const m = svc.normaliseMoney({ fee_minor: 2000000, discount_minor: 200000 });
    expect(m.discount_amount_minor).toBe(200000);
    expect(m.discount_type).toBe('amount');
  });

  it('a percentage over 100 is a 400', () => {
    expect(() => svc.normaliseMoney({ fee_minor: 1000, discount_type: 'percent', discount_value: 150 })).toThrow(BadRequestException);
  });

  it('create() enforces the finance discount CAP — over cap => 400', async () => {
    const lead = { id: 1, org_id: 1, full_name: 'X', branch_id: 9, vertical_id: 9, pipeline_id: null, campaign_id: null, team_id: null, owner_id: 1, stage_id: null };
    const db = { one: async () => lead };
    const resolver = { buildScopeWhere: () => '1=1' };
    const finance = { assertAllowed: async () => { throw new BadRequestException('Enrolment discount: exceeds the allowed limit of 10%'); } };
    const svc2 = new EnrolmentService(db as never, resolver as never, {} as never, {} as never, finance as never);
    await expect(svc2.create(
      { lead_id: 1, fee_minor: 2000000, discount_type: 'amount', discount_value: 1000000, payment_plan: 'full' },
      { id: 1 }, {} as never,
    )).rejects.toThrow(/limit|cap/i);
  });
});
