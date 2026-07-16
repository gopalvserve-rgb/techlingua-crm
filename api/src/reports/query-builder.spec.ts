import { BadRequestException } from '@nestjs/common';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { REPORT_ENTITIES, entityByKey, isGroupable } from './entities';
import { buildReportQuery, presetWindow } from './query-builder';

/**
 * =============================================================================
 * THE SECURITY TESTS FOR THE REPORT BUILDER.
 * =============================================================================
 *
 * The Report Builder is the single biggest security surface in Sprint 6: the user
 * describes a query and the server runs it. Two things must be true, forever:
 *
 *   1. NOTHING THE CLIENT SENDS EVER BECOMES SQL. Every value is a `$n`.
 *   2. THE RUNNER'S SCOPE IS IN THE WHERE CLAUSE. Always. Not "usually", not
 *      "when the report is not shared".
 *
 * These are testable ONLY because the builder is pure — it returns the statement as a
 * value instead of executing it. That is the DEF-S5-02 lesson applied in advance: when
 * the receipt-balance arithmetic lived inside a SQL string, no unit test could reach it,
 * and 1047 green tests were structurally incapable of noticing a false financial
 * document. So the SQL is a value here, and these tests read it.
 */

const resolver = new ScopeResolverService();

const scope = (over: Partial<ResolvedScope>): ResolvedScope => ({
  permissionKey: 'lead.read', allowed: true, all: false, filters: [],
  allowedFields: null, deniedFields: [], ...over,
});
const OWN = scope({ filters: [{ kind: 'own', userId: 3 }] });
const BRANCH = scope({ filters: [{ kind: 'branch', branchId: 9 }] });
const ADMIN = scope({ all: true });
const DENIED = scope({ allowed: false });

const leads = entityByKey('leads')!;

describe('SCOPE IS IN THE WHERE CLAUSE — the crux', () => {
  it("a counsellor's own-scope becomes `l.owner_id = $n`, inside WHERE", () => {
    const q = buildReportQuery(leads, { columns: ['full_name'] }, OWN, resolver);
    expect(q.sql).toMatch(/WHERE[\s\S]*l\.owner_id = \$\d+/);
    expect(q.params).toContain(3);
  });

  it("a branch manager's scope becomes `l.branch_id = $n`", () => {
    const q = buildReportQuery(leads, { columns: ['full_name'] }, BRANCH, resolver);
    expect(q.sql).toMatch(/l\.branch_id = \$\d+/);
    expect(q.params).toContain(9);
  });

  it('an admin gets 1=1 — and NOT a hand-rolled fragment', () => {
    const q = buildReportQuery(leads, { columns: ['full_name'] }, ADMIN, resolver);
    expect(q.sql).toContain('1=1');
    expect(q.sql).not.toMatch(/owner_id = \$/);
  });

  it('NO PERMISSION => 1=0. The failure direction is DENY, never open', () => {
    const q = buildReportQuery(leads, { columns: ['full_name'] }, DENIED, resolver);
    expect(q.sql).toContain('1=0');
    expect(q.sql).not.toContain('1=1');
  });

  /**
   * THE ONE THAT MATTERS MOST. A shared report is just a definition; the scope comes
   * from whoever runs it. So the SAME config, run by two people, must produce two
   * different WHERE clauses. If this ever fails, a shared report leaks.
   */
  it('THE SAME saved report produces a DIFFERENT WHERE for a different runner', () => {
    const config = { columns: ['full_name', 'owner'], filters: [] };
    const asCounsellor = buildReportQuery(leads, config, OWN, resolver);
    const asAdmin = buildReportQuery(leads, config, ADMIN, resolver);
    expect(asCounsellor.sql).not.toEqual(asAdmin.sql);
    expect(asCounsellor.sql).toMatch(/l\.owner_id = \$\d+/);
    expect(asAdmin.sql).not.toMatch(/l\.owner_id = \$\d+/);
  });

  it('EVERY entity puts its scope in the WHERE — not just leads', () => {
    for (const e of REPORT_ENTITIES) {
      const q = buildReportQuery(e, { columns: [e.columns[1].key] }, DENIED, resolver);
      expect({ entity: e.key, denied: q.sql.includes('1=0') }).toEqual({ entity: e.key, denied: true });
    }
  });

  it('the soft-delete predicate is ALWAYS on, on every entity', () => {
    for (const e of REPORT_ENTITIES) {
      const q = buildReportQuery(e, { columns: [e.columns[1].key] }, ADMIN, resolver);
      for (const w of e.where) expect({ entity: e.key, sql: q.sql }).toEqual({ entity: e.key, sql: expect.stringContaining(w) });
    }
  });
});

