-- =============================================================================
-- 064 — ASSESSMENT / TEST MODULE · BATCH B: TESTS / EXAMS, SETTINGS, TEMPLATES
--
-- Builds on Batch A's Question Bank (063). A "test" (assessment) is a reusable
-- exam definition that pulls questions from the bank — either hand-picked
-- (assessment_question links) or pooled from a category (assessment_section), or
-- both. Settings cover duration, marks, negative marking, randomisation, attempt
-- limits, an availability window, instructions and how results are shown. A
-- reusable settings preset lives in assessment_template.
--
--   1) assessment          — the test/exam definition (scope cols + settings).
--   2) assessment_section  — optional grouping within a test; may be a POOL
--                            (pick N random from a question_category).
--   3) assessment_question — link table: which bank questions are in a test,
--                            with per-link marks/negative overrides + ordering.
--   4) assessment_template — a reusable settings preset (duration, negative
--                            marking, randomisation, instructions, show-result mode).
--   5) permissions + role grants.
--   6) A guarded, clearly-marked [DEMO] seed: 3 tests off the Batch A dummy
--      questions (an IT mock, a Language chapter test with a pooled Reading
--      section, and an assignment-type test) + one template.
--
-- Serves BOTH institutes — IT (Insta Infotech) and Language (British College of
-- Language). India-first. Idempotent throughout (IF NOT EXISTS / guards). Batch C
-- (attempts/evaluation) and Batch D (results/analytics) build on these tables.
-- =============================================================================

