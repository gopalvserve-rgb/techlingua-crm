-- =============================================================================
-- 055 — PHASE 3 BATCH 1: GST TAX INVOICES + FINANCE DASHBOARD
--
--   1) branch legal/GST columns  — the SELLER identity a tax invoice must print:
--        legal_name, gstin, pan. (Address + state_id already exist on branch.)
--   2) gst_invoice + gst_invoice_item — a proper India GST tax invoice raised
--        against an enrolment/fee (or ad-hoc). Money in paise/NUMERIC, no floats.
--        CGST+SGST for intra-state, IGST for inter-state (seller state vs place of
--        supply). HSN/SAC per line, GSTIN both sides, place of supply, round-off,
--        amount in words. Numbering via number_series ('invoice' kind, Indian-FY
--        aware). status: draft/issued/paid/cancelled.
--   3) invoice.* + finance_dashboard permissions + grants.
--   4) The 'invoice' numbering series -> reset per Indian financial year ('fy').
--
-- MONEY RULE (unchanged, non-negotiable): every money column is BIGINT paise.
-- GST is computed via common/money.util.ts (discount-before-tax, half-up); the
-- CGST/SGST/IGST split lives in invoices/gst.util.ts and is unit-tested.
--
-- Idempotent throughout (IF NOT EXISTS / ON CONFLICT DO NOTHING).
-- =============================================================================

ALTER TABLE branch ADD COLUMN IF NOT EXISTS legal_name VARCHAR(200);
ALTER TABLE branch ADD COLUMN IF NOT EXISTS gstin      VARCHAR(15);
ALTER TABLE branch ADD COLUMN IF NOT EXISTS pan        VARCHAR(10);

