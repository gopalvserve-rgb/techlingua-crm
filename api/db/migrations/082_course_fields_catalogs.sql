-- =============================================================================
-- 082 — COURSE FIELDS + CATALOGS (client feedback #11/#12/#13)
--
-- The Course master gains four descriptive fields so a course records WHAT it is and HOW it is
-- delivered, and the Course list can filter on them:
--
--   level         — a course level (CEFR A1…C2 for languages + generic Beginner…Expert). Free-ish
--                   text, stored as the picked label (e.g. 'A2'); course_level_def powers the dropdown.
--   course_type   — Diploma / Certificate / Foundation / Crash Course / … (course_type_def catalog).
--   delivery_mode — Offline / Online / Hybrid (course_delivery_def catalog).
--   description   — free text.
--
-- Courses live in m_course with a `meta` jsonb that already holds fee + branch_id + vertical_id,
-- so these four ride in `meta` too (meta->>'course_type' etc.) — the exact shape the Course list
-- filters already query for branch_id/vertical_id, so filtering stays reliable and consistent.
-- The *_def tables are seeded catalogs (code == label, human-readable) that power the dropdowns
-- and the GET /courses/*-catalog endpoints — mirroring the batch_type_def pattern from 081.
--
-- Idempotent throughout (IF NOT EXISTS / ON CONFLICT / guarded).
-- =============================================================================

-- 1 ------------------------------------------------ COURSE TYPE catalog + seed
CREATE TABLE IF NOT EXISTS course_type_def (
  code     VARCHAR(48) PRIMARY KEY,
  label    VARCHAR(48) NOT NULL,
  ordering INT NOT NULL DEFAULT 0
);
INSERT INTO course_type_def (code, label, ordering) VALUES
  ('Diploma',          'Diploma',          10),
  ('Certificate',      'Certificate',      20),
  ('Foundation',       'Foundation',       30),
  ('Crash Course',     'Crash Course',     40),
  ('Advanced Diploma', 'Advanced Diploma', 50),
  ('Workshop',         'Workshop',         60)
ON CONFLICT (code) DO NOTHING;

-- 2 ------------------------------------------------ COURSE LEVEL catalog + seed
-- CEFR language levels (client example A1, A2, …) plus a generic ladder. Stored as the label.
CREATE TABLE IF NOT EXISTS course_level_def (
  code     VARCHAR(48) PRIMARY KEY,
  label    VARCHAR(48) NOT NULL,
  ordering INT NOT NULL DEFAULT 0
);
INSERT INTO course_level_def (code, label, ordering) VALUES
  ('A1',           'A1',           10),
  ('A2',           'A2',           20),
  ('B1',           'B1',           30),
  ('B2',           'B2',           40),
  ('C1',           'C1',           50),
  ('C2',           'C2',           60),
  ('Beginner',     'Beginner',     70),
  ('Intermediate', 'Intermediate', 80),
  ('Advanced',     'Advanced',     90),
  ('Expert',       'Expert',      100)
ON CONFLICT (code) DO NOTHING;

-- 3 ------------------------------------------------ DELIVERY MODE catalog + seed
CREATE TABLE IF NOT EXISTS course_delivery_def (
  code     VARCHAR(24) PRIMARY KEY,
  label    VARCHAR(24) NOT NULL,
  ordering INT NOT NULL DEFAULT 0
);
INSERT INTO course_delivery_def (code, label, ordering) VALUES
  ('Offline', 'Offline', 10),
  ('Online',  'Online',  20),
  ('Hybrid',  'Hybrid',  30)
ON CONFLICT (code) DO NOTHING;

-- 4 ------------------------------------------------ BACKFILL existing courses (deterministic)
-- Every existing course with no delivery_mode set gets 'Offline' (the sensible default). level,
-- course_type and description are left absent (null) until the client sets them — no fake data.
UPDATE m_course
   SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('delivery_mode', 'Offline')
 WHERE deleted_at IS NULL
   AND COALESCE(meta->>'delivery_mode', '') = '';
