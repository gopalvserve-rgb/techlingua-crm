import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ImportService, MAX_CSV_BYTES } from './import.service';
import { makeIngestion } from './fake-db.testkit';
import { DatabaseService } from '../database/database.service';
import { ScopeEnforcerService } from '../rbac/scope-enforcer.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope } from '../rbac/rbac.types';

/** Minimal Postgres double: enough for loadTarget + duplicate lookups + enqueue. */
function makeDb(existingPhones: string[] = []) {
  const jobs: any[] = [];
  const batches: any[] = [];
  const exec = async (sql: string, params: unknown[] = []): Promise<any[]> => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT id, org_id, branch_id, vertical_id, pipeline_id, distribution_config')) {
      return [{ id: 5, org_id: 1, branch_id: 2, vertical_id: 3, pipeline_id: 4,
        distribution_config: { mode: 'equal', agent_user_ids: [11] },
        duplicacy_config: { check_scope: 'this_campaign', on_duplicate: 'ignore' } }];
    }
    if (s.startsWith('SELECT id FROM source WHERE id')) return [{ id: 7 }];
    if (/^SELECT id, name FROM (state|city|m_course|m_qualification|m_budget|m_status|m_tag)/.test(s)) {
      return s.includes('m_course') ? [{ id: 21, name: 'IELTS' }] : [];
    }
    if (s.startsWith('SELECT id, name, is_default, sort_order FROM pipeline_stage')) return [{ id: 51, name: 'New', is_default: true, sort_order: 1 }];
    if (s.includes("FROM m_status WHERE org_id")) return [{ id: 31 }];
    if (s.startsWith('SELECT field_key FROM custom_field_def')) return [];
    if (s.startsWith('SELECT field_key, label FROM custom_field_def')) return [];
    if (s.includes('FROM lead l LEFT JOIN pipeline_stage st')) {
      return existingPhones.includes(String(params[0])) ? [{ id: 900, owner_id: 11, stage_type: 'open' }] : [];
    }
    if (s.startsWith('INSERT INTO import_batch')) { const b = { id: 1, file_name: params[1], total_rows: params[9] }; batches.push(b); return [b]; }
    if (s.startsWith('INSERT INTO import_job')) { jobs.push({ row_num: params[1], payload: params[2], dedupe_key: params[4] }); return []; }
    if (s.startsWith('SELECT lead_id, outcome FROM lead_ingest_record')) return [];
    throw new Error(`unhandled SQL: ${s.slice(0, 80)}`);
  };
  const db = {
    query: (sql: string, p?: unknown[]) => exec(sql, p),
    one: async (sql: string, p?: unknown[]) => (await exec(sql, p))[0] ?? null,
    tx: async (fn: (c: any) => Promise<any>) => fn({
      query: async (sql: string, p?: unknown[]) => { const rows = await exec(sql, p); return { rows, rowCount: rows.length }; },
    }),
  } as unknown as DatabaseService;
  return { db, jobs, batches };
}

const ALL_SCOPE: ResolvedScope = { permissionKey: 'lead.import', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [] };
const SCOPED: ResolvedScope = {
  permissionKey: 'lead.import', allowed: true, all: false,
  filters: [{ kind: 'branch', branchId: 99 }], allowedFields: null, deniedFields: [],
};

function makeSvc(db: DatabaseService, inScope = true) {
  const ingestion = makeIngestion(db).svc;
  const enforcer = {
    assertRefInScope: async (_s: ResolvedScope, kind: string) => {
      if (!inScope) throw new NotFoundException(`${kind} not found`);
    },
  } as unknown as ScopeEnforcerService;
  return new ImportService(db, ingestion, enforcer, new ScopeResolverService());
}

/** A real-world file: a quoted field with a comma, a duplicate, and a bad row. */
const CSV = [
  'Name,Mobile,Email,Course,Remarks',
  '"Sharma, Priya",9811100001,priya@example.com,IELTS,"Prefers ""evening"" batch, weekdays"',
  'Ravi Kumar,9811100002,ravi@example.com,IELTS,Called once',
  'Dup Ravi,9811100002,,IELTS,same phone as row 2',
  'Bad Row,12,not-an-email,IELTS,invalid phone + email',
  'No Phone,,x@y.com,IELTS,missing mobile',
].join('\n') + '\n';

const MAPPING = { Name: 'full_name', Mobile: 'phone', Email: 'email', Course: 'course', Remarks: 'note' };