CREATE TABLE IF NOT EXISTS gst_invoice (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         BIGINT NOT NULL REFERENCES organisation(id),
  invoice_no     VARCHAR(48) NULL,
  invoice_date   DATE NOT NULL DEFAULT CURRENT_DATE,
  status         VARCHAR(12) NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'issued', 'paid', 'cancelled')),
  enrolment_id   BIGINT NULL REFERENCES enrolment(id),
  quotation_id   BIGINT NULL REFERENCES quotation(id),
  lead_id        BIGINT NULL REFERENCES lead(id),
  student_id     BIGINT NULL,
  branch_id      BIGINT NOT NULL REFERENCES branch(id),
  vertical_id    BIGINT NOT NULL REFERENCES vertical(id),
  pipeline_id    BIGINT NULL REFERENCES pipeline(id),
  campaign_id    BIGINT NULL REFERENCES campaign(id),
  counsellor_id  BIGINT NULL REFERENCES "user"(id),
  team_id        BIGINT NULL REFERENCES team(id),
  seller_legal_name VARCHAR(200) NOT NULL DEFAULT '',
  seller_gstin      VARCHAR(15)  NULL,
  seller_pan        VARCHAR(10)  NULL,
  seller_address    TEXT NULL,
  seller_state_id   BIGINT NULL REFERENCES state(id),
  seller_state_name VARCHAR(120) NULL,
  seller_state_code VARCHAR(4)   NULL,
  buyer_name        VARCHAR(200) NOT NULL DEFAULT '',
  buyer_gstin       VARCHAR(15)  NULL,
  buyer_address     TEXT NULL,
  buyer_email       VARCHAR(255) NULL,
  buyer_phone       VARCHAR(24)  NULL,
  pos_state_id      BIGINT NULL REFERENCES state(id),
  pos_state_name    VARCHAR(120) NULL,
  pos_state_code    VARCHAR(4)   NULL,
  supply_type    VARCHAR(6) NOT NULL DEFAULT 'intra' CHECK (supply_type IN ('intra', 'inter')),
  currency       VARCHAR(3) NOT NULL DEFAULT 'INR',
  taxable_minor  BIGINT NOT NULL DEFAULT 0,
  discount_minor BIGINT NOT NULL DEFAULT 0,
  cgst_minor     BIGINT NOT NULL DEFAULT 0,
  sgst_minor     BIGINT NOT NULL DEFAULT 0,
  igst_minor     BIGINT NOT NULL DEFAULT 0,
  round_off_minor BIGINT NOT NULL DEFAULT 0,
  total_minor    BIGINT NOT NULL DEFAULT 0,
  amount_in_words TEXT NULL,
  notes          TEXT NULL,
  terms          TEXT NULL,
  issued_at      TIMESTAMPTZ NULL,
  issued_by      BIGINT NULL REFERENCES "user"(id),
  paid_at        TIMESTAMPTZ NULL,
  cancelled_at   TIMESTAMPTZ NULL,
  cancelled_by   BIGINT NULL REFERENCES "user"(id),
  cancel_reason  TEXT NULL,
  created_by     BIGINT NULL REFERENCES "user"(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ NULL,
  deleted_by     BIGINT NULL REFERENCES "user"(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_gst_invoice_no ON gst_invoice (org_id, invoice_no)
  WHERE invoice_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gst_invoice_scope ON gst_invoice (branch_id, vertical_id, counsellor_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_gst_invoice_enrolment ON gst_invoice (enrolment_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_gst_invoice_status ON gst_invoice (status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_gst_invoice_date ON gst_invoice (invoice_date) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS gst_invoice_item (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_id     BIGINT NOT NULL REFERENCES gst_invoice(id) ON DELETE CASCADE,
  line_no        INT NOT NULL DEFAULT 1,
  course_id      BIGINT NULL REFERENCES m_course(id),
  description    VARCHAR(240) NOT NULL,
  hsn_sac        VARCHAR(8) NULL,
  qty            INT NOT NULL DEFAULT 1 CHECK (qty > 0),
  unit_price_minor BIGINT NOT NULL DEFAULT 0 CHECK (unit_price_minor >= 0),
  discount_type  VARCHAR(8) NOT NULL DEFAULT 'amount' CHECK (discount_type IN ('amount', 'percent')),
  discount_value NUMERIC(14, 4) NOT NULL DEFAULT 0 CHECK (discount_value >= 0),
  gst_pct        NUMERIC(6, 3) NOT NULL DEFAULT 0 CHECK (gst_pct >= 0 AND gst_pct <= 100),
  gross_minor    BIGINT NOT NULL DEFAULT 0,
  discount_minor BIGINT NOT NULL DEFAULT 0,
  taxable_minor  BIGINT NOT NULL DEFAULT 0,
  cgst_minor     BIGINT NOT NULL DEFAULT 0,
  sgst_minor     BIGINT NOT NULL DEFAULT 0,
  igst_minor     BIGINT NOT NULL DEFAULT 0,
  total_minor    BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_gst_invoice_item ON gst_invoice_item (invoice_id, line_no);

INSERT INTO permission (key, module, action) VALUES
  ('invoice.read',            'invoice', 'read'),
  ('invoice.create',          'invoice', 'create'),
  ('invoice.issue',           'invoice', 'issue'),
  ('invoice.cancel',          'invoice', 'cancel'),
  ('invoice.delete',          'invoice', 'delete'),
  ('finance_dashboard.read',  'finance_dashboard', 'read')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('invoice.read',   'Super Admin',        'all'),
      ('invoice.read',   'Organization Admin', 'all'),
      ('invoice.read',   'Accountant',         'all'),
      ('invoice.read',   'Marketing Manager',  'all'),
      ('invoice.read',   'Branch Manager',     'branch'),
      ('invoice.read',   'Vertical Manager',   'vertical'),
      ('invoice.read',   'Team Leader',        'team'),
      ('invoice.read',   'Counsellor',         'own'),
      ('invoice.create', 'Super Admin',        'all'),
      ('invoice.create', 'Organization Admin', 'all'),
      ('invoice.create', 'Accountant',         'all'),
      ('invoice.create', 'Branch Manager',     'branch'),
      ('invoice.create', 'Vertical Manager',   'vertical'),
      ('invoice.create', 'Team Leader',        'team'),
      ('invoice.create', 'Counsellor',         'own'),
      ('invoice.issue',  'Super Admin',        'all'),
      ('invoice.issue',  'Organization Admin', 'all'),
      ('invoice.issue',  'Accountant',         'all'),
      ('invoice.issue',  'Branch Manager',     'branch'),
      ('invoice.issue',  'Vertical Manager',   'vertical'),
      ('invoice.cancel', 'Super Admin',        'all'),
      ('invoice.cancel', 'Organization Admin', 'all'),
      ('invoice.cancel', 'Accountant',         'all'),
      ('invoice.cancel', 'Branch Manager',     'branch'),
      ('invoice.cancel', 'Vertical Manager',   'vertical'),
      ('invoice.delete', 'Super Admin',        'all'),
      ('invoice.delete', 'Organization Admin', 'all'),
      ('invoice.delete', 'Accountant',         'all'),
      ('finance_dashboard.read', 'Super Admin',        'all'),
      ('finance_dashboard.read', 'Organization Admin', 'all'),
      ('finance_dashboard.read', 'Accountant',         'all'),
      ('finance_dashboard.read', 'Marketing Manager',  'all'),
      ('finance_dashboard.read', 'Branch Manager',     'branch'),
      ('finance_dashboard.read', 'Vertical Manager',   'vertical'),
      ('finance_dashboard.read', 'Team Leader',        'team'),
      ('finance_dashboard.read', 'Counsellor',         'own')
    ) AS v(pkey, role_name, scope)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope
      FROM role ro, permission p
     WHERE ro.name = r.role_name AND p.key = r.pkey
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;

UPDATE number_series
   SET reset_period = 'fy'
 WHERE kind = 'invoice' AND reset_period = 'yearly' AND next_number <= 1 AND period_token = '';
