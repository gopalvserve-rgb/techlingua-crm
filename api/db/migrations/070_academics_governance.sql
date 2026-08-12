-- =============================================================================
-- 070 — ACADEMICS GOVERNANCE · BATCH 1
--
-- Client rule: "Trainer -> Draft -> Submit for Approval -> Academic Admin -> Published.
-- Don't allow every trainer to immediately publish content globally." Academic Admin can
-- create/change batches and approve/publish everything students see; a Trainer drafts +
-- submits, manages attendance and published academic activity, but CANNOT publish/approve.
--
-- Lays the reusable foundation Batch 2 (study material / course content / syllabus) reuses:
--   1) New permissions: a generic `*.submit` + `*.approve`/publish gate for governed content,
--      wired for assessment now and pre-declared for Batch-2 entities.
--   2) A NEW system role `Academic Admin` (is_system) + a re-grant of the existing `Trainer`
--      role to the governance model (adds batch.read/attendance/draft+submit; REVOKES
--      assessment.publish + assessment_certificate.issue).
--   3) A SINGLE reusable ledger `content_approval` (entity_type, entity_id) = workflow_status
--      + review metadata for EVERY governed entity. Transition history reuses `audit_log`.
--   4) Assessment gets `pending_approval` in its native status flow + review-metadata columns.
--   5) Results release gate: assessment_attempt.results_released_{at,by}.
-- Idempotent throughout (IF NOT EXISTS / ON CONFLICT DO NOTHING / guarded).
-- =============================================================================

-- 1 -------------------------------------------------------------- new permissions
INSERT INTO permission (key, module, action) VALUES
  ('assessment.submit',        'assessment',     'submit'),
  ('results.publish',          'results',        'publish'),
  ('results.read',             'results',        'read'),
  ('material.submit',          'material',       'submit'),
  ('material.approve',         'material',       'approve'),
  ('course_content.read',      'course_content', 'read'),
  ('course_content.create',    'course_content', 'create'),
  ('course_content.update',    'course_content', 'update'),
  ('course_content.delete',    'course_content', 'delete'),
  ('course_content.submit',    'course_content', 'submit'),
  ('course_content.approve',   'course_content', 'approve'),
  ('syllabus.read',            'syllabus',       'read'),
  ('syllabus.create',          'syllabus',       'create'),
  ('syllabus.update',          'syllabus',       'update'),
  ('syllabus.delete',          'syllabus',       'delete'),
  ('syllabus.submit',          'syllabus',       'submit'),
  ('syllabus.approve',         'syllabus',       'approve')
ON CONFLICT (key) DO NOTHING;

-- 2 --------------------------------------------- the Academic Admin system role (per org)
DO $$
DECLARE o RECORD;
BEGIN
  FOR o IN SELECT id FROM organisation LOOP
    INSERT INTO role (org_id, name, is_system, description)
    SELECT o.id, 'Academic Admin', TRUE,
           'System role: Academic Admin - full academics authority (create/change batches; approve & publish all content students see; publish results & issue certificates; manage attendance).'
    WHERE NOT EXISTS (SELECT 1 FROM role WHERE org_id = o.id AND name = 'Academic Admin');
  END LOOP;
END $$;