-- 4 (template first — assessment.template_id references it) ------- assessment_template
CREATE TABLE IF NOT EXISTS assessment_template (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             BIGINT NOT NULL REFERENCES organisation(id),
  branch_id          BIGINT NULL REFERENCES branch(id),
  vertical_id        BIGINT NULL REFERENCES vertical(id),
  name               VARCHAR(160) NOT NULL,
  test_type          VARCHAR(16) NOT NULL DEFAULT 'practice' CHECK (test_type IN (
                       'practice','chapter','weekly','mock','assignment','practical','final_exam')),
  duration_min       INT NOT NULL DEFAULT 30 CHECK (duration_min >= 0),
  negative_marking   BOOLEAN NOT NULL DEFAULT false,
  default_negative   NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (default_negative >= 0),
  randomize_questions BOOLEAN NOT NULL DEFAULT false,
  randomize_options  BOOLEAN NOT NULL DEFAULT false,
  shuffle_per_attempt BOOLEAN NOT NULL DEFAULT false,
  questions_to_show  INT NULL CHECK (questions_to_show IS NULL OR questions_to_show > 0),
  max_attempts       INT NOT NULL DEFAULT 1 CHECK (max_attempts >= 1),
  passing_pct        NUMERIC(5,2) NULL CHECK (passing_pct IS NULL OR (passing_pct >= 0 AND passing_pct <= 100)),
  show_result_mode   VARCHAR(10) NOT NULL DEFAULT 'instant' CHECK (show_result_mode IN ('instant','manual','after_end')),
  instructions       TEXT NULL,
  active             BOOLEAN NOT NULL DEFAULT true,
  created_by         BIGINT NULL REFERENCES "user"(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ NULL,
  deleted_by         BIGINT NULL REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS idx_atmpl_scope ON assessment_template (branch_id, vertical_id) WHERE deleted_at IS NULL;

-- 1 ------------------------------------------------------------------- assessment
CREATE TABLE IF NOT EXISTS assessment (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             BIGINT NOT NULL REFERENCES organisation(id),
  branch_id          BIGINT NULL REFERENCES branch(id),
  vertical_id        BIGINT NULL REFERENCES vertical(id),
  pipeline_id        BIGINT NULL REFERENCES pipeline(id),
  team_id            BIGINT NULL REFERENCES team(id),
  title              VARCHAR(200) NOT NULL,
  description        TEXT NULL,
  test_type          VARCHAR(16) NOT NULL DEFAULT 'practice' CHECK (test_type IN (
                       'practice','chapter','weekly','mock','assignment','practical','final_exam')),
  course_id          BIGINT NULL REFERENCES m_course(id),
  batch_id           BIGINT NULL REFERENCES batch(id),
  language           VARCHAR(40) NULL,
  -- settings ----------------------------------------------------------------
  duration_min       INT NOT NULL DEFAULT 30 CHECK (duration_min >= 0),
  total_marks        NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (total_marks >= 0),
  total_marks_manual BOOLEAN NOT NULL DEFAULT false,
  passing_marks      NUMERIC(10,2) NULL CHECK (passing_marks IS NULL OR passing_marks >= 0),
  passing_pct        NUMERIC(5,2) NULL CHECK (passing_pct IS NULL OR (passing_pct >= 0 AND passing_pct <= 100)),
  negative_marking   BOOLEAN NOT NULL DEFAULT false,
  default_negative   NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (default_negative >= 0),
  randomize_questions BOOLEAN NOT NULL DEFAULT false,
  randomize_options  BOOLEAN NOT NULL DEFAULT false,
  shuffle_per_attempt BOOLEAN NOT NULL DEFAULT false,
  questions_to_show  INT NULL CHECK (questions_to_show IS NULL OR questions_to_show > 0),
  max_attempts       INT NOT NULL DEFAULT 1 CHECK (max_attempts >= 1),
  start_at           TIMESTAMPTZ NULL,
  end_at             TIMESTAMPTZ NULL,
  instructions       TEXT NULL,
  show_result_mode   VARCHAR(10) NOT NULL DEFAULT 'instant' CHECK (show_result_mode IN ('instant','manual','after_end')),
  status             VARCHAR(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','closed')),
  template_id        BIGINT NULL REFERENCES assessment_template(id),
  published_at       TIMESTAMPTZ NULL,
  closed_at          TIMESTAMPTZ NULL,
  active             BOOLEAN NOT NULL DEFAULT true,
  created_by         BIGINT NULL REFERENCES "user"(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ NULL,
  deleted_by         BIGINT NULL REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS idx_assessment_scope  ON assessment (branch_id, vertical_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_assessment_type   ON assessment (test_type) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_assessment_status ON assessment (status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_assessment_course ON assessment (course_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_assessment_batch  ON assessment (batch_id) WHERE deleted_at IS NULL;

-- 2 --------------------------------------------------------------- assessment_section
CREATE TABLE IF NOT EXISTS assessment_section (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  assessment_id        BIGINT NOT NULL REFERENCES assessment(id) ON DELETE CASCADE,
  title                VARCHAR(160) NOT NULL DEFAULT 'Section',
  description          TEXT NULL,
  ordering             INT NOT NULL DEFAULT 1,
  pool_from_category_id BIGINT NULL REFERENCES question_category(id),
  pool_pick_count      INT NULL CHECK (pool_pick_count IS NULL OR pool_pick_count > 0)
);
CREATE INDEX IF NOT EXISTS idx_asection_assessment ON assessment_section (assessment_id, ordering);

-- 3 -------------------------------------------------------------- assessment_question
CREATE TABLE IF NOT EXISTS assessment_question (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  assessment_id     BIGINT NOT NULL REFERENCES assessment(id) ON DELETE CASCADE,
  question_id       BIGINT NULL REFERENCES question(id),
  section_id        BIGINT NULL REFERENCES assessment_section(id) ON DELETE CASCADE,
  marks_override    NUMERIC(8,2) NULL CHECK (marks_override IS NULL OR marks_override >= 0),
  negative_override NUMERIC(8,2) NULL CHECK (negative_override IS NULL OR negative_override >= 0),
  ordering          INT NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_aquestion_assessment ON assessment_question (assessment_id, ordering);
CREATE INDEX IF NOT EXISTS idx_aquestion_question   ON assessment_question (question_id);
CREATE INDEX IF NOT EXISTS idx_aquestion_section    ON assessment_question (section_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_aquestion_once
  ON assessment_question (assessment_id, question_id) WHERE question_id IS NOT NULL;

-- 5 ------------------------------------------------------------- permissions + grants
INSERT INTO permission (key, module, action) VALUES
  ('assessment.read',    'assessment', 'read'),
  ('assessment.create',  'assessment', 'create'),
  ('assessment.update',  'assessment', 'update'),
  ('assessment.delete',  'assessment', 'delete'),
  ('assessment.publish', 'assessment', 'publish'),
  ('assessment_template.read',   'assessment_template', 'read'),
  ('assessment_template.create', 'assessment_template', 'create'),
  ('assessment_template.update', 'assessment_template', 'update'),
  ('assessment_template.delete', 'assessment_template', 'delete')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('assessment.read',    'Super Admin',          'all'),
      ('assessment.read',    'Organization Admin',   'all'),
      ('assessment.read',    'Academic Coordinator', 'branch'),
      ('assessment.read',    'Trainer',              'branch'),
      ('assessment.read',    'Branch Manager',       'branch'),
      ('assessment.read',    'Vertical Manager',     'vertical'),
      ('assessment.create',  'Super Admin',          'all'),
      ('assessment.create',  'Organization Admin',   'all'),
      ('assessment.create',  'Academic Coordinator', 'branch'),
      ('assessment.create',  'Trainer',              'branch'),
      ('assessment.update',  'Super Admin',          'all'),
      ('assessment.update',  'Organization Admin',   'all'),
      ('assessment.update',  'Academic Coordinator', 'branch'),
      ('assessment.update',  'Trainer',              'branch'),
      ('assessment.delete',  'Super Admin',          'all'),
      ('assessment.delete',  'Organization Admin',   'all'),
      ('assessment.delete',  'Academic Coordinator', 'branch'),
      ('assessment.publish', 'Super Admin',          'all'),
      ('assessment.publish', 'Organization Admin',   'all'),
      ('assessment.publish', 'Academic Coordinator', 'branch'),
      ('assessment.publish', 'Trainer',              'branch'),
      ('assessment_template.read',   'Super Admin',          'all'),
      ('assessment_template.read',   'Organization Admin',   'all'),
      ('assessment_template.read',   'Academic Coordinator', 'branch'),
      ('assessment_template.read',   'Trainer',              'branch'),
      ('assessment_template.read',   'Branch Manager',       'branch'),
      ('assessment_template.read',   'Vertical Manager',     'vertical'),
      ('assessment_template.create', 'Super Admin',          'all'),
      ('assessment_template.create', 'Organization Admin',   'all'),
      ('assessment_template.create', 'Academic Coordinator', 'branch'),
      ('assessment_template.update', 'Super Admin',          'all'),
      ('assessment_template.update', 'Organization Admin',   'all'),
      ('assessment_template.update', 'Academic Coordinator', 'branch'),
      ('assessment_template.delete', 'Super Admin',          'all'),
      ('assessment_template.delete', 'Organization Admin',   'all'),
      ('assessment_template.delete', 'Academic Coordinator', 'branch')
    ) AS v(pkey, role_name, scope)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope
      FROM role ro, permission p
     WHERE ro.name = r.role_name AND p.key = r.pkey
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;

-- 6 ------------------------------------------------------------- DUMMY / DEV seed
DO $$
DECLARE
  v_org BIGINT; v_branch BIGINT; v_vertical BIGINT;
  v_cat_it BIGINT; v_cat_lang BIGINT;
  v_tmpl BIGINT;
  a_mock BIGINT; a_chapter BIGINT; a_assign BIGINT;
  v_sec BIGINT;
  q RECORD; ord INT;
  v_total NUMERIC;
BEGIN
  IF EXISTS (SELECT 1 FROM assessment) THEN RETURN; END IF;
  SELECT id INTO v_org FROM organisation ORDER BY id LIMIT 1;
  IF v_org IS NULL THEN RETURN; END IF;
  SELECT id, branch_id, vertical_id INTO v_cat_it, v_branch, v_vertical
    FROM question_category WHERE org_id = v_org AND name = 'Programming Fundamentals' AND deleted_at IS NULL ORDER BY id LIMIT 1;
  SELECT id INTO v_cat_lang
    FROM question_category WHERE org_id = v_org AND name = 'English Grammar' AND deleted_at IS NULL ORDER BY id LIMIT 1;
  IF v_cat_it IS NULL THEN RETURN; END IF;

  INSERT INTO assessment_template (org_id, branch_id, vertical_id, name, test_type, duration_min,
      negative_marking, default_negative, randomize_questions, randomize_options, shuffle_per_attempt,
      max_attempts, passing_pct, show_result_mode, instructions)
    VALUES (v_org, v_branch, v_vertical, '[DEMO] Standard MCQ Mock', 'mock', 30,
      true, 0.25, true, true, true, 1, 40, 'instant',
      'Attempt all questions. Negative marking applies. Do not refresh the page.')
    RETURNING id INTO v_tmpl;

  INSERT INTO assessment (org_id, branch_id, vertical_id, title, description, test_type, language,
      duration_min, negative_marking, default_negative, randomize_questions, randomize_options,
      shuffle_per_attempt, max_attempts, passing_pct, show_result_mode, status, template_id, instructions, published_at)
    VALUES (v_org, v_branch, v_vertical, '[DEMO] IT Fundamentals Mock Test',
      'Programming Fundamentals mock — MCQ/True-False, negative marking, randomised.', 'mock', NULL,
      30, true, 0.25, true, true, true, 1, 40, 'instant', 'published', v_tmpl,
      'Attempt all questions. 0.25 negative per wrong objective answer.', now())
    RETURNING id INTO a_mock;
  ord := 0; v_total := 0;
  FOR q IN
    SELECT id, marks FROM question
     WHERE org_id = v_org AND category_id = v_cat_it AND deleted_at IS NULL
       AND q_type IN ('mcq_single','mcq_multi','true_false','image_mcq','video_mcq')
     ORDER BY id
  LOOP
    ord := ord + 1;
    INSERT INTO assessment_question (assessment_id, question_id, ordering) VALUES (a_mock, q.id, ord);
    v_total := v_total + COALESCE(q.marks, 0);
  END LOOP;
  UPDATE assessment SET total_marks = v_total, passing_marks = ROUND(v_total * 0.40, 2) WHERE id = a_mock;

  INSERT INTO assessment (org_id, branch_id, vertical_id, title, description, test_type, language,
      duration_min, negative_marking, randomize_questions, randomize_options, max_attempts,
      passing_pct, show_result_mode, status, instructions)
    VALUES (v_org, v_branch, v_vertical, '[DEMO] English Grammar — Chapter Test',
      'Chapter test with a Reading section pooled from English Grammar.', 'chapter', 'English',
      20, false, false, false, 2, 50, 'instant', 'draft',
      'Read each item carefully. Two attempts allowed.')
    RETURNING id INTO a_chapter;
  INSERT INTO assessment_section (assessment_id, title, description, ordering, pool_from_category_id, pool_pick_count)
    VALUES (a_chapter, 'Reading & Grammar', 'Randomly drawn from the English Grammar bank.', 1, v_cat_lang, 2)
    RETURNING id INTO v_sec;
  SELECT COALESCE(ROUND(2 * AVG(marks), 2), 0) INTO v_total
    FROM question WHERE org_id = v_org AND category_id = v_cat_lang AND deleted_at IS NULL;
  UPDATE assessment SET total_marks = v_total, passing_marks = ROUND(v_total * 0.50, 2) WHERE id = a_chapter;

  INSERT INTO assessment (org_id, branch_id, vertical_id, title, description, test_type, language,
      duration_min, negative_marking, max_attempts, passing_pct, show_result_mode, status, instructions)
    VALUES (v_org, v_branch, v_vertical, '[DEMO] Formal Email — Writing Assignment',
      'Assignment: write a formal email. Evaluated by faculty in Batch C.', 'assignment', 'English',
      0, false, 3, 40, 'manual', 'published',
      'Submit your response. Results are released manually after evaluation.')
    RETURNING id INTO a_assign;
  ord := 0; v_total := 0;
  FOR q IN
    SELECT id, marks FROM question
     WHERE org_id = v_org AND category_id = v_cat_lang AND deleted_at IS NULL AND q_type = 'writing'
     ORDER BY id
  LOOP
    ord := ord + 1;
    INSERT INTO assessment_question (assessment_id, question_id, ordering) VALUES (a_assign, q.id, ord);
    v_total := v_total + COALESCE(q.marks, 0);
  END LOOP;
  UPDATE assessment SET total_marks = v_total, passing_marks = ROUND(v_total * 0.40, 2), published_at = now() WHERE id = a_assign;
END $$;
