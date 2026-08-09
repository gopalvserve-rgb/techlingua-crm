-- =============================================================================
-- 048 — ERP LEARNING (Phase 2, Batch 2)
--
-- Three learning modules on top of the Phase-2 student + batch + academics tables:
--   1) STUDY MATERIAL — a per-batch / per-course / per-vertical library of items (video /
--      link / document / note) with an access LEVEL that decides which students see a
--      published item, plus an allow_parents flag for the parent share view.
--   2) CERTIFICATES — completion / participation / merit certificates issued to a student,
--      serial from the numbering series (kind 'certificate'), issue/reissue/revoke, branded
--      PDF (reuses the quotation/receipt PDF pipeline).
--   3) REPORT CARD — a per-student, per-term academic-progress snapshot computed from the
--      Batch-1 attendance %, test scores and assignment grades (India grading bands), with a
--      report-card PDF and a tokenised PARENT VIEW (a shareable, login-free read of the card
--      + attendance + the parent-visible study material for the child's batch/course).
--
-- Scope: every row DENORMALISES branch_id + vertical_id (+ course_id) so the ScopeResolver
-- filters them like every other module. Idempotent (IF NOT EXISTS / ON CONFLICT). Re-runnable.
-- =============================================================================

-- 1) study_material -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS study_material (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         BIGINT NOT NULL REFERENCES organisation(id),
  branch_id      BIGINT NOT NULL REFERENCES branch(id),
  vertical_id    BIGINT NOT NULL REFERENCES vertical(id),
  course_id      BIGINT NULL REFERENCES m_course(id),
  batch_id       BIGINT NULL REFERENCES batch(id),
  title          VARCHAR(200) NOT NULL,
  description    TEXT NULL,
  material_type  VARCHAR(16) NOT NULL DEFAULT 'link'
                   CHECK (material_type IN ('video', 'link', 'document', 'note')),
  url            VARCHAR(1000) NULL,
  body           TEXT NULL,
  tags           VARCHAR(300) NULL,
  access_level   VARCHAR(16) NOT NULL DEFAULT 'batch'
                   CHECK (access_level IN ('batch', 'course', 'vertical')),
  visibility     VARCHAR(16) NOT NULL DEFAULT 'draft'
                   CHECK (visibility IN ('draft', 'published')),
  allow_parents  BOOLEAN NOT NULL DEFAULT FALSE,
  created_by     BIGINT NULL REFERENCES "user"(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ NULL,
  deleted_by     BIGINT NULL REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS idx_material_scope  ON study_material (branch_id, vertical_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_material_batch  ON study_material (batch_id)  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_material_course ON study_material (course_id) WHERE deleted_at IS NULL;

-- 2) certificate --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS certificate (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         BIGINT NOT NULL REFERENCES organisation(id),
  student_id     BIGINT NOT NULL REFERENCES student(id),
  branch_id      BIGINT NOT NULL REFERENCES branch(id),
  vertical_id    BIGINT NOT NULL REFERENCES vertical(id),
  course_id      BIGINT NULL REFERENCES m_course(id),
  batch_id       BIGINT NULL REFERENCES batch(id),
  serial_no      VARCHAR(64) NOT NULL,
  cert_type      VARCHAR(20) NOT NULL DEFAULT 'completion'
                   CHECK (cert_type IN ('completion', 'participation', 'merit', 'other')),
  title          VARCHAR(200) NOT NULL,
  issue_date     DATE NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Kolkata')::date,
  status         VARCHAR(16) NOT NULL DEFAULT 'issued'
                   CHECK (status IN ('issued', 'revoked')),
  remarks        TEXT NULL,
  issued_by      BIGINT NULL REFERENCES "user"(id),
  revoked_at     TIMESTAMPTZ NULL,
  revoked_by     BIGINT NULL REFERENCES "user"(id),
  revoke_reason  TEXT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ NULL,
  deleted_by     BIGINT NULL REFERENCES "user"(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_certificate_serial ON certificate (org_id, serial_no) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_certificate_student ON certificate (student_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_certificate_scope   ON certificate (branch_id, vertical_id) WHERE deleted_at IS NULL;

-- 3) report_card --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS report_card (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id           BIGINT NOT NULL REFERENCES organisation(id),
  student_id       BIGINT NOT NULL REFERENCES student(id),
  branch_id        BIGINT NOT NULL REFERENCES branch(id),
  vertical_id      BIGINT NOT NULL REFERENCES vertical(id),
  course_id        BIGINT NULL REFERENCES m_course(id),
  batch_id         BIGINT NULL REFERENCES batch(id),
  term             VARCHAR(80) NOT NULL,
  period_from      DATE NULL,
  period_to        DATE NULL,
  attendance_pct   NUMERIC(5,1) NULL,
  attendance_present INT NULL,
  attendance_total   INT NULL,
  test_avg_pct     NUMERIC(5,1) NULL,
  test_count       INT NULL,
  assignment_avg_pct NUMERIC(5,1) NULL,
  assignment_count INT NULL,
  overall_pct      NUMERIC(5,1) NULL,
  overall_grade    VARCHAR(4) NULL,
  remarks          TEXT NULL,
  status           VARCHAR(16) NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'published')),
  share_token      VARCHAR(48) NULL,
  generated_by     BIGINT NULL REFERENCES "user"(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ NULL,
  deleted_by       BIGINT NULL REFERENCES "user"(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_report_card_term  ON report_card (student_id, lower(term)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_report_card_token ON report_card (share_token) WHERE share_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_report_card_scope ON report_card (branch_id, vertical_id) WHERE deleted_at IS NULL;

-- 4) Numbering — 'certificate' (CERT-) is created lazily by NumberingService (KIND_DEFAULTS).

-- 5) Permissions --------------------------------------------------------------
INSERT INTO permission (key, module, action) VALUES
  ('material.read',      'material', 'read'),
  ('material.create',    'material', 'create'),
  ('material.update',    'material', 'update'),
  ('material.delete',    'material', 'delete'),
  ('certificate.read',   'certificate', 'read'),
  ('certificate.issue',  'certificate', 'issue'),
  ('certificate.revoke', 'certificate', 'revoke'),
  ('certificate.delete', 'certificate', 'delete'),
  ('reportcard.read',    'reportcard', 'read'),
  ('reportcard.create',  'reportcard', 'create'),
  ('reportcard.delete',  'reportcard', 'delete')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('material.read',      'Super Admin',        'all'),
      ('material.read',      'Organization Admin', 'all'),
      ('material.read',      'Branch Manager',     'branch'),
      ('material.read',      'Vertical Manager',   'vertical'),
      ('material.read',      'Team Leader',        'team'),
      ('material.read',      'Counsellor',         'own'),
      ('material.create',    'Super Admin',        'all'),
      ('material.create',    'Organization Admin', 'all'),
      ('material.create',    'Branch Manager',     'branch'),
      ('material.create',    'Vertical Manager',   'vertical'),
      ('material.create',    'Team Leader',        'team'),
      ('material.update',    'Super Admin',        'all'),
      ('material.update',    'Organization Admin', 'all'),
      ('material.update',    'Branch Manager',     'branch'),
      ('material.update',    'Vertical Manager',   'vertical'),
      ('material.delete',    'Super Admin',        'all'),
      ('material.delete',    'Organization Admin', 'all'),
      ('material.delete',    'Branch Manager',     'branch'),
      ('certificate.read',   'Super Admin',        'all'),
      ('certificate.read',   'Organization Admin', 'all'),
      ('certificate.read',   'Branch Manager',     'branch'),
      ('certificate.read',   'Vertical Manager',   'vertical'),
      ('certificate.read',   'Team Leader',        'team'),
      ('certificate.read',   'Counsellor',         'own'),
      ('certificate.issue',  'Super Admin',        'all'),
      ('certificate.issue',  'Organization Admin', 'all'),
      ('certificate.issue',  'Branch Manager',     'branch'),
      ('certificate.issue',  'Vertical Manager',   'vertical'),
      ('certificate.revoke', 'Super Admin',        'all'),
      ('certificate.revoke', 'Organization Admin', 'all'),
      ('certificate.revoke', 'Branch Manager',     'branch'),
      ('certificate.delete', 'Super Admin',        'all'),
      ('certificate.delete', 'Organization Admin', 'all'),
      ('certificate.delete', 'Branch Manager',     'branch'),
      ('reportcard.read',    'Super Admin',        'all'),
      ('reportcard.read',    'Organization Admin', 'all'),
      ('reportcard.read',    'Branch Manager',     'branch'),
      ('reportcard.read',    'Vertical Manager',   'vertical'),
      ('reportcard.read',    'Team Leader',        'team'),
      ('reportcard.read',    'Counsellor',         'own'),
      ('reportcard.create',  'Super Admin',        'all'),
      ('reportcard.create',  'Organization Admin', 'all'),
      ('reportcard.create',  'Branch Manager',     'branch'),
      ('reportcard.create',  'Vertical Manager',   'vertical'),
      ('reportcard.create',  'Team Leader',        'team'),
      ('reportcard.delete',  'Super Admin',        'all'),
      ('reportcard.delete',  'Organization Admin', 'all'),
      ('reportcard.delete',  'Branch Manager',     'branch')
    ) AS v(pkey, role_name, scope)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope
      FROM role ro, permission p
     WHERE ro.name = r.role_name AND p.key = r.pkey
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;
