import { readFileSync } from 'fs';
import { join } from 'path';
import { DashboardService } from '../dashboard/dashboard.service';
import { PerformanceService } from '../performance/performance.service';
import { StandardReportService } from './standard.service';
import { ReportService } from './report.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { DatabaseService } from '../database/database.service';
import { RbacDataService } from '../rbac/rbac-data.service';
import { ResolvedScope } from '../rbac/rbac.types';
import {
  leadWonConversionPct, counsellorConversionPct,
  CONVERSION_LABEL_LEAD_WON, CONVERSION_LABEL_COUNSELLOR,
} from './shared-metrics';
import { entityByKey } from './entities';
import {
  ENROLMENT_COUNTS_AS_SOLD, ENROLMENT_REVENUE_COLUMN, STAGE_COUNT_FROM, STAGE_COUNT_LIVE,
} from './shared-metrics';

/**
 * =============================================================================
 * THE REPORTS AND THE DASHBOARD AGREE. THIS TEST IS WHY.
 * =============================================================================
 *
 * It exists because of DEF-S5-03, and the brief names it explicitly:
 *
 *     "/fees/summary said Rs 50,000 while /performance/summary said Rs 0."
 *
 * Nothing was broken in either query. Two screens had each written their own idea of
 * "collected", and they disagreed. The client — reasonably — stopped trusting both.
 *
 * Sprint 6 adds six more readers of the same numbers. So the definitions now live in
 * shared-metrics.ts as CONSTANTS, and this file asserts, on the SQL each service actually
 * emits, that they all use them. You cannot make the funnel report and the dashboard
 * disagree without deleting a test that says in words that they must not.
 *
 * Two layers, because one is not enough:
 *
 *   LAYER 1 (behavioural) — capture the real SQL each service emits against a db double
 *   and prove the counting cores are IDENTICAL, and that the scope fragment is in both.
 *
 *   LAYER 2 (structural) — read the source and prove nobody has re-hardcoded a
 *   definition next to the constant. A constant that is imported and then ignored is
 *   worse than no constant, because it looks safe.
 */

const scope = (over: Partial<ResolvedScope>): ResolvedScope => ({
  permissionKey: 'lead.read', allowed: true, all: false, filters: [],
  allowedFields: null, deniedFields: [], ...over,
});
const OWN = scope({ filters: [{ kind: 'own', userId: 3 }] });
const ADMIN = scope({ all: true });

/** A db double that RECORDS every statement and answers with harmless empties. */
class SqlRecorder {
  readonly sql: string[] = [];
  readonly params: unknown[][] = [];
  async query(sql: string, params: unknown[] = []) { this.sql.push(sql); this.params.push(params); return []; }
  async one(sql: string, params: unknown[] = []) { this.sql.push(sql); this.params.push(params); return null; }
  async tx(fn: any) { return fn({ query: async () => ({ rows: [] }) }); }
  find(re: RegExp) { return this.sql.find((s) => re.test(s)); }
}

const resolver = new ScopeResolverService();

/** Normalise whitespace so a reformat does not fail a semantic test. */
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('LAYER 1 — the dashboard funnel and the funnel REPORT count the same leads', () => {
  const dashDb = new SqlRecorder();
  const rptDb = new SqlRecorder();

  const dash = new DashboardService(dashDb as unknown as DatabaseService, resolver);
  const grants = { loadUserGrants: async () => ({ userId: 3, assignments: [], rolePermissions: [], teamIds: [] }) };
  const reports = new ReportService(rptDb as unknown as DatabaseService, grants as unknown as RbacDataService, resolver);
  // scopeFor is what run() uses to resolve the RUNNER's scope; pin it so the two
  // services are asked the same question.
  jest.spyOn(reports, 'scopeFor').mockResolvedValue(ADMIN);
  const standard = new StandardReportService(rptDb as unknown as DatabaseService, resolver, reports);

  beforeAll(async () => {
    await dash.overview(ADMIN, 3).catch(() => undefined);
    await standard.funnel({ id: 3 }).catch(() => undefined);
  });

  // The FUNNEL query is the one that GROUPs by stage. The dashboard also LEFT JOINs
  // pipeline_stage for its KPI strip (won/lost counters), which is a different question
  // and correctly a different query — so match on the grouping, not on the join.
  const STAGE_GROUP = /GROUP BY st\./;

  it('both emit a stage-count query', () => {
    expect(dashDb.find(STAGE_GROUP)).toBeTruthy();
    expect(rptDb.find(STAGE_GROUP)).toBeTruthy();
  });

  /**
   * THE ASSERTION. Both queries' FROM and live-row predicate are the SAME TEXT, because
   * both are the same imported constant. Change one, and this goes red.
   */
  it('the FROM clause and the live-row predicate are BYTE-IDENTICAL in both', () => {
    const d = dashDb.find(STAGE_GROUP)!;
    const r = rptDb.find(STAGE_GROUP)!;
    for (const q of [d, r]) {
      expect(norm(q)).toContain(norm(STAGE_COUNT_FROM));
      expect(norm(q)).toContain(norm(STAGE_COUNT_LIVE));
    }
  });

  it('neither counts a DELETED or an INACTIVE lead — the definition the dashboard has always used', () => {
    for (const q of [dashDb.find(STAGE_GROUP)!, rptDb.find(STAGE_GROUP)!]) {
      expect(q).toContain('l.is_active');
      expect(q).toContain('l.deleted_at IS NULL');
    }
  });
});

