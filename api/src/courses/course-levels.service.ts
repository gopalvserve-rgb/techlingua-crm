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
  duration?: string;
  ordering?: number;
}

export interface CourseLevel {
  code: string;
  label: string | null;
  fee_minor: number;
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
    const label = r.label != null && String(r.label).trim() !== '' ? String(r.label).trim() : code;
    const duration = r.duration != null && String(r.duration).trim() !== '' ? String(r.duration).trim() : null;
    const ordering = Number.isFinite(Number(r.ordering)) ? Number(r.ordering) : i;
    out.push({ code, label, fee_minor: feeMinor, duration, ordering });
  });
  return out;
}

@Injectable()
export class CourseLevelsService {
  constructor(private readonly db: DatabaseService) {}

  /** All active levels of a course, in display order. */
  list(courseId: number) {
    return this.db.query(
      `SELECT id, course_id, code, label, fee_minor, duration, ordering, is_active
         FROM course_level
        WHERE course_id = $1::bigint AND is_active
        ORDER BY ordering, id`,
      [courseId],
    );
  }

  /** Replace a course's levels with the given set (validated). Returns the stored rows. */
  async replace(courseId: number, levels: unknown, actorId?: number): Promise<any[]> {
    const course = await this.db.one<{ id: string }>(
      `SELECT id FROM m_course WHERE id = $1::bigint AND deleted_at IS NULL`, [courseId]);
    if (!course) throw new NotFoundException(`course #${courseId} not found`);
    const clean = normaliseLevels(levels);
    const org = await this.db.one<{ id: string }>(`SELECT id FROM organisation ORDER BY id LIMIT 1`);
    return this.db.tx(async (client) => {
      await client.query(`DELETE FROM course_level WHERE course_id = $1::bigint`, [courseId]);
      const rows: any[] = [];
      for (let i = 0; i < clean.length; i++) {
        const l = clean[i];
        const res = await client.query(
          `INSERT INTO course_level (org_id, course_id, code, label, fee_minor, duration, ordering)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, course_id, code, label, fee_minor, duration, ordering, is_active`,
          [Number(org!.id), courseId, l.code, l.label, l.fee_minor, l.duration, l.ordering ?? i],
        );
        rows.push(res.rows[0]);
      }
      return rows;
    });
  }
}
