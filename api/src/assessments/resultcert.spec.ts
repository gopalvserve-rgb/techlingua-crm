import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { PERMISSION_KEY } from '../rbac/rbac.decorators';
import { PERMISSION_CATALOG } from '../rbac/permission-catalog';
import { ResultService } from './result.service';
import { AssessmentCertificateService } from './assessment-certificate.service';
import { GradeSchemeController } from './grade-scheme.controller';
import { ResultController } from './result.controller';
import { AssessmentCertificateController } from './assessment-certificate.controller';
import { AssessmentReportController } from './assessment-report.controller';
import { validateBands, Band } from './grade';

const resolver = { buildScopeWhere: () => '1=1' } as any;
const scopeAll: any = { allowed: true, all: true, filters: [] };
const me = { id: 7, name: 'T' };
const INDIA: Band[] = [
  { label: 'Fail', min_pct: 0, max_pct: 50, is_pass: false },
  { label: 'C', min_pct: 50, max_pct: 60, is_pass: true },
  { label: 'B', min_pct: 60, max_pct: 70, is_pass: true },
  { label: 'B+', min_pct: 70, max_pct: 80, is_pass: true },
  { label: 'A', min_pct: 80, max_pct: 90, is_pass: true },
  { label: 'A+', min_pct: 90, max_pct: 100, is_pass: true },
];
const grades = {
  gradeFor: async (pct: number | null) => {
    if (pct == null) return { grade_label: null, is_pass: null, scheme_id: null, scheme_name: null };
    const b = validateBands(INDIA).ok ? INDIA : INDIA;
    const hit = [...b].reverse().find((x) => pct >= x.min_pct) ?? b[0];
    return { grade_label: hit.label, is_pass: hit.is_pass, scheme_id: 1, scheme_name: 'India Standard (Default)' };
  },
  effectiveScheme: async () => ({ id: 1, name: 'India Standard (Default)', bands: INDIA }),
} as any;

describe('ResultService — the show_result_mode gate', () => {
  const mk = (attempt: any) => ({
    one: async (sql: string) => (/FROM assessment_attempt at/.test(sql) ? attempt : null),
    query: async () => [],
  } as any);

  it('manual mode: a merely-submitted attempt is NOT released', async () => {
    const svc = new ResultService(mk({ id: '1', status: 'submitted', show_result_mode: 'manual', assembled: '[]', total_score: null, max_score: 10 }), resolver, grades);
    const r: any = await svc.attemptResult(1, scopeAll);
    expect(r.available).toBe(false);
  });
  it('manual mode: an evaluated but UNRELEASED attempt is withheld (governance — Academic Admin releases)', async () => {
    const svc = new ResultService(mk({ id: '1', status: 'evaluated', show_result_mode: 'manual', assembled: '[]', total_score: 8, max_score: 10, is_passed: true, results_released_at: null }), resolver, grades);
    const r: any = await svc.attemptResult(1, scopeAll);
    expect(r.available).toBe(false);
  });
  it('manual mode: an evaluated + RELEASED attempt IS shown with grade + analytics', async () => {
    const svc = new ResultService(mk({ id: '1', status: 'evaluated', show_result_mode: 'manual', assembled: '[]', total_score: 8, max_score: 10, is_passed: true, results_released_at: new Date().toISOString() }), resolver, grades);
    const r: any = await svc.attemptResult(1, scopeAll);
    expect(r.available).toBe(true);
    expect(r.percentage).toBe(80);
    expect(r.grade_label).toBe('A');
    expect(r.analytics).toBeTruthy();
  });
  it('instant mode: available as soon as scored (submitted/evaluated)', async () => {
    const svc = new ResultService(mk({ id: '1', status: 'submitted', show_result_mode: 'instant', assembled: '[]', total_score: 5, max_score: 10 }), resolver, grades);
    expect((await svc.attemptResult(1, scopeAll) as any).available).toBe(true);
  });
  it('after_end mode: gated until the window has closed', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const gated = new ResultService(mk({ id: '1', status: 'evaluated', show_result_mode: 'after_end', end_at: future, assembled: '[]', total_score: 5, max_score: 10 }), resolver, grades);
    expect((await gated.attemptResult(1, scopeAll) as any).available).toBe(false);
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const open = new ResultService(mk({ id: '1', status: 'evaluated', show_result_mode: 'after_end', end_at: past, assembled: '[]', total_score: 5, max_score: 10 }), resolver, grades);
    expect((await open.attemptResult(1, scopeAll) as any).available).toBe(true);
  });
});

