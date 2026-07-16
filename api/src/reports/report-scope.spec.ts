import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ReportService } from './report.service';
import { ExportService } from './export.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { RbacDataService } from '../rbac/rbac-data.service';
import { DatabaseService } from '../database/database.service';
import { ResolvedScope, UserGrantData } from '../rbac/rbac.types';
import { entityByKey } from './entities';

/**
 * =============================================================================
 * A SHARED REPORT DOES NOT LEAK. THIS IS THE PROOF AT THE SERVICE LEVEL.
 * =============================================================================
 *
 * query-builder.spec.ts proves the SQL is right. This proves the SERVICE asks the right
 * question: that `run()` resolves the scope of THE PERSON RUNNING IT, live, from their
 * own grants — not the owner's, not the sharer's, and not anything stored on the
 * definition.
 *
 * If `execute()` ever took a `ResolvedScope` parameter instead of a `me`, a caller could
 * pass the wrong one and every test here would still pass. So it takes a `me`, and these
 * tests assert the resolution happens inside.
 */

const resolver = new ScopeResolverService();

/** Real grant data, so the REAL resolver runs — not a mocked scope. */
const grantsFor = (userId: number, recordScope: string, branchId: number | null = null): UserGrantData => ({
  userId,
  assignments: [{ roleId: 1, branchId, verticalId: null, pipelineId: null, campaignId: null, teamId: null }],
  rolePermissions: ['lead.read', 'enrolment.read', 'fee.read', 'campaign.read', 'user.read', 'followup.read']
    .map((permissionKey) => ({ roleId: 1, permissionKey, recordScope: recordScope as any, fieldScope: null })),
  teamIds: [],
});

const COUNSELLOR = 3;
const MANAGER = 2;

