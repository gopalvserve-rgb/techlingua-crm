import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { StorageService } from '../storage/storage.service';
import { AssessmentTemplateService, TEST_TYPES, SHOW_RESULT_MODES } from './assessment-template.service';
import { ContentApprovalWorkflowService } from '../governance/content-approval.service';

/**
 * ASSESSMENT (TEST / EXAM) — Assessment Batch B.
 *
 * A reusable test definition assembled from the Batch A question bank. Questions are either
 * HAND-PICKED (assessment_question links) or POOLED from a category via a section
 * (assessment_section.pool_from_category_id + pool_pick_count), or both. total_marks is
 * DERIVED server-side from the linked questions + pooled sections (overridable). Publish/close
 * transitions are validated. The assemble() seam returns the resolved student-facing question
 * set WITHOUT correct answers — Batch C's attempt flow consumes it. Scope-enforced through the
 * central ScopeResolver, exactly like the question bank / invoices / students.
 */
export const ASSESSMENT_SCOPE_COLS: ScopeColumnMap = {
  owner: 'a.created_by', team: 'a.team_id', branch: 'a.branch_id',
  vertical: 'a.vertical_id', pipeline: 'a.pipeline_id',
};

/** Objective (auto-scorable) types — options are shown; answers stripped for students. */
const OBJECTIVE_TYPES = new Set<string>(['mcq_single', 'mcq_multi', 'true_false', 'image_mcq', 'audio_mcq', 'video_mcq', 'match_following']);

interface NormSection { title: string; description: string | null; ordering: number; pool_from_category_id: number | null; pool_pick_count: number | null }
interface NormLink { question_id: number; marks_override: number | null; negative_override: number | null; ordering: number }

@Injectable()
export class AssessmentService {
  private readonly log = new Logger('Assessment');

  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly storage: StorageService,
    private readonly templates: AssessmentTemplateService,
    private readonly workflow: ContentApprovalWorkflowService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  /* ---------------------------------------------------------------- normalise */

