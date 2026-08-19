import 'reflect-metadata';
import { StudentService } from './student.service';
import { ResolvedScope } from '../rbac/rbac.types';

/**
 * ENROLLMENT LEVEL RE-MODEL (batch 2) — service behaviour.
 *   * convert with 4 levels  -> ONE enrolment, Total = Σ level fees, Net = Total − discount
 *     (overall AND level-wise), + one row per level line-item;
 *   * add-level UPGRADE      -> the SAME enrolment's Total/Net increase, the plan reconciles
 *     (a future installment grows by the delta), NO second enrolment;
 *   * a no-level course      -> back-compat single-fee enrolment, ZERO level rows;
 *   * Due = Net − Paid.
 */

const scopeAll: ResolvedScope = { permissionKey: 'x', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [] };
const resolver = { buildScopeWhere: () => '1=1' };

const MASTER_ROWS = [
  { id: 11, code: 'A1', label: 'A1', fee_minor: 1000000 },
  { id: 12, code: 'A2', label: 'A2', fee_minor: 1200000 },
  { id: 13, code: 'B1', label: 'B1', fee_minor: 1500000 },
  { id: 14, code: 'B2', label: 'B2', fee_minor: 1800000 },
];

const numbering = { allocate: async () => 'SID-2026-27/0007', allocateCoded: async () => 'FR-2026-27/001' };

const has = (issued: any[], re: RegExp) => issued.some((i) => re.test(i.sql));
const find = (issued: any[], re: RegExp) => issued.find((i) => re.test(i.sql));
const count = (issued: any[], re: RegExp) => issued.filter((i) => re.test(i.sql)).length;

/* --------------------------------------------------- convert with levels harness */

function makeConvert() {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    one: async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      if (/FROM organisation/.test(sql)) return { id: 1 };
      if (/FROM m_course WHERE id/.test(sql)) return { id: 100, name: 'French', code: 'FR', meta: { fee: 30000 } };
      return null;
    },
    query: async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      if (/FROM course_level/.test(sql)) return MASTER_ROWS;
      return [];
    },
    tx: async (fn: any) => fn({
      query: async (sql: string, params: unknown[] = []) => {
        issued.push({ sql, params });
        if (/INSERT INTO enrolment \(/.test(sql)) return { rows: [{ id: 900 }] };
        if (/FROM student_vertical_id/.test(sql)) return { rows: [{ id: 950, student_vertical_no: 'RID-2026-27/0007' }] };
        return { rows: [{ id: 1 }] };
      },
    }),
  };
  const svc = new StudentService(db as never, resolver as never, numbering as never);
  return { svc, issued };
}
const LEAD = { vertical_id: 3, branch_id: 9, owner_id: 5 };