class FakeDb {
  readonly sql: string[] = [];
  readonly params: unknown[][] = [];
  rows: Record<string, any> = {};
  async query(sql: string, params: unknown[] = []) {
    this.sql.push(sql); this.params.push(params);
    if (/FROM organisation/.test(sql)) return [{ id: '1' }];
    if (/FROM report_definition r/.test(sql)) return this.rows.list ?? [];
    if (/user_assignment ua WHERE ua.user_id/.test(sql)) return [{ role_id: '1' }];
    if (/FROM report_share s/.test(sql)) return this.rows.shares ?? [];
    return this.rows.run ?? [];
  }
  async one(sql: string, params: unknown[] = []) {
    this.sql.push(sql); this.params.push(params);
    if (/FROM organisation/.test(sql)) return { id: '1' } as any;
    if (/SELECT \* FROM report_definition WHERE id/.test(sql)) return this.rows.def ?? null;
    if (/EXISTS \(SELECT 1 FROM report_share/.test(sql)) return { ok: this.rows.sharedToMe === true } as any;
    if (/INSERT INTO report_definition/.test(sql)) return { id: '11' } as any;
    return null;
  }
  async tx(fn: any) { return fn({ query: async () => ({ rows: [] }) }); }
  find(re: RegExp) { return this.sql.find((s) => re.test(s)); }
}

const scopeOf = (all: boolean): ResolvedScope => ({
  permissionKey: 'report.read', allowed: true, all, filters: all ? [] : [{ kind: 'own', userId: COUNSELLOR }],
  allowedFields: null, deniedFields: [],
});

/** A ReportService whose grant loader answers per user — the real thing, not a mock. */
const build = (grants: Record<number, UserGrantData>) => {
  const db = new FakeDb();
  const rbac = { loadUserGrants: async (uid: number) => grants[uid] } as unknown as RbacDataService;
  const svc = new ReportService(db as unknown as DatabaseService, rbac, resolver);
  return { db, svc };
};

describe('THE SHARED-REPORT RULE — the same definition, two runners, two answers', () => {
  const grants = {
    [MANAGER]: grantsFor(MANAGER, 'branch', 9),
    [COUNSELLOR]: grantsFor(COUNSELLOR, 'own'),
  };

  it("a MANAGER's run carries `l.branch_id = 9`", async () => {
    const { db, svc } = build(grants);
    await svc.execute(entityByKey('leads')!, { columns: ['full_name'] }, { id: MANAGER });
    const q = db.find(/FROM lead l/)!;
    expect(q).toMatch(/l\.branch_id = \$\d+/);
    expect(db.params.flat()).toContain(9);
  });

  it("a COUNSELLOR's run of THE SAME definition carries `l.owner_id = 3` and NOT the branch", async () => {
    const { db, svc } = build(grants);
    await svc.execute(entityByKey('leads')!, { columns: ['full_name'] }, { id: COUNSELLOR });
    const q = db.find(/FROM lead l/)!;
    expect(q).toMatch(/l\.owner_id = \$\d+/);
    expect(q).not.toMatch(/l\.branch_id = \$\d+/);
    expect(db.params.flat()).toContain(COUNSELLOR);
    expect(db.params.flat()).not.toContain(9);
  });

  /**
   * THE ONE THAT PROVES THE DESIGN. A report SAVED and SHARED by a manager, RUN by a
   * counsellor, must be the counsellor's rows. There is nothing on the definition to
   * inherit — `run()` takes a `me`, so the wrong scope is not passable.
   */
  it('a report OWNED by a manager and SHARED to a counsellor runs in the COUNSELLOR\'S scope', async () => {
    const { db, svc } = build(grants);
    db.rows.def = { id: 5, name: 'Branch leads', entity: 'leads', config: { columns: ['full_name'] }, owner_id: MANAGER, is_standard: false };
    db.rows.sharedToMe = true;

    await svc.run(5, { id: COUNSELLOR }, scopeOf(false));
    const q = db.find(/FROM lead l/)!;
    expect(q).toMatch(/l\.owner_id = \$\d+/);
    // `l.branch_id` appears in the entity's own `LEFT JOIN branch br ON br.id = l.branch_id`,
    // which is a display join, not a filter. The thing that must NOT be there is a branch
    // PREDICATE — so match the comparison, not the column name.
    expect(q).not.toMatch(/l\.branch_id = \$\d+/);
    expect(db.params.flat()).not.toContain(9);
  });

  it('and the payload TELLS the counsellor his view is narrowed', async () => {
    const { db, svc } = build(grants);
    db.rows.def = { id: 5, name: 'Branch leads', entity: 'leads', config: { columns: ['full_name'] }, owner_id: MANAGER, is_standard: false };
    db.rows.sharedToMe = true;
    const out = await svc.run(5, { id: COUNSELLOR }, scopeOf(false));
    expect(out.scope.unrestricted).toBe(false);
    expect(out.scope.note).toContain('only the records your role');
    expect(out.scope.user_id).toBe(COUNSELLOR);
  });

  /**
   * A receipts report shared to somebody with no `fee.read` must be EMPTY WITH A REASON —
   * not a 500 (which looks like a broken app), and obviously not a leak.
   */
  it('a report on an entity the runner CANNOT read is empty AND says why — never a 500, never a leak', async () => {
    const noFees: UserGrantData = {
      userId: 9, assignments: [{ roleId: 1, branchId: null, verticalId: null, pipelineId: null, campaignId: null, teamId: null }],
      rolePermissions: [{ roleId: 1, permissionKey: 'lead.read', recordScope: 'own', fieldScope: null }],
      teamIds: [],
    };
    const { db, svc } = build({ 9: noFees });
    const out = await svc.execute(entityByKey('receipts')!, { columns: ['receipt_no'] }, { id: 9 });
    const q = db.find(/FROM fee_receipt fr/)!;
    expect(q).toContain('1=0');
    expect(out.rows).toEqual([]);
    expect(out.scope.note).toContain('do not have access to Fee receipts');
  });

  it('entitiesFor() offers only what the user can actually read', async () => {
    const onlyLeads: UserGrantData = {
      userId: 9, assignments: [{ roleId: 1, branchId: null, verticalId: null, pipelineId: null, campaignId: null, teamId: null }],
      rolePermissions: [{ roleId: 1, permissionKey: 'lead.read', recordScope: 'own', fieldScope: null }],
      teamIds: [],
    };
    const { svc } = build({ 9: onlyLeads });
    expect(await svc.entitiesFor({ id: 9 })).toEqual(['leads']);
  });
});

describe('visibility of the DEFINITION (which is not visibility of the data)', () => {
  const grants = { [COUNSELLOR]: grantsFor(COUNSELLOR, 'own') };

  it('a report that is not mine, not shared to me and not standard is a 404', async () => {
    const { db, svc } = build(grants);
    db.rows.def = { id: 5, name: 'Secret', entity: 'leads', config: {}, owner_id: MANAGER, is_standard: false };
    db.rows.sharedToMe = false;
    await expect(svc.get(5, { id: COUNSELLOR }, scopeOf(false))).rejects.toThrow(NotFoundException);
  });

  it('a 404, not a 403 — a 403 confirms the report exists', async () => {
    const { db, svc } = build(grants);
    db.rows.def = { id: 5, name: 'Secret', entity: 'leads', config: {}, owner_id: MANAGER, is_standard: false };
    db.rows.sharedToMe = false;
    await expect(svc.run(5, { id: COUNSELLOR }, scopeOf(false))).rejects.toThrow(NotFoundException);
  });

  it('an admin with report.read at `all` sees every definition', async () => {
    const { db, svc } = build({ [MANAGER]: grantsFor(MANAGER, 'branch', 9) });
    db.rows.def = { id: 5, name: 'Someone else\'s', entity: 'leads', config: {}, owner_id: 99, is_standard: false };
    db.rows.shares = [];
    await expect(svc.get(5, { id: MANAGER }, scopeOf(true))).resolves.toBeTruthy();
  });

  it('nobody edits a STANDARD report — "Save as" makes a copy, and the message says so', async () => {
    const { db, svc } = build({ [MANAGER]: grantsFor(MANAGER, 'branch', 9) });
    db.rows.def = { id: 5, name: 'Lead status report', entity: 'leads', config: {}, owner_id: null, is_standard: true };
    await expect(svc.update(5, { name: 'mine now' }, { id: MANAGER }, scopeOf(true))).rejects.toThrow(/Save as/);
    await expect(svc.remove(5, { id: MANAGER }, scopeOf(true))).rejects.toThrow(ForbiddenException);
  });

  it('a non-owner cannot edit somebody else\'s report even if it is shared to them', async () => {
    const { db, svc } = build(grants);
    db.rows.def = { id: 5, name: 'Manager report', entity: 'leads', config: {}, owner_id: MANAGER, is_standard: false };
    db.rows.sharedToMe = true;
    await expect(svc.update(5, { name: 'hijacked' }, { id: COUNSELLOR }, scopeOf(false))).rejects.toThrow(/owner/);
  });
});

describe('SAVING a report validates it against the SAVER\'s access', () => {
  it('you cannot save a report on data you cannot read', async () => {
    const noFees: UserGrantData = {
      userId: 9, assignments: [{ roleId: 1, branchId: null, verticalId: null, pipelineId: null, campaignId: null, teamId: null }],
      rolePermissions: [{ roleId: 1, permissionKey: 'lead.read', recordScope: 'own', fieldScope: null }],
      teamIds: [],
    };
    const { svc } = build({ 9: noFees });
    await expect(svc.create({ name: 'Cash', entity: 'receipts', config: {} }, { id: 9 }, scopeOf(false)))
      .rejects.toThrow(/do not have access to Fee receipts/);
  });

  /**
   * Validate at SAVE, not only at RUN. A saved report with a bad column key that only
   * fails at 08:00 next Monday inside a scheduled email is a support call nobody can
   * trace back to the click that caused it.
   */
  it('a bad column is rejected AT SAVE TIME, before the row is written', async () => {
    const { svc } = build({ [MANAGER]: grantsFor(MANAGER, 'branch', 9) });
    await expect(svc.create({ name: 'Bad', entity: 'leads', config: { columns: ['nope'] } }, { id: MANAGER }, scopeOf(true)))
      .rejects.toThrow(/Unknown column "nope"/);
  });

  it('an unnamed report is refused', async () => {
    const { svc } = build({ [MANAGER]: grantsFor(MANAGER, 'branch', 9) });
    await expect(svc.create({ name: '  ', entity: 'leads', config: {} }, { id: MANAGER }, scopeOf(true)))
      .rejects.toThrow(/needs a name/);
  });

  /** `config` is not a place to smuggle. Whatever arrives, only the contract keys land. */
  it('the config is STRIPPED to the contract — extra keys never reach the database', async () => {
    const { db, svc } = build({ [MANAGER]: grantsFor(MANAGER, 'branch', 9) });
    db.rows.def = { id: 11, name: 'x', entity: 'leads', config: {}, owner_id: MANAGER, is_standard: false };
    await svc.create({
      name: 'x', entity: 'leads',
      config: { columns: ['full_name'], evil: 'DROP TABLE lead', __proto__: { polluted: true }, sql: 'SELECT 1' },
    }, { id: MANAGER }, scopeOf(true));
    const insert = db.params[db.sql.findIndex((s) => /INSERT INTO report_definition/.test(s))];
    const stored = JSON.parse(String(insert.find((p) => typeof p === 'string' && p.startsWith('{'))));
    const CONTRACT = ['columns', 'filters', 'group_by', 'sort', 'date_field', 'date_preset', 'date_from', 'date_to', 'limit'];
    // Every stored key is IN the contract. (Not "equals the contract": cleanConfig leaves
    // unset optionals `undefined`, and JSON.stringify drops those — which is right.)
    expect(Object.keys(stored).filter((k) => !CONTRACT.includes(k))).toEqual([]);
    expect(JSON.stringify(stored)).not.toContain('DROP TABLE');
    expect(JSON.stringify(stored)).not.toContain('SELECT 1');
    expect(stored.evil).toBeUndefined();
    expect(stored.sql).toBeUndefined();
    expect(stored.polluted).toBeUndefined();
    expect(({} as any).polluted).toBeUndefined();   // and nothing was prototype-polluted
  });
});

describe('EXPORTS are scoped to the REQUESTER, and only the requester downloads them', () => {
  it('an export renders in `requested_by`\'s scope — not the worker\'s, not an admin\'s', async () => {
    const db = new FakeDb();
    (db as any).one = async (sql: string) => {
      if (/SELECT \* FROM report_export WHERE id/.test(sql)) {
        return { id: 1, entity: 'leads', config: { columns: ['full_name'], _name: 'R' }, format: 'csv', requested_by: COUNSELLOR, status: 'running' };
      }
      return null;
    };
    let ranAs: number | null = null;
    const reports = {
      execute: async (_e: unknown, _c: unknown, me: { id: number }) => {
        ranAs = me.id;
        return { columns: [{ key: 'full_name', label: 'Name', type: 'text' }], rows: [], row_count: 0, grouped: false, truncated: false, entity: 'leads', entity_label: 'Leads', report: null, scope: { user_id: me.id, unrestricted: false, note: 'n' }, generated_at: '' };
      },
    };
    const svc = new ExportService(db as unknown as DatabaseService, reports as unknown as ReportService);
    await svc.render(1);
    expect(ranAs).toBe(COUNSELLOR);
  });

  it('you cannot download somebody else\'s export (it is a file of THEIR scoped rows)', async () => {
    const db = new FakeDb();
    (db as any).one = async (_sql: string, params: unknown[]) => {
      // the query filters on requested_by — a different user matches nothing
      const [, uid] = params as [number, number];
      return uid === COUNSELLOR ? { id: 1, status: 'ready', bytes: Buffer.from('x'), file_name: 'r.csv', format: 'csv' } : null;
    };
    const svc = new ExportService(db as unknown as DatabaseService, {} as ReportService);
    await expect(svc.download(1, { id: COUNSELLOR })).resolves.toBeTruthy();
    await expect(svc.download(1, { id: 999 })).rejects.toThrow(NotFoundException);
  });

  /** Fail at the BUTTON, not two minutes later in a red row the client cannot trace. */
  it('a PDF export with too many columns is refused SYNCHRONOUSLY, at the click', async () => {
    const db = new FakeDb();
    const svc = new ExportService(db as unknown as DatabaseService, {} as ReportService);
    const cols = entityByKey('leads')!.columns.slice(0, 20).map((c) => c.key);
    await expect(svc.queueAdhoc({ entity: 'leads', config: { columns: cols }, format: 'pdf' }, { id: 1 }))
      .rejects.toThrow(/Excel/);
  });

  it('an unknown format is refused with the value quoted', async () => {
    const db = new FakeDb();
    const svc = new ExportService(db as unknown as DatabaseService, {} as ReportService);
    await expect(svc.queueAdhoc({ entity: 'leads', config: {}, format: 'docx' }, { id: 1 })).rejects.toThrow(/docx/);
  });

  it('a failed render is RECORDED on the row with its reason, never thrown into the void', async () => {
    const db = new FakeDb();
    let updated = '';
    (db as any).one = async (sql: string) => (/SELECT \* FROM report_export/.test(sql)
      ? { id: 1, entity: 'leads', config: {}, format: 'xlsx', requested_by: 1, status: 'running' } : null);
    (db as any).query = async (sql: string, p: unknown[]) => { if (/status = 'failed'/.test(sql)) updated = String(p[1]); return []; };
    const reports = { execute: async () => { throw new Error('column "x" does not exist'); } };
    const svc = new ExportService(db as unknown as DatabaseService, reports as unknown as ReportService);
    expect(await svc.render(1)).toBe('failed');
    expect(updated).toContain('column "x" does not exist');
  });
});