  private normalise(dto: any) {
    const title = String(dto?.title ?? '').trim();
    if (!title) throw new BadRequestException('A test title is required.');
    const test_type = String(dto?.test_type ?? 'practice').trim();
    if (!TEST_TYPES.includes(test_type as any)) throw new BadRequestException(`Unknown test type "${test_type}".`);
    const show_result_mode = String(dto?.show_result_mode ?? 'instant').trim();
    if (!SHOW_RESULT_MODES.includes(show_result_mode as any)) throw new BadRequestException('Unknown show-result mode.');
    const num = (v: any, d: number) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
    const nullNum = (v: any) => (v === '' || v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
    const nullDate = (v: any) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
    const pct = nullNum(dto?.passing_pct);
    const start_at = nullDate(dto?.start_at);
    const end_at = nullDate(dto?.end_at);
    if (start_at && end_at && new Date(end_at).getTime() < new Date(start_at).getTime()) {
      throw new BadRequestException('The availability window ends before it starts.');
    }
    const qts = dto?.questions_to_show === '' || dto?.questions_to_show == null ? null : Math.max(1, Math.trunc(Number(dto.questions_to_show)));
    return {
      title: title.slice(0, 200),
      description: dto?.description ? String(dto.description) : null,
      test_type,
      course_id: dto?.course_id ? Number(dto.course_id) : null,
      batch_id: dto?.batch_id ? Number(dto.batch_id) : null,
      branch_id: dto?.branch_id ? Number(dto.branch_id) : null,
      vertical_id: dto?.vertical_id ? Number(dto.vertical_id) : null,
      language: dto?.language ? String(dto.language).trim().slice(0, 40) : null,
      duration_min: Math.max(0, Math.trunc(num(dto?.duration_min, 30))),
      passing_marks: pct != null ? null : (nullNum(dto?.passing_marks)),
      passing_pct: pct != null ? Math.min(100, Math.max(0, pct)) : null,
      negative_marking: !!dto?.negative_marking,
      default_negative: num(dto?.default_negative, 0),
      randomize_questions: !!dto?.randomize_questions,
      randomize_options: !!dto?.randomize_options,
      shuffle_per_attempt: !!dto?.shuffle_per_attempt,
      questions_to_show: qts,
      max_attempts: Math.max(1, Math.trunc(num(dto?.max_attempts, 1))),
      start_at, end_at,
      instructions: dto?.instructions ? String(dto.instructions) : null,
      show_result_mode,
      total_marks_manual: !!dto?.total_marks_manual,
      total_marks_override: nullNum(dto?.total_marks),
      template_id: dto?.template_id ? Number(dto.template_id) : null,
    };
  }

  private normSections(raw: unknown): NormSection[] {
    const list = Array.isArray(raw) ? raw : [];
    return list.map((s: any, i: number) => {
      const pick = s?.pool_pick_count === '' || s?.pool_pick_count == null ? null : Math.max(1, Math.trunc(Number(s.pool_pick_count)));
      const cat = s?.pool_from_category_id ? Number(s.pool_from_category_id) : null;
      return {
        title: String(s?.title ?? 'Section').trim().slice(0, 160) || 'Section',
        description: s?.description ? String(s.description) : null,
        ordering: Number.isInteger(Number(s?.ordering)) ? Number(s.ordering) : i + 1,
        pool_from_category_id: cat,
        pool_pick_count: cat ? pick : null,
      };
    });
  }

  private normLinks(raw: unknown): NormLink[] {
    const list = Array.isArray(raw) ? raw : [];
    const seen = new Set<number>();
    const out: NormLink[] = [];
    list.forEach((l: any, i: number) => {
      const qid = Number(l?.question_id ?? l?.id);
      if (!Number.isInteger(qid) || qid <= 0 || seen.has(qid)) return;
      seen.add(qid);
      const mo = l?.marks_override === '' || l?.marks_override == null ? null : Number(l.marks_override);
      const no = l?.negative_override === '' || l?.negative_override == null ? null : Number(l.negative_override);
      out.push({
        question_id: qid,
        marks_override: mo != null && Number.isFinite(mo) && mo >= 0 ? mo : null,
        negative_override: no != null && Number.isFinite(no) && no >= 0 ? no : null,
        ordering: Number.isInteger(Number(l?.ordering)) ? Number(l.ordering) : i + 1,
      });
    });
    return out;
  }

  /* -------------------------------------------------------------------- reads */

  async list(scope: ResolvedScope, f: {
    test_types?: string[]; statuses?: string[]; languages?: string[];
    course_ids?: number[]; batch_ids?: number[]; branch_ids?: number[]; vertical_ids?: number[];
    q?: string; limit?: number;
  } = {}) {
    const params: unknown[] = [];
    const where = [`a.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, ASSESSMENT_SCOPE_COLS, params)];
    if (f.test_types?.length) { params.push(f.test_types); where.push(`a.test_type = ANY($${params.length}::varchar[])`); }
    if (f.statuses?.length) { params.push(f.statuses); where.push(`a.status = ANY($${params.length}::varchar[])`); }
    if (f.languages?.length) { params.push(f.languages); where.push(`a.language = ANY($${params.length}::varchar[])`); }
    if (f.course_ids?.length) { params.push(f.course_ids); where.push(`a.course_id = ANY($${params.length}::bigint[])`); }
    if (f.batch_ids?.length) { params.push(f.batch_ids); where.push(`a.batch_id = ANY($${params.length}::bigint[])`); }
    if (f.branch_ids?.length) { params.push(f.branch_ids); where.push(`a.branch_id = ANY($${params.length}::bigint[])`); }
    if (f.vertical_ids?.length) { params.push(f.vertical_ids); where.push(`a.vertical_id = ANY($${params.length}::bigint[])`); }
    if (f.q) { params.push(`%${f.q}%`); where.push(`(a.title ILIKE $${params.length} OR a.description ILIKE $${params.length})`); }
    params.push(Math.min(Number(f.limit ?? 300), 1000));
    return this.db.query<any>(
      `SELECT a.id, a.title, a.test_type, a.status, a.language, a.duration_min, a.total_marks, a.passing_marks, a.passing_pct,
              a.max_attempts, a.negative_marking, a.randomize_questions, a.questions_to_show,
              a.submitted_at, a.reviewed_at, a.review_remarks,
              a.start_at, a.end_at, a.course_id, a.batch_id, a.branch_id, a.vertical_id, a.created_at,
              c.name AS course_name, bt.name AS batch_name, b.name AS branch_name, v.name AS vertical_name,
              tm.name AS template_name, u.name AS created_by_name,
              (SELECT count(*) FROM assessment_question aq WHERE aq.assessment_id = a.id AND aq.question_id IS NOT NULL) AS question_count,
              (SELECT count(*) FROM assessment_section s WHERE s.assessment_id = a.id) AS section_count
         FROM assessment a
         LEFT JOIN m_course c ON c.id = a.course_id
         LEFT JOIN batch bt ON bt.id = a.batch_id
         LEFT JOIN branch b ON b.id = a.branch_id
         LEFT JOIN vertical v ON v.id = a.vertical_id
         LEFT JOIN assessment_template tm ON tm.id = a.template_id
         LEFT JOIN "user" u ON u.id = a.created_by
        WHERE ${where.join(' AND ')}
        ORDER BY a.created_at DESC
        LIMIT $${params.length}`, params);
  }

  async summary(scope: ResolvedScope) {
    const params: unknown[] = [];
    const w = this.resolver.buildScopeWhere(scope, ASSESSMENT_SCOPE_COLS, params);
    const r = await this.db.one<any>(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE a.status = 'draft') AS draft,
              count(*) FILTER (WHERE a.status = 'published') AS published,
              count(*) FILTER (WHERE a.status = 'closed') AS closed
         FROM assessment a WHERE a.deleted_at IS NULL AND ${w}`, params);
    const num = (v: unknown) => Number(v ?? 0);
    return { total: num(r?.total), draft: num(r?.draft), published: num(r?.published), closed: num(r?.closed) };
  }

  private async getRow(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, ASSESSMENT_SCOPE_COLS, params);
    const a = await this.db.one<any>(
      `SELECT a.*, c.name AS course_name, bt.name AS batch_name, b.name AS branch_name, v.name AS vertical_name,
              tm.name AS template_name
         FROM assessment a
         LEFT JOIN m_course c ON c.id = a.course_id
         LEFT JOIN batch bt ON bt.id = a.batch_id
         LEFT JOIN branch b ON b.id = a.branch_id
         LEFT JOIN vertical v ON v.id = a.vertical_id
         LEFT JOIN assessment_template tm ON tm.id = a.template_id
        WHERE a.id = $1::bigint AND a.deleted_at IS NULL AND ${w}`, params);
    if (!a) throw new NotFoundException('Test not found (or outside your access)');
    return a;
  }

