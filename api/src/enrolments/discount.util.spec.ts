import { computeEnrolmentDiscount } from './discount.util';

describe('computeEnrolmentDiscount (item 4 — amount AND percent)', () => {
  it('a 10% discount on ₹20,000 => ₹2,000 off, net ₹18,000', () => {
    const r = computeEnrolmentDiscount(20000_00, 'percent', 10);
    expect(r.discount_amount_minor).toBe(2000_00);
    expect(r.net_fee_minor).toBe(18000_00);
    expect(r.discount_type).toBe('percent');
    expect(r.discount_value).toBe(10);
  });
  it('a ₹2,000 amount discount on ₹20,000 => the SAME net ₹18,000', () => {
    const r = computeEnrolmentDiscount(20000_00, 'amount', 2000_00);
    expect(r.discount_amount_minor).toBe(2000_00);
    expect(r.net_fee_minor).toBe(18000_00);
    expect(r.discount_type).toBe('amount');
  });
  it('none => zero discount, net == gross', () => {
    const r = computeEnrolmentDiscount(20000_00, 'none', 0);
    expect(r.discount_amount_minor).toBe(0);
    expect(r.net_fee_minor).toBe(20000_00);
  });
  it('a percent is half-up to the paisa', () => {
    // 12.5% of ₹333.33 = ₹41.66625 -> ₹41.67
    const r = computeEnrolmentDiscount(333_33, 'percent', 12.5);
    expect(r.discount_amount_minor).toBe(41_67);
  });
  it('a discount never exceeds the fee (amount clamped)', () => {
    const r = computeEnrolmentDiscount(1000_00, 'amount', 5000_00);
    expect(r.discount_amount_minor).toBe(1000_00);
    expect(r.net_fee_minor).toBe(0);
  });
  it('rejects a percentage above 100', () => {
    expect(() => computeEnrolmentDiscount(1000_00, 'percent', 120)).toThrow(/exceed 100/);
  });
});
