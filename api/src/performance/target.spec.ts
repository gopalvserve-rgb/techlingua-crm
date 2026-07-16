import { PerformanceService } from './performance.service';
import { periodOf, pct, TargetService } from './target.service';

describe('the period is always the 1st — so "this month" is an equality test', () => {
  it('normalises any date in a month to its first', () => {
    expect(periodOf('2026-07-16')).toBe('2026-07-01');
    expect(periodOf('2026-07')).toBe('2026-07-01');
    expect(periodOf('2026-12-31')).toBe('2026-12-01');
  });
  it('defaults to the current month', () => {
    const now = new Date();
    expect(periodOf()).toBe(`${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`);
  });
  it('refuses a non-month', () => {
    expect(() => periodOf('not-a-month')).toThrow(/must be a month/);
  });
});

describe('percentage of target', () => {
  it('one decimal, and a zero target is 0% not Infinity', () => {
    expect(pct(5, 10)).toBe(50);
    expect(pct(1, 3)).toBe(33.3);
    expect(pct(12, 10)).toBe(120);        // over-achievement is REAL and is shown
    expect(pct(5, 0)).toBe(0);            // never Infinity / NaN on the dashboard
    expect(pct(0, 0)).toBe(0);
  });
});

const tsvc = (rows: unknown[] = [], one: unknown = null) => {
  const db = { query: async () => rows, one: async () => one };
  const resolver = { buildScopeWhere: () => '1=1' };
  return new TargetService(db as never, resolver as never);
};

describe('setting a target', () => {
  it('refuses a scope type that is not counsellor / branch / vertical', async () => {
    await expect(tsvc().save({ scope_type: 'galaxy' }, { id: 1 }, {} as never))
      .rejects.toThrow(/counsellor, a branch or a vertical/);
  });

  it('demands the thing the target is FOR', async () => {
    await expect(tsvc().save({ scope_type: 'user' }, { id: 1 }, {} as never)).rejects.toThrow(/Choose the counsellor/);
    await expect(tsvc().save({ scope_type: 'branch' }, { id: 1 }, {} as never)).rejects.toThrow(/Choose the branch/);
    await expect(tsvc().save({ scope_type: 'vertical' }, { id: 1 }, {} as never)).rejects.toThrow(/Choose the vertical/);
  });

  it('refuses an empty target — a target of nothing is not a target', async () => {
    await expect(tsvc().save({ scope_type: 'branch', branch_id: 9, enrolment_target: 0, revenue_target: '0' }, { id: 1 }, { all: true } as never))
      .rejects.toThrow(/Set an admissions target, a revenue target, or both/);
  });

  it('refuses junk money and fractional admissions', async () => {
    await expect(tsvc().save({ scope_type: 'branch', branch_id: 9, enrolment_target: 5, revenue_target: 'lots' }, { id: 1 }, { all: true } as never))
      .rejects.toThrow(/Revenue target.*not an amount/);
    await expect(tsvc().save({ scope_type: 'branch', branch_id: 9, enrolment_target: 2.5 }, { id: 1 }, { all: true } as never))
      .rejects.toThrow(/whole number/);
  });

  it('takes rupees and stores paise', async () => {
    const rows = [{ id: 1 }];
    const db = { query: async () => rows, one: async () => ({ id: 1 }) };
    let captured: unknown[] = [];
    const svc = new TargetService({
      ...db,
      query: async (_s: string, p: unknown[]) => { if (p?.length > 5) captured = p; return rows; },
    } as never, { buildScopeWhere: () => '1=1' } as never);
    await svc.save({ scope_type: 'branch', branch_id: 9, period: '2026-07', enrolment_target: 12, revenue_target: '5,00,000' }, { id: 1 }, { all: true } as never);
    expect(captured).toContain(50_000_000);      // ₹5,00,000 -> paise
    expect(captured).toContain('2026-07-01');
  });

  it('a manager CANNOT set a target outside the part of the org he manages', async () => {
    // scope.all = false and the VALUES probe says no, and the user has no assignment in scope
    const db = { query: async () => [], one: async (sql: string) => (/count\(\*\)/.test(sql) ? { n: 0 } : { ok: false }) };
    const svc = new TargetService(db as never, { buildScopeWhere: () => 'branch_id = 9' } as never);
    await expect(svc.save({ scope_type: 'branch', branch_id: 77, enrolment_target: 5 }, { id: 1 }, { all: false } as never))
      .rejects.toThrow(/outside the part of the organisation you manage/);
  });

  it('…but he CAN target a counsellor who sits inside his scope', async () => {
    const db = {
      query: async () => [{ id: 1 }],
      one: async (sql: string) => (/count\(\*\)/.test(sql) ? { n: 1 } : { ok: false }),
    };
    const svc = new TargetService(db as never, { buildScopeWhere: () => 'branch_id = 9' } as never);
    await expect(svc.save({ scope_type: 'user', user_id: 3, enrolment_target: 5 }, { id: 1 }, { all: false } as never))
      .resolves.toMatchObject({ id: 1 });
  });
});

