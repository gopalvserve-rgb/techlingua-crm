-- =============================================================================
-- 084 — ENROLMENT COURSE TRANSFER (client feedback #8)
--
-- "Add a course transfer option for a student's enrolled course."
--
-- A student holds MANY course enrolments (074). This adds the history trail for MOVING a
-- single enrolment from one COURSE to another — the per-course sibling of the student BRANCH
-- transfer (062 `student_transfer`) and the batch transfer (047). The move re-points
-- enrolment.course_id (+ optionally branch/vertical) and recomputes the fee from the target
-- Course master; payments already made are preserved (outstanding recomputes). Each move lands
-- ONE row here. The enrolment KEEPS its identity + per-course status + admission stage — only
-- the course (and its fee) change.
--
-- from_* may be NULL (defensive); to_course is always set. Fee snapshots (gross/net, before +
-- after) are kept for audit. Idempotent + re-runnable (IF NOT EXISTS guards).
-- =============================================================================

CREATE TABLE IF NOT EXISTS enrolment_course_transfer (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id               BIGINT NOT NULL REFERENCES organisation(id),
  enrolment_id         BIGINT NOT NULL REFERENCES enrolment(id),
  student_id           BIGINT NULL REFERENCES student(id),
  from_course_id       BIGINT NULL REFERENCES m_course(id),
  to_course_id         BIGINT NOT NULL REFERENCES m_course(id),
  from_branch_id       BIGINT NULL REFERENCES branch(id),
  to_branch_id         BIGINT NULL REFERENCES branch(id),
  from_vertical_id     BIGINT NULL REFERENCES vertical(id),
  to_vertical_id       BIGINT NULL REFERENCES vertical(id),
  from_batch_id        BIGINT NULL REFERENCES batch(id),
  to_batch_id          BIGINT NULL REFERENCES batch(id),
  from_gross_fee_minor BIGINT NULL,
  to_gross_fee_minor   BIGINT NULL,
  from_net_fee_minor   BIGINT NULL,
  to_net_fee_minor     BIGINT NULL,
  reason               TEXT NULL,
  transferred_by       BIGINT NULL REFERENCES "user"(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_enrol_course_transfer_enrol
  ON enrolment_course_transfer (enrolment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_enrol_course_transfer_student
  ON enrolment_course_transfer (student_id, created_at DESC);
