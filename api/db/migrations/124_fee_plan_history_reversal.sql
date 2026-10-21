-- ============================================================================
-- 124 — FEE PLAN HISTORY, PAYMENT REVERSAL, LEVEL DISCOUNT TYPE (client 3 & 4 Sep 2026)
--
-- 1. payment_plan_history — every version of an enrolment's payment terms (created, re-set up,
--    level added), as a frozen snapshot of the schedule and what had been paid at that moment.
--    "Create the all history of payment terms" (3 Sep, point 2).
-- 2. fee_receipt reversal — "After any payment is posted, staff should not directly edit or
--    delete it. Use Reverse Payment with a reason and approval so the audit history remains
--    accurate" (4 Sep). A reversed receipt keeps its row and number; it simply stops counting
--    as money (deleted_at is set, exactly like the old delete, so every paid total is unchanged
--    in meaning) and carries who asked, who approved, when and why.
-- 3. enrolment_level / enrolment_level_history discount TYPE — which level got a % discount and
--    which a ₹ discount (3 Sep, point 1). Amount-only rows from before stay as 'amount'.
-- 4. fee_receipt.lead_id becomes optional — an enrolment created from an approved online
--    application has no lead, and collecting its fee failed on the NOT NULL.
-- 5. permission fee.reverse — approves / performs a reversal (finance roles).
--
-- Additive and idempotent.
-- ============================================================================

-- 1 ---------------------------------------------------------- payment terms history
CREATE TABLE IF NOT EXISTS payment_plan_history (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES organisation(id),
  enrolment_id  BIGINT NOT NULL REFERENCES enrolment(id) ON DELETE CASCADE,
  plan_id       BIGINT NULL REFERENCES payment_plan(id) ON DELETE SET NULL,
  version_no    INT NOT NULL,
  action        VARCHAR(16) NOT NULL CHECK (action IN ('created', 'resetup', 'level_added', 'deleted')),
  plan_type     VARCHAR(16) NULL,
  total_minor   BIGINT NOT NULL DEFAULT 0,
  paid_minor    BIGINT NOT NULL DEFAULT 0,
  balance_minor BIGINT NOT NULL DEFAULT 0,
  schedule      JSONB NOT NULL DEFAULT '[]',     -- [{seq_no,label,due_date,amount_minor,paid_minor,status}]
  reason        TEXT NULL,
  actor_id      BIGINT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payment_plan_history_enrolment ON payment_plan_history (enrolment_id, version_no);

-- a plan replaced by "Re-setup plan" is kept, marked superseded
ALTER TABLE payment_plan DROP CONSTRAINT IF EXISTS payment_plan_status_check;
ALTER TABLE payment_plan ADD CONSTRAINT payment_plan_status_check
  CHECK (status IN ('active', 'completed', 'cancelled', 'superseded'));

-- backfill version 1 for every live plan, so history starts complete
INSERT INTO payment_plan_history (org_id, enrolment_id, plan_id, version_no, action, plan_type, total_minor, paid_minor, balance_minor, schedule, reason, actor_id, created_at)
SELECT pp.org_id, pp.enrolment_id, pp.id, 1, 'created', pp.plan_type, pp.total_minor,
       COALESCE((SELECT sum(i.paid_minor) FROM installment i WHERE i.plan_id = pp.id), 0),
       pp.total_minor - COALESCE((SELECT sum(i.paid_minor) FROM installment i WHERE i.plan_id = pp.id), 0),
       COALESCE((SELECT jsonb_agg(jsonb_build_object('seq_no', i.seq_no, 'label', i.label, 'due_date', i.due_date,
                                   'amount_minor', i.amount_minor, 'paid_minor', i.paid_minor, 'status', i.status) ORDER BY i.seq_no)
                   FROM installment i WHERE i.plan_id = pp.id), '[]'::jsonb),
       'Recorded from the existing plan (before plan history was tracked)', pp.created_by, pp.created_at
  FROM payment_plan pp
 WHERE pp.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM payment_plan_history h WHERE h.enrolment_id = pp.enrolment_id);

-- 2 ---------------------------------------------------------------- reversal columns
ALTER TABLE fee_receipt ADD COLUMN IF NOT EXISTS reversal_status       VARCHAR(10) NULL;   -- requested | reversed | rejected
ALTER TABLE fee_receipt ADD COLUMN IF NOT EXISTS reversal_reason       TEXT NULL;
ALTER TABLE fee_receipt ADD COLUMN IF NOT EXISTS reversal_requested_by BIGINT NULL;
ALTER TABLE fee_receipt ADD COLUMN IF NOT EXISTS reversal_requested_at TIMESTAMPTZ NULL;
ALTER TABLE fee_receipt ADD COLUMN IF NOT EXISTS reversed_by           BIGINT NULL;
ALTER TABLE fee_receipt ADD COLUMN IF NOT EXISTS reversed_at           TIMESTAMPTZ NULL;
ALTER TABLE fee_receipt DROP CONSTRAINT IF EXISTS chk_fee_receipt_reversal_status;
ALTER TABLE fee_receipt ADD CONSTRAINT chk_fee_receipt_reversal_status
  CHECK (reversal_status IS NULL OR reversal_status IN ('requested', 'reversed', 'rejected'));

-- 3 --------------------------------------------------------- level discount type
ALTER TABLE enrolment_level ADD COLUMN IF NOT EXISTS discount_type  VARCHAR(8) NOT NULL DEFAULT 'amount';
ALTER TABLE enrolment_level ADD COLUMN IF NOT EXISTS discount_value NUMERIC(12,2) NULL;
ALTER TABLE enrolment_level_history ADD COLUMN IF NOT EXISTS discount_type  VARCHAR(8) NOT NULL DEFAULT 'amount';
ALTER TABLE enrolment_level_history ADD COLUMN IF NOT EXISTS discount_value NUMERIC(12,2) NULL;

-- 4 ------------------------------------------------- receipts for lead-less enrolments
ALTER TABLE fee_receipt ALTER COLUMN lead_id DROP NOT NULL;

-- 4b ------------------------------------- Sale Closure fee plan held for approval
-- "Create installment plan at the time of sale closure" (3 Sep). When the sale needs approval,
-- the plan the counsellor set up is kept here and built the moment the enrolment is approved.
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS plan_setup JSONB NULL;

-- 5 ---------------------------------------------------------------- fee.reverse
INSERT INTO permission (key, module, action) VALUES ('fee.reverse', 'fee', 'reverse')
ON CONFLICT (key) DO NOTHING;
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('fee.reverse', 'Super Admin',        'all'),
      ('fee.reverse', 'Organization Admin', 'all'),
      ('fee.reverse', 'Accountant',         'branch')
    ) AS t(pkey, role_name, scope) LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope FROM role ro, permission p
     WHERE ro.name = r.role_name AND p.key = r.pkey
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;
