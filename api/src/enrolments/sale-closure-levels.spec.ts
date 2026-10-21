import { EnrolmentService } from './enrolment.service';

/**
 * SALE CLOSURE (client 3 Sep, F1 / F1.1 / F1.2): one or more levels of the course, the total fee
 * = Σ level fees, the discount on the overall total (₹ or %) or per level (₹ or % each), and the
 * instalment plan created with the enrolment — immediately when it is active, or held on the
 * enrolment (plan_setup) and built once it is approved. Driven through db / plans doubles.
 */

const LEAD = { id: 1, org_id: 1, full_name: 'ZZTEST', branch_id: 9, vertical_id: 9, pipeline_id: null, campaign_id: null, team_id: null, owner_id: 1, stage_id: null };
const LEVELS = [
  { id: 11, code: 'A1', label: 'A1', fee_minor: 1000000, exam_fee_minor: 0 },
  { id: 12, code: 'A2', label: 'A2', fee_minor: 1200000, exam_fee_minor: 0 },
];

function harness(opts: { approvals?: boolean } = {}) {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const planCalls: any[] = [];
  const db = {
    one: async (sql: string) => {
      if (/FROM organisation/.test(sql)) return { id: 1 };
      if (/meta->>'fee'/.test(sql)) return { fee: null };
      if (/FROM m_course/.test(sql)) return { code: 'ENG' };
      if (/FROM lead l/.test(sql)) return LEAD;
      return {};
    },
    query: async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      if (/FROM course_level/.test(sql)) return LEVELS;
      return [];
    },
    tx: async (fn: any) => fn({
      query: async (sql: string, params: unknown[] = []) => { issued.push({ sql, params }); return { rows: [{ id: 77 }] }; },
    }),
  };
  const resolver = { buildScopeWhere: () => '1=1' };
  const numbering = { allocateCoded: async () => 'ENG-2026-001' };
  const steps = opts.approvals ? [{ key: 'enrolment', label: 'Manager' }] : [];
  const approvals = {
    policy: async () => ({ enabled: !!opts.approvals, steps }),
    open: async () => undefined, notifyApprovers: async () => undefined,
  };
  const plans = { create: async (dto: any) => { planCalls.push(dto); return { id: 501, installments: 3 }; } };
  const svc = new EnrolmentService(db as never, resolver as never, numbering as never, approvals as never,
    undefined, undefined, undefined, plans as never);
  return { svc, issued, planCalls };
}

jest.mock('./approval.service', () => ({
  ApprovalService: class {},
  requiredSteps: (policy: any) => (policy?.enabled ? policy.steps : []),
}));

const PLAN = { plan_type: 'installment', frequency: 'monthly', num_installments: 3, down_payment_minor: 0, start_date: '2026-11-01' };

describe('Sale Closure with levels + instalment plan (client 3 Sep)', () => {
  it('two levels: total fee = Σ level fees, both level line-items and their history are written', async () => {
    const { svc, issued } = harness();
    await svc.create({ lead_id: 1, course_id: 5, levels: [{ course_level_id: 11 }, { course_level_id: 12 }], discount_scope: 'overall',
      discount_type: 'percent', discount_value: 10 }, { id: 1 }, {} as never);
    const ins = issued.find((q) => /INSERT INTO enrolment \(/.test(q.sql))!;
    expect(ins.params[11]).toBe(2200000);   // fee = ₹10,000 + ₹12,000
    expect(ins.params[12]).toBe(220000);    // 10% overall discount
    expect(ins.params[13]).toBe(1980000);   // net
    expect(issued.filter((q) => /INSERT INTO enrolment_level \(/.test(q.sql))).toHaveLength(2);
    expect(issued.filter((q) => /INSERT INTO enrolment_level_history/.test(q.sql))).toHaveLength(2);
  });

  it('per-level discount: one level by %, one by ₹ — each keeps its own discount type', async () => {
    const { svc, issued } = harness();
    await svc.create({ lead_id: 1, course_id: 5, discount_scope: 'level', levels: [
      { course_level_id: 11, discount_type: 'percent', discount_value: 10 },   // ₹1,000
      { course_level_id: 12, discount_type: 'amount', discount_value: 500 },   // ₹500
    ] }, { id: 1 }, {} as never);
    const ins = issued.find((q) => /INSERT INTO enrolment \(/.test(q.sql))!;
    expect(ins.params[12]).toBe(150000);
    expect(ins.params[13]).toBe(2050000);
    const lv = issued.filter((q) => /INSERT INTO enrolment_level \(/.test(q.sql));
    expect(lv[0].params[9]).toBe('percent');
    expect(lv[0].params[10]).toBe(10);
    expect(lv[1].params[9]).toBe('amount');
    expect(issued.some((q) => /SET discount_scope/.test(q.sql) && q.params[1] === 'level')).toBe(true);
  });

  it('an ACTIVE enrolment gets its instalment plan straight away', async () => {
    const { svc, planCalls } = harness();
    const r: any = await svc.create({ lead_id: 1, course_id: 5, levels: [{ code: 'A1' }], plan_setup: PLAN }, { id: 1 }, {} as never);
    expect(planCalls).toHaveLength(1);
    expect(planCalls[0]).toMatchObject({ ...PLAN, enrolment_id: 77 });
    expect(r.plan_id).toBe(501);
  });

  it('a sale awaiting approval HOLDS the plan on the enrolment instead of creating it', async () => {
    const { svc, planCalls, issued } = harness({ approvals: true });
    const r: any = await svc.create({ lead_id: 1, course_id: 5, levels: [{ code: 'A1' }], plan_setup: PLAN }, { id: 1 }, {} as never);
    expect(r.status).toBe('pending_approval');
    expect(r.plan_pending_approval).toBe(true);
    expect(planCalls).toHaveLength(0);
    expect(issued.some((q) => /SET plan_setup/.test(q.sql))).toBe(true);
  });
});
