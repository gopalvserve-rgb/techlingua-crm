-- =============================================================================
-- 074 — PER-ENROLMENT (per-course) STATUS
--
-- Client spec: a student carries ONE overall lifecycle status (073), but EACH course
-- enrolment now carries its OWN status. A student can be Active overall yet have French A1
-- Completed and French A2 Active. This mirrors the student-status lifecycle (073) at the
-- ENROLMENT level, reusing the SAME `student_status_def` catalog for labels + LMS access so
-- there is ONE taxonomy:
--   1) enrolment.course_status  -> references student_status_def(code) (default 'active';
--      existing cancelled enrolments backfilled to 'cancelled'), + the same metadata block
--      (reason, last-attendance, effective date, outstanding paise snapshot, approver, changer).
--   2) enrolment_status_history — the per-enrolment transition trail (mirror of
--      student_status_history, keyed by enrolment_id + student_id + course_id).
--   3) enrolment.lead_id relaxed to NULL and the `uq_enrolment_lead` idempotency guard scoped
--      to the PRE-CONVERSION stage only (student_profile_id IS NULL), so a converted student
--      may hold MULTIPLE course enrolments while a lead still enrols ONCE at the sale desk.
-- Reuses permission `student.status_manage` (073) for the SENSITIVE enrolment statuses — no new
-- permission. Idempotent throughout (IF NOT EXISTS / guarded / ON CONFLICT). Re-runnable.
-- =============================================================================

-- 1 ------------------------------------------------ per-enrolment status + metadata
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS course_status                     VARCHAR(24) NOT NULL DEFAULT 'active';
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS course_status_reason              TEXT NULL;
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS course_status_last_attendance_date DATE NULL;
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS course_status_effective_date      DATE NULL;
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS course_status_outstanding_minor   BIGINT NULL;
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS course_status_approved_by         BIGINT NULL REFERENCES "user"(id);
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS course_status_changed_by          BIGINT NULL REFERENCES "user"(id);
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS course_status_changed_at          TIMESTAMPTZ NULL;

-- Backfill: an enrolment whose SALE status is already cancelled should read as course cancelled;
-- everything else keeps the 'active' default. Any non-catalog value falls back to 'active'.
UPDATE enrolment SET course_status = 'cancelled'
 WHERE status = 'cancelled' AND (course_status IS NULL OR course_status = 'active');
UPDATE enrolment SET course_status = 'active'
 WHERE course_status IS NULL OR course_status NOT IN (SELECT code FROM student_status_def);

-- Catalog FK (added after rows are conformed).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'enrolment_course_status_fk') THEN
    ALTER TABLE enrolment
      ADD CONSTRAINT enrolment_course_status_fk FOREIGN KEY (course_status) REFERENCES student_status_def(code);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_enrolment_course_status ON enrolment (course_status) WHERE deleted_at IS NULL;

