-- =============================================================================
-- 057 — PHASE 3 BATCH 3: RAZORPAY ONLINE COLLECTION (per vertical) + PARTIAL
--        PAYMENTS + AUTO-RECEIPTS
--
--   1) payment                 — an ONLINE payment attempt against an enrolment (and,
--                                optionally, a chosen installment). Created when a
--                                Razorpay order / payment link is minted; moves
--                                pending -> paid / failed / cancelled on the webhook.
--                                Money is BIGINT paise. Carries the vertical (the key
--                                that minted it), the gateway refs (order / payment /
--                                link ids), and — on capture — the fee_receipt it
--                                produced (so the online payment and the receipt are one
--                                chain, never two disconnected facts).
--   2) IDEMPOTENCY              — a partial UNIQUE index on gateway_payment_id means a
--                                webhook REPLAY of the same captured payment can never
--                                create a second row; the capture path itself claims the
--                                row with a conditional UPDATE (status <> 'paid'), so the
--                                fee collection + auto-receipt run AT MOST ONCE.
--   3) payment.* permissions + grants (mirror the fee / payment_plan roles).
--
-- Razorpay is CREDENTIAL-GATED (key id/secret + webhook secret are stored per vertical
-- in channel_config, encrypted — migration 017 / the Settings screen). This migration
-- adds NO secret. Everything degrades to a clean 503 until the client enters the key.
--
-- Idempotent throughout (IF NOT EXISTS / ON CONFLICT DO NOTHING).
-- =============================================================================

CREATE TABLE IF NOT EXISTS payment (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             BIGINT NOT NULL REFERENCES organisation(id),
  enrolment_id       BIGINT NOT NULL REFERENCES enrolment(id),
  installment_id     BIGINT NULL REFERENCES installment(id),
  lead_id            BIGINT NULL REFERENCES lead(id),
  branch_id          BIGINT NOT NULL REFERENCES branch(id),
  vertical_id        BIGINT NOT NULL REFERENCES vertical(id),
  amount_minor       BIGINT NOT NULL CHECK (amount_minor > 0),
  currency           VARCHAR(8) NOT NULL DEFAULT 'INR',
  status             VARCHAR(12) NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'paid', 'failed', 'cancelled')),
  gateway            VARCHAR(24) NOT NULL DEFAULT 'razorpay',
  gateway_order_id   VARCHAR(64) NULL,
  gateway_payment_id VARCHAR(64) NULL,
  gateway_link_id    VARCHAR(64) NULL,
  short_url          TEXT NULL,
  fee_receipt_id     BIGINT NULL REFERENCES fee_receipt(id),
  note               TEXT NULL,
  failed_reason      TEXT NULL,
  created_by         BIGINT NULL REFERENCES "user"(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at            TIMESTAMPTZ NULL,
  deleted_at         TIMESTAMPTZ NULL,
  deleted_by         BIGINT NULL REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS idx_payment_enrolment ON payment (enrolment_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_payment_status ON payment (status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_payment_vertical ON payment (vertical_id) WHERE deleted_at IS NULL;
-- The webhook resolves our row by the link id it minted, then by order id on capture.
CREATE INDEX IF NOT EXISTS idx_payment_link ON payment (gateway_link_id);
CREATE INDEX IF NOT EXISTS idx_payment_order ON payment (gateway_order_id);
-- IDEMPOTENCY: one captured Razorpay payment id maps to at most one payment row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_gateway_payment
  ON payment (gateway_payment_id) WHERE gateway_payment_id IS NOT NULL;
-- A captured online payment maps to at most one fee_receipt (no double-collect).
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_receipt
  ON payment (fee_receipt_id) WHERE fee_receipt_id IS NOT NULL;

INSERT INTO permission (key, module, action) VALUES
  ('payment.read',   'payment', 'read'),
  ('payment.create', 'payment', 'create'),
  ('payment.delete', 'payment', 'delete')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('payment.read',   'Super Admin',        'all'),
      ('payment.read',   'Organization Admin', 'all'),
      ('payment.read',   'Accountant',         'all'),
      ('payment.read',   'Marketing Manager',  'all'),
      ('payment.read',   'Branch Manager',     'branch'),
      ('payment.read',   'Vertical Manager',   'vertical'),
      ('payment.read',   'Team Leader',        'team'),
      ('payment.read',   'Counsellor',         'own'),
      ('payment.create', 'Super Admin',        'all'),
      ('payment.create', 'Organization Admin', 'all'),
      ('payment.create', 'Accountant',         'all'),
      ('payment.create', 'Branch Manager',     'branch'),
      ('payment.create', 'Vertical Manager',   'vertical'),
      ('payment.create', 'Team Leader',        'team'),
      ('payment.create', 'Counsellor',         'own'),
      ('payment.delete', 'Super Admin',        'all'),
      ('payment.delete', 'Organization Admin', 'all'),
      ('payment.delete', 'Accountant',         'all'),
      ('payment.delete', 'Branch Manager',     'branch'),
      ('payment.delete', 'Vertical Manager',   'vertical')
    ) AS v(pkey, role_name, scope)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope
      FROM role ro, permission p
     WHERE ro.name = r.role_name AND p.key = r.pkey
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;
