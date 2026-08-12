import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { GradeSchemeService } from './grade-scheme.service';
import { resolveBand } from './grade';

/**
 * RESULTS + ANALYTICS + LEADERBOARD — Assessment Batch D.
 *
 * Turns an EVALUATED attempt into a student-facing RESULT: percentage, grade (via the test's
 * scheme or the org default), pass/fail, a per-question score breakdown and analytics
 * (per-topic/category, per-difficulty, per-q_type accuracy, correct/incorrect/unattempted, time
 * taken). The result is GATED by the test's show_result_mode: instant (as soon as it is scored),
 * manual (only after a faculty marks it evaluated), after_end (only after the availability window
 * closes). The leaderboard ranks students by total score (dense rank) with a percentile.
 * Scope-enforced through the central ScopeResolver.
 */
const ATTEMPT_SCOPE_COLS: ScopeColumnMap = {
  owner: 'at.created_by', team: 'at.team_id', branch: 'at.branch_id', vertical: 'at.vertical_id', pipeline: 'at.pipeline_id',
};
const ASSESSMENT_SCOPE_COLS: ScopeColumnMap = {
  owner: 'a.created_by', team: 'a.team_id', branch: 'a.branch_id', vertical: 'a.vertical_id', pipeline: 'a.pipeline_id',
};
const OBJECTIVE = new Set(['mcq_single', 'mcq_multi', 'true_false', 'image_mcq', 'audio_mcq', 'video_mcq', 'match_following', 'fill_blank']);

