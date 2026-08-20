import 'reflect-metadata';
import { StudentService } from './student.service';
import { ResolvedScope } from '../rbac/rbac.types';

/**
 * dev/110 — LEVEL-WISE DISCOUNT. Each selected course level carries its OWN discount (amount or %),
 * so the enrolment Total (gross) = Σ level fees, Total Discount = Σ per-level discounts and Net =
 * Σ per-level nets. The Discount Master's level-scoped cap resolves PER (course, level): an over-cap
 * discount on ONE level holds only that level's excess pending while the others apply in full.
 * `enrolment_level.discount_minor` keeps the REQUESTED per-level breakdown; the enrolment aggregate
 * applies the capped sum until an approval lands. Edit re-syncs the level line-items + recomputes.
 */

const scopeAll: ResolvedScope = { permissionKey: 'x', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [] };
const resolver = { buildScopeWhere: () => '1=1' };
const numbering = { allocate: async () => 'SID-1', allocateCoded: async () => 'FR-2026-27/001' };

// A1 ₹10,000 · A2 ₹12,000 · B1 ₹15,000
const MASTER_ROWS = [
  { id: 11, code: 'A1', label: 'A1', fee_minor: 1000000 },
  { id: 12, code: 'A2', label: 'A2', fee_minor: 1200000 },
  { id: 13, code: 'B1', label: 'B1', fee_minor: 1500000 },
];
const LEAD = { vertical_id: 3, branch_id: 9, owner_id: 5 };

const find = (issued: any[], re: RegExp) => issued.find((i) => re.test(i.sql));
const all = (issued: any[], re: RegExp) => issued.filter((i) => re.test(i.sql));
const count = (issued: any[], re: RegExp) => all(issued, re).length;
const has = (issued: any[], re: RegExp) => issued.some((i) => re.test(i.sql));
/** the enrolment_level INSERT for a level code -> its discount_minor (param 6). */
const levelDisc = (issued: any[], code: string) =>
  all(issued, /INSERT INTO enrolment_level/).find((i) => String(i.params[3]).toLowerCase() === code.toLowerCase())?.params[6];

const rbac = (authorised: boolean) => ({
  loadUserGrants: async () => ({ rolePermissions: authorised ? [{ permissionKey: 'discount.approve' }] : [{ permissionKey: 'student.update' }] }),
});

/* -------------------------------------------------------------- convert harness */
function makeConvert(discountMaster?: any, authorised = false) {
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
        if (/FROM student_vertical_id/.test(sql)) return { rows: [{ id: 950, student_vertical_no: 'RID-1' }] };
        return { rows: [{ id: 1 }] };
      },
    }),
  };
  const svc = new StudentService(db as never, resolver as never, numbering as never,
    undefined, undefined, rbac(authorised) as never, undefined, undefined, discountMaster as never);
  return { svc, issued };
}

