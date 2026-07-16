import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { REPORT_ENTITIES } from './entities';
import {
  ENROLMENT_COUNTS_AS_SOLD, ENROLMENT_REVENUE_COLUMN, RECEIPT_ATTRIBUTION_KEY,
  SLA_ELAPSED_COLUMN, SLA_FIRST_RESPONSE_METRIC, STAGE_COUNT_FROM, STAGE_COUNT_LIVE,
} from './shared-metrics';

/**
 * THE SCHEMA GUARD, EXTENDED TO SPRINT 6 — AND TO THE NOTIFIER.
 *
 * =============================================================================
 * IT FOUND A LIVE BUG BEFORE A LINE OF SPRINT-6 SQL RAN. (DEF-S6-01)
 * =============================================================================
 * The Sprint-5 guard covered seven files. Sprint 6 pointed it at the notifier too —
 * because scheduled delivery and announcements both go through it — and it immediately
 * failed on:
 *
 *     notifications/notifier.service.ts:  SELECT email, mobile, name FROM "user"
 *
 * THERE IS NO `mobile` COLUMN ON `"user"`. It is `phone` (migration 012 made it the
 * mobile-first login identifier and never renamed it). That line has been in the repo
 * since Sprint 4 and has never thrown, for one reason only: the SMS and WhatsApp staff
 * notification channels are DISABLED BY DEFAULT, so no request has ever reached it. The
 * first time Gopal ticked "SMS" in the notification matrix, every staff notification
 * would have thrown `column "mobile" does not exist` — and 1092 green unit tests would
 * have said nothing, because every one of them drives an in-memory double that never
 * validates a column name. The DEF-S4-01 shape, exactly.
 *
 * Fixed in the same commit. The lesson is not "we fixed a bug" — it is that a guard
 * pointed at MORE FILES finds MORE BUGS, for free, so the file list below is deliberately
 * wider than Sprint 6.
 */

const MIGRATIONS = join(__dirname, '..', '..', 'db', 'migrations');
const SRC = join(__dirname, '..');

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

    const loop = /FOREACH\s+t\s+IN\s+ARRAY\s+ARRAY\[([\s\S]*?)\]/i.exec(sql);
    if (loop && /ADD COLUMN IF NOT EXISTS deleted_at/i.test(sql)) {
      const listed = loop[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '').replace(/"/g, ''));
      if (listed.includes(table)) { cols.add('deleted_at'); cols.add('deleted_by'); }
    }
  }
  return cols;
}