-- 3 ------------------------------------------------------------ role grants
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- ---- Academic Admin (branch scope) ----
      ('dashboard.read',                 'Academic Admin', 'branch'),
      ('master.read',                    'Academic Admin', 'branch'),
      ('notification.read',              'Academic Admin', 'branch'),
      ('student.read',                   'Academic Admin', 'branch'),
      ('student.update',                 'Academic Admin', 'branch'),
      ('batch.read',                     'Academic Admin', 'branch'),
      ('batch.create',                   'Academic Admin', 'branch'),
      ('batch.update',                   'Academic Admin', 'branch'),
      ('batch.delete',                   'Academic Admin', 'branch'),
      ('attendance.read',                'Academic Admin', 'branch'),
      ('attendance.mark',                'Academic Admin', 'branch'),
      ('attendance.manage',              'Academic Admin', 'branch'),
      ('test.read',                      'Academic Admin', 'branch'),
      ('test.create',                    'Academic Admin', 'branch'),
      ('test.update',                    'Academic Admin', 'branch'),
      ('test.delete',                    'Academic Admin', 'branch'),
      ('test.grade',                     'Academic Admin', 'branch'),
      ('coursework.read',                'Academic Admin', 'branch'),
      ('coursework.create',              'Academic Admin', 'branch'),
      ('coursework.update',              'Academic Admin', 'branch'),
      ('coursework.delete',              'Academic Admin', 'branch'),
      ('coursework.grade',               'Academic Admin', 'branch'),
      ('question_category.read',         'Academic Admin', 'branch'),
      ('question_category.create',       'Academic Admin', 'branch'),
      ('question_category.update',       'Academic Admin', 'branch'),
      ('question_category.delete',       'Academic Admin', 'branch'),
      ('question.read',                  'Academic Admin', 'branch'),
      ('question.create',                'Academic Admin', 'branch'),
      ('question.update',                'Academic Admin', 'branch'),
      ('question.delete',                'Academic Admin', 'branch'),
      ('question.import',                'Academic Admin', 'branch'),
      ('assessment.read',                'Academic Admin', 'branch'),
      ('assessment.create',              'Academic Admin', 'branch'),
      ('assessment.update',              'Academic Admin', 'branch'),
      ('assessment.delete',              'Academic Admin', 'branch'),
      ('assessment.submit',              'Academic Admin', 'branch'),
      ('assessment.publish',             'Academic Admin', 'branch'),
      ('assessment.evaluate',            'Academic Admin', 'branch'),
      ('assessment_template.read',       'Academic Admin', 'branch'),
      ('assessment_template.create',     'Academic Admin', 'branch'),
      ('assessment_template.update',     'Academic Admin', 'branch'),
      ('assessment_template.delete',     'Academic Admin', 'branch'),
      ('assessment_attempt.read',        'Academic Admin', 'branch'),
      ('assessment_attempt.create',      'Academic Admin', 'branch'),
      ('assessment_attempt.update',      'Academic Admin', 'branch'),
      ('assessment_attempt.delete',      'Academic Admin', 'branch'),
      ('assignment_submission.read',     'Academic Admin', 'branch'),
      ('assignment_submission.create',   'Academic Admin', 'branch'),
      ('assignment_submission.update',   'Academic Admin', 'branch'),
      ('assignment_submission.delete',   'Academic Admin', 'branch'),
      ('results.read',                   'Academic Admin', 'branch'),
      ('results.publish',                'Academic Admin', 'branch'),
      ('grade_scheme.read',              'Academic Admin', 'branch'),
      ('grade_scheme.create',            'Academic Admin', 'branch'),
      ('grade_scheme.update',            'Academic Admin', 'branch'),
      ('assessment_certificate.read',    'Academic Admin', 'branch'),
      ('assessment_certificate.issue',   'Academic Admin', 'branch'),
      ('assessment_certificate.revoke',  'Academic Admin', 'branch'),
      ('assessment_certificate.delete',  'Academic Admin', 'branch'),
      ('material.read',                  'Academic Admin', 'branch'),
      ('material.create',                'Academic Admin', 'branch'),
      ('material.update',                'Academic Admin', 'branch'),
      ('material.delete',                'Academic Admin', 'branch'),
      ('material.submit',                'Academic Admin', 'branch'),
      ('material.approve',               'Academic Admin', 'branch'),
      ('certificate.read',               'Academic Admin', 'branch'),
      ('certificate.issue',              'Academic Admin', 'branch'),
      ('certificate.revoke',             'Academic Admin', 'branch'),
      ('reportcard.read',                'Academic Admin', 'branch'),
      ('reportcard.create',              'Academic Admin', 'branch'),
      ('course_content.read',            'Academic Admin', 'branch'),
      ('course_content.create',          'Academic Admin', 'branch'),
      ('course_content.update',          'Academic Admin', 'branch'),
      ('course_content.delete',          'Academic Admin', 'branch'),
      ('course_content.submit',          'Academic Admin', 'branch'),
      ('course_content.approve',         'Academic Admin', 'branch'),
      ('syllabus.read',                  'Academic Admin', 'branch'),
      ('syllabus.create',                'Academic Admin', 'branch'),
      ('syllabus.update',                'Academic Admin', 'branch'),
      ('syllabus.delete',                'Academic Admin', 'branch'),
      ('syllabus.submit',                'Academic Admin', 'branch'),
      ('syllabus.approve',               'Academic Admin', 'branch'),
      -- ---- Trainer ADDITIONS (branch) — teaching + academic activity, draft+submit ----
      ('batch.read',                     'Trainer', 'branch'),
      ('student.read',                   'Trainer', 'branch'),
      ('attendance.read',                'Trainer', 'branch'),
      ('attendance.mark',                'Trainer', 'branch'),
      ('test.read',                      'Trainer', 'branch'),
      ('test.create',                    'Trainer', 'branch'),
      ('test.update',                    'Trainer', 'branch'),
      ('test.grade',                     'Trainer', 'branch'),
      ('coursework.read',                'Trainer', 'branch'),
      ('coursework.create',              'Trainer', 'branch'),
      ('coursework.update',              'Trainer', 'branch'),
      ('coursework.grade',               'Trainer', 'branch'),
      ('assessment.submit',              'Trainer', 'branch'),
      ('results.read',                   'Trainer', 'branch'),
      ('reportcard.read',                'Trainer', 'branch'),
      ('certificate.read',               'Trainer', 'branch'),
      ('material.read',                  'Trainer', 'branch'),
      ('material.create',                'Trainer', 'branch'),
      ('material.update',                'Trainer', 'branch'),
      ('material.submit',                'Trainer', 'branch'),
      ('course_content.read',            'Trainer', 'branch'),
      ('course_content.create',          'Trainer', 'branch'),
      ('course_content.update',          'Trainer', 'branch'),
      ('course_content.submit',          'Trainer', 'branch'),
      ('syllabus.read',                  'Trainer', 'branch'),
      ('syllabus.create',                'Trainer', 'branch'),
      ('syllabus.update',                'Trainer', 'branch'),
      ('syllabus.submit',                'Trainer', 'branch'),
      -- ---- Super Admin + Organization Admin get every NEW permission @ all ----
      ('assessment.submit',        'Super Admin',        'all'),
      ('assessment.submit',        'Organization Admin', 'all'),
      ('results.publish',          'Super Admin',        'all'),
      ('results.publish',          'Organization Admin', 'all'),
      ('results.read',             'Super Admin',        'all'),
      ('results.read',             'Organization Admin', 'all'),
      ('material.submit',          'Super Admin',        'all'),
      ('material.submit',          'Organization Admin', 'all'),
      ('material.approve',         'Super Admin',        'all'),
      ('material.approve',         'Organization Admin', 'all'),
      ('course_content.read',      'Super Admin',        'all'),
      ('course_content.read',      'Organization Admin', 'all'),
      ('course_content.create',    'Super Admin',        'all'),
      ('course_content.create',    'Organization Admin', 'all'),
      ('course_content.update',    'Super Admin',        'all'),
      ('course_content.update',    'Organization Admin', 'all'),
      ('course_content.delete',    'Super Admin',        'all'),
      ('course_content.delete',    'Organization Admin', 'all'),
      ('course_content.submit',    'Super Admin',        'all'),
      ('course_content.submit',    'Organization Admin', 'all'),
      ('course_content.approve',   'Super Admin',        'all'),
      ('course_content.approve',   'Organization Admin', 'all'),
      ('syllabus.read',            'Super Admin',        'all'),
      ('syllabus.read',            'Organization Admin', 'all'),
      ('syllabus.create',          'Super Admin',        'all'),
      ('syllabus.create',          'Organization Admin', 'all'),
      ('syllabus.update',          'Super Admin',        'all'),
      ('syllabus.update',          'Organization Admin', 'all'),
      ('syllabus.delete',          'Super Admin',        'all'),
      ('syllabus.delete',          'Organization Admin', 'all'),
      ('syllabus.submit',          'Super Admin',        'all'),
      ('syllabus.submit',          'Organization Admin', 'all'),
      ('syllabus.approve',         'Super Admin',        'all'),
      ('syllabus.approve',         'Organization Admin', 'all')
    ) AS v(pkey, role_name, scope)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope
      FROM role ro, permission p
     WHERE ro.name = r.role_name AND p.key = r.pkey
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;

