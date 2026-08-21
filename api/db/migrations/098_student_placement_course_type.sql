-- ============================================================================
-- 098 — STUDENT PLACEMENT COURSE TYPE (dev/122, client: Student add/edit —
-- add a Course Type dropdown under the Placement section, sourced from the
-- manageable Course Type master (m_course_type / /api/masters/course_type,
-- migration 095) with the ＋Master quick-add. It ties a student's placement
-- preference to a course type.
--
-- Stored as the course-type LABEL text on the student (mirrors how a course
-- stores its type in m_course.meta->>'course_type'), so nothing needs a join.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.
-- ============================================================================

ALTER TABLE student ADD COLUMN IF NOT EXISTS placement_course_type VARCHAR(120);
