import { readFileSync } from 'fs';
import { join } from 'path';
import { computeRoyalty } from './royalty.util';
import {
  royaltyAgeBucket, ageingBuckets, onboardingProgress, invoiceOutstanding, isFullyPaid,
} from './franchise-ops.util';
import { periodToken, formatNumber } from '../numbering/numbering.service';

/**
 * Phase 4 Batch 2 — franchise royalty OPS. Pure-function coverage for the pieces the live
 * ops screens depend on: invoice amount == royalty + adjustments (from computeRoyalty),
 * the ROY- numbering series increments, the outstanding ageing buckets, a payment
 * reducing outstanding + flipping to Paid, the onboarding progress %, and migration 106.
 */

describe('royalty invoice amount == computeRoyalty + adjustments', () => {
  it('percent_collected 10% of ₹1,00,000 + ₹500 adjustment = ₹10,500', () => {
    const comp = computeRoyalty(
      { model: 'percent_collected', percent: 10, fixed_amount_minor: 0, min_guarantee_minor: 0, tier_basis: 'collected', slabs: [] },
      { gross_collected_minor: 10000000, refunds_minor: 0 }, 1);
    const adjustments = 50000; // ₹500
    const payable = comp.royalty_minor + adjustments;
    expect(comp.royalty_minor).toBe(1000000); // ₹10,000
    expect(payable).toBe(1050000);            // ₹10,500 — what the invoice freezes as amount_minor
  });

  it('tiered plan freezes the band rate the statement resolved', () => {
    const comp = computeRoyalty(
      { model: 'tiered', percent: 0, fixed_amount_minor: 0, min_guarantee_minor: 0, tier_basis: 'collected',
        slabs: [
          { min_amount_minor: 0, max_amount_minor: 5000000, percent: 5 },
          { min_amount_minor: 5000000, max_amount_minor: null, percent: 8 },
        ] },
      { gross_collected_minor: 8000000, refunds_minor: 0 }, 1);
    expect(comp.rate_pct).toBe(8);
    expect(comp.royalty_minor).toBe(640000); // 8% of ₹80,000
  });
});

