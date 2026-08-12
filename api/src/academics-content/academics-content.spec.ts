import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { PERMISSION_KEY } from '../rbac/rbac.decorators';
import { CourseContentController } from './course-content.controller';
import { SyllabusController } from './syllabus.controller';
import { MaterialController } from '../learning/material.controller';
import { CourseContentService } from './course-content.service';
import { SyllabusService } from './syllabus.service';

/** Reflect the @RequirePermission on a controller method. */
function permOf(ctrl: any, method: string): string | undefined {
  return Reflect.getMetadata(PERMISSION_KEY, ctrl.prototype[method]);
}
function httpPath(ctrl: any, method: string): string {
  return Reflect.getMetadata(PATH_METADATA, ctrl.prototype[method]);
}

describe('Academics Governance Batch 2 — route permission wiring', () => {
  it('course-content routes are gated correctly (submit=submit, approve/reject/unpublish=approve)', () => {
    expect(permOf(CourseContentController, 'list')).toBe('course_content.read');
    expect(permOf(CourseContentController, 'create')).toBe('course_content.create');
    expect(permOf(CourseContentController, 'update')).toBe('course_content.update');
    expect(permOf(CourseContentController, 'remove')).toBe('course_content.delete');
    expect(permOf(CourseContentController, 'submit')).toBe('course_content.submit');
    expect(permOf(CourseContentController, 'approve')).toBe('course_content.approve');
    expect(permOf(CourseContentController, 'reject')).toBe('course_content.approve');
    expect(permOf(CourseContentController, 'unpublish')).toBe('course_content.approve');
  });
  it('syllabus routes are gated correctly', () => {
    expect(permOf(SyllabusController, 'submit')).toBe('syllabus.submit');
    expect(permOf(SyllabusController, 'approve')).toBe('syllabus.approve');
    expect(permOf(SyllabusController, 'reject')).toBe('syllabus.approve');
    expect(permOf(SyllabusController, 'unpublish')).toBe('syllabus.approve');
  });
  it('study-material governance routes are gated correctly', () => {
    expect(permOf(MaterialController, 'submit')).toBe('material.submit');
    expect(permOf(MaterialController, 'approve')).toBe('material.approve');
    expect(permOf(MaterialController, 'reject')).toBe('material.approve');
    expect(permOf(MaterialController, 'unpublish')).toBe('material.approve');
  });
  it('a trainer (holds *.submit, not *.approve) is therefore 403 on approve/reject/unpublish by construction', () => {
    // approve/reject/unpublish all require the approve permission a Trainer role never holds.
    for (const m of ['approve', 'reject', 'unpublish']) {
      expect(permOf(CourseContentController, m)).toBe('course_content.approve');
      expect(permOf(SyllabusController, m)).toBe('syllabus.approve');
    }
  });
});

/** A fake db/resolver/rbac/workflow/storage harness for the service-level tests. */
function harness(opts: { approver: boolean }) {
  const queries: Array<{ sql: string; params: any[] }> = [];
  const db: any = {
    one: async (sql: string, params: any[] = []) => {
      if (/FROM organisation/.test(sql)) return { id: '1' };
      if (/FROM course_content|FROM syllabus/.test(sql)) return { id: params[0], workflow_status: 'draft', branch_id: 2, vertical_id: 3, course_id: 4 };
      if (/FROM m_course/.test(sql)) return { id: params[0], branch_id: 2, vertical_id: 3 };
      return null;
    },
    query: async (sql: string, params: any[] = []) => { queries.push({ sql, params }); return []; },
    tx: async (fn: any) => fn(db),
  };
  const resolver: any = {
    buildScopeWhere: () => 'TRUE',
    resolve: () => ({ allowed: opts.approver, all: true, filters: [] }),
  };
  const rbacData: any = { loadUserGrants: async () => ({ userId: 1, assignments: [], rolePermissions: [], teamIds: [] }) };
  const workflow: any = {
    submit: jest.fn(async () => ({})), approve: jest.fn(async () => ({})),
    reject: jest.fn(async () => ({})), unpublish: jest.fn(async () => ({})),
    record: jest.fn(async () => ({})),
  };
  const storage: any = { presignGet: async () => 'https://r2/x', presignPut: async () => 'https://r2/put', materialKey: () => 'k' };
  return { db, resolver, rbacData, workflow, storage, queries };
}
const me = { id: 7, name: 'T' };
const scope: any = { permissionKey: 'x', allowed: true, all: true, filters: [], allowedFields: null, deniedFields: [] };

describe('Academics Governance Batch 2 — published-only visibility + transitions', () => {
  it('a NON-approver list forces workflow_status = published', async () => {
    const h = harness({ approver: false });
    const svc = new CourseContentService(h.db, h.resolver, h.rbacData, h.storage, h.workflow);
    let captured = '';
    h.db.query = async (sql: string) => { captured = sql; return []; };
    await svc.list(scope, me, {});
    expect(captured).toMatch(/workflow_status = 'published'/);
  });
  it('an APPROVER list does NOT force published-only (can filter any status)', async () => {
    const h = harness({ approver: true });
    const svc = new CourseContentService(h.db, h.resolver, h.rbacData, h.storage, h.workflow);
    let captured = '';
    h.db.query = async (sql: string) => { captured = sql; return []; };
    await svc.list(scope, me, {});
    expect(captured).not.toMatch(/workflow_status = 'published'/);
  });
  it('submit -> pending_approval calls workflow.submit and mirrors the column', async () => {
    const h = harness({ approver: false });
    const svc = new SyllabusService(h.db, h.resolver, h.rbacData, h.storage, h.workflow);
    const r = await svc.submit(9, me, scope);
    expect(h.workflow.submit).toHaveBeenCalledWith('syllabus', 9, me);
    expect(r.workflow_status).toBe('pending_approval');
    expect(h.queries.some((q) => /pending_approval/.test(q.sql))).toBe(true);
  });
  it('approve -> published mirrors the column', async () => {
    const h = harness({ approver: true });
    const svc = new CourseContentService(h.db, h.resolver, h.rbacData, h.storage, h.workflow);
    const r = await svc.approve(9, me, scope);
    expect(h.workflow.approve).toHaveBeenCalledWith('course_content', 9, me);
    expect(r.workflow_status).toBe('published');
  });
  it('reject requires remarks and moves to changes_requested', async () => {
    const h = harness({ approver: true });
    const svc = new CourseContentService(h.db, h.resolver, h.rbacData, h.storage, h.workflow);
    await expect(svc.reject(9, '   ', me, scope)).rejects.toThrow(/Remarks are required/);
    const r = await svc.reject(9, 'Fix the intro', me, scope);
    expect(r.workflow_status).toBe('changes_requested');
    expect(r.review_remarks).toBe('Fix the intro');
  });
});
