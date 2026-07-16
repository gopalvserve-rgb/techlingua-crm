import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * THE SCHEMA GUARD, EXTENDED TO SPRINT 5.
 *
 * DEF-S4-01 taught this the hard way: `varsForLead()` selected `c.fee`, a column that
 * does not exist, and EVERY unit test passed because they all run against an in-memory
 * double that never validates a column name. Only the live smoke found it.
 *
 * Sprint 5 writes more SQL than any sprint so far, against six new tables AND several
 * old ones it had never touched. Writing this guard FIRST already paid for itself twice
 * before a single line reached Postgres:
 *
 *   · `lead_activity` — org_id and branch_id are NOT NULL. The first draft inserted
 *     neither. That is a 500 on the client's first quotation.
 *   · `follow_up.due_at` and `lead_stage_tat.first_response_minutes` — NEITHER EXISTS.
 *     The columns are `scheduled_at` and (for first response) `lead_sla.elapsed_seconds`.
 *     The performance leaderboard would have thrown on every load.
 *
 * So this parses the REAL migrations for the REAL column list, then checks every column
 * every Sprint-5 query references. Rename or drop a column and this goes red before the
 * client ever sees a broken screen.
 */

const MIGRATIONS = join(__dirname, '..', '..', 'db', 'migrations');
const SRC = join(__dirname, '..');

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
        if (/^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT|EXCLUDE)\b/i.test(line)) continue;
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

    // migration 015 adds deleted_at/deleted_by through a dynamic EXECUTE format() loop
    const loop = /FOREACH\s+t\s+IN\s+ARRAY\s+ARRAY\[([\s\S]*?)\]/i.exec(sql);
    if (loop && /ADD COLUMN IF NOT EXISTS deleted_at/i.test(sql)) {
      const listed = loop[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '').replace(/"/g, ''));
      if (listed.includes(table)) { cols.add('deleted_at'); cols.add('deleted_by'); }
    }
  }
  return cols;
}

const SPRINT5_FILES = [
  'quotations/quotation.service.ts',
  'enrolments/enrolment.service.ts',
  'enrolments/approval.service.ts',
  'fees/fee.service.ts',
  'performance/performance.service.ts',
  'performance/target.service.ts',
  'numbering/numbering.service.ts',
];

const sourceOf = () => SPRINT5_FILES.map((f) => readFileSync(join(SRC, f), 'utf8')).join('\n');

/**
 * Pull out the SQL, and ONLY the SQL.
 *
 * The first draft of this guard scanned the whole TypeScript file for `alias.column` and
 * drowned in false positives — `r.revenue_target_minor` in a `.map()` is not SQL, and
 * `this.db` is not a table. So: take every template literal that contains a SQL verb,
 * blank out its `${...}` interpolations (they are scope fragments, already covered by
 * their own aliases), and work only on those.
 */
