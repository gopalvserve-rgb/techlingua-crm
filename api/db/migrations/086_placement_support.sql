-- =============================================================================
-- 086 — PLACEMENT SUPPORT  (client feedback #14)
--
-- "Add a Placement Support module where we can post job openings and eligible
--  students can access this." Staff post JOB OPENINGS (scoped org > branch > vertical,
--  like the other academics entities); ELIGIBLE students can view them and APPLY; staff
--  track applications and advance their status.
--
--   1) job_opening — a posted job/internship. Scope cols (branch/vertical), employer, JD,
--      location, job_type, openings count, salary/stipend range (paise, optional), skills,
--      ELIGIBILITY (eligible_course_ids / eligible_vertical_ids + optional min_status like
--      'completed'), application deadline, status (open/closed/filled), optional JD file to R2.
--      ELIGIBILITY RULE (enforced in the student-facing service): a student can access an
--      opening when they hold an enrolment (not cancelled/withdrawn/dropped-out) whose course
--      is in eligible_course_ids (or that list is empty) AND whose vertical is in
--      eligible_vertical_ids (or that list is empty), AND -- when min_status is set -- that
--      enrolment's course_status equals min_status. Empty course+vertical lists => open to all
--      enrolled students.
--   2) placement_application — an eligible student's application to an opening
--      (applied/shortlisted/selected/rejected). UNIQUE(job_opening_id, student_id) makes
--      "apply" idempotent per student+job.
--
-- Permissions placement.* (+ placement_application.*) catalogued + granted (Academic Admin @
-- branch; Super Admin + Organization Admin @ all). Students access via the student-facing
-- /students/:id/placements path (guarded by student.read/update), never these staff perms.
-- FKs + indexes. Idempotent (IF NOT EXISTS / ON CONFLICT / guarded). Re-runnable.
-- =============================================================================

