import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { rupeesToMinor } from '../common/money.util';

/**
 * COURSE LEVELS (enrollment re-model, batch 1) — a course's multiple levels, each with its own
 * fee. Levels live in the `course_level` table (migration 091), keyed by course_id. A course
 * with zero levels keeps its single course-level fee (m_course.meta.fee = "Standard Fee") —
 * backward compatible. code == the level label (A1, A2, …) from the course_level_def catalog.
 *
 * fee_minor is PAISE — the same minor-unit convention the enrolment/fee stack uses, so batch-2
 * reads a level's fee straight into gross_fee_minor. The API accepts either `fee_minor` (paise)
 * or `fee` (rupees, converted here), so the front-end can send the plain rupee amount it collects.
 *
 * Writes are a REPLACE-ALL sync (delete the course's levels, insert the new set) inside one
 * transaction — atomic, and the (course_id, lower(code)) unique index always holds.
 */

export interface CourseLevelInput {
  code?: string;
  label?: string;
  fee_minor?: number | string;
  fee?: number | string; // rupees (alternative to fee_minor)
  exam_fee_minor?: number | string;
  exam_fee?: number | string; // rupees (alternative to exam_fee_minor) — dev/140 item 3
  duration?: string;
  ordering?: number;
}

export interface CourseLevel {
  code: string;
  label: string | null;
  fee_minor: number;
  exam_fee_minor: number;
  duration: string | null;
  ordering: number;
}

/** Validate + normalise the incoming levels: non-empty unique codes, fee >= 0, ordered. */
export function normaliseLevels(input: unknown): CourseLevel[] {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new BadRequestException('levels must be an array');
  const out: CourseLevel[] = [];
  const seen = new Set<string>();
  input.forEach((raw, i) => {
    const r = (raw ?? {}) as CourseLevelInput;
    const code = String(r.code ?? r.label ?? '').trim();
    if (!code) throw new BadRequestException(`Level #${i + 1}: a level code/label is required`);
    const key = code.toLowerCase();
    if (seen.has(key)) throw new BadRequestException(`Duplicate level code "${code}" — level codes must be unique within a course`);
    seen.add(key);
    let feeMinor: number;
    try {
      feeMinor = r.fee_minor != null && String(r.fee_minor).trim() !== ''
        ? Math.round(Number(r.fee_minor))
        : rupeesToMinor(r.fee ?? 0);
    } catch {
      throw new BadRequestException(`Level "${code}": fee is not a valid amount`);
    }
    if (!Number.isFinite(feeMinor) || feeMinor < 0) throw new BadRequestException(`Level "${code}": fee must be zero or more`);
    // EXAM FEE (dev/140 item 3) — optional per-level add-on; never discounted. Accepts paise or rupees.
    let examMinor: number;
    try {
      examMinor = r.exam_fee_minor != null && String(r.exam_fee_minor).trim() !== ''
        ? Math.round(Number(r.exam_fee_minor))
        : rupeesToMinor(r.exam_fee ?? 0);
    } catch {
      throw new BadRequestException(`Level "${code}": exam fee is not a valid amount`);
    }
    if (!Number.isFinite(examMinor) || examMinor < 0) throw new BadRequestException(`Level "${code}": exam fee must be zero or more`);
    const label = r.label != null && String(r.label).trim() !== '' ? String(r.label).trim() : code;
    const duration = r.duration != null && String(r.duration).trim() !== '' ? String(r.duration).trim() : null;
    const ordering = Number.isFinite(Number(r.ordering)) ? Number(r.ordering) : i;
    out.push({ code, label, fee_minor: feeMinor, exam_fee_minor: examMinor, duration, ordering });
  });
  return out;
}

@Injectable()
export class CourseLevelsService {
  constructor(private readonly db: DatabaseService) {}

  /** All active levels of a course, in display order. */
  list(courseId: number) {
    return this.db.query(
      `SELECT id, course_id, code, label, fee_minor, exam_fee_minor, duration, ordering, is_active
         FROM course_level
        WHERE course_id = $1::bigint AND is_active
        ORDER BY ordering, id`,
      [courseId],
    );
  }

