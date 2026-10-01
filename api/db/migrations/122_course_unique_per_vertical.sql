-- ============================================================================
-- 122 — COURSE NAME / CODE UNIQUE PER BRANCH › VERTICAL (client feedback, Oct 2026)
--
-- "Branch and Vertical should be multi-select at the time of course creation."
-- A course still BELONGS to one Branch → one Vertical (meta.branch_id / meta.vertical_id), so
-- creating a course for several verticals creates the same course once under each of them.
-- Migration 008 made an ACTIVE course name and code unique across the WHOLE organisation,
-- which rejects the second copy with a 409. Uniqueness is now scoped to the course's own
-- Branch › Vertical: the same name/code may exist under different verticals, but never twice
-- under the same one.
--
-- Idempotent. No data is changed — every existing course already satisfies the narrower rule.
-- ============================================================================
DROP INDEX IF EXISTS uq_m_course_active_name;
DROP INDEX IF EXISTS uq_m_course_active_code;

CREATE UNIQUE INDEX IF NOT EXISTS uq_m_course_active_name_bv
  ON m_course (org_id, COALESCE(meta->>'branch_id', ''), COALESCE(meta->>'vertical_id', ''), lower(name))
  WHERE is_active;

CREATE UNIQUE INDEX IF NOT EXISTS uq_m_course_active_code_bv
  ON m_course (org_id, COALESCE(meta->>'branch_id', ''), COALESCE(meta->>'vertical_id', ''), lower(code))
  WHERE is_active AND code IS NOT NULL;
