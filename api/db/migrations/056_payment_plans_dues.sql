-- =============================================================================
-- 056 — PHASE 3 BATCH 2: PAYMENT PLANS + FEE DUES & AGEING + AUTO REMINDERS
--
--   1) payment_plan            — a plan on an ENROLMENT: Full / Installment / EMI /
--                                Custom. Carries the total (₹ paise, = enrolment net
--                                fee), optional down payment, count + frequency. One
--                                ACTIVE plan per enrolment (partial UNIQUE index).
--   2) installment             — N scheduled dues per plan, each due_date + amount_minor
--                                (sums EXACTLY to the plan total — rounding handled in
--                                paymentplans/schedule.util.ts, unit-tested). paid_minor
--                                is the sum of its allocations; status pending/partial/paid.
--   3) installment_payment     — links a fee_receipt to the installment(s) it settles
--                                (oldest-due first, or a chosen one). A receipt can span
--                                several installments; each split is one row. Reversed
--                                (ON DELETE CASCADE) when the receipt is hard-deleted, and
--                                the fee service rolls back paid_minor on soft-delete.
--   4) installment_reminder    — the IDEMPOTENCY ledger for auto reminders: one row per
--                                (installment, reminder_key) so a due-soon/due-today/overdue
--                                reminder fires AT MOST ONCE per stage per installment,
--                                even across API replicas. Points at the message_log row.
--   5) payment_plan.* + fee_dues.read permissions + grants.
--   6) app_setting 'fee_reminder_config' seed (offsets, channels, enabled).
--
-- MONEY RULE (non-negotiable): every money column is BIGINT paise. No floats.
-- Idempotent throughout (IF NOT EXISTS / ON CONFLICT DO NOTHING).
-- =============================================================================

CREATE TABLE IF NOT EXISTS payment_plan (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         BIGINT NOT NULL REFERENCES organisation(id),
  enrolment_id   BIGINT NOT NULL REFERENCES enrolment(id),
  plan_type      VARCHAR(16) NOT NULL DEFAULT 'installment'
                   CHECK (plan_type IN ('full', 'installment', 'emi', 'custom')),
  frequency      VARCHAR(12) NOT NULL DEFAULT 'monthly'
                   CHECK (frequency IN ('once', 'weekly', 'monthly', 'custom')),
  total_minor    BIGINT NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  down_payment_minor BIGINT NOT NULL DEFAULT 0 CHECK (down_payment_minor >= 0),
  num_installments   INT NOT NULL DEFAULT 1 CHECK (num_installments >= 1),
  start_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  status         VARCHAR(12) NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'completed', 'cancelled')),
  note           TEXT NULL,
  created_by     BIGINT NULL REFERENCES "user"(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ NULL,
  deleted_by     BIGINT NULL REFERENCES "user"(id)
);
-- ONE active plan per enrolment — a double-click cannot create two schedules.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_plan_active
  ON payment_plan (enrolment_id) WHERE status = 'active' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_payment_plan_enrolment ON payment_plan (enrolment_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS installment (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_id        BIGINT NOT NULL REFERENCES payment_plan(id) ON DELETE CASCADE,
  enrolment_id   BIGINT NOT NULL REFERENCES enrolment(id),
  seq_no         INT NOT NULL,
  due_date       DATE NOT NULL,
  amount_minor   BIGINT NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
  paid_minor     BIGINT NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
  status         VARCHAR(10) NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'partial', 'paid', 'waived')),
  label          VARCHAR(48) NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_installment_seq ON installment (plan_id, seq_no);
CREATE INDEX IF NOT EXISTS idx_installment_enrolment ON installment (enrolment_id);
CREATE INDEX IF NOT EXISTS idx_installment_due ON installment (due_date);

