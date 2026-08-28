-- =============================================================================
-- 115 — ENROLMENT COURSE TYPE (28aug, item 6)
-- The convert-to-student / new-enrolment flow now records the COURSE TYPE (the
-- m_course_type master from task #186 — Diploma / Certificate / …) on the
-- enrolment. Nullable; existing enrolments keep NULL (they still show their
-- course's master course_type where the UI needs it). Backfill from the course
-- master's meta so live rows display a value immediately.
-- =============================================================================
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS course_type VARCHAR(64) NULL;

UPDATE enrolment e
   SET course_type = c.meta->>'course_type'
  FROM m_course c
 WHERE e.course_id = c.id
   AND e.course_type IS NULL
   AND COALESCE(c.meta->>'course_type', '') <> '';
