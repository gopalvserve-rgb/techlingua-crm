import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';

/**
 * ASSESSMENT DASHBOARDS / REPORTS — Batch D.
 *
 * Scope-enforced aggregates that feed the Student / Faculty / Admin dashboards:
 *   · student(studentId)  — a student's attempts, scores, grades, certificates + a trend line.
 *   · faculty(me)         — pending evaluations, tests owned, average score, pass rate.
 *   · admin()             — org-wide KPIs, grade distribution, per-branch/vertical/course
 *                           breakdown, top/bottom performers, hardest questions.
 * Every query is filtered by the same ScopeResolver used by the lists, so a scoped user's numbers
 * can never include another branch's.
 */
const ATTEMPT_SCOPE_COLS: ScopeColumnMap = {
  owner: 'at.created_by', team: 'at.team_id', branch: 'at.branch_id', vertical: 'at.vertical_id', pipeline: 'at.pipeline_id',
};
const ASSESSMENT_SCOPE_COLS: ScopeColumnMap = {
  owner: 'a.created_by', team: 'a.team_id', branch: 'a.branch_id', vertical: 'a.vertical_id', pipeline: 'a.pipeline_id',
};
const STUDENT_SCOPE_COLS: ScopeColumnMap = { branch: 's.branch_id', vertical: 's.vertical_id', owner: 's.owner_id' };
const CERT_SCOPE_COLS: ScopeColumnMap = { branch: 'ct.branch_id', vertical: 'ct.vertical_id', owner: 'ct.issued_by' };

