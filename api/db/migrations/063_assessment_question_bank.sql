-- =============================================================================
-- 063 — ASSESSMENT / TEST MODULE · BATCH A: QUESTION BANK FOUNDATION
--
-- The reusable question bank the Test/Exam engine (Batch B), the student attempt flow
-- (Batch C) and results/analytics (Batch D) will all build on. Serves BOTH institute
-- types: IT (Insta Infotech) technical items and Language (British College of Language)
-- language-learning items — hence the wide q_type list below.
--
--   1) question_category — subject/topic taxonomy. Hierarchy path + scope columns; a
--      topic sits under a subject via parent_id (nullable). name + optional code, active.
--   2) question — the bank. Full type list (single CHECK), difficulty, marks/negative,
--      body text, MEDIA (image/audio -> Cloudflare R2 KEY only, never bytes; youtube =
--      URL/id + start/end seconds, never an uploaded video), language, explanation, tags.
--   3) question_option — objective-type options: text, optional R2 image key, is_correct,
--      ordering, match_key (for match-the-following pairs).
--   4) question_category.* + question.* permissions + role grants.
--   5) A small, clearly-marked DUMMY/DEV seed (2 categories, 8 questions across types incl.
--      image_mcq / audio_mcq / video_mcq / a language item / a subjective one) so the
--      later-batch tester has data. Guarded (NOT EXISTS) — never duplicates.
--
-- MEDIA RULE (non-negotiable, docs/dev/57): binaries live in Cloudflare R2; the DB stores
-- only r2_key + metadata. YouTube questions store the URL/video id + start/end seconds.
-- Idempotent throughout (IF NOT EXISTS / ON CONFLICT DO NOTHING / NOT EXISTS guards).
-- =============================================================================

