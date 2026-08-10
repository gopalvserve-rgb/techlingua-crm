-- =============================================================================
-- 058 — PHASE 3 BATCH 4: REFUNDS (approval hierarchy) + REVENUE (collection vs
--        accrual) + COLLECTION REPORTS + TALLY EXPORT
--
--   1) refund                 — a full or PARTIAL refund against an enrolment's collected
--                               fee (optionally citing the specific fee_receipt). Money is
--                               BIGINT paise. A refund is REQUESTED (status 'pending'),
--                               then APPROVED or REJECTED by a permitted role (never the
--                               requester — the self-approval bar lives in the service AND
--                               is unreachable for a plain requester by RBAC). On approval
--                               the refund gets a voucher number (numbering series 'refund',
--                               REF- per branch/vertical, reset per Indian FY) and REDUCES
--                               net collected (net = receipts - approved refunds) — so the
--                               revenue view, the finance dashboard and the collection
--                               reports all net it out from ONE fact.
--   2) refund_approvals        — app_setting policy: approval always required; a configurable
--                               HIGH-VALUE threshold above which the higher permission
--                               (refund.approve_high) is needed. Simple + configurable, and
--                               documented in docs/dev/52.
--   3) 'refund' numbering series (REF-, reset 'fy') — seeded org-wide so the Numbering
--                               screen lists it immediately (mirrors 055's 'invoice').
--   4) permissions + grants    — refund.read / refund.request / refund.approve /
--                               refund.approve_high / refund.delete, revenue.read,
--                               collection_report.read / collection_report.export.
--
-- Idempotent throughout (IF NOT EXISTS / ON CONFLICT DO NOTHING). No secret added.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) refund
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refund (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          BIGINT NOT NULL REFERENCES organisation(id),
  refund_no       VARCHAR(48) NULL,                       -- allocated ON APPROVAL, not on request
  enrolment_id    BIGINT NOT NULL REFERENCES enrolment(id),
  fee_receipt_id  BIGINT NULL REFERENCES fee_receipt(id), -- the specific receipt, if cited
  lead_id         BIGINT NULL REFERENCES lead(id),
  branch_id       BIGINT NOT NULL REFERENCES branch(id),
  vertical_id     BIGINT NOT NULL REFERENCES vertical(id),
  amount_minor    BIGINT NOT NULL CHECK (amount_minor > 0),
  reason          TEXT NOT NULL,
  mode            VARCHAR(12) NOT NULL CHECK (mode IN ('cash', 'upi', 'card', 'cheque', 'online')),
  reference       VARCHAR(64) NULL,                       -- UTR / cheque no of the payout
  status          VARCHAR(12) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  requires_high   BOOLEAN NOT NULL DEFAULT FALSE,         -- above the high-value threshold?
  requested_by    BIGINT NULL REFERENCES "user"(id),
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  approver_id     BIGINT NULL REFERENCES "user"(id),
  decided_at      TIMESTAMPTZ NULL,
  decide_note     TEXT NULL,
  refunded_at     TIMESTAMPTZ NULL,                       -- when the money was released (= decided_at on approve)
  note            TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ NULL,
  deleted_by      BIGINT NULL REFERENCES "user"(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_refund_no ON refund (org_id, refund_no) WHERE refund_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_refund_enrolment ON refund (enrolment_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_refund_status ON refund (status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_refund_scope ON refund (branch_id, vertical_id, requested_at) WHERE deleted_at IS NULL;
-- Only ONE open (pending) refund request per enrolment+amount+requester can never be
-- forced, but we DO want to stop a double-submit creating two identical pending rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_refund_open
  ON refund (enrolment_id, amount_minor, requested_by) WHERE status = 'pending' AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2) refund approval policy — approval ALWAYS on; a high-value threshold decides
--    whether the higher approver (refund.approve_high) is required. Default ₹25,000.
-- ---------------------------------------------------------------------------
INSERT INTO app_setting (key, value)
VALUES ('refund_approvals', jsonb_build_object(
  'require_approval', TRUE,
  'high_value_over_minor', 2500000,
  'high_roles', jsonb_build_array('Branch Manager', 'Vertical Manager', 'Organization Admin'),
  'roles', jsonb_build_array('Branch Manager', 'Vertical Manager', 'Accountant')
))
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3) 'refund' numbering series — REF-, reset per Indian FY, seeded org-wide.
-- ---------------------------------------------------------------------------
INSERT INTO number_series (org_id, kind, prefix, next_number, padding, reset_period)
SELECT id, 'refund', 'REF-', 1, 4, 'fy' FROM organisation ORDER BY id LIMIT 1
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4) Permissions + grants.
-- ---------------------------------------------------------------------------
INSERT INTO permission (key, module, action) VALUES
  ('refund.read',            'refund',           'read'),
  ('refund.request',         'refund',           'request'),
  ('refund.approve',         'refund',           'approve'),
  ('refund.approve_high',    'refund',           'approve_high'),
  ('refund.delete',          'refund',           'delete'),
  ('revenue.read',           'revenue',          'read'),
  ('collection_report.read',   'collection_report', 'read'),
  ('collection_report.export', 'collection_report', 'export')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- refund.read — everyone who can see fees
      ('refund.read',           'Super Admin',        'all'),
      ('refund.read',           'Organization Admin', 'all'),
      ('refund.read',           'Accountant',         'all'),
      ('refund.read',           'Branch Manager',     'branch'),
      ('refund.read',           'Vertical Manager',   'vertical'),
      ('refund.read',           'Team Leader',        'team'),
      ('refund.read',           'Counsellor',         'own'),
      -- refund.request — a counsellor/accountant can RAISE a refund request
      ('refund.request',        'Super Admin',        'all'),
      ('refund.request',        'Organization Admin', 'all'),
      ('refund.request',        'Accountant',         'all'),
      ('refund.request',        'Branch Manager',     'branch'),
      ('refund.request',        'Vertical Manager',   'vertical'),
      ('refund.request',        'Team Leader',        'team'),
      ('refund.request',        'Counsellor',         'own'),
      -- refund.approve — managers + accountant (NOT counsellor / team leader)
      ('refund.approve',        'Super Admin',        'all'),
      ('refund.approve',        'Organization Admin', 'all'),
      ('refund.approve',        'Accountant',         'all'),
      ('refund.approve',        'Branch Manager',     'branch'),
      ('refund.approve',        'Vertical Manager',   'vertical'),
      -- refund.approve_high — only the senior approvers clear a high-value refund
      ('refund.approve_high',   'Super Admin',        'all'),
      ('refund.approve_high',   'Organization Admin', 'all'),
      ('refund.approve_high',   'Branch Manager',     'branch'),
      ('refund.approve_high',   'Vertical Manager',   'vertical'),
      -- refund.delete — admins only (soft-delete a mistaken request)
      ('refund.delete',         'Super Admin',        'all'),
      ('refund.delete',         'Organization Admin', 'all'),
      ('refund.delete',         'Accountant',         'all'),
      -- revenue.read
      ('revenue.read',          'Super Admin',        'all'),
      ('revenue.read',          'Organization Admin', 'all'),
      ('revenue.read',          'Accountant',         'all'),
      ('revenue.read',          'Marketing Manager',  'all'),
      ('revenue.read',          'Branch Manager',     'branch'),
      ('revenue.read',          'Vertical Manager',   'vertical'),
      -- collection_report.read
      ('collection_report.read',   'Super Admin',        'all'),
      ('collection_report.read',   'Organization Admin', 'all'),
      ('collection_report.read',   'Accountant',         'all'),
      ('collection_report.read',   'Marketing Manager',  'all'),
      ('collection_report.read',   'Branch Manager',     'branch'),
      ('collection_report.read',   'Vertical Manager',   'vertical'),
      ('collection_report.read',   'Team Leader',        'team'),
      -- collection_report.export
      ('collection_report.export', 'Super Admin',        'all'),
      ('collection_report.export', 'Organization Admin', 'all'),
      ('collection_report.export', 'Accountant',         'all'),
      ('collection_report.export', 'Branch Manager',     'branch'),
      ('collection_report.export', 'Vertical Manager',   'vertical')
    ) AS v(pkey, role_name, scope)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope
      FROM role ro, permission p
     WHERE ro.name = r.role_name AND p.key = r.pkey
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;