describe('convert with levels — ONE enrolment, Total = Σ, Net = Total − discount', () => {
  it('OVERALL discount: 4 levels -> one enrolment, Total 55,000, Net 49,500, 4 level rows', async () => {
    const { svc, issued } = makeConvert();
    const rows = [{ course_id: 100, discount_type: 'percent', discount_value: 10,
      levels: [{ code: 'A1' }, { code: 'A2' }, { code: 'B1' }, { code: 'B2' }] }];
    const out: any = await svc.createConvertEnrolments(7, 31, LEAD, rows, { id: 5 });
    // exactly ONE enrolment created (not one per level)
    expect(count(issued, /INSERT INTO enrolment \(/)).toBe(1);
    const ins = find(issued, /INSERT INTO enrolment \(/)!;
    expect(ins.params[9]).toBe(5500000);   // fee_minor = Σ level fees = ₹55,000
    expect(ins.params[11]).toBe(4950000);  // net = 55,000 − 10% = ₹49,500
    expect(ins.params[20]).toBe('overall'); // discount_scope
    // one line-item per level
    expect(count(issued, /INSERT INTO enrolment_level/)).toBe(4);
    expect(out[0].total_fee_minor).toBe(5500000);
    expect(out[0].net_fee_minor).toBe(4950000);
    expect(out[0].levels).toHaveLength(4);
  });

  it('LEVEL-WISE discount: Net = Total − Σ per-level discounts', async () => {
    const { svc, issued } = makeConvert();
    const rows = [{ course_id: 100, discount_scope: 'level',
      levels: [{ code: 'A1', discount_minor: 100000 }, { code: 'A2', discount_minor: 200000 }, { code: 'B1' }] }];
    await svc.createConvertEnrolments(7, 31, LEAD, rows, { id: 5 });
    const ins = find(issued, /INSERT INTO enrolment \(/)!;
    expect(ins.params[9]).toBe(3700000);   // 10,000+12,000+15,000 = ₹37,000
    expect(ins.params[11]).toBe(3400000);  // − (1,000+2,000) = ₹34,000
    expect(ins.params[20]).toBe('level');
  });

  it('BACK-COMPAT: a course with no levels enrols on its single Standard Fee, zero level rows', async () => {
    const { svc, issued } = makeConvert();
    const rows = [{ course_id: 100 }]; // no levels
    await svc.createConvertEnrolments(7, 31, LEAD, rows, { id: 5 });
    const ins = find(issued, /INSERT INTO enrolment \(/)!;
    expect(ins.params[9]).toBe(3000000);   // meta.fee 30,000 -> paise
    expect(count(issued, /INSERT INTO enrolment_level/)).toBe(0);
  });
});

/* --------------------------------------------------- upgrade / add-level harness */

const ENR = (over: any = {}) => ({
  id: 900, org_id: 1, branch_id: 9, vertical_id: 3, course_id: 100, enrolment_no: 'FR-2026-27/001',
  status: 'active', discount_scope: 'overall', discount_type: 'none', discount_value: 0,
  fee_minor: 1000000, gross_fee_minor: 1000000, discount_minor: 0, discount_amount_minor: 0, net_fee_minor: 1000000,
  linked_student_id: 7, ...over,
});

function makeUpgrade(opts: { enr?: any; plan?: any; installment?: any; existing?: any[] } = {}) {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    one: async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      if (/FROM enrolment e/.test(sql) && /LIMIT 1/.test(sql)) return opts.enr ?? ENR();
      return null;
    },
    query: async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      if (/FROM course_level/.test(sql)) return MASTER_ROWS;
      if (/FROM enrolment_level WHERE enrolment_id/.test(sql)) return opts.existing ?? [{ code: 'a1' }];
      return [];
    },
    tx: async (fn: any) => fn({
      query: async (sql: string, params: unknown[] = []) => {
        issued.push({ sql, params });
        if (/FROM payment_plan WHERE enrolment_id/.test(sql)) return { rows: opts.plan === null ? [] : [opts.plan ?? { id: 77 }] };
        if (/FROM installment\b/.test(sql) && /ORDER BY seq_no DESC/.test(sql)) {
          return { rows: opts.installment === null ? [] : [opts.installment ?? { id: 88, amount_minor: 500000, paid_minor: 0 }] };
        }
        if (/MAX\(seq_no\)/.test(sql)) return { rows: [{ seq: 3, d: '2026-09-01' }] };
        return { rows: [{ id: 1 }] };
      },
    }),
  };
  const svc = new StudentService(db as never, resolver as never, numbering as never);
  return { svc, issued };
}

describe('add-level UPGRADE — same enrolment, Total/Net up, plan reconciled, no new enrolment', () => {
  it('adds A2 to an A1 enrolment: Total 10k->22k, Net up, installment grows by delta, no INSERT enrolment', async () => {
    const { svc, issued } = makeUpgrade();
    const out: any = await svc.addEnrolmentLevel(900, { levels: [{ code: 'A2' }] }, { id: 5 }, scopeAll, 7);
    // NO second enrolment
    expect(has(issued, /INSERT INTO enrolment \(/)).toBe(false);
    // a new level line-item was inserted
    expect(has(issued, /INSERT INTO enrolment_level/)).toBe(true);
    // the enrolment row's totals grew (Total = 10k + 12k = 22k, Net = 22k, discount none)
    const upd = find(issued, /UPDATE enrolment SET fee_minor/)!;
    expect(upd.params[1]).toBe(2200000); // new total
    expect(upd.params[3]).toBe(2200000); // new net
    expect(out.total_fee_minor).toBe(2200000);
    expect(out.net_fee_minor).toBe(2200000);
    // the plan reconciled: the open installment grew by the delta (₹5,000 -> ₹17,000)
    const inst = find(issued, /UPDATE installment/)!;
    expect(inst.params[1]).toBe(1700000);
    // Due = Net − Paid
    expect(Math.max(0, out.net_fee_minor - 500000)).toBe(1700000);
  });

  it('re-applies an OVERALL percent discount on the new total', async () => {
    const { svc, issued } = makeUpgrade({ enr: ENR({ discount_type: 'percent', discount_value: 10, discount_minor: 100000, discount_amount_minor: 100000, net_fee_minor: 900000 }) });
    await svc.addEnrolmentLevel(900, { levels: [{ code: 'A2' }] }, { id: 5 }, scopeAll, 7);
    const upd = find(issued, /UPDATE enrolment SET fee_minor/)!;
    expect(upd.params[1]).toBe(2200000);  // total 22,000
    expect(upd.params[2]).toBe(220000);   // discount = 10% of 22,000 = ₹2,200
    expect(upd.params[3]).toBe(1980000);  // net = ₹19,800
  });

  it('rejects a duplicate level and a non-active enrolment', async () => {
    const dup = makeUpgrade({ existing: [{ code: 'a2' }] });
    await expect(dup.svc.addEnrolmentLevel(900, { levels: [{ code: 'A2' }] }, { id: 5 }, scopeAll, 7)).rejects.toThrow(/already part/);
    const cancelled = makeUpgrade({ enr: ENR({ status: 'cancelled' }) });
    await expect(cancelled.svc.addEnrolmentLevel(900, { levels: [{ code: 'A2' }] }, { id: 5 }, scopeAll, 7)).rejects.toThrow(/only be added to an active/);
  });

  it('no active plan -> totals still update, no installment touched (unplanned dues recompute)', async () => {
    const { svc, issued } = makeUpgrade({ plan: null });
    await svc.addEnrolmentLevel(900, { levels: [{ code: 'A2' }] }, { id: 5 }, scopeAll, 7);
    expect(has(issued, /UPDATE enrolment SET fee_minor/)).toBe(true);
    expect(has(issued, /UPDATE installment/)).toBe(false);
  });
});