describe('dev/110 convert — per-level discount (₹ and %) -> per-level nets + summed gross/discount/net', () => {
  it('mixes amount + percent: A1 ₹1,000 · A2 10% · B1 none → gross ₹37,000, discount ₹2,200, net ₹34,800', async () => {
    const { svc, issued } = makeConvert();
    const rows = [{ course_id: 100, discount_scope: 'level', levels: [
      { code: 'A1', discount_type: 'amount', discount_value: 1000 },   // ₹1,000 -> 100000 paise
      { code: 'A2', discount_type: 'percent', discount_value: 10 },    // 10% of ₹12,000 -> 120000 paise
      { code: 'B1' },
    ] }];
    const out: any = await svc.createConvertEnrolments(7, 31, LEAD, rows, { id: 5 });
    const ins = find(issued, /INSERT INTO enrolment \(/)!;
    expect(ins.params[9]).toBe(3700000);    // fee_minor (gross) = Σ level fees
    expect(ins.params[10]).toBe(220000);    // discount_minor (applied) = Σ per-level discounts
    expect(ins.params[11]).toBe(3480000);   // net = gross − discount
    expect(ins.params[20]).toBe('level');   // discount_scope
    expect(ins.params[21]).toBe('none');    // no cap -> nothing pending
    // per-level breakdown persisted on enrolment_level.discount_minor
    expect(count(issued, /INSERT INTO enrolment_level/)).toBe(3);
    expect(levelDisc(issued, 'A1')).toBe(100000);
    expect(levelDisc(issued, 'A2')).toBe(120000);
    expect(levelDisc(issued, 'B1')).toBe(0);
    expect(out[0].net_fee_minor).toBe(3480000);
  });
});

describe('dev/110 convert — level-scoped cap: over-cap on ONE level holds that level pending, others apply', () => {
  it('A1 over its ₹500 cap → A1 capped+pending; A2 (no cap) applies in full', async () => {
    // cap only for course-level A1 (id 11); any other level -> no cap
    const discountMaster = { resolve: async (ctx: any) => (Number(ctx?.course_level_id) === 11 ? { capMinor: 50000 } : { capMinor: null }) };
    const { svc, issued } = makeConvert(discountMaster, false);
    const rows = [{ course_id: 100, discount_scope: 'level', levels: [
      { code: 'A1', discount_type: 'amount', discount_value: 1000 },   // ₹1,000 req, cap ₹500 -> applied ₹500, pending
      { code: 'A2', discount_type: 'amount', discount_value: 1000 },   // ₹1,000 req, no cap -> applied ₹1,000
    ] }];
    const out: any = await svc.createConvertEnrolments(7, 31, LEAD, rows, { id: 5 });
    const ins = find(issued, /INSERT INTO enrolment \(/)!;
    expect(ins.params[9]).toBe(2200000);    // gross ₹22,000
    expect(ins.params[10]).toBe(150000);    // applied = ₹500 (A1 cap) + ₹1,000 (A2) = ₹1,500
    expect(ins.params[11]).toBe(2050000);   // net = ₹20,500
    expect(ins.params[21]).toBe('pending'); // any level over cap -> the enrolment is pending
    expect(ins.params[22]).toBe(200000);    // discount_requested_minor = full Σ = ₹2,000
    expect(ins.params[24]).toBe(5);         // requested_by
    // the REQUESTED per-level discounts are the breakdown (approval later applies the full Σ)
    expect(levelDisc(issued, 'A1')).toBe(100000);
    expect(levelDisc(issued, 'A2')).toBe(100000);
    expect(out[0].discount_approval_status).toBe('pending');
  });
});

/* -------------------------------------------------------------- add-level upgrade harness */
const ENR = (over: any = {}) => ({
  id: 900, org_id: 1, branch_id: 9, vertical_id: 3, course_id: 100, enrolment_no: 'FR-2026-27/001',
  status: 'active', discount_scope: 'level', discount_type: 'amount', discount_value: 0,
  fee_minor: 1000000, gross_fee_minor: 1000000, discount_minor: 0, discount_amount_minor: 0, net_fee_minor: 1000000,
  linked_student_id: 7, ...over,
});
function makeUpgrade() {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    one: async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      if (/FROM enrolment e/.test(sql) && /LIMIT 1/.test(sql)) return ENR();
      return null;
    },
    query: async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      if (/FROM course_level/.test(sql)) return MASTER_ROWS;
      if (/FROM enrolment_level WHERE enrolment_id/.test(sql)) return [{ code: 'a1' }];
      return [];
    },
    tx: async (fn: any) => fn({
      query: async (sql: string, params: unknown[] = []) => {
        issued.push({ sql, params });
        if (/FROM payment_plan WHERE enrolment_id/.test(sql)) return { rows: [{ id: 77 }] };
        if (/FROM installment\b/.test(sql) && /ORDER BY seq_no DESC/.test(sql)) return { rows: [{ id: 88, amount_minor: 500000, paid_minor: 0 }] };
        if (/MAX\(seq_no\)/.test(sql)) return { rows: [{ seq: 3, d: '2026-09-01' }] };
        return { rows: [{ id: 1 }] };
      },
    }),
  };
  const svc = new StudentService(db as never, resolver as never, numbering as never);
  return { svc, issued };
}

