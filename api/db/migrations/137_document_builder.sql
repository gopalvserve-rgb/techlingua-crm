-- =============================================================================
-- 137 — DOCUMENT BUILDER for every template (client 12 Nov 2026, "In Template setup … need to
-- create builder to customise fields")
--
--   doc_builder_template          a document design: type, name, where it applies (organisation /
--                                 branch / vertical / course — the most specific published match
--                                 wins), default flag, status (draft → pending approval →
--                                 published / unpublished), effective date, the draft config
--   doc_builder_template_version  every PUBLISHED design, immutable (version control / restore)
--   doc_builder_audit             who created, edited, submitted, approved, rejected, published,
--                                 cloned, set default, restored or deleted a template
--   doc_verification              one public verification code per issued document (QR)
--
-- The Fee Invoice keeps its own builder (131). Existing documents keep their built-in layout
-- until a builder template is published for them.
-- Permissions: doctemplate.read / manage / approve / override (override = pick a different
-- template for one document at print time).
-- =============================================================================

CREATE TABLE IF NOT EXISTS doc_builder_template (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id                BIGINT NOT NULL REFERENCES organisation(id),
  doc_type              VARCHAR(32) NOT NULL,
  name                  VARCHAR(120) NOT NULL,
  branch_id             BIGINT NULL REFERENCES branch(id),
  vertical_id           BIGINT NULL REFERENCES vertical(id),
  course_id             BIGINT NULL REFERENCES m_course(id),
  is_default            BOOLEAN NOT NULL DEFAULT FALSE,
  status                VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'published', 'unpublished')),
  effective_from        DATE NULL,
  config                JSONB NOT NULL DEFAULT '{}',
  published_version_id  BIGINT NULL,
  submitted_by          BIGINT NULL REFERENCES "user"(id),
  submitted_at          TIMESTAMPTZ NULL,
  reviewed_by           BIGINT NULL REFERENCES "user"(id),
  reviewed_at           TIMESTAMPTZ NULL,
  review_note           VARCHAR(300) NULL,
  cloned_from_id        BIGINT NULL,
  created_by            BIGINT NULL REFERENCES "user"(id),
  updated_by            BIGINT NULL REFERENCES "user"(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at            TIMESTAMPTZ NULL,
  deleted_by            BIGINT NULL
);
CREATE INDEX IF NOT EXISTS ix_dbt_type ON doc_builder_template (doc_type) WHERE deleted_at IS NULL;
-- one DEFAULT per (type, scope)
CREATE UNIQUE INDEX IF NOT EXISTS uq_dbt_default
  ON doc_builder_template (org_id, doc_type, COALESCE(branch_id, 0), COALESCE(vertical_id, 0), COALESCE(course_id, 0))
  WHERE is_default AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS doc_builder_template_version (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  template_id    BIGINT NOT NULL REFERENCES doc_builder_template(id) ON DELETE CASCADE,
  version_no     INT NOT NULL,
  config         JSONB NOT NULL,
  effective_from DATE NULL,
  note           VARCHAR(300) NULL,
  published_by   BIGINT NULL REFERENCES "user"(id),
  published_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (template_id, version_no)
);

CREATE TABLE IF NOT EXISTS doc_builder_audit (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  template_id  BIGINT NOT NULL REFERENCES doc_builder_template(id) ON DELETE CASCADE,
  action       VARCHAR(24) NOT NULL,
  actor_id     BIGINT NULL REFERENCES "user"(id),
  note         VARCHAR(300) NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_dba_tpl ON doc_builder_audit (template_id, created_at DESC);

CREATE TABLE IF NOT EXISTS doc_verification (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id               BIGINT NOT NULL REFERENCES organisation(id),
  code                 VARCHAR(24) NOT NULL UNIQUE,
  doc_type             VARCHAR(32) NOT NULL,
  ref_id               BIGINT NOT NULL,
  title                VARCHAR(120) NULL,
  holder               VARCHAR(160) NULL,
  doc_no               VARCHAR(80) NULL,
  institute            VARCHAR(160) NULL,
  details              JSONB NOT NULL DEFAULT '{}',
  template_version_id  BIGINT NULL REFERENCES doc_builder_template_version(id),
  issued_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (doc_type, ref_id)
);

INSERT INTO permission (key, module, action) VALUES
  ('doctemplate.read', 'doctemplate', 'read'),
  ('doctemplate.manage', 'doctemplate', 'manage'),
  ('doctemplate.approve', 'doctemplate', 'approve'),
  ('doctemplate.override', 'doctemplate', 'override')
ON CONFLICT (key) DO NOTHING;

-- New grants only (existing grants are never changed): admins get all four; branch / vertical
-- managers may read the templates that print their documents.
INSERT INTO role_permission (role_id, permission_id, record_scope)
SELECT r.id, p.id, 'all'
  FROM role r CROSS JOIN permission p
 WHERE r.name IN ('Super Admin', 'Organization Admin')
   AND p.key IN ('doctemplate.read', 'doctemplate.manage', 'doctemplate.approve', 'doctemplate.override')
ON CONFLICT (role_id, permission_id) DO NOTHING;
INSERT INTO role_permission (role_id, permission_id, record_scope)
SELECT r.id, p.id, CASE r.name WHEN 'Branch Manager' THEN 'branch' ELSE 'vertical' END
  FROM role r CROSS JOIN permission p
 WHERE r.name IN ('Branch Manager', 'Vertical Manager') AND p.key = 'doctemplate.read'
ON CONFLICT (role_id, permission_id) DO NOTHING;
