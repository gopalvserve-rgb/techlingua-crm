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

/** A fake R2 StorageService for the AdmissionService unit tests. */
function fakeStorage(configured: boolean, sink?: { puts: any[]; presigns: string[] }) {
  return {
    isConfigured: async () => configured,
    studentDocKey: (o: any) => `students/admission-${o.admissionId}/docs/uuid-${o.fileName}`,
    putObject: async (key: string, bytes: Buffer, ct: string) => { sink?.puts.push({ key, len: bytes.length, ct }); return { key }; },
    getObject: async (_key: string) => ({ body: Buffer.from('r2-bytes'), contentType: 'image/png' }),
    presignGet: async (key: string) => { const u = `https://r2.example/${key}?sig=abc`; sink?.presigns.push(u); return u; },
  } as any;
}


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
    // 'approve' = the authorized-person admission-journey approval (migration 075), granted to
    // Academic Admin / Branch Manager / Org / Super Admin. The other four are the online-form
    // review queue (migration 049).
    expect(mod!.actions.sort()).toEqual(['approve', 'delete', 'manage', 'read', 'review']);
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
  const svc = new AdmissionService(db, resolver, numbering, students, fakeStorage(false));
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
    const svc = new AdmissionService(db, resolver, numbering, students, fakeStorage(false));
    const out = await svc.approve(99, { id: 3 }, {} as any);
    expect(created.full_name).toBe('Riya');
    expect(created.branch_id).toBe(1);
    expect(out).toMatchObject({ approved: true, student_id: 55, admission_no: 'ADM-0007' });
    expect(inserts.some((i) => /UPDATE admission SET status='approved'/.test(i.sql))).toBe(true);
  });
});

describe('Admission document attachments (education + KYC)', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64');

  function makeDocDb(admissionRow?: any, storage?: any) {
    const queries: any[] = [];
    const db: any = {
      async one(sql: string, params: any[] = []) {
        if (/FROM organisation/.test(sql)) return { id: '1' };
        if (/FROM admission_form WHERE form_key/.test(sql)) return { id: 7, is_active: true, branch_id: 1, vertical_id: 2, course_id: 3 };
        if (/FROM vertical WHERE id=/.test(sql)) return { id: params[0] };
        if (/FROM m_course WHERE id=/.test(sql)) return { id: params[0] };
        if (/INSERT INTO admission \(/.test(sql)) return { id: '99' };
        if (/FROM admission a/.test(sql)) return admissionRow ?? { id: 99, status: 'pending', branch_id: 1, vertical_id: 2, course_id: 3, data: { full_name: 'Riya' } };
        if (/SELECT file_name, mime, content.*FROM student_document/.test(sql)) return { file_name: 'me.png', mime: 'image/png', content: Buffer.from('hello'), r2_key: null };
        if (/SELECT file_name, r2_key FROM student_document/.test(sql)) return { file_name: 'me.png', r2_key: 'students/admission-99/docs/uuid-me.png' };
        return null;
      },
      async query(sql: string, params: any[] = []) { queries.push({ sql, params }); return []; },
      async tx(fn: any) { return fn({ query: async () => ({ rows: [{ id: '1' }] }) }); },
    };
    const resolver: any = { buildScopeWhere: () => 'TRUE' };
    const numbering: any = { allocate: async () => 'ADM-0007' };
    const students: any = { create: async () => ({ id: 55, student_no: 'STU-0009' }) };
    const svc = new AdmissionService(db, resolver, numbering, students, storage ?? fakeStorage(false));
    return { svc, queries };
  }

  it('a public submit STORES each attached document as a student_document row (bytes never logged)', async () => {
    const { svc, queries } = makeDocDb();
    const out: any = await svc.submitPublic('k', {
      full_name: 'Riya Sharma', phone: '9812345678', branch_id: 1, vertical_id: 2, course_id: 3,
      documents: [
        { doc_type: 'photo', file_name: 'me.png', mime: 'image/png', content: b64('hello-png') },
        { doc_type: 'aadhaar', file_name: 'aadhaar.pdf', mime: 'application/pdf', content: b64('%PDF-1.4') },
      ],
    }, { ip: '5.5.5.9' });
    expect(out.documents).toBe(2);
    const docInserts = queries.filter((q) => /INSERT INTO student_document/.test(q.sql));
    expect(docInserts).toHaveLength(2);
    // linked to the created admission, storing a Buffer (bytea), type + size captured.
    expect(docInserts[0].params[1]).toBe(99);              // admission_id
    expect(Buffer.isBuffer(docInserts[0].params[6])).toBe(true);
  });

  it('rejects a submit whose attachment is a disallowed type', async () => {
    const { svc } = makeDocDb();
    await expect(svc.submitPublic('k', {
      full_name: 'A', phone: '9812345678', branch_id: 1, vertical_id: 2,
      documents: [{ doc_type: 'other', file_name: 'x.exe', mime: 'application/x-msdownload', content: b64('MZ') }],
    }, { ip: '5.5.5.8' })).rejects.toThrow(/PDF, JPG or PNG/);
  });

  it('approve CARRIES documents over to the new student (student_id set from admission_id)', async () => {
    const { svc, queries } = makeDocDb();
    await svc.approve(99, { id: 3 }, {} as any);
    const carry = queries.find((q) => /UPDATE student_document SET student_id=/.test(q.sql));
    expect(carry).toBeTruthy();
    expect(carry.params).toEqual([99, 55]);
  });

  it('R2 CONFIGURED: an attached document is uploaded to R2 and stored as an r2_key (NOT bytea)', async () => {
    const sink = { puts: [] as any[], presigns: [] as string[] };
    const { svc, queries } = makeDocDb(undefined, fakeStorage(true, sink));
    const out: any = await svc.submitPublic('k', {
      full_name: 'Riya Sharma', phone: '9812345678', branch_id: 1, vertical_id: 2, course_id: 3,
      documents: [{ doc_type: 'aadhaar', file_name: 'aadhaar.pdf', mime: 'application/pdf', content: b64('%PDF-1.4') }],
    }, { ip: '5.5.5.9' });
    expect(out.documents).toBe(1);
    // uploaded to R2 with the composed key
    expect(sink.puts).toHaveLength(1);
    expect(sink.puts[0].key).toMatch(/^students\/admission-99\/docs\/uuid-aadhaar.pdf$/);
    const docInsert = queries.find((q) => /INSERT INTO student_document/.test(q.sql));
    // params: [...,content(6), r2_key(7)] — content is NULL, r2_key is set (no DB blob)
    expect(docInsert.params[6]).toBeNull();
    expect(docInsert.params[7]).toBe(sink.puts[0].key);
  });

  it('R2 download returns a short-lived PRESIGNED url (sensitive doc never public)', async () => {
    const sink = { puts: [] as any[], presigns: [] as string[] };
    const { svc } = makeDocDb(undefined, fakeStorage(true, sink));
    const out: any = await svc.downloadDocumentUrl(99, 5, {} as any);
    expect(out.url).toMatch(/^https:\/\/r2\.example\//);
    expect(out.url).toContain('sig=');
    expect(out.expires_in).toBe(300);
  });

  it('download returns the bytes + filename for an in-scope reviewer', async () => {
    const { svc } = makeDocDb();
    const d = await svc.downloadDocument(99, 12, {} as any);
    expect(d.file_name).toBe('me.png');
    expect(d.mime).toBe('image/png');
    expect(d.content.toString()).toBe('hello');
  });
});