  /** Full test: settings + sections + linked questions (with the correct-answer flags, for the builder). */
  async get(id: number, scope: ResolvedScope) {
    const a = await this.getRow(id, scope);
    const sections = await this.db.query<any>(
      `SELECT s.id, s.title, s.description, s.ordering, s.pool_from_category_id, s.pool_pick_count,
              qc.name AS pool_category_name,
              (SELECT count(*) FROM question q WHERE q.category_id = s.pool_from_category_id AND q.deleted_at IS NULL AND q.active) AS pool_available
         FROM assessment_section s
         LEFT JOIN question_category qc ON qc.id = s.pool_from_category_id
        WHERE s.assessment_id = $1::bigint ORDER BY s.ordering, s.id`, [id]);
    const questions = await this.db.query<any>(
      `SELECT aq.id AS link_id, aq.question_id, aq.section_id, aq.marks_override, aq.negative_override, aq.ordering,
              q.body, q.q_type, q.difficulty, q.marks, q.negative_marks, q.language, q.category_id,
              qc.name AS category_name
         FROM assessment_question aq
         JOIN question q ON q.id = aq.question_id
         LEFT JOIN question_category qc ON qc.id = q.category_id
        WHERE aq.assessment_id = $1::bigint AND aq.question_id IS NOT NULL AND q.deleted_at IS NULL
        ORDER BY aq.ordering, aq.id`, [id]);
    const computed = await this.computeTotal(id);
    return { ...a, sections, questions, computed_total: computed };
  }

  /* ------------------------------------------------------------------- writes */

