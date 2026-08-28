import { EnrolmentService } from './enrolment.service';

/** dev/143 item 3 REDO — the Record-payment search (GET /enrolments?status=active&q=…) must find
 *  by enrolment no, student name OR phone, and phone must match ignoring formatting. */
describe('EnrolmentService.list — record-payment search', () => {
  function make() {
    let lastSql = ''; let lastParams: any[] = [];
    const db = { query: async (sql: string, params: any[]) => { lastSql = sql; lastParams = params; return []; } };
    const resolver = { buildScopeWhere: (_s: any, _c: any, _p: any[]) => 'TRUE' };
    const svc = new EnrolmentService(db as any, resolver as any, {} as any, {} as any);
    return { svc, sql: () => lastSql, params: () => lastParams };
  }

  it('a text query searches enrolment_no / student name (ILIKE) + phone on DIGITS-ONLY', async () => {
    const h = make();
    await h.svc.list({} as any, { status: 'active', q: '98765 43210' });
    const sql = h.sql();
    expect(sql).toMatch(/e\.enrolment_no ILIKE/);
    expect(sql).toMatch(/l\.full_name ILIKE/);
    // phone compared digits-only on both sides so a formatted stored number still matches
    expect(sql).toMatch(/regexp_replace\(COALESCE\(l\.phone/);
    expect(h.params()).toContain('%9876543210%');
  });

  it('a non-numeric query still matches enrolment_no / name (no phone digits branch)', async () => {
    const h = make();
    await h.svc.list({} as any, { q: 'Asha' });
    expect(h.sql()).toMatch(/e\.enrolment_no ILIKE .* OR l\.full_name ILIKE .* OR l\.phone ILIKE/);
    expect(h.params()).toContain('%Asha%');
  });

  it('the list projects branch_name / vertical_name / course_type for the modal breadcrumb + course type', async () => {
    const h = make();
    await h.svc.list({} as any, {});
    expect(h.sql()).toMatch(/b\.name AS branch_name/);
    expect(h.sql()).toMatch(/v\.name AS vertical_name/);
    expect(h.sql()).toMatch(/e\.course_type/);
  });
});
