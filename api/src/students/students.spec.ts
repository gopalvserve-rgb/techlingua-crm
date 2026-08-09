import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { StudentService } from './student.service';
import { StudentController } from './student.controller';
import { BatchController } from './batch.controller';
import { PERMISSION_KEY, IS_PUBLIC_KEY } from '../rbac/rbac.decorators';
import { PERMISSION_CATALOG } from '../rbac/permission-catalog';
import { ResolvedScope } from '../rbac/rbac.types';
import { readFileSync } from 'fs';
import { redact } from '../common/redact';
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
      if (/FROM vertical WHERE id/.test(sql)) return { id: 3 };
      if (/FROM m_course WHERE id/.test(sql)) return { id: 100 };
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
  const numbering = { allocate: async (kind: string) => (kind === 'enrollment' ? 'EN-0001' : 'STU-0001') };
  const svc = new StudentService(db as never, resolver as never, numbering as never);
  return { svc, issued };
}

const has = (issued: any[], re: RegExp) => issued.some((i) => re.test(i.sql));

describe('StudentService.convert', () => {
  it('creates the student, wins the lead, and writes the activity (first conversion)', async () => {
    const { svc, issued } = make({ wonStage: { id: 77, name: 'Won' } });
    const out = await svc.convert({ lead_id: 10 }, { id: 5 }, scopeAll);
    expect(out.already).toBe(false);
    expect((out as any).student_no).toBe('STU-0001');
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

describe('StudentService.create (direct Add — the Admission form)', () => {
  const FULL = {
    full_name: 'Neha Verma', branch_id: 9, vertical_id: 3, course_id: 100,
    dob: '2001-05-04', gender: 'Female', nationality: 'Indian',
    registration_date: '2026-08-01', admission_date: '2026-08-05',
    phone: '9810000001', whatsapp_phone: '9810000002', alt_phone: '9810000003', email: 'neha@x.io',
    father_name: 'Mr Verma', father_mobile: '9810000004',
    guardian_name: 'Mrs Verma', guardian_mobile: '9810000005', guardian_email: 'g@x.io', guardian_relation: 'Mother',
    address_line1: 'A-1', address_line2: 'Block C', landmark: 'Near park', country: 'India',
    state_id: 1, city_id: 2, district: 'West', pincode: '110018',
    permanent_address: 'Perm addr', current_address: 'Curr addr',
    id_proof_type: 'Aadhaar', id_proof_number: 'X123', aadhaar: '1234 1234 1234', pan: 'abcde1234f', passport: 'P123',
    qualification: 'B.A.', institution: 'DU', board_university: 'Delhi University', passing_year: 2022, previous_institution: 'ABC School',
  };

  it('persists the full profile, mints Student ID + Enrollment No from the numbering series', async () => {
    const { svc, issued } = make();
    const out = await svc.create(FULL, { id: 5 }, scopeAll);
    expect((out as any).student_no).toBe('STU-0001');
    expect((out as any).enrollment_no).toBe('EN-0001');
    const ins = issued.find((i) => /INSERT INTO student/.test(i.sql))!;
    expect(ins).toBeTruthy();
    // every section reaches the INSERT column list
    for (const col of ['full_name', 'dob', 'gender', 'father_name', 'guardian_relation',
      'state_id', 'city_id', 'pincode', 'aadhaar', 'pan', 'qualification', 'passing_year',
      'student_no', 'enrollment_no']) {
      expect(ins.sql).toMatch(new RegExp(`\\b${col}\\b`));
    }
    // phones normalised to E.164; PAN upper-cased; aadhaar spaces stripped
    expect(ins.params).toContain('+919810000001');
    expect(ins.params).toContain('ABCDE1234F');
    expect(ins.params).toContain('123412341234');
  });

  it('a MANUAL Enrollment No is used as-is (auto only when blank)', async () => {
    const { svc, issued } = make();
    await svc.create({ ...FULL, enrollment_no: 'MYENR-9' }, { id: 5 }, scopeAll);
    const ins = issued.find((i) => /INSERT INTO student/.test(i.sql))!;
    expect(ins.params).toContain('MYENR-9');
  });

  it('rejects a future Date of Birth and a bad Indian pincode', async () => {
    const { svc } = make();
    await expect(svc.create({ ...FULL, dob: '2999-01-01' }, { id: 5 }, scopeAll)).rejects.toThrow(/future/i);
    await expect(svc.create({ ...FULL, pincode: '123' }, { id: 5 }, scopeAll)).rejects.toThrow(/pincode/i);
  });

  it('requires a name, branch and vertical', async () => {
    const { svc } = make();
    await expect(svc.create({ branch_id: 9, vertical_id: 3 }, { id: 5 }, scopeAll)).rejects.toThrow();
    await expect(svc.create({ full_name: 'X' }, { id: 5 }, scopeAll)).rejects.toThrow();
  });

  it('never LOGS the sensitive ID-proof fields (aadhaar / pan / passport)', async () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((m) =>
      jest.spyOn(console, m as any).mockImplementation(() => undefined));
    const { svc } = make();
    await svc.create(FULL, { id: 5 }, scopeAll);
    const printed = spies.flatMap((sp) => sp.mock.calls.flat()).map((x) => String(x)).join(' | ');
    for (const secret of ['123412341234', 'ABCDE1234F', 'P123']) {
      expect(printed).not.toContain(secret);
    }
    spies.forEach((sp) => sp.mockRestore());
  });

  it('the audit/error redactor masks aadhaar / pan / passport / id_proof_number (never persisted in clear)', () => {
    const masked = redact({ aadhaar: '123412341234', pan: 'ABCDE1234F', passport: 'P1234567', id_proof_number: 'X-9', full_name: 'Neha' }) as any;
    expect(masked.aadhaar).toBe('[redacted]');
    expect(masked.pan).toBe('[redacted]');
    expect(masked.passport).toBe('[redacted]');
    expect(masked.id_proof_number).toBe('[redacted]');
    expect(masked.full_name).toBe('Neha');   // non-sensitive fields survive
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

/* =============================================================================
 * STUDENT PROFILE AGGREGATE — GET /students/:id/profile returns EVERY section the
 * tabbed detail view renders (identity/contact/family/address/id/education + academics
 * + certificates + report cards + fees), and stays RBAC-scoped (the student is
 * scope-validated first, so its children inherit the same access).
 * =========================================================================== */
const STUDENT_ROW = {
  id: 7, org_id: 1, student_no: 'STU-0007', enrollment_no: 'EN-0007', full_name: 'Meera Nair',
  status: 'active', branch_id: 9, vertical_id: 3, course_id: 100, batch_id: 5, batch_name: 'Batch A',
  enrolment_id: 55, family_group_id: null, dob: '2001-05-10', phone: '+919812345678',
  father_name: 'Nair', aadhaar: '1234', pan: 'ABCDE', address_line1: 'MG Rd', qualification: 'B.Com',
};

function makeProfileDb() {
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const db: any = {
    one: async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      if (/FROM student s\b/.test(sql) && /WHERE s\.id/.test(sql)) return STUDENT_ROW;
      if (/FROM attendance WHERE student_id/.test(sql)) return { total: 10, present: 8, absent: 1, late: 1, excused: 0 };
      return null;
    },
    query: async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      if (/FROM batch_transfer/.test(sql)) return [{ id: 1, to_batch_name: 'Batch A', created_at: '2026-01-02' }];
      if (/FROM batch_waitlist/.test(sql)) return [];
      if (/FROM attendance a\b/.test(sql)) return [{ id: 1, session_date: '2026-01-05', status: 'present', batch_name: 'Batch A' }];
      if (/FROM assessment_score/.test(sql)) return [{ id: 1, test_name: 'Quiz 1', max_marks: 100, marks_obtained: 90, grade: 'A' }];
      if (/FROM coursework_submission/.test(sql)) return [{ id: 1, title: 'Essay', status: 'graded', marks: 18, max_marks: 20 }];
      if (/FROM certificate/.test(sql)) return [{ id: 1, serial_no: 'CERT-1', cert_type: 'completion', title: 'Cert', issue_date: '2026-02-01', status: 'issued' }];
      if (/FROM report_card/.test(sql)) return [{ id: 1, term: 'Term 1', overall_pct: 88.0, overall_grade: 'A', status: 'published' }];
      if (/FROM enrolment e\b/.test(sql)) return [{ id: 55, enrolment_no: 'ENR-55', status: 'active', net_fee_minor: 5000000, course_name: 'Spoken English' }];
      if (/FROM fee_receipt/.test(sql)) return [{ id: 1, receipt_no: 'RC-1', amount_minor: 2000000, mode: 'upi', received_at: '2026-03-01' }];
      return [];
    },
    issued,
  };
  const numbering = { allocate: async () => 'X' } as any;
  return { svc: new StudentService(db as any, resolver as any, numbering), db };
}

describe('StudentService.profile aggregate', () => {
  it('returns every profile section for an in-scope student', async () => {
    const { svc } = makeProfileDb();
    const p: any = await svc.profile(7, scopeAll);
    // identity/contact/family/address/id/education all ride the student row
    expect(p.student).toMatchObject({ student_no: 'STU-0007', full_name: 'Meera Nair', aadhaar: '1234', qualification: 'B.Com' });
    expect(Array.isArray(p.siblings)).toBe(true);
    // academics
    expect(p.academics.current_batch).toMatchObject({ id: 5, name: 'Batch A' });
    expect(p.academics.transfers).toHaveLength(1);
    expect(p.academics.attendance.summary).toMatchObject({ total: 10, present: 8, present_pct: 80 });
    expect(p.academics.attendance.records).toHaveLength(1);
    expect(p.academics.tests).toHaveLength(1);
    expect(p.academics.assignments).toHaveLength(1);
    // learning
    expect(p.certificates).toHaveLength(1);
    expect(p.report_cards).toHaveLength(1);
    // fees
    expect(p.fees.enrolments).toHaveLength(1);
    expect(p.fees.receipts).toHaveLength(1);
    expect(p.fees.summary).toMatchObject({ net_fee_minor: 5000000, collected_minor: 2000000, balance_minor: 3000000, receipt_count: 1 });
  });

  it('is RBAC-scoped — an out-of-scope student throws (never leaks academics/fees)', async () => {
    const { svc, db } = makeProfileDb();
    // make the scoped student read return nothing (resolver 1=0 for scopeOwn + no match)
    db.one = async (sql: string) => (/FROM student s\b/.test(sql) ? null : null);
    await expect(svc.profile(7, scopeOwn(999))).rejects.toThrow(/not found|access/i);
  });
});


/**
 * OBS-1 (docs/qa/27) — POST /students must HONOUR batch_id on create: assign the new student
 * to the batch when it has room, or queue them on the waitlist when the batch is full. The
 * batch must belong to the student's branch + vertical (mirrors the transfer flow).
 */
function makeCreate(opts: { capacity?: number; filled?: number; batchInScope?: boolean } = {}) {
  const capacity = opts.capacity ?? 10;
  const filled = opts.filled ?? 0;
  const batchInScope = opts.batchInScope !== false;
  const issued: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    one: async (sql: string, params: unknown[] = []) => {
      issued.push({ sql, params });
      if (/FROM organisation/.test(sql)) return { id: 1 };
      if (/FROM vertical WHERE id/.test(sql)) return { id: 3 };
      if (/FROM m_course WHERE id/.test(sql)) return { id: 100 };
      return null;
    },
    query: async (sql: string, params: unknown[] = []) => { issued.push({ sql, params }); return []; },
    tx: async (fn: any) => fn({
      query: async (sql: string, params: unknown[] = []) => {
        issued.push({ sql, params });
        if (/INSERT INTO student/.test(sql)) return { rows: [{ id: 777 }] };
        if (/SELECT id, capacity FROM batch/.test(sql)) return { rows: batchInScope ? [{ id: 55, capacity }] : [] };
        if (/count\(\*\)::int AS n FROM student WHERE batch_id/.test(sql)) return { rows: [{ n: filled }] };
        if (/COALESCE\(max\(position\)/.test(sql)) return { rows: [{ n: 1 }] };
        return { rows: [] };
      },
    }),
  };
  const numbering = { allocate: async (kind: string) => (kind === 'enrollment' ? 'EN-0001' : 'STU-0001') };
  const svc = new StudentService(db as never, resolver as never, numbering as never);
  return { svc, issued };
}

describe('StudentService.create — batch_id (OBS-1)', () => {
  const dto = (over: any = {}) => ({ branch_id: 9, vertical_id: 3, full_name: 'Ravi Kumar', batch_id: 55, ...over });

  it('assigns the student to the batch when there is room', async () => {
    const { svc, issued } = makeCreate({ capacity: 10, filled: 3 });
    const out = await svc.create(dto(), { id: 5 }, scopeAll);
    expect(out.id).toBe(777);
    expect(out.batch_id).toBe(55);
    expect(out.waitlisted).toBe(false);
    expect(has(issued, /UPDATE student SET batch_id = \$2::bigint/)).toBe(true);
    expect(has(issued, /INSERT INTO batch_transfer/)).toBe(true);
    expect(has(issued, /INSERT INTO batch_waitlist/)).toBe(false);
  });

  it('waitlists the student when the batch is full (capacity honoured)', async () => {
    const { svc, issued } = makeCreate({ capacity: 2, filled: 2 });
    const out = await svc.create(dto(), { id: 5 }, scopeAll);
    expect(out.id).toBe(777);
    expect(out.waitlisted).toBe(true);
    expect(out.batch_id).toBeNull();
    expect(out.waitlist_position).toBe(1);
    expect(has(issued, /INSERT INTO batch_waitlist/)).toBe(true);
    expect(has(issued, /UPDATE student SET batch_id/)).toBe(false);
  });

  it('rejects a batch outside the student\'s branch/vertical', async () => {
    const { svc } = makeCreate({ batchInScope: false });
    await expect(svc.create(dto(), { id: 5 }, scopeAll)).rejects.toThrow(/branch and vertical/i);
  });

  it('creates a student with no batch_id unchanged (batch stays unset)', async () => {
    const { svc, issued } = makeCreate();
    const out = await svc.create(dto({ batch_id: undefined }), { id: 5 }, scopeAll);
    expect(out.id).toBe(777);
    expect(out.batch_id).toBeNull();
    expect(has(issued, /SELECT id, capacity FROM batch/)).toBe(false);
  });
});
