import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { PERMISSION_KEY, IS_PUBLIC_KEY } from '../rbac/rbac.decorators';
import { PERMISSION_CATALOG } from '../rbac/permission-catalog';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MaterialController } from './material.controller';
import { CertificateController } from './certificate.controller';
import { ReportCardController } from './reportcard.controller';
import { PublicLearningController } from './public-learning.controller';
import { overallGrade, weightedOverall } from './reportcard.service';
import { KIND_DEFAULTS } from '../numbering/numbering.service';

/* --------------------------------------------------------------- RBAC census */
function routesOf(ctrl: any) {
  const proto = ctrl.prototype; const base = Reflect.getMetadata(PATH_METADATA, ctrl) ?? '';
  const classPublic = Reflect.getMetadata(IS_PUBLIC_KEY, ctrl) === true;
  return Object.getOwnPropertyNames(proto).filter((m) => m !== 'constructor' && typeof proto[m] === 'function'
    && Reflect.getMetadata(METHOD_METADATA, proto[m]) !== undefined).map((m) => ({
    handler: m, base,
    permission: Reflect.getMetadata(PERMISSION_KEY, proto[m]) as string | undefined,
    public: classPublic || Reflect.getMetadata(IS_PUBLIC_KEY, proto[m]) === true,
  }));
}
const CATALOG_KEYS = new Set(PERMISSION_CATALOG.flatMap((m) => m.actions.map((a) => `${m.module}.${a}`)));
const GUARDED = [MaterialController, CertificateController, ReportCardController].flatMap(routesOf);
const PUBLIC = routesOf(PublicLearningController);

describe('Learning RBAC census', () => {
  it('every non-public route requires a permission', () => {
    expect(GUARDED.filter((r) => !r.permission).map((r) => r.handler)).toEqual([]);
  });
  it('every permission a route names exists in the catalog', () => {
    expect(GUARDED.filter((r) => r.permission && !CATALOG_KEYS.has(r.permission!)).map((r) => r.permission)).toEqual([]);
  });
  it('the parent-view controller is deliberately public (no login for a parent share link)', () => {
    expect(PUBLIC.length).toBeGreaterThan(0);
    expect(PUBLIC.every((r) => r.public)).toBe(true);
  });
  it('migration 048 seeds + grants every material./certificate./reportcard. permission the catalog declares', () => {
    const sql = readFileSync(join(__dirname, '..', '..', 'db', 'migrations', '048_erp_learning.sql'), 'utf8');
    // material.submit / material.approve are the Academics-Governance verbs (migration 070),
    // not part of the original Learning module, so they are excluded from this 048 census.
    const GOVERNANCE = new Set(['material.submit', 'material.approve']);
    const keys = PERMISSION_CATALOG.filter((m) => ['material', 'certificate', 'reportcard'].includes(m.module))
      .flatMap((m) => m.actions.map((a) => `${m.module}.${a}`))
      .filter((k) => !GOVERNANCE.has(k));
    const ungranted = keys.filter((k) => !new RegExp(`'${k.replace('.', '\\.')}'\\s*,\\s*'`).test(sql));
    expect(ungranted).toEqual([]);
  });
  it('the certificate numbering series (CERT-) is registered', () => {
    expect(KIND_DEFAULTS.certificate).toBeDefined();
    expect(KIND_DEFAULTS.certificate.prefix).toBe('CERT-');
  });
});

/* ---------------------------------------------------- report-card computation */
describe('Report card — Indian grading bands', () => {
  it('maps percentages to A+..F', () => {
    expect(overallGrade(95)).toBe('A+');
    expect(overallGrade(90)).toBe('A+');
    expect(overallGrade(85)).toBe('A');
    expect(overallGrade(72)).toBe('B');
    expect(overallGrade(61)).toBe('C');
    expect(overallGrade(55)).toBe('D');
    expect(overallGrade(41)).toBe('E');
    expect(overallGrade(30)).toBe('F');
    expect(overallGrade(null)).toBeNull();
  });
});

describe('Report card — weighted overall renormalises over present components', () => {
  it('weights tests .5, assignments .3, attendance .2 when all present', () => {
    // 80*.5 + 60*.3 + 100*.2 = 40 + 18 + 20 = 78
    expect(weightedOverall({ tests: 80, assignments: 60, attendance: 100 })).toBe(78);
  });
  it('renormalises when a component is missing (tests only => tests)', () => {
    expect(weightedOverall({ tests: 70, assignments: null, attendance: null })).toBe(70);
  });
  it('attendance + tests only renormalise to their two weights', () => {
    // tests .5, attendance .2 -> weights sum .7; (90*.5 + 50*.2)/.7 = (45+10)/.7 = 78.57 -> 78.6
    expect(weightedOverall({ tests: 90, attendance: 50, assignments: null })).toBe(78.6);
  });
  it('returns null with no components', () => {
    expect(weightedOverall({})).toBeNull();
  });
});

/* ---------------------------------------------- study-material access control */
describe('Study material access control (source shape)', () => {
  const src = readFileSync(join(__dirname, 'material.service.ts'), 'utf8');
  it('forStudent only returns PUBLISHED items', () => {
    expect(src).toMatch(/visibility = 'published'/);
  });
  it('matches a student by batch / course / vertical access level', () => {
    expect(src).toMatch(/access_level = 'batch'\s+AND m\.batch_id = s\.batch_id/);
    expect(src).toMatch(/access_level = 'course'\s+AND m\.course_id = s\.course_id/);
    expect(src).toMatch(/access_level = 'vertical' AND m\.vertical_id = s\.vertical_id/);
  });
  it('the parent view narrows to allow_parents = TRUE', () => {
    expect(src).toMatch(/m\.allow_parents = TRUE/);
  });
});
