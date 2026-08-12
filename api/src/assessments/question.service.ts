import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ResolvedScope, ScopeColumnMap } from '../rbac/rbac.types';
import { StorageService } from '../storage/storage.service';
import { demoBinaryTreePng, demoListeningClipWav, DEMO_IMAGE_MCQ_KEY, DEMO_AUDIO_MCQ_KEY } from './demo-media';

/**
 * QUESTION BANK — Assessment Batch A (Insta Infotech IT + British College of Language items).
 *
 * A reusable question with a wide type list (objective auto-scorable; subjective evaluated in
 * Batch C). MEDIA RULE: images/audio live in Cloudflare R2 — the row stores only the r2_key;
 * YouTube "video" questions store the URL/id + start/end seconds, never an uploaded video.
 * Everything is scope-enforced through the central ScopeResolver, like invoices/students.
 */

export const QUESTION_SCOPE_COLS: ScopeColumnMap = {
  owner: 'q.created_by', team: 'q.team_id', branch: 'q.branch_id',
  vertical: 'q.vertical_id', pipeline: 'q.pipeline_id',
};

export const Q_TYPES = [
  'mcq_single', 'mcq_multi', 'true_false', 'fill_blank', 'match_following',
  'image_mcq', 'audio_mcq', 'video_mcq', 'short_answer', 'long_answer', 'essay',
  'case_study', 'coding', 'practical',
  'reading', 'listening', 'speaking', 'translation', 'vocabulary', 'grammar', 'writing',
] as const;
export type QType = typeof Q_TYPES[number];
/** Types that carry selectable options (auto-scorable objective items). */
export const OBJECTIVE_TYPES = new Set<string>(['mcq_single', 'mcq_multi', 'true_false', 'image_mcq', 'audio_mcq', 'video_mcq', 'match_following']);
const DIFFICULTIES = new Set(['easy', 'medium', 'hard']);

interface NormOption { body: string; image_r2_key: string | null; is_correct: boolean; ordering: number; match_key: string | null }

