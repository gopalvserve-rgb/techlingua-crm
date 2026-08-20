-- =============================================================================
-- 094 — DISCOUNT MASTER: LEVEL (optional) scope  [discount level-aware cap, dev/107]
--
-- Client requirement (extends dev/103): a discount rule scoped to a COURSE that has LEVELS
-- may be pinned to a SPECIFIC course-level (e.g. French A1 vs A2). The cap resolver becomes
-- most-specific-wins INCLUDING level:  course+level > course > vertical > branch > org default.
--
-- THE MODEL — one nullable column on discount_master:
--   * course_level_id -> course_level(id). NULL = "all levels of the course" (the existing
--     behaviour, unchanged for every current rule). A non-null value pins the cap to that one
--     level, and only applies when the enrolment being priced is on that (course, level).
--
-- A level scope is only meaningful alongside a course scope (a level belongs to a course);
-- the app never stores a level without its course. ON DELETE is left to the FK default
-- (RESTRICT) -- the course-level replace-all sync soft-removes referenced levels (dev/104), so
-- a level a discount rule points at is never hard-deleted out from under it.
--
-- Purely additive + idempotent (IF NOT EXISTS). Backfill: NONE -- every existing rule keeps
-- course_level_id = NULL and resolves exactly as before.
-- =============================================================================

ALTER TABLE discount_master
  ADD COLUMN IF NOT EXISTS course_level_id BIGINT NULL REFERENCES course_level(id);

-- Fast scope resolution incl. level (mirrors idx_discount_master_scope).
CREATE INDEX IF NOT EXISTS idx_discount_master_level
  ON discount_master (org_id, course_id, course_level_id) WHERE deleted_at IS NULL;