describe('LAYER 1 — the counsellor scope reaches BOTH', () => {
  it('a counsellor asking the dashboard and asking the funnel report both get `l.owner_id = $n`', async () => {
    const dashDb = new SqlRecorder();
    const rptDb = new SqlRecorder();
    const dash = new DashboardService(dashDb as unknown as DatabaseService, resolver);
    const grants = { loadUserGrants: async () => ({ userId: 3, assignments: [], rolePermissions: [], teamIds: [] }) };
    const reports = new ReportService(rptDb as unknown as DatabaseService, grants as unknown as RbacDataService, resolver);
    jest.spyOn(reports, 'scopeFor').mockResolvedValue(OWN);
    const standard = new StandardReportService(rptDb as unknown as DatabaseService, resolver, reports);

    await dash.overview(OWN, 3).catch(() => undefined);
    await standard.funnel({ id: 3 }).catch(() => undefined);

    expect(dashDb.find(/GROUP BY st\./)).toMatch(/l\.owner_id = \$\d+/);
    expect(rptDb.find(/GROUP BY st\./)).toMatch(/l\.owner_id = \$\d+/);
    expect(dashDb.params.flat()).toContain(3);
    expect(rptDb.params.flat()).toContain(3);
  });
});

describe('LAYER 1 — booked revenue means the same thing to PerformanceService and to campaign ROI', () => {
  it('both restrict to `status = \'active\'` and both sum `net_fee_minor`', async () => {
    const perfDb = new SqlRecorder();
    const perf = new PerformanceService(perfDb as unknown as DatabaseService, resolver);
    await perf.leaderboard(ADMIN).catch(() => undefined);
    const perfSql = perfDb.find(/scoped_enr/)!;
    expect(perfSql).toContain(ENROLMENT_COUNTS_AS_SOLD);
    expect(perfSql).toContain(ENROLMENT_REVENUE_COLUMN);

    // the campaigns entity's `revenue` column — the ROI screen and any user-built
    // campaign report both read THIS definition, not one of their own.
    const revenue = entityByKey('campaigns')!.columns.find((c) => c.key === 'revenue')!;
    expect(revenue.sql).toContain(ENROLMENT_COUNTS_AS_SOLD);
    expect(revenue.sql).toContain(ENROLMENT_REVENUE_COLUMN);
    expect(revenue.sql).toContain('deleted_at IS NULL');
  });

  /**
   * A `pending_approval` enrolment "counts for nothing and takes no money until a manager
   * approves" (decision #41). A report that counted it would show the client money he has
   * not sold — and it would disagree with his dashboard, which is how trust goes.
   */
  it('NOTHING counts a pending_approval enrolment as revenue', () => {
    const revenue = entityByKey('campaigns')!.columns.find((c) => c.key === 'revenue')!;
    const enrolments = entityByKey('enrolments')!.columns.find((c) => c.key === 'net_fee')!;
    expect(revenue.sql).not.toContain('pending_approval');
    expect(revenue.sql).toContain("status = 'active'");
    // the `enrolments` entity shows `status` as a COLUMN so the client can filter it
    // himself — the aggregate is what must not silently include it.
    expect(entityByKey('enrolments')!.columns.some((c) => c.key === 'status')).toBe(true);
    expect(enrolments.sql).toBe('e.net_fee_minor');
  });

  /** The `collected` column must be a CORRELATED SUM, not a join. A join multiplies
   *  `net_fee` by the number of receipts, and the report claims three times the revenue.  */
  it('`collected` is a correlated subquery, so a 3-instalment enrolment is not counted 3x', () => {
    const collected = entityByKey('enrolments')!.columns.find((c) => c.key === 'collected')!;
    expect(collected.sql).toMatch(/^\(SELECT COALESCE\(sum\(fr\.amount_minor\), 0\) FROM fee_receipt fr WHERE fr\.enrolment_id = e\.id/);
    expect(entityByKey('enrolments')!.from).not.toMatch(/JOIN\s+fee_receipt/i);
  });
});

describe('LAYER 2 — nobody has re-hardcoded a definition next to the constant', () => {
  const read = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8');

  it('dashboard.service.ts uses the shared constants, not its own stage-count SQL', () => {
    const src = read('dashboard/dashboard.service.ts');
    expect(src).toContain("from '../reports/shared-metrics'");
    expect(src).toContain('${STAGE_COUNT_FROM}');
    expect(src).toContain('${STAGE_COUNT_LIVE}');
    // and the old hardcoded copy is gone
    expect(src).not.toMatch(/FROM lead l JOIN pipeline_stage st ON st\.id = l\.stage_id\s*\n\s*WHERE \(\$\{w2\}\) AND l\.is_active AND l\.deleted_at IS NULL/);
  });

  it('performance.service.ts uses the shared revenue constants', () => {
    const src = read('performance/performance.service.ts');
    expect(src).toContain("from '../reports/shared-metrics'");
    expect(src).toContain('${ENROLMENT_COUNTS_AS_SOLD}');
    expect(src).toContain('${ENROLMENT_REVENUE_COLUMN}');
  });

  it('standard.service.ts uses the shared constants', () => {
    const src = read('reports/standard.service.ts');
    expect(src).toContain("from './shared-metrics'");
    expect(src).toContain('${STAGE_COUNT_FROM}');
    expect(src).toContain('${SLA_FIRST_RESPONSE_METRIC}');
  });

  /**
   * THE STRUCTURAL RULE: the ROI screen does not have its own query. It calls the report
   * builder on the `campaigns` entity, so "cost per lead" is defined exactly once. Two
   * implementations of CPL is the DEF-S5-03 shape, and this is how it is prevented rather
   * than fixed afterwards.
   */
  it('the ROI screen RUNS THE REPORT BUILDER — it does not have a second query', () => {
    const src = read('reports/standard.service.ts');
    const roi = src.slice(src.indexOf('async roi('));
    expect(roi).toContain('this.reports.execute(entity');
    expect(roi).not.toMatch(/SELECT[\s\S]{0,200}FROM campaign/i);
  });

  it('NOTHING outside shared-metrics.ts and the entity registry hardcodes "status = \'active\'" for revenue', () => {
    const suspects = ['dashboard/dashboard.service.ts', 'performance/performance.service.ts', 'reports/standard.service.ts'];
    for (const f of suspects) {
      const src = read(f);
      // The constant expands to it — so the literal must not ALSO appear as text.
      const literal = (src.match(/status = 'active'/g) ?? []).length;
      expect({ file: f, hardcoded: literal }).toEqual({ file: f, hardcoded: 0 });
    }
  });
});

describe('the TAT report reads the SPRINT-3 clocks, not a new measurement', () => {
  it('first response is lead_sla.elapsed_seconds, and time-in-stage is lead_stage_tat.seconds', async () => {
    const db = new SqlRecorder();
    const grants = { loadUserGrants: async () => ({ userId: 3, assignments: [], rolePermissions: [], teamIds: [] }) };
    const reports = new ReportService(db as unknown as DatabaseService, grants as unknown as RbacDataService, resolver);
    jest.spyOn(reports, 'scopeFor').mockResolvedValue(ADMIN);
    const standard = new StandardReportService(db as unknown as DatabaseService, resolver, reports);
    await standard.tat({ id: 3 }).catch(() => undefined);

    const fr = db.find(/lead_sla sla/)!;
    expect(fr).toContain("sla.metric = 'first_response'");
    expect(fr).toContain('sla.elapsed_seconds');

    const stage = db.find(/lead_stage_tat t/)!;
    expect(stage).toContain('t.seconds IS NOT NULL');   // only stages the lead has LEFT
    expect(stage).not.toContain('first_response_minutes');   // a column that has never existed
  });

  it('MEDIAN, not mean, is what percentile_disc computes — and both are reported', async () => {
    const db = new SqlRecorder();
    const grants = { loadUserGrants: async () => ({ userId: 3, assignments: [], rolePermissions: [], teamIds: [] }) };
    const reports = new ReportService(db as unknown as DatabaseService, grants as unknown as RbacDataService, resolver);
    jest.spyOn(reports, 'scopeFor').mockResolvedValue(ADMIN);
    const standard = new StandardReportService(db as unknown as DatabaseService, resolver, reports);
    await standard.tat({ id: 3 }).catch(() => undefined);
    const fr = db.find(/lead_sla sla/)!;
    expect(fr).toContain('percentile_disc(0.5)');
    expect(fr).toContain('avg(');
  });
});

/**
 * =============================================================================
 * OBS-S16-05 — THE CLIENT MUST NOT SEE THREE DIFFERENT CONVERSION RATES.
 * =============================================================================
 *
 * QA-16: funnel 50%, Counsellor Performance 100%, dashboard rounded differently — all
 * correct, all different, and `conversion_pct` was NOT in shared-metrics.ts despite
 * `docs/dev/08` §2 claiming it was. Two independent definitions that happened to agree
 * is the DEF-S5-03 shape without the bug. These tests make the drift impossible.
 */
describe('conversion % — two questions, two names, one definition each', () => {
  it('the dashboard and the funnel report call THE SAME FUNCTION (they cannot disagree)', () => {
    const dash = readFileSync(join(__dirname, '..', 'dashboard', 'dashboard.service.ts'), 'utf8');
    const funnel = readFileSync(join(__dirname, 'standard.service.ts'), 'utf8');
    for (const src of [dash, funnel]) {
      expect(src).toContain('leadWonConversionPct');
      expect(src).toContain('shared-metrics');
    }
    // and neither has kept a hand-rolled copy of the arithmetic
    for (const src of [dash, funnel]) {
      expect(/Math\.round\(\(?\s*won\s*[*/]/.test(src)).toBe(false);
    }
  });

  it('THE BUG QA-16 WOULD HAVE FOUND NEXT: the dashboard used to round to a whole number', () => {
    // 1 won of 3 leads. The old dashboard said 33; the funnel said 33.3. Same question,
    // same moment, two answers — which is exactly the complaint DEF-S5-03 generated.
    expect(leadWonConversionPct(1, 3)).toBe(33.3);
    expect(Math.round((1 / 3) * 100)).toBe(33);          // <- what the dashboard used to do
    expect(leadWonConversionPct(2, 4)).toBe(50);
    expect(leadWonConversionPct(0, 0)).toBe(0);          // no leads is 0%, not NaN
  });

  it('counsellor conversion is a DIFFERENT question and is allowed to differ', () => {
    // QA-16's live numbers: 4 leads, 2 won, but only 2 leads OWNED by a counsellor.
    expect(leadWonConversionPct(2, 4)).toBe(50);
    expect(counsellorConversionPct(2, 2)).toBe(100);
    // ...and it is NOT capped: a counsellor may close last month's leads this month.
    expect(counsellorConversionPct(3, 2)).toBe(150);
  });

  it('the two are LABELLED differently, so 50% and 100% are not both called "Conversion"', () => {
    expect(CONVERSION_LABEL_LEAD_WON).not.toBe(CONVERSION_LABEL_COUNSELLOR);
    expect(CONVERSION_LABEL_LEAD_WON).toMatch(/lead/i);
    expect(CONVERSION_LABEL_COUNSELLOR).toMatch(/counsellor/i);
  });

  it('PerformanceService uses the counsellor definition, not the lead→won one', () => {
    const perf = readFileSync(join(__dirname, '..', 'performance', 'performance.service.ts'), 'utf8');
    expect(perf).toContain('counsellorConversionPct');
    expect(perf).not.toContain('leadWonConversionPct');
  });
});
