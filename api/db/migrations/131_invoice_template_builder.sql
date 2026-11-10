-- ============================================================================
-- 131 - FEE INVOICE TEMPLATE BUILDER (client 5 Nov 2026, "Template Setting For Fee Invoice")
--
-- A Super Admin designs the whole fee invoice: page, branding, which fields show and in what
-- order, the fee-table columns, the totals block, payment details, footer and terms. Templates are
-- separate from invoices (the client's own architecture rule):
--
--   invoice_template          the design being edited (config = draft), global or per branch
--   invoice_template_version  every PUBLISHED design, immutable; restore = copy back to the draft
--   gst_invoice.template_version_id
--                             stamped when an invoice is ISSUED, so editing or republishing a
--                             template never changes an invoice that was already issued.
--                             NULL on invoices issued before this migration: they keep the
--                             built-in layout they were issued with.
--
-- Numbering and every money figure stay with the finance module; a template only lays them out.
-- ============================================================================

CREATE TABLE IF NOT EXISTS invoice_template (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id           BIGINT NOT NULL REFERENCES organisation(id),
  name             VARCHAR(120) NOT NULL,
  branch_id        BIGINT NULL REFERENCES branch(id),          -- NULL = global
  is_default       BOOLEAN NOT NULL DEFAULT FALSE,
  status           VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'unpublished')),
  config           JSONB NOT NULL DEFAULT '{}',                  -- the draft being edited
  published_version_id BIGINT NULL,
  created_by       BIGINT NULL REFERENCES "user"(id),
  updated_by       BIGINT NULL REFERENCES "user"(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ NULL,
  deleted_by       BIGINT NULL
);
-- one DEFAULT per scope (global, or one branch)
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_template_default
  ON invoice_template (org_id, COALESCE(branch_id, 0)) WHERE is_default AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS invoice_template_version (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  template_id   BIGINT NOT NULL REFERENCES invoice_template(id) ON DELETE CASCADE,
  version_no    INT NOT NULL,
  config        JSONB NOT NULL,
  note          VARCHAR(300) NULL,
  published_by  BIGINT NULL REFERENCES "user"(id),
  published_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (template_id, version_no)
);

ALTER TABLE gst_invoice ADD COLUMN IF NOT EXISTS template_version_id BIGINT NULL REFERENCES invoice_template_version(id);
