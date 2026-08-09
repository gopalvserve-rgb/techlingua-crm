-- =============================================================================
-- 044 — STUDENTS & BATCHES (Phase 2 at the CRM level)
--
-- The client's three related requests, made real:
--   A) Convert a lead -> a STUDENT record (button), and win the lead (WON stage).
--   B) A Student dashboard computed from the students/enrolments/fees that exist.
--   C) A Batch bound to Branch -> Vertical -> Course (the module-audit fix).
--
-- HOW STUDENT RELATES TO ENROLMENT (read this before touching either).
--   Sprint 5 built `enrolment` — the SALE CLOSURE — and left two seam columns empty
--   on purpose: `enrolment.student_profile_id` and `enrolment.batch_id` (029 §"THE
--   SEAMS"). Phase 2 fills them. This migration:
--     * creates `student` (the student profile) and POINTS `enrolment.student_profile_id`
--       at it via a real FK — the enrolment is NOT copied or migrated; it already carries
--       the course, fee, plan, branch, vertical, counsellor and the lead it came from;
--     * creates `batch` and points `enrolment.batch_id` at it via a real FK.
--   A student can therefore exist from a WON lead WITH an enrolment (the normal path —
--   student.enrolment_id links back, enrolment.student_profile_id links forward) or from
--   a WON lead with NO enrolment yet (enrolment_id NULL — a desk that converts before it
--   raises the closure). One lead -> one live student (partial UNIQUE index), the mirror
--   of `uq_enrolment_lead`.
--
-- Idempotent throughout (IF NOT EXISTS / ON CONFLICT DO NOTHING / guarded FKs). Re-runnable.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) student — the STUDENT PROFILE (a converted, won lead).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS student (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         BIGINT NOT NULL REFERENCES organisation(id),
  student_no     VARCHAR(48) NULL,
  lead_id        BIGINT NOT NULL REFERENCES lead(id),
  enrolment_id   BIGINT NULL REFERENCES enrolment(id),
  full_name      VARCHAR(160) NOT NULL,
  phone          VARCHAR(32) NULL,
  email          VARCHAR(160) NULL,
  branch_id      BIGINT NOT NULL REFERENCES branch(id),
  vertical_id    BIGINT NOT NULL REFERENCES vertical(id),
  pipeline_id    BIGINT NULL REFERENCES pipeline(id),
  campaign_id    BIGINT NULL REFERENCES campaign(id),
  course_id      BIGINT NULL REFERENCES m_course(id),
  batch_id       BIGINT NULL,
  owner_id       BIGINT NULL REFERENCES "user"(id),
  team_id        BIGINT NULL REFERENCES team(id),
  status         VARCHAR(16) NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'inactive')),
  remarks        TEXT NULL,
  created_by     BIGINT NULL REFERENCES "user"(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ NULL,
  deleted_by     BIGINT NULL REFERENCES "user"(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_student_no ON student (org_id, student_no) WHERE student_no IS NOT NULL;
-- ONE LIVE STUDENT PER LEAD — the idempotency guarantee behind "Convert to Student".
-- A double-click, or a second press months later, links the existing student; it never
-- makes a second one. (Mirror of uq_enrolment_lead.)
CREATE UNIQUE INDEX IF NOT EXISTS uq_student_lead ON student (lead_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_student_scope   ON student (branch_id, vertical_id, owner_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_student_created ON student (created_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_student_course  ON student (course_id)  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_student_batch   ON student (batch_id)   WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2) batch — a class bound to Branch -> Vertical -> Course.
--     The client's audit finding: "Add Batch must ask Branch + Vertical." A batch
--     ALWAYS carries branch_id + vertical_id + course_id (all NOT NULL) so it can
--     never be created outside the hierarchy.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS batch (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         BIGINT NOT NULL REFERENCES organisation(id),
  batch_code     VARCHAR(48) NULL,
  name           VARCHAR(160) NOT NULL,
  branch_id      BIGINT NOT NULL REFERENCES branch(id),
  vertical_id    BIGINT NOT NULL REFERENCES vertical(id),
  course_id      BIGINT NOT NULL REFERENCES m_course(id),
  trainer_id     BIGINT NULL REFERENCES "user"(id),
  capacity       INT NOT NULL DEFAULT 0 CHECK (capacity >= 0),
  room           VARCHAR(80) NULL,
  schedule       VARCHAR(200) NULL,
  start_date     DATE NULL,
  end_date       DATE NULL,
  status         VARCHAR(16) NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'completed', 'cancelled')),
  remarks        TEXT NULL,
  created_by     BIGINT NULL REFERENCES "user"(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ NULL,
  deleted_by     BIGINT NULL REFERENCES "user"(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_batch_code ON batch (org_id, batch_code) WHERE deleted_at IS NULL AND batch_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_batch_scope  ON batch (branch_id, vertical_id, course_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_batch_created ON batch (created_at) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3) FILL THE SEAMS — enrolment.student_profile_id -> student, batch_id -> batch.
--     Both columns were created NULL and unused in 029 ("NOTHING in Phase 1 writes
--     either column"), so adding the FK now is safe. Guarded so re-run is a no-op.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_enrolment_student_profile') THEN
    ALTER TABLE enrolment
      ADD CONSTRAINT fk_enrolment_student_profile
      FOREIGN KEY (student_profile_id) REFERENCES student(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_enrolment_batch') THEN
    ALTER TABLE enrolment
      ADD CONSTRAINT fk_enrolment_batch
      FOREIGN KEY (batch_id) REFERENCES batch(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_student_batch') THEN
    ALTER TABLE student
      ADD CONSTRAINT fk_student_batch
      FOREIGN KEY (batch_id) REFERENCES batch(id);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4) Permissions — student.* and batch.* + role grants.
--     Mirrors enrolment's grant shape: managers/admins wide, counsellor 'own'.
--     'create' on student is what "Convert to Student" checks (the controller also
--     accepts enrolment.create as an alternative — a desk that can close a sale can
--     make the student it produces).
-- ---------------------------------------------------------------------------
INSERT INTO permission (key, module, action) VALUES
  ('student.read',   'student', 'read'),
  ('student.create', 'student', 'create'),
  ('student.update', 'student', 'update'),
  ('student.delete', 'student', 'delete'),
  ('batch.read',     'batch',   'read'),
  ('batch.create',   'batch',   'create'),
  ('batch.update',   'batch',   'update'),
  ('batch.delete',   'batch',   'delete')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('student.read',   'Super Admin',        'all'),
      ('student.read',   'Organization Admin', 'all'),
      ('student.read',   'Marketing Manager',  'all'),
      ('student.read',   'Branch Manager',     'branch'),
      ('student.read',   'Vertical Manager',   'vertical'),
      ('student.read',   'Team Leader',        'team'),
      ('student.read',   'Counsellor',         'own'),
      ('student.create', 'Super Admin',        'all'),
      ('student.create', 'Organization Admin', 'all'),
      ('student.create', 'Branch Manager',     'branch'),
      ('student.create', 'Vertical Manager',   'vertical'),
      ('student.create', 'Team Leader',        'team'),
      ('student.create', 'Counsellor',         'own'),
      ('student.update', 'Super Admin',        'all'),
      ('student.update', 'Organization Admin', 'all'),
      ('student.update', 'Branch Manager',     'branch'),
      ('student.update', 'Vertical Manager',   'vertical'),
      ('student.update', 'Team Leader',        'team'),
      ('student.update', 'Counsellor',         'own'),
      ('student.delete', 'Super Admin',        'all'),
      ('student.delete', 'Organization Admin', 'all'),

      ('batch.read',     'Super Admin',        'all'),
      ('batch.read',     'Organization Admin', 'all'),
      ('batch.read',     'Marketing Manager',  'all'),
      ('batch.read',     'Branch Manager',     'branch'),
      ('batch.read',     'Vertical Manager',   'vertical'),
      ('batch.create',   'Super Admin',        'all'),
      ('batch.create',   'Organization Admin', 'all'),
      ('batch.create',   'Branch Manager',     'branch'),
      ('batch.create',   'Vertical Manager',   'vertical'),
      ('batch.update',   'Super Admin',        'all'),
      ('batch.update',   'Organization Admin', 'all'),
      ('batch.update',   'Branch Manager',     'branch'),
      ('batch.update',   'Vertical Manager',   'vertical'),
      ('batch.delete',   'Super Admin',        'all'),
      ('batch.delete',   'Organization Admin', 'all')
    ) AS v(pkey, role_name, scope)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope
      FROM role ro, permission p
     WHERE ro.name = r.role_name AND p.key = r.pkey
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;
