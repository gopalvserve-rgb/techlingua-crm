import 'reflect-metadata';
import { StudentService } from './student.service';
import { ResolvedScope } from '../rbac/rbac.types';
import { periodToken, formatNumber, KIND_DEFAULTS } from '../numbering/numbering.service';

const scopeAll: ResolvedScope = { permissionKey: 'student.read', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [] };
const resolver = { buildScopeWhere: () => '1=1' } as any;

const STUDENT = {
  id: 55, org_id: 1, branch_id: 9, vertical_id: 3, full_name: 'ZZTEST Riya Sharma',
  student_no: 'STU-0055', enrollment_no: 'EN-0055', enrolment_id: 900, status: 'active',
  branch_name: 'Vikaspuri', vertical_name: 'BCL', course_name: 'French A1', batch_name: 'Morning A1',
};

// Two enrolments across TWO verticals -> two distinct vertical-wise ids.
const ENROLMENTS = [
  { id: 701, enrolment_no: 'ENR-0701', status: 'active', course_id: 11, batch_id: null, course_name: 'French A1',
    branch_id: 9, vertical_id: 3, branch_name: 'Vikaspuri', vertical_name: 'BCL', student_vertical_no: 'SID-2026-27/0001',
    course_status: 'active', net_fee_minor: 100000, created_at: '2026-08-01' },
  { id: 702, enrolment_no: 'ENR-0702', status: 'active', course_id: 22, batch_id: null, course_name: 'German A1',
    branch_id: 9, vertical_id: 4, branch_name: 'Vikaspuri', vertical_name: 'German School', student_vertical_no: 'SID-2026-27/0002',
    course_status: 'active', net_fee_minor: 120000, created_at: '2026-08-05' },
];

function makeSvc(enrolments = ENROLMENTS) {
  const db = {
    one: async (sql: string) => {
      if (/FROM student s/.test(sql)) return { ...STUDENT };
      if (/FROM organisation/.test(sql)) return { id: 1, name: 'Tech Lingua LLP' };
      return null;
    },
    query: async (sql: string) => {
      if (/FROM enrolment e/.test(sql)) return enrolments.map((e) => ({ ...e }));
      return [];
    },
  };
  return new StudentService(db as never, resolver, {} as never, undefined, undefined, undefined, undefined, undefined);
}

describe('numbering — student_vertical (vertical-wise Student ID) series', () => {
  it('is registered with an SID- prefix, reset per Indian FY', () => {
    expect(KIND_DEFAULTS['student_vertical'].prefix).toBe('SID-');
    expect(KIND_DEFAULTS['student_vertical'].reset).toBe('fy');
  });
  it('formats FY-aware SID-2026-27/0001 (April -> 2026-27, March -> 2025-26)', () => {
    const apr = periodToken('fy', new Date(Date.UTC(2026, 4, 10)));   // May 2026 -> FY 2026-27
    const mar = periodToken('fy', new Date(Date.UTC(2026, 2, 10)));   // Mar 2026 -> FY 2025-26
    expect(apr).toBe('2026-27');
    expect(mar).toBe('2025-26');
    expect(formatNumber({ prefix: 'SID-', suffix: '', padding: 4, token: apr, n: 1 })).toBe('SID-2026-27/0001');
  });
});

describe('StudentService.listEnrolments — per-enrolment Branch > Vertical > Course + vertical-wise id', () => {
  it('carries a Branch > Vertical > Course breadcrumb and the vertical-wise id on each enrolment', async () => {
    const svc = makeSvc();
    const out: any = await svc.listEnrolments(55, scopeAll);
    expect(out.enrolments).toHaveLength(2);
    expect(out.enrolments[0].path).toBe('Vikaspuri › BCL › French A1');
    expect(out.enrolments[0].student_vertical_no).toBe('SID-2026-27/0001');
    expect(out.enrolments[1].student_vertical_no).toBe('SID-2026-27/0002');
  });
  it('groups the distinct vertical-wise ids — one per vertical (2 verticals -> 2 ids)', async () => {
    const svc = makeSvc();
    const out: any = await svc.listEnrolments(55, scopeAll);
    expect(out.vertical_ids).toHaveLength(2);
    const nos = out.vertical_ids.map((v: any) => v.student_vertical_no).sort();
    expect(nos).toEqual(['SID-2026-27/0001', 'SID-2026-27/0002']);
  });
});

describe('StudentService.verticalIds — the ID-card picker', () => {
  it('lists one entry per vertical with its courses + Branch > Vertical path', async () => {
    // single query returns grouped rows; emulate the SQL GROUP BY output
    const grouped = [
      { vertical_id: 3, branch_id: 9, vertical_name: 'BCL', branch_name: 'Vikaspuri', student_vertical_no: 'SID-2026-27/0001', courses: ['French A1'] },
      { vertical_id: 4, branch_id: 9, vertical_name: 'German School', branch_name: 'Vikaspuri', student_vertical_no: 'SID-2026-27/0002', courses: ['German A1'] },
    ];
    const db = {
      one: async (sql: string) => (/FROM student s/.test(sql) ? { ...STUDENT } : null),
      query: async (sql: string) => (/FROM enrolment e/.test(sql) ? grouped : []),
    };
    const svc = new StudentService(db as never, resolver, {} as never, undefined, undefined, undefined, undefined, undefined);
    const out: any = await svc.verticalIds(55, scopeAll);
    expect(out.verticals).toHaveLength(2);
    expect(out.verticals[0].path).toBe('Vikaspuri › BCL');
    expect(out.verticals[0].student_vertical_no).toBe('SID-2026-27/0001');
    expect(out.verticals[1].courses).toEqual(['German A1']);
  });
});

describe('StudentService.idCard — per vertical', () => {
  it('a student enrolled across 2 verticals must choose a vertical (400 without vertical_id)', async () => {
    const svc = makeSvc();
    await expect(svc.idCard(55, scopeAll)).rejects.toThrow(/multiple verticals|choose a vertical/i);
  });
});
