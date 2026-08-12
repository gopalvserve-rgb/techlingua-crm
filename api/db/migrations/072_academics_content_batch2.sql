-- =============================================================================
-- 072 — ACADEMICS GOVERNANCE · BATCH 2  (Study Material · Course Content · Syllabus)
--
-- Batch 2 of the academics-governance model (docs/dev/67 = Batch 1). Three governed
-- content entities that REUSE the Batch-1 content_approval ledger + ContentApprovalWorkflowService
-- (draft -> pending_approval -> published; reject -> changes_requested; unpublish). Each table
-- carries a `workflow_status` MIRROR column kept in sync with the ledger (exactly like assessment).
--
--   1) study_material — EXTENDS the existing ERP-Batch-2 table (048): adds image/audio types,
--      an R2 file key + external_url (YouTube/link), and the workflow_status mirror. The legacy
--      `visibility` column is retained and kept aligned (published<->published) so the existing
--      learning screen + parent view keep working. Published material is visible to students of
--      the mapped batch/course/vertical.
--   2) course_content — NEW: structured lessons/units under a course (module ordering + rich body,
--      optional R2 file), governed.
--   3) syllabus — NEW: a versioned syllabus outline under a course (rich body / JSON, optional R2
--      file), governed.
--
-- No new permissions (Batch-1 migration 070 catalogued material.submit/approve + course_content.*
-- + syllabus.* and granted Trainer read/create/update/submit, Academic Admin + Super/Org approve).
-- FKs + indexes throughout. Idempotent (IF NOT EXISTS / guarded / ON CONFLICT). Re-runnable.
-- =============================================================================

-- 1 ---------------------------------------------------- study_material: governance columns
-- Extend the material_type CHECK to add image + audio (drop + re-add, idempotent).
ALTER TABLE study_material DROP CONSTRAINT IF EXISTS study_material_material_type_check;
ALTER TABLE study_material ADD CONSTRAINT study_material_material_type_check
  CHECK (material_type IN ('video','link','document','note','image','audio'));

ALTER TABLE study_material ADD COLUMN IF NOT EXISTS file_r2_key     VARCHAR(400) NULL;
ALTER TABLE study_material ADD COLUMN IF NOT EXISTS external_url    VARCHAR(1000) NULL;
ALTER TABLE study_material ADD COLUMN IF NOT EXISTS workflow_status VARCHAR(20) NOT NULL DEFAULT 'draft';
ALTER TABLE study_material DROP CONSTRAINT IF EXISTS study_material_workflow_status_check;
ALTER TABLE study_material ADD CONSTRAINT study_material_workflow_status_check
  CHECK (workflow_status IN ('draft','pending_approval','published','changes_requested','unpublished'));
ALTER TABLE study_material ADD COLUMN IF NOT EXISTS submitted_by   BIGINT NULL REFERENCES "user"(id);
ALTER TABLE study_material ADD COLUMN IF NOT EXISTS submitted_at   TIMESTAMPTZ NULL;
ALTER TABLE study_material ADD COLUMN IF NOT EXISTS reviewed_by    BIGINT NULL REFERENCES "user"(id);
ALTER TABLE study_material ADD COLUMN IF NOT EXISTS reviewed_at    TIMESTAMPTZ NULL;
ALTER TABLE study_material ADD COLUMN IF NOT EXISTS review_remarks TEXT NULL;
ALTER TABLE study_material ADD COLUMN IF NOT EXISTS published_by   BIGINT NULL REFERENCES "user"(id);
ALTER TABLE study_material ADD COLUMN IF NOT EXISTS published_at   TIMESTAMPTZ NULL;

-- Backfill the mirror from the legacy visibility (published -> published, else draft).
UPDATE study_material SET workflow_status = 'published'
 WHERE visibility = 'published' AND workflow_status = 'draft';

-- Migrate legacy `url` into external_url where it clearly is a link (kept `url` too for the
-- legacy screen). external_url is the new canonical link/YouTube slot.
UPDATE study_material SET external_url = url
 WHERE external_url IS NULL AND url IS NOT NULL AND file_r2_key IS NULL;

CREATE INDEX IF NOT EXISTS idx_material_wf ON study_material (workflow_status) WHERE deleted_at IS NULL;

-- Seed the content_approval ledger for existing material so the ledger mirrors the column.
DO $$
DECLARE v_org BIGINT; m RECORD;
BEGIN
  SELECT id INTO v_org FROM organisation ORDER BY id LIMIT 1;
  IF v_org IS NULL THEN RETURN; END IF;
  FOR m IN SELECT id, workflow_status, created_by FROM study_material WHERE deleted_at IS NULL LOOP
    INSERT INTO content_approval (org_id, entity_type, entity_id, workflow_status,
        published_by, published_at)
    VALUES (v_org, 'study_material', m.id, m.workflow_status,
        CASE WHEN m.workflow_status = 'published' THEN m.created_by ELSE NULL END,
        CASE WHEN m.workflow_status = 'published' THEN now() ELSE NULL END)
    ON CONFLICT (entity_type, entity_id) DO NOTHING;
  END LOOP;
END $$;

