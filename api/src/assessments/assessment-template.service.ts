import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';

/**
 * ASSESSMENT TEMPLATE — Assessment Batch B.
 *
 * A reusable settings preset (duration, negative marking, randomisation, attempt limit,
 * pass %, show-result mode, instructions) that a test can be created from. Creating a test
 * from a template COPIES its settings (see AssessmentService.createFromTemplate). Scope-
 * enforced through the central ScopeResolver, exactly like the question bank.
 */
export const ATMPL_SCOPE_COLS: ScopeColumnMap = {
  owner: 't.created_by', branch: 't.branch_id', vertical: 't.vertical_id',
};

export const TEST_TYPES = ['practice', 'chapter', 'weekly', 'mock', 'assignment', 'practical', 'final_exam'] as const;
export const SHOW_RESULT_MODES = ['instant', 'manual', 'after_end'] as const;

@Injectable()
export class AssessmentTemplateService {
  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  private normalise(dto: any) {
    const name = String(dto?.name ?? '').trim();
    if (!name) throw new BadRequestException('A template name is required.');
    const test_type = String(dto?.test_type ?? 'practice').trim();
    if (!TEST_TYPES.includes(test_type as any)) throw new BadRequestException(`Unknown test type "${test_type}".`);
    const show = String(dto?.show_result_mode ?? 'instant').trim();
    if (!SHOW_RESULT_MODES.includes(show as any)) throw new BadRequestException('Unknown show-result mode.');
    const num = (v: any, d: number) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
    const pct = dto?.passing_pct === '' || dto?.passing_pct == null ? null : Math.min(100, Math.max(0, Number(dto.passing_pct)));
    const qts = dto?.questions_to_show === '' || dto?.questions_to_show == null ? null : Math.max(1, Math.trunc(Number(dto.questions_to_show)));
    return {
      name: name.slice(0, 160), test_type,
      branch_id: dto?.branch_id ? Number(dto.branch_id) : null,
      vertical_id: dto?.vertical_id ? Number(dto.vertical_id) : null,
      duration_min: Math.max(0, Math.trunc(num(dto?.duration_min, 30))),
      negative_marking: !!dto?.negative_marking,
      default_negative: num(dto?.default_negative, 0),
      randomize_questions: !!dto?.randomize_questions,
      randomize_options: !!dto?.randomize_options,
      shuffle_per_attempt: !!dto?.shuffle_per_attempt,
      questions_to_show: qts,
      max_attempts: Math.max(1, Math.trunc(num(dto?.max_attempts, 1))),
      passing_pct: pct != null && Number.isFinite(pct) ? pct : null,
      show_result_mode: show,
      instructions: dto?.instructions ? String(dto.instructions) : null,
      active: dto?.active === false ? false : true,
    };
  }

