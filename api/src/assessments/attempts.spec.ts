import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { PERMISSION_KEY } from '../rbac/rbac.decorators';
import { PERMISSION_CATALOG } from '../rbac/permission-catalog';
import { scoreAttempt, computeIsPassed, ScorerQuestion } from './scorer';
import { AttemptController } from './attempt.controller';
import { SubmissionController } from './submission.controller';
import { AttemptService } from './attempt.service';

/* ============================================================ the auto-scorer === */
describe('Auto-scorer — Batch C', () => {
  const q = (over: Partial<ScorerQuestion>): ScorerQuestion => ({ question_id: 1, q_type: 'mcq_single', marks: 2, negative: 0.5, ...over });

  it('mcq_single: exact single correct option scores full', () => {
    const r = scoreAttempt([q({ question_id: 1, correct_option_ids: [11] })], [{ question_id: 1, selected_option_ids: [11] }], { negativeMarking: false });
    expect(r.auto_score).toBe(2); expect(r.max_score).toBe(2); expect(r.per[0].is_correct).toBe(true);
  });

  it('mcq_multi: full marks ONLY when the selected set equals the correct set', () => {
    const qq = q({ question_id: 2, q_type: 'mcq_multi', marks: 3, correct_option_ids: [21, 22] });
    expect(scoreAttempt([qq], [{ question_id: 2, selected_option_ids: [21, 22] }], { negativeMarking: false }).auto_score).toBe(3);
    expect(scoreAttempt([qq], [{ question_id: 2, selected_option_ids: [21] }], { negativeMarking: false }).auto_score).toBe(0);        // partial → 0
    expect(scoreAttempt([qq], [{ question_id: 2, selected_option_ids: [21, 22, 23] }], { negativeMarking: false }).auto_score).toBe(0); // extra → 0
  });

  it('true_false: correct scores full, wrong scores 0 without negative marking', () => {
    const qq = q({ question_id: 3, q_type: 'true_false', marks: 1, correct_option_ids: [31] });
    expect(scoreAttempt([qq], [{ question_id: 3, selected_option_ids: [31] }], { negativeMarking: false }).auto_score).toBe(1);
    expect(scoreAttempt([qq], [{ question_id: 3, selected_option_ids: [32] }], { negativeMarking: false }).auto_score).toBe(0);
  });

  it('fill_blank: case-insensitive, trimmed exact match', () => {
    const qq = q({ question_id: 4, q_type: 'fill_blank', marks: 2, correct_texts: ['Paris'] });
    expect(scoreAttempt([qq], [{ question_id: 4, answer_text: '  paris ' }], { negativeMarking: false }).auto_score).toBe(2);
    expect(scoreAttempt([qq], [{ question_id: 4, answer_text: 'London' }], { negativeMarking: false }).auto_score).toBe(0);
  });

  it('negative marking is applied to a wrong answer, but never to an unanswered one', () => {
    const qq = q({ question_id: 5, q_type: 'mcq_single', marks: 2, negative: 0.5, correct_option_ids: [51] });
    const wrong = scoreAttempt([qq], [{ question_id: 5, selected_option_ids: [52] }], { negativeMarking: true });
    expect(wrong.per[0].awarded).toBe(-0.5);
    expect(wrong.auto_score).toBe(0); // clamped at 0
    const blank = scoreAttempt([qq], [{ question_id: 5, selected_option_ids: [] }], { negativeMarking: true });
    expect(blank.per[0].awarded).toBe(0);
  });

  it('subjective types are left null (awarded=null) pending evaluation and flip has_subjective', () => {
    const r = scoreAttempt([q({ question_id: 6, q_type: 'writing', marks: 10 })], [{ question_id: 6, answer_text: 'an essay' }], { negativeMarking: true });
    expect(r.per[0].awarded).toBeNull();
    expect(r.per[0].is_correct).toBeNull();
    expect(r.has_subjective).toBe(true);
    expect(r.auto_score).toBe(0);
    expect(r.max_score).toBe(10);
  });

  it('match_following: all pairs must match', () => {
    const qq = q({ question_id: 7, q_type: 'match_following', marks: 4, match_pairs: [{ option_id: 71, match_key: 'A' }, { option_id: 72, match_key: 'B' }] });
    expect(scoreAttempt([qq], [{ question_id: 7, answer_text: JSON.stringify({ '71': 'A', '72': 'B' }) }], { negativeMarking: false }).auto_score).toBe(4);
    expect(scoreAttempt([qq], [{ question_id: 7, answer_text: JSON.stringify({ '71': 'A', '72': 'A' }) }], { negativeMarking: false }).auto_score).toBe(0);
  });

  it('pass/fail boundary — by marks and by percent', () => {
    expect(computeIsPassed(4, 10, 4, null)).toBe(true);   // exactly at threshold passes
    expect(computeIsPassed(3.99, 10, 4, null)).toBe(false);
    expect(computeIsPassed(5, 10, null, 50)).toBe(true);  // 50% boundary passes
    expect(computeIsPassed(4.9, 10, null, 50)).toBe(false);
    expect(computeIsPassed(1, 10, null, null)).toBeNull(); // no threshold → null
  });
});

