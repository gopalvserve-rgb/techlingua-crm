import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { TemplateService } from './template.service';

/**
 * DEF-S4-01 — THE REGRESSION GUARD.
 *
 * The live smoke, not the unit tests, found this:
 *
 *     step send_message -> failed: column c.fee does not exist
 *
 * `varsForLead()` selected `c.fee AS course_fee`, but the masters are a GENERIC table
 * (`m_course(id, org_id, name, code, sort_order, is_active, meta JSONB, parent_id)`) — the
 * fee lives in `meta.fee`. Every unit test passed, because they all run against an
 * in-memory double that never validates a column name. This is the same class as the
 * Sprint-3 `$3`-cast bug: a query that only Postgres can falsify.
 *
 * So this test falsifies it WITHOUT Postgres: it parses the real migrations for the real
 * column list, then checks every column the template query references actually exists.
 * Rename or drop a column and this goes red before the client ever sees a broken journey.
 */

const MIGRATIONS = join(__dirname, '..', '..', 'db', 'migrations');

/** Every column of a table, as the migrations actually declare it (CREATE + ALTER ADD). */
function columnsOf(table: string): Set<string> {
  const cols = new Set<string>();
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), 'utf8');

    const create = new RegExp(
      `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?${table}"?\\s*\\(([\\s\\S]*?)\\n\\);`, 'i',
    ).exec(sql);
    if (create) {
      for (const raw of create[1].split('\n')) {
        const line = raw.trim().replace(/--.*$/, '').trim();
        if (!line) continue;
        // skip table-level constraints
        if (/^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT|EXCLUDE)\b/i.test(line)) continue;
        // a column line may declare several columns separated by commas ("name VARCHAR, code VARCHAR")
        for (const part of line.split(/,(?![^(]*\))/)) {
          const m = /^\s*"?([a-z_][a-z0-9_]*)"?\s+[a-z]/i.exec(part);
          if (m) cols.add(m[1].toLowerCase());
        }
      }
    }

    const alter = new RegExp(
      `ALTER\\s+TABLE\\s+"?${table}"?\\s+ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?([a-z_][a-z0-9_]*)"?`, 'gi',
    );
    let a: RegExpExecArray | null;
    while ((a = alter.exec(sql)) !== null) cols.add(a[1].toLowerCase());

    // Migration 015 adds deleted_at/deleted_by to a LIST of tables via a dynamic
    // `EXECUTE format('ALTER TABLE %s ADD COLUMN ...', t)` loop, which no regex over the
    // literal DDL can see. Read the loop's table array instead — these columns are as real
    // as any other, and pretending otherwise would make this guard cry wolf.
    const loop = /FOREACH\s+t\s+IN\s+ARRAY\s+ARRAY\[([\s\S]*?)\]/i.exec(sql);
    if (loop && /ADD COLUMN IF NOT EXISTS deleted_at/i.test(sql)) {
      const listed = loop[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '').replace(/"/g, ''));
      if (listed.includes(table)) { cols.add('deleted_at'); cols.add('deleted_by'); }
    }
  }
  return cols;
}

/** The SQL `varsForLead()` actually runs, captured by handing the service a fake db. */
function varsForLeadSql(): string {
  let captured = '';
  const db = {
    one: async (sql: string) => { captured = sql; return null; },
    query: async () => [],
  } as never;
  const svc = new TemplateService(db, {} as never, {} as never);
  // it throws NotFound (the fake returns no row) — we only want the SQL it issued
  return svc.varsForLead(1).then(() => captured, () => captured) as unknown as string;
}

