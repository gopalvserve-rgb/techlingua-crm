-- =============================================================================
-- 047 — ERP ACADEMICS CORE (Phase 2, Batch 1)
--
-- Builds the four academic modules on top of the Phase-2 student + batch tables:
--   1) BATCH TRANSFER + WAITLIST — move a student between batches (history + audit),
--      respecting batch capacity; a full batch queues the student on a per-batch waitlist,
--      and a manual "promote" fills a freed seat.
--   2) ATTENDANCE — per-session (batch + date) marking Present/Absent/Late/Excused, by a
--      trainer/staff OR self (mode flag) OR a biometric feed (mode='biometric', posted to
--      the same /mark endpoint — see docs/dev/39). Absent => a parent-notification attempt.
--   3) TESTS & SCORES — a test per batch (type/max/pass) + per-student scores (grade %).
--   4) ASSIGNMENTS (coursework) — an assignment per batch (due date, attachment) + per-student
--      submissions (assigned/submitted/graded, marks + feedback).
--
-- Scope: attendance/test/coursework rows DENORMALISE branch_id + vertical_id (+ course_id)
-- from their batch, so the ScopeResolver filters them exactly like every other module. Batch
-- transfer/waitlist are gated by student.update (they move the student's batch assignment).
--
-- Idempotent throughout (IF NOT EXISTS / guarded / ON CONFLICT DO NOTHING). Re-runnable.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) batch_transfer — the HISTORY of a student's batch assignments/moves.
--     from_batch_id NULL = first assignment; to_batch_id NULL = removed from a batch.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS batch_transfer (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         BIGINT NOT NULL REFERENCES organisation(id),
  student_id     BIGINT NOT NULL REFERENCES student(id),
  from_batch_id  BIGINT NULL REFERENCES batch(id),
  to_batch_id    BIGINT NULL REFERENCES batch(id),
  reason         TEXT NULL,
  transferred_by BIGINT NULL REFERENCES "user"(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_batch_transfer_student ON batch_transfer (student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_batch_transfer_to      ON batch_transfer (to_batch_id);

-- ---------------------------------------------------------------------------
-- 2) batch_waitlist — an ORDERED per-batch queue when a batch is at capacity.
--     One live 'waiting' row per (batch, student). promote -> status 'promoted'.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS batch_waitlist (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       BIGINT NOT NULL REFERENCES organisation(id),
  batch_id     BIGINT NOT NULL REFERENCES batch(id),
  student_id   BIGINT NOT NULL REFERENCES student(id),
  position     INT NOT NULL DEFAULT 0,
  status       VARCHAR(16) NOT NULL DEFAULT 'waiting'
                 CHECK (status IN ('waiting', 'promoted', 'removed')),
  note         TEXT NULL,
  created_by   BIGINT NULL REFERENCES "user"(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  promoted_at  TIMESTAMPTZ NULL,
  promoted_by  BIGINT NULL REFERENCES "user"(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_waitlist_live ON batch_waitlist (batch_id, student_id) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS idx_waitlist_batch ON batch_waitlist (batch_id, position) WHERE status = 'waiting';

-- ---------------------------------------------------------------------------
-- 3) attendance — one row per (batch, student, session_date).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES organisation(id),
  batch_id      BIGINT NOT NULL REFERENCES batch(id),
  student_id    BIGINT NOT NULL REFERENCES student(id),
  branch_id     BIGINT NOT NULL REFERENCES branch(id),
  vertical_id   BIGINT NOT NULL REFERENCES vertical(id),
  session_date  DATE NOT NULL,
  status        VARCHAR(12) NOT NULL DEFAULT 'present'
                  CHECK (status IN ('present', 'absent', 'late', 'excused')),
  mode          VARCHAR(12) NOT NULL DEFAULT 'staff'
                  CHECK (mode IN ('staff', 'self', 'biometric')),
  remarks       TEXT NULL,
  parent_notified BOOLEAN NOT NULL DEFAULT FALSE,
  marked_by     BIGINT NULL REFERENCES "user"(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ NULL,
  deleted_by    BIGINT NULL REFERENCES "user"(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_attendance_session ON attendance (batch_id, student_id, session_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_attendance_scope ON attendance (branch_id, vertical_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_attendance_batch_date ON attendance (batch_id, session_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_attendance_student ON attendance (student_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 4) assessment_test + assessment_score — tests and per-student scores.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assessment_test (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES organisation(id),
  batch_id      BIGINT NOT NULL REFERENCES batch(id),
  branch_id     BIGINT NOT NULL REFERENCES branch(id),
  vertical_id   BIGINT NOT NULL REFERENCES vertical(id),
  course_id     BIGINT NULL REFERENCES m_course(id),
  name          VARCHAR(160) NOT NULL,
  test_type     VARCHAR(24) NOT NULL DEFAULT 'quiz'
                  CHECK (test_type IN ('quiz', 'mock', 'exam', 'assignment', 'other')),
  test_date     DATE NULL,
  max_marks     NUMERIC(8,2) NOT NULL DEFAULT 100 CHECK (max_marks > 0),
  pass_marks    NUMERIC(8,2) NULL,
  remarks       TEXT NULL,
  status        VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by    BIGINT NULL REFERENCES "user"(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ NULL,
  deleted_by    BIGINT NULL REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS idx_test_scope ON assessment_test (branch_id, vertical_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_test_batch ON assessment_test (batch_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS assessment_score (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES organisation(id),
  test_id       BIGINT NOT NULL REFERENCES assessment_test(id),
  student_id    BIGINT NOT NULL REFERENCES student(id),
  marks_obtained NUMERIC(8,2) NULL,
  grade         VARCHAR(4) NULL,
  remarks       TEXT NULL,
  marked_by     BIGINT NULL REFERENCES "user"(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_score_test_student ON assessment_score (test_id, student_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_score_student ON assessment_score (student_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 5) coursework_assignment + coursework_submission.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS coursework_assignment (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES organisation(id),
  batch_id      BIGINT NOT NULL REFERENCES batch(id),
  branch_id     BIGINT NOT NULL REFERENCES branch(id),
  vertical_id   BIGINT NOT NULL REFERENCES vertical(id),
  course_id     BIGINT NULL REFERENCES m_course(id),
  title         VARCHAR(200) NOT NULL,
  description   TEXT NULL,
  due_date      DATE NULL,
  attachment_url VARCHAR(500) NULL,
  max_marks     NUMERIC(8,2) NULL,
  status        VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by    BIGINT NULL REFERENCES "user"(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ NULL,
  deleted_by    BIGINT NULL REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS idx_assignment_scope ON coursework_assignment (branch_id, vertical_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_assignment_batch ON coursework_assignment (batch_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS coursework_submission (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES organisation(id),
  assignment_id BIGINT NOT NULL REFERENCES coursework_assignment(id),
  student_id    BIGINT NOT NULL REFERENCES student(id),
  status        VARCHAR(16) NOT NULL DEFAULT 'assigned'
                  CHECK (status IN ('assigned', 'submitted', 'graded')),
  submission_url VARCHAR(500) NULL,
  submitted_at  TIMESTAMPTZ NULL,
  marks         NUMERIC(8,2) NULL,
  feedback      TEXT NULL,
  graded_by     BIGINT NULL REFERENCES "user"(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_submission_student ON coursework_submission (assignment_id, student_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_submission_student ON coursework_submission (student_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 6) Permissions — attendance.* / test.* / coursework.* + role grants.
--     (Batch transfer + waitlist reuse student.update, so no new batch action.)
-- ---------------------------------------------------------------------------
INSERT INTO permission (key, module, action) VALUES
  ('attendance.read',   'attendance', 'read'),
  ('attendance.mark',   'attendance', 'mark'),
  ('attendance.manage', 'attendance', 'manage'),
  ('test.read',         'test', 'read'),
  ('test.create',       'test', 'create'),
  ('test.update',       'test', 'update'),
  ('test.delete',       'test', 'delete'),
  ('test.grade',        'test', 'grade'),
  ('coursework.read',   'coursework', 'read'),
  ('coursework.create', 'coursework', 'create'),
  ('coursework.update', 'coursework', 'update'),
  ('coursework.delete', 'coursework', 'delete'),
  ('coursework.grade',  'coursework', 'grade')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- attendance
      ('attendance.read',   'Super Admin',        'all'),
      ('attendance.read',   'Organization Admin', 'all'),
      ('attendance.read',   'Branch Manager',     'branch'),
      ('attendance.read',   'Vertical Manager',   'vertical'),
      ('attendance.read',   'Team Leader',        'team'),
      ('attendance.read',   'Counsellor',         'own'),
      ('attendance.mark',   'Super Admin',        'all'),
      ('attendance.mark',   'Organization Admin', 'all'),
      ('attendance.mark',   'Branch Manager',     'branch'),
      ('attendance.mark',   'Vertical Manager',   'vertical'),
      ('attendance.mark',   'Team Leader',        'team'),
      ('attendance.mark',   'Counsellor',         'own'),
      ('attendance.manage', 'Super Admin',        'all'),
      ('attendance.manage', 'Organization Admin', 'all'),
      ('attendance.manage', 'Branch Manager',     'branch'),
      -- tests & scores
      ('test.read',   'Super Admin',        'all'),
      ('test.read',   'Organization Admin', 'all'),
      ('test.read',   'Branch Manager',     'branch'),
      ('test.read',   'Vertical Manager',   'vertical'),
      ('test.read',   'Team Leader',        'team'),
      ('test.read',   'Counsellor',         'own'),
      ('test.create', 'Super Admin',        'all'),
      ('test.create', 'Organization Admin', 'all'),
      ('test.create', 'Branch Manager',     'branch'),
      ('test.create', 'Vertical Manager',   'vertical'),
      ('test.create', 'Team Leader',        'team'),
      ('test.create', 'Counsellor',         'own'),
      ('test.update', 'Super Admin',        'all'),
      ('test.update', 'Organization Admin', 'all'),
      ('test.update', 'Branch Manager',     'branch'),
      ('test.update', 'Vertical Manager',   'vertical'),
      ('test.update', 'Counsellor',         'own'),
      ('test.delete', 'Super Admin',        'all'),
      ('test.delete', 'Organization Admin', 'all'),
      ('test.delete', 'Branch Manager',     'branch'),
      ('test.grade',  'Super Admin',        'all'),
      ('test.grade',  'Organization Admin', 'all'),
      ('test.grade',  'Branch Manager',     'branch'),
      ('test.grade',  'Vertical Manager',   'vertical'),
      ('test.grade',  'Team Leader',        'team'),
      ('test.grade',  'Counsellor',         'own'),
      -- coursework / assignments
      ('coursework.read',   'Super Admin',        'all'),
      ('coursework.read',   'Organization Admin', 'all'),
      ('coursework.read',   'Branch Manager',     'branch'),
      ('coursework.read',   'Vertical Manager',   'vertical'),
      ('coursework.read',   'Team Leader',        'team'),
      ('coursework.read',   'Counsellor',         'own'),
      ('coursework.create', 'Super Admin',        'all'),
      ('coursework.create', 'Organization Admin', 'all'),
      ('coursework.create', 'Branch Manager',     'branch'),
      ('coursework.create', 'Vertical Manager',   'vertical'),
      ('coursework.create', 'Team Leader',        'team'),
      ('coursework.create', 'Counsellor',         'own'),
      ('coursework.update', 'Super Admin',        'all'),
      ('coursework.update', 'Organization Admin', 'all'),
      ('coursework.update', 'Branch Manager',     'branch'),
      ('coursework.update', 'Vertical Manager',   'vertical'),
      ('coursework.update', 'Counsellor',         'own'),
      ('coursework.delete', 'Super Admin',        'all'),
      ('coursework.delete', 'Organization Admin', 'all'),
      ('coursework.delete', 'Branch Manager',     'branch'),
      ('coursework.grade',  'Super Admin',        'all'),
      ('coursework.grade',  'Organization Admin', 'all'),
      ('coursework.grade',  'Branch Manager',     'branch'),
      ('coursework.grade',  'Vertical Manager',   'vertical'),
      ('coursework.grade',  'Team Leader',        'team'),
      ('coursework.grade',  'Counsellor',         'own')
    ) AS v(pkey, role_name, scope)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope
      FROM role ro, permission p
     WHERE ro.name = r.role_name AND p.key = r.pkey
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;
