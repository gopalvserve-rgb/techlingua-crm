-- =============================================================================
-- 116 — DOCUMENT TEMPLATE SETUP (28aug, item 5)
-- Admin-configurable templates/formats for the org's printed & generated documents.
-- One row per template TYPE; `settings` is a free JSON blob the relevant generator reads
-- (header/title, logo toggle, footer/terms text; for ID cards the ID number format; for
-- documents which fields show + a notes/terms block). Reachable from Administration.
-- Seeded with the 7 default templates so the Template Setup screen is populated on boot.
-- =============================================================================
CREATE TABLE IF NOT EXISTS document_template (
  id           BIGSERIAL PRIMARY KEY,
  org_id       BIGINT NOT NULL REFERENCES organisation(id),
  type         VARCHAR(48) NOT NULL,
  name         VARCHAR(120) NOT NULL,
  settings     JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by   BIGINT NULL REFERENCES "user"(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_document_template_org_type
  ON document_template (org_id, type);

-- Seed the 7 default templates for the (single-tenant) organisation. Idempotent.
INSERT INTO document_template (org_id, type, name, settings)
SELECT o.id, t.type, t.name, t.settings::jsonb
  FROM organisation o
  CROSS JOIN (VALUES
    ('fee_invoice',  'Fee Invoice',  '{"header_title":"Fee Invoice (Tax Invoice)","show_logo":true,"footer_text":"","terms":"Fees once paid are non-refundable except per the refund policy.","fields":{"gstin":true,"place_of_supply":true,"hsn_sac":true}}'),
    ('fee_receipt',  'Fee Receipt',  '{"header_title":"Fee Receipt","show_logo":true,"footer_text":"Thank you for your payment.","terms":"","fields":{"mode":true,"reference":true,"balance":true}}'),
    ('student_id',   'Student ID',   '{"header_title":"Student Identity Card","show_logo":true,"footer_text":"","id_format":"<CENTRE>-<YYYY>-<NNN>","fields":{"photo":true,"blood_group":true,"valid_until":true}}'),
    ('employee_id',  'Employee ID',  '{"header_title":"Employee Identity Card","show_logo":true,"footer_text":"","id_format":"EMP-<NNNN>","fields":{"photo":true,"department":true,"designation":true}}'),
    ('quotation',    'Quotation',    '{"header_title":"Quotation","show_logo":true,"footer_text":"","terms":"This quotation is valid for 15 days from the date of issue.","fields":{"validity":true,"payment_plan":true}}'),
    ('certificate',  'Certificate',  '{"header_title":"Certificate of Completion","show_logo":true,"footer_text":"","terms":"","fields":{"serial_no":true,"issue_date":true,"signatory":true}}'),
    ('marksheet',    'Marksheet',    '{"header_title":"Statement of Marks","show_logo":true,"footer_text":"","terms":"","fields":{"grade":true,"percentage":true,"result":true}}')
  ) AS t(type, name, settings)
  ON CONFLICT (org_id, type) DO NOTHING;
