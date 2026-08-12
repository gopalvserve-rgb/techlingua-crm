-- =============================================================================
-- 065 — ASSESSMENT / TEST MODULE · BATCH C: ATTEMPTS, AUTO-SCORING, SUBMISSIONS,
--        FACULTY EVALUATION
--
-- Builds on Batch A (Question Bank, 063) and Batch B (Tests/Exams, 064). A student
-- TAKES a published test: an ATTEMPT freezes the exact question set it was served
-- (so scoring/review is stable even for randomised/pooled tests), autosaves answers,
-- and on submit the objective portion is AUTO-SCORED; subjective answers wait for a
-- faculty EVALUATION. An assignment/practical test may instead be satisfied by a FILE
-- SUBMISSION (PDF/DOC/DOCX/image) stored in Cloudflare R2 (r2_key only, never on disk).
--
--   1) assessment_attempt    — one student's run at a test (frozen set + scores + status).
--   2) attempt_answer         — per-question answer within an attempt.
--   3) assignment_submission  — a file answer for an assignment/practical test.
--   4) permissions + role grants (+ assessment.evaluate).
--   5) A guarded, clearly-marked [DEMO] seed. Idempotent throughout.
-- =============================================================================

-- 1 --------------------------------------------------------------- assessment_attempt
CREATE TABLE IF NOT EXISTS assessment_attempt (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             BIGINT NOT NULL REFERENCES organisation(id),
  branch_id          BIGINT NULL REFERENCES branch(id),
  vertical_id        BIGINT NULL REFERENCES vertical(id),
  pipeline_id        BIGINT NULL REFERENCES pipeline(id),
  team_id            BIGINT NULL REFERENCES team(id),
  assessment_id      BIGINT NOT NULL REFERENCES assessment(id),
  student_id         BIGINT NOT NULL REFERENCES student(id),
  attempt_no         INT NOT NULL DEFAULT 1 CHECK (attempt_no >= 1),
  status             VARCHAR(12) NOT NULL DEFAULT 'in_progress'
                       CHECK (status IN ('in_progress','submitted','evaluated','expired')),
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at       TIMESTAMPTZ NULL,
  due_at             TIMESTAMPTZ NULL,
  assembled          JSONB NOT NULL DEFAULT '[]',
  auto_score         NUMERIC(10,2) NULL,
  manual_score       NUMERIC(10,2) NULL,
  total_score        NUMERIC(10,2) NULL,
  max_score          NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (max_score >= 0),
  is_passed          BOOLEAN NULL,
  evaluated_by       BIGINT NULL REFERENCES "user"(id),
  evaluated_at       TIMESTAMPTZ NULL,
  created_by         BIGINT NULL REFERENCES "user"(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ NULL,
  deleted_by         BIGINT NULL REFERENCES "user"(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_attempt_no
  ON assessment_attempt (assessment_id, student_id, attempt_no) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_attempt_assessment ON assessment_attempt (assessment_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_attempt_student    ON assessment_attempt (student_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_attempt_status     ON assessment_attempt (status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_attempt_scope      ON assessment_attempt (branch_id, vertical_id) WHERE deleted_at IS NULL;

-- 2 ------------------------------------------------------------------- attempt_answer
CREATE TABLE IF NOT EXISTS attempt_answer (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  attempt_id         BIGINT NOT NULL REFERENCES assessment_attempt(id) ON DELETE CASCADE,
  question_id        BIGINT NOT NULL REFERENCES question(id),
  q_type             VARCHAR(20) NOT NULL,
  selected_option_ids BIGINT[] NOT NULL DEFAULT '{}',
  answer_text        TEXT NULL,
  file_r2_key        VARCHAR(400) NULL,
  is_correct         BOOLEAN NULL,
  awarded_marks      NUMERIC(8,2) NULL,
  evaluator_marks    NUMERIC(8,2) NULL,
  evaluator_feedback TEXT NULL,
  ordering           INT NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_attempt_answer ON attempt_answer (attempt_id, question_id);
CREATE INDEX IF NOT EXISTS idx_attempt_answer_attempt ON attempt_answer (attempt_id, ordering);

-- 3 -------------------------------------------------------------- assignment_submission
CREATE TABLE IF NOT EXISTS assignment_submission (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             BIGINT NOT NULL REFERENCES organisation(id),
  branch_id          BIGINT NULL REFERENCES branch(id),
  vertical_id        BIGINT NULL REFERENCES vertical(id),
  pipeline_id        BIGINT NULL REFERENCES pipeline(id),
  team_id            BIGINT NULL REFERENCES team(id),
  assessment_id      BIGINT NOT NULL REFERENCES assessment(id),
  student_id         BIGINT NOT NULL REFERENCES student(id),
  attempt_id         BIGINT NULL REFERENCES assessment_attempt(id),
  file_r2_key        VARCHAR(400) NOT NULL,
  original_filename  VARCHAR(240) NULL,
  mime               VARCHAR(120) NULL,
  size_bytes         BIGINT NULL,
  submitted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  status             VARCHAR(12) NOT NULL DEFAULT 'submitted'
                       CHECK (status IN ('submitted','evaluated','returned')),
  marks              NUMERIC(10,2) NULL,
  max_marks          NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (max_marks >= 0),
  is_passed          BOOLEAN NULL,
  feedback           TEXT NULL,
  evaluated_by       BIGINT NULL REFERENCES "user"(id),
  evaluated_at       TIMESTAMPTZ NULL,
  created_by         BIGINT NULL REFERENCES "user"(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ NULL,
  deleted_by         BIGINT NULL REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS idx_submission_assessment ON assignment_submission (assessment_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_submission_student    ON assignment_submission (student_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_submission_status     ON assignment_submission (status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_submission_scope      ON assignment_submission (branch_id, vertical_id) WHERE deleted_at IS NULL;

-- 4 ------------------------------------------------------------- permissions + grants
INSERT INTO permission (key, module, action) VALUES
  ('assessment.evaluate',           'assessment', 'evaluate'),
  ('assessment_attempt.read',       'assessment_attempt', 'read'),
  ('assessment_attempt.create',     'assessment_attempt', 'create'),
  ('assessment_attempt.update',     'assessment_attempt', 'update'),
  ('assessment_attempt.delete',     'assessment_attempt', 'delete'),
  ('assignment_submission.read',    'assignment_submission', 'read'),
  ('assignment_submission.create',  'assignment_submission', 'create'),
  ('assignment_submission.update',  'assignment_submission', 'update'),
  ('assignment_submission.delete',  'assignment_submission', 'delete')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('assessment.evaluate',          'Super Admin',          'all'),
      ('assessment.evaluate',          'Organization Admin',   'all'),
      ('assessment.evaluate',          'Academic Coordinator', 'branch'),
      ('assessment.evaluate',          'Trainer',              'branch'),
      ('assessment_attempt.read',      'Super Admin',          'all'),
      ('assessment_attempt.read',      'Organization Admin',   'all'),
      ('assessment_attempt.read',      'Academic Coordinator', 'branch'),
      ('assessment_attempt.read',      'Trainer',              'branch'),
      ('assessment_attempt.read',      'Branch Manager',       'branch'),
      ('assessment_attempt.read',      'Vertical Manager',     'vertical'),
      ('assessment_attempt.create',    'Super Admin',          'all'),
      ('assessment_attempt.create',    'Organization Admin',   'all'),
      ('assessment_attempt.create',    'Academic Coordinator', 'branch'),
      ('assessment_attempt.create',    'Trainer',              'branch'),
      ('assessment_attempt.update',    'Super Admin',          'all'),
      ('assessment_attempt.update',    'Organization Admin',   'all'),
      ('assessment_attempt.update',    'Academic Coordinator', 'branch'),
      ('assessment_attempt.update',    'Trainer',              'branch'),
      ('assessment_attempt.delete',    'Super Admin',          'all'),
      ('assessment_attempt.delete',    'Organization Admin',   'all'),
      ('assessment_attempt.delete',    'Academic Coordinator', 'branch'),
      ('assignment_submission.read',   'Super Admin',          'all'),
      ('assignment_submission.read',   'Organization Admin',   'all'),
      ('assignment_submission.read',   'Academic Coordinator', 'branch'),
      ('assignment_submission.read',   'Trainer',              'branch'),
      ('assignment_submission.read',   'Branch Manager',       'branch'),
      ('assignment_submission.read',   'Vertical Manager',     'vertical'),
      ('assignment_submission.create', 'Super Admin',          'all'),
      ('assignment_submission.create', 'Organization Admin',   'all'),
      ('assignment_submission.create', 'Academic Coordinator', 'branch'),
      ('assignment_submission.create', 'Trainer',              'branch'),
      ('assignment_submission.update', 'Super Admin',          'all'),
      ('assignment_submission.update', 'Organization Admin',   'all'),
      ('assignment_submission.update', 'Academic Coordinator', 'branch'),
      ('assignment_submission.update', 'Trainer',              'branch'),
      ('assignment_submission.delete', 'Super Admin',          'all'),
      ('assignment_submission.delete', 'Organization Admin',   'all'),
      ('assignment_submission.delete', 'Academic Coordinator', 'branch')
    ) AS v(pkey, role_name, scope)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope
      FROM role ro, permission p
     WHERE ro.name = r.role_name AND p.key = r.pkey
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;

-- 5 ------------------------------------------------------------- DUMMY / DEV seed
DO $$
DECLARE
  v_org BIGINT; v_student BIGINT; v_branch BIGINT; v_vertical BIGINT;
  v_lead BIGINT; v_pipeline BIGINT; v_campaign BIGINT; v_source BIGINT;
  a_mock BIGINT; a_assign BIGINT;
  a_max NUMERIC;
  q RECORD; ord INT; frozen JSONB;
  att_eval BIGINT; att_pending BIGINT;
  sel BIGINT[];
BEGIN
  IF EXISTS (SELECT 1 FROM assessment_attempt) THEN RETURN; END IF;
  SELECT id INTO v_org FROM organisation ORDER BY id LIMIT 1;
  IF v_org IS NULL THEN RETURN; END IF;

  SELECT id INTO a_mock   FROM assessment WHERE org_id = v_org AND title = '[DEMO] IT Fundamentals Mock Test' AND deleted_at IS NULL ORDER BY id LIMIT 1;
  SELECT id INTO a_assign FROM assessment WHERE org_id = v_org AND title = '[DEMO] Formal Email — Writing Assignment' AND deleted_at IS NULL ORDER BY id LIMIT 1;
  IF a_mock IS NULL OR a_assign IS NULL THEN RETURN; END IF;

  SELECT id, branch_id, vertical_id INTO v_student, v_branch, v_vertical
    FROM student WHERE org_id = v_org AND deleted_at IS NULL ORDER BY id LIMIT 1;

  IF v_student IS NULL THEN
    SELECT id INTO v_branch   FROM branch   WHERE org_id = v_org AND deleted_at IS NULL ORDER BY id LIMIT 1;
    SELECT id INTO v_vertical FROM vertical WHERE branch_id = v_branch AND deleted_at IS NULL ORDER BY id LIMIT 1;
    SELECT id INTO v_pipeline FROM pipeline WHERE deleted_at IS NULL ORDER BY id LIMIT 1;
    SELECT id INTO v_campaign FROM campaign WHERE deleted_at IS NULL ORDER BY id LIMIT 1;
    SELECT id INTO v_source   FROM source   WHERE deleted_at IS NULL ORDER BY id LIMIT 1;
    IF v_branch IS NULL OR v_vertical IS NULL OR v_pipeline IS NULL OR v_campaign IS NULL OR v_source IS NULL THEN RETURN; END IF;
    INSERT INTO lead (org_id, branch_id, vertical_id, pipeline_id, campaign_id, source_id, full_name, phone, email)
      VALUES (v_org, v_branch, v_vertical, v_pipeline, v_campaign, v_source, '[DEMO] Assessment Student', '+919000000091', 'demo.assessment@techlingua.in')
      RETURNING id INTO v_lead;
    INSERT INTO student (org_id, student_no, lead_id, full_name, phone, email, branch_id, vertical_id, status, remarks)
      VALUES (v_org, 'DEMO-STU-001', v_lead, '[DEMO] Assessment Student', '+919000000091', 'demo.assessment@techlingua.in', v_branch, v_vertical, 'active', '[DEMO] created for Assessment Batch C dummy data')
      RETURNING id INTO v_student;
  END IF;

  -- (a) EVALUATED attempt on the IT mock
  ord := 0; a_max := 0; frozen := '[]'::jsonb;
  FOR q IN
    SELECT aq.question_id, COALESCE(aq.marks_override, qn.marks) AS marks, qn.q_type
      FROM assessment_question aq JOIN question qn ON qn.id = aq.question_id
     WHERE aq.assessment_id = a_mock AND aq.question_id IS NOT NULL AND qn.deleted_at IS NULL
     ORDER BY aq.ordering, aq.id
  LOOP
    ord := ord + 1;
    a_max := a_max + COALESCE(q.marks, 0);
    frozen := frozen || jsonb_build_object('question_id', q.question_id, 'q_type', q.q_type, 'marks', q.marks, 'ordering', ord);
  END LOOP;

  INSERT INTO assessment_attempt (org_id, branch_id, vertical_id, assessment_id, student_id, attempt_no,
      status, started_at, submitted_at, due_at, assembled, auto_score, manual_score, total_score, max_score,
      is_passed, evaluated_at)
    VALUES (v_org, v_branch, v_vertical, a_mock, v_student, 1, 'evaluated',
      now() - interval '2 days', now() - interval '2 days' + interval '18 minutes',
      now() - interval '2 days' + interval '30 minutes', frozen, a_max, 0, a_max, a_max,
      (a_max >= COALESCE((SELECT passing_marks FROM assessment WHERE id = a_mock), 0)),
      now() - interval '2 days' + interval '20 minutes')
    RETURNING id INTO att_eval;

  ord := 0;
  FOR q IN
    SELECT aq.question_id, COALESCE(aq.marks_override, qn.marks) AS marks, qn.q_type
      FROM assessment_question aq JOIN question qn ON qn.id = aq.question_id
     WHERE aq.assessment_id = a_mock AND aq.question_id IS NOT NULL AND qn.deleted_at IS NULL
     ORDER BY aq.ordering, aq.id
  LOOP
    ord := ord + 1;
    SELECT COALESCE(array_agg(o.id), '{}') INTO sel
      FROM question_option o WHERE o.question_id = q.question_id AND o.is_correct;
    INSERT INTO attempt_answer (attempt_id, question_id, q_type, selected_option_ids, is_correct, awarded_marks, ordering)
      VALUES (att_eval, q.question_id, q.q_type, sel, true, q.marks, ord);
  END LOOP;

  -- (b) PENDING attempt on the writing assignment
  SELECT COALESCE(SUM(COALESCE(aq.marks_override, qn.marks)), 0) INTO a_max
    FROM assessment_question aq JOIN question qn ON qn.id = aq.question_id
   WHERE aq.assessment_id = a_assign AND aq.question_id IS NOT NULL AND qn.deleted_at IS NULL;
  ord := 0; frozen := '[]'::jsonb;
  FOR q IN
    SELECT aq.question_id, COALESCE(aq.marks_override, qn.marks) AS marks, qn.q_type
      FROM assessment_question aq JOIN question qn ON qn.id = aq.question_id
     WHERE aq.assessment_id = a_assign AND aq.question_id IS NOT NULL AND qn.deleted_at IS NULL
     ORDER BY aq.ordering, aq.id
  LOOP
    ord := ord + 1;
    frozen := frozen || jsonb_build_object('question_id', q.question_id, 'q_type', q.q_type, 'marks', q.marks, 'ordering', ord);
  END LOOP;

  INSERT INTO assessment_attempt (org_id, branch_id, vertical_id, assessment_id, student_id, attempt_no,
      status, started_at, submitted_at, assembled, auto_score, max_score)
    VALUES (v_org, v_branch, v_vertical, a_assign, v_student, 1, 'submitted',
      now() - interval '1 day', now() - interval '1 day' + interval '25 minutes', frozen, 0, a_max)
    RETURNING id INTO att_pending;
  ord := 0;
  FOR q IN
    SELECT aq.question_id, COALESCE(aq.marks_override, qn.marks) AS marks, qn.q_type
      FROM assessment_question aq JOIN question qn ON qn.id = aq.question_id
     WHERE aq.assessment_id = a_assign AND aq.question_id IS NOT NULL AND qn.deleted_at IS NULL
     ORDER BY aq.ordering, aq.id
  LOOP
    ord := ord + 1;
    INSERT INTO attempt_answer (attempt_id, question_id, q_type, answer_text, ordering)
      VALUES (att_pending, q.question_id, q.q_type,
        '[DEMO] Dear Sir, I am writing to formally request... (student response awaiting faculty evaluation).', ord);
  END LOOP;

  -- (c) An assignment_submission (file) on the writing assignment
  INSERT INTO assignment_submission (org_id, branch_id, vertical_id, assessment_id, student_id,
      file_r2_key, original_filename, mime, size_bytes, status, max_marks)
    VALUES (v_org, v_branch, v_vertical, a_assign, v_student,
      'submissions/demo/formal-email-demo.pdf', 'formal-email-demo.pdf', 'application/pdf', 1024, 'submitted',
      COALESCE((SELECT total_marks FROM assessment WHERE id = a_assign), 0));
END $$;