  async list(scope: ResolvedScope, f: { branch_ids?: number[]; vertical_ids?: number[]; test_types?: string[]; q?: string; active?: string } = {}) {
    const params: unknown[] = [];
    const where = [`t.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, ATMPL_SCOPE_COLS, params)];
    if (f.branch_ids?.length) { params.push(f.branch_ids); where.push(`t.branch_id = ANY($${params.length}::bigint[])`); }
    if (f.vertical_ids?.length) { params.push(f.vertical_ids); where.push(`t.vertical_id = ANY($${params.length}::bigint[])`); }
    if (f.test_types?.length) { params.push(f.test_types); where.push(`t.test_type = ANY($${params.length}::varchar[])`); }
    if (f.active === '1' || f.active === '0') { params.push(f.active === '1'); where.push(`t.active = $${params.length}::boolean`); }
    if (f.q) { params.push(`%${f.q}%`); where.push(`t.name ILIKE $${params.length}`); }
    return this.db.query<any>(
      `SELECT t.*, b.name AS branch_name, v.name AS vertical_name,
              (SELECT count(*) FROM assessment a WHERE a.template_id = t.id AND a.deleted_at IS NULL) AS used_count
         FROM assessment_template t
         LEFT JOIN branch b ON b.id = t.branch_id
         LEFT JOIN vertical v ON v.id = t.vertical_id
        WHERE ${where.join(' AND ')}
        ORDER BY t.created_at DESC`, params);
  }

  async getScoped(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, ATMPL_SCOPE_COLS, params);
    const r = await this.db.one<any>(
      `SELECT t.* FROM assessment_template t WHERE t.id = $1::bigint AND t.deleted_at IS NULL AND ${w}`, params);
    if (!r) throw new NotFoundException('Template not found (or outside your access)');
    return r;
  }

  async create(dto: any, me: { id: number }, _scope: ResolvedScope) {
    const org = await this.orgId();
    const n = this.normalise(dto);
    const r = await this.db.one<{ id: string }>(
      `INSERT INTO assessment_template (org_id, branch_id, vertical_id, name, test_type, duration_min,
          negative_marking, default_negative, randomize_questions, randomize_options, shuffle_per_attempt,
          questions_to_show, max_attempts, passing_pct, show_result_mode, instructions, active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
      [org, n.branch_id, n.vertical_id, n.name, n.test_type, n.duration_min, n.negative_marking, n.default_negative,
        n.randomize_questions, n.randomize_options, n.shuffle_per_attempt, n.questions_to_show, n.max_attempts,
        n.passing_pct, n.show_result_mode, n.instructions, n.active, me.id]);
    return { id: Number(r!.id) };
  }

  async update(id: number, dto: any, _me: { id: number }, scope: ResolvedScope) {
    await this.getScoped(id, scope);
    const n = this.normalise(dto);
    await this.db.query(
      `UPDATE assessment_template SET branch_id=$2, vertical_id=$3, name=$4, test_type=$5, duration_min=$6,
          negative_marking=$7, default_negative=$8, randomize_questions=$9, randomize_options=$10, shuffle_per_attempt=$11,
          questions_to_show=$12, max_attempts=$13, passing_pct=$14, show_result_mode=$15, instructions=$16, active=$17,
          updated_at=now()
        WHERE id=$1::bigint`,
      [id, n.branch_id, n.vertical_id, n.name, n.test_type, n.duration_min, n.negative_marking, n.default_negative,
        n.randomize_questions, n.randomize_options, n.shuffle_per_attempt, n.questions_to_show, n.max_attempts,
        n.passing_pct, n.show_result_mode, n.instructions, n.active]);
    return { id, ok: true };
  }

  async remove(id: number, me: { id: number }, scope: ResolvedScope) {
    await this.getScoped(id, scope);
    await this.db.query(`UPDATE assessment_template SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint`, [id, me.id]);
    return { id, ok: true };
  }

  async bulkDeleteImpact(ids: number[], scope: ResolvedScope) {
    const clean = [...new Set((ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!clean.length) return { entity: 'assessment_template', label: 'Template', requested: 0, in_scope: 0, out_of_scope: 0, total_associations: 0, impact: [] };
    const params: unknown[] = [clean];
    const w = this.resolver.buildScopeWhere(scope, ATMPL_SCOPE_COLS, params);
    const inScope = await this.db.query<{ id: string }>(
      `SELECT t.id FROM assessment_template t WHERE t.id = ANY($1::bigint[]) AND t.deleted_at IS NULL AND ${w}`, params);
    const inIds = inScope.map((r) => Number(r.id));
    const uc = inIds.length
      ? await this.db.one<{ n: string }>(`SELECT count(*) AS n FROM assessment WHERE template_id = ANY($1::bigint[]) AND deleted_at IS NULL`, [inIds])
      : { n: '0' };
    const used = Number(uc?.n ?? 0);
    return {
      entity: 'assessment_template', label: 'Template', requested: clean.length,
      in_scope: inIds.length, out_of_scope: clean.length - inIds.length,
      total_associations: used,
      impact: used ? [{ key: 'tests', label: 'Tests created from it (kept, link cleared)', count: used }] : [],
    };
  }

  async bulkDelete(ids: number[], me: { id: number }, scope: ResolvedScope) {
    const clean = [...new Set((ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!clean.length) return { deleted: 0, skipped: 0 };
    const params: unknown[] = [clean, me.id];
    const w = this.resolver.buildScopeWhere(scope, ATMPL_SCOPE_COLS, params);
    const rows = await this.db.query<{ id: string }>(
      `UPDATE assessment_template t SET deleted_at = now(), deleted_by = $2::bigint
        WHERE t.id = ANY($1::bigint[]) AND t.deleted_at IS NULL AND ${w} RETURNING t.id`, params);
    return { deleted: rows.length, skipped: clean.length - rows.length };
  }
}
