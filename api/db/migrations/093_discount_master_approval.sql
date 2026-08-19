-- =============================================================================
-- 093 — DISCOUNT MASTER + OVER-CAP APPROVAL  [level/fee re-model, batch 3 of 3]
--
-- Client requirement: a manageable DISCOUNT MASTER caps a discount by AMOUNT (₹) and by
-- PERCENTAGE (%). If a counsellor asks for MORE than the cap, the over-cap portion needs
-- APPROVAL from an authorized user (Academic Admin / Org / Super Admin).
--
-- THE MODEL
--   * discount_master — named cap rules, each with a max_percent and/or max_amount_minor,
--     optionally SCOPED by branch / vertical / course. A NULL scope column = "applies to
--     all". Resolution is MOST-SPECIFIC-WINS (the number_series / finance_setting rule):
--     given a (branch, vertical, course) the applicable cap is the ACTIVE master whose
--     non-null scope columns all match, with the greatest number of matched columns.
--     This EXTENDS the existing finance_setting capping (migration 045) into a manageable
--     master the client edits himself.
--
--   * enrolment over-cap approval — when the discount requested at enroll/convert/edit
--     EXCEEDS the applicable cap, the enrolment records the FULL requested discount but
--     APPLIES ONLY UP TO THE CAP immediately; the excess is held `pending` until an
--     authorized user (discount.approve) approves it. On approval the full discount is
--     applied and Net/Due recompute (+ the payment plan reconciles). A user who already
--     holds discount.approve (or finance.override) applies the full amount inline.
--
--   * permission discount.* (read/create/update/delete/approve). approve is granted to
--     Academic Admin / Organization Admin / Super Admin — the client's chosen approvers
--     (the same role set as admission.approve, migration 075).
--
-- Money columns are PAISE (BIGINT). Idempotent throughout (IF NOT EXISTS / ON CONFLICT).
-- =============================================================================

-- 1 ---------------------------------------------------------- discount_master table
CREATE TABLE IF NOT EXISTS discount_master (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id           BIGINT NOT NULL REFERENCES organisation(id),
  name             VARCHAR(120) NOT NULL,
  branch_id        BIGINT NULL REFERENCES branch(id),     -- NULL = all branches
  vertical_id      BIGINT NULL REFERENCES vertical(id),   -- NULL = all verticals
  course_id        BIGINT NULL REFERENCES m_course(id),   -- NULL = all courses
  max_percent      NUMERIC(6,3) NULL CHECK (max_percent IS NULL OR (max_percent >= 0 AND max_percent <= 100)),
  max_amount_minor BIGINT NULL CHECK (max_amount_minor IS NULL OR max_amount_minor >= 0),
  active           BOOLEAN NOT NULL DEFAULT true,
  created_by       BIGINT NULL REFERENCES "user"(id),
  updated_by       BIGINT NULL REFERENCES "user"(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS idx_discount_master_org
  ON discount_master (org_id, active) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_discount_master_scope
  ON discount_master (org_id, branch_id, vertical_id, course_id) WHERE deleted_at IS NULL;

-- 2 ------------------------------------------- enrolment over-cap approval columns
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS discount_approval_status VARCHAR(12) NOT NULL DEFAULT 'none';
ALTER TABLE enrolment DROP CONSTRAINT IF EXISTS chk_enrolment_discount_approval_status;
ALTER TABLE enrolment ADD  CONSTRAINT chk_enrolment_discount_approval_status
  CHECK (discount_approval_status IN ('none', 'pending', 'approved', 'rejected'));
-- The FULL requested discount (incl. the over-cap portion). discount_minor stays the
-- APPLIED (capped-while-pending) discount so every existing reader keeps reading truth.
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS discount_requested_minor BIGINT NOT NULL DEFAULT 0 CHECK (discount_requested_minor >= 0);
-- The cap that applied at request time (paise). NULL = no cap configured.
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS discount_cap_minor BIGINT NULL;
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS discount_requested_by BIGINT NULL REFERENCES "user"(id);
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS discount_approved_by BIGINT NULL REFERENCES "user"(id);
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS discount_approved_at TIMESTAMPTZ NULL;
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS discount_approval_remarks TEXT NULL;

-- 3 -------------------------------------------- permission discount.* + role grants
INSERT INTO permission (key, module, action) VALUES
  ('discount.read',   'discount', 'read'),
  ('discount.create', 'discount', 'create'),
  ('discount.update', 'discount', 'update'),
  ('discount.delete', 'discount', 'delete'),
  ('discount.approve','discount', 'approve')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- read: managers + admins see the caps
      ('discount.read',    'Academic Admin',     'branch'),
      ('discount.read',    'Branch Manager',     'branch'),
      ('discount.read',    'Vertical Manager',   'vertical'),
      ('discount.read',    'Organization Admin', 'all'),
      ('discount.read',    'Super Admin',        'all'),
      -- create/update/delete: manage the master (admins + branch/vertical managers)
      ('discount.create',  'Academic Admin',     'branch'),
      ('discount.create',  'Organization Admin', 'all'),
      ('discount.create',  'Super Admin',        'all'),
      ('discount.update',  'Academic Admin',     'branch'),
      ('discount.update',  'Organization Admin', 'all'),
      ('discount.update',  'Super Admin',        'all'),
      ('discount.delete',  'Organization Admin', 'all'),
      ('discount.delete',  'Super Admin',        'all'),
      -- approve over-cap discount: the client's chosen approvers
      ('discount.approve', 'Academic Admin',     'branch'),
      ('discount.approve', 'Organization Admin', 'all'),
      ('discount.approve', 'Super Admin',        'all')
    ) AS v(pkey, role_name, scope)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope
      FROM role ro, permission p
     WHERE ro.name = r.role_name AND p.key = r.pkey
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;

-- 4 ---------------------------------- seed a sensible default org-wide discount cap
-- Reuse the existing finance_setting cap values as the seed where present, else 25%.
-- One default per org; only if the org has NO discount_master rows yet (idempotent).
DO $$
DECLARE o RECORD;
BEGIN
  FOR o IN SELECT id FROM organisation LOOP
    IF NOT EXISTS (SELECT 1 FROM discount_master WHERE org_id = o.id) THEN
      INSERT INTO discount_master (org_id, name, max_percent, max_amount_minor, active)
      SELECT o.id, 'Default discount cap',
             COALESCE(fs.cap_max_pct, fs.discount_max_pct, 25),
             COALESCE(fs.cap_max_minor, fs.discount_max_minor),
             true
        FROM (SELECT 1) x
        LEFT JOIN finance_setting fs ON fs.org_id = o.id AND fs.vertical_id IS NULL;
    END IF;
  END LOOP;
END $$;