function sqlStatements(): string[] {
  const src = sourceOf();
  const out: string[] = [];
  const re = /`([^`\\]*(?:\\.[^`\\]*)*)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const body = m[1];
    if (!/\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(body)) continue;
    out.push(body.replace(/\$\{[^}]*\}/g, ' '));
  }
  return out;
}

/**
 * The alias bindings a STATEMENT declares for itself: `FROM quotation q`, `JOIN lead l`,
 * `UPDATE enrolment e`, `INSERT INTO fee_receipt`. An alias bound to a CTE, a LATERAL
 * subquery or a VALUES list is simply NOT a table, so it is not in the map and is
 * skipped — which is right: `win w` and `people p` have no migration to check against.
 */
function bindingsOf(stmt: string): Map<string, string> {
  const map = new Map<string, string>();
  // CTE / derived-table names must never be treated as tables
  const derived = new Set<string>();
  for (const m of stmt.matchAll(/\b([a-z_][a-z0-9_]*)\s+AS\s*\(/gi)) derived.add(m[1].toLowerCase());
  // `) alias ON` / `) alias (` — a LATERAL or subquery alias
  for (const m of stmt.matchAll(/\)\s*([a-z_][a-z0-9_]*)\s+ON\b/gi)) derived.add(m[1].toLowerCase());
  for (const m of stmt.matchAll(/\)\s*(?:AS\s+)?([a-z_][a-z0-9_]*)\b(?=[\s,)])/gi)) derived.add(m[1].toLowerCase());

  const re = /\b(?:FROM|JOIN|UPDATE)\s+("?[a-z_][a-z0-9_]*"?)\s+(?:AS\s+)?([a-z_][a-z0-9_]*)\b/gi;
  for (const m of stmt.matchAll(re)) {
    const table = m[1].replace(/"/g, '').toLowerCase();
    const alias = m[2].toLowerCase();
    if (['on', 'set', 'where', 'lateral', 'as', 'select', 'values'].includes(alias)) continue;
    if (derived.has(table)) continue;                 // `FROM scoped_leads sl` — a CTE
    map.set(alias, table);
  }
  return map;
}

/** `alias.column` references in a statement. */
function refsIn(stmt: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const m of stmt.matchAll(/\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b(?!\s*\()/g)) {
    out.push([m[1].toLowerCase(), m[2].toLowerCase()]);
  }
  return out;
}

describe('the parser works (a guard that cannot see a column would pass everything)', () => {
  it('reads the columns Sprint 5 created', () => {
    const q = columnsOf('quotation');
    for (const c of ['id', 'quote_no', 'version', 'parent_id', 'is_current', 'lead_id',
      'subtotal_minor', 'discount_minor', 'tax_minor', 'total_minor', 'valid_until',
      'status', 'deleted_at']) expect([...q]).toContain(c);
    expect(q.has('nonexistent_column')).toBe(false);
  });

  it('reads the columns Sprint 5 only USES — the ones the first draft got wrong', () => {
    // the two real bugs this guard caught, now assertions
    expect([...columnsOf('lead_activity')]).toEqual(expect.arrayContaining(['org_id', 'branch_id', 'lead_id', 'type', 'note', 'actor_id']));
    expect(columnsOf('follow_up').has('scheduled_at')).toBe(true);
    expect(columnsOf('follow_up').has('due_at')).toBe(false);          // <- the bug
    expect(columnsOf('lead_sla').has('elapsed_seconds')).toBe(true);
    expect(columnsOf('lead_stage_tat').has('first_response_minutes')).toBe(false);   // <- the bug
  });
});

describe('EVERY column every Sprint-5 query names actually EXISTS', () => {
  const stmts = sqlStatements();

  it('found the Sprint-5 SQL at all (a guard that sees nothing passes everything)', () => {
    expect(stmts.length).toBeGreaterThan(20);
    expect(stmts.some((s) => /FROM\s+quotation\s+q/i.test(s))).toBe(true);
    expect(stmts.some((s) => /FROM\s+enrolment\s+e/i.test(s))).toBe(true);
    expect(stmts.some((s) => /INSERT\s+INTO\s+lead_activity/i.test(s))).toBe(true);
  });

  it('resolves each statement\'s OWN aliases — CTEs and LATERALs are not tables', () => {
    const perf = stmts.find((s) => /scoped_leads/.test(s))!;
    const b = bindingsOf(perf);
    expect(b.get('u')).toBe('user');
    expect(b.has('w')).toBe(false);          // `win w` is a CTE
    expect(b.has('p')).toBe(false);          // `people p` is a CTE
    expect(b.has('sl')).toBe(false);         // `scoped_leads sl` is a CTE
  });

  it('no Sprint-5 query names a column that does not exist', () => {
    const cache = new Map<string, Set<string>>();
    const cols = (t: string) => {
      if (!cache.has(t)) cache.set(t, columnsOf(t));
      return cache.get(t)!;
    };
    const bad: string[] = [];
    for (const stmt of stmts) {
      const binds = bindingsOf(stmt);
      for (const [alias, col] of refsIn(stmt)) {
        const table = binds.get(alias);
        if (!table) continue;                          // CTE / derived alias — nothing to check
        const declared = cols(table);
        if (!declared.size) { bad.push(`unknown table "${table}"`); continue; }
        if (!declared.has(col)) bad.push(`${table}.${col}  (alias "${alias}")`);
      }
    }
    // The DEF-S4-01 bug class: every unit test passes and Postgres throws on the
    // client's first click. If this is red, the query is wrong — not this test.
    expect([...new Set(bad)]).toEqual([]);
  });

  it('every column an INSERT names exists on the table it inserts into', () => {
    const bad: string[] = [];
    for (const stmt of stmts) {
      const m = /INSERT\s+INTO\s+("?[a-z_][a-z0-9_]*"?)\s*\(([^)]*)\)/i.exec(stmt);
      if (!m) continue;
      const table = m[1].replace(/"/g, '').toLowerCase();
      const declared = columnsOf(table);
      if (!declared.size) { bad.push(`unknown table "${table}"`); continue; }
      for (const raw of m[2].split(',')) {
        const col = raw.trim().replace(/"/g, '').toLowerCase();
        if (!col || !/^[a-z_][a-z0-9_]*$/.test(col)) continue;
        if (!declared.has(col)) bad.push(`${table}.${col}`);
      }
    }
    expect([...new Set(bad)]).toEqual([]);
  });

  /**
   * NOT-NULL columns must be supplied. This is the exact bug the first draft shipped:
   * `INSERT INTO lead_activity (lead_id, type, note, actor_id)` — org_id and branch_id
   * are NOT NULL and were both missing. Postgres would have thrown on the client's very
   * first quotation, and 893 green unit tests would have said nothing.
   */
  it('every INSERT supplies the NOT NULL columns that have no default', () => {
    const required = (table: string): string[] => {
      const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
      const out: string[] = [];
      for (const f of files) {
        const sql = readFileSync(join(MIGRATIONS, f), 'utf8');
        const create = new RegExp(
          `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?${table}"?\\s*\\(([\\s\\S]*?)\\n\\);`, 'i',
        ).exec(sql);
        if (!create) continue;
        for (const raw of create[1].split('\n')) {
          const line = raw.trim().replace(/--.*$/, '').trim().replace(/,$/, '');
          if (!line || /^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT|EXCLUDE)\b/i.test(line)) continue;
          const m = /^\s*"?([a-z_][a-z0-9_]*)"?\s+(.*)$/i.exec(line);
          if (!m) continue;
          const [, col, rest] = m;
          if (/GENERATED\s+ALWAYS/i.test(rest)) continue;
          if (/DEFAULT/i.test(rest)) continue;
          if (!/NOT\s+NULL/i.test(rest)) continue;
          out.push(col.toLowerCase());
        }
      }
      return out;
    };
    const bad: string[] = [];
    for (const stmt of stmts) {
      const m = /INSERT\s+INTO\s+("?[a-z_][a-z0-9_]*"?)\s*\(([^)]*)\)/i.exec(stmt);
      if (!m) continue;
      const table = m[1].replace(/"/g, '').toLowerCase();
      const given = new Set(m[2].split(',').map((x) => x.trim().replace(/"/g, '').toLowerCase()));
      for (const col of required(table)) {
        if (!given.has(col)) bad.push(`${table}.${col} is NOT NULL with no default, and this INSERT omits it`);
      }
    }
    expect([...new Set(bad)]).toEqual([]);
  });
});