describe('the dashboard bar means something different per role — and that is the point', () => {
  const rows = [
    { scope_type: 'user', user_id: 3, label: 'Asha Rao', actual_enrolments: 4, enrolment_target: 10, enrolment_pct: 40, actual_revenue_minor: 100, revenue_target_minor: 1000, revenue_pct: 10 },
    { scope_type: 'branch', branch_id: 9, label: 'Vikaspuri', actual_enrolments: 30, enrolment_target: 50, enrolment_pct: 60, actual_revenue_minor: 900, revenue_target_minor: 1000, revenue_pct: 90 },
  ];
  const svcWith = (list: unknown[]) => {
    const s = new TargetService({} as never, {} as never);
    (s as any).list = async () => list;
    return s;
  };

  it('a counsellor sees HIS OWN target — not his branch\'s (which teaches him nothing)', async () => {
    const out = await svcWith(rows).dashboard({} as never, 3);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe('Asha Rao');
    expect(out[0].enrolments).toEqual({ actual: 4, target: 10, pct: 40 });
  });

  it('a manager with no personal target sees every target in his scope', async () => {
    const out = await svcWith(rows).dashboard({} as never, 99);
    expect(out.map((r) => r.label)).toEqual(['Asha Rao', 'Vikaspuri']);
  });

  it('no targets = an empty array, which is the empty state — never a fake bar', async () => {
    expect(await svcWith([]).dashboard({} as never, 3)).toEqual([]);
  });
});

describe('counsellor performance', () => {
  const psvc = (rows: unknown[]) => {
    const db = { query: async () => rows };
    const resolver = { buildScopeWhere: () => '1=1' };
    return new PerformanceService(db as never, resolver as never);
  };
  const ROW = {
    user_id: 3, user_name: 'Asha Rao', leads: 20, enrolments: 5, revenue_minor: 22_500_000,
    collected_minor: 5_000_000, activities: 42, followups_due: 10, followups_ontime: 8,
    tat_median_seconds: 1_800,
  };

  it('computes conversion, adherence and TAT in the units the screen shows', async () => {
    const [r] = await psvc([ROW]).leaderboard({} as never);
    expect(r.conversion_pct).toBe(25);          // 5 / 20
    expect(r.adherence_pct).toBe(80);           // 8 / 10
    expect(r.tat_median_minutes).toBe(30);      // 1800s -> 30 min
  });

  it('does NOT cap conversion at 100% — closing last month\'s leads is real', async () => {
    const [r] = await psvc([{ ...ROW, leads: 2, enrolments: 5 }]).leaderboard({} as never);
    expect(r.conversion_pct).toBe(250);
  });

  it('adherence with nothing due is null ("—"), not 0% and not 100%', async () => {
    const [r] = await psvc([{ ...ROW, followups_due: 0, followups_ontime: 0 }]).leaderboard({} as never);
    expect(r.adherence_pct).toBeNull();
  });

  it('a counsellor with no leads is 0% conversion, not NaN', async () => {
    const [r] = await psvc([{ ...ROW, leads: 0, enrolments: 0 }]).leaderboard({} as never);
    expect(r.conversion_pct).toBe(0);
  });

  it('no TAT data is null, not 0 minutes (which would read as "instant")', async () => {
    const [r] = await psvc([{ ...ROW, tat_median_seconds: null }]).leaderboard({} as never);
    expect(r.tat_median_minutes).toBeNull();
  });

  it('BOOKED revenue and COLLECTED cash are separate numbers — conflating them is the lie', async () => {
    const [r] = await psvc([ROW]).leaderboard({} as never);
    expect(r.revenue_minor).toBe(22_500_000);
    expect(r.collected_minor).toBe(5_000_000);
    expect(r.revenue_minor).not.toBe(r.collected_minor);
  });

  it('the summary totals the same rows the leaderboard shows', async () => {
    const s = await psvc([ROW, { ...ROW, user_id: 4, user_name: 'Ravi', leads: 10, enrolments: 1, revenue_minor: 1_000, collected_minor: 500 }])
      .summary({} as never);
    expect(s.counsellors).toBe(2);
    expect(s.leads).toBe(30);
    expect(s.enrolments).toBe(6);
    expect(s.conversion_pct).toBe(20);
    expect(s.revenue_minor).toBe(22_501_000);
    expect(s.best).toEqual({ user_name: 'Asha Rao', enrolments: 5 });
  });

  it('an empty scope is an empty leaderboard, not a crash', async () => {
    const s = await psvc([]).summary({} as never);
    expect(s).toMatchObject({ counsellors: 0, leads: 0, enrolments: 0, conversion_pct: 0, best: null });
  });
});
