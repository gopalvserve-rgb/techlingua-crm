import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { PERMISSION_KEY } from '../rbac/rbac.decorators';
import { PERMISSION_CATALOG } from '../rbac/permission-catalog';
import { QuestionController } from './question.controller';
import { QuestionCategoryController } from './question-category.controller';
import { QuestionService, Q_TYPES, OBJECTIVE_TYPES } from './question.service';
import { QuestionCategoryService } from './question-category.service';

/** A pg-shaped fake DatabaseService capturing SQL. */
function mkDb(cap: any[] = []) {
  const one = async (sql: string) => {
    if (/FROM organisation/.test(sql)) return { id: '1' };
    return null;
  };
  return {
    one,
    query: async (sql: string, params?: any[]) => { cap.push({ sql, params }); return []; },
    tx: async (fn: (c: any) => any) => fn({
      query: async (sql: string, params?: any[]) => { cap.push({ sql, params }); return { rows: [{ id: '99' }] }; },
    }),
  } as any;
}
const resolver = { buildScopeWhere: () => '1=1' } as any;
const storage = {
  questionMediaKey: (n: string) => `questions/media/x-${n}`,
  presignPut: async () => 'https://r2/put',
  presignGet: async () => 'https://r2/get',
} as any;
const scopeAll: any = { allowed: true, all: true, filters: [] };
const me = { id: 7, name: 'T' };

