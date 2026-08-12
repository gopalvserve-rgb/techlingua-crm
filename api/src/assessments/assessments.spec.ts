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
