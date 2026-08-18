-- =============================================================================
-- 091 — COURSE LEVELS (per-level fee)  [enrollment re-model, batch 1 of 3]
--
-- Client requirement: a course can have MANY levels, each with its OWN fee.
--   e.g. course "French" (code FR) → levels A1, A2, B1, B2, C1, C2, each with a fee.
-- Fee is PER LEVEL (client confirmed). A course with NO levels keeps a single
-- course-level fee (m_course.meta.fee, the existing "Standard Fee") — backward
-- compatible for every existing course. Duration stays a course-level field
-- (m_course.meta.duration); an OPTIONAL per-level duration is allowed here too.
--
-- Levels live in a real `course_level` table (not meta JSON) so batch-2 enrolment
-- can JOIN on them, look up each level's fee, and report per level. code == the
-- level label (A1, A2, …) picked from the course_level_def catalog (migration 082),
-- so the stored value, the dropdown option and the display string are all the same
-- human-readable text. fee_minor is PAISE (the same minor-unit convention the whole
-- enrolment/fee stack uses), so batch-2 reads it straight into gross_fee_minor.
--
-- BACKFILL: none — existing courses get ZERO levels and keep using meta.fee. No fake
-- data. Idempotent throughout (IF NOT EXISTS guards); the app writes levels via a
-- replace-all sync (DELETE + INSERT in one transaction), so the unique code index holds.
-- =============================================================================

CREATE TABLE IF NOT EXISTS course_level (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id     BIGINT NOT NULL REFERENCES organisation(id),
  course_id  BIGINT NOT NULL REFERENCES m_course(id) ON DELETE CASCADE,
  code       VARCHAR(64)  NOT NULL,               -- the level label/code, e.g. 'A1'
  label      VARCHAR(96)  NULL,                    -- optional display label (defaults to code)
  fee_minor  BIGINT       NOT NULL DEFAULT 0,      -- per-level fee in paise (>= 0)
  duration   TEXT         NULL,                    -- optional per-level duration (free text)
  ordering   INT          NOT NULL DEFAULT 0,      -- display / numbering order within the course
  is_active  BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Fast per-course fetch in ordering order (the GET /courses/:id/levels read + batch-2 joins).
CREATE INDEX IF NOT EXISTS idx_course_level_course
  ON course_level (course_id, ordering);

-- A level code is unique within a course (case-insensitive) — no duplicate A1 on the same course.
CREATE UNIQUE INDEX IF NOT EXISTS ux_course_level_course_code
  ON course_level (course_id, lower(code));