  /**
   * Replace a course's levels with the given set (validated). Returns the stored rows.
   *
   * DEF-1 (dev/104): this is an UPSERT-BY-CODE sync, NOT a delete-all-then-insert. A plain
   * `DELETE FROM course_level` breaks when a level is already referenced by an existing
   * enrolment (`enrolment_level.course_level_id → course_level.id`, migration 092, no cascade):
   * Postgres raises a 23503 foreign-key violation ("... is still referenced from table
   * enrolment_level"), surfaced to the client as HTTP 400 when editing a course that already
   * has enrolled levels. We instead keep each existing row's id stable (so the enrolment FK
   * stays valid) — updating matched codes in place, inserting new codes, and for a level that
   * was removed from the form: HARD-delete it only when nothing references it, else SOFT-remove
   * it (is_active = FALSE) so the signed-up student's snapshot and FK survive. Matching is by
   * (course_id, lower(code)) — the same unique key the DB enforces — and includes inactive rows,
   * so re-adding a previously removed code reactivates it rather than colliding.
   */
  async replace(courseId: number, levels: unknown, actorId?: number): Promise<any[]> {
    const course = await this.db.one<{ id: string }>(
      `SELECT id FROM m_course WHERE id = $1::bigint AND deleted_at IS NULL`, [courseId]);
    if (!course) throw new NotFoundException(`course #${courseId} not found`);
    const clean = normaliseLevels(levels);
    const org = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    return this.db.tx(async (client) => {
      // Existing rows (active AND inactive) keyed by lower(code) so we upsert against the DB's
      // own unique key and can reactivate a code that was previously soft-removed.
      const existing = (await client.query(
        `SELECT id, lower(code) AS lc FROM course_level WHERE course_id = $1::bigint`, [courseId])).rows;
      const byCode = new Map<string, number>(existing.map((r: any) => [String(r.lc), Number(r.id)]));
      const keep = new Set<number>();
      const rows: any[] = [];
      for (let i = 0; i < clean.length; i++) {
        const l = clean[i];
        const existingId = byCode.get(l.code.toLowerCase());
        if (existingId != null) {
          // UPDATE in place — id (and thus every enrolment_level FK) is preserved.
          const res = await client.query(
            `UPDATE course_level
                SET code = $2, label = $3, fee_minor = $4, duration = $5, ordering = $6,
                    exam_fee_minor = $7, is_active = TRUE, updated_at = now()
              WHERE id = $1::bigint
             RETURNING id, course_id, code, label, fee_minor, exam_fee_minor, duration, ordering, is_active`,
            [existingId, l.code, l.label, l.fee_minor, l.duration, l.ordering ?? i, l.exam_fee_minor]);
          rows.push(res.rows[0]);
          keep.add(existingId);
        } else {
          const res = await client.query(
            `INSERT INTO course_level (org_id, course_id, code, label, fee_minor, duration, ordering, exam_fee_minor)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, course_id, code, label, fee_minor, exam_fee_minor, duration, ordering, is_active`,
            [Number(org!.id), courseId, l.code, l.label, l.fee_minor, l.duration, l.ordering ?? i, l.exam_fee_minor]);
          rows.push(res.rows[0]);
          keep.add(Number(res.rows[0].id));
        }
      }
      // Remove levels no longer in the form. Referenced rows are soft-removed (keep the FK +
      // the enrolled student's snapshot); unreferenced rows are hard-deleted.
      const removeIds = existing.map((r: any) => Number(r.id)).filter((id) => !keep.has(id));
      for (const id of removeIds) {
        const ref = await client.query(
          `SELECT 1 FROM enrolment_level WHERE course_level_id = $1::bigint LIMIT 1`, [id]);
        if (ref.rowCount && ref.rowCount > 0) {
          await client.query(`UPDATE course_level SET is_active = FALSE, updated_at = now() WHERE id = $1::bigint`, [id]);
        } else {
          await client.query(`DELETE FROM course_level WHERE id = $1::bigint`, [id]);
        }
      }
      return rows;
    });
  }
}
