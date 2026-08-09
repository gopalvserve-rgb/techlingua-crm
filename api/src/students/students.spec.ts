import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { StudentService } from './student.service';
import { StudentController } from './student.controller';
import { BatchController } from './batch.controller';
import { PERMISSION_KEY, IS_PUBLIC_KEY } from '../rbac/rbac.decorators';
import { PERMISSION_CATALOG } from '../rbac/permission-catalog';
import { ResolvedScope } from '../rbac/rbac.types';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * STUDENTS & BATCHES — unit coverage for the "Convert to Student" behaviour (creates a
 * student, wins the lead, idempotent), plus the RBAC census (every route guarded, every
 * key in the catalog, migration 044 grants them) mirroring the sprint-5 RBAC spec.
 */

const scopeAll: ResolvedScope = { permissionKey: 'student.read', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [] };
const scopeOwn = (u: number): ResolvedScope => ({ permissionKey: 'student.read', allowed: true, all: false, filters: [{ kind: 'own', userId: u }], allowedFields: null, deniedFields: [] });

const resolver = {
  buildScopeWhere: (scope: ResolvedScope, cols: any, params: unknown[]) => {
    if (scope.all) return '1=1';
    const f = scope.filters[0];
    if (f?.kind === 'own') { params.push(f.userId); return `${cols.owner} = $${params.length}`; }
    return '1=0';
  },
};

const LEAD = (over: any = {}) => ({
  id: 10, org_id: 1, branch_id: 9, vertical_id: 3, pipeline_id: 4, campaign_id: 5,
  owner_id: 5, team_id: null, full_name: 'Asha Rao', phone: '+919812345678',
  email: 'asha@x.io', course_id: 100, stage_id: 20, ...over,
});

function make(opts: { lead?: any; existing?: any; enrolment?: any; wonStage?: any } = {}) {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    one: async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      if (/FROM organisation/.test(sql)) return { id: 1 };
      if (/FROM lead l\s+WHERE l\.id/.test(sql)) return opts.lead === null ? null : (opts.lead ?? LEAD());
      if (/FROM student WHERE lead_id/.test(sql)) return opts.existing ?? null;
      if (/FROM enrolment\s+WHERE lead_id/.test(sql)) return opts.enrolment ?? null;
      return null;
    },
    query: async (sql: string, params: unknown[] = []) => { issued.push({ sql, params }); return []; },
    tx: async (fn: any) => fn({
      query: async (sql: string, params: unknown[] = []) => {
        issued.push({ sql, params });
        if (/INSERT INTO student/.test(sql)) return { rows: [{ id: 501 }] };
        if (/FROM pipeline_stage/.test(sql)) return { rows: opts.wonStage ? [opts.wonStage] : [] };
        return { rows: [] };
      },
    }),
  };
  const svc = new StudentService(db as never, resolver as never);
  return { svc, issued };
}

const has = (issued: any[], re: RegExp) => issued.some((i) => re.test(i.sql));

