-- =============================================================================
-- 073 — STUDENT STATUS LIFECYCLE
--
-- Client spec sheet: a student now carries a lifecycle STATUS (11 of them) that drives
-- their LMS access and, for the sensitive ones, demands a reason + dates + an approver +
-- a snapshot of their outstanding fee. This lays:
--   1) student_status_def — a seeded, self-manageable CATALOG of the 11 statuses (label,
--      meaning, lms_access, requires_reason/approval, is_terminal, ordering). India-first,
--      consistent with the other seeded masters.
--   2) student.status now references a catalog code (the existing active/inactive map across)
--      + current-status metadata (reason, last-attendance, effective date, outstanding paise
--      snapshot, approved_by, changed_by, changed_at).
--   3) student_status_history — the audit trail of every transition.
--   4) permission student.status_manage (catalogued + granted to Academic Admin / Org / Super
--      Admin) — the gate for the SENSITIVE statuses.
-- Idempotent throughout (IF NOT EXISTS / ON CONFLICT DO NOTHING / guarded). Re-runnable.
-- =============================================================================

-- 1 ------------------------------------------------ the status catalog + seed
CREATE TABLE IF NOT EXISTS student_status_def (
  code            VARCHAR(24) PRIMARY KEY,
  label           VARCHAR(48) NOT NULL,
  meaning         VARCHAR(200) NOT NULL,
  lms_access      VARCHAR(10) NOT NULL DEFAULT 'full'
                    CHECK (lms_access IN ('full','limited','none','alumni','depends')),
  requires_reason  BOOLEAN NOT NULL DEFAULT FALSE,
  requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
  is_terminal      BOOLEAN NOT NULL DEFAULT FALSE,
  ordering         INT NOT NULL DEFAULT 0
);

INSERT INTO student_status_def (code, label, meaning, lms_access, requires_reason, requires_approval, is_terminal, ordering) VALUES
  ('active',        'Active',        'Currently enrolled and studying',                 'full',    FALSE, FALSE, FALSE, 10),
  ('on_hold',       'On Hold',       'Temporarily paused with approval',                'limited', TRUE,  TRUE,  FALSE, 20),
  ('inactive',      'Inactive',      'No current academic activity',                    'limited', FALSE, FALSE, FALSE, 30),
  ('suspended',     'Suspended',     'Temporarily suspended by the institute',          'none',    TRUE,  TRUE,  FALSE, 40),
  ('withdrawn',     'Withdrawn',     'Student voluntarily left the course',             'none',    TRUE,  TRUE,  TRUE,  50),
  ('dropped_out',   'Dropped Out',   'Stopped attending without completing',            'none',    TRUE,  TRUE,  TRUE,  60),
  ('transferred',   'Transferred',   'Moved to another branch/course/batch',            'depends', FALSE, FALSE, FALSE, 70),
  ('completed',     'Completed',     'Successfully completed the course',               'alumni',  FALSE, FALSE, TRUE,  80),
  ('cancelled',     'Cancelled',     'Admission/enrolment cancelled',                   'none',    TRUE,  TRUE,  TRUE,  90),
  ('failed',        'Failed',        'Did not meet completion requirements',            'none',    FALSE, FALSE, TRUE,  100),
  ('course_expired','Course Expired','Course duration ended',                           'none',    FALSE, FALSE, TRUE,  110)
ON CONFLICT (code) DO NOTHING;

-- 2 ------------------------------------------------ student status + metadata
-- The 044 inline CHECK only allowed active/inactive; drop it so the catalog governs the set.
ALTER TABLE student DROP CONSTRAINT IF EXISTS student_status_check;
ALTER TABLE student ALTER COLUMN status TYPE VARCHAR(24);
-- Any legacy value that is not a catalog code falls back to 'active' (only active/inactive existed).
UPDATE student SET status = 'active'
 WHERE status IS NULL OR status NOT IN (SELECT code FROM student_status_def);

ALTER TABLE student ADD COLUMN IF NOT EXISTS status_reason               TEXT NULL;
ALTER TABLE student ADD COLUMN IF NOT EXISTS status_last_attendance_date DATE NULL;
ALTER TABLE student ADD COLUMN IF NOT EXISTS status_effective_date       DATE NULL;
ALTER TABLE student ADD COLUMN IF NOT EXISTS status_outstanding_minor    BIGINT NULL;
ALTER TABLE student ADD COLUMN IF NOT EXISTS status_approved_by          BIGINT NULL REFERENCES "user"(id);
ALTER TABLE student ADD COLUMN IF NOT EXISTS status_changed_by           BIGINT NULL REFERENCES "user"(id);
ALTER TABLE student ADD COLUMN IF NOT EXISTS status_changed_at           TIMESTAMPTZ NULL;

-- Catalog FK (added after the catalog is seeded + rows are conformed).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'student_status_fk') THEN
    ALTER TABLE student
      ADD CONSTRAINT student_status_fk FOREIGN KEY (status) REFERENCES student_status_def(code);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_student_status ON student (status) WHERE deleted_at IS NULL;

