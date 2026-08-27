import { DuesService } from './dues.service';

/**
 * DEF-3 (dev/104) — a multi-level / full-payment enrolment with an outstanding balance but NO
 * installment plan must STILL appear in Fee Management dues. Two things made these invisible:
 *   (a) the dues CTE INNER-joined `lead`, so a directly-added student's (lead-less) enrolment was
 *       dropped entirely — now it's a LEFT JOIN with a student-profile name/phone/email fallback;
 *   (b) the "unplanned" branch already existed (dev/50) — this locks in that it keys off
 *       net_fee_minor − paid > 0 for an active enrolment with no active payment_plan, which is
 *       exactly a "Full payment, no first-due-date" enrolment.
 * The list() SQL string is asserted (the CTE is what the DB runs).
 */
function capture() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    async query(sql: string, params: unknown[]) { calls.push({ sql, params }); return []; },
    async one() { return {}; },
  };
  const resolver = { buildScopeWhere: () => 'TRUE' };
  const svc = new DuesService(db as never, resolver as never, {} as never, {} as never);
  return { svc, calls };
}
const SCOPE = {} as never;

describe('DuesService — DEF-3 lead-less / full-payment outstanding enrolments are included', () => {
  it('joins lead as a LEFT JOIN (not INNER) so a lead-less enrolment is not dropped', async () => {
    const { svc, calls } = capture();
    await svc.list(SCOPE, {});
    const sql = calls[0].sql;
    expect(sql).toMatch(/LEFT JOIN lead l ON l\.id = e\.lead_id/);
    expect(sql).not.toMatch(/\n\s*JOIN lead l ON l\.id = e\.lead_id/); // no bare INNER join to lead
  });

  it('falls back to the student profile for name/phone/email when there is no lead', async () => {
    const { svc, calls } = capture();
    await svc.list(SCOPE, {});
    const sql = calls[0].sql;
    expect(sql).toMatch(/LEFT JOIN student sp ON sp\.id = e\.student_profile_id/);
    expect(sql).toMatch(/COALESCE\(l\.full_name, sp\.full_name\) AS student_name/);
  });

  it('the unplanned branch surfaces an active enrolment with outstanding > 0 and no active plan', async () => {
    const { svc, calls } = capture();
    await svc.list(SCOPE, {});
    const sql = calls[0].sql;
    // the "unplanned" source exists and is gated on no-active-plan + a positive collectible balance.
    // dev/140 item 3 — the collectible now includes the exam fee (Net + Exam − Paid), so it stays due
    // until the exam fee is collected too.
    expect(sql).toMatch(/'unplanned'::text AS source/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM payment_plan pp/);
    expect(sql).toMatch(/\(\(e\.net_fee_minor \+ COALESCE\(e\.exam_fee_minor, 0\)\) - COALESCE\(pr\.paid_minor, 0\)\) > 0/);
    // and it carries the level breakdown (multi-level enrolments show their Level column)
    expect(sql).toMatch(/string_agg\(el\.code/);
  });
});