-- 2 ------------------------------------------------ the per-enrolment transition history
CREATE TABLE IF NOT EXISTS enrolment_status_history (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id               BIGINT NOT NULL REFERENCES organisation(id),
  branch_id            BIGINT NULL REFERENCES branch(id),
  vertical_id          BIGINT NULL REFERENCES vertical(id),
  enrolment_id         BIGINT NOT NULL REFERENCES enrolment(id),
  student_id           BIGINT NULL REFERENCES student(id),
  course_id            BIGINT NULL REFERENCES m_course(id),
  from_status          VARCHAR(24) NULL,
  to_status            VARCHAR(24) NOT NULL,
  reason               TEXT NULL,
  last_attendance_date DATE NULL,
  effective_date       DATE NULL,
  outstanding_minor    BIGINT NULL,
  approved_by          BIGINT NULL REFERENCES "user"(id),
  changed_by           BIGINT NULL REFERENCES "user"(id),
  changed_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_enrol_status_hist_enrol ON enrolment_status_history (enrolment_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_enrol_status_hist_student ON enrolment_status_history (student_id, changed_at DESC);

-- 3 ------------------------------------------------ allow a student to hold MULTIPLE enrolments
-- A student enrols in several courses, so the "one enrolment per lead" idempotency guard must
-- apply only to the SALE-DESK stage (before a student profile exists). Once the enrolment is
-- linked to a student (student_profile_id set — that happens at conversion), further course
-- enrolments are allowed. A directly-admitted (lead-less) student needs a NULL lead_id.
ALTER TABLE enrolment ALTER COLUMN lead_id DROP NOT NULL;
DROP INDEX IF EXISTS uq_enrolment_lead;
CREATE UNIQUE INDEX IF NOT EXISTS uq_enrolment_lead ON enrolment (lead_id)
  WHERE deleted_at IS NULL AND status <> 'cancelled' AND status <> 'rejected'
    AND student_profile_id IS NULL AND lead_id IS NOT NULL;

-- 4 --------------------------------- [DEMO] seed: the "Rahul" example (idempotent, guarded)
-- Give ONE existing [DEMO] student a SECOND enrolment in the SAME vertical so the Course
-- Enrollment section + per-course independence are demonstrable out of the box: enrolment #1
-- (the original) -> COMPLETED, a fresh enrolment #2 (a different course in the same vertical)
-- -> ACTIVE. Overall student status stays whatever it is (independent). Acts only on a [DEMO]
-- student (never Subash) that has a linked enrolment and does NOT already have a 2nd one.
DO $$
DECLARE
  v_admin  BIGINT;
  v_org    BIGINT;
  v_stu    BIGINT;
  v_enr1   BIGINT;
  v_branch BIGINT;
  v_vert   BIGINT;
  v_course2 BIGINT;
  v_lead   BIGINT;
  v_enr2   BIGINT;
  v_no     TEXT;
BEGIN
  SELECT id FROM organisation ORDER BY id LIMIT 1 INTO v_org;
  SELECT id FROM "user" WHERE deleted_at IS NULL ORDER BY id LIMIT 1 INTO v_admin;

  SELECT s.id, s.enrolment_id, s.branch_id, s.vertical_id, s.lead_id
    FROM student s
   WHERE s.full_name LIKE '[DEMO]%' AND s.full_name NOT ILIKE '%subash%'
     AND s.deleted_at IS NULL AND s.enrolment_id IS NOT NULL
     AND (SELECT count(*) FROM enrolment e
            WHERE e.deleted_at IS NULL
              AND (e.student_profile_id = s.id OR e.id = s.enrolment_id)) = 1
   ORDER BY s.id LIMIT 1
   INTO v_stu, v_enr1, v_branch, v_vert, v_lead;

  IF v_stu IS NOT NULL THEN
    UPDATE enrolment SET course_status = 'completed',
        course_status_reason = '[DEMO] Level A1 completed',
        course_status_effective_date = (now() AT TIME ZONE 'Asia/Kolkata')::date,
        course_status_outstanding_minor = 0,
        course_status_changed_by = v_admin, course_status_changed_at = now(), updated_at = now()
      WHERE id = v_enr1 AND course_status = 'active';
    IF FOUND THEN
      INSERT INTO enrolment_status_history (org_id, branch_id, vertical_id, enrolment_id, student_id, course_id,
          from_status, to_status, reason, effective_date, outstanding_minor, changed_by)
      SELECT v_org, e.branch_id, e.vertical_id, e.id, v_stu, e.course_id,
          'active', 'completed', '[DEMO] Level A1 completed', (now() AT TIME ZONE 'Asia/Kolkata')::date, 0, v_admin
        FROM enrolment e WHERE e.id = v_enr1;
    END IF;

    SELECT c.id FROM m_course c
      JOIN batch b ON b.course_id = c.id AND b.vertical_id = v_vert AND b.deleted_at IS NULL
     WHERE c.deleted_at IS NULL AND c.id <> (SELECT course_id FROM enrolment WHERE id = v_enr1)
     ORDER BY c.id LIMIT 1 INTO v_course2;
    IF v_course2 IS NULL THEN
      SELECT course_id FROM enrolment WHERE id = v_enr1 INTO v_course2;
    END IF;

    SELECT 'ENR-DEMO-' || v_stu INTO v_no;
    IF NOT EXISTS (SELECT 1 FROM enrolment WHERE enrolment_no = v_no) THEN
      INSERT INTO enrolment (org_id, enrolment_no, lead_id, branch_id, vertical_id, course_id,
          student_profile_id, fee_minor, discount_minor, net_fee_minor, payment_plan,
          start_date, status, course_status, remarks, created_by)
      VALUES (v_org, v_no, v_lead, v_branch, v_vert, v_course2,
          v_stu, 3000000, 0, 3000000, 'full',
          (now() AT TIME ZONE 'Asia/Kolkata')::date, 'active', 'active', '[DEMO] Second course enrolment', v_admin)
      RETURNING id INTO v_enr2;
      INSERT INTO enrolment_status_history (org_id, branch_id, vertical_id, enrolment_id, student_id, course_id,
          from_status, to_status, reason, effective_date, outstanding_minor, changed_by)
      VALUES (v_org, v_branch, v_vert, v_enr2, v_stu, v_course2,
          NULL, 'active', '[DEMO] Second course enrolment', (now() AT TIME ZONE 'Asia/Kolkata')::date, 3000000, v_admin);
    END IF;
  END IF;
END $$;
