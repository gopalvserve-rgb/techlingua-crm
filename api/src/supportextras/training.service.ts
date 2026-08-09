import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { assertDateRange } from '../common/date.util';

/**
 * TRAINING VIDEO — an ORG-WIDE library of training / how-to videos for staff. Not scoped
 * to a branch/vertical (it is a shared staff resource), so the guard (@RequirePermission
 * training.view / training.manage) is the whole access story. Full list treatment: multi
 * filters (category / active / q / date), export & column chooser (client), bulk-delete.
 */
@Injectable()
export class TrainingService {
  constructor(private readonly db: DatabaseService) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  async list(f: any = {}) {
    const params: unknown[] = [];
    const where = [`t.deleted_at IS NULL`];
    if (f.category) { params.push(String(f.category)); where.push(`t.category = $${params.length}`); }
    if (f.active === 'true' || f.active === 'false') { params.push(f.active === 'true'); where.push(`t.active = $${params.length}`); }
    const dr = assertDateRange(f.from, f.to);
    if (dr.from) { params.push(dr.from); where.push(`t.created_at >= $${params.length}::date`); }
    if (dr.to) { params.push(dr.to); where.push(`t.created_at < ($${params.length}::date + 1)`); }
    if (f.q) { params.push(`%${f.q}%`); where.push(`(t.title ILIKE $${params.length} OR t.description ILIKE $${params.length} OR t.tags ILIKE $${params.length})`); }
    params.push(Math.min(Number(f.limit ?? 300), 1000));
    return this.db.query<any>(
      `SELECT t.id, t.title, t.description, t.category, t.video_url, t.thumbnail_url, t.tags,
              t.sort_order, t.active, t.created_at, u.name AS created_by_name
         FROM training_video t
         LEFT JOIN "user" u ON u.id = t.created_by
        WHERE ${where.join(' AND ')}
        ORDER BY t.active DESC, t.sort_order ASC, t.created_at DESC
        LIMIT $${params.length}`, params);
  }

  /** Distinct categories in use — powers the manage-list filter and the browse grouping. */
  async categories() {
    const rows = await this.db.query<{ category: string }>(
      `SELECT DISTINCT category FROM training_video WHERE deleted_at IS NULL AND category IS NOT NULL AND category <> '' ORDER BY category`);
    return rows.map((r) => r.category);
  }

  async get(id: number) {
    const m = await this.db.one<any>(
      `SELECT t.*, u.name AS created_by_name FROM training_video t
         LEFT JOIN "user" u ON u.id = t.created_by
        WHERE t.id = $1::bigint AND t.deleted_at IS NULL`, [id]);
    if (!m) throw new NotFoundException('Training video not found');
    return m;
  }

  private norm(dto: any) {
    const title = String(dto?.title ?? '').trim();
    if (!title) throw new BadRequestException('Give the training video a title.');
    const url = String(dto?.video_url ?? '').trim();
    if (!url) throw new BadRequestException('Add the video URL (YouTube / Vimeo / MP4 / embed link).');
    return { title, url };
  }

  async create(dto: any, me: { id: number }) {
    const { title, url } = this.norm(dto);
    const orgId = await this.orgId();
    const ins = await this.db.query<{ id: string }>(
      `INSERT INTO training_video (org_id, title, description, category, video_url, thumbnail_url, tags, sort_order, active, created_by)
       VALUES ($1::bigint,$2,$3,$4,$5,$6,$7,$8,$9,$10::bigint) RETURNING id`,
      [orgId, title, dto?.description ?? null, dto?.category ?? null, url, dto?.thumbnail_url ?? null,
        dto?.tags ?? null, Number.isFinite(Number(dto?.sort_order)) ? Number(dto.sort_order) : 0,
        dto?.active === undefined ? true : !!dto.active, me.id]);
    return { id: Number(ins[0].id) };
  }

  async update(id: number, dto: any) {
    await this.get(id);
    const sets: string[] = []; const params: unknown[] = [];
    const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (dto?.title !== undefined) { const t = String(dto.title).trim(); if (!t) throw new BadRequestException('Title cannot be empty.'); set('title', t); }
    if (dto?.description !== undefined) set('description', dto.description ?? null);
    if (dto?.category !== undefined) set('category', dto.category ?? null);
    if (dto?.video_url !== undefined) { const u = String(dto.video_url).trim(); if (!u) throw new BadRequestException('Video URL cannot be empty.'); set('video_url', u); }
    if (dto?.thumbnail_url !== undefined) set('thumbnail_url', dto.thumbnail_url ?? null);
    if (dto?.tags !== undefined) set('tags', dto.tags ?? null);
    if (dto?.sort_order !== undefined) set('sort_order', Number.isFinite(Number(dto.sort_order)) ? Number(dto.sort_order) : 0);
    if (dto?.active !== undefined) set('active', !!dto.active);
    if (!sets.length) return { id, unchanged: true };
    params.push(id);
    await this.db.query(`UPDATE training_video SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}::bigint`, params);
    return { id };
  }

  async remove(id: number, me: { id: number }) {
    await this.get(id);
    await this.db.query(`UPDATE training_video SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint AND deleted_at IS NULL`, [id, me.id]);
    return { id, deleted: true };
  }

  /* ---- bulk delete (client standard on every list) --------------------- */
  private ids(raw: unknown): number[] {
    return (Array.isArray(raw) ? raw : []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
  }
  private async liveIds(ids: number[]): Promise<number[]> {
    if (!ids.length) return [];
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM training_video WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL`, [ids]);
    return rows.map((r) => Number(r.id));
  }
  async bulkImpact(raw: unknown) {
    const req = this.ids(raw); const ok = await this.liveIds(req);
    return { entity: 'training_video', label: 'Training Videos', requested: req.length, in_scope: ok.length,
      out_of_scope: req.length - ok.length, total_associations: 0, impact: [] };
  }
  async bulkRemove(raw: unknown, me: { id: number }) {
    const ok = await this.liveIds(this.ids(raw));
    let deleted = 0;
    for (const id of ok) { await this.remove(id, me); deleted++; }
    return { deleted, skipped: this.ids(raw).length - deleted };
  }
}