describe('ImportService', () => {
  it('parse() returns headers, an auto-mapping and a sample', async () => {
    const { db } = makeDb();
    const out = await makeSvc(db).parse(CSV);
    expect(out.headers).toEqual(['Name', 'Mobile', 'Email', 'Course', 'Remarks']);
    expect(out.total_rows).toBe(5);
    expect(out.mapping).toMatchObject({ Name: 'full_name', Mobile: 'phone', Email: 'email', Course: 'course' });
    // the quoted field survived parsing
    expect(out.sample[0].Name).toBe('Sharma, Priya');
    expect(out.sample[0].Remarks).toContain('"evening" batch, weekdays');
  });

  it('parse() rejects an empty file and a header-only file', async () => {
    const { db } = makeDb();
    await expect(makeSvc(db).parse('')).rejects.toThrow(BadRequestException);
    await expect(makeSvc(db).parse('Name,Phone\n')).rejects.toThrow(/no data rows/);
  });

  it('parse() enforces the size guard', async () => {
    const { db } = makeDb();
    const big = 'Name,Phone\n' + 'x,9811100001\n'.repeat(Math.ceil(MAX_CSV_BYTES / 12) + 10);
    await expect(makeSvc(db).parse(big)).rejects.toThrow(/too large|Too many rows/i);
  });

  it('preview() counts valid / duplicate / error rows and gives a reason per row', async () => {
    const { db } = makeDb(['+919811100001']);   // row 1 already exists in the CRM
    const p = await makeSvc(db).preview(CSV, MAPPING, 5, 7, ALL_SCOPE, 1);
    expect(p.total).toBe(5);
    expect(p.valid).toBe(1);        // Ravi
    expect(p.duplicates).toBe(2);   // Priya (existing lead) + Dup Ravi (repeat in file)
    expect(p.errors).toBe(2);       // bad phone/email + missing mobile
    expect(p.duplicate_action).toBe('ignore');

    const byRow = Object.fromEntries(p.rows.map((r) => [r.row_num, r]));
    expect(byRow[1].status).toBe('duplicate');
    expect(byRow[1].duplicate_of).toBe(900);
    expect(byRow[2].status).toBe('valid');
    expect(byRow[3].reason).toMatch(/repeats earlier in this file/);
    expect(byRow[4].status).toBe('error');
    expect(byRow[4].reason).toMatch(/Invalid mobile/);
    expect(byRow[5].reason).toMatch(/Mobile number is required/);
  });

  it('preview() rejects a mapping without the mandatory fields', async () => {
    const { db } = makeDb();
    await expect(makeSvc(db).preview(CSV, { Name: 'full_name' }, 5, 7, ALL_SCOPE, 1))
      .rejects.toThrow(/Mobile Number/);
  });

  it('RBAC — a scoped user cannot preview or import into a campaign outside their scope', async () => {
    const { db, jobs } = makeDb();
    const svc = makeSvc(db, false);   // enforcer says: out of scope
    await expect(svc.preview(CSV, MAPPING, 5, 7, SCOPED, 1)).rejects.toThrow(NotFoundException);
    await expect(svc.enqueue({ csv: CSV, mapping: MAPPING, campaign_id: 5, source_id: 7 }, SCOPED, 1))
      .rejects.toThrow(NotFoundException);
    expect(jobs).toHaveLength(0);     // nothing was written
  });

  it('enqueue() writes one durable job per row with a stable dedupe key', async () => {
    const { db, jobs, batches } = makeDb();
    const batch = await makeSvc(db).enqueue({ csv: CSV, mapping: MAPPING, campaign_id: 5, source_id: 7, file_name: 'leads.csv' }, ALL_SCOPE, 1);
    expect(batch.total_rows).toBe(5);
    expect(batches).toHaveLength(1);
    expect(jobs).toHaveLength(5);
    expect(jobs.map((j) => j.row_num)).toEqual([1, 2, 3, 4, 5]);
    // rows 2 and 3 differ (different name) -> different keys; re-uploading the SAME
    // file produces the SAME keys, which is what makes re-import a no-op.
    const again = makeDb();
    await makeSvc(again.db).enqueue({ csv: CSV, mapping: MAPPING, campaign_id: 5, source_id: 7 }, ALL_SCOPE, 1);
    expect(again.jobs.map((j) => j.dedupe_key)).toEqual(jobs.map((j) => j.dedupe_key));
  });

  it('template() is itself a valid, parseable CSV', async () => {
    const { db } = makeDb();
    const svc = makeSvc(db);
    const parsed = await svc.parse(svc.template());
    expect(parsed.total_rows).toBe(1);
    expect(parsed.mapping['Name']).toBe('full_name');
    expect(parsed.mapping['Mobile Number']).toBe('phone');
  });
});
