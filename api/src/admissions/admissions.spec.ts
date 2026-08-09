import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { PERMISSION_KEY, IS_PUBLIC_KEY } from '../rbac/rbac.decorators';
import { PERMISSION_CATALOG } from '../rbac/permission-catalog';
import { readFileSync } from 'fs';
import { join } from 'path';
import { AdmissionController } from './admission.controller';
import { PublicAdmissionController } from './public-admission.controller';
import { StudentController } from '../students/student.controller';
import { AdmissionService } from './admission.service';
import { KIND_DEFAULTS } from '../numbering/numbering.service';

/* --------------------------------------------------------------- RBAC census */
function routesOf(ctrl: any) {
  const proto = ctrl.prototype;
  const classPublic = Reflect.getMetadata(IS_PUBLIC_KEY, ctrl) === true;
  return Object.getOwnPropertyNames(proto).filter((m) => m !== 'constructor' && typeof proto[m] === 'function'
    && Reflect.getMetadata(METHOD_METADATA, proto[m]) !== undefined).map((m) => ({
    handler: m,
    permission: Reflect.getMetadata(PERMISSION_KEY, proto[m]) as string | undefined,
    public: classPublic || Reflect.getMetadata(IS_PUBLIC_KEY, proto[m]) === true,
  }));
}
const CATALOG_KEYS = new Set(PERMISSION_CATALOG.flatMap((m) => m.actions.map((a) => `${m.module}.${a}`)));

describe('Admissions RBAC census', () => {
  it('every AdmissionController route requires a permission that exists in the catalog', () => {
    const routes = routesOf(AdmissionController);
    expect(routes.filter((r) => !r.permission).map((r) => r.handler)).toEqual([]);
    expect(routes.filter((r) => !CATALOG_KEYS.has(r.permission!)).map((r) => r.permission)).toEqual([]);
  });
  it('the public admission controller is deliberately public (self-serve intake carries no JWT)', () => {
    const routes = routesOf(PublicAdmissionController);
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.every((r) => r.public)).toBe(true);
  });
  it('the sibling link/unlink routes reuse student.update; sibling read reuses student.read', () => {
    const routes = routesOf(StudentController);
    const link = routes.find((r) => r.handler === 'linkSibling');
    const unlink = routes.find((r) => r.handler === 'unlinkSibling');
    const read = routes.find((r) => r.handler === 'siblings');
    expect(link?.permission).toBe('student.update');
    expect(unlink?.permission).toBe('student.update');
    expect(read?.permission).toBe('student.read');
  });
  it('the admission module + actions are declared in the catalog', () => {
    const mod = PERMISSION_CATALOG.find((m) => m.module === 'admission');
    expect(mod).toBeDefined();
    expect(mod!.actions.sort()).toEqual(['delete', 'manage', 'read', 'review']);
  });
  it('migration 049 seeds + grants every admission.* permission the catalog declares', () => {
    const sql = readFileSync(join(__dirname, '..', '..', 'db', 'migrations', '049_erp_admission_family.sql'), 'utf8');
    const keys = ['admission.read', 'admission.manage', 'admission.review', 'admission.delete'];
    const ungranted = keys.filter((k) => !new RegExp(`'${k.replace('.', '\\.')}'\\s*,\\s*'`).test(sql));
    expect(ungranted).toEqual([]);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS admission_form/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS admission\b/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS family_group/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS family_group_id/);
  });
  it('the admission numbering series (ADM-) is registered', () => {
    expect(KIND_DEFAULTS.admission).toBeDefined();
    expect(KIND_DEFAULTS.admission.prefix).toBe('ADM-');
  });
});