describe('Question Bank — Batch A', () => {
  it('catalogs the two assessment modules', () => {
    for (const m of ['question_category', 'question']) {
      expect(PERMISSION_CATALOG.some((x) => x.module === m)).toBe(true);
    }
  });

  it('every assessment route declares a permission that exists in the catalog', () => {
    const keys = new Set(PERMISSION_CATALOG.flatMap((m) => m.actions.map((a) => `${m.module}.${a}`)));
    for (const C of [QuestionController, QuestionCategoryController]) {
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

  it('covers IT + Language question types incl. the required media/video types', () => {
    for (const t of ['mcq_single', 'image_mcq', 'audio_mcq', 'video_mcq', 'coding', 'reading', 'listening', 'writing']) {
      expect(Q_TYPES).toContain(t as any);
    }
    expect(OBJECTIVE_TYPES.has('video_mcq')).toBe(true);
  });

  it('rejects an unknown q_type', async () => {
    const svc = new QuestionService(mkDb() as any, resolver, storage);
    await expect(svc.create({ q_type: 'nope', body: 'x' }, me, scopeAll)).rejects.toThrow(/Unknown question type/);
  });

  it('requires question text', async () => {
    const svc = new QuestionService(mkDb() as any, resolver, storage);
    await expect(svc.create({ q_type: 'short_answer', body: '  ' }, me, scopeAll)).rejects.toThrow(/text is required/);
  });

  it('an objective question needs >=2 options and a correct one', async () => {
    const svc = new QuestionService(mkDb() as any, resolver, storage);
    await expect(svc.create({ q_type: 'mcq_single', body: 'q', options: [{ body: 'a' }] }, me, scopeAll)).rejects.toThrow(/at least two options/);
    await expect(svc.create({ q_type: 'mcq_single', body: 'q', options: [{ body: 'a' }, { body: 'b' }] }, me, scopeAll)).rejects.toThrow(/correct/);
  });

  it('mcq_single refuses two correct options', async () => {
    const svc = new QuestionService(mkDb() as any, resolver, storage);
    await expect(svc.create({ q_type: 'mcq_single', body: 'q', options: [{ body: 'a', is_correct: true }, { body: 'b', is_correct: true }] }, me, scopeAll))
      .rejects.toThrow(/only one correct/);
  });

  it('a video question needs a YouTube URL', async () => {
    const svc = new QuestionService(mkDb() as any, resolver, storage);
    await expect(svc.create({ q_type: 'video_mcq', body: 'q', options: [{ body: 'a', is_correct: true }, { body: 'b' }] }, me, scopeAll))
      .rejects.toThrow(/YouTube/);
  });

  it('creates a valid mcq_single with options in one transaction', async () => {
    const cap: any[] = [];
    const svc = new QuestionService(mkDb(cap) as any, resolver, storage);
    const out = await svc.create({ q_type: 'mcq_single', body: 'Pick', category_id: 3,
      options: [{ body: 'a', is_correct: true }, { body: 'b' }] }, me, scopeAll);
    expect(out.id).toBe(99);
    expect(cap.some((c) => /INSERT INTO question \(/.test(c.sql))).toBe(true);
    expect(cap.filter((c) => /INSERT INTO question_option/.test(c.sql)).length).toBe(2);
  });

  it('upload-url presigns an R2 PUT and returns the key', async () => {
    const svc = new QuestionService(mkDb() as any, resolver, storage);
    const out = await svc.uploadUrl({ file_name: 'diagram.png', content_type: 'image/png' });
    expect(out.url).toMatch(/^https:\/\/r2/);
    expect(out.r2_key).toContain('questions/media/');
  });

  it('category create requires a name', async () => {
    const svc = new QuestionCategoryService(mkDb() as any, resolver);
    await expect(svc.create({ name: ' ' }, me, scopeAll)).rejects.toThrow(/name is required/);
  });
});

/* ============================================================ Batch B — Tests === */
import { PATH_METADATA as PATH2, METHOD_METADATA as METH2 } from '@nestjs/common/constants';
import { AssessmentController } from './assessment.controller';
import { AssessmentTemplateController } from './assessment-template.controller';
import { AssessmentService } from './assessment.service';
import { AssessmentTemplateService } from './assessment-template.service';

const tmplSvc = () => new AssessmentTemplateService(mkDb() as any, resolver);

/** A DB double that returns shaped rows for assemble()/publish() by matching the SQL. */
function mkAssessDb(overrides: Record<string, any[]> = {}) {
  const asRow = {
    id: '5', title: 'Mock', description: null, test_type: 'mock', language: null, instructions: null,
    duration_min: 30, total_marks: '2', passing_marks: null, passing_pct: null, negative_marking: true,
    default_negative: '0.25', max_attempts: 1, show_result_mode: 'instant', status: 'draft',
    start_at: null, end_at: null, randomize_options: false, randomize_questions: false, shuffle_per_attempt: false,
    questions_to_show: null, total_marks_manual: false,
  };
  return {
    one: async (sql: string) => {
      if (/FROM organisation/.test(sql)) return { id: '1' };
      if (/FROM assessment a/.test(sql)) return asRow;
      if (/questions_to_show, total_marks_manual/.test(sql)) return asRow;
      if (/count\(\*\) AS n FROM assessment_question/.test(sql)) return { n: '1' };
      return null;
    },
    query: async (sql: string) => {
      if (/FROM assessment_question aq JOIN question q/.test(sql)) {
        return [{ question_id: '9', marks_override: null, ordering: 1, id: '9', q_type: 'mcq_single',
          difficulty: 'easy', marks: '2', negative_marks: '0.25', body: 'Pick one', language: null,
          image_r2_key: null, audio_r2_key: null, youtube_url: null }];
      }
      if (/FROM assessment_section s/.test(sql)) return overrides.sections ?? [];
      if (/FROM question_option/.test(sql)) {
        return [{ id: '11', body: 'A', image_r2_key: null, is_correct: true, ordering: 1, match_key: null },
                { id: '12', body: 'B', image_r2_key: null, is_correct: false, ordering: 2, match_key: null }];
      }
      return [];
    },
    tx: async (fn: (c: any) => any) => fn({ query: async () => ({ rows: [{ id: '5' }] }) }),
  } as any;
}
const assessSvc = (db?: any) => new AssessmentService(db ?? mkAssessDb(), resolver, storage, tmplSvc());

describe('Assessment Tests — Batch B', () => {
  it('catalogs the assessment + assessment_template modules', () => {
    for (const m of ['assessment', 'assessment_template']) {
      expect(PERMISSION_CATALOG.some((x) => x.module === m)).toBe(true);
    }
  });

  it('every Batch-B route declares a permission that exists in the catalog', () => {
    const keys = new Set(PERMISSION_CATALOG.flatMap((m) => m.actions.map((a) => `${m.module}.${a}`)));
    for (const C of [AssessmentController, AssessmentTemplateController]) {
      const proto: any = C.prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        const isRoute = Reflect.getMetadata(PATH2, proto[name]) !== undefined && Reflect.getMetadata(METH2, proto[name]) !== undefined;
        if (!isRoute) continue;
        const perm = Reflect.getMetadata(PERMISSION_KEY, proto[name]);
        expect(perm).toBeTruthy();
        expect(keys.has(perm)).toBe(true);
      }
    }
  });

  it('a template needs a name and a known test type', async () => {
    const s = tmplSvc();
    await expect(s.create({ name: ' ' }, me, scopeAll)).rejects.toThrow(/name is required/);
    await expect(s.create({ name: 'T', test_type: 'nope' }, me, scopeAll)).rejects.toThrow(/Unknown test type/);
  });

  it('a test needs a title and a known type', async () => {
    const s = assessSvc();
    await expect(s.create({ title: ' ' }, me, scopeAll)).rejects.toThrow(/title is required/);
    await expect(s.create({ title: 'X', test_type: 'nope' }, me, scopeAll)).rejects.toThrow(/Unknown test type/);
  });

  it('rejects an availability window that ends before it starts', async () => {
    const s = assessSvc();
    await expect(s.create({ title: 'X', start_at: '2026-08-10T10:00:00Z', end_at: '2026-08-09T10:00:00Z' }, me, scopeAll))
      .rejects.toThrow(/ends before it starts/);
  });

  it('publish refuses a test with no questions and no pool', async () => {
    const db = mkAssessDb();
    db.one = async (sql: string) => {
      if (/FROM assessment a/.test(sql)) return { id: '5', status: 'draft', test_type: 'mock', duration_min: 30, passing_marks: null };
      if (/count\(\*\) AS n FROM assessment_question/.test(sql)) return { n: '0' };
      if (/questions_to_show, total_marks_manual/.test(sql)) return { questions_to_show: null, total_marks_manual: false, total_marks: '0' };
      return null;
    };
    const s = assessSvc(db);
    await expect(s.publish(5, me, scopeAll)).rejects.toThrow(/at least one question|section pool/);
  });

  it('assemble() strips correct answers from the options (the Batch C seam)', async () => {
    const s = assessSvc();
    const out = await s.assemble(5, scopeAll, { forAttempt: true });
    expect(out.question_count).toBe(1);
    const q = out.questions[0];
    expect(q.body).toBe('Pick one');
    expect(q.options.length).toBe(2);
    for (const o of q.options) {
      expect('is_correct' in o).toBe(false);
      expect(o).not.toHaveProperty('is_correct');
    }
    // marks flow through, no explanation leaks
    expect(q.marks).toBe(2);
    expect('explanation' in q).toBe(false);
  });
});
