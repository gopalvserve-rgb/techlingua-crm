-- ===========================================================================
-- 106 — FRANCHISE ROYALTY OPS & LIFECYCLE (Phase 4 Batch 2, dev/137)
--
-- Batch 1 (migration 105) shipped the franchise entity + branch mapping, royalty
-- PLANS and the royalty STATEMENT (computeRoyalty). This batch turns the P2 nav
-- placeholders into real operations:
--
--   · royalty_invoice / royalty_payment  — bill a franchise for a period from its
--     royalty statement (own numbering series ROY-<FY>/####), collect payments and
--     age the outstanding (current / 30 / 60 / 90+), exactly like the Phase-3 fee
--     dues ageing + fee_receipt collection do for students.
--   · franchise_agreement                — agreement records + signed document (R2)
--     + a renewal-reminder (expiring-soon) list.
--   · franchise_onboarding_step (+ _template) — a per-franchise onboarding checklist
--     materialised from a seeded default TEMPLATE; each step done/pending + who/when.
--   · franchise_territory                — allowed operating area(s) per franchise so
--     two franchises do not overlap.
--
-- RBAC: reuses the Batch-1 permissions — royalty.read / royalty.manage for invoices
-- & payments, franchise.read / franchise.update for agreements, onboarding, territory.
-- No new permission keys, so no new grants: the two admin roles already hold them.
-- Every ₹ figure still reconciles with Finance (same fee_receipt / refund sources).
-- ===========================================================================

-- 1 --------------------------------------------------------- royalty_invoice
-- A royalty invoice bills ONE franchise for ONE period. Its money is the frozen
-- output of the royalty statement at issue time (so a later plan change does not
-- rewrite history) — royalty_minor + adjustments_minor = amount_minor (payable).
CREATE TABLE IF NOT EXISTS royalty_invoice (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id                BIGINT NOT NULL REFERENCES organisation(id),
  franchise_id          BIGINT NOT NULL REFERENCES franchise(id),
  plan_id               BIGINT NULL REFERENCES royalty_plan(id),
  invoice_no            VARCHAR(60) NOT NULL,
  status                VARCHAR(12) NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'issued', 'paid', 'cancelled')),
  issue_date            DATE NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Kolkata')::date,
  period_from           DATE NULL,
  period_to             DATE NULL,
  months                INT NOT NULL DEFAULT 1,
  gross_collected_minor BIGINT NOT NULL DEFAULT 0,
  refunds_minor         BIGINT NOT NULL DEFAULT 0,
  net_collected_minor   BIGINT NOT NULL DEFAULT 0,
  royalty_minor         BIGINT NOT NULL DEFAULT 0 CHECK (royalty_minor >= 0),
  adjustments_minor     BIGINT NOT NULL DEFAULT 0,
  amount_minor          BIGINT NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
  plan_name             VARCHAR(160) NULL,
  plan_model            VARCHAR(20)  NULL,
  rate_pct              NUMERIC(7,4) NULL,
  note                  TEXT NULL,
  created_by            BIGINT NULL REFERENCES "user"(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at            TIMESTAMPTZ NULL,
  deleted_by            BIGINT NULL REFERENCES "user"(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_royalty_invoice_no
  ON royalty_invoice (org_id, lower(invoice_no)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_royalty_invoice_fr
  ON royalty_invoice (franchise_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_royalty_invoice_status
  ON royalty_invoice (status) WHERE deleted_at IS NULL;

-- 2 --------------------------------------------------------- royalty_payment
-- A receipt against a royalty invoice. outstanding = invoice.amount_minor - Σ payments.
-- When Σ payments >= amount the invoice flips to 'paid' (mirrors fee_receipt vs plan).
CREATE TABLE IF NOT EXISTS royalty_payment (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       BIGINT NOT NULL REFERENCES organisation(id),
  invoice_id   BIGINT NOT NULL REFERENCES royalty_invoice(id) ON DELETE CASCADE,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  paid_on      DATE NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Kolkata')::date,
  mode         VARCHAR(24) NOT NULL DEFAULT 'bank_transfer',
  reference    VARCHAR(140) NULL,
  note         TEXT NULL,
  created_by   BIGINT NULL REFERENCES "user"(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ NULL,
  deleted_by   BIGINT NULL REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS idx_royalty_payment_inv
  ON royalty_payment (invoice_id) WHERE deleted_at IS NULL;

-- 3 ------------------------------------------------------ franchise_agreement
-- Franchise agreement record + optional signed document in R2 (document_r2_key).
-- status is operator-set (active / renewed); expiring / expired are DERIVED at read
-- time from end_date vs today, and also surfaced by the expiring-soon reminder list.
CREATE TABLE IF NOT EXISTS franchise_agreement (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         BIGINT NOT NULL REFERENCES organisation(id),
  franchise_id   BIGINT NOT NULL REFERENCES franchise(id) ON DELETE CASCADE,
  agreement_no   VARCHAR(60) NULL,
  sign_date      DATE NULL,
  start_date     DATE NULL,
  end_date       DATE NULL,
  renewal_date   DATE NULL,
  document_r2_key TEXT NULL,
  status         VARCHAR(12) NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'expiring', 'expired', 'renewed')),
  note           TEXT NULL,
  created_by     BIGINT NULL REFERENCES "user"(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ NULL,
  deleted_by     BIGINT NULL REFERENCES "user"(id),
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_franchise_agreement_fr
  ON franchise_agreement (franchise_id) WHERE deleted_at IS NULL;

-- 4 ------------------------------------------ franchise onboarding (template + steps)
-- A default onboarding TEMPLATE (structure, not fake franchise data). A franchise's
-- steps are materialised from the template on first access; each step tracks done +
-- completed_by/at, and progress % = done / total.
CREATE TABLE IF NOT EXISTS franchise_onboarding_template (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id     BIGINT NOT NULL REFERENCES organisation(id),
  title      VARCHAR(160) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, title)
);

CREATE TABLE IF NOT EXISTS franchise_onboarding_step (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       BIGINT NOT NULL REFERENCES organisation(id),
  franchise_id BIGINT NOT NULL REFERENCES franchise(id) ON DELETE CASCADE,
  title        VARCHAR(160) NOT NULL,
  sort_order   INT NOT NULL DEFAULT 0,
  done         BOOLEAN NOT NULL DEFAULT FALSE,
  completed_by BIGINT NULL REFERENCES "user"(id),
  completed_at TIMESTAMPTZ NULL,
  note         TEXT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_franchise_onboarding_step_fr
  ON franchise_onboarding_step (franchise_id);

-- Seed the DEFAULT onboarding step template for every org (structure only, idempotent).
INSERT INTO franchise_onboarding_template (org_id, title, sort_order)
SELECT o.id, v.title, v.sort_order
  FROM organisation o
  CROSS JOIN (VALUES
    ('Application received',        10),
    ('Agreement signed',           20),
    ('Franchise fee collected',    30),
    ('Branches mapped',            40),
    ('Royalty plan configured',    50),
    ('KYC documents verified',     60),
    ('Territory assigned',         70),
    ('Team & staff onboarded',     80),
    ('Training completed',         90),
    ('Go-live',                   100)
  ) AS v(title, sort_order)
ON CONFLICT (org_id, title) DO NOTHING;

-- 5 ------------------------------------------------------- franchise_territory
-- Allowed operating area(s) per franchise (city / region / pincode / area) so two
-- franchises do not overlap. A simple list; overlap is surfaced as a WARNING (a shared
-- value across franchises) rather than a hard constraint (territories can legitimately
-- share a metro while carving pincodes).
CREATE TABLE IF NOT EXISTS franchise_territory (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       BIGINT NOT NULL REFERENCES organisation(id),
  franchise_id BIGINT NOT NULL REFERENCES franchise(id) ON DELETE CASCADE,
  kind         VARCHAR(12) NOT NULL DEFAULT 'city'
               CHECK (kind IN ('city', 'region', 'pincode', 'area')),
  value        VARCHAR(160) NOT NULL,
  note         TEXT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   BIGINT NULL REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS idx_franchise_territory_fr
  ON franchise_territory (franchise_id);
CREATE INDEX IF NOT EXISTS idx_franchise_territory_val
  ON franchise_territory (org_id, lower(value));
