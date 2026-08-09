import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { assertDateRange, requireDateString } from '../common/date.util';

const CATS = ['feature', 'fix', 'improvement'];

/**
 * RELEASE NOTE — an ORG-WIDE in-app changelog. Admins (release_note.manage) create entries;
 * ALL staff (release_note.view) read the "What's New / Release Notes" screen backed by this
 * data. Not branch-scoped. Full list treatment on the manage list; the What's-New feed is
 * `feed()` (active, newest first).
 */
@Injectable()
export class ReleaseNoteService {
  constructor(private readonly db: DatabaseService) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  async list(f: any = {}) {
    const params: unknown[] = [];
    const where = [`r.deleted_at IS NULL`];
    if (CATS.includes(String(f.category))) { params.push(String(f.category)); where.push(`r.category = $${params.length}`); }
    if (f.active === 'true' || f.active === 'false') { params.push(f.active === 'true'); where.push(`r.active = $${params.length}`); }
    const dr = assertDateRange(f.from, f.to);
    if (dr.from) { params.push(dr.from); where.push(`r.release_date >= $${params.length}::date`); }
    if (dr.to) { params.push(dr.to); where.push(`r.release_date <= $${params.length}::date`); }
    if (f.q) { params.push(`%${f.q}%`); where.push(`(r.title ILIKE $${params.length} OR r.notes ILIKE $${params.length} OR r.version ILIKE $${params.length})`); }
    params.push(Math.min(Number(f.limit ?? 300), 1000));
    return this.db.query<any>(
      `SELECT r.id, r.version, r.release_date, r.title, r.notes, r.category, r.active, r.created_at,
              u.name AS created_by_name
         FROM release_note r
         LEFT JOIN "user" u ON u.id = r.created_by
        WHERE ${where.join(' AND ')}
        ORDER BY r.release_date DESC, r.id DESC
        LIMIT $${params.length}`, params);
  }

  /** The read-only "What's New" feed for every user — active entries, newest first. */
  async feed(limit = 30) {
    return this.db.query<any>(
      `SELECT r.id, r.version, r.release_date, r.title, r.notes, r.category
         FROM release_note r
        WHERE r.deleted_at IS NULL AND r.active = TRUE
        ORDER BY r.release_date DESC, r.id DESC
        LIMIT $1`, [Math.min(Number(limit) || 30, 100)]);
  }

  async get(id: number) {
    const m = await this.db.one<any>(
      `SELECT r.*, u.name AS created_by_name FROM release_note r
         LEFT JOIN "user" u ON u.id = r.created_by
        WHERE r.id = $1::bigint AND r.deleted_at IS NULL`, [id]);
    if (!m) throw new NotFoundException('Release note not found');
    return m;
  }

  private norm(dto: any) {
    const title = String(dto?.title ?? '').trim();
    if (!title) throw new BadRequestException('Give the release note a title.');
    const category = CATS.includes(String(dto?.category)) ? String(dto.category) : 'feature';
    return { title, category };
  }

  async create(dto: any, me: { id: number }) {
    const { title, category } = this.norm(dto);
    const orgId = await this.orgId();
    const releaseDate = dto?.release_date ? requireDateString(dto.release_date, () => { throw new BadRequestException('Enter a valid release date (DD-MM-YYYY).'); }) : null;
    const ins = await this.db.query<{ id: string }>(
      `INSERT INTO release_note (org_id, version, release_date, title, notes, category, active, created_by)
       VALUES ($1::bigint,$2,COALESCE($3::date, (now() AT TIME ZONE 'Asia/Kolkata')::date),$4,$5,$6,$7,$8::bigint)
       RETURNING id`,
      [orgId, dto?.version ?? null, releaseDate, title, dto?.notes ?? null, category,
        dto?.active === undefined ? true : !!dto.active, me.id]);
    return { id: Number(ins[0].id) };
  }

  async update(id: number, dto: any) {
    await this.get(id);
    const sets: string[] = []; const params: unknown[] = [];
    const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (dto?.title !== undefined) { const t = String(dto.title).trim(); if (!t) throw new BadRequestException('Title cannot be empty.'); set('title', t); }
    if (dto?.version !== undefined) set('version', dto.version ?? null);
    if (dto?.release_date !== undefined && dto.release_date) set('release_date', requireDateString(dto.release_date, () => { throw new BadRequestException('Enter a valid release date (DD-MM-YYYY).'); }));
    if (dto?.notes !== undefined) set('notes', dto.notes ?? null);
    if (dto?.category !== undefined) { if (!CATS.includes(String(dto.category))) throw new BadRequestException('Invalid category.'); set('category', String(dto.category)); }
    if (dto?.active !== undefined) set('active', !!dto.active);
    if (!sets.length) return { id, unchanged: true };
    params.push(id);
    await this.db.query(`UPDATE release_note SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}::bigint`, params);
    return { id };
  }

  async remove(id: number, me: { id: number }) {
    await this.get(id);
    await this.db.query(`UPDATE release_note SET deleted_at = now(), deleted_by = $2::bigint WHERE id = $1::bigint AND deleted_at IS NULL`, [id, me.id]);
    return { id, deleted: true };
  }

  /* ---- bulk delete ----------------------------------------------------- */
  private ids(raw: unknown): number[] {
    return (Array.isArray(raw) ? raw : []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
  }
  private async liveIds(ids: number[]): Promise<number[]> {
    if (!ids.length) return [];
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM release_note WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL`, [ids]);
    return rows.map((r) => Number(r.id));
  }
  async bulkImpact(raw: unknown) {
    const req = this.ids(raw); const ok = await this.liveIds(req);
    return { entity: 'release_note', label: 'Release Notes', requested: req.length, in_scope: ok.length,
      out_of_scope: req.length - ok.length, total_associations: 0, impact: [] };
  }
  async bulkRemove(raw: unknown, me: { id: number }) {
    const ok = await this.liveIds(this.ids(raw));
    let deleted = 0;
    for (const id of ok) { await this.remove(id, me); deleted++; }
    return { deleted, skipped: this.ids(raw).length - deleted };
  }
}