@Injectable()
export class AssessmentReportService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
  ) {}

  private pct(total: any, max: any): number | null {
    const t = total != null ? Number(total) : null; const m = Number(max) || 0;
    return t != null && m > 0 ? Math.round((t / m) * 10000) / 100 : null;
  }

  /* ------------------------------------------------------------------- STUDENT */
  async student(studentId: number, scope: ResolvedScope) {
    if (!studentId) throw new BadRequestException('Choose a student.');
    const sp: unknown[] = [studentId];
    const sw = this.resolver.buildScopeWhere(scope, STUDENT_SCOPE_COLS, sp);
    const s = await this.db.one<any>(
      `SELECT s.id, s.full_name, s.student_no, s.branch_id, s.vertical_id, b.name AS branch_name, v.name AS vertical_name
         FROM student s LEFT JOIN branch b ON b.id = s.branch_id LEFT JOIN vertical v ON v.id = s.vertical_id
        WHERE s.id = $1::bigint AND s.deleted_at IS NULL AND ${sw}`, sp);
    if (!s) throw new NotFoundException('Student not found (or outside your access)');

    const attempts = await this.db.query<any>(
      `SELECT at.id, at.assessment_id, at.attempt_no, at.status, at.total_score, at.max_score, at.percentage,
              at.grade_label, at.is_passed, at.submitted_at, at.evaluated_at, a.title AS assessment_title, a.test_type
         FROM assessment_attempt at JOIN assessment a ON a.id = at.assessment_id
        WHERE at.student_id = $1::bigint AND at.deleted_at IS NULL
        ORDER BY COALESCE(at.submitted_at, at.started_at) DESC`, [studentId]);
    const certs = await this.db.query<any>(
      `SELECT ct.id, ct.certificate_no, ct.title, ct.grade_label, ct.percentage, ct.issued_on, ct.status, ct.verify_code,
              a.title AS assessment_title
         FROM assessment_certificate ct LEFT JOIN assessment a ON a.id = ct.assessment_id
        WHERE ct.student_id = $1::bigint AND ct.deleted_at IS NULL
        ORDER BY ct.issued_on DESC, ct.id DESC`, [studentId]);

    const evaluated = attempts.filter((a) => a.status === 'evaluated' && a.percentage != null);
    const trend = evaluated
      .slice().sort((x, y) => new Date(x.evaluated_at || x.submitted_at).getTime() - new Date(y.evaluated_at || y.submitted_at).getTime())
      .map((a) => ({ label: a.assessment_title, at: a.evaluated_at || a.submitted_at, percentage: Number(a.percentage), grade: a.grade_label }));
    const avg = evaluated.length ? Math.round((evaluated.reduce((s0, a) => s0 + Number(a.percentage), 0) / evaluated.length) * 100) / 100 : null;
    const passed = evaluated.filter((a) => a.is_passed).length;

    return {
      student: { id: Number(s.id), full_name: s.full_name, student_no: s.student_no, branch_name: s.branch_name, vertical_name: s.vertical_name },
      kpis: {
        attempts: attempts.length, evaluated: evaluated.length,
        avg_pct: avg, passed, failed: evaluated.length - passed,
        pass_rate: evaluated.length ? Math.round((passed / evaluated.length) * 10000) / 100 : null,
        certificates: certs.filter((c) => c.status === 'issued').length,
        best_pct: evaluated.length ? Math.max(...evaluated.map((a) => Number(a.percentage))) : null,
      },
      trend,
      attempts: attempts.map((a) => ({ ...a, total_score: a.total_score != null ? Number(a.total_score) : null, max_score: Number(a.max_score), percentage: a.percentage != null ? Number(a.percentage) : null })),
      certificates: certs.map((c) => ({ ...c, percentage: c.percentage != null ? Number(c.percentage) : null })),
    };
  }

  /* ------------------------------------------------------------------- FACULTY */
  async faculty(me: { id: number }, scope: ResolvedScope) {
    const p: unknown[] = [];
    const atw = this.resolver.buildScopeWhere(scope, ATTEMPT_SCOPE_COLS, p);
    const pendingAttempts = await this.db.one<any>(
      `SELECT count(*) AS n FROM assessment_attempt at
        WHERE at.deleted_at IS NULL AND at.status = 'submitted' AND ${atw}`, p);
    const p2: unknown[] = [];
    const atw2 = this.resolver.buildScopeWhere(scope, ATTEMPT_SCOPE_COLS, p2);
    const evalAgg = await this.db.one<any>(
      `SELECT count(*) FILTER (WHERE status = 'evaluated') AS evaluated,
              count(*) AS attempts,
              count(*) FILTER (WHERE status = 'evaluated' AND is_passed) AS passed,
              round(avg(percentage) FILTER (WHERE status = 'evaluated'), 2) AS avg_pct
         FROM assessment_attempt at WHERE at.deleted_at IS NULL AND ${atw2}`, p2);
    const p3: unknown[] = [];
    const subw = this.resolver.buildScopeWhere(scope, { branch: 'sub.branch_id', vertical: 'sub.vertical_id', owner: 'sub.created_by' }, p3);
    const pendingSubs = await this.db.one<any>(
      `SELECT count(*) AS n FROM assignment_submission sub WHERE sub.deleted_at IS NULL AND sub.status = 'submitted' AND ${subw}`, p3);
    const p4: unknown[] = [];
    const aw = this.resolver.buildScopeWhere(scope, ASSESSMENT_SCOPE_COLS, p4);
    const tests = await this.db.one<any>(
      `SELECT count(*) AS total, count(*) FILTER (WHERE status = 'published') AS published,
              count(*) FILTER (WHERE status = 'draft') AS draft
         FROM assessment a WHERE a.deleted_at IS NULL AND ${aw}`, p4);
    const p5: unknown[] = [];
    const aw2 = this.resolver.buildScopeWhere(scope, ASSESSMENT_SCOPE_COLS, p5);
    const perTest = await this.db.query<any>(
      `SELECT a.id, a.title, a.test_type, a.status,
              count(at.id) FILTER (WHERE at.status IN ('evaluated','submitted','expired')) AS attempts,
              count(at.id) FILTER (WHERE at.status = 'evaluated' AND at.is_passed) AS passed,
              round(avg(at.percentage) FILTER (WHERE at.status = 'evaluated'), 2) AS avg_pct,
              count(at.id) FILTER (WHERE at.status = 'submitted') AS pending
         FROM assessment a LEFT JOIN assessment_attempt at ON at.assessment_id = a.id AND at.deleted_at IS NULL
        WHERE a.deleted_at IS NULL AND ${aw2}
        GROUP BY a.id, a.title, a.test_type, a.status
        ORDER BY pending DESC, attempts DESC LIMIT 50`, p5);

    return {
      kpis: {
        pending_evaluations: Number(pendingAttempts?.n ?? 0),
        pending_submissions: Number(pendingSubs?.n ?? 0),
        tests_total: Number(tests?.total ?? 0), tests_published: Number(tests?.published ?? 0), tests_draft: Number(tests?.draft ?? 0),
        attempts: Number(evalAgg?.attempts ?? 0), evaluated: Number(evalAgg?.evaluated ?? 0),
        pass_rate: Number(evalAgg?.evaluated ?? 0) ? Math.round((Number(evalAgg.passed) / Number(evalAgg.evaluated)) * 10000) / 100 : null,
        avg_pct: evalAgg?.avg_pct != null ? Number(evalAgg.avg_pct) : null,
      },
      tests: perTest.map((t) => ({
        id: Number(t.id), title: t.title, test_type: t.test_type, status: t.status,
        attempts: Number(t.attempts), passed: Number(t.passed), pending: Number(t.pending),
        avg_pct: t.avg_pct != null ? Number(t.avg_pct) : null,
        pass_rate: Number(t.attempts) ? Math.round((Number(t.passed) / Number(t.attempts)) * 10000) / 100 : null,
      })),
    };
  }

  /* --------------------------------------------------------------------- ADMIN */
  async admin(scope: ResolvedScope) {
    const p: unknown[] = [];
    const aw = this.resolver.buildScopeWhere(scope, ASSESSMENT_SCOPE_COLS, p);
    const assessCount = await this.db.one<any>(
      `SELECT count(*) AS total, count(*) FILTER (WHERE status='published') AS published,
              count(*) FILTER (WHERE status='closed') AS closed
         FROM assessment a WHERE a.deleted_at IS NULL AND ${aw}`, p);

    const p2: unknown[] = [];
    const atw = this.resolver.buildScopeWhere(scope, ATTEMPT_SCOPE_COLS, p2);
    const attAgg = await this.db.one<any>(
      `SELECT count(*) AS attempts, count(*) FILTER (WHERE status='evaluated') AS evaluated,
              count(*) FILTER (WHERE status='submitted') AS pending,
              count(*) FILTER (WHERE status='evaluated' AND is_passed) AS passed,
              round(avg(percentage) FILTER (WHERE status='evaluated'), 2) AS avg_pct
         FROM assessment_attempt at WHERE at.deleted_at IS NULL AND ${atw}`, p2);

    const p3: unknown[] = [];
    const atw3 = this.resolver.buildScopeWhere(scope, ATTEMPT_SCOPE_COLS, p3);
    const gradeDist = await this.db.query<any>(
      `SELECT COALESCE(grade_label,'—') AS grade, count(*) AS n
         FROM assessment_attempt at WHERE at.deleted_at IS NULL AND at.status='evaluated' AND ${atw3}
        GROUP BY grade_label ORDER BY min(percentage) DESC NULLS LAST`, p3);

    const p4: unknown[] = [];
    const atw4 = this.resolver.buildScopeWhere(scope, ATTEMPT_SCOPE_COLS, p4);
    const byBranch = await this.db.query<any>(
      `SELECT b.name AS label, count(*) AS attempts, count(*) FILTER (WHERE at.is_passed) AS passed, round(avg(at.percentage),2) AS avg_pct
         FROM assessment_attempt at LEFT JOIN branch b ON b.id = at.branch_id
        WHERE at.deleted_at IS NULL AND at.status='evaluated' AND ${atw4}
        GROUP BY b.name ORDER BY attempts DESC`, p4);
    const p5: unknown[] = [];
    const atw5 = this.resolver.buildScopeWhere(scope, ATTEMPT_SCOPE_COLS, p5);
    const byVertical = await this.db.query<any>(
      `SELECT v.name AS label, count(*) AS attempts, count(*) FILTER (WHERE at.is_passed) AS passed, round(avg(at.percentage),2) AS avg_pct
         FROM assessment_attempt at LEFT JOIN vertical v ON v.id = at.vertical_id
        WHERE at.deleted_at IS NULL AND at.status='evaluated' AND ${atw5}
        GROUP BY v.name ORDER BY attempts DESC`, p5);
    const p6: unknown[] = [];
    const atw6 = this.resolver.buildScopeWhere(scope, ATTEMPT_SCOPE_COLS, p6);
    const byCourse = await this.db.query<any>(
      `SELECT c.name AS label, count(*) AS attempts, count(*) FILTER (WHERE at.is_passed) AS passed, round(avg(at.percentage),2) AS avg_pct
         FROM assessment_attempt at JOIN assessment a ON a.id = at.assessment_id LEFT JOIN m_course c ON c.id = a.course_id
        WHERE at.deleted_at IS NULL AND at.status='evaluated' AND ${atw6}
        GROUP BY c.name ORDER BY attempts DESC`, p6);

    const p7: unknown[] = [];
    const atw7 = this.resolver.buildScopeWhere(scope, ATTEMPT_SCOPE_COLS, p7);
    const top = await this.db.query<any>(
      `SELECT s.full_name AS student_name, s.student_no, a.title AS assessment_title, at.percentage, at.grade_label
         FROM assessment_attempt at JOIN student s ON s.id = at.student_id JOIN assessment a ON a.id = at.assessment_id
        WHERE at.deleted_at IS NULL AND at.status='evaluated' AND at.percentage IS NOT NULL AND ${atw7}
        ORDER BY at.percentage DESC LIMIT 5`, p7);
    const p8: unknown[] = [];
    const atw8 = this.resolver.buildScopeWhere(scope, ATTEMPT_SCOPE_COLS, p8);
    const bottom = await this.db.query<any>(
      `SELECT s.full_name AS student_name, s.student_no, a.title AS assessment_title, at.percentage, at.grade_label
         FROM assessment_attempt at JOIN student s ON s.id = at.student_id JOIN assessment a ON a.id = at.assessment_id
        WHERE at.deleted_at IS NULL AND at.status='evaluated' AND at.percentage IS NOT NULL AND ${atw8}
        ORDER BY at.percentage ASC LIMIT 5`, p8);

    // hardest questions — lowest objective accuracy, scope via the attempt
    const p9: unknown[] = [];
    const atw9 = this.resolver.buildScopeWhere(scope, ATTEMPT_SCOPE_COLS, p9);
    const hardest = await this.db.query<any>(
      `SELECT q.id, LEFT(q.body, 90) AS body, q.q_type, q.difficulty,
              count(*) AS answered, count(*) FILTER (WHERE aa.is_correct) AS correct,
              round(100.0 * count(*) FILTER (WHERE aa.is_correct) / NULLIF(count(*),0), 2) AS accuracy_pct
         FROM attempt_answer aa
         JOIN assessment_attempt at ON at.id = aa.attempt_id
         JOIN question q ON q.id = aa.question_id
        WHERE at.deleted_at IS NULL AND at.status IN ('evaluated','submitted','expired') AND aa.is_correct IS NOT NULL AND ${atw9}
        GROUP BY q.id, q.body, q.q_type, q.difficulty
       HAVING count(*) >= 1
        ORDER BY accuracy_pct ASC, answered DESC LIMIT 10`, p9);

    const pc: unknown[] = [];
    const cw = this.resolver.buildScopeWhere(scope, CERT_SCOPE_COLS, pc);
    const certAgg = await this.db.one<any>(
      `SELECT count(*) FILTER (WHERE status='issued') AS issued, count(*) FILTER (WHERE status='revoked') AS revoked
         FROM assessment_certificate ct WHERE ct.deleted_at IS NULL AND ${cw}`, pc);

    const evaluated = Number(attAgg?.evaluated ?? 0);
    const passed = Number(attAgg?.passed ?? 0);
    const shape = (rows: any[]) => rows.map((r) => ({
      label: r.label ?? '—', attempts: Number(r.attempts), passed: Number(r.passed),
      avg_pct: r.avg_pct != null ? Number(r.avg_pct) : null,
      pass_rate: Number(r.attempts) ? Math.round((Number(r.passed) / Number(r.attempts)) * 10000) / 100 : null,
    }));
    return {
      kpis: {
        assessments: Number(assessCount?.total ?? 0), published: Number(assessCount?.published ?? 0), closed: Number(assessCount?.closed ?? 0),
        attempts: Number(attAgg?.attempts ?? 0), evaluated, pending: Number(attAgg?.pending ?? 0),
        passed, failed: evaluated - passed,
        pass_rate: evaluated ? Math.round((passed / evaluated) * 10000) / 100 : null,
        avg_pct: attAgg?.avg_pct != null ? Number(attAgg.avg_pct) : null,
        certificates_issued: Number(certAgg?.issued ?? 0), certificates_revoked: Number(certAgg?.revoked ?? 0),
      },
      grade_distribution: gradeDist.map((g) => ({ grade: g.grade, n: Number(g.n) })),
      by_branch: shape(byBranch), by_vertical: shape(byVertical), by_course: shape(byCourse),
      top_performers: top.map((t) => ({ ...t, percentage: Number(t.percentage) })),
      bottom_performers: bottom.map((t) => ({ ...t, percentage: Number(t.percentage) })),
      hardest_questions: hardest.map((h) => ({ id: Number(h.id), body: h.body, q_type: h.q_type, difficulty: h.difficulty, answered: Number(h.answered), correct: Number(h.correct), accuracy_pct: h.accuracy_pct != null ? Number(h.accuracy_pct) : 0 })),
    };
  }
}