-- 1 -------------------------------------------------------------- job_opening (NEW)
CREATE TABLE IF NOT EXISTS job_opening (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id                BIGINT NOT NULL REFERENCES organisation(id),
  branch_id             BIGINT NOT NULL REFERENCES branch(id),
  vertical_id           BIGINT NOT NULL REFERENCES vertical(id),
  title                 VARCHAR(200) NOT NULL,
  employer              VARCHAR(200) NULL,
  description           TEXT NULL,
  location              VARCHAR(200) NULL,
  job_type              VARCHAR(20) NOT NULL DEFAULT 'full_time'
                          CHECK (job_type IN ('full_time','part_time','internship','contract')),
  openings              INT NOT NULL DEFAULT 1,
  salary_min_minor      BIGINT NULL,
  salary_max_minor      BIGINT NULL,
  skills                TEXT[] NULL,
  eligible_course_ids   BIGINT[] NULL,
  eligible_vertical_ids BIGINT[] NULL,
  min_status            VARCHAR(20) NULL,
  jd_r2_key             VARCHAR(400) NULL,
  deadline              DATE NULL,
  status                VARCHAR(12) NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open','closed','filled')),
  posted_by             BIGINT NULL REFERENCES "user"(id),
  created_by            BIGINT NULL REFERENCES "user"(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at            TIMESTAMPTZ NULL,
  deleted_by            BIGINT NULL REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS idx_jobopening_scope    ON job_opening (branch_id, vertical_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_jobopening_status   ON job_opening (status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_jobopening_deadline ON job_opening (deadline) WHERE deleted_at IS NULL;

-- 2 --------------------------------------------------------- placement_application (NEW)
CREATE TABLE IF NOT EXISTS placement_application (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          BIGINT NOT NULL REFERENCES organisation(id),
  job_opening_id  BIGINT NOT NULL REFERENCES job_opening(id),
  student_id      BIGINT NOT NULL REFERENCES student(id),
  status          VARCHAR(12) NOT NULL DEFAULT 'applied'
                    CHECK (status IN ('applied','shortlisted','selected','rejected')),
  applied_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  note            TEXT NULL,
  updated_by      BIGINT NULL REFERENCES "user"(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ NULL,
  deleted_by      BIGINT NULL REFERENCES "user"(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_placement_application ON placement_application (job_opening_id, student_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_placement_app_job     ON placement_application (job_opening_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_placement_app_student ON placement_application (student_id) WHERE deleted_at IS NULL;

-- 3 -------------------------------------------------------------- permissions
INSERT INTO permission (key, module, action) VALUES
  ('placement.read',                'placement',             'read'),
  ('placement.create',              'placement',             'create'),
  ('placement.update',              'placement',             'update'),
  ('placement.delete',              'placement',             'delete'),
  ('placement_application.read',    'placement_application', 'read'),
  ('placement_application.create',  'placement_application', 'create'),
  ('placement_application.update',  'placement_application', 'update'),
  ('placement_application.delete',  'placement_application', 'delete')
ON CONFLICT (key) DO NOTHING;

-- 3b ------------------------------------------------------------- role grants
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('placement.read',                'Academic Admin',     'branch'),
      ('placement.create',              'Academic Admin',     'branch'),
      ('placement.update',              'Academic Admin',     'branch'),
      ('placement.delete',              'Academic Admin',     'branch'),
      ('placement_application.read',    'Academic Admin',     'branch'),
      ('placement_application.create',  'Academic Admin',     'branch'),
      ('placement_application.update',  'Academic Admin',     'branch'),
      ('placement_application.delete',  'Academic Admin',     'branch'),
      ('placement.read',                'Super Admin',        'all'),
      ('placement.create',              'Super Admin',        'all'),
      ('placement.update',              'Super Admin',        'all'),
      ('placement.delete',              'Super Admin',        'all'),
      ('placement_application.read',    'Super Admin',        'all'),
      ('placement_application.create',  'Super Admin',        'all'),
      ('placement_application.update',  'Super Admin',        'all'),
      ('placement_application.delete',  'Super Admin',        'all'),
      ('placement.read',                'Organization Admin', 'all'),
      ('placement.create',              'Organization Admin', 'all'),
      ('placement.update',              'Organization Admin', 'all'),
      ('placement.delete',              'Organization Admin', 'all'),
      ('placement_application.read',    'Organization Admin', 'all'),
      ('placement_application.create',  'Organization Admin', 'all'),
      ('placement_application.update',  'Organization Admin', 'all'),
      ('placement_application.delete',  'Organization Admin', 'all')
    ) AS v(pkey, role_name, scope)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope
      FROM role ro, permission p
     WHERE ro.name = r.role_name AND p.key = r.pkey
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;

-- 4 ---------------------------------------------------------------------- [DEMO] seed
DO $$
DECLARE
  v_org BIGINT;
  d_branch BIGINT; d_vertical BIGINT; d_course BIGINT;
BEGIN
  SELECT id INTO v_org FROM organisation ORDER BY id LIMIT 1;
  IF v_org IS NULL THEN RETURN; END IF;

  SELECT e.branch_id, e.vertical_id, e.course_id
    INTO d_branch, d_vertical, d_course
    FROM enrolment e
   WHERE e.deleted_at IS NULL AND e.course_id IS NOT NULL
   ORDER BY e.id LIMIT 1;

  IF d_course IS NULL THEN
    SELECT bt.branch_id, bt.vertical_id, bt.course_id INTO d_branch, d_vertical, d_course
      FROM batch bt WHERE bt.deleted_at IS NULL ORDER BY bt.id LIMIT 1;
  END IF;
  IF d_course IS NULL THEN
    SELECT b.id, v.id, c.id INTO d_branch, d_vertical, d_course
      FROM branch b
      JOIN vertical v ON v.branch_id = b.id AND v.deleted_at IS NULL
      JOIN m_course c ON c.deleted_at IS NULL
     WHERE b.deleted_at IS NULL ORDER BY b.id, v.id, c.id LIMIT 1;
  END IF;
  IF d_course IS NULL THEN RETURN; END IF;

  IF NOT EXISTS (SELECT 1 FROM job_opening WHERE title = '[DEMO] Junior Software Engineer') THEN
    INSERT INTO job_opening (org_id, branch_id, vertical_id, title, employer, description, location,
        job_type, openings, salary_min_minor, salary_max_minor, skills, eligible_course_ids,
        eligible_vertical_ids, min_status, deadline, status, posted_by)
    VALUES (v_org, d_branch, d_vertical, '[DEMO] Junior Software Engineer', 'Insta Infotech Pvt Ltd',
        'Entry-level software engineering role. Work on web applications with our product team.',
        'Pune', 'full_time', 3, 3000000, 6000000, ARRAY['JavaScript','React','SQL'],
        ARRAY[d_course]::BIGINT[], NULL, NULL, (CURRENT_DATE + INTERVAL '30 days')::date, 'open', NULL);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM job_opening WHERE title = '[DEMO] Language Trainer Internship') THEN
    INSERT INTO job_opening (org_id, branch_id, vertical_id, title, employer, description, location,
        job_type, openings, salary_min_minor, salary_max_minor, skills, eligible_course_ids,
        eligible_vertical_ids, min_status, deadline, status, posted_by)
    VALUES (v_org, d_branch, d_vertical, '[DEMO] Language Trainer Internship', 'British College of Language',
        'Internship for course completers -- assist senior trainers and run practice sessions.',
        'Mumbai', 'internship', 2, 1500000, 2500000, ARRAY['Communication','Teaching'],
        NULL, ARRAY[d_vertical]::BIGINT[], 'completed', (CURRENT_DATE + INTERVAL '45 days')::date, 'open', NULL);
  END IF;
END $$;
