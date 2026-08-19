import { BadRequestException } from '@nestjs/common';
import { EnrolmentService, appliedDiscountMinor } from './enrolment.service';

/**
 * OVER-CAP DISCOUNT APPROVAL (dev/103). A discount within the Discount Master cap applies
 * immediately; an over-cap discount by a counsellor is held at the cap (excess pending) and
 * cannot be self-approved; an authorized user approves → the full discount applies and the
 * Net recomputes; a reject leaves the discount at the cap.
 */

const LEAD = { id: 1, org_id: 1, full_name: 'ZZTEST', branch_id: 9, vertical_id: 9, pipeline_id: null, campaign_id: null, team_id: null, owner_id: 1, stage_id: null };

/** A create()-capable stub: routes db.one by SQL, captures tx statements. */
function createHarness(capMinorValue: number | null, canApprove: boolean) {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    one: async (sql: string) => {
      if (/FROM organisation/.test(sql)) return { id: 1 };
      if (/FROM m_course/.test(sql)) return { code: 'ENG' };
      if (/FROM lead l/.test(sql)) return LEAD;
      return {};
    },
    query: async () => [],
    tx: async (fn: any) => fn({
      query: async (sql: string, params: unknown[] = []) => { issued.push({ sql, params }); return { rows: [{ id: 77 }] }; },
    }),
  };
  const resolver = { buildScopeWhere: () => '1=1' };
  const numbering = { allocateCoded: async () => 'ENG-2026-001' };
  const approvals = { policy: async () => ({ enabled: false, steps: [] }), notifyApprovers: async () => undefined };
  const discountMaster = { resolve: async () => ({ cap: null, capMinor: capMinorValue }) };
  const rbac = { loadUserGrants: async () => ({ rolePermissions: canApprove ? [{ permissionKey: 'discount.approve' }] : [] }) };
  const svc = new EnrolmentService(db as never, resolver as never, numbering as never, approvals as never, undefined, discountMaster as never, rbac as never);
  return { svc, issued };
}

/** A get()-capable stub for approve/reject: db.one returns the enrolment row. */
function decideHarness(enrolRow: Record<string, unknown>) {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    one: async (sql: string) => {
      if (/FROM enrolment e/.test(sql)) return enrolRow;
      return {};
    },
    query: async (sql: string, params: unknown[] = []) => { issued.push({ sql, params }); return []; },
    tx: async (fn: any) => fn({ query: async (sql: string, params: unknown[] = []) => { issued.push({ sql, params }); return { rows: [] }; } }),
  };
  const resolver = { buildScopeWhere: () => '1=1' };
  const approvals = { forEntity: async () => [] };
  const svc = new EnrolmentService(db as never, resolver as never, {} as never, approvals as never);
  return { svc, issued };
}

describe('appliedDiscountMinor', () => {
  it('within cap / approved: applies the full requested', () => {
    expect(appliedDiscountMinor('none', 1000000, 200000)).toBe(1000000);
    expect(appliedDiscountMinor('approved', 1000000, 200000)).toBe(1000000);
  });
  it('pending / rejected: withholds the excess, applies up to the cap', () => {
    expect(appliedDiscountMinor('pending', 1000000, 200000)).toBe(200000);
    expect(appliedDiscountMinor('rejected', 1000000, 200000)).toBe(200000);
  });
});

describe('create() over-cap discount', () => {
  it('a discount WITHIN cap applies immediately (status none)', async () => {
    const { svc } = createHarness(500000, false); // cap ₹5,000
    const r: any = await svc.create(
      { lead_id: 1, fee_minor: 2000000, discount_type: 'amount', discount_value: 200000, payment_plan: 'full', course_id: 5 },
      { id: 1 }, {} as never);
    expect(r.discount_approval_status).toBe('none');
    expect(r.discount_over_cap).toBe(false);
  });

  it('an over-cap discount by a COUNSELLOR is held pending, applying only up to the cap', async () => {
    const { svc, issued } = createHarness(200000, false); // cap ₹2,000, requested ₹10,000
    const r: any = await svc.create(
      { lead_id: 1, fee_minor: 2000000, discount_type: 'amount', discount_value: 1000000, payment_plan: 'full', course_id: 5 },
      { id: 1 }, {} as never);
    expect(r.discount_approval_status).toBe('pending');
    expect(r.discount_over_cap).toBe(true);
    expect(r.discount_cap_minor).toBe(200000);
    const insert = issued.find((q) => /INSERT INTO enrolment/.test(q.sql))!;
    expect(insert.params[12]).toBe(200000);   // applied discount = the cap
    expect(insert.params[13]).toBe(1800000);  // net = fee − cap (excess withheld)
    expect(insert.params[25]).toBe('pending');
    expect(insert.params[26]).toBe(1000000);  // full requested recorded
  });

  it('an authorized user (discount.approve) applies the full over-cap discount inline', async () => {
    const { svc, issued } = createHarness(200000, true);
    const r: any = await svc.create(
      { lead_id: 1, fee_minor: 2000000, discount_type: 'amount', discount_value: 1000000, payment_plan: 'full', course_id: 5 },
      { id: 5 }, {} as never);
    expect(r.discount_approval_status).toBe('approved');
    const insert = issued.find((q) => /INSERT INTO enrolment/.test(q.sql))!;
    expect(insert.params[12]).toBe(1000000);  // full discount applied
    expect(insert.params[13]).toBe(1000000);  // net = fee − full
  });
});

describe('approve / reject the over-cap discount', () => {
  const PENDING = {
    id: 77, enrolment_no: 'ENG-2026-001', lead_id: 1, status: 'active',
    fee_minor: 2000000, discount_minor: 200000, net_fee_minor: 1800000,
    discount_approval_status: 'pending', discount_requested_minor: 1000000,
    discount_cap_minor: 200000, discount_requested_by: 1, paid_minor: 0,
    branch_id: 9, vertical_id: 9,
  };

  it('a counsellor cannot approve their OWN request', async () => {
    const { svc } = decideHarness(PENDING);
    await expect(svc.approveDiscount(77, {}, { id: 1 }, {} as never)).rejects.toThrow(/cannot approve your own/i);
  });

  it('an authorized approver applies the FULL discount and recomputes the net', async () => {
    const { svc, issued } = decideHarness(PENDING);
    const r: any = await svc.approveDiscount(77, { remarks: 'ok' }, { id: 5 }, {} as never);
    expect(r.discount_approval_status).toBe('approved');
    expect(r.discount_minor).toBe(1000000);
    expect(r.net_fee_minor).toBe(1000000);
    const upd = issued.find((q) => /UPDATE enrolment SET discount_minor/.test(q.sql))!;
    expect(upd.params[1]).toBe(1000000);   // applied = full requested
    expect(upd.params[2]).toBe(1000000);   // net = fee − full
  });

  it('reject keeps the discount at the cap and requires a reason', async () => {
    const { svc } = decideHarness(PENDING);
    await expect(svc.rejectDiscount(77, {}, { id: 5 }, {} as never)).rejects.toThrow(/reason/i);
    const r: any = await svc.rejectDiscount(77, { remarks: 'too high' }, { id: 5 }, {} as never);
    expect(r.discount_approval_status).toBe('rejected');
    expect(r.discount_minor).toBe(200000); // stays at the cap
  });

  it('approving something not pending is a 400', async () => {
    const { svc } = decideHarness({ ...PENDING, discount_approval_status: 'none' });
    await expect(svc.approveDiscount(77, {}, { id: 5 }, {} as never)).rejects.toThrow(/no over-cap discount/i);
  });
});