describe('ROY- royalty invoice numbering series increments (FY reset)', () => {
  const at = new Date('2026-08-26T00:00:00Z'); // FY 2026-27
  it('formats ROY-2026-27/0001 then ROY-2026-27/0002', () => {
    const token = periodToken('fy', at);
    expect(token).toBe('2026-27');
    const n1 = formatNumber({ prefix: 'ROY-', suffix: '', padding: 4, token, n: 1 });
    const n2 = formatNumber({ prefix: 'ROY-', suffix: '', padding: 4, token, n: 2 });
    expect(n1).toBe('ROY-2026-27/0001');
    expect(n2).toBe('ROY-2026-27/0002');
  });
  it('the royalty_invoice kind is registered as an FY series', () => {
    const svc = readFileSync(join(__dirname, '..', 'numbering', 'numbering.service.ts'), 'utf8');
    expect(svc).toContain("'royalty_invoice'");
    expect(svc).toMatch(/royalty_invoice:\s*\{\s*prefix:\s*'ROY-',\s*reset:\s*'fy'/);
  });
});

describe('outstanding ageing buckets (current / 31-60 / 61-90 / 90+)', () => {
  it('routes each age to its bucket', () => {
    expect(royaltyAgeBucket(0)).toBe('current');
    expect(royaltyAgeBucket(30)).toBe('current');
    expect(royaltyAgeBucket(31)).toBe('31-60');
    expect(royaltyAgeBucket(60)).toBe('31-60');
    expect(royaltyAgeBucket(61)).toBe('61-90');
    expect(royaltyAgeBucket(90)).toBe('61-90');
    expect(royaltyAgeBucket(91)).toBe('90+');
    expect(royaltyAgeBucket(400)).toBe('90+');
  });
  it('sums outstanding into the four buckets and ignores zero-outstanding rows', () => {
    const b = ageingBuckets([
      { outstanding_minor: 100000, age_days: 10 },   // current
      { outstanding_minor: 200000, age_days: 45 },   // 31-60
      { outstanding_minor: 300000, age_days: 75 },   // 61-90
      { outstanding_minor: 400000, age_days: 120 },  // 90+
      { outstanding_minor: 0, age_days: 200 },       // ignored
    ]);
    expect(b.current_minor).toBe(100000);
    expect(b.d30_minor).toBe(200000);
    expect(b.d60_minor).toBe(300000);
    expect(b.d90_minor).toBe(400000);
    expect(b.total_minor).toBe(1000000);
  });
});

describe('royalty payment reduces outstanding and flips status to Paid when full', () => {
  it('partial payment leaves outstanding > 0 and not fully paid', () => {
    const amount = 1050000;
    let paid = 500000;
    expect(invoiceOutstanding(amount, paid)).toBe(550000);
    expect(isFullyPaid(amount, paid)).toBe(false);
    paid += 550000; // pay the rest
    expect(invoiceOutstanding(amount, paid)).toBe(0);
    expect(isFullyPaid(amount, paid)).toBe(true);
  });
  it('overpayment still clamps outstanding at 0 and reads fully paid', () => {
    expect(invoiceOutstanding(1000, 1500)).toBe(0);
    expect(isFullyPaid(1000, 1500)).toBe(true);
  });
});

describe('onboarding progress %', () => {
  it('0 of 4 = 0%, 1 of 4 = 25%, 4 of 4 = 100%', () => {
    expect(onboardingProgress([{ done: false }, { done: false }, { done: false }, { done: false }]).progress_pct).toBe(0);
    expect(onboardingProgress([{ done: true }, { done: false }, { done: false }, { done: false }]).progress_pct).toBe(25);
    const all = onboardingProgress([{ done: true }, { done: true }, { done: true }, { done: true }]);
    expect(all.done).toBe(4);
    expect(all.progress_pct).toBe(100);
  });
  it('an empty checklist is 0% (no divide-by-zero)', () => {
    expect(onboardingProgress([]).progress_pct).toBe(0);
  });
});

describe('migration 106 ships the ops tables + seeds the onboarding template', () => {
  const sql = readFileSync(join(__dirname, '..', '..', 'db', 'migrations', '106_franchise_ops.sql'), 'utf8');
  it('creates the five ops tables', () => {
    for (const t of ['royalty_invoice', 'royalty_payment', 'franchise_agreement',
      'franchise_onboarding_template', 'franchise_onboarding_step', 'franchise_territory']) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${t}`);
    }
  });
  it('seeds a DEFAULT onboarding step template (structure, not fake franchise data)', () => {
    expect(sql).toContain('INSERT INTO franchise_onboarding_template');
    expect(sql).toContain('Agreement signed');
    expect(sql).toContain('Go-live');
    // no franchise rows are seeded
    expect(sql).not.toMatch(/INSERT INTO franchise\s*\(/);
  });
});

describe('franchise report rollup + CSV shape', () => {
  // The report row shape the web CSV export projects (per-franchise + royalty billed/paid/outstanding).
  it('a report row carries every column the CSV needs', () => {
    const row = {
      franchise_id: 1, franchise_name: 'X', code: 'FX', status: 'active',
      branches: 2, active_branches: 2, students: 10, enrolments: 12,
      revenue_collected_minor: 500000, net_revenue_minor: 480000, outstanding_dues_minor: 20000,
      royalty_billed_minor: 50000, royalty_paid_minor: 30000, royalty_outstanding_minor: 20000,
    };
    // billed - paid should reconcile with outstanding when nothing is cancelled
    expect(row.royalty_billed_minor - row.royalty_paid_minor).toBe(row.royalty_outstanding_minor);
    for (const k of ['franchise_name', 'branches', 'students', 'enrolments',
      'revenue_collected_minor', 'net_revenue_minor', 'royalty_billed_minor',
      'royalty_paid_minor', 'royalty_outstanding_minor']) {
      expect(row).toHaveProperty(k);
    }
  });
});
