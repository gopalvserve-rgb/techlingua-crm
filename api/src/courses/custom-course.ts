import { BadRequestException } from '@nestjs/common';

/**
 * CUSTOM COURSE (client 5 Nov, point 3: "Course field should be custom also"). An enrolment can
 * name a course that is not in the list: `custom_course_name` instead of `course_id`. The course
 * becomes a real Courses-master row under the enrolment's Branch › Vertical (meta.custom = true,
 * the typed fee as its standard fee), so every report, invoice and filter that reads course_id
 * keeps working. Typing a name that already exists there reuses that course instead of making a
 * twin (same rule as the unique index uq_m_course_active_name_bv).
 *
 * Runs under the ENROLMENT permission on purpose: a counsellor closing a sale need not have
 * Courses-master rights to enrol someone into a one-off course.
 * Returns the course id to use, or null when no custom course was asked for.
 */
export async function resolveCustomCourse(
  db: { one: (sql: string, params?: unknown[]) => Promise<any> },
  dto: any,
  ctx: { org_id: number; branch_id: number | null; vertical_id: number | null; fee_minor?: number | null; actor_id: number | null },
): Promise<number | null> {
  if (dto?.course_id != null && String(dto.course_id).trim() !== '' && String(dto.course_id) !== '__custom') return null;
  const name = String(dto?.custom_course_name ?? '').replace(/\s+/g, ' ').trim();
  if (!name) return null;
  if (name.length < 2) throw new BadRequestException('Type the custom course name.');
  if (name.length > 120) throw new BadRequestException('The custom course name is too long (120 characters at most).');
  if (ctx.vertical_id == null) throw new BadRequestException('A custom course needs the enrolment vertical.');

  // the caller's row may not carry org_id: there is one organisation per database
  const orgId = Number.isFinite(Number(ctx.org_id)) && Number(ctx.org_id) > 0
    ? Number(ctx.org_id) : Number((await db.one(`SELECT id FROM organisation ORDER BY id LIMIT 1`))?.id);
  const b = ctx.branch_id != null ? String(ctx.branch_id) : '';
  const v = String(ctx.vertical_id);
  const existing = await db.one(
    `SELECT id FROM m_course
      WHERE org_id = $1::bigint AND is_active AND deleted_at IS NULL AND lower(name) = lower($2)
        AND COALESCE(meta->>'branch_id', '') = $3 AND COALESCE(meta->>'vertical_id', '') = $4
      ORDER BY id LIMIT 1`, [orgId, name, b, v]);
  if (existing) return Number(existing.id);

  const fee = ctx.fee_minor != null && Number(ctx.fee_minor) > 0 ? (Number(ctx.fee_minor) / 100).toFixed(2).replace(/\.00$/, '') : undefined;
  const row = await db.one(
    `INSERT INTO m_course (org_id, name, meta, created_by)
     VALUES ($1::bigint, $2, $3::jsonb, $4)
     RETURNING id`,
    [orgId, name, JSON.stringify({
      ...(ctx.branch_id != null ? { branch_id: Number(ctx.branch_id) } : {}),
      vertical_id: Number(ctx.vertical_id),
      ...(fee ? { fee } : {}),
      custom: true,
    }), ctx.actor_id]);
  return Number(row!.id);
}