CREATE TABLE IF NOT EXISTS installment_payment (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  installment_id BIGINT NOT NULL REFERENCES installment(id) ON DELETE CASCADE,
  fee_receipt_id BIGINT NOT NULL REFERENCES fee_receipt(id) ON DELETE CASCADE,
  amount_minor   BIGINT NOT NULL CHECK (amount_minor > 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_installment_payment_inst ON installment_payment (installment_id);
CREATE INDEX IF NOT EXISTS idx_installment_payment_receipt ON installment_payment (fee_receipt_id);

CREATE TABLE IF NOT EXISTS installment_reminder (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  installment_id BIGINT NOT NULL REFERENCES installment(id) ON DELETE CASCADE,
  reminder_key   VARCHAR(32) NOT NULL,
  stage          VARCHAR(12) NOT NULL,
  sent_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  message_log_id BIGINT NULL
);
-- AT MOST ONCE per (installment, reminder_key) — the exactly-once claim.
CREATE UNIQUE INDEX IF NOT EXISTS uq_installment_reminder ON installment_reminder (installment_id, reminder_key);

INSERT INTO permission (key, module, action) VALUES
  ('payment_plan.read',   'payment_plan', 'read'),
  ('payment_plan.create', 'payment_plan', 'create'),
  ('payment_plan.update', 'payment_plan', 'update'),
  ('payment_plan.delete', 'payment_plan', 'delete'),
  ('fee_dues.read',       'fee_dues',     'read')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('payment_plan.read',   'Super Admin',        'all'),
      ('payment_plan.read',   'Organization Admin', 'all'),
      ('payment_plan.read',   'Accountant',         'all'),
      ('payment_plan.read',   'Marketing Manager',  'all'),
      ('payment_plan.read',   'Branch Manager',     'branch'),
      ('payment_plan.read',   'Vertical Manager',   'vertical'),
      ('payment_plan.read',   'Team Leader',        'team'),
      ('payment_plan.read',   'Counsellor',         'own'),
      ('payment_plan.create', 'Super Admin',        'all'),
      ('payment_plan.create', 'Organization Admin', 'all'),
      ('payment_plan.create', 'Accountant',         'all'),
      ('payment_plan.create', 'Branch Manager',     'branch'),
      ('payment_plan.create', 'Vertical Manager',   'vertical'),
      ('payment_plan.create', 'Team Leader',        'team'),
      ('payment_plan.create', 'Counsellor',         'own'),
      ('payment_plan.update', 'Super Admin',        'all'),
      ('payment_plan.update', 'Organization Admin', 'all'),
      ('payment_plan.update', 'Accountant',         'all'),
      ('payment_plan.update', 'Branch Manager',     'branch'),
      ('payment_plan.update', 'Vertical Manager',   'vertical'),
      ('payment_plan.update', 'Team Leader',        'team'),
      ('payment_plan.update', 'Counsellor',         'own'),
      ('payment_plan.delete', 'Super Admin',        'all'),
      ('payment_plan.delete', 'Organization Admin', 'all'),
      ('payment_plan.delete', 'Accountant',         'all'),
      ('payment_plan.delete', 'Branch Manager',     'branch'),
      ('payment_plan.delete', 'Vertical Manager',   'vertical'),
      ('fee_dues.read',       'Super Admin',        'all'),
      ('fee_dues.read',       'Organization Admin', 'all'),
      ('fee_dues.read',       'Accountant',         'all'),
      ('fee_dues.read',       'Marketing Manager',  'all'),
      ('fee_dues.read',       'Branch Manager',     'branch'),
      ('fee_dues.read',       'Vertical Manager',   'vertical'),
      ('fee_dues.read',       'Team Leader',        'team'),
      ('fee_dues.read',       'Counsellor',         'own')
    ) AS v(pkey, role_name, scope)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope
      FROM role ro, permission p
     WHERE ro.name = r.role_name AND p.key = r.pkey
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;

-- Auto-reminder config — editable in Settings, no deploy. Offsets in days.
INSERT INTO app_setting (key, value)
VALUES ('fee_reminder_config',
        '{"enabled": true, "channels": ["whatsapp","sms","email"], "due_soon_days": [3], "remind_on_due": true, "overdue_days": [3, 7]}'::jsonb)
ON CONFLICT (key) DO NOTHING;
