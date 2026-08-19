import 'reflect-metadata';
import { StudentService } from './student.service';
import { ResolvedScope } from '../rbac/rbac.types';

/**
 * DEF-4 (dev/104) — the OVER-CAP discount decision is wired into the ACTUAL save paths:
 * convert (POST /students/convert → createConvertEnrolments), add (POST /students/:id/enrolments
 * → addEnrolment) and edit (PATCH /students/:id/enrolments/:eid → updateEnrolment). Before this
 * fix the full discount was silently stored and no approval was raised; now an over-cap discount
 * by a non-authorised user applies ONLY up to the cap and records the excess `pending`, while an
 * authorised (discount.approve) user applies it in full inline.
 *
 * Scenario: ₹20,000 fee, ₹8,000 requested discount, ₹4,000 cap.
 *   counsellor  → applied ₹4,000 (cap), net ₹16,000, status 'pending', requested ₹8,000 stored.
 *   admin       → applied ₹8,000 (full), net ₹12,000, status 'approved'.
 */

const scopeAll: ResolvedScope = { permissionKey: 'x', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [] };
const resolver = { buildScopeWhere: () => '1=1' };
const numbering = { allocate: async () => 'SID-2026-27/0007', allocateCoded: async () => 'FR-2026-27/001' };

const FEE = 2000000;        // ₹20,000
const REQUESTED = 800000;   // ₹8,000
const CAP = 400000;         // ₹4,000

/** discountMaster double — a fixed ₹4,000 cap for any (branch,vertical,course). */
const discountMaster = { resolve: async () => ({ cap: { id: 1 }, capMinor: CAP }) };
/** rbac double — `authorised` toggles whether the actor holds discount.approve. */
const rbac = (authorised: boolean) => ({
  loadUserGrants: async () => ({ rolePermissions: authorised ? [{ permissionKey: 'discount.approve' }] : [{ permissionKey: 'student.update' }] }),
});

const find = (issued: any[], re: RegExp) => issued.find((i) => re.test(i.sql));

/* -------------------------------------------------------------- convert harness */
function makeConvert(authorised: boolean) {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    one: async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      if (/FROM organisation/.test(sql)) return { id: 1 };
      if (/FROM m_course WHERE id/.test(sql)) return { id: 100, name: 'French', code: 'FR', meta: { fee: 20000 } };
      return null;
    },
    query: async (sql: string, params: unknown[] = []) => { issued.push({ sql, params }); return []; },
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
const LEAD = { vertical_id: 3, branch_id: 9, owner_id: 5 };

