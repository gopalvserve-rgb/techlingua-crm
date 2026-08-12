import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { AssessmentService } from './assessment.service';
import { scoreAttempt, computeIsPassed, ScorerQuestion, ScorerAnswer } from './scorer';

/**
 * ATTEMPT FLOW — Assessment Batch C.
 *
 * A student TAKES a published test. startAttempt() validates the availability window,
 * publish status, student scope and max_attempts, then FREEZES the assembled question set
 * (via AssessmentService.assemble — the Batch B seam, NOT re-implemented here) into the
 * attempt so scoring/review is stable for randomised/pooled tests, and computes due_at.
 * Answers autosave (in-progress, before due, owner-scoped). submit() auto-scores the
 * objective portion and, when there is no subjective question, finalises the result. Faculty
 * evaluate() fills subjective marks and recomputes the total. expireOverdue() sweeps timed-out
 * attempts. Scope-enforced through the central ScopeResolver, like every other entity.
 */
export const ATTEMPT_SCOPE_COLS: ScopeColumnMap = {
  owner: 'at.created_by', team: 'at.team_id', branch: 'at.branch_id',
  vertical: 'at.vertical_id', pipeline: 'at.pipeline_id',
};
const STUDENT_SCOPE_COLS: ScopeColumnMap = {
  owner: 's.owner_id', team: 's.team_id', branch: 's.branch_id', vertical: 's.vertical_id',
};
const ASSESSMENT_SCOPE_COLS: ScopeColumnMap = {
  owner: 'a.created_by', team: 'a.team_id', branch: 'a.branch_id', vertical: 'a.vertical_id', pipeline: 'a.pipeline_id',
};

interface Me { id: number; name?: string }