-- 3b -------------------------------------- REVOKE global publish authority from Trainer
DELETE FROM role_permission
 WHERE role_id IN (SELECT id FROM role WHERE name = 'Trainer')
   AND permission_id IN (SELECT id FROM permission
                          WHERE key IN ('assessment.publish', 'assessment_certificate.issue'));

-- 4 -------------------------------------------------- reusable content_approval ledger
CREATE TABLE IF NOT EXISTS content_approval (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          BIGINT NOT NULL REFERENCES organisation(id),
  entity_type     VARCHAR(40) NOT NULL,
  entity_id       BIGINT NOT NULL,
  workflow_status VARCHAR(20) NOT NULL DEFAULT 'draft'
                    CHECK (workflow_status IN ('draft','pending_approval','published','changes_requested','unpublished')),
  submitted_by    BIGINT NULL REFERENCES "user"(id),
  submitted_at    TIMESTAMPTZ NULL,
  reviewed_by     BIGINT NULL REFERENCES "user"(id),
  reviewed_at     TIMESTAMPTZ NULL,
  review_remarks  TEXT NULL,
  published_by    BIGINT NULL REFERENCES "user"(id),
  published_at    TIMESTAMPTZ NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_content_approval_lookup ON content_approval (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_content_approval_status ON content_approval (entity_type, workflow_status);

-- 5 ------------------------------------ assessment: pending_approval + review metadata
ALTER TABLE assessment ALTER COLUMN status TYPE VARCHAR(20);
ALTER TABLE assessment DROP CONSTRAINT IF EXISTS assessment_status_check;
ALTER TABLE assessment ADD CONSTRAINT assessment_status_check
  CHECK (status IN ('draft','pending_approval','published','closed'));
ALTER TABLE assessment ADD COLUMN IF NOT EXISTS submitted_by   BIGINT NULL REFERENCES "user"(id);
ALTER TABLE assessment ADD COLUMN IF NOT EXISTS submitted_at   TIMESTAMPTZ NULL;
ALTER TABLE assessment ADD COLUMN IF NOT EXISTS reviewed_by    BIGINT NULL REFERENCES "user"(id);
ALTER TABLE assessment ADD COLUMN IF NOT EXISTS reviewed_at    TIMESTAMPTZ NULL;
ALTER TABLE assessment ADD COLUMN IF NOT EXISTS review_remarks TEXT NULL;
ALTER TABLE assessment ADD COLUMN IF NOT EXISTS published_by   BIGINT NULL REFERENCES "user"(id);

-- 6 ----------------------------------- results release gate on the student's attempt
ALTER TABLE assessment_attempt ADD COLUMN IF NOT EXISTS results_released_at TIMESTAMPTZ NULL;
ALTER TABLE assessment_attempt ADD COLUMN IF NOT EXISTS results_released_by BIGINT NULL REFERENCES "user"(id);

-- 6b -- Grandfather EXISTING evaluated attempts as already-released so live students do not
-- suddenly lose visibility of results they could already see. Only NEW evaluations (from now)
-- require an explicit Academic-Admin release.
UPDATE assessment_attempt
   SET results_released_at = COALESCE(results_released_at, evaluated_at, submitted_at, now())
 WHERE status = 'evaluated' AND results_released_at IS NULL;
