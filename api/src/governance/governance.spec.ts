import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { PERMISSION_KEY } from '../rbac/rbac.decorators';
import { PERMISSION_CATALOG } from '../rbac/permission-catalog';
import { ContentApprovalWorkflowService } from './content-approval.service';
import { AssessmentController } from '../assessments/assessment.controller';
import { ResultController } from '../assessments/result.controller';
import { BatchController } from '../students/batch.controller';

/** A pg-shaped fake DatabaseService that records rows keyed by (entity_type, entity_id). */
function mkDb() {
  const ledger = new Map<string, any>();
  const audits: any[] = [];
  const key = (t: string, id: any) => `${t}:${id}`;
  const db: any = {
    one: async (sql: string, params: any[] = []) => {
      if (/FROM organisation/.test(sql)) return { id: '1' };
      if (/FROM content_approval/.test(sql)) return ledger.get(key(params[0], params[1])) ?? null;
      if (/INSERT INTO content_approval/.test(sql)) {
        const [org, et, eid, target, isSubmit, me, isReview, remarks, isPublish] = params;
        const prev = ledger.get(key(et, eid)) ?? {};
        const row = {
          ...prev, org_id: org, entity_type: et, entity_id: eid, workflow_status: target,
          submitted_by: isSubmit ? me : prev.submitted_by ?? null,
          reviewed_by: isReview ? me : prev.reviewed_by ?? null,
          review_remarks: isReview ? remarks : prev.review_remarks ?? null,
          published_by: isPublish ? me : prev.published_by ?? null,
        };
        ledger.set(key(et, eid), row);
        return row;
      }
      return null;
    },
    query: async (sql: string, params: any[] = []) => {
      if (/INSERT INTO audit_log/.test(sql)) audits.push({ sql, params });
      return [];
    },
  };
  return { db, ledger, audits };
}
const me = { id: 9, name: 'Admin' };

describe('Academics Governance — content-approval workflow', () => {
  it('catalogs the new governance permissions', () => {
    const keys = new Set(PERMISSION_CATALOG.flatMap((m) => m.actions.map((a) => `${m.module}.${a}`)));
    for (const k of ['assessment.submit', 'assessment.publish', 'results.publish',
      'material.submit', 'material.approve',
      'course_content.submit', 'course_content.approve', 'syllabus.submit', 'syllabus.approve']) {
      expect(keys.has(k)).toBe(true);
    }
  });

  it('submit moves draft -> pending_approval and writes an audit row', async () => {
    const { db, ledger, audits } = mkDb();
    const svc = new ContentApprovalWorkflowService(db);
    await svc.submit('material', 5, me);
    expect(ledger.get('material:5').workflow_status).toBe('pending_approval');
    expect(audits.length).toBe(1);
  });

  it('approve moves pending_approval -> published; reject requires remarks and returns changes_requested', async () => {
    const { db, ledger } = mkDb();
    const svc = new ContentApprovalWorkflowService(db);
    await svc.submit('course_content', 3, me);
    await svc.approve('course_content', 3, me);
    expect(ledger.get('course_content:3').workflow_status).toBe('published');

    await svc.submit('syllabus', 4, me);
    await expect(svc.reject('syllabus', 4, me, '')).rejects.toThrow(/remarks/i);
    const r = await svc.reject('syllabus', 4, me, 'Fix section 2');
    expect(r.workflow_status).toBe('changes_requested');
    expect(ledger.get('syllabus:4').review_remarks).toBe('Fix section 2');
  });

  it('cannot submit an already-published item; cannot unpublish a draft', async () => {
    const { db } = mkDb();
    const svc = new ContentApprovalWorkflowService(db);
    await svc.submit('material', 8, me);
    await svc.approve('material', 8, me);
    await expect(svc.submit('material', 8, me)).rejects.toThrow(/published/i);
    await expect(svc.unpublish('material', 99, me)).rejects.toThrow(/published/i);
  });

  it('gates the governance routes with the right permissions (trainer submit; approver publish/reject/release)', () => {
    const permOf = (C: any, method: string) => Reflect.getMetadata(PERMISSION_KEY, C.prototype[method]);
    expect(permOf(AssessmentController, 'submitForApproval')).toBe('assessment.submit');
    expect(permOf(AssessmentController, 'publish')).toBe('assessment.publish');
    expect(permOf(AssessmentController, 'reject')).toBe('assessment.publish');
    expect(permOf(AssessmentController, 'unpublish')).toBe('assessment.publish');
    expect(permOf(ResultController, 'releaseAttempt')).toBe('results.publish');
    expect(permOf(ResultController, 'releaseAssessment')).toBe('results.publish');
    // Batch creation is gated so a Trainer (no batch.create) is 403'd; batch.read is view-only.
    expect(permOf(BatchController, 'create')).toBe('batch.create');
    expect(permOf(BatchController, 'update')).toBe('batch.update');
    expect(permOf(BatchController, 'list')).toBe('batch.read');
  });

  it('every governance route declares a permission present in the catalog', () => {
    const keys = new Set(PERMISSION_CATALOG.flatMap((m) => m.actions.map((a) => `${m.module}.${a}`)));
    for (const C of [AssessmentController, ResultController]) {
      const proto: any = C.prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        const isRoute = Reflect.getMetadata(PATH_METADATA, proto[name]) !== undefined
          && Reflect.getMetadata(METHOD_METADATA, proto[name]) !== undefined;
        if (!isRoute) continue;
        const perm = Reflect.getMetadata(PERMISSION_KEY, proto[name]);
        expect(perm).toBeTruthy();
        expect(keys.has(perm)).toBe(true);
      }
    }
  });
});