describe('DEF-S4-01 — the template query only references columns that EXIST', () => {
  const TABLES: Record<string, string> = {
    l: 'lead', b: 'branch', v: 'vertical', p: 'pipeline', ca: 'campaign',
    s: 'source', st: 'pipeline_stage', c: 'm_course', u: 'user', o: 'organisation',
  };

  let sql = '';
  beforeAll(async () => { sql = await (varsForLeadSql() as unknown as Promise<string>); });

  it('the migrations really do declare the columns we think they do (the parser works)', () => {
    const lead = columnsOf('lead');
    expect(lead.has('full_name')).toBe(true);
    expect(lead.has('whatsapp_phone')).toBe(true);   // added by an ALTER (024)
    expect(lead.has('dob')).toBe(true);              // added by an ALTER (026)
    expect(lead.has('deleted_at')).toBe(true);       // added by the dynamic loop (015)
    expect(lead.has('nonsense')).toBe(false);

    const course = columnsOf('m_course');
    expect(course.has('meta')).toBe(true);
    // THE BUG, pinned: there is no `fee` column on the Course master. There never was.
    expect(course.has('fee')).toBe(false);
  });

  it('captured the SQL', () => {
    expect(sql).toContain('FROM lead l');
    expect(sql).toContain('course_fee');
  });

  it.each(Object.entries(TABLES))(
    'every `%s.<column>` in the query exists on `%s`',
    (alias, table) => {
      const cols = columnsOf(table);
      expect(cols.size).toBeGreaterThan(0);

      const refs = new Set<string>();
      const re = new RegExp(`\\b${alias}\\.([a-z_][a-z0-9_]*)`, 'gi');
      let m: RegExpExecArray | null;
      while ((m = re.exec(sql)) !== null) refs.add(m[1].toLowerCase());

      const missing = [...refs].filter((c) => !cols.has(c));
      expect(missing).toEqual([]);
    },
  );

  it('the course FEE is read from meta JSONB, not from a phantom column', () => {
    expect(sql).toContain("(c.meta->>'fee')");
    expect(sql).not.toMatch(/\bc\.fee\b/);
  });
});

/* ========================================================================== */
/*  The SAME guard, extended to the CAPTURE queries (DEF-S34-02 / -03).        */
/*                                                                             */
/*  Migration 027 adds six columns to `walk_in` and four to `referral`, and    */
/*  the list/edit queries now select all of them. A typo, or a column dropped  */
/*  from a migration, would only surface as a 500 on the client's Walk-ins     */
/*  screen — exactly how DEF-S4-01 reached production. Same parser, same guard.*/
/* ========================================================================== */

import { CaptureService } from '../capture/capture.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';

/** the SQL listWalkIns() / listReferrals() actually run, captured with a fake db */
async function captureSql(which: 'walkins' | 'referrals'): Promise<string> {
  let sql = '';
  const db = {
    query: async (s: string) => { sql = s; return []; },
    one: async () => ({}),
  } as never;
  const svc = new CaptureService(db, {} as never, new ScopeResolverService(),
    {} as never, {} as never, {} as never);
  const scope = { permissionKey: 'walkin.read', allowed: true, all: true, filters: [],
    allowedFields: null, deniedFields: [] } as never;
  if (which === 'walkins') await svc.listWalkIns(scope, {});
  else await svc.listReferrals(scope, {});
  return sql;
}

describe('DEF-S34-02/03 — the walk-in & referral queries only reference columns that EXIST', () => {
  it('migration 027 really adds the six walk-in columns the form now depends on', () => {
    const w = columnsOf('walk_in');
    for (const c of ['alt_phone', 'whatsapp_phone', 'course_fee', 'heard_about_source_id',
      'convert_to_lead', 'campaign_id', 'source_id']) {
      expect(`walk_in.${c}: ${w.has(c)}`).toBe(`walk_in.${c}: true`);
    }
    const r = columnsOf('referral');
    for (const c of ['referred_whatsapp', 'referred_email', 'campaign_id', 'source_id']) {
      expect(`referral.${c}: ${r.has(c)}`).toBe(`referral.${c}: true`);
    }
  });

  const ALIASES: Record<string, Record<string, string>> = {
    walkins: { w: 'walk_in', wl: 'lead', c: 'm_course', ms: 'm_source', b: 'branch',
      v: 'vertical', cmp: 'campaign', pl: 'pipeline', sr: 'source', st: 'pipeline_stage' },
    referrals: { r: 'referral', rl: 'lead', c: 'm_course', b: 'branch', v: 'vertical',
      cmp: 'campaign', pl: 'pipeline', sr: 'source', st: 'pipeline_stage' },
  };

  it.each(['walkins', 'referrals'] as const)('%s: every aliased column exists', async (which) => {
    const sql = await captureSql(which);
    const missing: string[] = [];
    for (const [alias, table] of Object.entries(ALIASES[which])) {
      const cols = columnsOf(table);
      const re = new RegExp(`\\b${alias}\\.([a-z_][a-z0-9_]*)`, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(sql)) !== null) {
        if (!cols.has(m[1].toLowerCase())) missing.push(`${alias}.${m[1]}  (${table})`);
      }
    }
    // any entry here is a column the query names but the migrations never create
    expect(missing).toEqual([]);
  });
});