describe('the migration is idempotent-shaped', () => {
  const sql = readFileSync(join(MIGRATIONS, '029_sprint5.sql'), 'utf8');

  it('every CREATE TABLE is IF NOT EXISTS', () => {
    const creates = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?\w+/gi) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    expect(creates.filter((c) => !/IF\s+NOT\s+EXISTS/i.test(c))).toEqual([]);
  });

  it('every CREATE INDEX is IF NOT EXISTS', () => {
    const idx = sql.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\w+/gi) ?? [];
    expect(idx.length).toBeGreaterThan(0);
    expect(idx.filter((c) => !/IF\s+NOT\s+EXISTS/i.test(c))).toEqual([]);
  });

  it('every seed INSERT can run twice', () => {
    // each INSERT INTO must carry ON CONFLICT (or be inside a DO block that guards itself)
    const inserts = sql.split(/\bINSERT\s+INTO\b/i).slice(1);
    for (const chunk of inserts) {
      const stmt = chunk.split(';')[0];
      const head = stmt.trim().split('\n')[0].slice(0, 80);
      expect({ insert: head, guarded: /ON\s+CONFLICT/i.test(stmt) }).toEqual({ insert: head, guarded: true });
    }
  });

  it('MONEY IS NEVER A FLOAT — every amount column is BIGINT minor units or NUMERIC', () => {
    const bad = sql.match(/^\s*\w*(fee|amount|price|total|revenue|discount|subtotal|tax)\w*\s+(REAL|FLOAT|DOUBLE|MONEY)\b/gim) ?? [];
    expect({ floatMoneyColumns: bad }).toEqual({ floatMoneyColumns: [] });
    // and every *_minor really is BIGINT
    const minors = sql.match(/^\s*\w+_minor\s+\w+/gim) ?? [];
    expect(minors.length).toBeGreaterThan(8);
    expect(minors.filter((m) => !/BIGINT/i.test(m))).toEqual([]);
  });

  it('the PHASE-2 and PHASE-3 seams exist and are nullable (nothing writes them yet)', () => {
    for (const seam of ['student_profile_id', 'batch_id', 'gateway', 'gateway_order_id', 'gateway_payment_id']) {
      const ok = new RegExp(`${seam}\\s+\\w+.*NULL`, 'i').test(sql);
      expect({ seam, declaredNullable: ok }).toEqual({ seam, declaredNullable: true });
    }
    // and NOTHING in the Sprint-5 source writes them — a half-populated seam is a
    // migration nobody planned.
    const src = sourceOf();
    for (const seam of ['student_profile_id', 'batch_id', 'gateway_payment_id']) {
      const written = new RegExp(`(INSERT|UPDATE)[\\s\\S]{0,400}${seam}`, 'i').test(src);
      expect({ seam, writtenInPhase1: written }).toEqual({ seam, writtenInPhase1: false });
    }
  });
});
