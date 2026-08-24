import { PerformanceService } from './performance.service';
import { TargetDefService } from './target-def.service';

/* db double that records SQL and returns a canned actuals row. */
function tdefSvc(canned: any = {}) {
  const sql: string[] = [];
  const db = {
    query: async (q: string) => { sql.push(q); return []; },
    one: async (q: string) => {
      sql.push(q);
      if (/count\(\*\) FROM lead l/.test(q)) return canned;   // actuals()
      if (/FROM organisation/.test(q)) return { id: '1' };
      return null;
    },
    tx: async (fn: any) => fn({ query: async () => ({ rows: [{ id: '9' }], rowCount: 1 }) }),
  };
  const resolver = { buildScopeWhere: () => '1=1' };
  const incentive = { get: async () => null };
  return { svc: new TargetDefService(db as never, resolver as never, incentive as never), sql };
}

describe('target actuals — the six live metrics, attributed by Target-For', () => {
  const row = (target_for: string, ids: any) => ({
    target_for, period_start: '2026-08-01', period_end: '2026-09-01', ...ids,
  });

  it('a Counsellor target attributes leads/walk-ins/admissions/meetings to that user', async () => {
    const { svc, sql } = tdefSvc();
    await svc.actuals(row('user', { user_id: '7' }));
    const q = sql.join('\n');
    expect(q).toMatch(/l\.owner_id = \$1::bigint/);
    expect(q).toMatch(/w\.counsellor_id = \$1::bigint/);
    expect(q).toMatch(/e\.counsellor_id = \$1::bigint/);
    expect(q).toMatch(/ce\.owner_id = \$1::bigint/);
  });

  it('a Branch target attributes by branch_id on every metric', async () => {
    const { svc, sql } = tdefSvc();
    await svc.actuals(row('branch', { branch_id: '3' }));
    const q = sql.join('\n');
    expect(q).toMatch(/l\.branch_id = \$1::bigint/);
    expect(q).toMatch(/e\.branch_id = \$1::bigint/);
    expect(q).toMatch(/ce\.branch_id = \$1::bigint/);
  });

  it('a Course target joins meetings to the lead for the course column', async () => {
    const { svc, sql } = tdefSvc();
    await svc.actuals(row('course', { course_id: '4' }));
    const q = sql.join('\n');
    expect(q).toMatch(/l\.course_id = \$1::bigint/);
    expect(q).toMatch(/JOIN lead ml ON ml\.id = ce\.lead_id/);
    expect(q).toMatch(/ml\.course_id = \$1::bigint/);
  });

  it('ADMISSIONS count only ACTIVE enrolments and REVENUE is net_fee_minor (booked)', async () => {
    const { svc, sql } = tdefSvc();
    await svc.actuals(row('user', { user_id: '1' }));
    const q = sql.join('\n');
    expect(q).toMatch(/e\.status = 'active'/);
    expect(q).toMatch(/sum\(e\.net_fee_minor\)/);
    expect(q).toMatch(/sum\(fr\.amount_minor\)/); // collection from receipts
  });

  it('maps the canned counts/sums into numbers', async () => {
    const { svc } = tdefSvc({ leads: '12', walkins: '3', admissions: '5', revenue_minor: '5000000', collection_minor: '2500000', meetings: '4' });
    const a = await svc.actuals({ target_for: 'user', user_id: '1', period_start: '2026-08-01', period_end: '2026-09-01' });
    expect(a).toEqual({ leads: 12, walkins: 3, admissions: 5, revenue_minor: 5000000, collection_minor: 2500000, meetings: 4 });
  });
});

describe('saving a rich target — validation', () => {
  it('rejects an unknown Target-For', async () => {
    const { svc } = tdefSvc();
    await expect(svc.save({ name: 'x', target_for: 'galaxy' }, { id: 1 }, {} as never)).rejects.toThrow(/Target For/);
  });
  it('requires a name', async () => {
    const { svc } = tdefSvc();
    await expect(svc.save({ target_for: 'user', user_id: 1 }, { id: 1 }, {} as never)).rejects.toThrow(/name/);
  });
  it('requires at least one metric target', async () => {
    const { svc } = tdefSvc();
    await expect(svc.save(
      { name: 'Empty', target_for: 'branch', branch_id: 2, period_type: 'monthly', period_anchor: '2026-08-01' },
      { id: 1 }, { all: true } as never,
    )).rejects.toThrow(/at least one metric/);
  });
});

/* ==================== COUNSELLOR PERFORMANCE — Part 2 KPIs ==================== */

function perfSvc(rows: any[]) {
  const sql: string[] = [];
  const db = {
    query: async (q: string) => { sql.push(q); return rows; },
    one: async (q: string) => (/sum\(fr\.amount_minor\)/.test(q) ? { collected_minor: 0 } : null),
  };
  const resolver = { buildScopeWhere: () => '1=1' };
  return { svc: new PerformanceService(db as never, resolver as never), sql };
}

describe('Counsellor Performance leaderboard — Part 2 fields', () => {
  it('SQL selects leads_contacted and meetings', async () => {
    const { svc, sql } = perfSvc([]);
    await svc.leaderboard({} as never);
    const q = sql.join('\n');
    expect(q).toMatch(/AS leads_contacted/);
    expect(q).toMatch(/ce\.type = 'meeting'[\s\S]*?AS meetings/);
  });

  it('conversion % = enrolments / owned leads (one decimal) and adherence = ontime/due', async () => {
    const { svc } = perfSvc([{
      user_id: '5', user_name: 'A', leads: '10', enrolments: '3', revenue_minor: '0', collected_minor: '0',
      activities: '8', leads_contacted: '7', meetings: '2', followups_due: '4', followups_ontime: '3', tat_median_seconds: null,
    }]);
    const rows = await svc.leaderboard({} as never);
    expect(rows[0].conversion_pct).toBe(30);
    expect(rows[0].leads_contacted).toBe(7);
    expect(rows[0].meetings).toBe(2);
    expect(rows[0].adherence_pct).toBe(75);
  });

  it('a counsellor with nothing due shows adherence "—" (null), not 0%', async () => {
    const { svc } = perfSvc([{
      user_id: '5', user_name: 'A', leads: '1', enrolments: '0', revenue_minor: '0', collected_minor: '0',
      activities: '0', leads_contacted: '0', meetings: '0', followups_due: '0', followups_ontime: '0', tat_median_seconds: null,
    }]);
    const rows = await svc.leaderboard({} as never);
    expect(rows[0].adherence_pct).toBeNull();
  });

  it('summary applies the Branch/Vertical/Counsellor filter to the SQL', async () => {
    const { svc, sql } = perfSvc([]);
    await svc.summary({} as never, { branchId: 2, verticalId: 3, userId: 5 });
    const q = sql.join('\n');
    expect(q).toMatch(/l\.branch_id = \$/);
    expect(q).toMatch(/e\.vertical_id = \$/);
    expect(q).toMatch(/l\.owner_id = \$/);
  });
});
