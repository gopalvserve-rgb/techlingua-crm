import {
  computeRoyalty, resolveRoyaltySlab, pctOfMinor, monthsInPeriod, RoyaltyPlanCompute, RoyaltySlab,
} from './royalty.util';
import { FranchiseService } from './franchise.service';
import { DatabaseService } from '../database/database.service';

/* =============================== pctOfMinor =============================== */
describe('pctOfMinor — half-up % of a paise amount', () => {
  it('computes whole percents exactly', () => {
    expect(pctOfMinor(1000000, 10)).toBe(100000);   // 10% of ₹10,000 = ₹1,000
    expect(pctOfMinor(1000000, 12.5)).toBe(125000);  // 12.5% = ₹1,250
  });
  it('is 0 for a 0 base, 0 percent or negative percent', () => {
    expect(pctOfMinor(0, 10)).toBe(0);
    expect(pctOfMinor(1000000, 0)).toBe(0);
    expect(pctOfMinor(1000000, -5)).toBe(0);
  });
  it('rounds half-up to the paise', () => {
    // 33.3333% of 1 rupee (100 paise) = 33.3333 -> 33
    expect(pctOfMinor(100, 33.3333)).toBe(33);
    // 0.5 paise rounds up
    expect(pctOfMinor(1000, 0.05)).toBe(1); // 0.05% of 1000 = 0.5 -> 1
  });
});

/* =========================== resolveRoyaltySlab =========================== */
const SLABS: RoyaltySlab[] = [
  { min_amount_minor: 0, max_amount_minor: 999999, percent: 5, label: 'Tier 1' },
  { min_amount_minor: 1000000, max_amount_minor: 4999999, percent: 8, label: 'Tier 2' },
  { min_amount_minor: 5000000, max_amount_minor: null, percent: 12, label: 'Tier 3' },
];
describe('resolveRoyaltySlab — greatest min_amount <= base', () => {
  it('lands each base in the right band', () => {
    expect(resolveRoyaltySlab(SLABS, 500000)?.label).toBe('Tier 1');
    expect(resolveRoyaltySlab(SLABS, 2000000)?.label).toBe('Tier 2');
    expect(resolveRoyaltySlab(SLABS, 9000000)?.label).toBe('Tier 3');
  });
  it('resolves exact band boundaries to the band that STARTS there', () => {
    expect(resolveRoyaltySlab(SLABS, 1000000)?.label).toBe('Tier 2');
    expect(resolveRoyaltySlab(SLABS, 5000000)?.label).toBe('Tier 3');
  });
  it('is open-ended at the top and order-independent', () => {
    expect(resolveRoyaltySlab(SLABS, 999999999)?.label).toBe('Tier 3');
    expect(resolveRoyaltySlab([...SLABS].reverse(), 2000000)?.label).toBe('Tier 2');
  });
  it('returns null below the lowest min_amount', () => {
    const gapped: RoyaltySlab[] = [{ min_amount_minor: 1000000, max_amount_minor: null, percent: 5 }];
    expect(resolveRoyaltySlab(gapped, 500000)).toBeNull();
  });
});

/* ============================== monthsInPeriod ============================ */
describe('monthsInPeriod', () => {
  it('counts inclusive calendar months, defaults to 1', () => {
    expect(monthsInPeriod('2026-08-01', '2026-08-31')).toBe(1);
    expect(monthsInPeriod('2026-07-01', '2026-09-30')).toBe(3);   // a quarter
    expect(monthsInPeriod(null, null)).toBe(1);
    expect(monthsInPeriod('2026-01-01', '2026-12-31')).toBe(12);
  });
});

/* =============================== computeRoyalty ========================== */
const base = (o: Partial<RoyaltyPlanCompute>): RoyaltyPlanCompute => ({
  model: 'percent_collected', percent: 0, fixed_amount_minor: 0, min_guarantee_minor: 0,
  tier_basis: 'collected', slabs: [], ...o,
});
const REV = { gross_collected_minor: 10000000, refunds_minor: 2000000 }; // ₹1,00,000 collected, ₹20,000 refunded