@Injectable()
export class ResultService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly grades: GradeSchemeService,
  ) {}

  private async attemptRow(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, ATTEMPT_SCOPE_COLS, params);
    const at = await this.db.one<any>(
      `SELECT at.*, a.title AS assessment_title, a.test_type, a.show_result_mode, a.end_at,
              a.passing_marks, a.passing_pct, a.grade_scheme_id, a.total_marks AS assessment_total,
              s.full_name AS student_name, s.student_no
         FROM assessment_attempt at
         JOIN assessment a ON a.id = at.assessment_id
         JOIN student s ON s.id = at.student_id
        WHERE at.id = $1::bigint AND at.deleted_at IS NULL AND ${w}`, params);
    if (!at) throw new NotFoundException('Attempt not found (or outside your access)');
    return at;
  }

  /** Is the result released to view, per show_result_mode? Returns {available, reason}. */
  private gate(at: any): { available: boolean; reason: string } {
    if (at.status === 'in_progress') return { available: false, reason: 'This attempt has not been submitted yet.' };
    const mode = at.show_result_mode || 'instant';
    if (mode === 'manual' && at.status !== 'evaluated') {
      return { available: false, reason: 'Your result will be available once the faculty has finished evaluating this test.' };
    }
    // Governance: in manual mode the Academic Admin must RELEASE the result before the student
    // sees it (results.publish). A trainer evaluates + records marks, but does not release.
    if (mode === 'manual' && !at.results_released_at) {
      return { available: false, reason: 'Your result is being reviewed and will be released by the Academic Admin shortly.' };
    }
    if (mode === 'after_end') {
      const ended = at.end_at && Date.now() > new Date(at.end_at).getTime();
      if (!ended) return { available: false, reason: 'Your result will be available after the test window closes.' };
    }
    return { available: true, reason: '' };
  }

  async attemptResult(attemptId: number, scope: ResolvedScope, opts: { bypassGate?: boolean } = {}) {
    const at = await this.attemptRow(attemptId, scope);
    const gate = this.gate(at);
    const total = at.total_score != null ? Number(at.total_score) : null;
    const max = Number(at.max_score) || 0;
    const pct = total != null && max > 0 ? Math.round((total / max) * 10000) / 100 : null;
    const grade = await this.grades.gradeFor(pct, at.grade_scheme_id ? Number(at.grade_scheme_id) : null);

    const head = {
      attempt_id: Number(at.id), assessment_id: Number(at.assessment_id), assessment_title: at.assessment_title,
      test_type: at.test_type, student_id: Number(at.student_id), student_name: at.student_name, student_no: at.student_no,
      attempt_no: Number(at.attempt_no), status: at.status, show_result_mode: at.show_result_mode,
      started_at: at.started_at, submitted_at: at.submitted_at, evaluated_at: at.evaluated_at,
      auto_score: at.auto_score != null ? Number(at.auto_score) : null,
      manual_score: at.manual_score != null ? Number(at.manual_score) : null,
      total_score: total, max_score: max, percentage: pct,
      grade_label: grade.grade_label, grade_scheme: grade.scheme_name,
      is_passed: at.is_passed,
      passing_marks: at.passing_marks != null ? Number(at.passing_marks) : null,
      passing_pct: at.passing_pct != null ? Number(at.passing_pct) : null,
      time_taken_sec: at.submitted_at && at.started_at
        ? Math.max(0, Math.round((new Date(at.submitted_at).getTime() - new Date(at.started_at).getTime()) / 1000)) : null,
    };

    if (!gate.available && !opts.bypassGate) {
      return { ...head, available: false, reason: gate.reason };
    }

    // ---- analytics over the frozen set + answers + question meta ----
    const frozen: any[] = Array.isArray(at.assembled) ? at.assembled : JSON.parse(at.assembled || '[]');
    const ids = frozen.map((f) => Number(f.question_id));
    const qmeta = ids.length ? await this.db.query<any>(
      `SELECT q.id, q.q_type, q.difficulty, q.category_id, c.name AS category_name
         FROM question q LEFT JOIN question_category c ON c.id = q.category_id
        WHERE q.id = ANY($1::bigint[])`, [ids]) : [];
    const metaById = new Map<number, any>(qmeta.map((q) => [Number(q.id), q]));
    const ans = ids.length ? await this.db.query<any>(
      `SELECT question_id, is_correct, awarded_marks, evaluator_marks, selected_option_ids, answer_text, file_r2_key
         FROM attempt_answer WHERE attempt_id = $1::bigint`, [attemptId]) : [];
    const ansByQ = new Map<number, any>(ans.map((a) => [Number(a.question_id), a]));

    const bucket = () => ({ total: 0, correct: 0, incorrect: 0, unattempted: 0, marks: 0, max: 0 });
    const byTopic: Record<string, any> = {};
    const byDifficulty: Record<string, any> = {};
    const byType: Record<string, any> = {};
    let correct = 0, incorrect = 0, unattempted = 0, subjectivePending = 0;

    const add = (map: Record<string, any>, key: string, marks: number, qmax: number, state: 'correct' | 'incorrect' | 'unattempted') => {
      if (!map[key]) map[key] = bucket();
      const b = map[key];
      b.total += 1; b.max += qmax; b.marks += marks; b[state] += 1;
    };

    for (const f of frozen) {
      const qid = Number(f.question_id);
      const m = metaById.get(qid) ?? { q_type: f.q_type, difficulty: 'medium', category_name: null };
      const a = ansByQ.get(qid);
      const qmax = Number(f.marks) || 0;
      const awarded = a ? Number(a.evaluator_marks ?? a.awarded_marks ?? 0) : 0;
      const answered = a && ((a.selected_option_ids?.length ?? 0) > 0 || (a.answer_text != null && String(a.answer_text).trim() !== '') || a.file_r2_key);
      const objective = OBJECTIVE.has(m.q_type);
      let state: 'correct' | 'incorrect' | 'unattempted';
      if (!answered) { state = 'unattempted'; unattempted += 1; }
      else if (objective) { if (a.is_correct) { state = 'correct'; correct += 1; } else { state = 'incorrect'; incorrect += 1; } }
      else {
        // subjective: correct if it earned full marks; pending if not yet evaluated
        if (a.evaluator_marks == null) { subjectivePending += 1; state = 'unattempted'; }
        else if (awarded >= qmax && qmax > 0) { state = 'correct'; correct += 1; }
        else { state = 'incorrect'; incorrect += 1; }
      }
      add(byTopic, m.category_name || 'Uncategorised', awarded, qmax, state);
      add(byDifficulty, m.difficulty || 'medium', awarded, qmax, state);
      add(byType, m.q_type, awarded, qmax, state);
    }

    const shape = (map: Record<string, any>) => Object.entries(map).map(([k, b]) => ({
      key: k, ...b, accuracy_pct: b.total ? Math.round(((b.correct) / b.total) * 10000) / 100 : 0,
      score_pct: b.max ? Math.round((b.marks / b.max) * 10000) / 100 : 0,
    }));

    return {
      ...head, available: true, reason: '',
      analytics: {
        counts: { total: frozen.length, correct, incorrect, unattempted, subjective_pending: subjectivePending },
        by_topic: shape(byTopic),
        by_difficulty: shape(byDifficulty),
        by_type: shape(byType),
      },
    };
  }

  /** LEADERBOARD — scope-enforced ranked results for a test (best evaluated attempt per student). */
  /**
   * RELEASE a manual-mode result to the student (results.publish — Academic Admin / Super Admin).
   * The attempt must be evaluated. Idempotent. Trainers evaluate + record marks but do NOT hold
   * results.publish, so this is the governance gate on results going out to students.
   */
  async releaseAttempt(attemptId: number, me: { id: number }, scope: ResolvedScope) {
    const at = await this.attemptRow(attemptId, scope);
    if (at.status !== 'evaluated') {
      throw new BadRequestException('Only an evaluated attempt can have its result released.');
    }
    if (at.results_released_at) return { id: attemptId, released: true, already: true };
    await this.db.query(
      `UPDATE assessment_attempt SET results_released_at = now(), results_released_by = $2 WHERE id = $1::bigint`,
      [attemptId, me?.id ?? null]);
    const org = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    await this.db.query(
      `INSERT INTO audit_log (org_id, actor_id, entity_type, entity_id, action, after)
       VALUES ($1,$2,'assessment_result',$3::bigint,'results_release',$4)`,
      [Number(org?.id), me?.id ?? null, attemptId, JSON.stringify({ released: true })]);
    return { id: attemptId, released: true };
  }

  /** RELEASE every evaluated-but-unreleased attempt of a test in one action (results.publish). */
  async releaseAssessment(assessmentId: number, me: { id: number }, scope: ResolvedScope) {
    const params: unknown[] = [assessmentId];
    const w = this.resolver.buildScopeWhere(scope, ASSESSMENT_SCOPE_COLS, params);
    const rows = await this.db.query<{ id: string }>(
      `SELECT at.id FROM assessment_attempt at JOIN assessment a ON a.id = at.assessment_id
        WHERE at.assessment_id = $1::bigint AND at.deleted_at IS NULL
          AND at.status = 'evaluated' AND at.results_released_at IS NULL AND ${w}`, params);
    let released = 0;
    for (const r of rows) { await this.releaseAttempt(Number(r.id), me, scope); released++; }
    return { assessment_id: assessmentId, released };
  }

  async leaderboard(assessmentId: number, scope: ResolvedScope) {
    const params: unknown[] = [assessmentId];
    const aw = this.resolver.buildScopeWhere(scope, ASSESSMENT_SCOPE_COLS, params);
    const a = await this.db.one<any>(
      `SELECT a.*, b.name AS branch_name, v.name AS vertical_name, c.name AS course_name
         FROM assessment a
         LEFT JOIN branch b ON b.id = a.branch_id
         LEFT JOIN vertical v ON v.id = a.vertical_id
         LEFT JOIN m_course c ON c.id = a.course_id
        WHERE a.id = $1::bigint AND a.deleted_at IS NULL AND ${aw}`, params);
    if (!a) throw new NotFoundException('Test not found (or outside your access)');

    const p2: unknown[] = [assessmentId];
    const atw = this.resolver.buildScopeWhere(scope, ATTEMPT_SCOPE_COLS, p2);
    // best evaluated attempt per student, then dense-rank + percentile in JS for clarity.
    const rows = await this.db.query<any>(
      `SELECT DISTINCT ON (at.student_id) at.id, at.student_id, at.attempt_no, at.total_score, at.max_score,
              at.is_passed, at.submitted_at, at.evaluated_at, s.full_name AS student_name, s.student_no,
              b.name AS branch_name, v.name AS vertical_name
         FROM assessment_attempt at
         JOIN student s ON s.id = at.student_id
         LEFT JOIN branch b ON b.id = at.branch_id
         LEFT JOIN vertical v ON v.id = at.vertical_id
        WHERE at.assessment_id = $1::bigint AND at.deleted_at IS NULL AND at.status = 'evaluated'
          AND at.total_score IS NOT NULL AND ${atw}
        ORDER BY at.student_id, at.total_score DESC, at.evaluated_at DESC`, p2);

    const sch = await this.grades.effectiveScheme(a.grade_scheme_id ? Number(a.grade_scheme_id) : null);
    const scored = rows.map((r) => {
      const total = Number(r.total_score);
      const max = Number(r.max_score) || 0;
      const pct = max > 0 ? Math.round((total / max) * 10000) / 100 : 0;
      const band = sch ? resolveBand(sch.bands, pct) : null;
      return {
        attempt_id: Number(r.id), student_id: Number(r.student_id), student_name: r.student_name, student_no: r.student_no,
        branch_name: r.branch_name, vertical_name: r.vertical_name,
        total_score: total, max_score: max, percentage: pct,
        grade_label: band?.label ?? null, is_passed: r.is_passed,
        attempt_no: Number(r.attempt_no), submitted_at: r.submitted_at, evaluated_at: r.evaluated_at,
      };
    });
    scored.sort((x, y) => y.total_score - x.total_score);
    const n = scored.length;
    let rank = 0, prev: number | null = null, seen = 0;
    const results = scored.map((r) => {
      seen += 1;
      if (prev === null || r.total_score < prev) { rank += 1; prev = r.total_score; }
      const lower = scored.filter((o) => o.total_score < r.total_score).length;
      const percentile = n > 1 ? Math.round((lower / (n - 1)) * 10000) / 100 : 100;
      return { ...r, rank, percentile };
    });

    const passed = results.filter((r) => r.is_passed).length;
    const avgPct = n ? Math.round((results.reduce((s, r) => s + r.percentage, 0) / n) * 100) / 100 : 0;
    return {
      assessment: {
        id: Number(a.id), title: a.title, test_type: a.test_type, total_marks: Number(a.total_marks),
        branch_name: a.branch_name, vertical_name: a.vertical_name, course_name: a.course_name,
        passing_marks: a.passing_marks != null ? Number(a.passing_marks) : null,
        passing_pct: a.passing_pct != null ? Number(a.passing_pct) : null,
        grade_scheme: sch?.name ?? null,
      },
      summary: { students: n, passed, failed: n - passed, pass_rate: n ? Math.round((passed / n) * 10000) / 100 : 0, avg_pct: avgPct },
      results,
    };
  }
}