@Injectable()
export class AttemptService {
  private readonly log = new Logger('AssessmentAttempt');

  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly assessments: AssessmentService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  /** The assessment row, scope-enforced (mirrors AssessmentService.getRow which is private). */
  private async scopedAssessment(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, ASSESSMENT_SCOPE_COLS, params);
    const a = await this.db.one<any>(
      `SELECT a.* FROM assessment a WHERE a.id = $1::bigint AND a.deleted_at IS NULL AND ${w}`, params);
    if (!a) throw new NotFoundException('Test not found (or outside your access)');
    return a;
  }

  private async scopedStudent(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, STUDENT_SCOPE_COLS, params);
    const s = await this.db.one<any>(
      `SELECT s.id, s.full_name, s.student_no, s.branch_id, s.vertical_id, s.owner_id, s.team_id
         FROM student s WHERE s.id = $1::bigint AND s.deleted_at IS NULL AND ${w}`, params);
    if (!s) throw new NotFoundException('Student not found (or outside your access)');
    return s;
  }

  private async attemptRow(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, ATTEMPT_SCOPE_COLS, params);
    const at = await this.db.one<any>(
      `SELECT at.*, a.title AS assessment_title, a.test_type, a.show_result_mode, a.negative_marking,
              a.passing_marks, a.passing_pct, a.total_marks AS assessment_total, s.full_name AS student_name, s.student_no
         FROM assessment_attempt at
         JOIN assessment a ON a.id = at.assessment_id
         JOIN student s ON s.id = at.student_id
        WHERE at.id = $1::bigint AND at.deleted_at IS NULL AND ${w}`, params);
    if (!at) throw new NotFoundException('Attempt not found (or outside your access)');
    return at;
  }

  /* --------------------------------------------------------------- start attempt */

  async start(assessmentId: number, dto: any, me: Me, scope: ResolvedScope) {
    const org = await this.orgId();
    const a = await this.scopedAssessment(assessmentId, scope);
    if (a.status !== 'published') throw new BadRequestException('This test is not published — it cannot be attempted.');
    const now = Date.now();
    if (a.start_at && now < new Date(a.start_at).getTime()) throw new BadRequestException('This test has not opened yet.');
    if (a.end_at && now > new Date(a.end_at).getTime()) throw new BadRequestException('The availability window for this test has closed.');

    const studentId = Number(dto?.student_id);
    if (!Number.isInteger(studentId) || studentId <= 0) throw new BadRequestException('Choose a student to start the attempt for.');
    const student = await this.scopedStudent(studentId, scope);

    // resume an in-progress attempt (that has not timed out) instead of making a second one
    const open = await this.db.one<any>(
      `SELECT * FROM assessment_attempt
        WHERE assessment_id = $1::bigint AND student_id = $2::bigint AND status = 'in_progress' AND deleted_at IS NULL
        ORDER BY attempt_no DESC LIMIT 1`, [assessmentId, studentId]);
    if (open && (!open.due_at || new Date(open.due_at).getTime() > now)) {
      const resume = await this.assembleForPlayer(open);
      return { attempt: this.attemptMeta(open), ...resume, resumed: true };
    }

    const done = await this.db.one<{ n: string }>(
      `SELECT count(*) AS n FROM assessment_attempt
        WHERE assessment_id = $1::bigint AND student_id = $2::bigint AND deleted_at IS NULL
          AND status IN ('submitted','evaluated','expired')`, [assessmentId, studentId]);
    const maxAttempts = Number(a.max_attempts) || 1;
    if (Number(done?.n ?? 0) >= maxAttempts) {
      throw new BadRequestException(`Maximum attempts (${maxAttempts}) reached for this student.`);
    }
    const attemptNo = Number(done?.n ?? 0) + 1;

    // FREEZE the assembled set via the Batch B seam (answers stripped for the player).
    const assembled = await this.assessments.assemble(assessmentId, scope, { forAttempt: true });
    const frozen = assembled.questions.map((q: any, i: number) => ({
      question_id: Number(q.id), q_type: q.q_type, marks: Number(q.marks) || 0,
      negative: Number(q.negative_marks) > 0 ? Number(q.negative_marks) : Number(a.default_negative) || 0,
      ordering: i + 1,
    }));
    const maxScore = frozen.reduce((s: number, f: any) => s + f.marks, 0);
    const durationMin = Number(a.duration_min) || 0;
    const dueAt = durationMin > 0 ? new Date(now + durationMin * 60_000).toISOString() : null;

    const attemptId = await this.db.tx(async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO assessment_attempt (org_id, branch_id, vertical_id, assessment_id, student_id, attempt_no,
            status, started_at, due_at, assembled, max_score, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'in_progress', now(), $7, $8::jsonb, $9, $10) RETURNING id`,
        [org, student.branch_id ?? a.branch_id, student.vertical_id ?? a.vertical_id, assessmentId, studentId,
          attemptNo, dueAt, JSON.stringify(frozen), maxScore, me.id]);
      const aid = Number(r.rows[0].id);
      for (const f of frozen) {
        await c.query(
          `INSERT INTO attempt_answer (attempt_id, question_id, q_type, ordering)
           VALUES ($1::bigint,$2::bigint,$3,$4::int) ON CONFLICT (attempt_id, question_id) DO NOTHING`,
          [aid, f.question_id, f.q_type, f.ordering]);
      }
      return aid;
    });

    const row = await this.db.one<any>(`SELECT * FROM assessment_attempt WHERE id = $1::bigint`, [attemptId]);
    const player = await this.assembleForPlayer(row, assembled);
    return { attempt: this.attemptMeta(row), ...player, resumed: false };
  }

  private attemptMeta(row: any) {
    return {
      id: Number(row.id), assessment_id: Number(row.assessment_id), student_id: Number(row.student_id),
      attempt_no: Number(row.attempt_no), status: row.status,
      started_at: row.started_at, due_at: row.due_at, server_time: new Date().toISOString(),
      max_score: Number(row.max_score),
    };
  }

  /** The stripped player payload for a (frozen) attempt + any saved answers. */
  private async assembleForPlayer(row: any, assembled?: any) {
    const frozen: any[] = Array.isArray(row.assembled) ? row.assembled : JSON.parse(row.assembled || '[]');
    const saved = await this.db.query<any>(
      `SELECT question_id, selected_option_ids, answer_text FROM attempt_answer WHERE attempt_id = $1::bigint`, [row.id]);
    const savedBy = new Map<number, any>();
    for (const s of saved) savedBy.set(Number(s.question_id), s);

    let strippedById = new Map<number, any>();
    if (assembled) {
      for (const q of assembled.questions) strippedById.set(Number(q.id), q);
    } else {
      // re-load question bodies/options for a resumed attempt (answers stripped)
      const ids = frozen.map((f) => Number(f.question_id));
      if (ids.length) {
        const qs = await this.db.query<any>(
          `SELECT id, q_type, difficulty, body, language, marks, negative_marks, youtube_url, youtube_start_sec, youtube_end_sec,
                  image_r2_key, audio_r2_key FROM question WHERE id = ANY($1::bigint[])`, [ids]);
        const opts = await this.db.query<any>(
          `SELECT question_id, id, body, image_r2_key, ordering, match_key FROM question_option
            WHERE question_id = ANY($1::bigint[]) ORDER BY ordering, id`, [ids]);
        const optsByQ = new Map<number, any[]>();
        for (const o of opts) { const k = Number(o.question_id); if (!optsByQ.has(k)) optsByQ.set(k, []); optsByQ.get(k)!.push({ id: Number(o.id), body: o.body, ordering: o.ordering, match_key: o.match_key ?? null }); }
        for (const q of qs) strippedById.set(Number(q.id), { ...q, id: Number(q.id), options: optsByQ.get(Number(q.id)) ?? [] });
      }
    }

    const questions = frozen.map((f) => {
      const q = strippedById.get(Number(f.question_id)) ?? { id: f.question_id, q_type: f.q_type, body: '(question unavailable)', options: [] };
      const ans = savedBy.get(Number(f.question_id));
      return {
        question_id: Number(f.question_id), q_type: f.q_type, marks: f.marks, ordering: f.ordering,
        body: q.body, difficulty: q.difficulty, language: q.language,
        image_url: q.image_url ?? null, audio_url: q.audio_url ?? null,
        youtube_url: q.youtube_url ?? null, youtube_start_sec: q.youtube_start_sec ?? null, youtube_end_sec: q.youtube_end_sec ?? null,
        options: (q.options ?? []).map((o: any) => ({ id: Number(o.id), body: o.body, ordering: o.ordering, match_key: o.match_key ?? null })),
        selected_option_ids: (ans?.selected_option_ids ?? []).map(Number),
        answer_text: ans?.answer_text ?? '',
      };
    });
    return { questions };
  }

  /* --------------------------------------------------------------- save answers */

  async saveAnswers(attemptId: number, dto: any, me: Me, scope: ResolvedScope) {
    const at = await this.attemptRow(attemptId, scope);
    if (at.status !== 'in_progress') throw new BadRequestException('This attempt is already submitted.');
    if (at.due_at && Date.now() > new Date(at.due_at).getTime()) {
      throw new BadRequestException('Time is up — this attempt can no longer be edited. Submit it to score.');
    }
    const frozen: any[] = Array.isArray(at.assembled) ? at.assembled : JSON.parse(at.assembled || '[]');
    const allowed = new Set(frozen.map((f) => Number(f.question_id)));
    const answers = Array.isArray(dto?.answers) ? dto.answers : [];
    let saved = 0;
    for (const ans of answers) {
      const qid = Number(ans?.question_id);
      if (!allowed.has(qid)) continue;
      const sel = Array.isArray(ans?.selected_option_ids) ? ans.selected_option_ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0) : [];
      const text = ans?.answer_text != null ? String(ans.answer_text) : null;
      await this.db.query(
        `INSERT INTO attempt_answer (attempt_id, question_id, q_type, selected_option_ids, answer_text, ordering)
         VALUES ($1::bigint, $2::bigint,
                 (SELECT q_type FROM question WHERE id = $2::bigint),
                 $3::bigint[], $4,
                 COALESCE((SELECT ordering FROM attempt_answer WHERE attempt_id = $1::bigint AND question_id = $2::bigint), 1))
         ON CONFLICT (attempt_id, question_id)
         DO UPDATE SET selected_option_ids = EXCLUDED.selected_option_ids, answer_text = EXCLUDED.answer_text`,
        [attemptId, qid, sel, text]);
      saved += 1;
    }
    await this.db.query(`UPDATE assessment_attempt SET updated_at = now() WHERE id = $1::bigint`, [attemptId]);
    return { ok: true, saved };
  }

  /* -------------------------------------------------------------------- submit */

  /** Load ScorerQuestion[] (correct answers) for a frozen attempt. */
  private async scorerQuestions(frozen: any[]): Promise<ScorerQuestion[]> {
    const ids = frozen.map((f) => Number(f.question_id));
    if (!ids.length) return [];
    const opts = await this.db.query<any>(
      `SELECT question_id, id, body, is_correct, match_key FROM question_option WHERE question_id = ANY($1::bigint[])`, [ids]);
    const byQ = new Map<number, any[]>();
    for (const o of opts) { const k = Number(o.question_id); if (!byQ.has(k)) byQ.set(k, []); byQ.get(k)!.push(o); }
    return frozen.map((f) => {
      const os = byQ.get(Number(f.question_id)) ?? [];
      const correct = os.filter((o) => o.is_correct);
      return {
        question_id: Number(f.question_id), q_type: f.q_type, marks: Number(f.marks) || 0, negative: Number(f.negative) || 0,
        correct_option_ids: correct.map((o) => Number(o.id)),
        correct_texts: correct.map((o) => String(o.body ?? '')),
        match_pairs: os.filter((o) => o.match_key).map((o) => ({ option_id: Number(o.id), match_key: String(o.match_key) })),
      };
    });
  }

  async submit(attemptId: number, dto: any, me: Me, scope: ResolvedScope) {
    const at = await this.attemptRow(attemptId, scope);
    if (at.status !== 'in_progress') throw new BadRequestException('This attempt has already been submitted.');
    if (Array.isArray(dto?.answers) && dto.answers.length) {
      // final flush of any unsaved answers (allowed even a hair past due — this finalises)
      const frozen: any[] = Array.isArray(at.assembled) ? at.assembled : JSON.parse(at.assembled || '[]');
      const allowed = new Set(frozen.map((f) => Number(f.question_id)));
      for (const ans of dto.answers) {
        const qid = Number(ans?.question_id);
        if (!allowed.has(qid)) continue;
        const sel = Array.isArray(ans?.selected_option_ids) ? ans.selected_option_ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0) : [];
        const text = ans?.answer_text != null ? String(ans.answer_text) : null;
        await this.db.query(
          `INSERT INTO attempt_answer (attempt_id, question_id, q_type, selected_option_ids, answer_text, ordering)
           VALUES ($1::bigint,$2::bigint,(SELECT q_type FROM question WHERE id=$2::bigint),$3::bigint[],$4,
                   COALESCE((SELECT ordering FROM attempt_answer WHERE attempt_id=$1::bigint AND question_id=$2::bigint),1))
           ON CONFLICT (attempt_id, question_id)
           DO UPDATE SET selected_option_ids = EXCLUDED.selected_option_ids, answer_text = EXCLUDED.answer_text`,
          [attemptId, qid, sel, text]);
      }
    }
    return this.finalise(at, 'submitted', me);
  }

  /** Score the objective portion; finalise result when there is no subjective question. */
  private async finalise(at: any, terminalStatus: 'submitted' | 'expired', me: Me) {
    const frozen: any[] = Array.isArray(at.assembled) ? at.assembled : JSON.parse(at.assembled || '[]');
    const questions = await this.scorerQuestions(frozen);
    const rawAnswers = await this.db.query<any>(
      `SELECT question_id, selected_option_ids, answer_text FROM attempt_answer WHERE attempt_id = $1::bigint`, [at.id]);
    const answers: ScorerAnswer[] = rawAnswers.map((r) => ({
      question_id: Number(r.question_id), selected_option_ids: (r.selected_option_ids ?? []).map(Number), answer_text: r.answer_text ?? null,
    }));
    const result = scoreAttempt(questions, answers, { negativeMarking: !!at.negative_marking });

    await this.db.tx(async (c) => {
      for (const p of result.per) {
        if (!p.objective) continue;
        await c.query(
          `UPDATE attempt_answer SET is_correct = $2, awarded_marks = $3 WHERE attempt_id = $1::bigint AND question_id = $4::bigint`,
          [at.id, p.is_correct, p.awarded, p.question_id]);
      }
      if (result.has_subjective) {
        await c.query(
          `UPDATE assessment_attempt SET status = $2, submitted_at = now(), auto_score = $3, max_score = $4,
              total_score = NULL, is_passed = NULL, updated_at = now() WHERE id = $1::bigint`,
          [at.id, terminalStatus, result.auto_score, result.max_score]);
      } else {
        const total = result.auto_score;
        const passed = computeIsPassed(total, result.max_score, at.passing_marks != null ? Number(at.passing_marks) : null, at.passing_pct != null ? Number(at.passing_pct) : null);
        // No subjective: an on-time submit is fully evaluated; an expired one stays 'expired' but scored.
        const status = terminalStatus === 'expired' ? 'expired' : 'evaluated';
        await c.query(
          `UPDATE assessment_attempt SET status = $2, submitted_at = now(), auto_score = $3, manual_score = 0,
              total_score = $4, max_score = $5, is_passed = $6, evaluated_at = CASE WHEN $2 = 'evaluated' THEN now() ELSE evaluated_at END,
              updated_at = now() WHERE id = $1::bigint`,
          [at.id, status, result.auto_score, total, result.max_score, passed]);
      }
    });

    const fresh = await this.db.one<any>(`SELECT * FROM assessment_attempt WHERE id = $1::bigint`, [at.id]);
    return {
      id: Number(at.id), status: fresh.status, auto_score: Number(fresh.auto_score),
      total_score: fresh.total_score != null ? Number(fresh.total_score) : null,
      max_score: Number(fresh.max_score), is_passed: fresh.is_passed,
      has_subjective: result.has_subjective, show_result_mode: at.show_result_mode,
    };
  }

  /* --------------------------------------------------------------------- expire */

  /** Idempotent sweep: score any in-progress attempt whose due_at has passed, as 'expired'. */
  async expireOverdue(_me: Me): Promise<{ expired: number }> {
    const overdue = await this.db.query<any>(
      `SELECT at.*, a.negative_marking, a.passing_marks, a.passing_pct, a.show_result_mode
         FROM assessment_attempt at JOIN assessment a ON a.id = at.assessment_id
        WHERE at.status = 'in_progress' AND at.deleted_at IS NULL
          AND at.due_at IS NOT NULL AND at.due_at < now()`, []);
    let n = 0;
    for (const at of overdue) {
      try { await this.finalise(at, 'expired', { id: at.created_by ?? 0 }); n += 1; }
      catch (e) { this.log.warn(`expire attempt ${at.id} failed: ${(e as Error).message}`); }
    }
    return { expired: n };
  }

  /* ----------------------------------------------------------------- evaluation */

  /** Full attempt for the evaluator: questions + student answers + (post-submit) the answer key. */
  async get(attemptId: number, scope: ResolvedScope) {
    const at = await this.attemptRow(attemptId, scope);
    const frozen: any[] = Array.isArray(at.assembled) ? at.assembled : JSON.parse(at.assembled || '[]');
    const ids = frozen.map((f) => Number(f.question_id));
    const withKey = at.status !== 'in_progress';
    const questions = ids.length ? await this.db.query<any>(
      `SELECT id, q_type, difficulty, body, language, marks, negative_marks, explanation, youtube_url
         FROM question WHERE id = ANY($1::bigint[])`, [ids]) : [];
    const qById = new Map<number, any>(questions.map((q) => [Number(q.id), q]));
    const opts = ids.length ? await this.db.query<any>(
      `SELECT question_id, id, body, is_correct, ordering, match_key FROM question_option
        WHERE question_id = ANY($1::bigint[]) ORDER BY ordering, id`, [ids]) : [];
    const optsByQ = new Map<number, any[]>();
    for (const o of opts) { const k = Number(o.question_id); if (!optsByQ.has(k)) optsByQ.set(k, []); optsByQ.get(k)!.push(o); }
    const ans = await this.db.query<any>(
      `SELECT question_id, selected_option_ids, answer_text, file_r2_key, is_correct, awarded_marks, evaluator_marks, evaluator_feedback
         FROM attempt_answer WHERE attempt_id = $1::bigint`, [attemptId]);
    const ansByQ = new Map<number, any>(ans.map((a) => [Number(a.question_id), a]));

    const out = frozen.map((f) => {
      const q = qById.get(Number(f.question_id)) ?? {};
      const a = ansByQ.get(Number(f.question_id)) ?? {};
      const os = (optsByQ.get(Number(f.question_id)) ?? []).map((o) => ({
        id: Number(o.id), body: o.body, ordering: o.ordering, match_key: o.match_key ?? null,
        ...(withKey ? { is_correct: !!o.is_correct } : {}),
      }));
      const objective = ['mcq_single', 'mcq_multi', 'true_false', 'image_mcq', 'audio_mcq', 'video_mcq', 'match_following', 'fill_blank'].includes(f.q_type);
      return {
        question_id: Number(f.question_id), q_type: f.q_type, marks: f.marks, ordering: f.ordering, objective,
        body: q.body, difficulty: q.difficulty, language: q.language,
        explanation: withKey ? (q.explanation ?? null) : null,
        options: os,
        selected_option_ids: (a.selected_option_ids ?? []).map(Number),
        answer_text: a.answer_text ?? '',
        file_r2_key: a.file_r2_key ?? null,
        is_correct: withKey ? (a.is_correct ?? null) : null,
        awarded_marks: withKey ? (a.awarded_marks != null ? Number(a.awarded_marks) : null) : null,
        evaluator_marks: a.evaluator_marks != null ? Number(a.evaluator_marks) : null,
        evaluator_feedback: a.evaluator_feedback ?? null,
      };
    });

    return {
      id: Number(at.id), assessment_id: Number(at.assessment_id), assessment_title: at.assessment_title,
      test_type: at.test_type, student_id: Number(at.student_id), student_name: at.student_name, student_no: at.student_no,
      attempt_no: Number(at.attempt_no), status: at.status,
      started_at: at.started_at, submitted_at: at.submitted_at, due_at: at.due_at, evaluated_at: at.evaluated_at,
      auto_score: at.auto_score != null ? Number(at.auto_score) : null,
      manual_score: at.manual_score != null ? Number(at.manual_score) : null,
      total_score: at.total_score != null ? Number(at.total_score) : null,
      max_score: Number(at.max_score), is_passed: at.is_passed,
      passing_marks: at.passing_marks != null ? Number(at.passing_marks) : null,
      passing_pct: at.passing_pct != null ? Number(at.passing_pct) : null,
      show_result_mode: at.show_result_mode,
      server_time: new Date().toISOString(),
      questions: out,
    };
  }

  async evaluate(attemptId: number, dto: any, me: Me, scope: ResolvedScope) {
    const at = await this.attemptRow(attemptId, scope);
    if (at.status === 'in_progress') throw new BadRequestException('This attempt has not been submitted yet.');
    const frozen: any[] = Array.isArray(at.assembled) ? at.assembled : JSON.parse(at.assembled || '[]');
    const marksByQ = new Map<number, number>(frozen.map((f) => [Number(f.question_id), Number(f.marks) || 0]));
    const subjective = new Set(frozen.filter((f) => !['mcq_single', 'mcq_multi', 'true_false', 'image_mcq', 'audio_mcq', 'video_mcq', 'match_following', 'fill_blank'].includes(f.q_type)).map((f) => Number(f.question_id)));
    const items = Array.isArray(dto?.answers) ? dto.answers : [];

    await this.db.tx(async (c) => {
      for (const it of items) {
        const qid = Number(it?.question_id);
        if (!subjective.has(qid)) continue;
        const cap = marksByQ.get(qid) ?? 0;
        let m: number | null = it?.evaluator_marks === '' || it?.evaluator_marks == null ? null : Number(it.evaluator_marks);
        if (m != null) m = Math.max(0, Math.min(cap, Number.isFinite(m) ? m : 0));
        const fb = it?.evaluator_feedback != null ? String(it.evaluator_feedback) : null;
        await c.query(
          `UPDATE attempt_answer SET evaluator_marks = $2, evaluator_feedback = $3, awarded_marks = $2
             WHERE attempt_id = $1::bigint AND question_id = $4::bigint`,
          [attemptId, m, fb, qid]);
      }
    });

    const sums = await this.db.one<any>(
      `SELECT COALESCE(SUM(CASE WHEN is_correct IS NOT NULL AND evaluator_marks IS NULL THEN awarded_marks ELSE 0 END),0) AS auto,
              COALESCE(SUM(COALESCE(evaluator_marks,0)),0) AS manual
         FROM attempt_answer WHERE attempt_id = $1::bigint`, [attemptId]);
    const auto = Number(at.auto_score != null ? at.auto_score : sums?.auto ?? 0);
    const manual = Number(sums?.manual ?? 0);
    const total = Math.max(0, Math.round((auto + manual) * 100) / 100);
    const passed = computeIsPassed(total, Number(at.max_score), at.passing_marks != null ? Number(at.passing_marks) : null, at.passing_pct != null ? Number(at.passing_pct) : null);
    await this.db.query(
      `UPDATE assessment_attempt SET manual_score = $2, total_score = $3, is_passed = $4, status = 'evaluated',
          evaluated_by = $5, evaluated_at = now(), updated_at = now() WHERE id = $1::bigint`,
      [attemptId, manual, total, passed, me.id]);
    return { id: attemptId, status: 'evaluated', auto_score: auto, manual_score: manual, total_score: total, max_score: Number(at.max_score), is_passed: passed };
  }

  /* ---------------------------------------------------------------------- lists */

  async list(scope: ResolvedScope, f: { assessment_ids?: number[]; student_ids?: number[]; statuses?: string[]; branch_ids?: number[]; vertical_ids?: number[]; limit?: number } = {}) {
    const params: unknown[] = [];
    const where = [`at.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, ATTEMPT_SCOPE_COLS, params)];
    if (f.assessment_ids?.length) { params.push(f.assessment_ids); where.push(`at.assessment_id = ANY($${params.length}::bigint[])`); }
    if (f.student_ids?.length) { params.push(f.student_ids); where.push(`at.student_id = ANY($${params.length}::bigint[])`); }
    if (f.statuses?.length) { params.push(f.statuses); where.push(`at.status = ANY($${params.length}::varchar[])`); }
    if (f.branch_ids?.length) { params.push(f.branch_ids); where.push(`at.branch_id = ANY($${params.length}::bigint[])`); }
    if (f.vertical_ids?.length) { params.push(f.vertical_ids); where.push(`at.vertical_id = ANY($${params.length}::bigint[])`); }
    params.push(Math.min(Number(f.limit ?? 300), 1000));
    return this.db.query<any>(
      `SELECT at.id, at.assessment_id, at.student_id, at.attempt_no, at.status, at.started_at, at.submitted_at, at.due_at,
              at.auto_score, at.manual_score, at.total_score, at.max_score, at.is_passed, at.evaluated_at,
              a.title AS assessment_title, a.test_type, s.full_name AS student_name, s.student_no,
              b.name AS branch_name, v.name AS vertical_name, u.name AS evaluated_by_name,
              (SELECT count(*) FROM attempt_answer aa WHERE aa.attempt_id = at.id AND aa.evaluator_marks IS NULL
                 AND aa.q_type NOT IN ('mcq_single','mcq_multi','true_false','image_mcq','audio_mcq','video_mcq','match_following','fill_blank')) AS pending_subjective
         FROM assessment_attempt at
         JOIN assessment a ON a.id = at.assessment_id
         JOIN student s ON s.id = at.student_id
         LEFT JOIN branch b ON b.id = at.branch_id
         LEFT JOIN vertical v ON v.id = at.vertical_id
         LEFT JOIN "user" u ON u.id = at.evaluated_by
        WHERE ${where.join(' AND ')}
        ORDER BY at.submitted_at DESC NULLS LAST, at.started_at DESC
        LIMIT $${params.length}`, params);
  }
}