describe('NOTHING FROM THE REQUEST BECOMES SQL', () => {
  it('a filter value is a parameter, never text in the statement', () => {
    const q = buildReportQuery(leads, {
      columns: ['full_name'],
      filters: [{ col: 'full_name', op: 'contains', value: "Robert'); DROP TABLE lead;--" }],
    }, ADMIN, resolver);
    expect(q.sql).not.toContain('DROP TABLE');
    expect(q.sql).toMatch(/ILIKE \$\d+/);
    expect(q.params).toContain("%Robert'); DROP TABLE lead;--%");
  });

  it('an UNKNOWN COLUMN is a 400 that names it — never a query', () => {
    expect(() => buildReportQuery(leads, { columns: ['(SELECT password_hash FROM "user")'] }, ADMIN, resolver))
      .toThrow(BadRequestException);
    expect(() => buildReportQuery(leads, { columns: ['nope'] }, ADMIN, resolver))
      .toThrow(/Unknown column "nope"/);
  });

  it('an unknown FILTER column, GROUP BY column, SORT column and DATE FIELD are all 400s', () => {
    const bad = { col: 'x; DELETE FROM lead', op: 'eq' as const, value: 1 };
    expect(() => buildReportQuery(leads, { columns: ['full_name'], filters: [bad] }, ADMIN, resolver)).toThrow(BadRequestException);
    expect(() => buildReportQuery(leads, { columns: ['full_name'], group_by: ['evil'] }, ADMIN, resolver)).toThrow(BadRequestException);
    expect(() => buildReportQuery(leads, { columns: ['full_name'], sort: [{ col: 'evil' }] }, ADMIN, resolver)).toThrow(BadRequestException);
    expect(() => buildReportQuery(leads, { columns: ['full_name'], date_field: 'evil', date_preset: 'today' }, ADMIN, resolver)).toThrow(BadRequestException);
  });

  it('an unknown OPERATOR is a 400', () => {
    expect(() => buildReportQuery(leads, {
      columns: ['full_name'], filters: [{ col: 'full_name', op: 'or 1=1 --' as any, value: 'x' }],
    }, ADMIN, resolver)).toThrow(BadRequestException);
  });

  it('the SORT DIRECTION cannot be injected — it is matched to one of two literals', () => {
    const q = buildReportQuery(leads, {
      columns: ['full_name'], sort: [{ col: 'full_name', dir: 'asc; DROP TABLE lead' as any }],
    }, ADMIN, resolver);
    expect(q.sql).not.toContain('DROP');
    expect(q.sql).toMatch(/ORDER BY l\.full_name DESC NULLS LAST/);   // anything not 'asc' is DESC
  });

  it('a date field only accepts a DATE-WINDOW column of that entity', () => {
    // `full_name` is a real column, so `requireColumn` passes — the SECOND check
    // (is it a declared date window?) is what stops it. Both are needed.
    expect(() => buildReportQuery(leads, { columns: ['full_name'], date_field: 'full_name', date_preset: 'today' }, ADMIN, resolver))
      .toThrow(/is not a date window/);
  });

  it('LIKE metacharacters in the search text are ESCAPED — searching "50%" finds "50%"', () => {
    const q = buildReportQuery(leads, {
      columns: ['full_name'], filters: [{ col: 'full_name', op: 'contains', value: '50%_x' }],
    }, ADMIN, resolver);
    expect(q.params).toContain('%50\\%\\_x%');
  });

  it('the LIMIT is clamped — a client cannot ask for the whole database in one request', () => {
    const q = buildReportQuery(leads, { columns: ['full_name'], limit: 9_999_999 }, ADMIN, resolver);
    expect(q.sql).toContain('LIMIT 50000');
    const q2 = buildReportQuery(leads, { columns: ['full_name'], limit: -5 }, ADMIN, resolver);
    expect(q2.sql).toMatch(/LIMIT \d+/);
    expect(q2.sql).not.toContain('LIMIT -5');
  });

  it('an `in` filter passes a real array parameter, not a joined string', () => {
    const q = buildReportQuery(leads, {
      columns: ['full_name'], filters: [{ col: 'temperature', op: 'in', value: ['hot', "warm') OR 1=1--"] }],
    }, ADMIN, resolver);
    expect(q.sql).toMatch(/= ANY\(\$\d+::text\[\]\)/);
    expect(q.params).toContainEqual(['hot', "warm') OR 1=1--"]);
    expect(q.sql).not.toContain('OR 1=1');
  });
});