-- 1 ---------------------------------------------------------- question_category
CREATE TABLE IF NOT EXISTS question_category (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       BIGINT NOT NULL REFERENCES organisation(id),
  branch_id    BIGINT NULL REFERENCES branch(id),
  vertical_id  BIGINT NULL REFERENCES vertical(id),
  parent_id    BIGINT NULL REFERENCES question_category(id),
  name         VARCHAR(160) NOT NULL,
  code         VARCHAR(40)  NULL,
  description  TEXT NULL,
  active       BOOLEAN NOT NULL DEFAULT true,
  created_by   BIGINT NULL REFERENCES "user"(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ NULL,
  deleted_by   BIGINT NULL REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS idx_qcat_scope  ON question_category (branch_id, vertical_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_qcat_parent ON question_category (parent_id) WHERE deleted_at IS NULL;

-- 2 ------------------------------------------------------------------- question
CREATE TABLE IF NOT EXISTS question (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          BIGINT NOT NULL REFERENCES organisation(id),
  branch_id       BIGINT NULL REFERENCES branch(id),
  vertical_id     BIGINT NULL REFERENCES vertical(id),
  pipeline_id     BIGINT NULL REFERENCES pipeline(id),
  team_id         BIGINT NULL REFERENCES team(id),
  category_id     BIGINT NULL REFERENCES question_category(id),
  q_type          VARCHAR(20) NOT NULL CHECK (q_type IN (
                    'mcq_single','mcq_multi','true_false','fill_blank','match_following',
                    'image_mcq','audio_mcq','video_mcq','short_answer','long_answer','essay',
                    'case_study','coding','practical',
                    'reading','listening','speaking','translation','vocabulary','grammar','writing')),
  difficulty      VARCHAR(6) NOT NULL DEFAULT 'medium' CHECK (difficulty IN ('easy','medium','hard')),
  marks           NUMERIC(8,2) NOT NULL DEFAULT 1 CHECK (marks >= 0),
  negative_marks  NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (negative_marks >= 0),
  body            TEXT NOT NULL DEFAULT '',
  image_r2_key    VARCHAR(400) NULL,
  audio_r2_key    VARCHAR(400) NULL,
  youtube_url     VARCHAR(400) NULL,
  youtube_start_sec INT NULL,
  youtube_end_sec   INT NULL,
  language        VARCHAR(40) NULL,
  explanation     TEXT NULL,
  tags            TEXT[] NOT NULL DEFAULT '{}',
  active          BOOLEAN NOT NULL DEFAULT true,
  created_by      BIGINT NULL REFERENCES "user"(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ NULL,
  deleted_by      BIGINT NULL REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS idx_question_scope    ON question (branch_id, vertical_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_question_category ON question (category_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_question_type     ON question (q_type) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_question_diff     ON question (difficulty) WHERE deleted_at IS NULL;

-- 3 ------------------------------------------------------------- question_option
CREATE TABLE IF NOT EXISTS question_option (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  question_id  BIGINT NOT NULL REFERENCES question(id) ON DELETE CASCADE,
  body         TEXT NOT NULL DEFAULT '',
  image_r2_key VARCHAR(400) NULL,
  is_correct   BOOLEAN NOT NULL DEFAULT false,
  ordering     INT NOT NULL DEFAULT 1,
  match_key    VARCHAR(200) NULL
);
CREATE INDEX IF NOT EXISTS idx_question_option ON question_option (question_id, ordering);

-- 4 ------------------------------------------------------------- permissions
INSERT INTO permission (key, module, action) VALUES
  ('question_category.read',   'question_category', 'read'),
  ('question_category.create', 'question_category', 'create'),
  ('question_category.update', 'question_category', 'update'),
  ('question_category.delete', 'question_category', 'delete'),
  ('question.read',   'question', 'read'),
  ('question.create', 'question', 'create'),
  ('question.update', 'question', 'update'),
  ('question.delete', 'question', 'delete'),
  ('question.import', 'question', 'import')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- question_category
      ('question_category.read',   'Super Admin',          'all'),
      ('question_category.read',   'Organization Admin',   'all'),
      ('question_category.read',   'Academic Coordinator', 'branch'),
      ('question_category.read',   'Trainer',              'branch'),
      ('question_category.read',   'Branch Manager',       'branch'),
      ('question_category.read',   'Vertical Manager',     'vertical'),
      ('question_category.create', 'Super Admin',          'all'),
      ('question_category.create', 'Organization Admin',   'all'),
      ('question_category.create', 'Academic Coordinator', 'branch'),
      ('question_category.create', 'Trainer',              'branch'),
      ('question_category.update', 'Super Admin',          'all'),
      ('question_category.update', 'Organization Admin',   'all'),
      ('question_category.update', 'Academic Coordinator', 'branch'),
      ('question_category.update', 'Trainer',              'branch'),
      ('question_category.delete', 'Super Admin',          'all'),
      ('question_category.delete', 'Organization Admin',   'all'),
      ('question_category.delete', 'Academic Coordinator', 'branch'),
      -- question
      ('question.read',   'Super Admin',          'all'),
      ('question.read',   'Organization Admin',   'all'),
      ('question.read',   'Academic Coordinator', 'branch'),
      ('question.read',   'Trainer',              'branch'),
      ('question.read',   'Branch Manager',       'branch'),
      ('question.read',   'Vertical Manager',     'vertical'),
      ('question.create', 'Super Admin',          'all'),
      ('question.create', 'Organization Admin',   'all'),
      ('question.create', 'Academic Coordinator', 'branch'),
      ('question.create', 'Trainer',              'branch'),
      ('question.update', 'Super Admin',          'all'),
      ('question.update', 'Organization Admin',   'all'),
      ('question.update', 'Academic Coordinator', 'branch'),
      ('question.update', 'Trainer',              'branch'),
      ('question.delete', 'Super Admin',          'all'),
      ('question.delete', 'Organization Admin',   'all'),
      ('question.delete', 'Academic Coordinator', 'branch'),
      ('question.import', 'Super Admin',          'all'),
      ('question.import', 'Organization Admin',   'all'),
      ('question.import', 'Academic Coordinator', 'branch'),
      ('question.import', 'Trainer',              'branch')
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
-- Clearly-marked dummy data so the Batch B/C/D tester has a populated bank. Runs only on
-- a bank that is still empty; picks the first org + its first branch/vertical. NOT client
-- data — delete freely.
DO $$
DECLARE
  v_org BIGINT; v_branch BIGINT; v_vertical BIGINT;
  v_cat_it BIGINT; v_cat_lang BIGINT;
  q1 BIGINT; q2 BIGINT; q3 BIGINT; q4 BIGINT; q5 BIGINT;
BEGIN
  IF EXISTS (SELECT 1 FROM question) THEN RETURN; END IF;
  SELECT id INTO v_org FROM organisation ORDER BY id LIMIT 1;
  IF v_org IS NULL THEN RETURN; END IF;
  SELECT id INTO v_branch FROM branch WHERE org_id = v_org AND deleted_at IS NULL ORDER BY id LIMIT 1;
  SELECT id INTO v_vertical FROM vertical WHERE branch_id = v_branch AND deleted_at IS NULL ORDER BY id LIMIT 1;

  INSERT INTO question_category (org_id, branch_id, vertical_id, name, code, description)
    VALUES (v_org, v_branch, v_vertical, 'Programming Fundamentals', 'PROG', '[DEMO] IT — core programming (Insta Infotech)')
    RETURNING id INTO v_cat_it;
  INSERT INTO question_category (org_id, branch_id, vertical_id, name, code, description)
    VALUES (v_org, v_branch, v_vertical, 'English Grammar', 'ENG-GRAM', '[DEMO] Language — English grammar (British College of Language)')
    RETURNING id INTO v_cat_lang;

  -- 1. mcq_single (IT)
  INSERT INTO question (org_id, branch_id, vertical_id, category_id, q_type, difficulty, marks, negative_marks, body, explanation, tags)
    VALUES (v_org, v_branch, v_vertical, v_cat_it, 'mcq_single', 'easy', 1, 0.25,
      'Which keyword declares a block-scoped variable in modern JavaScript?',
      'let (and const) are block-scoped; var is function-scoped.', ARRAY['demo','javascript'])
    RETURNING id INTO q1;
  INSERT INTO question_option (question_id, body, is_correct, ordering) VALUES
    (q1, 'var', false, 1), (q1, 'let', true, 2), (q1, 'define', false, 3), (q1, 'static', false, 4);

  -- 2. mcq_multi (IT)
  INSERT INTO question (org_id, branch_id, vertical_id, category_id, q_type, difficulty, marks, body, tags)
    VALUES (v_org, v_branch, v_vertical, v_cat_it, 'mcq_multi', 'medium', 2,
      'Select ALL languages that run on the JVM.', ARRAY['demo','jvm'])
    RETURNING id INTO q2;
  INSERT INTO question_option (question_id, body, is_correct, ordering) VALUES
    (q2, 'Kotlin', true, 1), (q2, 'Scala', true, 2), (q2, 'C#', false, 3), (q2, 'Clojure', true, 4);

  -- 3. true_false (IT)
  INSERT INTO question (org_id, branch_id, vertical_id, category_id, q_type, difficulty, marks, body)
    VALUES (v_org, v_branch, v_vertical, v_cat_it, 'true_false', 'easy', 1,
      'HTTP is a stateless protocol.')
    RETURNING id INTO q3;
  INSERT INTO question_option (question_id, body, is_correct, ordering) VALUES
    (q3, 'True', true, 1), (q3, 'False', false, 2);

  -- 4. image_mcq (IT) — image lives in R2; key set once uploads are wired; demo leaves it null
  INSERT INTO question (org_id, branch_id, vertical_id, category_id, q_type, difficulty, marks, body, tags)
    VALUES (v_org, v_branch, v_vertical, v_cat_it, 'image_mcq', 'medium', 2,
      'Identify the data structure shown in the diagram.', ARRAY['demo','image'])
    RETURNING id INTO q4;
  INSERT INTO question_option (question_id, body, is_correct, ordering) VALUES
    (q4, 'Stack', false, 1), (q4, 'Binary tree', true, 2), (q4, 'Linked list', false, 3), (q4, 'Hash map', false, 4);

  -- 5. audio_mcq (Language) — audio prompt lives in R2 (key null in demo)
  INSERT INTO question (org_id, branch_id, vertical_id, category_id, q_type, difficulty, marks, body, language, tags)
    VALUES (v_org, v_branch, v_vertical, v_cat_lang, 'audio_mcq', 'medium', 1,
      'Listen to the clip and choose the word you heard.', 'English', ARRAY['demo','listening'])
    RETURNING id INTO q5;
  INSERT INTO question_option (question_id, body, is_correct, ordering) VALUES
    (q5, 'their', true, 1), (q5, 'there', false, 2), (q5, 'they''re', false, 3);

  -- 6. video_mcq (IT) — REAL YouTube id, start/end seconds (no uploaded video)
  INSERT INTO question (org_id, branch_id, vertical_id, category_id, q_type, difficulty, marks, body, youtube_url, youtube_start_sec, youtube_end_sec, tags)
    VALUES (v_org, v_branch, v_vertical, v_cat_it, 'video_mcq', 'medium', 2,
      'Watch the clip 00:30–01:00 and answer: what does the presenter call the loop construct?',
      'https://www.youtube.com/watch?v=Ke90Tje7VS0', 30, 60, ARRAY['demo','video']);

  -- 7. grammar / fill_blank (Language subjective-lite)
  INSERT INTO question (org_id, branch_id, vertical_id, category_id, q_type, difficulty, marks, body, language, explanation, tags)
    VALUES (v_org, v_branch, v_vertical, v_cat_lang, 'fill_blank', 'easy', 1,
      'Fill in the blank: "She has lived in Delhi ____ 2010."', 'English',
      'Answer: since (a point in time).', ARRAY['demo','grammar']);

  -- 8. writing (Language subjective — evaluated in Batch C)
  INSERT INTO question (org_id, branch_id, vertical_id, category_id, q_type, difficulty, marks, body, language, tags)
    VALUES (v_org, v_branch, v_vertical, v_cat_lang, 'writing', 'hard', 10,
      'Write a 150-word formal email requesting a refund for a delayed course.', 'English', ARRAY['demo','writing','subjective']);
END $$;