const cache = new Map<string, Set<string>>();
const cols = (t: string) => {
  const k = t.replace(/"/g, '');
  if (!cache.has(k)) cache.set(k, columnsOf(k));
  return cache.get(k)!;
};

/* ========================================================================= */
/*  PART 1 — the ENTITY REGISTRY declares its dependencies. Check them.       */
/* ========================================================================= */

describe('every column the report registry offers reads a column that EXISTS', () => {
  it('the parser can read a real table (a guard that sees nothing passes everything)', () => {
    expect([...cols('lead')]).toEqual(expect.arrayContaining(['id', 'full_name', 'phone', 'owner_id', 'temperature']));
    expect(cols('lead').has('definitely_not_a_column')).toBe(false);
  });

  it('THE `"user".mobile` BUG — the column really is `phone`, and `mobile` really does not exist', () => {
    expect(cols('user').has('phone')).toBe(true);
    expect(cols('user').has('mobile')).toBe(false);       // <- DEF-S6-01
    expect(cols('user').has('last_login_at')).toBe(false); // <- the entity registry's own first draft
  });

  it('every `deps` entry of every report column names a real table.column', () => {
    const bad: string[] = [];
    for (const e of REPORT_ENTITIES) {
      for (const c of e.columns) {
        expect({ col: `${e.key}.${c.key}`, hasDeps: c.deps.length > 0 }).toEqual({ col: `${e.key}.${c.key}`, hasDeps: true });
        for (const d of c.deps) {
          const [table, col] = d.split('.');
          const declared = cols(table);
          if (!declared.size) { bad.push(`${e.key}.${c.key}: unknown table "${table}"`); continue; }
          if (!declared.has(col)) bad.push(`${e.key}.${c.key}: ${table}.${col} does not exist`);
        }
      }
    }
    expect([...new Set(bad)]).toEqual([]);
  });

  it('every table an entity JOINs exists', () => {
    const bad: string[] = [];
    for (const e of REPORT_ENTITIES) {
      const stmt = e.from;
      for (const m of stmt.matchAll(/\b(?:FROM|JOIN)\s+("?[a-z_][a-z0-9_]*"?)\s/gi)) {
        const t = m[1].replace(/"/g, '').toLowerCase();
        if (t === 'lateral') continue;
        if (!cols(t).size) bad.push(`${e.key}: unknown table "${t}"`);
      }
    }
    expect([...new Set(bad)]).toEqual([]);
  });

  it('every scope column names a real table.column via its alias', () => {
    // alias -> table, from each entity's own FROM clause
    const bad: string[] = [];
    for (const e of REPORT_ENTITIES) {
      const binds = new Map<string, string>();
      for (const m of e.from.matchAll(/\b(?:FROM|JOIN)\s+("?[a-z_][a-z0-9_]*"?)\s+(?:AS\s+)?([a-z_][a-z0-9_]*)\b/gi)) {
        const t = m[1].replace(/"/g, '').toLowerCase();
        if (t === 'lateral') continue;
        binds.set(m[2].toLowerCase(), t);
      }
      for (const [kind, expr] of Object.entries(e.scopeCols)) {
        if (!expr) continue;
        const [alias, col] = String(expr).split('.');
        const table = binds.get(alias);
        if (!table) continue;   // a LATERAL alias (`ua` on users) — nothing to bind to
        if (!cols(table).has(col)) bad.push(`${e.key}.scopeCols.${kind} -> ${table}.${col} does not exist`);
      }
    }
    expect([...new Set(bad)]).toEqual([]);
  });
});

/* ========================================================================= */
/*  PART 2 — the SQL in the Sprint-6 services, and the NOTIFIER.             */
/* ========================================================================= */

const GUARDED_FILES = [
  'reports/report.service.ts',
  'reports/standard.service.ts',
  'reports/export.service.ts',
  'reports/export.worker.ts',
  'reports/schedule.service.ts',
  'reports/schedule.worker.ts',
  'workspace/workspace.service.ts',
  // NOT Sprint-6 code — pointed at deliberately. This is where DEF-S6-01 was found, and
  // it is the whole argument for a guard: aim it wider and it works harder.
  'notifications/notifier.service.ts',
  'notifications/notification.service.ts',
  'messaging/messaging.service.ts',
];

const sourceOf = () => GUARDED_FILES.map((f) => readFileSync(join(SRC, f), 'utf8')).join('\n');

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

function bindingsOf(stmt: string): Map<string, string> {
  const map = new Map<string, string>();
  const derived = new Set<string>();
  for (const m of stmt.matchAll(/\b([a-z_][a-z0-9_]*)\s+AS\s*\(/gi)) derived.add(m[1].toLowerCase());
  for (const m of stmt.matchAll(/\)\s*([a-z_][a-z0-9_]*)\s+ON\b/gi)) derived.add(m[1].toLowerCase());
  for (const m of stmt.matchAll(/\)\s*(?:AS\s+)?([a-z_][a-z0-9_]*)\b(?=[\s,)])/gi)) derived.add(m[1].toLowerCase());

  const re = /\b(?:FROM|JOIN|UPDATE)\s+("?[a-z_][a-z0-9_]*"?)\s+(?:AS\s+)?([a-z_][a-z0-9_]*)\b/gi;
  for (const m of stmt.matchAll(re)) {
    const table = m[1].replace(/"/g, '').toLowerCase();
    const alias = m[2].toLowerCase();
    if (['on', 'set', 'where', 'lateral', 'as', 'select', 'values', 'order', 'group', 'limit'].includes(alias)) continue;
    if (derived.has(table)) continue;
    map.set(alias, table);
  }
  return map;
}

const refsIn = (stmt: string): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  for (const m of stmt.matchAll(/\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b(?!\s*\()/g)) out.push([m[1].toLowerCase(), m[2].toLowerCase()]);
  return out;
};

describe('EVERY column every guarded query names actually EXISTS', () => {
  const stmts = sqlStatements();

  it('found the SQL at all', () => {
    expect(stmts.length).toBeGreaterThan(20);
    expect(stmts.some((s) => /FROM\s+report_definition/i.test(s))).toBe(true);
    expect(stmts.some((s) => /INSERT\s+INTO\s+report_delivery/i.test(s))).toBe(true);
    expect(stmts.some((s) => /FROM\s+workspace_channel/i.test(s))).toBe(true);
  });

  it('no guarded query names a column that does not exist', () => {
    const bad: string[] = [];
    for (const stmt of stmts) {
      const binds = bindingsOf(stmt);
      for (const [alias, col] of refsIn(stmt)) {
        const table = binds.get(alias);
        if (!table) continue;
        const declared = cols(table);
        if (!declared.size) { bad.push(`unknown table "${table}"`); continue; }
        if (!declared.has(col)) bad.push(`${table}.${col}  (alias "${alias}")`);
      }
    }
    expect([...new Set(bad)]).toEqual([]);
  });

  it('a BARE column list (`SELECT email, phone, name FROM "user"`) is checked too', () => {
    // The alias-based check above cannot see `SELECT email, mobile, name FROM "user"` —
    // there IS no alias. That is EXACTLY the shape DEF-S6-01 had, so it gets its own pass.
    const bad: string[] = [];
    for (const stmt of stmts) {
      const m = /SELECT\s+((?:[a-z_][a-z0-9_]*(?:\s+AS\s+[a-z_][a-z0-9_]*)?\s*,\s*)*[a-z_][a-z0-9_]*(?:\s+AS\s+[a-z_][a-z0-9_]*)?)\s+FROM\s+("?[a-z_][a-z0-9_]*"?)\s+WHERE/i.exec(stmt);
      if (!m) continue;
      const table = m[2].replace(/"/g, '').toLowerCase();
      const declared = cols(table);
      if (!declared.size) continue;
      for (const raw of m[1].split(',')) {
        const col = raw.trim().split(/\s+AS\s+/i)[0].trim().toLowerCase();
        if (!/^[a-z_][a-z0-9_]*$/.test(col) || col === '*') continue;
        if (['count', 'max', 'min', 'sum', 'now', 'distinct'].includes(col)) continue;
        if (!declared.has(col)) bad.push(`${table}.${col}`);
      }
    }
    expect([...new Set(bad)]).toEqual([]);
  });

  it('every column an INSERT names exists on the table it inserts into', () => {
    const bad: string[] = [];
    for (const stmt of stmts) {
      const m = /INSERT\s+INTO\s+("?[a-z_][a-z0-9_]*"?)\s*\(([^)]*)\)/i.exec(stmt);
      if (!m) continue;
      const table = m[1].replace(/"/g, '').toLowerCase();
      const declared = cols(table);
      if (!declared.size) { bad.push(`unknown table "${table}"`); continue; }
      for (const raw of m[2].split(',')) {
        const col = raw.trim().replace(/"/g, '').toLowerCase();
        if (!col || !/^[a-z_][a-z0-9_]*$/.test(col)) continue;
        if (!declared.has(col)) bad.push(`${table}.${col}`);
      }
    }
    expect([...new Set(bad)]).toEqual([]);
  });

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
          if (/GENERATED\s+ALWAYS/i.test(rest) || /DEFAULT/i.test(rest) || !/NOT\s+NULL/i.test(rest)) continue;
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

/* ========================================================================= */
/*  PART 3 — the SHARED METRIC CONSTANTS name real columns.                   */
/* ========================================================================= */

describe('shared-metrics.ts names real columns (it is interpolated, so the alias check cannot see it)', () => {
  it('the stage-count constants are real', () => {
    expect(STAGE_COUNT_FROM).toContain('pipeline_stage');
    expect(cols('lead').has('stage_id')).toBe(true);
    expect(cols('lead').has('is_active')).toBe(true);
    expect(STAGE_COUNT_LIVE).toContain('deleted_at');
  });
  it('the revenue constants are real', () => {
    expect(cols('enrolment').has(ENROLMENT_REVENUE_COLUMN)).toBe(true);
    expect(ENROLMENT_COUNTS_AS_SOLD).toBe("status = 'active'");
    expect(cols('enrolment').has('status')).toBe(true);
  });
  it('the receipt attribution key is real, and is the COUNSELLOR (decision #45)', () => {
    expect(RECEIPT_ATTRIBUTION_KEY).toBe('e.counsellor_id');
    expect(cols('enrolment').has('counsellor_id')).toBe(true);
  });
  it('the SLA constants are real — and lead_stage_tat still has no first_response column', () => {
    expect(cols('lead_sla').has(SLA_ELAPSED_COLUMN)).toBe(true);
    expect(cols('lead_sla').has('metric')).toBe(true);
    expect(SLA_FIRST_RESPONSE_METRIC).toBe("'first_response'");
    expect(cols('lead_stage_tat').has('first_response_minutes')).toBe(false);
  });
});

/* ========================================================================= */
/*  PART 4 — migration 031 is idempotent-shaped.                              */
/* ========================================================================= */

describe('migration 031 is idempotent-shaped', () => {
  const sql = readFileSync(join(MIGRATIONS, '031_sprint6.sql'), 'utf8');

  it('every CREATE TABLE is IF NOT EXISTS', () => {
    const creates = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?\w+/gi) ?? [];
    expect(creates.length).toBeGreaterThan(5);
    expect(creates.filter((c) => !/IF\s+NOT\s+EXISTS/i.test(c))).toEqual([]);
  });

  it('every CREATE INDEX is IF NOT EXISTS', () => {
    const idx = sql.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\w+/gi) ?? [];
    expect(idx.length).toBeGreaterThan(10);
    expect(idx.filter((c) => !/IF\s+NOT\s+EXISTS/i.test(c))).toEqual([]);
  });

  it('every seed INSERT can run twice', () => {
    const inserts = sql.split(/\bINSERT\s+INTO\b/i).slice(1);
    for (const chunk of inserts) {
      const stmt = chunk.split(';')[0];
      const head = stmt.trim().split('\n')[0].slice(0, 80);
      expect({ insert: head, guarded: /ON\s+CONFLICT/i.test(stmt) }).toEqual({ insert: head, guarded: true });
    }
  });

  /** The idempotency of the WHOLE feature rests on this one index. If a refactor ever
   *  drops it, a schedule double-sends and nothing else notices. */
  it('THE DELIVERY IDEMPOTENCY INDEX EXISTS AND IS UNIQUE', () => {
    expect(sql).toMatch(/CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+uq_report_delivery_period\s+ON\s+report_delivery\s*\(schedule_id,\s*run_key\)/i);
  });

  it('the hardening indexes target the columns the big lists actually filter on', () => {
    for (const ix of ['ix_lead_owner_created', 'ix_lead_branch_created', 'ix_follow_up_owner_sched',
      'ix_enrolment_counsellor', 'ix_fee_receipt_enrolment', 'ix_lead_stage_tat_lead']) {
      expect({ ix, present: sql.includes(ix) }).toEqual({ ix, present: true });
    }
  });

  it('the new report/workspace permissions are granted to somebody (a permission nobody holds is a screen nobody can open)', () => {
    for (const p of ['report.read', 'report.create', 'report.export', 'report.schedule', 'report.share',
      'workspace.read', 'workspace.post', 'kb.read', 'announcement.read']) {
      expect({ perm: p, granted: new RegExp(`\\('${p.replace('.', '\\.')}'`).test(sql) }).toEqual({ perm: p, granted: true });
    }
  });

  /** SHARE and SCHEDULE put data in someone else's list / inbox. That is a manager's
   *  decision, and this asserts the grant list says so. */
  it('a Counsellor may build and export, but may NOT share or schedule', () => {
    const grants = sql.slice(sql.indexOf('AS v(pkey, role_name, scope)') - 6000, sql.indexOf('AS v(pkey, role_name, scope)'));
    expect(grants).toMatch(/\('report\.create',\s*'Counsellor'/);
    expect(grants).toMatch(/\('report\.export',\s*'Counsellor'/);
    expect(grants).not.toMatch(/\('report\.share',\s*'Counsellor'/);
    expect(grants).not.toMatch(/\('report\.schedule',\s*'Counsellor'/);
  });
});