describe('dev/110 add-level — a later level carries its OWN discount, added to the enrolment', () => {
  it('adds A2 with a ₹500 level discount to a level-scoped A1 enrolment', async () => {
    const { svc, issued } = makeUpgrade();
    const out: any = await svc.addEnrolmentLevel(900, { levels: [{ code: 'A2', discount_type: 'amount', discount_value: 500 }] }, { id: 5 }, scopeAll, 7);
    expect(has(issued, /INSERT INTO enrolment \(/)).toBe(false);         // no second enrolment
    expect(levelDisc(issued, 'A2')).toBe(50000);                        // ₹500 persisted on the new level line-item
    const upd = find(issued, /UPDATE enrolment SET fee_minor/)!;
    expect(upd.params[1]).toBe(2200000);   // new total ₹22,000
    expect(upd.params[2]).toBe(50000);     // new discount ₹500 (old 0 + added 500)
    expect(upd.params[3]).toBe(2150000);   // new net ₹21,500
    expect(out.net_fee_minor).toBe(2150000);
  });
});

/* -------------------------------------------------------------- edit-with-levels harness */
function makeEdit() {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    one: async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      if (/FROM enrolment e/.test(sql) && /LIMIT 1/.test(sql)) {
        return { id: 900, org_id: 1, status: 'active', enrolment_no: 'FR-2026-27/001', course_id: 100,
          branch_id: 9, vertical_id: 3, gross_fee_minor: 2200000, fee_minor: 2200000, net_fee_minor: 2200000,
          discount_type: 'amount', discount_value: 0, discount_amount_minor: 0, discount_minor: 0,
          discount_scope: 'level', payment_plan: 'full', start_date: null, linked_student_id: 7 };
      }
      if (/FROM m_course WHERE id/.test(sql)) return { id: 100 };
      if (/FROM fee_receipt/.test(sql)) return { paid: 0 };
      return null;
    },
    query: async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      if (/FROM course_level/.test(sql)) return MASTER_ROWS;
      return [];
    },
    tx: async (fn: any) => fn({ query: async (sql: string, params: unknown[] = []) => { issued.push({ sql, params }); return { rows: [] }; } }),
  };
  const svc = new StudentService(db as never, resolver as never, numbering as never,
    undefined, undefined, rbac(false) as never, undefined, undefined, undefined);
  return { svc, issued };
}

describe('dev/110 edit — updating a level discount re-syncs the line-items + recomputes net (Due = Net − Paid)', () => {
  it("raises A1's discount to ₹2,000, keeps A2 ₹1,000 → net ₹19,000, level rows rebuilt", async () => {
    const { svc, issued } = makeEdit();
    const out: any = await svc.updateEnrolment(900, {
      course_id: 100, discount_scope: 'level', payment_plan: 'full',
      levels: [
        { code: 'A1', fee_minor: 1000000, discount_type: 'amount', discount_value: 2000 },
        { code: 'A2', fee_minor: 1200000, discount_type: 'amount', discount_value: 1000 },
      ],
    }, { id: 5 }, scopeAll, 7);
    const upd = find(issued, /UPDATE enrolment/)!;
    expect(upd.params[2]).toBe(2200000);   // gross unchanged (Σ level fees)
    expect(upd.params[3]).toBe(300000);    // applied discount = ₹2,000 + ₹1,000
    expect(upd.params[4]).toBe(1900000);   // net ₹19,000
    expect(upd.params[14]).toBe('level');  // discount_scope
    // the level line-items are re-synced (delete-all then re-insert the edited set)
    expect(has(issued, /DELETE FROM enrolment_level WHERE enrolment_id/)).toBe(true);
    expect(count(issued, /INSERT INTO enrolment_level/)).toBe(2);
    expect(levelDisc(issued, 'A1')).toBe(200000);
    // Due = Net − Paid (nothing collected)
    expect(out.net_fee_minor).toBe(1900000);
    expect(Math.max(0, out.net_fee_minor - 0)).toBe(1900000);
  });
});