describe('ResultService — leaderboard rank + percentile', () => {
  it('dense-ranks by total score with ties and computes percentile', async () => {
    const rows = [
      { id: '1', student_id: '1', attempt_no: 1, total_score: 90, max_score: 100, is_passed: true, student_name: 'A' },
      { id: '2', student_id: '2', attempt_no: 1, total_score: 80, max_score: 100, is_passed: true, student_name: 'B' },
      { id: '3', student_id: '3', attempt_no: 1, total_score: 80, max_score: 100, is_passed: true, student_name: 'C' },
      { id: '4', student_id: '4', attempt_no: 1, total_score: 40, max_score: 100, is_passed: false, student_name: 'D' },
    ];
    const db = {
      one: async () => ({ id: '5', title: 'T', test_type: 'mock', total_marks: 100 }),
      query: async () => rows,
    } as any;
    const svc = new ResultService(db, resolver, grades);
    const out: any = await svc.leaderboard(5, scopeAll);
    expect(out.results.map((r: any) => r.rank)).toEqual([1, 2, 2, 3]);
    expect(out.results[0].percentile).toBe(100);   // top
    expect(out.results[3].percentile).toBe(0);      // bottom
    expect(out.results[0].grade_label).toBe('A+');
    expect(out.summary).toMatchObject({ students: 4, passed: 3, failed: 1 });
    expect(out.summary.pass_rate).toBe(75);
  });
});

describe('AssessmentCertificateService — issue guard + public verify', () => {
  const numbering = { allocate: async () => 'ACRT-2026-27/0001' } as any;
  const storage = {} as any;
  const pdfAssets = { persist: async () => null, presignedUrl: async () => null } as any;
  const mk = (attempt: any) => ({
    one: async (sql: string) => {
      if (/FROM organisation/.test(sql)) return { id: '1' };
      if (/FROM assessment_attempt at JOIN assessment a/.test(sql)) return attempt;
      return null;
    },
    query: async () => [],
    tx: async (fn: any) => fn({ query: async () => ({ rows: [{ id: '55' }] }) }),
  } as any);

  it('refuses to issue for an attempt that is not evaluated', async () => {
    const svc = new AssessmentCertificateService(mk({ id: '1', status: 'submitted', is_passed: null }), resolver, numbering, grades, storage, pdfAssets);
    await expect(svc.issue({ attempt_id: 1 }, me, scopeAll)).rejects.toThrow(/evaluated/);
  });
  it('refuses to issue for an evaluated but FAILED attempt', async () => {
    const svc = new AssessmentCertificateService(mk({ id: '1', status: 'evaluated', is_passed: false }), resolver, numbering, grades, storage, pdfAssets);
    await expect(svc.issue({ attempt_id: 1 }, me, scopeAll)).rejects.toThrow(/PASSED/);
  });

  it('verify: unknown code -> invalid; issued -> valid; revoked -> invalid+revoked', async () => {
    const mkVerify = (row: any) => new AssessmentCertificateService(
      { one: async () => row, query: async () => [] } as any, resolver, numbering, grades, storage, pdfAssets);
    expect((await mkVerify(null).verify('nope')).valid).toBe(false);
    const issued: any = await mkVerify({ certificate_no: 'ACRT-1', status: 'issued', student_name: 'S', grade_label: 'A', percentage: 82 }).verify('CODE');
    expect(issued.valid).toBe(true); expect(issued.student_name).toBe('S');
    const revoked: any = await mkVerify({ certificate_no: 'ACRT-1', status: 'revoked', student_name: 'S' }).verify('CODE');
    expect(revoked.valid).toBe(false); expect(revoked.revoked).toBe(true);
  });
});

describe('Batch-D routes are catalogued + guarded', () => {
  it('catalogs grade_scheme + assessment_certificate', () => {
    expect(PERMISSION_CATALOG.some((x) => x.module === 'grade_scheme')).toBe(true);
    const cert = PERMISSION_CATALOG.find((x) => x.module === 'assessment_certificate');
    expect(cert?.actions).toEqual(expect.arrayContaining(['read', 'issue', 'revoke', 'delete']));
  });
  it('every Batch-D authed route declares a permission that exists in the catalog', () => {
    const keys = new Set(PERMISSION_CATALOG.flatMap((m) => m.actions.map((a) => `${m.module}.${a}`)));
    for (const C of [GradeSchemeController, ResultController, AssessmentCertificateController, AssessmentReportController]) {
      const proto: any = C.prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        const isRoute = Reflect.getMetadata(PATH_METADATA, proto[name]) !== undefined && Reflect.getMetadata(METHOD_METADATA, proto[name]) !== undefined;
        if (!isRoute) continue;
        const perm = Reflect.getMetadata(PERMISSION_KEY, proto[name]);
        expect(perm).toBeTruthy();
        expect(keys.has(perm)).toBe(true);
      }
    }
  });
});
