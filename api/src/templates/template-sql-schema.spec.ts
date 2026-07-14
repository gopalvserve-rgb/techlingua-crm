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