describe('StudentService.convert', () => {
  it('creates the student, wins the lead, and writes the activity (first conversion)', async () => {
    const { svc, issued } = make({ wonStage: { id: 77, name: 'Won' } });
    const out = await svc.convert({ lead_id: 10 }, { id: 5 }, scopeAll);
    expect(out.already).toBe(false);
    expect((out as any).student_no).toBe('STU-00501');
    expect(has(issued, /INSERT INTO student/)).toBe(true);
    expect(has(issued, /UPDATE lead SET stage_id/)).toBe(true);           // WON
    expect(has(issued, /INSERT INTO lead_activity/)).toBe(true);          // activity
  });

  it('is IDEMPOTENT — an already-converted lead returns the existing student, makes no new one', async () => {
    const { svc, issued } = make({ existing: { id: 501, student_no: 'STU-00501', full_name: 'Asha Rao', status: 'active' } });
    const out = await svc.convert({ lead_id: 10 }, { id: 5 }, scopeAll);
    expect(out.already).toBe(true);
    expect((out as any).student_no).toBe('STU-00501');
    expect(has(issued, /INSERT INTO student/)).toBe(false);
  });

  it('links the enrolment (seam) when the lead already has one', async () => {
    const { svc, issued } = make({ enrolment: { id: 900, course_id: 100 }, wonStage: { id: 77, name: 'Won' } });
    await svc.convert({ lead_id: 10 }, { id: 5 }, scopeAll);
    expect(has(issued, /UPDATE enrolment SET student_profile_id/)).toBe(true);
  });

  it('does NOT fail conversion when the pipeline has no won stage (a taxonomy must not block it)', async () => {
    const { svc, issued } = make({ wonStage: null });
    const out = await svc.convert({ lead_id: 10 }, { id: 5 }, scopeAll);
    expect(out.already).toBe(false);
    expect(has(issued, /UPDATE lead SET stage_id/)).toBe(false);          // no won stage -> no move
    expect(has(issued, /INSERT INTO student/)).toBe(true);                // …but the student still exists
  });

  it('rejects a missing lead_id', async () => {
    const { svc } = make();
    await expect(svc.convert({}, { id: 5 }, scopeAll)).rejects.toThrow();
  });

  it('the scoped list threads the RBAC fragment (own -> owner column) into the query', async () => {
    const { svc, issued } = make();
    await svc.list(scopeOwn(5), {});
    const q = issued.find((i) => /FROM student s/.test(i.sql));
    expect(q).toBeTruthy();
    expect(q!.sql).toMatch(/s\.owner_id = \$/);
  });
});

/* ------------------------------- RBAC census ------------------------------- */
const CATALOG_KEYS = new Set(PERMISSION_CATALOG.flatMap((m) => m.actions.map((a) => `${m.module}.${a}`)));
const routesOf = (ctrl: any) => {
  const proto = ctrl.prototype;
  return Object.getOwnPropertyNames(proto)
    .filter((m) => m !== 'constructor' && typeof proto[m] === 'function' && Reflect.getMetadata(METHOD_METADATA, proto[m]) !== undefined)
    .map((m) => ({
      handler: m,
      permission: Reflect.getMetadata(PERMISSION_KEY, proto[m]) as string | undefined,
      public: Reflect.getMetadata(IS_PUBLIC_KEY, proto[m]) === true,
    }));
};
const ALL = [...routesOf(StudentController), ...routesOf(BatchController)];

describe('Students & Batches RBAC', () => {
  it('EVERY route requires a permission — none is unguarded or public', () => {
    expect(ALL.filter((r) => !r.permission || r.public).map((r) => r.handler)).toEqual([]);
  });
  it('every permission a route names exists in the catalog', () => {
    expect(ALL.filter((r) => r.permission && !CATALOG_KEYS.has(r.permission)).map((r) => r.permission)).toEqual([]);
  });
  it('migration 044 GRANTS every student.* / batch.* permission the catalog declares', () => {
    const sql = readFileSync(join(__dirname, '..', '..', 'db', 'migrations', '044_students_batches.sql'), 'utf8');
    const keys = PERMISSION_CATALOG.filter((m) => ['student', 'batch'].includes(m.module))
      .flatMap((m) => m.actions.map((a) => `${m.module}.${a}`));
    const ungranted = keys.filter((k) => !new RegExp(`'${k.replace('.', '\\.')}'\\s*,\\s*'`).test(sql));
    expect(ungranted).toEqual([]);
  });
  it('a Counsellor can create a student (convert) but cannot delete one', () => {
    const sql = readFileSync(join(__dirname, '..', '..', 'db', 'migrations', '044_students_batches.sql'), 'utf8');
    const granted = (p: string, role: string) => new RegExp(`'${p.replace('.', '\\.')}'\\s*,\\s*'${role}'`).test(sql);
    expect(granted('student.create', 'Counsellor')).toBe(true);
    expect(granted('student.delete', 'Counsellor')).toBe(false);
    expect(granted('student.delete', 'Organization Admin')).toBe(true);
  });
});