describe('computeRoyalty — the four models', () => {
  it('percent_collected applies the % to GROSS collected', () => {
    const r = computeRoyalty(base({ model: 'percent_collected', percent: 10 }), REV, 1);
    expect(r.base_minor).toBe(10000000);
    expect(r.royalty_minor).toBe(1000000); // 10% of ₹1,00,000 = ₹10,000
    expect(r.rate_pct).toBe(10);
  });
  it('percent_net applies the % to NET collected (gross - refunds)', () => {
    const r = computeRoyalty(base({ model: 'percent_net', percent: 10 }), REV, 1);
    expect(r.base_minor).toBe(8000000);   // ₹80,000 net
    expect(r.royalty_minor).toBe(800000); // 10% = ₹8,000
  });
  it('fixed pays the monthly fee times the number of months', () => {
    const r = computeRoyalty(base({ model: 'fixed', fixed_amount_minor: 500000 }), REV, 3);
    expect(r.royalty_minor).toBe(1500000); // ₹5,000 x 3 = ₹15,000
    expect(r.rate_pct).toBeNull();
  });
  it('tiered on GROSS picks the band and applies its %', () => {
    const r = computeRoyalty(base({ model: 'tiered', tier_basis: 'collected', slabs: SLABS }), REV, 1);
    // gross ₹1,00,000 = 10000000 paise -> Tier 3 (>=5000000) @ 12%
    expect(r.slab?.label).toBe('Tier 3');
    expect(r.royalty_minor).toBe(1200000); // 12% of ₹1,00,000 = ₹12,000
  });
  it('tiered on NET reads the net base for the band', () => {
    const r = computeRoyalty(base({ model: 'tiered', tier_basis: 'net', slabs: SLABS }), REV, 1);
    // net ₹80,000 = 8000000 -> Tier 3 @ 12% -> ₹9,600
    expect(r.base_minor).toBe(8000000);
    expect(r.royalty_minor).toBe(960000);
  });
  it('tiered at an exact band boundary resolves to the band starting there', () => {
    const rev = { gross_collected_minor: 1000000, refunds_minor: 0 }; // exactly ₹10,000 = Tier 2 start
    const r = computeRoyalty(base({ model: 'tiered', slabs: SLABS }), rev, 1);
    expect(r.slab?.label).toBe('Tier 2');
    expect(r.royalty_minor).toBe(80000); // 8% of ₹10,000 = ₹800
  });
  it('applies the monthly minimum guarantee as a floor (x months)', () => {
    const r = computeRoyalty(base({ model: 'percent_collected', percent: 1, min_guarantee_minor: 300000 }), REV, 2);
    // 1% of ₹1,00,000 = ₹1,000 (100000) < floor ₹3,000 x 2 = ₹6,000 (600000)
    expect(r.gross_royalty_minor).toBe(100000);
    expect(r.floor_applied).toBe(true);
    expect(r.royalty_minor).toBe(600000);
  });
  it('does not apply the floor when the earned royalty already exceeds it', () => {
    const r = computeRoyalty(base({ model: 'percent_collected', percent: 10, min_guarantee_minor: 100000 }), REV, 1);
    expect(r.floor_applied).toBe(false);
    expect(r.royalty_minor).toBe(1000000);
  });
});

/* ================= franchise scope resolver + dashboard (fake db) ========= */
function fakeDb(handlers: { query?: (sql: string, p: any[]) => any[]; one?: (sql: string, p: any[]) => any }): DatabaseService {
  return {
    query: async (sql: string, p: any[] = []) => (handlers.query ? handlers.query(sql, p) : []),
    one: async (sql: string, p: any[] = []) => (handlers.one ? handlers.one(sql, p) : null),
    tx: async (fn: any) => fn({ query: async () => ({ rowCount: 1, rows: [{ id: '1' }] }) }),
  } as unknown as DatabaseService;
}

describe('FranchiseService.branchIds — franchise -> branch_ids', () => {
  it('maps the join rows to a numeric branch_id array', async () => {
    const svc = new FranchiseService(fakeDb({
      query: (sql) => (/franchise_branch/.test(sql) ? [{ branch_id: '3' }, { branch_id: '7' }] : []),
    }));
    expect(await svc.branchIds(1)).toEqual([3, 7]);
  });
});

describe('FranchiseService.dashboard — rollup aggregation', () => {
  it('assembles KPIs from the scoped revenue + enrolment aggregates and computes royalty', async () => {
    const db = fakeDb({
      query: (sql) => {
        if (/FROM franchise_branch WHERE franchise_id/.test(sql)) return [{ branch_id: '5' }];
        if (/FROM royalty_slab/.test(sql)) return [];
        return [];
      },
      one: (sql) => {
        // Order matters: the enrolment aggregate embeds a fee_receipt lateral join, so match
        // it FIRST by a distinctive token before the plain collected-revenue query.
        if (/count\(DISTINCT e\.lead_id\)/.test(sql)) return { enrolments: '6', students: '5', booked: '15000000', outstanding: '3000000' };
        if (/FROM franchise WHERE id/.test(sql)) return { id: '9', name: 'Pune HO', code: 'PUN', status: 'active' };
        if (/AS gross/.test(sql)) return { gross: '10000000', receipts: '4' };
        if (/AS refunds/.test(sql)) return { refunds: '2000000' };
        if (/FROM branch WHERE id/.test(sql)) return { n: '1' };
        if (/FROM royalty_plan p/.test(sql)) return { id: '2', name: '10% collected', model: 'percent_collected', percent: '10', fixed_amount_minor: '0', min_guarantee_minor: '0', tier_basis: 'collected' };
        return null;
      },
    });
    const svc = new FranchiseService(db);
    const d = await svc.dashboard(9, { from: '2026-08-01', to: '2026-08-31' });
    expect(d.branch_ids).toEqual([5]);
    expect(d.kpis.revenue_collected_minor).toBe(10000000);
    expect(d.kpis.net_revenue_minor).toBe(8000000);       // gross - refunds
    expect(d.kpis.students).toBe(5);
    expect(d.kpis.enrolments).toBe(6);
    expect(d.kpis.outstanding_minor).toBe(3000000);
    expect(d.kpis.royalty_payable_minor).toBe(1000000);   // 10% of gross ₹1,00,000 = ₹10,000
    expect(d.kpis.royalty_plan_name).toBe('10% collected');
  });
});