describe('money filters are in RUPEES on the wire and PAISE in the query', () => {
  it('"net fee at least 50000" becomes 5000000 paise', () => {
    const enr = entityByKey('enrolments')!;
    const q = buildReportQuery(enr, {
      columns: ['enrolment_no'], filters: [{ col: 'net_fee', op: 'gte', value: 50000 }],
    }, ADMIN, resolver);
    expect(q.params).toContain(5_000_000);
  });

  it('a non-numeric money filter is a readable 400, not NaN in the SQL', () => {
    const enr = entityByKey('enrolments')!;
    expect(() => buildReportQuery(enr, {
      columns: ['enrolment_no'], filters: [{ col: 'net_fee', op: 'gte', value: 'lots' }],
    }, ADMIN, resolver)).toThrow(/needs a number/);
  });
});

describe('the date window', () => {
  const NOW = new Date('2026-07-16T18:30:00Z');

  it.each([
    ['today', '2026-07-16', '2026-07-17'],
    ['yesterday', '2026-07-15', '2026-07-16'],
    ['last_7', '2026-07-10', '2026-07-17'],
    ['this_month', '2026-07-01', '2026-08-01'],
    ['last_month', '2026-06-01', '2026-07-01'],
    ['this_quarter', '2026-07-01', '2026-10-01'],
    ['this_year', '2026-01-01', '2027-01-01'],
  ] as const)('%s -> [%s, %s)', (preset, from, to) => {
    expect(presetWindow(preset, NOW)).toEqual([from, to]);
  });

  it('"all" has no bounds', () => {
    expect(presetWindow('all', NOW)).toEqual([null, null]);
  });

  /**
   * THE OFF-BY-ONE THE CLIENT WOULD HAVE FOUND. "1st to 31st" is INCLUSIVE to a human
   * and EXCLUSIVE in SQL. Without the +1 day, every report run for a month silently
   * drops the last day — and the client reconciles it by hand every month rather than
   * reporting it, which is worse.
   */
  it('a CUSTOM `to` date is INCLUSIVE — 31 July includes 31 July', () => {
    const q = buildReportQuery(leads, {
      columns: ['full_name'], date_preset: 'custom', date_from: '2026-07-01', date_to: '2026-07-31',
    }, ADMIN, resolver);
    expect(q.params).toContain('2026-07-01');
    expect(q.params).toContain('2026-08-01');   // <- +1 day, so the 31st is in
  });

  it('the date bounds carry an explicit ::date cast (the Sprint-3 $3-cast lesson)', () => {
    const q = buildReportQuery(leads, { columns: ['full_name'], date_preset: 'this_month' }, ADMIN, resolver);
    expect(q.sql).toMatch(/>= \$\d+::date/);
    expect(q.sql).toMatch(/< \$\d+::date/);
  });
});