describe('Academics Governance — migration 070 + seed', () => {
  const fs = require('fs');
  const path = require('path');
  const mig = fs.readFileSync(path.join(__dirname, '../../db/migrations/070_academics_governance.sql'), 'utf8');
  const seed = fs.readFileSync(path.join(__dirname, '../database/seed.ts'), 'utf8');

  it('migration seeds the Academic Admin system role idempotently', () => {
    expect(mig).toMatch(/INSERT INTO role[\s\S]*'Academic Admin', TRUE/);
    expect(mig).toMatch(/NOT EXISTS \(SELECT 1 FROM role WHERE org_id = o\.id AND name = 'Academic Admin'\)/);
  });

  it('migration REVOKES publish + certificate issue from Trainer', () => {
    expect(mig).toMatch(/DELETE FROM role_permission[\s\S]*name = 'Trainer'[\s\S]*assessment\.publish'[\s\S]*assessment_certificate\.issue'/);
  });

  it('migration grants Academic Admin publish/approve authority and Trainer only submit + batch.read', () => {
    expect(mig).toMatch(/\('assessment\.publish',\s*'Academic Admin'/);
    expect(mig).toMatch(/\('results\.publish',\s*'Academic Admin'/);
    expect(mig).toMatch(/\('batch\.create',\s*'Academic Admin'/);
    expect(mig).toMatch(/\('assessment\.submit',\s*'Trainer'/);
    expect(mig).toMatch(/\('batch\.read',\s*'Trainer'/);
    // Trainer must NOT be granted publish/approve in the migration grant block
    expect(mig).not.toMatch(/\('assessment\.publish',\s*'Trainer'/);
    expect(mig).not.toMatch(/\('material\.approve',\s*'Trainer'/);
  });

  it('migration adds pending_approval to the assessment status flow + the results release columns', () => {
    expect(mig).toMatch(/status IN \('draft','pending_approval','published','closed'\)/);
    expect(mig).toMatch(/CREATE TABLE IF NOT EXISTS content_approval/);
    expect(mig).toMatch(/results_released_at/);
  });

  it('migration 071 whitelists the workflow actions in audit_log', () => {
    const m71 = fs.readFileSync(path.join(__dirname, '../../db/migrations/071_audit_workflow_actions.sql'), 'utf8');
    for (const a of ['workflow_submit', 'workflow_approve', 'workflow_reject', 'workflow_unpublish', 'results_release']) {
      expect(m71).toContain(`'${a}'`);
    }
  });

  it('seed.ts registers Academic Admin and gives Trainer submit but not publish', () => {
    expect(seed).toMatch(/'Academic Admin'/);
    expect(seed).toMatch(/grant\('Academic Admin'/);
    // Trainer grant list contains assessment.submit but not assessment.publish
    const trainerBlock = seed.split("grant('Trainer'")[1].split("], 'branch')")[0];
    expect(trainerBlock).toMatch(/assessment\.submit/);
    expect(trainerBlock).not.toMatch(/assessment\.publish/);
    expect(trainerBlock).toMatch(/batch\.read/);
  });
});