  async create(dto: any, me: { id: number }, _scope: ResolvedScope) {
    const org = await this.orgId();
    const n = this.normalise(dto);
    const sections = this.normSections(dto?.sections);
    const links = this.normLinks(dto?.questions ?? dto?.links);
    const id = await this.db.tx(async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO assessment (org_id, branch_id, vertical_id, title, description, test_type, course_id, batch_id, language,
            duration_min, passing_marks, passing_pct, negative_marking, default_negative, randomize_questions, randomize_options,
            shuffle_per_attempt, questions_to_show, max_attempts, start_at, end_at, instructions, show_result_mode,
            total_marks_manual, template_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) RETURNING id`,
        [org, n.branch_id, n.vertical_id, n.title, n.description, n.test_type, n.course_id, n.batch_id, n.language,
          n.duration_min, n.passing_marks, n.passing_pct, n.negative_marking, n.default_negative, n.randomize_questions,
          n.randomize_options, n.shuffle_per_attempt, n.questions_to_show, n.max_attempts, n.start_at, n.end_at,
          n.instructions, n.show_result_mode, n.total_marks_manual, n.template_id, me.id]);
      const aid = Number(r.rows[0].id);
      await this.replaceSections(c, aid, sections, links);
      return aid;
    });
    if (n.total_marks_manual && n.total_marks_override != null) {
      await this.db.query(`UPDATE assessment SET total_marks = $2 WHERE id = $1::bigint`, [id, n.total_marks_override]);
    } else {
      await this.computeTotal(id, undefined, true);
    }
    return { id };
  }

  async update(id: number, dto: any, _me: { id: number }, scope: ResolvedScope) {
    const existing = await this.getRow(id, scope);
    if (existing.status === 'closed') throw new BadRequestException('A closed test cannot be edited. Re-open is not supported.');
    const n = this.normalise(dto);
    const sections = this.normSections(dto?.sections);
    const links = this.normLinks(dto?.questions ?? dto?.links);
    await this.db.tx(async (c) => {
      await c.query(
        `UPDATE assessment SET branch_id=$2, vertical_id=$3, title=$4, description=$5, test_type=$6, course_id=$7, batch_id=$8,
            language=$9, duration_min=$10, passing_marks=$11, passing_pct=$12, negative_marking=$13, default_negative=$14,
            randomize_questions=$15, randomize_options=$16, shuffle_per_attempt=$17, questions_to_show=$18, max_attempts=$19,
            start_at=$20, end_at=$21, instructions=$22, show_result_mode=$23, total_marks_manual=$24, template_id=$25, updated_at=now()
          WHERE id=$1::bigint`,
        [id, n.branch_id, n.vertical_id, n.title, n.description, n.test_type, n.course_id, n.batch_id, n.language,
          n.duration_min, n.passing_marks, n.passing_pct, n.negative_marking, n.default_negative, n.randomize_questions,
          n.randomize_options, n.shuffle_per_attempt, n.questions_to_show, n.max_attempts, n.start_at, n.end_at,
          n.instructions, n.show_result_mode, n.total_marks_manual, n.template_id]);
      await this.replaceSections(c, id, sections, links);
    });
    if (n.total_marks_manual && n.total_marks_override != null) {
      await this.db.query(`UPDATE assessment SET total_marks = $2 WHERE id = $1::bigint`, [id, n.total_marks_override]);
    } else {
      await this.computeTotal(id, undefined, true);
    }
    return { id, ok: true };
  }

  /** Replace sections + hand-picked links wholesale (the builder sends the complete set). */
  private async replaceSections(c: PoolClient, aid: number, sections: NormSection[], links: NormLink[]) {
    await c.query(`DELETE FROM assessment_question WHERE assessment_id = $1::bigint`, [aid]);
    await c.query(`DELETE FROM assessment_section WHERE assessment_id = $1::bigint`, [aid]);
    let sOrd = 0;
    for (const s of sections) {
      sOrd += 1;
      await c.query(
        `INSERT INTO assessment_section (assessment_id, title, description, ordering, pool_from_category_id, pool_pick_count)
         VALUES ($1::bigint,$2,$3,$4::int,$5,$6)`,
        [aid, s.title, s.description, s.ordering || sOrd, s.pool_from_category_id, s.pool_pick_count]);
    }
    let qOrd = 0;
    for (const l of links) {
      qOrd += 1;
      await c.query(
        `INSERT INTO assessment_question (assessment_id, question_id, marks_override, negative_override, ordering)
         VALUES ($1::bigint,$2::bigint,$3,$4,$5::int)`,
        [aid, l.question_id, l.marks_override, l.negative_override, l.ordering || qOrd]);
    }
  }

  async remove(id: number, me: { id: number }, scope: ResolvedScope) {
    await this.getRow(id, scope);
    await this.db.query(`UPDATE assessment SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint`, [id, me.id]);
    return { id, ok: true };
  }

  async bulkDeleteImpact(ids: number[], scope: ResolvedScope) {
    const clean = [...new Set((ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!clean.length) return { entity: 'assessment', label: 'Test', requested: 0, in_scope: 0, out_of_scope: 0, total_associations: 0, impact: [] };
    const params: unknown[] = [clean];
    const w = this.resolver.buildScopeWhere(scope, ASSESSMENT_SCOPE_COLS, params);
    const inScope = await this.db.query<{ id: string }>(
      `SELECT a.id FROM assessment a WHERE a.id = ANY($1::bigint[]) AND a.deleted_at IS NULL AND ${w}`, params);
    const inIds = inScope.map((r) => Number(r.id));
    const qc = inIds.length
      ? await this.db.one<{ n: string }>(`SELECT count(*) AS n FROM assessment_question WHERE assessment_id = ANY($1::bigint[])`, [inIds])
      : { n: '0' };
    const links = Number(qc?.n ?? 0);
    return {
      entity: 'assessment', label: 'Test', requested: clean.length,
      in_scope: inIds.length, out_of_scope: clean.length - inIds.length,
      total_associations: links,
      impact: links ? [{ key: 'questions', label: 'Question links (removed with the test)', count: links }] : [],
    };
  }

  async bulkDelete(ids: number[], me: { id: number }, scope: ResolvedScope) {
    const clean = [...new Set((ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!clean.length) return { deleted: 0, skipped: 0 };
    const params: unknown[] = [clean, me.id];
    const w = this.resolver.buildScopeWhere(scope, ASSESSMENT_SCOPE_COLS, params);
    const rows = await this.db.query<{ id: string }>(
      `UPDATE assessment a SET deleted_at = now(), deleted_by = $2::bigint
        WHERE a.id = ANY($1::bigint[]) AND a.deleted_at IS NULL AND ${w} RETURNING a.id`, params);
    return { deleted: rows.length, skipped: clean.length - rows.length };
  }

  /* ----------------------------------------------------- questions / sections */

  /** Add / remove / reorder the hand-picked questions on a test (replaces the set). */
  async setQuestions(id: number, links: any[], _me: { id: number }, scope: ResolvedScope) {
    const a = await this.getRow(id, scope);
    if (a.status === 'closed') throw new BadRequestException('A closed test cannot be edited.');
    const norm = this.normLinks(links);
    await this.db.tx(async (c) => {
      await c.query(`DELETE FROM assessment_question WHERE assessment_id = $1::bigint AND question_id IS NOT NULL`, [id]);
      let qOrd = 0;
      for (const l of norm) {
        qOrd += 1;
        await c.query(
          `INSERT INTO assessment_question (assessment_id, question_id, marks_override, negative_override, ordering)
           VALUES ($1::bigint,$2::bigint,$3,$4,$5::int)`,
          [id, l.question_id, l.marks_override, l.negative_override, l.ordering || qOrd]);
      }
    });
    const total = await this.computeTotal(id, undefined, true);
    return { id, count: norm.length, total_marks: total };
  }

  /** Set a section's pool (category + pick count). Creates or updates the section. */
  async setSectionPool(id: number, dto: any, _me: { id: number }, scope: ResolvedScope) {
    const a = await this.getRow(id, scope);
    if (a.status === 'closed') throw new BadRequestException('A closed test cannot be edited.');
    const cat = dto?.pool_from_category_id ? Number(dto.pool_from_category_id) : null;
    if (!cat) throw new BadRequestException('Choose a category to pool from.');
    const pick = Math.max(1, Math.trunc(Number(dto?.pool_pick_count ?? 1)));
    const title = String(dto?.title ?? 'Pooled section').trim().slice(0, 160) || 'Pooled section';
    const sectionId = dto?.section_id ? Number(dto.section_id) : null;
    let sid: number;
    if (sectionId) {
      await this.db.query(
        `UPDATE assessment_section SET title=$3, pool_from_category_id=$4, pool_pick_count=$5
          WHERE id=$1::bigint AND assessment_id=$2::bigint`, [sectionId, id, title, cat, pick]);
      sid = sectionId;
    } else {
      const r = await this.db.one<{ id: string; n: string }>(
        `INSERT INTO assessment_section (assessment_id, title, ordering, pool_from_category_id, pool_pick_count)
         VALUES ($1::bigint, $2, (SELECT COALESCE(max(ordering),0)+1 FROM assessment_section WHERE assessment_id=$1::bigint), $3, $4)
         RETURNING id, '0' AS n`, [id, title, cat, pick]);
      sid = Number(r!.id);
    }
    const total = await this.computeTotal(id, undefined, true);
    return { id, section_id: sid, total_marks: total };
  }

  /* --------------------------------------------------------- compute total */

  /**
   * Derive total_marks from the hand-picked questions (+ pooled sections) server-side.
   * A pooled section contributes pick_count * (average marks in its category). If
   * questions_to_show trims the hand-picked pool, the total reflects the expected N.
   * When persist=true and the test is not on a manual override, the row is updated.
   */
  async computeTotal(id: number, scope?: ResolvedScope, persist = false): Promise<number> {
    if (scope) await this.getRow(id, scope);
    const a = await this.db.one<any>(
      `SELECT questions_to_show, total_marks_manual, total_marks FROM assessment WHERE id = $1::bigint`, [id]);
    if (!a) throw new NotFoundException('Test not found');
    const picked = await this.db.query<any>(
      `SELECT COALESCE(aq.marks_override, q.marks) AS marks
         FROM assessment_question aq JOIN question q ON q.id = aq.question_id
        WHERE aq.assessment_id = $1::bigint AND aq.question_id IS NOT NULL AND q.deleted_at IS NULL
        ORDER BY aq.ordering, aq.id`, [id]);
    const marks = picked.map((r) => Number(r.marks) || 0);
    const handCount = marks.length;
    const handSum = marks.reduce((s, m) => s + m, 0);
    const sections = await this.db.query<any>(
      `SELECT s.pool_pick_count,
              (SELECT COALESCE(AVG(q.marks),0) FROM question q WHERE q.category_id = s.pool_from_category_id AND q.deleted_at IS NULL AND q.active) AS avg_marks
         FROM assessment_section s
        WHERE s.assessment_id = $1::bigint AND s.pool_from_category_id IS NOT NULL AND s.pool_pick_count IS NOT NULL`, [id]);
    let pooled = 0;
    for (const s of sections) pooled += Number(s.pool_pick_count || 0) * Number(s.avg_marks || 0);
    let hand = handSum;
    const qts = a.questions_to_show == null ? null : Number(a.questions_to_show);
    if (qts != null && handCount > 0 && qts < handCount && sections.length === 0) {
      hand = qts * (handSum / handCount);
    }
    const total = Math.round((hand + pooled) * 100) / 100;
    if (persist && !a.total_marks_manual) {
      await this.db.query(`UPDATE assessment SET total_marks = $2, updated_at = now() WHERE id = $1::bigint`, [id, total]);
    }
    return persist && a.total_marks_manual ? Number(a.total_marks) : total;
  }

  /* ---------------------------------- governance: submit / approve(publish) / reject / close */

  /**
   * TRAINER submits a draft test for approval (assessment.submit). draft -> pending_approval.
   * The trainer CANNOT publish; only an approver (assessment.publish — Academic Admin / Super
   * Admin) can move it forward. Mirrors the reusable content-approval workflow into the shared
   * ledger + audit_log so Batch-2 content shares the same code path.
   */
  async submit(id: number, me: { id: number }, scope: ResolvedScope) {
    const a = await this.getRow(id, scope);
    if (a.status === 'pending_approval') return { id, status: 'pending_approval' };
    if (a.status === 'published') throw new BadRequestException('This test is already published.');
    if (a.status === 'closed') throw new BadRequestException('A closed test cannot be submitted.');
    await this.db.query(
      `UPDATE assessment SET status='pending_approval', submitted_by=$2, submitted_at=now(), review_remarks=NULL, updated_at=now() WHERE id=$1::bigint`,
      [id, me?.id ?? null]);
    await this.workflow.record('assessment', id, 'pending_approval', { me });
    return { id, status: 'pending_approval' };
  }

  /**
   * APPROVER sends a pending test back to the trainer with remarks (assessment.publish).
   * pending_approval -> draft (ledger: changes_requested; remarks preserved on the row).
   */
  async reject(id: number, remarks: string, me: { id: number }, scope: ResolvedScope) {
    if (!remarks || !String(remarks).trim()) throw new BadRequestException('Remarks are required when sending a test back.');
    const a = await this.getRow(id, scope);
    if (a.status !== 'pending_approval') throw new BadRequestException('Only a test pending approval can be sent back.');
    await this.db.query(
      `UPDATE assessment SET status='draft', reviewed_by=$2, reviewed_at=now(), review_remarks=$3, updated_at=now() WHERE id=$1::bigint`,
      [id, me?.id ?? null, String(remarks)]);
    await this.workflow.record('assessment', id, 'changes_requested', { me, remarks });
    return { id, status: 'draft', workflow_status: 'changes_requested', review_remarks: String(remarks) };
  }

  /** APPROVER pulls a published test back to draft (assessment.publish). published -> draft. */
  async unpublish(id: number, me: { id: number }, scope: ResolvedScope) {
    const a = await this.getRow(id, scope);
    if (a.status !== 'published') throw new BadRequestException('Only a published test can be unpublished.');
    await this.db.query(`UPDATE assessment SET status='draft', updated_at=now() WHERE id=$1::bigint`, [id]);
    await this.workflow.record('assessment', id, 'unpublished', { me });
    return { id, status: 'draft', workflow_status: 'unpublished' };
  }

  /**
   * APPROVE & PUBLISH (assessment.publish — Academic Admin / Super Admin). A trainer never
   * holds this permission, so a trainer POST /publish is 403'd by the guard before here.
   * Accepts a draft (admin shortcut) or a pending_approval test; runs the publish validation.
   */
  async publish(id: number, me: { id: number }, scope: ResolvedScope) {
    const a = await this.getRow(id, scope);
    if (a.status === 'published') return { id, status: 'published' };
    if (a.status === 'closed') throw new BadRequestException('A closed test cannot be re-published.');
    // Validation: >=1 hand-picked question OR a valid pool; positive duration (timed types); passing <= total.
    const cnt = await this.db.one<{ n: string }>(
      `SELECT count(*) AS n FROM assessment_question WHERE assessment_id = $1::bigint AND question_id IS NOT NULL`, [id]);
    const handpicked = Number(cnt?.n ?? 0);
    const pools = await this.db.query<any>(
      `SELECT s.title, s.pool_pick_count,
              (SELECT count(*) FROM question q WHERE q.category_id = s.pool_from_category_id AND q.deleted_at IS NULL AND q.active) AS available
         FROM assessment_section s
        WHERE s.assessment_id = $1::bigint AND s.pool_from_category_id IS NOT NULL AND s.pool_pick_count IS NOT NULL`, [id]);
    const validPools = pools.filter((p) => Number(p.available) >= Number(p.pool_pick_count));
    if (handpicked === 0 && validPools.length === 0) {
      const shortPool = pools.find((p) => Number(p.available) < Number(p.pool_pick_count));
      if (shortPool) throw new BadRequestException(`Section "${shortPool.title}" needs ${shortPool.pool_pick_count} questions but its category has only ${shortPool.available}.`);
      throw new BadRequestException('Add at least one question, or configure a section pool, before publishing.');
    }
    const timed = a.test_type !== 'assignment' && a.test_type !== 'practical';
    if (timed && Number(a.duration_min) <= 0) throw new BadRequestException('Set a positive duration before publishing a timed test.');
    const total = await this.computeTotal(id, undefined, true);
    if (a.passing_marks != null && Number(a.passing_marks) > total) {
      throw new BadRequestException(`Passing marks (${a.passing_marks}) cannot exceed the total (${total}).`);
    }
    await this.db.query(
      `UPDATE assessment SET status='published', published_at=now(), published_by=$2, reviewed_by=$2, reviewed_at=now(), review_remarks=NULL, updated_at=now() WHERE id=$1::bigint`,
      [id, me?.id ?? null]);
    await this.workflow.record('assessment', id, 'published', { me });
    return { id, status: 'published', total_marks: total };
  }

  async close(id: number, _me: { id: number }, scope: ResolvedScope) {
    const a = await this.getRow(id, scope);
    if (a.status === 'closed') return { id, status: 'closed' };
    if (a.status !== 'published') throw new BadRequestException('Only a published test can be closed.');
    await this.db.query(`UPDATE assessment SET status='closed', closed_at=now(), updated_at=now() WHERE id=$1::bigint`, [id]);
    return { id, status: 'closed' };
  }

  /* ----------------------------------------------------- create from template */

  async createFromTemplate(dto: any, me: { id: number }, scope: ResolvedScope) {
    const templateId = Number(dto?.template_id);
    if (!Number.isInteger(templateId) || templateId <= 0) throw new BadRequestException('Choose a template.');
    const t = await this.templates.getScoped(templateId, scope);
    const merged = {
      title: dto?.title || `${t.name} — new test`,
      description: dto?.description ?? null,
      test_type: t.test_type,
      branch_id: dto?.branch_id ?? t.branch_id, vertical_id: dto?.vertical_id ?? t.vertical_id,
      course_id: dto?.course_id ?? null, batch_id: dto?.batch_id ?? null, language: dto?.language ?? null,
      duration_min: t.duration_min,
      negative_marking: t.negative_marking, default_negative: t.default_negative,
      randomize_questions: t.randomize_questions, randomize_options: t.randomize_options,
      shuffle_per_attempt: t.shuffle_per_attempt, questions_to_show: t.questions_to_show,
      max_attempts: t.max_attempts, passing_pct: t.passing_pct,
      show_result_mode: t.show_result_mode, instructions: t.instructions,
      template_id: templateId,
    };
    return this.create(merged, me, scope);
  }

  /* ----------------------------------------------------- assemble / preview */

  /** Strip a question down to what a student may see — NO correct-answer flags, NO explanation. */
  private async stripQuestion(q: any, options: any[], randomizeOptions: boolean, marks: number): Promise<any> {
    const sign = async (key: string | null | undefined): Promise<string | null> => {
      if (!key) return null;
      try { return await this.storage.presignGet(String(key), 600); } catch { return null; }
    };
    let opts = await Promise.all((options || []).map(async (o: any) => ({
      id: Number(o.id), body: o.body, ordering: o.ordering, match_key: o.match_key ?? null,
      image_url: await sign(o.image_r2_key),
      // NB: is_correct is DELIBERATELY OMITTED — this is the answer-stripping seam for Batch C.
    })));
    if (randomizeOptions) opts = this.shuffle(opts);
    return {
      id: Number(q.id), q_type: q.q_type, difficulty: q.difficulty, body: q.body, language: q.language,
      marks, negative_marks: q.negative_marks,
      youtube_url: q.youtube_url ?? null, youtube_start_sec: q.youtube_start_sec ?? null, youtube_end_sec: q.youtube_end_sec ?? null,
      image_url: await sign(q.image_r2_key), audio_url: await sign(q.audio_r2_key),
      options: OBJECTIVE_TYPES.has(q.q_type) ? opts : [],
    };
  }

  private shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  /**
   * ASSEMBLE — the resolved question set a student would face, WITHOUT correct answers.
   * Respects randomize_questions / randomize_options / questions_to_show and pooled sections.
   * This is the single seam Batch C's attempt flow consumes; answer-stripping is centralised here.
   */
  async assemble(id: number, scope: ResolvedScope, opts: { forAttempt?: boolean } = {}) {
    const a = await this.getRow(id, scope);
    const randomizeOptions = opts.forAttempt ? (a.randomize_options || a.shuffle_per_attempt) : a.randomize_options;
    const randomizeQuestions = opts.forAttempt ? (a.randomize_questions || a.shuffle_per_attempt) : a.randomize_questions;

    // Hand-picked questions (section_id NULL) grouped as the "main" set.
    const picked = await this.db.query<any>(
      `SELECT aq.question_id, aq.marks_override, aq.ordering, q.*
         FROM assessment_question aq JOIN question q ON q.id = aq.question_id
        WHERE aq.assessment_id = $1::bigint AND aq.question_id IS NOT NULL AND q.deleted_at IS NULL
        ORDER BY aq.ordering, aq.id`, [id]);
    const sections = await this.db.query<any>(
      `SELECT s.id, s.title, s.description, s.ordering, s.pool_from_category_id, s.pool_pick_count
         FROM assessment_section s WHERE s.assessment_id = $1::bigint ORDER BY s.ordering, s.id`, [id]);

    const loadOptions = async (qid: number) =>
      this.db.query<any>(`SELECT id, body, image_r2_key, ordering, match_key FROM question_option WHERE question_id = $1::bigint ORDER BY ordering, id`, [qid]);

    // Main (hand-picked) set.
    let main = picked.map((q) => ({ q, marks: q.marks_override != null ? Number(q.marks_override) : Number(q.marks) }));
    if (randomizeQuestions) main = this.shuffle(main);
    if (a.questions_to_show != null && Number(a.questions_to_show) > 0 && Number(a.questions_to_show) < main.length) {
      main = main.slice(0, Number(a.questions_to_show));
    }
    const mainOut = await Promise.all(main.map(async (m) => this.stripQuestion(m.q, await loadOptions(Number(m.q.id)), randomizeOptions, m.marks)));

    // Pooled sections — draw pick_count random questions from the category.
    const sectionOut: any[] = [];
    for (const s of sections) {
      if (!s.pool_from_category_id || !s.pool_pick_count) continue;
      const pool = await this.db.query<any>(
        `SELECT * FROM question WHERE category_id = $1::bigint AND deleted_at IS NULL AND active
          ORDER BY random() LIMIT $2::int`, [s.pool_from_category_id, Number(s.pool_pick_count)]);
      const qs = await Promise.all(pool.map(async (q) => this.stripQuestion(q, await loadOptions(Number(q.id)), randomizeOptions, Number(q.marks))));
      sectionOut.push({ id: Number(s.id), title: s.title, description: s.description, questions: qs });
    }

    const flat = [...mainOut, ...sectionOut.flatMap((s) => s.questions)];
    return {
      assessment: {
        id: Number(a.id), title: a.title, description: a.description, test_type: a.test_type, language: a.language,
        instructions: a.instructions, duration_min: a.duration_min, total_marks: Number(a.total_marks),
        passing_marks: a.passing_marks, passing_pct: a.passing_pct, negative_marking: a.negative_marking,
        default_negative: a.default_negative, max_attempts: a.max_attempts, show_result_mode: a.show_result_mode,
        status: a.status, start_at: a.start_at, end_at: a.end_at,
      },
      main_questions: mainOut,
      sections: sectionOut,
      questions: flat,
      question_count: flat.length,
    };
  }

  /* -------------------------------------------------------------------- import */

  /**
   * CSV import of the TEST LIST — one draft test per row. Names, not ids: course/batch are
   * matched by name within scope. Mirrors the question-import contract: a bad row is reported,
   * never aborts the batch. Questions are added later in the builder (import creates the shell).
   */
  async import(rows: any[], me: { id: number }, scope: ResolvedScope) {
    if (!Array.isArray(rows) || !rows.length) throw new BadRequestException('Nothing to import — the file has no rows.');
    if (rows.length > 1000) throw new BadRequestException('Import is limited to 1000 rows per file.');
    const courses = await this.db.query<any>(`SELECT id, name, code FROM m_course WHERE is_active`, []);
    const byCourse = new Map<string, number>();
    for (const c of courses) { if (c.name) byCourse.set(String(c.name).toLowerCase(), Number(c.id)); if (c.code) byCourse.set(String(c.code).toLowerCase(), Number(c.id)); }
    const batches = await this.db.query<any>(`SELECT id, name FROM batch WHERE deleted_at IS NULL`, []);
    const byBatch = new Map<string, number>();
    for (const b of batches) if (b.name) byBatch.set(String(b.name).toLowerCase(), Number(b.id));
    let imported = 0;
    const errors: Array<{ row: number; message: string }> = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] ?? {};
      const line = i + 1;
      try {
        const test_type = String(r.test_type ?? r.type ?? 'practice').trim();
        if (!TEST_TYPES.includes(test_type as any)) throw new Error(`unknown test_type "${test_type}"`);
        let course_id: number | null = null;
        const ck = String(r.course ?? r.course_name ?? '').trim().toLowerCase();
        if (ck) { if (!byCourse.has(ck)) throw new Error(`course "${r.course}" not found`); course_id = byCourse.get(ck)!; }
        let batch_id: number | null = null;
        const bk = String(r.batch ?? r.batch_name ?? '').trim().toLowerCase();
        if (bk) { if (!byBatch.has(bk)) throw new Error(`batch "${r.batch}" not found`); batch_id = byBatch.get(bk)!; }
        await this.create({
          title: r.title ?? r.name, description: r.description || null, test_type, course_id, batch_id,
          language: r.language || null, duration_min: r.duration_min ?? 30,
          passing_marks: r.passing_marks ?? null, passing_pct: r.passing_pct ?? null,
          negative_marking: String(r.negative_marking ?? '').toLowerCase() === 'yes' || r.negative_marking === true,
          max_attempts: r.max_attempts ?? 1, instructions: r.instructions || null,
        }, me, scope);
        imported += 1;
      } catch (e) {
        errors.push({ row: line, message: (e as Error).message });
      }
    }
    return { imported, failed: errors.length, errors };
  }
}