@Injectable()
export class QuestionService {
  private readonly log = new Logger('QuestionBank');

  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: ScopeResolverService,
    private readonly storage: StorageService,
  ) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  /* ---------------------------------------------------------------- normalise */

  private normaliseOptions(raw: unknown, qType: string): NormOption[] {
    const list = Array.isArray(raw) ? raw : [];
    const opts: NormOption[] = list.map((o: any, i: number) => ({
      body: String(o?.body ?? o?.text ?? '').trim(),
      image_r2_key: o?.image_r2_key ? String(o.image_r2_key).slice(0, 400) : null,
      is_correct: !!o?.is_correct,
      ordering: Number.isInteger(Number(o?.ordering)) ? Number(o.ordering) : i + 1,
      match_key: o?.match_key ? String(o.match_key).trim().slice(0, 200) : null,
    })).filter((o) => o.body || o.image_r2_key || o.match_key);
    if (OBJECTIVE_TYPES.has(qType)) {
      if (opts.length < 2) throw new BadRequestException('An objective question needs at least two options.');
      if (qType !== 'match_following' && !opts.some((o) => o.is_correct)) {
        throw new BadRequestException('Mark at least one option as correct.');
      }
      if (qType === 'mcq_single' || qType === 'true_false') {
        if (opts.filter((o) => o.is_correct).length > 1) throw new BadRequestException('A single-answer question can have only one correct option.');
      }
    }
    return opts;
  }

  private normalise(dto: any) {
    const q_type = String(dto?.q_type ?? '').trim();
    if (!Q_TYPES.includes(q_type as QType)) throw new BadRequestException(`Unknown question type "${q_type}".`);
    const difficulty = String(dto?.difficulty ?? 'medium').trim();
    if (!DIFFICULTIES.has(difficulty)) throw new BadRequestException('Difficulty must be easy, medium or hard.');
    const body = String(dto?.body ?? '').trim();
    if (!body) throw new BadRequestException('The question text is required.');
    const marks = Number(dto?.marks ?? 1);
    if (!Number.isFinite(marks) || marks < 0) throw new BadRequestException('Marks must be zero or more.');
    const negative_marks = Number(dto?.negative_marks ?? 0);
    if (!Number.isFinite(negative_marks) || negative_marks < 0) throw new BadRequestException('Negative marks must be zero or more.');
    const yt = dto?.youtube_url ? String(dto.youtube_url).trim().slice(0, 400) : null;
    if (q_type === 'video_mcq' && !yt) throw new BadRequestException('A video question needs a YouTube URL or video id.');
    const tags = Array.isArray(dto?.tags) ? dto.tags.map((t: any) => String(t).trim()).filter(Boolean).slice(0, 30) : [];
    return {
      q_type, difficulty, body, marks, negative_marks,
      category_id: dto?.category_id ? Number(dto.category_id) : null,
      branch_id: dto?.branch_id ? Number(dto.branch_id) : null,
      vertical_id: dto?.vertical_id ? Number(dto.vertical_id) : null,
      image_r2_key: dto?.image_r2_key ? String(dto.image_r2_key).slice(0, 400) : null,
      audio_r2_key: dto?.audio_r2_key ? String(dto.audio_r2_key).slice(0, 400) : null,
      youtube_url: yt,
      youtube_start_sec: dto?.youtube_start_sec != null && dto.youtube_start_sec !== '' ? Math.max(0, Math.trunc(Number(dto.youtube_start_sec))) : null,
      youtube_end_sec: dto?.youtube_end_sec != null && dto.youtube_end_sec !== '' ? Math.max(0, Math.trunc(Number(dto.youtube_end_sec))) : null,
      language: dto?.language ? String(dto.language).trim().slice(0, 40) : null,
      explanation: dto?.explanation ? String(dto.explanation) : null,
      tags,
      active: dto?.active === false ? false : true,
      options: this.normaliseOptions(dto?.options, q_type),
    };
  }

  /* -------------------------------------------------------------------- reads */

  async list(scope: ResolvedScope, f: {
    q_types?: string[]; difficulties?: string[]; languages?: string[];
    category_ids?: number[]; branch_ids?: number[]; vertical_ids?: number[];
    active?: string; q?: string; limit?: number;
  } = {}) {
    const params: unknown[] = [];
    const where = [`q.deleted_at IS NULL`, this.resolver.buildScopeWhere(scope, QUESTION_SCOPE_COLS, params)];
    if (f.q_types?.length) { params.push(f.q_types); where.push(`q.q_type = ANY($${params.length}::varchar[])`); }
    if (f.difficulties?.length) { params.push(f.difficulties); where.push(`q.difficulty = ANY($${params.length}::varchar[])`); }
    if (f.languages?.length) { params.push(f.languages); where.push(`q.language = ANY($${params.length}::varchar[])`); }
    if (f.category_ids?.length) { params.push(f.category_ids); where.push(`q.category_id = ANY($${params.length}::bigint[])`); }
    if (f.branch_ids?.length) { params.push(f.branch_ids); where.push(`q.branch_id = ANY($${params.length}::bigint[])`); }
    if (f.vertical_ids?.length) { params.push(f.vertical_ids); where.push(`q.vertical_id = ANY($${params.length}::bigint[])`); }
    if (f.active === '1' || f.active === '0') { params.push(f.active === '1'); where.push(`q.active = $${params.length}::boolean`); }
    if (f.q) { params.push(`%${f.q}%`); where.push(`(q.body ILIKE $${params.length} OR array_to_string(q.tags, ' ') ILIKE $${params.length})`); }
    params.push(Math.min(Number(f.limit ?? 300), 1000));
    return this.db.query<any>(
      `SELECT q.id, q.q_type, q.difficulty, q.marks, q.negative_marks, q.body, q.language, q.active, q.tags,
              q.category_id, q.branch_id, q.vertical_id, q.created_at,
              (q.image_r2_key IS NOT NULL) AS has_image, (q.audio_r2_key IS NOT NULL) AS has_audio,
              (q.youtube_url IS NOT NULL) AS has_video,
              c.name AS category_name, b.name AS branch_name, v.name AS vertical_name,
              u.name AS created_by_name,
              (SELECT count(*) FROM question_option o WHERE o.question_id = q.id) AS option_count
         FROM question q
         LEFT JOIN question_category c ON c.id = q.category_id
         LEFT JOIN branch b ON b.id = q.branch_id
         LEFT JOIN vertical v ON v.id = q.vertical_id
         LEFT JOIN "user" u ON u.id = q.created_by
        WHERE ${where.join(' AND ')}
        ORDER BY q.created_at DESC
        LIMIT $${params.length}`,
      params,
    );
  }

  async summary(scope: ResolvedScope) {
    const params: unknown[] = [];
    const w = this.resolver.buildScopeWhere(scope, QUESTION_SCOPE_COLS, params);
    const r = await this.db.one<any>(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE q.active) AS active,
              count(*) FILTER (WHERE q.difficulty = 'easy') AS easy,
              count(*) FILTER (WHERE q.difficulty = 'medium') AS medium,
              count(*) FILTER (WHERE q.difficulty = 'hard') AS hard
         FROM question q WHERE q.deleted_at IS NULL AND ${w}`, params);
    const num = (v: unknown) => Number(v ?? 0);
    return { total: num(r?.total), active: num(r?.active), easy: num(r?.easy), medium: num(r?.medium), hard: num(r?.hard) };
  }

  private async getRow(id: number, scope: ResolvedScope) {
    const params: unknown[] = [id];
    const w = this.resolver.buildScopeWhere(scope, QUESTION_SCOPE_COLS, params);
    const q = await this.db.one<any>(
      `SELECT q.*, c.name AS category_name, b.name AS branch_name, v.name AS vertical_name
         FROM question q
         LEFT JOIN question_category c ON c.id = q.category_id
         LEFT JOIN branch b ON b.id = q.branch_id
         LEFT JOIN vertical v ON v.id = q.vertical_id
        WHERE q.id = $1::bigint AND q.deleted_at IS NULL AND ${w}`, params);
    if (!q) throw new NotFoundException('Question not found (or outside your access)');
    return q;
  }

  /** Full question with options + short-lived presigned R2 URLs for any media. */
  async get(id: number, scope: ResolvedScope) {
    const q = await this.getRow(id, scope);
    const options = await this.db.query<any>(
      `SELECT id, body, image_r2_key, is_correct, ordering, match_key FROM question_option WHERE question_id = $1::bigint ORDER BY ordering, id`, [id]);
    const sign = async (key: string | null | undefined): Promise<string | null> => {
      if (!key) return null;
      try { return await this.storage.presignGet(String(key), 600); } catch { return null; }
    };
    return {
      ...q,
      image_url: await sign(q.image_r2_key),
      audio_url: await sign(q.audio_r2_key),
      options: await Promise.all(options.map(async (o: any) => ({ ...o, image_url: await sign(o.image_r2_key) }))),
    };
  }

  /* ------------------------------------------------------------------- writes */

  async create(dto: any, me: { id: number }, _scope: ResolvedScope) {
    const org = await this.orgId();
    const n = this.normalise(dto);
    return this.db.tx(async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO question (org_id, branch_id, vertical_id, category_id, q_type, difficulty, marks, negative_marks,
                               body, image_r2_key, audio_r2_key, youtube_url, youtube_start_sec, youtube_end_sec,
                               language, explanation, tags, active, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
        [org, n.branch_id, n.vertical_id, n.category_id, n.q_type, n.difficulty, n.marks, n.negative_marks,
          n.body, n.image_r2_key, n.audio_r2_key, n.youtube_url, n.youtube_start_sec, n.youtube_end_sec,
          n.language, n.explanation, n.tags, n.active, me.id]);
      const id = Number(r.rows[0].id);
      await this.insertOptions(c, id, n.options);
      return { id };
    });
  }

  async update(id: number, dto: any, _me: { id: number }, scope: ResolvedScope) {
    await this.getRow(id, scope);
    const n = this.normalise(dto);
    return this.db.tx(async (c) => {
      await c.query(
        `UPDATE question SET branch_id=$2, vertical_id=$3, category_id=$4, q_type=$5, difficulty=$6, marks=$7, negative_marks=$8,
                            body=$9, image_r2_key=$10, audio_r2_key=$11, youtube_url=$12, youtube_start_sec=$13, youtube_end_sec=$14,
                            language=$15, explanation=$16, tags=$17, active=$18, updated_at=now()
          WHERE id=$1::bigint`,
        [id, n.branch_id, n.vertical_id, n.category_id, n.q_type, n.difficulty, n.marks, n.negative_marks,
          n.body, n.image_r2_key, n.audio_r2_key, n.youtube_url, n.youtube_start_sec, n.youtube_end_sec,
          n.language, n.explanation, n.tags, n.active]);
      // Options are fully replaced on save (the editor sends the complete set).
      await c.query(`DELETE FROM question_option WHERE question_id = $1::bigint`, [id]);
      await this.insertOptions(c, id, n.options);
      return { id, ok: true };
    });
  }

  private async insertOptions(c: PoolClient, questionId: number, options: NormOption[]) {
    let n = 0;
    for (const o of options) {
      n += 1;
      await c.query(
        `INSERT INTO question_option (question_id, body, image_r2_key, is_correct, ordering, match_key)
         VALUES ($1::bigint,$2,$3,$4::boolean,$5::int,$6)`,
        [questionId, o.body, o.image_r2_key, o.is_correct, o.ordering || n, o.match_key]);
    }
  }

  async remove(id: number, me: { id: number }, scope: ResolvedScope) {
    await this.getRow(id, scope);
    await this.db.query(`UPDATE question SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint`, [id, me.id]);
    return { id, ok: true };
  }

  async bulkDeleteImpact(ids: number[], scope: ResolvedScope) {
    const clean = [...new Set((ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!clean.length) return { entity: 'question', label: 'Question', requested: 0, in_scope: 0, out_of_scope: 0, total_associations: 0, impact: [] };
    const params: unknown[] = [clean];
    const w = this.resolver.buildScopeWhere(scope, QUESTION_SCOPE_COLS, params);
    const inScope = await this.db.query<{ id: string }>(
      `SELECT q.id FROM question q WHERE q.id = ANY($1::bigint[]) AND q.deleted_at IS NULL AND ${w}`, params);
    const inIds = inScope.map((r) => Number(r.id));
    const oc = inIds.length
      ? await this.db.one<{ n: string }>(`SELECT count(*) AS n FROM question_option WHERE question_id = ANY($1::bigint[])`, [inIds])
      : { n: '0' };
    const options = Number(oc?.n ?? 0);
    return {
      entity: 'question', label: 'Question', requested: clean.length,
      in_scope: inIds.length, out_of_scope: clean.length - inIds.length,
      total_associations: options,
      impact: options ? [{ key: 'options', label: 'Options (removed with the question)', count: options }] : [],
    };
  }

  async bulkDelete(ids: number[], me: { id: number }, scope: ResolvedScope) {
    const clean = [...new Set((ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!clean.length) return { deleted: 0, skipped: 0 };
    const params: unknown[] = [clean, me.id];
    const w = this.resolver.buildScopeWhere(scope, QUESTION_SCOPE_COLS, params);
    const rows = await this.db.query<{ id: string }>(
      `UPDATE question q SET deleted_at = now(), deleted_by = $2::bigint
        WHERE q.id = ANY($1::bigint[]) AND q.deleted_at IS NULL AND ${w} RETURNING q.id`, params);
    return { deleted: rows.length, skipped: clean.length - rows.length };
  }

  /* --------------------------------------------------------------- media (R2) */

  /** Presigned PUT so the browser uploads the file straight to R2, then attaches the key. */
  async uploadUrl(dto: { kind?: string; file_name?: string; content_type?: string }) {
    const fileName = String(dto?.file_name ?? 'file').trim() || 'file';
    const contentType = String(dto?.content_type ?? 'application/octet-stream');
    const key = this.storage.questionMediaKey(fileName);
    const url = await this.storage.presignPut(key, contentType, 300);
    return { url, r2_key: key };
  }

  /**
   * DEMO MEDIA SEED (docs/dev/64) — invoked once at boot from main.ts. The Batch-A demo image_mcq /
   * audio_mcq shipped with NULL media, so the sheet showed "-" and no player. This ensures a real
   * PNG + WAV live in R2 (under fixed keys, via StorageService.putObject — the same store Batch A
   * uses) and that the two demo questions point at them. Idempotent: uploads only when the object is
   * missing and sets the key only when NULL. Needs a configured R2 credential, else it throws
   * NotConfiguredException (the boot caller swallows it — never crashes startup).
   */
  async seedDemoMedia() {
    const findDemo = async (qType: string, tag: string) => {
      const r = await this.db.query<{ id: string; image_r2_key: string | null; audio_r2_key: string | null }>(
        `SELECT id, image_r2_key, audio_r2_key FROM question
          WHERE q_type = $1 AND deleted_at IS NULL AND tags @> ARRAY['demo', $2]::text[]
          ORDER BY id LIMIT 1`, [qType, tag]);
      return r[0] ?? null;
    };
    const ensureObject = async (key: string, bytes: Buffer, contentType: string) => {
      const head = await this.storage.headObject(key);
      if (head && head.size > 0) return false;
      await this.storage.putObject(key, bytes, contentType);
      return true;
    };

    const out: any = { image: null, audio: null };

    const img = await findDemo('image_mcq', 'image');
    if (img) {
      const key = String(img.image_r2_key || DEMO_IMAGE_MCQ_KEY);
      const uploaded = await ensureObject(key, demoBinaryTreePng(), 'image/png');
      let keySet = false;
      if (!img.image_r2_key) {
        await this.db.query(`UPDATE question SET image_r2_key = $2, updated_at = now() WHERE id = $1::bigint AND image_r2_key IS NULL`, [Number(img.id), key]);
        keySet = true;
      }
      out.image = { id: Number(img.id), key, uploaded, keySet };
    }

    const aud = await findDemo('audio_mcq', 'listening');
    if (aud) {
      const key = String(aud.audio_r2_key || DEMO_AUDIO_MCQ_KEY);
      const uploaded = await ensureObject(key, demoListeningClipWav(), 'audio/wav');
      let keySet = false;
      if (!aud.audio_r2_key) {
        await this.db.query(`UPDATE question SET audio_r2_key = $2, updated_at = now() WHERE id = $1::bigint AND audio_r2_key IS NULL`, [Number(aud.id), key]);
        keySet = true;
      }
      out.audio = { id: Number(aud.id), key, uploaded, keySet };
    }
    return out;
  }

  /* -------------------------------------------------------------------- import */

  /**
   * CSV import — validate each row (category by name/code, q_type against the CHECK list) and
   * insert the valid ones, returning a per-row error report. Mirrors the lead-import contract:
   * a bad row NEVER aborts the batch; it is reported by row number and reason.
   */
  async import(rows: any[], me: { id: number }, scope: ResolvedScope) {
    const org = await this.orgId();
    if (!Array.isArray(rows) || !rows.length) throw new BadRequestException('Nothing to import — the file has no rows.');
    if (rows.length > 2000) throw new BadRequestException('Import is limited to 2000 rows per file.');
    // resolve categories in scope, keyed by lower(name) and lower(code)
    const catRows = await this.db.query<any>(
      `SELECT qc.id, qc.name, qc.code FROM question_category qc WHERE qc.deleted_at IS NULL AND ${this.resolver.buildScopeWhere(scope, { owner: 'qc.created_by', branch: 'qc.branch_id', vertical: 'qc.vertical_id' }, [])}`,
      [],
    );
    const byName = new Map<string, number>();
    for (const c of catRows) {
      if (c.name) byName.set(String(c.name).toLowerCase(), Number(c.id));
      if (c.code) byName.set(String(c.code).toLowerCase(), Number(c.id));
    }
    let imported = 0;
    const errors: Array<{ row: number; message: string }> = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] ?? {};
      const line = i + 1;
      try {
        const q_type = String(r.q_type ?? r.type ?? '').trim();
        if (!Q_TYPES.includes(q_type as QType)) throw new Error(`unknown q_type "${q_type}"`);
        let category_id: number | null = null;
        const catKey = String(r.category ?? r.category_name ?? r.category_code ?? '').trim().toLowerCase();
        if (catKey) {
          if (!byName.has(catKey)) throw new Error(`category "${r.category ?? r.category_code}" not found`);
          category_id = byName.get(catKey)!;
        }
        const options = this.optionsFromCsv(r, q_type);
        await this.create({
          q_type, category_id,
          difficulty: r.difficulty || 'medium',
          marks: r.marks ?? 1, negative_marks: r.negative_marks ?? 0,
          body: r.body ?? r.question ?? r.text, language: r.language || null,
          explanation: r.explanation || null,
          branch_id: r.branch_id || null, vertical_id: r.vertical_id || null,
          youtube_url: r.youtube_url || null, youtube_start_sec: r.youtube_start_sec, youtube_end_sec: r.youtube_end_sec,
          tags: r.tags ? String(r.tags).split(/[;|]/).map((t: string) => t.trim()).filter(Boolean) : [],
          options,
        }, me, scope);
        imported += 1;
      } catch (e) {
        errors.push({ row: line, message: (e as Error).message });
      }
    }
    return { imported, failed: errors.length, errors };
  }

  /** option_1..option_6 columns + correct=comma indices; for CSV-friendly objective import. */
  private optionsFromCsv(r: any, qType: string): any[] {
    if (!OBJECTIVE_TYPES.has(qType)) return [];
    const opts: any[] = [];
    const correct = new Set(String(r.correct ?? r.answer ?? '').split(/[,;]/).map((x) => x.trim()).filter(Boolean));
    for (let n = 1; n <= 8; n++) {
      const body = r[`option_${n}`] ?? r[`opt${n}`];
      if (body == null || String(body).trim() === '') continue;
      opts.push({ body: String(body), ordering: n, is_correct: correct.has(String(n)) || correct.has(String(body).trim()) });
    }
    return opts;
  }
}