describe('DEF-4 convert — over-cap discount is capped + held pending (not applied in full)', () => {
  it('counsellor: ₹8,000 on ₹20,000 with a ₹4,000 cap → net ₹16,000, status pending, requested ₹8,000 stored', async () => {
    const { svc, issued } = makeConvert(false);
    const rows = [{ course_id: 100, discount_type: 'amount', discount_value: REQUESTED }];
    const out: any = await svc.createConvertEnrolments(7, 31, LEAD, rows, { id: 5 });
    const ins = find(issued, /INSERT INTO enrolment \(/)!;
    expect(ins.params[9]).toBe(FEE);          // fee_minor
    expect(ins.params[10]).toBe(CAP);         // discount_minor = APPLIED (cap only), not the full 8,000
    expect(ins.params[11]).toBe(1600000);     // net = 16,000
    expect(ins.params[21]).toBe('pending');   // discount_approval_status
    expect(ins.params[22]).toBe(REQUESTED);   // discount_requested_minor
    expect(ins.params[23]).toBe(CAP);         // discount_cap_minor
    expect(ins.params[24]).toBe(5);           // discount_requested_by
    expect(out[0].net_fee_minor).toBe(1600000);
    expect(out[0].discount_approval_status).toBe('pending');
  });

  it('authorised (discount.approve): applied in full → net ₹12,000, status approved', async () => {
    const { svc, issued } = makeConvert(true);
    const rows = [{ course_id: 100, discount_type: 'amount', discount_value: REQUESTED }];
    await svc.createConvertEnrolments(7, 31, LEAD, rows, { id: 5 });
    const ins = find(issued, /INSERT INTO enrolment \(/)!;
    expect(ins.params[10]).toBe(REQUESTED);   // full ₹8,000 applied inline
    expect(ins.params[11]).toBe(1200000);     // net = 12,000
    expect(ins.params[21]).toBe('approved');
    expect(ins.params[25]).toBe(5);           // discount_approved_by
  });
});

/* -------------------------------------------------------------- add-enrolment harness */
function makeAdd(authorised: boolean) {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    one: async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      if (/FROM student s/.test(sql)) return { id: 7, vertical_id: 3, branch_id: 9, lead_id: 31, owner_id: 5, status: 'active' };
      if (/FROM m_course WHERE id/.test(sql)) return { id: 100, name: 'French', code: 'FR' };
      if (/FROM organisation/.test(sql)) return { id: 1 };
      return null;
    },
    query: async (sql: string, params: unknown[] = []) => { issued.push({ sql, params }); return []; },
    tx: async (fn: any) => fn({
      query: async (sql: string, params: unknown[] = []) => {
        issued.push({ sql, params });
        if (/INSERT INTO enrolment \(/.test(sql)) return { rows: [{ id: 901 }] };
        if (/FROM student_vertical_id/.test(sql)) return { rows: [{ id: 951, student_vertical_no: 'RID-2' }] };
        return { rows: [{ id: 1 }] };
      },
    }),
  };
  const svc = new StudentService(db as never, resolver as never, numbering as never,
    undefined, undefined, rbac(authorised) as never, undefined, undefined, discountMaster as never);
  return { svc, issued };
}

describe('DEF-4 add-enrolment — over-cap discount is capped + held pending', () => {
  it('counsellor: net ₹16,000, status pending, requested ₹8,000 stored', async () => {
    const { svc, issued } = makeAdd(false);
    const out: any = await svc.addEnrolment(7, { course_id: 100, fee_minor: FEE, discount_type: 'amount', discount_value: REQUESTED }, { id: 5 }, scopeAll);
    const ins = find(issued, /INSERT INTO enrolment \(/)!;
    expect(ins.params[10]).toBe(CAP);         // applied cap only
    expect(ins.params[11]).toBe(1600000);     // net
    expect(ins.params[21]).toBe('pending');
    expect(ins.params[22]).toBe(REQUESTED);
    expect(out.discount_approval_status).toBe('pending');
    expect(out.net_fee_minor).toBe(1600000);
  });
});

/* -------------------------------------------------------------- edit-enrolment harness */
function makeEdit(authorised: boolean) {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    one: async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      if (/FROM enrolment e/.test(sql) && /LIMIT 1/.test(sql)) {
        return { id: 900, status: 'active', enrolment_no: 'FR-2026-27/001', course_id: 100,
          branch_id: 9, vertical_id: 3, gross_fee_minor: FEE, fee_minor: FEE, net_fee_minor: FEE,
          discount_type: 'none', discount_value: 0, discount_amount_minor: 0, discount_minor: 0,
          payment_plan: 'full', start_date: null, linked_student_id: 7 };
      }
      if (/FROM fee_receipt/.test(sql)) return { paid: 0 };
      return null;
    },
    query: async (sql: string, params: unknown[] = []) => { issued.push({ sql, params }); return []; },
  };
  const svc = new StudentService(db as never, resolver as never, numbering as never,
    undefined, undefined, rbac(authorised) as never, undefined, undefined, discountMaster as never);
  return { svc, issued };
}

describe('DEF-4 edit-enrolment (PATCH /students/:id/enrolments/:eid) — over-cap capped + pending', () => {
  it('counsellor edit adds an over-cap ₹8,000 discount → net ₹16,000, status pending', async () => {
    const { svc, issued } = makeEdit(false);
    const out: any = await svc.updateEnrolment(900, { fee_minor: FEE, discount_type: 'amount', discount_value: REQUESTED, payment_plan: 'full' }, { id: 5 }, scopeAll, 7);
    const upd = find(issued, /UPDATE enrolment/)!;
    expect(upd.params[3]).toBe(CAP);          // applied
    expect(upd.params[4]).toBe(1600000);      // net
    expect(upd.params[9]).toBe('pending');    // discount_approval_status
    expect(upd.params[10]).toBe(REQUESTED);   // discount_requested_minor
    expect(out.net_fee_minor).toBe(1600000);
    expect(out.discount_approval_status).toBe('pending');
  });

  it('admin edit applies the full ₹8,000 inline → net ₹12,000, status approved', async () => {
    const { svc, issued } = makeEdit(true);
    await svc.updateEnrolment(900, { fee_minor: FEE, discount_type: 'amount', discount_value: REQUESTED, payment_plan: 'full' }, { id: 5 }, scopeAll, 7);
    const upd = find(issued, /UPDATE enrolment/)!;
    expect(upd.params[3]).toBe(REQUESTED);    // full applied
    expect(upd.params[4]).toBe(1200000);      // net
    expect(upd.params[9]).toBe('approved');
  });
});