-- 2 ------------------------------------------------------------------ course_content (NEW)
CREATE TABLE IF NOT EXISTS course_content (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          BIGINT NOT NULL REFERENCES organisation(id),
  branch_id       BIGINT NOT NULL REFERENCES branch(id),
  vertical_id     BIGINT NOT NULL REFERENCES vertical(id),
  course_id       BIGINT NOT NULL REFERENCES m_course(id),
  batch_id        BIGINT NULL REFERENCES batch(id),
  title           VARCHAR(200) NOT NULL,
  module_no       INT NOT NULL DEFAULT 1,          -- module / unit ordering
  description     TEXT NULL,                        -- rich-text lesson body
  file_r2_key     VARCHAR(400) NULL,
  external_url    VARCHAR(1000) NULL,
  tags            TEXT[] NULL,
  workflow_status VARCHAR(20) NOT NULL DEFAULT 'draft'
                    CHECK (workflow_status IN ('draft','pending_approval','published','changes_requested','unpublished')),
  submitted_by    BIGINT NULL REFERENCES "user"(id),
  submitted_at    TIMESTAMPTZ NULL,
  reviewed_by     BIGINT NULL REFERENCES "user"(id),
  reviewed_at     TIMESTAMPTZ NULL,
  review_remarks  TEXT NULL,
  published_by    BIGINT NULL REFERENCES "user"(id),
  published_at    TIMESTAMPTZ NULL,
  created_by      BIGINT NULL REFERENCES "user"(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ NULL,
  deleted_by      BIGINT NULL REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS idx_coursecontent_scope  ON course_content (branch_id, vertical_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_coursecontent_course ON course_content (course_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_coursecontent_batch  ON course_content (batch_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_coursecontent_wf     ON course_content (workflow_status) WHERE deleted_at IS NULL;

-- 3 ------------------------------------------------------------------------ syllabus (NEW)
CREATE TABLE IF NOT EXISTS syllabus (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          BIGINT NOT NULL REFERENCES organisation(id),
  branch_id       BIGINT NOT NULL REFERENCES branch(id),
  vertical_id     BIGINT NOT NULL REFERENCES vertical(id),
  course_id       BIGINT NOT NULL REFERENCES m_course(id),
  batch_id        BIGINT NULL REFERENCES batch(id),
  title           VARCHAR(200) NOT NULL,
  version         VARCHAR(40) NOT NULL DEFAULT 'v1',
  body            TEXT NULL,                        -- outline (rich text or JSON of units)
  file_r2_key     VARCHAR(400) NULL,
  external_url    VARCHAR(1000) NULL,
  tags            TEXT[] NULL,
  workflow_status VARCHAR(20) NOT NULL DEFAULT 'draft'
                    CHECK (workflow_status IN ('draft','pending_approval','published','changes_requested','unpublished')),
  submitted_by    BIGINT NULL REFERENCES "user"(id),
  submitted_at    TIMESTAMPTZ NULL,
  reviewed_by     BIGINT NULL REFERENCES "user"(id),
  reviewed_at     TIMESTAMPTZ NULL,
  review_remarks  TEXT NULL,
  published_by    BIGINT NULL REFERENCES "user"(id),
  published_at    TIMESTAMPTZ NULL,
  created_by      BIGINT NULL REFERENCES "user"(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ NULL,
  deleted_by      BIGINT NULL REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS idx_syllabus_scope  ON syllabus (branch_id, vertical_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_syllabus_course ON syllabus (course_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_syllabus_wf     ON syllabus (workflow_status) WHERE deleted_at IS NULL;

-- 4 ---------------------------------------------------------------------- [DEMO] seed data
-- Guarded + idempotent (keyed on the [DEMO] title marker). Spreads items across two verticals
-- (IT + Language, whichever two distinct verticals with a course exist) in MIXED workflow states
-- so the tester sees every state + the published-only filter. The published R2-file material
-- points at an existing demo object (the Batch-A binary-tree PNG) so a presigned GET returns 200.
DO $$
DECLARE
  v_org BIGINT;
  it_branch BIGINT; it_vertical BIGINT; it_course BIGINT; it_batch BIGINT;
  lg_branch BIGINT; lg_vertical BIGINT; lg_course BIGINT; lg_batch BIGINT;
  new_id BIGINT;
BEGIN
  SELECT id INTO v_org FROM organisation ORDER BY id LIMIT 1;
  IF v_org IS NULL THEN RETURN; END IF;

  -- Primary (IT-ish) scope: first course with a resolvable branch/vertical.
  SELECT c.id, c.branch_id, c.vertical_id INTO it_course, it_branch, it_vertical
    FROM m_course c WHERE c.deleted_at IS NULL AND c.branch_id IS NOT NULL AND c.vertical_id IS NOT NULL
    ORDER BY c.id LIMIT 1;
  IF it_course IS NULL THEN RETURN; END IF;
  SELECT id INTO it_batch FROM batch WHERE course_id = it_course AND deleted_at IS NULL ORDER BY id LIMIT 1;

  -- Secondary (Language-ish) scope: a course under a DIFFERENT vertical, else reuse the primary.
  SELECT c.id, c.branch_id, c.vertical_id INTO lg_course, lg_branch, lg_vertical
    FROM m_course c WHERE c.deleted_at IS NULL AND c.branch_id IS NOT NULL AND c.vertical_id IS NOT NULL
      AND c.vertical_id <> it_vertical
    ORDER BY c.id LIMIT 1;
  IF lg_course IS NULL THEN
    lg_course := it_course; lg_branch := it_branch; lg_vertical := it_vertical;
  END IF;
  SELECT id INTO lg_batch FROM batch WHERE course_id = lg_course AND deleted_at IS NULL ORDER BY id LIMIT 1;

  -- (a) PUBLISHED study material — a YouTube link (external_url), IT scope, batch or course level.
  IF NOT EXISTS (SELECT 1 FROM study_material WHERE title = '[DEMO] Intro Video — Getting Started') THEN
    INSERT INTO study_material (org_id, branch_id, vertical_id, course_id, batch_id, title, description,
        material_type, url, external_url, tags, access_level, visibility, allow_parents, workflow_status,
        published_at, created_by)
    VALUES (v_org, it_branch, it_vertical, it_course, it_batch, '[DEMO] Intro Video — Getting Started',
        'A short welcome / orientation video for new students.', 'video',
        'https://www.youtube.com/watch?v=Ke90Tje7VS0', 'https://www.youtube.com/watch?v=Ke90Tje7VS0',
        'demo,orientation', CASE WHEN it_batch IS NOT NULL THEN 'batch' ELSE 'course' END,
        'published', TRUE, 'published', now(), NULL)
    RETURNING id INTO new_id;
    INSERT INTO content_approval (org_id, entity_type, entity_id, workflow_status, published_at)
      VALUES (v_org, 'study_material', new_id, 'published', now())
      ON CONFLICT (entity_type, entity_id) DO UPDATE SET workflow_status = 'published';
  END IF;

  -- (b) PUBLISHED study material — an R2-backed document (points at an existing demo object).
  IF NOT EXISTS (SELECT 1 FROM study_material WHERE title = '[DEMO] Course Handbook (PDF)') THEN
    INSERT INTO study_material (org_id, branch_id, vertical_id, course_id, batch_id, title, description,
        material_type, file_r2_key, tags, access_level, visibility, allow_parents, workflow_status,
        published_at, created_by)
    VALUES (v_org, it_branch, it_vertical, it_course, it_batch, '[DEMO] Course Handbook (PDF)',
        'The uploaded course handbook (stored in Cloudflare R2).', 'document',
        'questions/media/demo/binary-tree-diagram.png', 'demo,handbook',
        CASE WHEN it_batch IS NOT NULL THEN 'batch' ELSE 'course' END, 'published', FALSE, 'published', now(), NULL)
    RETURNING id INTO new_id;
    INSERT INTO content_approval (org_id, entity_type, entity_id, workflow_status, published_at)
      VALUES (v_org, 'study_material', new_id, 'published', now())
      ON CONFLICT (entity_type, entity_id) DO UPDATE SET workflow_status = 'published';
  END IF;

  -- (c) PENDING_APPROVAL course content — Language scope (submitted, awaiting an Academic Admin).
  IF NOT EXISTS (SELECT 1 FROM course_content WHERE title = '[DEMO] Module 1 — Foundations') THEN
    INSERT INTO course_content (org_id, branch_id, vertical_id, course_id, batch_id, title, module_no,
        description, tags, workflow_status, submitted_at, created_by)
    VALUES (v_org, lg_branch, lg_vertical, lg_course, lg_batch, '[DEMO] Module 1 — Foundations', 1,
        'Unit 1 lesson content — grammar foundations and warm-up exercises.', ARRAY['demo','module-1'],
        'pending_approval', now(), NULL)
    RETURNING id INTO new_id;
    INSERT INTO content_approval (org_id, entity_type, entity_id, workflow_status, submitted_at)
      VALUES (v_org, 'course_content', new_id, 'pending_approval', now())
      ON CONFLICT (entity_type, entity_id) DO UPDATE SET workflow_status = 'pending_approval';
  END IF;

  -- (d) DRAFT syllabus — IT scope (still being drafted by a trainer).
  IF NOT EXISTS (SELECT 1 FROM syllabus WHERE title = '[DEMO] Full Course Syllabus') THEN
    INSERT INTO syllabus (org_id, branch_id, vertical_id, course_id, batch_id, title, version, body,
        tags, workflow_status, created_by)
    VALUES (v_org, it_branch, it_vertical, it_course, it_batch, '[DEMO] Full Course Syllabus', 'v1',
        E'Unit 1: Introduction\nUnit 2: Core concepts\nUnit 3: Practicals\nUnit 4: Assessment & certification',
        ARRAY['demo','syllabus'], 'draft', NULL)
    RETURNING id INTO new_id;
    INSERT INTO content_approval (org_id, entity_type, entity_id, workflow_status)
      VALUES (v_org, 'syllabus', new_id, 'draft')
      ON CONFLICT (entity_type, entity_id) DO NOTHING;
  END IF;
END $$;