/* ============================================================ route guards ==== */
describe('Batch-C routes are catalogued + guarded', () => {
  it('catalogs the attempt + submission modules and the evaluate action', () => {
    for (const m of ['assessment_attempt', 'assignment_submission']) {
      expect(PERMISSION_CATALOG.some((x) => x.module === m)).toBe(true);
    }
    const assess = PERMISSION_CATALOG.find((x) => x.module === 'assessment');
    expect(assess?.actions).toContain('evaluate');
  });

  it('every Batch-C route declares a permission that exists in the catalog', () => {
    const keys = new Set(PERMISSION_CATALOG.flatMap((m) => m.actions.map((a) => `${m.module}.${a}`)));
    for (const C of [AttemptController, SubmissionController]) {
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

/* ============================================================ attempt guards === */
const resolver = { buildScopeWhere: () => '1=1' } as any;
const scopeAll: any = { allowed: true, all: true, filters: [] };
const me = { id: 7, name: 'T' };

/** A configurable fake DB that answers start()'s queries by matching the SQL. */
function mkDb(assessment: any, extra: Record<string, any> = {}) {
  return {
    one: async (sql: string) => {
      if (/FROM organisation/.test(sql)) return { id: '1' };
      if (/FROM assessment a WHERE a.id/.test(sql)) return assessment;
      if (/FROM student s WHERE s.id/.test(sql)) return extra.student ?? { id: '9', branch_id: '1', vertical_id: '1' };
      if (/status = 'in_progress'/.test(sql)) return extra.open ?? null;
      if (/count\(\*\) AS n FROM assessment_attempt/.test(sql)) return { n: String(extra.done ?? 0) };
      if (/FROM assessment_attempt WHERE id/.test(sql)) return extra.attempt ?? null;
      return null;
    },
    query: async () => [],
    tx: async (fn: (c: any) => any) => fn({ query: async () => ({ rows: [{ id: '55' }] }) }),
  } as any;
}
const assembleStub = { assemble: async () => ({ questions: [{ id: 1, q_type: 'mcq_single', marks: 2, negative_marks: 0 }] }) } as any;

describe('AttemptService — window / status / max-attempts / due', () => {
  it('refuses to start an unpublished test', async () => {
    const svc = new AttemptService(mkDb({ id: '5', status: 'draft', max_attempts: 1 }), resolver, assembleStub);
    await expect(svc.start(5, { student_id: 9 }, me, scopeAll)).rejects.toThrow(/not published/);
  });

  it('refuses to start before the window opens', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const svc = new AttemptService(mkDb({ id: '5', status: 'published', start_at: future, max_attempts: 1 }), resolver, assembleStub);
    await expect(svc.start(5, { student_id: 9 }, me, scopeAll)).rejects.toThrow(/not opened yet/);
  });

  it('refuses to start after the window closes', async () => {
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const svc = new AttemptService(mkDb({ id: '5', status: 'published', end_at: past, max_attempts: 1 }), resolver, assembleStub);
    await expect(svc.start(5, { student_id: 9 }, me, scopeAll)).rejects.toThrow(/has closed/);
  });

  it('refuses to start once max_attempts is reached', async () => {
    const svc = new AttemptService(mkDb({ id: '5', status: 'published', max_attempts: 2 }, { done: 2 }), resolver, assembleStub);
    await expect(svc.start(5, { student_id: 9 }, me, scopeAll)).rejects.toThrow(/Maximum attempts/);
  });

  it('rejects saving answers to an already-submitted attempt', async () => {
    const db = mkDb({ id: '5', status: 'published' });
    db.one = async (sql: string) => {
      if (/FROM assessment_attempt at/.test(sql)) return { id: '55', status: 'submitted', assembled: '[]' };
      return null;
    };
    const svc = new AttemptService(db, resolver, assembleStub);
    await expect(svc.saveAnswers(55, { answers: [] }, me, scopeAll)).rejects.toThrow(/already submitted/);
  });

  it('rejects saving answers past due_at', async () => {
    const db = mkDb({ id: '5', status: 'published' });
    db.one = async (sql: string) => {
      if (/FROM assessment_attempt at/.test(sql)) return { id: '55', status: 'in_progress', assembled: '[]', due_at: new Date(Date.now() - 60_000).toISOString() };
      return null;
    };
    const svc = new AttemptService(db, resolver, assembleStub);
    await expect(svc.saveAnswers(55, { answers: [] }, me, scopeAll)).rejects.toThrow(/Time is up/);
  });
});
