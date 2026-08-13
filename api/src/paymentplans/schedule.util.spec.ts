import { generateSchedule, splitEvenly, addMonths, addDays } from './schedule.util';

/**
 * THE ONE RULE: installments SUM EXACTLY TO THE TOTAL — including the awkward-rounding
 * cases the client will find (₹1,00,000 / 3, odd paise), a down payment, and every
 * frequency. No floats, no leaked paisa.
 */
describe('splitEvenly — exact integer split', () => {
  it('splits evenly when it divides', () => {
    expect(splitEvenly(30000, 3)).toEqual([10000, 10000, 10000]);
  });
  it('puts the extra paise on the EARLIER installments and still sums exactly', () => {
    const parts = splitEvenly(100000, 3);   // ₹1,000.00 / 3
    expect(parts).toEqual([33334, 33333, 33333]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100000);
  });
  it('handles 1 installment and 0 amount', () => {
    expect(splitEvenly(4500000, 1)).toEqual([4500000]);
    expect(splitEvenly(0, 4)).toEqual([0, 0, 0, 0]);
  });
  it('never leaks a paisa across many awkward divisions', () => {
    for (const total of [1, 7, 99991, 4500001, 123457, 1000000]) {
      for (const n of [1, 2, 3, 4, 5, 6, 7, 11, 12, 24]) {
        const parts = splitEvenly(total, n);
        expect(parts.length).toBe(n);
        expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
        expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('date arithmetic', () => {
  it('adds calendar months, clamping to the last day', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-01-15', 2)).toBe('2026-03-15');
    expect(addMonths('2026-12-10', 1)).toBe('2027-01-10');
  });
  it('adds days across a month boundary', () => {
    expect(addDays('2026-08-30', 7)).toBe('2026-09-06');
  });
});

describe('generateSchedule — sums to the total, always', () => {
  it('FULL = one installment equal to the total', () => {
    const s = generateSchedule({ plan_type: 'full', total_minor: 4500000, num_installments: 1, frequency: 'once', start_date: '2026-09-01' });
    expect(s).toHaveLength(1);
    expect(s[0].amount_minor).toBe(4500000);
    expect(s[0].due_date).toBe('2026-09-01');
  });

  it('3 monthly EMIs sum to the total, dated month by month', () => {
    const s = generateSchedule({ plan_type: 'emi', total_minor: 100000, num_installments: 3, frequency: 'monthly', start_date: '2026-09-01' });
    expect(s.map((r) => r.amount_minor)).toEqual([33334, 33333, 33333]);
    expect(s.reduce((a, r) => a + r.amount_minor, 0)).toBe(100000);
    expect(s.map((r) => r.due_date)).toEqual(['2026-09-01', '2026-10-01', '2026-11-01']);
  });

  it('down payment becomes installment #1; the rest split across N and STILL sum to total', () => {
    const s = generateSchedule({ plan_type: 'installment', total_minor: 4500000, down_payment_minor: 1500000, num_installments: 3, frequency: 'monthly', start_date: '2026-09-01' });
    expect(s).toHaveLength(4);
    expect(s[0].amount_minor).toBe(1500000);       // down payment
    expect(s[0].due_date).toBe('2026-09-01');
    expect(s[1].due_date).toBe('2026-10-01');       // first EMI is a month after the down payment
    expect(s.reduce((a, r) => a + r.amount_minor, 0)).toBe(4500000);
  });

  it('weekly frequency spaces due dates by 7 days', () => {
    const s = generateSchedule({ plan_type: 'installment', total_minor: 30000, num_installments: 3, frequency: 'weekly', start_date: '2026-09-01' });
    expect(s.map((r) => r.due_date)).toEqual(['2026-09-01', '2026-09-08', '2026-09-15']);
  });

  it('custom dates are honoured', () => {
    const s = generateSchedule({ plan_type: 'custom', total_minor: 60000, num_installments: 2, frequency: 'custom', start_date: '2026-09-01', custom_dates: ['2026-09-10', '2026-12-25'] });
    expect(s.map((r) => r.due_date)).toEqual(['2026-09-10', '2026-12-25']);
    expect(s.reduce((a, r) => a + r.amount_minor, 0)).toBe(60000);
  });

  it('rejects a down payment larger than the total', () => {
    expect(() => generateSchedule({ plan_type: 'installment', total_minor: 1000, down_payment_minor: 2000, num_installments: 2, frequency: 'monthly', start_date: '2026-09-01' })).toThrow(/down payment/i);
  });

  it('CUSTOM amounts (down payment + user-defined installments) sum to the net', () => {
    // ₹18,000 net, ₹6,000 down, then custom 5000 + 4000 + 3000 = 12000 (== 18000-6000).
    const rows = generateSchedule({
      plan_type: 'custom', total_minor: 1800000, down_payment_minor: 600000,
      num_installments: 3, frequency: 'custom', start_date: '2026-09-01',
      custom_dates: ['2026-10-01', '2026-11-01', '2026-12-01'],
      custom_amounts: [500000, 400000, 300000],
    });
    expect(rows[0].label).toBe('Down payment');
    expect(rows[0].amount_minor).toBe(600000);
    expect(rows.slice(1).map((r) => r.amount_minor)).toEqual([500000, 400000, 300000]);
    expect(rows.reduce((a, r) => a + r.amount_minor, 0)).toBe(1800000);
  });

  it('CUSTOM amounts that do NOT sum to the payable are rejected', () => {
    expect(() => generateSchedule({
      plan_type: 'custom', total_minor: 1800000, down_payment_minor: 600000,
      num_installments: 2, frequency: 'custom', start_date: '2026-09-01',
      custom_amounts: [500000, 400000],   // 900000 != 1200000
    })).toThrow(/must sum to the payable/i);
  });
});