-- 3 ------------------------------------------------ the transition history
CREATE TABLE IF NOT EXISTS student_status_history (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id               BIGINT NOT NULL REFERENCES organisation(id),
  branch_id            BIGINT NULL REFERENCES branch(id),
  vertical_id          BIGINT NULL REFERENCES vertical(id),
  student_id           BIGINT NOT NULL REFERENCES student(id),
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
CREATE INDEX IF NOT EXISTS idx_student_status_hist_student ON student_status_history (student_id, changed_at DESC);

-- 4 ------------------------------------------------ the status_manage permission + grants
INSERT INTO permission (key, module, action) VALUES
  ('student.status_manage', 'student', 'status_manage')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('student.status_manage', 'Academic Admin',     'branch'),
      ('student.status_manage', 'Organization Admin', 'all'),
      ('student.status_manage', 'Super Admin',        'all')
    ) AS v(pkey, role_name, scope)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope
      FROM role ro, permission p
     WHERE ro.name = r.role_name AND p.key = r.pkey
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;

-- 5 --------------------------------- [DEMO] seed: make the lifecycle demonstrable
-- Set two EXISTING [DEMO] students (never Subash) to non-active statuses + a history row, so
-- the status filter, LMS enforcement and history are visible out of the box. Fully idempotent
-- (acts only on a still-'active' [DEMO] student that has no status history yet). No-ops if the
-- demo students are absent. The approver + changer is the seed admin (first org user).
DO $$
DECLARE
  v_admin   BIGINT;
  v_hold    BIGINT;
  v_done    BIGINT;
  v_org     BIGINT;
  v_out     BIGINT;
BEGIN
  SELECT id FROM organisation ORDER BY id LIMIT 1 INTO v_org;
  SELECT id FROM "user" WHERE deleted_at IS NULL ORDER BY id LIMIT 1 INTO v_admin;

  -- ON HOLD (limited access) — the first eligible [DEMO] student.
  SELECT id FROM student
    WHERE full_name LIKE '[DEMO]%' AND full_name NOT ILIKE '%subash%'
      AND status = 'active' AND deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM student_status_history h WHERE h.student_id = student.id)
    ORDER BY id LIMIT 1 INTO v_hold;
  IF v_hold IS NOT NULL THEN
    SELECT COALESCE(GREATEST(0, e.net_fee_minor - COALESCE((SELECT sum(fr.amount_minor) FROM fee_receipt fr WHERE fr.enrolment_id = e.id AND fr.deleted_at IS NULL),0)),0)
      FROM enrolment e WHERE e.id = (SELECT enrolment_id FROM student WHERE id = v_hold) INTO v_out;
    v_out := COALESCE(v_out, 0);
    UPDATE student SET status='on_hold', status_reason='[DEMO] Fees pending — paused with approval',
       status_last_attendance_date = (now() AT TIME ZONE 'Asia/Kolkata')::date - 14,
       status_effective_date = (now() AT TIME ZONE 'Asia/Kolkata')::date - 7,
       status_outstanding_minor = v_out, status_approved_by = v_admin,
       status_changed_by = v_admin, status_changed_at = now(), updated_at = now()
     WHERE id = v_hold;
    INSERT INTO student_status_history (org_id, branch_id, vertical_id, student_id, from_status, to_status,
        reason, last_attendance_date, effective_date, outstanding_minor, approved_by, changed_by)
    SELECT v_org, branch_id, vertical_id, v_hold, 'active', 'on_hold',
        '[DEMO] Fees pending — paused with approval',
        (now() AT TIME ZONE 'Asia/Kolkata')::date - 14, (now() AT TIME ZONE 'Asia/Kolkata')::date - 7,
        v_out, v_admin, v_admin
      FROM student WHERE id = v_hold;
  END IF;

  -- COMPLETED (alumni) — the next eligible [DEMO] student.
  SELECT id FROM student
    WHERE full_name LIKE '[DEMO]%' AND full_name NOT ILIKE '%subash%'
      AND status = 'active' AND deleted_at IS NULL AND id <> COALESCE(v_hold, -1)
      AND NOT EXISTS (SELECT 1 FROM student_status_history h WHERE h.student_id = student.id)
    ORDER BY id LIMIT 1 INTO v_done;
  IF v_done IS NOT NULL THEN
    UPDATE student SET status='completed', status_reason='[DEMO] Course completed successfully',
       status_effective_date = (now() AT TIME ZONE 'Asia/Kolkata')::date,
       status_outstanding_minor = 0, status_changed_by = v_admin,
       status_changed_at = now(), updated_at = now()
     WHERE id = v_done;
    INSERT INTO student_status_history (org_id, branch_id, vertical_id, student_id, from_status, to_status,
        reason, effective_date, outstanding_minor, changed_by)
    SELECT v_org, branch_id, vertical_id, v_done, 'active', 'completed',
        '[DEMO] Course completed successfully', (now() AT TIME ZONE 'Asia/Kolkata')::date, 0, v_admin
      FROM student WHERE id = v_done;
  END IF;
END $$;
