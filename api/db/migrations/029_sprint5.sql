-- =============================================================================
-- 029 — SPRINT 5: CONVERSION & MONEY-LITE
--
--   1) number_series      THE numbering series, promoted from an app_setting JSON
--                         blob to a real table, because Sprint 5 is the first thing
--                         that ALLOCATES from it. Allocation must be atomic and
--                         per-branch / per-vertical; a single JSON row can be
--                         neither. The app_setting row is migrated in and DELETED
--                         (the 028 calendar_sync pattern): two places to edit one
--                         number is how you get two different numbers.
--   2) quotation          + quotation_item — line items, discounts, tax SHOWN but
--                         not GST machinery (Phase 3), versioning via parent_id.
--   3) enrolment          the sale-closure record. `student_profile_id` is the
--                         PHASE-2 SEAM: the column exists, nothing writes it, and
--                         Phase 2's student profile extends this row.
--   4) approval_request   the OPTIONAL per-step approval queue + audit.
--                         DEFAULT OFF (app_setting.enrolment_approvals).
--   5) fee_receipt        lite collection entry. Partial payments allowed;
--                         over-collection is refused. Razorpay/online capture is
--                         PHASE 3 — `gateway_*` columns are the seam, unused now.
--   6) monthly_target     per counsellor / branch / vertical, per month.
--
-- MONEY RULE (non-negotiable, PROJECT_DOCUMENTATION decision log):
--   every money column is BIGINT MINOR UNITS (paise). Never FLOAT, never MONEY.
--   Percentages are NUMERIC with a fixed scale. See common/money.util.ts for the
--   rounding rules, which are pure and unit-tested.
--
-- Idempotent throughout (IF NOT EXISTS / ON CONFLICT DO NOTHING).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) number_series — per (kind, branch, vertical). Resolution is "most specific
--    wins" — the same rule channel_config and the SLA policies already use, so
--    the product has ONE mental model:
--        (branch, vertical) -> (vertical) -> (branch) -> org-wide
--
--    Allocation is `UPDATE ... SET next_number = next_number + 1 RETURNING`, a
--    single statement, so the row lock IS the mutex. Two counsellors saving a
--    quotation in the same millisecond cannot get the same number.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS number_series (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       BIGINT NOT NULL REFERENCES organisation(id),
  kind         VARCHAR(24) NOT NULL,
  branch_id    BIGINT NULL REFERENCES branch(id),
  vertical_id  BIGINT NULL REFERENCES vertical(id),
  prefix       VARCHAR(24) NOT NULL DEFAULT '',
  suffix       VARCHAR(24) NOT NULL DEFAULT '',
  next_number  BIGINT NOT NULL DEFAULT 1 CHECK (next_number >= 0),
  padding      INT NOT NULL DEFAULT 4 CHECK (padding BETWEEN 0 AND 12),
  reset_period VARCHAR(8) NOT NULL DEFAULT 'none',
  period_token VARCHAR(12) NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   BIGINT NULL REFERENCES "user"(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_number_series
  ON number_series (org_id, kind, COALESCE(branch_id, 0), COALESCE(vertical_id, 0));

INSERT INTO number_series (org_id, kind, prefix, next_number, padding, reset_period)
SELECT o.id, v.kind, v.prefix, 1, 4, v.reset
  FROM organisation o,
       (VALUES
         ('quotation', 'QT-',  'yearly'),
         ('enrolment', 'ENR-', 'yearly'),
         ('receipt',   'RCP-', 'yearly'),
         ('invoice',   'INV-', 'yearly')
       ) AS v(kind, prefix, reset)
ON CONFLICT DO NOTHING;

DO $$
DECLARE
  j JSONB;
  k TEXT;
  o BIGINT;
BEGIN
  SELECT value INTO j FROM app_setting WHERE key = 'numbering_series';
  SELECT id INTO o FROM organisation ORDER BY id LIMIT 1;
  IF j IS NOT NULL AND o IS NOT NULL THEN
    FOR k IN SELECT jsonb_object_keys(j) LOOP
      IF jsonb_typeof(j -> k) = 'object' THEN
        INSERT INTO number_series (org_id, kind, prefix, next_number, padding, reset_period)
        VALUES (
          o, k,
          COALESCE(j -> k ->> 'prefix', ''),
          GREATEST(COALESCE((j -> k ->> 'next')::BIGINT, 1), 1),
          COALESCE((j -> k ->> 'padding')::INT, 4),
          'none'
        )
        ON CONFLICT (org_id, kind, COALESCE(branch_id, 0), COALESCE(vertical_id, 0))
        DO UPDATE SET prefix      = EXCLUDED.prefix,
                      next_number = GREATEST(number_series.next_number, EXCLUDED.next_number),
                      padding     = EXCLUDED.padding;
      END IF;
    END LOOP;
  END IF;
END $$;
DELETE FROM app_setting WHERE key = 'numbering_series';

-- ---------------------------------------------------------------------------
-- 2) quotation + quotation_item
--
-- The PATH is denormalised off the lead, exactly as every other lead-derived
-- record does, so reports roll up and isolate at every level without a join back.
--
-- VERSIONING: a revision is a NEW ROW with `parent_id` pointing at the original and
-- `version = parent.version + 1`. The old row is kept verbatim and marked
-- `is_current = FALSE`. A quote that was SENT to a customer is evidence; editing it
-- in place would destroy the record of what he was actually offered.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quotation (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES organisation(id),
  quote_no      VARCHAR(48) NOT NULL,
  version       INT NOT NULL DEFAULT 1,
  parent_id     BIGINT NULL REFERENCES quotation(id),
  is_current    BOOLEAN NOT NULL DEFAULT TRUE,
  lead_id       BIGINT NOT NULL REFERENCES lead(id),
  branch_id     BIGINT NOT NULL REFERENCES branch(id),
  vertical_id   BIGINT NOT NULL REFERENCES vertical(id),
  pipeline_id   BIGINT NULL REFERENCES pipeline(id),
  campaign_id   BIGINT NULL REFERENCES campaign(id),
  owner_id      BIGINT NULL REFERENCES "user"(id),
  team_id       BIGINT NULL REFERENCES team(id),
  status        VARCHAR(12) NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'sent', 'accepted', 'rejected', 'expired')),
  valid_until   DATE NULL,
  currency      VARCHAR(3) NOT NULL DEFAULT 'INR',
  subtotal_minor BIGINT NOT NULL DEFAULT 0,
  discount_minor BIGINT NOT NULL DEFAULT 0,
  tax_minor      BIGINT NOT NULL DEFAULT 0,
  total_minor    BIGINT NOT NULL DEFAULT 0,
  notes         TEXT NULL,
  terms         TEXT NULL,
  sent_at       TIMESTAMPTZ NULL,
  decided_at    TIMESTAMPTZ NULL,
  decided_by    BIGINT NULL REFERENCES "user"(id),
  decision_note TEXT NULL,
  created_by    BIGINT NULL REFERENCES "user"(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ NULL,
  deleted_by    BIGINT NULL REFERENCES "user"(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_quotation_no ON quotation (org_id, quote_no);
CREATE INDEX IF NOT EXISTS idx_quotation_lead   ON quotation (lead_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_quotation_status ON quotation (status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_quotation_scope  ON quotation (branch_id, vertical_id, owner_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_quotation_expiry ON quotation (valid_until)
  WHERE status = 'sent' AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS quotation_item (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  quotation_id   BIGINT NOT NULL REFERENCES quotation(id) ON DELETE CASCADE,
  line_no        INT NOT NULL DEFAULT 1,
  course_id      BIGINT NULL REFERENCES m_course(id),
  description    VARCHAR(240) NOT NULL,
  qty            INT NOT NULL DEFAULT 1 CHECK (qty > 0),
  unit_price_minor BIGINT NOT NULL DEFAULT 0 CHECK (unit_price_minor >= 0),
  discount_type  VARCHAR(8) NOT NULL DEFAULT 'amount' CHECK (discount_type IN ('amount', 'percent')),
  discount_value NUMERIC(14, 4) NOT NULL DEFAULT 0 CHECK (discount_value >= 0),
  tax_pct        NUMERIC(6, 3) NOT NULL DEFAULT 0 CHECK (tax_pct >= 0 AND tax_pct <= 100),
  gross_minor    BIGINT NOT NULL DEFAULT 0,
  discount_minor BIGINT NOT NULL DEFAULT 0,
  taxable_minor  BIGINT NOT NULL DEFAULT 0,
  tax_minor      BIGINT NOT NULL DEFAULT 0,
  total_minor    BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_quotation_item_q ON quotation_item (quotation_id, line_no);

-- ---------------------------------------------------------------------------
-- 3) enrolment — the sale-closure record.
--
-- THE PHASE-2 SEAM: `student_profile_id`. Phase 2 creates `student_profile` and
-- points this column at it; the enrolment row is NOT re-created and NOT migrated.
-- Everything Phase 2 needs to know about the sale (course, fee, plan intent, start
-- date, branch/vertical, counsellor) is already here.
--
-- THE PHASE-3 SEAM: `payment_plan` + `first_payment_minor` are INTENT ONLY — what
-- was agreed at closure. Phase 3 builds the installment SCHEDULE, dues and ageing
-- from them. We deliberately do NOT generate a schedule now: a half-built schedule
-- that nothing maintains is worse than none.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS enrolment (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         BIGINT NOT NULL REFERENCES organisation(id),
  enrolment_no   VARCHAR(48) NOT NULL,
  lead_id        BIGINT NOT NULL REFERENCES lead(id),
  quotation_id   BIGINT NULL REFERENCES quotation(id),
  branch_id      BIGINT NOT NULL REFERENCES branch(id),
  vertical_id    BIGINT NOT NULL REFERENCES vertical(id),
  pipeline_id    BIGINT NULL REFERENCES pipeline(id),
  campaign_id    BIGINT NULL REFERENCES campaign(id),
  counsellor_id  BIGINT NULL REFERENCES "user"(id),
  team_id        BIGINT NULL REFERENCES team(id),
  course_id      BIGINT NULL REFERENCES m_course(id),
  batch_id       BIGINT NULL,
  student_profile_id BIGINT NULL,
  fee_minor      BIGINT NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  discount_minor BIGINT NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  net_fee_minor  BIGINT NOT NULL DEFAULT 0 CHECK (net_fee_minor >= 0),
  payment_plan   VARCHAR(16) NOT NULL DEFAULT 'full'
                   CHECK (payment_plan IN ('full', 'emi_3', 'emi_6', 'custom')),
  first_payment_minor BIGINT NOT NULL DEFAULT 0 CHECK (first_payment_minor >= 0),
  plan_note      TEXT NULL,
  start_date     DATE NULL,
  status         VARCHAR(16) NOT NULL DEFAULT 'active'
                   CHECK (status IN ('draft', 'pending_approval', 'active', 'rejected', 'cancelled')),
  remarks        TEXT NULL,
  created_by     BIGINT NULL REFERENCES "user"(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ NULL,
  deleted_by     BIGINT NULL REFERENCES "user"(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_enrolment_no ON enrolment (org_id, enrolment_no);
CREATE UNIQUE INDEX IF NOT EXISTS uq_enrolment_lead ON enrolment (lead_id)
  WHERE deleted_at IS NULL AND status <> 'cancelled' AND status <> 'rejected';
CREATE INDEX IF NOT EXISTS idx_enrolment_scope ON enrolment (branch_id, vertical_id, counsellor_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_enrolment_created ON enrolment (created_at) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 4) approval_request — the OPTIONAL per-step approval queue.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approval_request (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       BIGINT NOT NULL REFERENCES organisation(id),
  entity_type  VARCHAR(24) NOT NULL,
  entity_id    BIGINT NOT NULL,
  step_key     VARCHAR(32) NOT NULL,
  step_label   VARCHAR(64) NOT NULL DEFAULT '',
  status       VARCHAR(12) NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'rejected')),
  branch_id    BIGINT NULL REFERENCES branch(id),
  vertical_id  BIGINT NULL REFERENCES vertical(id),
  requested_by BIGINT NULL REFERENCES "user"(id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approver_id  BIGINT NULL REFERENCES "user"(id),
  decided_at   TIMESTAMPTZ NULL,
  note         TEXT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_approval_open
  ON approval_request (entity_type, entity_id, step_key) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_approval_queue
  ON approval_request (status, branch_id, vertical_id, requested_at);

-- ---------------------------------------------------------------------------
-- 5) fee_receipt — LITE collection entry.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fee_receipt (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES organisation(id),
  receipt_no    VARCHAR(48) NOT NULL,
  enrolment_id  BIGINT NOT NULL REFERENCES enrolment(id),
  lead_id       BIGINT NULL REFERENCES lead(id),
  branch_id     BIGINT NOT NULL REFERENCES branch(id),
  vertical_id   BIGINT NOT NULL REFERENCES vertical(id),
  amount_minor  BIGINT NOT NULL CHECK (amount_minor > 0),
  mode          VARCHAR(12) NOT NULL CHECK (mode IN ('cash', 'upi', 'card', 'cheque', 'online')),
  reference     VARCHAR(64) NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_by   BIGINT NULL REFERENCES "user"(id),
  note          TEXT NULL,
  gateway            VARCHAR(24) NULL,
  gateway_order_id   VARCHAR(64) NULL,
  gateway_payment_id VARCHAR(64) NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ NULL,
  deleted_by    BIGINT NULL REFERENCES "user"(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_receipt_no ON fee_receipt (org_id, receipt_no);
CREATE INDEX IF NOT EXISTS idx_receipt_enrolment ON fee_receipt (enrolment_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_receipt_scope ON fee_receipt (branch_id, vertical_id, received_at)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 6) monthly_target — per counsellor / branch / vertical.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS monthly_target (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES organisation(id),
  period        DATE NOT NULL CHECK (EXTRACT(DAY FROM period) = 1),
  scope_type    VARCHAR(10) NOT NULL CHECK (scope_type IN ('user', 'branch', 'vertical')),
  user_id       BIGINT NULL REFERENCES "user"(id),
  branch_id     BIGINT NULL REFERENCES branch(id),
  vertical_id   BIGINT NULL REFERENCES vertical(id),
  enrolment_target INT NOT NULL DEFAULT 0 CHECK (enrolment_target >= 0),
  revenue_target_minor BIGINT NOT NULL DEFAULT 0 CHECK (revenue_target_minor >= 0),
  note          TEXT NULL,
  created_by    BIGINT NULL REFERENCES "user"(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ NULL,
  deleted_by    BIGINT NULL REFERENCES "user"(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_monthly_target
  ON monthly_target (org_id, period, scope_type,
                     COALESCE(user_id, 0), COALESCE(branch_id, 0), COALESCE(vertical_id, 0))
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_monthly_target_period ON monthly_target (period) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 7) The approval policy — DEFAULT OFF.
--    §5 says "optional approval per step" and fixes no default, so the default
--    invents no bureaucracy: a counsellor closes a sale and it is closed. Switch it
--    on and the SAME closure lands in the approval queue instead. One row, no deploy.
-- ---------------------------------------------------------------------------
INSERT INTO app_setting (key, value)
VALUES ('enrolment_approvals', jsonb_build_object(
  'enabled', FALSE,
  'steps', jsonb_build_array(
    jsonb_build_object('key', 'closure', 'label', 'Enrolment closure', 'enabled', TRUE,
                       'roles', jsonb_build_array('Branch Manager', 'Vertical Manager')),
    jsonb_build_object('key', 'discount', 'label', 'Discount above threshold', 'enabled', FALSE,
                       'roles', jsonb_build_array('Branch Manager'),
                       'discount_pct_over', 10)
  )
))
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 8) Permissions + grants.
-- ---------------------------------------------------------------------------
INSERT INTO permission (key, module, action) VALUES
  ('quotation.read',    'quotation', 'read'),
  ('quotation.create',  'quotation', 'create'),
  ('quotation.update',  'quotation', 'update'),
  ('quotation.delete',  'quotation', 'delete'),
  ('quotation.send',    'quotation', 'send'),
  ('enrolment.read',    'enrolment', 'read'),
  ('enrolment.create',  'enrolment', 'create'),
  ('enrolment.update',  'enrolment', 'update'),
  ('enrolment.delete',  'enrolment', 'delete'),
  ('enrolment.approve', 'enrolment', 'approve'),
  ('fee.read',          'fee',       'read'),
  ('fee.collect',       'fee',       'collect'),
  ('fee.delete',        'fee',       'delete'),
  ('target.read',       'target',    'read'),
  ('target.manage',     'target',    'manage'),
  ('performance.read',  'performance', 'read')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('quotation.read',    'Super Admin',        'all'),
      ('quotation.read',    'Organization Admin', 'all'),
      ('quotation.read',    'Marketing Manager',  'all'),
      ('quotation.read',    'Branch Manager',     'branch'),
      ('quotation.read',    'Vertical Manager',   'vertical'),
      ('quotation.read',    'Team Leader',        'team'),
      ('quotation.read',    'Counsellor',         'own'),
      ('quotation.create',  'Super Admin',        'all'),
      ('quotation.create',  'Organization Admin', 'all'),
      ('quotation.create',  'Branch Manager',     'branch'),
      ('quotation.create',  'Vertical Manager',   'vertical'),
      ('quotation.create',  'Team Leader',        'team'),
      ('quotation.create',  'Counsellor',         'own'),
      ('quotation.update',  'Super Admin',        'all'),
      ('quotation.update',  'Organization Admin', 'all'),
      ('quotation.update',  'Branch Manager',     'branch'),
      ('quotation.update',  'Vertical Manager',   'vertical'),
      ('quotation.update',  'Team Leader',        'team'),
      ('quotation.update',  'Counsellor',         'own'),
      ('quotation.send',    'Super Admin',        'all'),
      ('quotation.send',    'Organization Admin', 'all'),
      ('quotation.send',    'Branch Manager',     'branch'),
      ('quotation.send',    'Vertical Manager',   'vertical'),
      ('quotation.send',    'Team Leader',        'team'),
      ('quotation.send',    'Counsellor',         'own'),
      ('quotation.delete',  'Super Admin',        'all'),
      ('quotation.delete',  'Organization Admin', 'all'),

      ('enrolment.read',    'Super Admin',        'all'),
      ('enrolment.read',    'Organization Admin', 'all'),
      ('enrolment.read',    'Marketing Manager',  'all'),
      ('enrolment.read',    'Branch Manager',     'branch'),
      ('enrolment.read',    'Vertical Manager',   'vertical'),
      ('enrolment.read',    'Team Leader',        'team'),
      ('enrolment.read',    'Counsellor',         'own'),
      ('enrolment.create',  'Super Admin',        'all'),
      ('enrolment.create',  'Organization Admin', 'all'),
      ('enrolment.create',  'Branch Manager',     'branch'),
      ('enrolment.create',  'Vertical Manager',   'vertical'),
      ('enrolment.create',  'Team Leader',        'team'),
      ('enrolment.create',  'Counsellor',         'own'),
      ('enrolment.update',  'Super Admin',        'all'),
      ('enrolment.update',  'Organization Admin', 'all'),
      ('enrolment.update',  'Branch Manager',     'branch'),
      ('enrolment.update',  'Vertical Manager',   'vertical'),
      ('enrolment.update',  'Team Leader',        'team'),
      ('enrolment.update',  'Counsellor',         'own'),
      ('enrolment.delete',  'Super Admin',        'all'),
      ('enrolment.delete',  'Organization Admin', 'all'),
      ('enrolment.approve', 'Super Admin',        'all'),
      ('enrolment.approve', 'Organization Admin', 'all'),
      ('enrolment.approve', 'Branch Manager',     'branch'),
      ('enrolment.approve', 'Vertical Manager',   'vertical'),

      ('fee.read',          'Super Admin',        'all'),
      ('fee.read',          'Organization Admin', 'all'),
      ('fee.read',          'Branch Manager',     'branch'),
      ('fee.read',          'Vertical Manager',   'vertical'),
      ('fee.read',          'Team Leader',        'team'),
      ('fee.read',          'Counsellor',         'own'),
      ('fee.collect',       'Super Admin',        'all'),
      ('fee.collect',       'Organization Admin', 'all'),
      ('fee.collect',       'Branch Manager',     'branch'),
      ('fee.collect',       'Vertical Manager',   'vertical'),
      ('fee.collect',       'Team Leader',        'team'),
      ('fee.collect',       'Counsellor',         'own'),
      ('fee.delete',        'Super Admin',        'all'),
      ('fee.delete',        'Organization Admin', 'all'),

      ('target.read',       'Super Admin',        'all'),
      ('target.read',       'Organization Admin', 'all'),
      ('target.read',       'Branch Manager',     'branch'),
      ('target.read',       'Vertical Manager',   'vertical'),
      ('target.read',       'Team Leader',        'team'),
      ('target.read',       'Counsellor',         'own'),
      ('target.read',       'Telecaller',         'own'),
      ('target.manage',     'Super Admin',        'all'),
      ('target.manage',     'Organization Admin', 'all'),
      ('target.manage',     'Branch Manager',     'branch'),
      ('target.manage',     'Vertical Manager',   'vertical'),

      ('performance.read',  'Super Admin',        'all'),
      ('performance.read',  'Organization Admin', 'all'),
      ('performance.read',  'Marketing Manager',  'all'),
      ('performance.read',  'Branch Manager',     'branch'),
      ('performance.read',  'Vertical Manager',   'vertical'),
      ('performance.read',  'Team Leader',        'team'),
      ('performance.read',  'Counsellor',         'own'),
      ('performance.read',  'Telecaller',         'own')
    ) AS v(pkey, role_name, scope)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope
      FROM role ro, permission p
     WHERE ro.name = r.role_name AND p.key = r.pkey
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;
