import { ApprovalService, DEFAULT_APPROVALS, requiredSteps } from './approval.service';

/**
 * THE APPROVAL MODEL — pinned, because the client will be told "it is off by default"
 * and that sentence has to stay true.
 */

describe('the DEFAULT is OFF — §5 says "optional" and fixes no default', () => {
  it('ships disabled: a counsellor closes a sale and it is closed', () => {
    expect(DEFAULT_APPROVALS.enabled).toBe(false);
    expect(requiredSteps(DEFAULT_APPROVALS, { fee_minor: 5_000_000, discount_minor: 4_000_000 })).toEqual([]);
  });

  it('the master switch beats every step — off means off', () => {
    const p = { ...DEFAULT_APPROVALS, enabled: false, steps: DEFAULT_APPROVALS.steps.map((s) => ({ ...s, enabled: true })) };
    expect(requiredSteps(p, { fee_minor: 100, discount_minor: 100 })).toEqual([]);
  });

  it('a missing app_setting row behaves EXACTLY like the seeded default (fresh-DB parity)', () => {
    // the Sprint-3 lesson: a fresh database came up with no scoring rules
    expect(DEFAULT_APPROVALS.steps.map((s) => s.key)).toEqual(['closure', 'discount']);
    expect(DEFAULT_APPROVALS.steps.find((s) => s.key === 'closure')!.enabled).toBe(true);
    expect(DEFAULT_APPROVALS.steps.find((s) => s.key === 'discount')!.enabled).toBe(false);
  });
});

describe('when it is switched ON', () => {
  const on = { enabled: true, steps: DEFAULT_APPROVALS.steps.map((s) => ({ ...s })) };

  it('the closure step applies to every enrolment', () => {
    const steps = requiredSteps(on, { fee_minor: 4_500_000, discount_minor: 0 });
    expect(steps.map((s) => s.key)).toEqual(['closure']);
  });

  it('PER STEP: a disabled step does not fire even when the master switch is on', () => {
    const p = { enabled: true, steps: on.steps.map((s) => s.key === 'closure' ? { ...s, enabled: false } : s) };
    expect(requiredSteps(p, { fee_minor: 100, discount_minor: 0 }).map((s) => s.key)).toEqual([]);
  });

  it('the DISCOUNT step fires only ABOVE the threshold — and not AT it', () => {
    const p = {
      enabled: true,
      steps: on.steps.map((s) => s.key === 'discount' ? { ...s, enabled: true, discount_pct_over: 10 } : { ...s, enabled: false }),
    };
    // exactly 10% -> no approval. "Approval above 10%" must not fire at 10%.
    expect(requiredSteps(p, { fee_minor: 1_000_000, discount_minor: 100_000 }).map((s) => s.key)).toEqual([]);
    // 10.01% -> approval
    expect(requiredSteps(p, { fee_minor: 1_000_000, discount_minor: 100_100 }).map((s) => s.key)).toEqual(['discount']);
    // 0% -> no approval
    expect(requiredSteps(p, { fee_minor: 1_000_000, discount_minor: 0 }).map((s) => s.key)).toEqual([]);
  });

  it('a zero-fee enrolment does not divide by zero', () => {
    const p = { enabled: true, steps: on.steps.map((s) => s.key === 'discount' ? { ...s, enabled: true } : { ...s, enabled: false }) };
    expect(() => requiredSteps(p, { fee_minor: 0, discount_minor: 0 })).not.toThrow();
    expect(requiredSteps(p, { fee_minor: 0, discount_minor: 0 })).toEqual([]);
  });

  it('both steps can be required at once', () => {
    const p = { enabled: true, steps: on.steps.map((s) => ({ ...s, enabled: true, discount_pct_over: 10 })) };
    expect(requiredSteps(p, { fee_minor: 1_000_000, discount_minor: 500_000 }).map((s) => s.key))
      .toEqual(['closure', 'discount']);
  });
});

describe('the policy editor', () => {
  const svc = (policy = DEFAULT_APPROVALS) => {
    const settings = { get: async () => policy, set: jest.fn(async () => undefined) };
    return { s: new ApprovalService({} as never, settings as never, {} as never), settings };
  };

  it('refuses an unknown step — the policy is a fixed set, not free JSON', async () => {
    const { s } = svc();
    await expect(s.setPolicy({ steps: [{ key: 'invent_a_step', enabled: true }] }, 1)).rejects.toThrow(/Unknown approval step/);
  });

  it('refuses a nonsense discount threshold', async () => {
    const { s } = svc();
    await expect(s.setPolicy({ steps: [{ key: 'discount', discount_pct_over: 500 }] }, 1)).rejects.toThrow(/between 0 and 100/);
    await expect(s.setPolicy({ steps: [{ key: 'discount', discount_pct_over: -1 }] }, 1)).rejects.toThrow(/between 0 and 100/);
  });

  it('flipping the master switch is ONE settings write — no deploy', async () => {
    const { s, settings } = svc();
    const next = await s.setPolicy({ enabled: true }, 7);
    expect(next.enabled).toBe(true);
    expect(settings.set).toHaveBeenCalledWith('enrolment_approvals', expect.objectContaining({ enabled: true }), 7);
  });

  it('a step\'s LABEL and KEY are ours, not the client\'s — he toggles, he does not rename', async () => {
    const { s } = svc();
    const next = await s.setPolicy({ steps: [{ key: 'closure', enabled: false, label: 'Hacked', roles: ['Counsellor'] }] }, 1);
    const closure = next.steps.find((x) => x.key === 'closure')!;
    expect(closure.label).toBe('Enrolment closure');
    expect(closure.enabled).toBe(false);       // the toggle DID apply
  });
});

describe('self-approval is impossible', () => {
  it('the requester cannot decide his own request, even holding enrolment.approve', async () => {
    const db = {
      one: async () => ({ id: 5, status: 'pending', requested_by: 3, entity_type: 'enrolment', entity_id: 11 }),
      query: async () => [],
    };
    const resolver = { buildScopeWhere: () => '1=1' };
    const s = new ApprovalService(db as never, {} as never, resolver as never);
    await expect(s.decide(5, true, null, { id: 3 }, {} as never)).rejects.toThrow(/cannot approve your own enrolment/);
    // …but somebody else can
    await expect(s.decide(5, true, null, { id: 4 }, {} as never)).resolves.toEqual({
      entity_type: 'enrolment', entity_id: 11, approved: true,
    });
  });

  it('a request that was already decided cannot be decided again', async () => {
    const db = {
      one: async () => ({ id: 5, status: 'approved', requested_by: 3, entity_type: 'enrolment', entity_id: 11 }),
      query: async () => [],
    };
    const resolver = { buildScopeWhere: () => '1=1' };
    const s = new ApprovalService(db as never, {} as never, resolver as never);
    await expect(s.decide(5, false, null, { id: 4 }, {} as never)).rejects.toThrow(/already approved/);
  });
});