describe('grouping', () => {
  it('a grouped report selects the group columns, a count, and the SUM of each measure', () => {
    const q = buildReportQuery(entityByKey('enrolments')!, {
      columns: ['counsellor', 'net_fee', 'collected'], group_by: ['counsellor'],
    }, ADMIN, resolver);
    expect(q.grouped).toBe(true);
    expect(q.sql).toContain('GROUP BY');
    expect(q.sql).toContain('count(*)');
    expect(q.columns.map((c) => c.key)).toEqual(['counsellor', '_count', 'net_fee', 'collected']);
  });

  /**
   * A text column in a GROUP BY result is meaningless. Wrapping it in min()/max() would
   * make the query run and print "the alphabetically-first phone number in this branch",
   * which is worse than not printing one: it looks like data.
   */
  it('a non-measure text column is DROPPED from a grouped report, not min()-wrapped', () => {
    const q = buildReportQuery(leads, {
      columns: ['owner', 'phone', 'score'], group_by: ['owner'],
    }, ADMIN, resolver);
    expect(q.sql).not.toContain('min(');
    expect(q.columns.map((c) => c.key)).not.toContain('phone');
  });

  it('grouping on a MEASURE is refused with a reason a human can act on', () => {
    expect(() => buildReportQuery(entityByKey('enrolments')!, {
      columns: ['net_fee'], group_by: ['net_fee'],
    }, ADMIN, resolver)).toThrow(/is a measure, not a category/);
  });

  it('isGroupable defaults: text yes, money no, datetime no', () => {
    expect(isGroupable({ key: 'x', label: 'x', sql: 'x', type: 'text', deps: [] })).toBe(true);
    expect(isGroupable({ key: 'x', label: 'x', sql: 'x', type: 'money', deps: [] })).toBe(false);
    expect(isGroupable({ key: 'x', label: 'x', sql: 'x', type: 'datetime', deps: [] })).toBe(false);
  });

  it('SCOPE SURVIVES GROUPING — a grouped report is not a way around the WHERE clause', () => {
    const q = buildReportQuery(entityByKey('enrolments')!, {
      columns: ['counsellor', 'net_fee'], group_by: ['counsellor'],
    }, OWN, resolver);
    expect(q.sql).toMatch(/e\.counsellor_id = \$\d+/);
    expect(q.sql.indexOf('WHERE')).toBeLessThan(q.sql.indexOf('GROUP BY'));
  });
});

describe('the registry itself', () => {
  it('every column key is unique within its entity', () => {
    for (const e of REPORT_ENTITIES) {
      const keys = e.columns.map((c) => c.key);
      expect({ entity: e.key, dupes: keys.filter((k, i) => keys.indexOf(k) !== i) }).toEqual({ entity: e.key, dupes: [] });
    }
  });

  it('every default column and date field actually exists on its entity', () => {
    for (const e of REPORT_ENTITIES) {
      for (const k of [...e.defaultColumns, ...e.dateFields, e.defaultDateField]) {
        expect({ entity: e.key, key: k, exists: e.columns.some((c) => c.key === k) })
          .toEqual({ entity: e.key, key: k, exists: true });
      }
    }
  });

  /**
   * `buildScopeWhere` SKIPS a filter whose column it has no mapping for, and returns
   * `1=0` if nothing maps. So a missing `owner` mapping does not leak — it DENIES. But
   * it denies silently, and a counsellor's empty report is a bug report. Every entity
   * therefore declares at least a branch mapping, and every lead-shaped one declares
   * `owner` too.
   */
  it('every entity maps enough scope columns to be usable', () => {
    for (const e of REPORT_ENTITIES) {
      expect({ entity: e.key, cols: Object.keys(e.scopeCols).length > 0 }).toEqual({ entity: e.key, cols: true });
      expect({ entity: e.key, branch: !!e.scopeCols.branch }).toEqual({ entity: e.key, branch: true });
    }
    for (const key of ['leads', 'follow_ups', 'enrolments', 'receipts']) {
      expect({ key, owner: !!entityByKey(key)!.scopeCols.owner }).toEqual({ key, owner: true });
    }
  });

  /** DECISION #45, pinned. Scope a receipt on `received_by` and an Accountant's receipt
   *  vanishes from the counsellor's own report while showing on the dashboard — DEF-S5-03
   *  rebuilt in a new module. */
  it('RECEIPTS scope on the ENROLMENT\'S COUNSELLOR, never on received_by (decision #45)', () => {
    const r = entityByKey('receipts')!;
    expect(r.scopeCols.owner).toBe('e.counsellor_id');
    expect(JSON.stringify(r.scopeCols)).not.toContain('received_by');
    // ...and `received_by` is still SHOWN, because "which till took the cash" is a real
    // question — it is simply not an attribution key.
    expect(r.columns.some((c) => c.key === 'received_by')).toBe(true);
  });

  it('no entity\'s SQL contains a template placeholder (a constant that got interpolated)', () => {
    for (const e of REPORT_ENTITIES) {
      for (const c of e.columns) {
        expect({ col: `${e.key}.${c.key}`, clean: !c.sql.includes('${') }).toEqual({ col: `${e.key}.${c.key}`, clean: true });
      }
    }
  });
});
