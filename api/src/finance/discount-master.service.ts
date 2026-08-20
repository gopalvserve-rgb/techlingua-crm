import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { rupeesToMinor } from '../common/money.util';
import { DiscountCapRow, CapCtx, pickCap, capMinor, resolveCapMinor } from './discount-master.util';

/**
 * DISCOUNT MASTER (migration 093) — the manageable master of discount caps and the resolver
 * the enrolment discount-check runs through. CRUD is guarded by discount.* at the controller;
 * `resolve()` is the most-specific-wins cap for a (branch, vertical, course), reused by the
 * enrolment create/convert/edit path to decide whether a discount is within cap or over-cap.
 */
@Injectable()
export class DiscountMasterService {
  constructor(private readonly db: DatabaseService) {}

  private async orgId(): Promise<number> {
    const r = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    if (!r) throw new NotFoundException('No organisation');
    return Number(r.id);
  }

  /** All active (non-deleted) cap rows for the org, as the pure resolver expects them. */
  async caps(): Promise<DiscountCapRow[]> {
    const org = await this.orgId();
    const rows = await this.db.query<any>(
      `SELECT id, branch_id, vertical_id, course_id, course_level_id, max_percent, max_amount_minor
         FROM discount_master
        WHERE org_id = $1::bigint AND active AND deleted_at IS NULL`,
      [org],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      branch_id: r.branch_id != null ? Number(r.branch_id) : null,
      vertical_id: r.vertical_id != null ? Number(r.vertical_id) : null,
      course_id: r.course_id != null ? Number(r.course_id) : null,
      course_level_id: r.course_level_id != null ? Number(r.course_level_id) : null,
      max_percent: r.max_percent != null ? Number(r.max_percent) : null,
      max_amount_minor: r.max_amount_minor != null ? Number(r.max_amount_minor) : null,
    }));
  }

  /** The applicable cap + the max discount (paise) for a base. Reused by the enrolment path. */
  async resolve(ctx: CapCtx, base: number): Promise<{ cap: DiscountCapRow | null; capMinor: number | null }> {
    return resolveCapMinor(await this.caps(), ctx, base);
  }

  /** The applicable cap row (no base) — for the UI hint on the discount control. */
  async resolveCap(ctx: CapCtx): Promise<DiscountCapRow | null> {
    return pickCap(await this.caps(), ctx);
  }

  /** GET /discounts/effective — the cap that applies for a (branch,vertical,course), for the form. */
  async effectiveForApi(ctx: CapCtx, base?: number) {
    const cap = await this.resolveCap(ctx);
    return {
      ...ctx,
      cap: cap
        ? { id: cap.id, max_percent: cap.max_percent, max_amount_minor: cap.max_amount_minor }
        : null,
      cap_minor: base != null && Number.isFinite(base) ? capMinor(cap, Math.trunc(Number(base))) : null,
    };
  }

  /** The full list for the admin screen — with branch/vertical/course names. */
  async list() {
    const org = await this.orgId();
    return this.db.query<any>(
      `SELECT dm.id, dm.name, dm.branch_id, dm.vertical_id, dm.course_id, dm.course_level_id,
              dm.max_percent, dm.max_amount_minor, dm.active, dm.updated_at,
              b.name AS branch_name, v.name AS vertical_name, c.name AS course_name, c.code AS course_code,
              cl.code AS course_level_code, COALESCE(cl.label, cl.code) AS course_level_label
         FROM discount_master dm
         LEFT JOIN branch b ON b.id = dm.branch_id
         LEFT JOIN vertical v ON v.id = dm.vertical_id
         LEFT JOIN m_course c ON c.id = dm.course_id
         LEFT JOIN course_level cl ON cl.id = dm.course_level_id
        WHERE dm.org_id = $1::bigint AND dm.deleted_at IS NULL
        ORDER BY (dm.course_level_id IS NOT NULL) DESC, (dm.course_id IS NOT NULL) DESC,
                 (dm.vertical_id IS NOT NULL) DESC, (dm.branch_id IS NOT NULL) DESC, dm.name`,
      [org],
    );
  }

  private pct(v: unknown, label: string): number | null {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).trim());
    if (!Number.isFinite(n) || n < 0 || n > 100) throw new BadRequestException(`${label} must be a percentage between 0 and 100.`);
    return n;
  }

  private amt(rupees: unknown, minor: unknown, label: string): number | null {
    if (minor !== undefined && minor !== null && minor !== '') {
      const m = Math.trunc(Number(minor));
      if (!Number.isFinite(m) || m < 0) throw new BadRequestException(`${label} cannot be negative.`);
      return m;
    }
    if (rupees === null || rupees === undefined || rupees === '') return null;
    let m: number;
    try { m = rupeesToMinor(rupees); } catch (e) { throw new BadRequestException(`${label}: ${(e as Error).message}`); }
    if (m < 0) throw new BadRequestException(`${label} cannot be negative.`);
    return m;
  }

  private normalise(dto: any) {
    const name = String(dto?.name ?? '').trim();
    if (!name) throw new BadRequestException('Give the discount rule a name.');
    const max_percent = this.pct(dto?.max_percent, 'Max discount %');
    const max_amount_minor = this.amt(dto?.max_amount, dto?.max_amount_minor, 'Max discount amount');
    if (max_percent == null && max_amount_minor == null) {
      throw new BadRequestException('Set at least one cap — a max percentage and/or a max amount.');
    }
    const courseId = dto?.course_id ? Number(dto.course_id) : null;
    // A level scope is only meaningful alongside a course (a level belongs to a course).
    const courseLevelId = courseId && dto?.course_level_id ? Number(dto.course_level_id) : null;
    return {
      name,
      branch_id: dto?.branch_id ? Number(dto.branch_id) : null,
      vertical_id: dto?.vertical_id ? Number(dto.vertical_id) : null,
      course_id: courseId,
      course_level_id: courseLevelId,
      max_percent, max_amount_minor,
      active: dto?.active === undefined ? true : !!dto.active,
    };
  }

  async create(dto: any, actorId: number) {
    const org = await this.orgId();
    const v = this.normalise(dto);
    const row = await this.db.one<any>(
      `INSERT INTO discount_master (org_id, name, branch_id, vertical_id, course_id, course_level_id,
                                    max_percent, max_amount_minor, active, created_by, updated_by)
       VALUES ($1::bigint, $2, $3::bigint, $4::bigint, $5::bigint, $6::bigint, $7, $8, $9, $10::bigint, $10::bigint)
       RETURNING id`,
      [org, v.name, v.branch_id, v.vertical_id, v.course_id, v.course_level_id, v.max_percent, v.max_amount_minor, v.active, actorId],
    );
    return { id: Number(row.id), ok: true };
  }

  async update(id: number, dto: any, actorId: number) {
    const org = await this.orgId();
    const cur = await this.db.one<any>(
      `SELECT * FROM discount_master WHERE id = $1::bigint AND org_id = $2::bigint AND deleted_at IS NULL`, [id, org]);
    if (!cur) throw new NotFoundException('Discount rule not found');
    const v = this.normalise({
      name: dto?.name ?? cur.name,
      branch_id: dto?.branch_id === undefined ? cur.branch_id : dto.branch_id,
      vertical_id: dto?.vertical_id === undefined ? cur.vertical_id : dto.vertical_id,
      course_id: dto?.course_id === undefined ? cur.course_id : dto.course_id,
      course_level_id: dto?.course_level_id === undefined ? cur.course_level_id : dto.course_level_id,
      max_percent: dto?.max_percent === undefined ? cur.max_percent : dto.max_percent,
      max_amount_minor: dto?.max_amount_minor === undefined && dto?.max_amount === undefined ? cur.max_amount_minor : dto.max_amount_minor,
      max_amount: dto?.max_amount,
      active: dto?.active === undefined ? cur.active : dto.active,
    });
    await this.db.query(
      `UPDATE discount_master SET name = $2, branch_id = $3::bigint, vertical_id = $4::bigint,
              course_id = $5::bigint, course_level_id = $6::bigint, max_percent = $7, max_amount_minor = $8,
              active = $9, updated_by = $10::bigint, updated_at = now()
        WHERE id = $1::bigint`,
      [id, v.name, v.branch_id, v.vertical_id, v.course_id, v.course_level_id, v.max_percent, v.max_amount_minor, v.active, actorId],
    );
    return { id, ok: true };
  }

  async remove(id: number, actorId: number) {
    const org = await this.orgId();
    const cur = await this.db.one<any>(
      `SELECT id FROM discount_master WHERE id = $1::bigint AND org_id = $2::bigint AND deleted_at IS NULL`, [id, org]);
    if (!cur) throw new NotFoundException('Discount rule not found');
    await this.db.query(`UPDATE discount_master SET deleted_at = now(), updated_by = $2::bigint WHERE id = $1::bigint`, [id, actorId]);
    return { id, ok: true };
  }

  async bulkDeleteImpact(ids: number[]) {
    const clean = [...new Set((ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    return { deletable: clean, blocked: [], count: clean.length };
  }

  async bulkDelete(ids: number[], actorId: number) {
    const { deletable } = await this.bulkDeleteImpact(ids);
    if (!deletable.length) return { deleted: 0 };
    const org = await this.orgId();
    await this.db.query(
      `UPDATE discount_master SET deleted_at = now(), updated_by = $3::bigint
        WHERE id = ANY($1::bigint[]) AND org_id = $2::bigint AND deleted_at IS NULL`,
      [deletable, org, actorId]);
    return { deleted: deletable.length };
  }
}