/* ---------------------------------------------- functional (stubbed DB) tests */
function makeService() {
  const inserts: any[] = [];
  const db: any = {
    async one(sql: string, params: any[] = []) {
      if (/FROM organisation/.test(sql)) return { id: '1' };
      if (/FROM admission_form WHERE form_key/.test(sql)) return { id: 7, is_active: true, branch_id: null, vertical_id: null, course_id: null };
      if (/FROM vertical WHERE id=/.test(sql)) return { id: params[0] };
      if (/FROM m_course WHERE id=/.test(sql)) return { id: params[0] };
      if (/INSERT INTO admission \(/.test(sql)) { inserts.push({ sql, params }); return { id: '99' }; }
      return null;
    },
    async query() { return []; },
    async tx(fn: any) { return fn({ query: async () => ({ rows: [{ id: '1' }] }) }); },
  };
  const resolver: any = { buildScopeWhere: () => 'TRUE' };
  const numbering: any = { allocate: async () => 'ADM-0001' };
  const students: any = { create: async () => ({ id: 55, student_no: 'STU-0001' }) };
  const svc = new AdmissionService(db, resolver, numbering, students);
  return { svc, inserts };
}

describe('Public admission submit — guarded intake', () => {
  it('a honeypot hit is silently accepted and creates nothing', async () => {
    const { svc, inserts } = makeService();
    const out = await svc.submitPublic('k', { _hp: 'iamabot', full_name: 'X', phone: '+919812345678', branch_id: 1, vertical_id: 2 }, { ip: '1.1.1.1' });
    expect(out).toEqual({ ok: true });
    expect(inserts.length).toBe(0);
  });
  it('rejects an invalid Aadhaar (must be 12 digits)', async () => {
    const { svc } = makeService();
    await expect(svc.submitPublic('k', { full_name: 'A', phone: '+919812345678', aadhaar: '123', branch_id: 1, vertical_id: 2 }, { ip: '2.2.2.2' }))
      .rejects.toThrow(/Aadhaar/);
  });
  it('rejects an invalid Indian pincode (must be 6 digits)', async () => {
    const { svc } = makeService();
    await expect(svc.submitPublic('k', { full_name: 'A', phone: '+919812345678', pincode: '12', branch_id: 1, vertical_id: 2 }, { ip: '3.3.3.3' }))
      .rejects.toThrow(/pincode/);
  });
  it('requires a name and a phone', async () => {
    const { svc } = makeService();
    await expect(svc.submitPublic('k', { phone: '+919812345678', branch_id: 1, vertical_id: 2 }, { ip: '4.4.4.4' })).rejects.toThrow(/name/i);
    await expect(svc.submitPublic('k', { full_name: 'A', branch_id: 1, vertical_id: 2 }, { ip: '4.4.4.5' })).rejects.toThrow(/mobile/i);
  });
  it('creates a pending admission for a valid submission', async () => {
    const { svc, inserts } = makeService();
    const out = await svc.submitPublic('k', { full_name: 'Riya Sharma', phone: '9812345678', aadhaar: '1234 5678 9012', pincode: '110001', branch_id: 1, vertical_id: 2, course_id: 3 }, { ip: '5.5.5.5' });
    expect(out.ok).toBe(true);
    expect(inserts.length).toBe(1);
    const payload = JSON.parse(inserts[0].params[8]);
    expect(payload.full_name).toBe('Riya Sharma');
    expect(payload.aadhaar).toBe('123456789012');   // whitespace stripped
  });
  it('rate-limits abusive bursts (>20 / minute / ip+key)', async () => {
    const { svc } = makeService();
    const body = { full_name: 'A', phone: '+919812345678', branch_id: 1, vertical_id: 2 };
    let ok = 0; let blocked = 0;
    for (let i = 0; i < 25; i++) {
      try { await svc.submitPublic('kk', body, { ip: '9.9.9.9' }); ok++; } catch (e: any) { if (/Too many/.test(e.message)) blocked++; }
    }
    expect(ok).toBe(20);
    expect(blocked).toBe(5);
  });
});

describe('Approve → student', () => {
  it('creates the student via StudentService and marks the admission approved', async () => {
    const inserts: any[] = [];
    const db: any = {
      async one(sql: string) {
        if (/FROM admission a/.test(sql)) return { id: 99, status: 'pending', branch_id: 1, vertical_id: 2, course_id: 3, data: { full_name: 'Riya' } };
        return null;
      },
      async query(sql: string, p: any[]) { inserts.push({ sql, p }); return []; },
      async tx(fn: any) { return fn({ query: async () => ({ rows: [{ id: '1' }] }) }); },
    };
    const resolver: any = { buildScopeWhere: () => 'TRUE' };
    const numbering: any = { allocate: async () => 'ADM-0007' };
    let created: any = null;
    const students: any = { create: async (dto: any) => { created = dto; return { id: 55, student_no: 'STU-0009' }; } };
    const svc = new AdmissionService(db, resolver, numbering, students);
    const out = await svc.approve(99, { id: 3 }, {} as any);
    expect(created.full_name).toBe('Riya');
    expect(created.branch_id).toBe(1);
    expect(out).toMatchObject({ approved: true, student_id: 55, admission_no: 'ADM-0007' });
    expect(inserts.some((i) => /UPDATE admission SET status='approved'/.test(i.sql))).toBe(true);
  });
});
