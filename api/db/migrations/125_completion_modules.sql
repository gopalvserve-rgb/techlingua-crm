-- ============================================================================
-- 125 — MODULE COMPLETION (client, Oct 2026: "many modules still show Phase 2 pending")
--
-- The screens that were design placeholders become working modules:
--   1. WhatsBot keyword rules + bot reply log  (Engagement › WhatsBot / AI Bot)
--   2. Scholarships — request → approve / reject on an enrolment (Finance › Scholarships)
--   3. Shared Documents — folders + files shared by scope (Workspace › Shared Documents)
--   4. Salary — salary structure, payroll runs, payslips (HR › Salary)
--   5. Tracked keywords (Communication Intelligence › Keyword Tracking)
-- Bot / AI / duplicate-rule / compliance SETTINGS live in app_setting (no table needed).
-- Permissions: scholarship.*, shared_doc.*, payroll.*.
--
-- Additive and idempotent.
-- ============================================================================

-- 1 ------------------------------------------------------------- WhatsBot
CREATE TABLE IF NOT EXISTS wa_bot_rule (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES organisation(id),
  name        VARCHAR(120) NOT NULL,
  keywords    TEXT NOT NULL,                       -- comma-separated, case-insensitive
  match_type  VARCHAR(10) NOT NULL DEFAULT 'contains' CHECK (match_type IN ('contains', 'exact', 'starts')),
  reply       TEXT NOT NULL,
  priority    INT NOT NULL DEFAULT 100,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  hits        INT NOT NULL DEFAULT 0,
  created_by  BIGINT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ NULL,
  deleted_by  BIGINT NULL
);
CREATE INDEX IF NOT EXISTS idx_wa_bot_rule_org ON wa_bot_rule (org_id, priority) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS wa_bot_log (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       BIGINT NOT NULL REFERENCES organisation(id),
  phone10      VARCHAR(10) NOT NULL,
  lead_id      BIGINT NULL,
  kind         VARCHAR(12) NOT NULL CHECK (kind IN ('welcome', 'keyword', 'away', 'ai', 'handover', 'skipped')),
  rule_id      BIGINT NULL,
  inbound_text TEXT NULL,
  reply_text   TEXT NULL,
  status       VARCHAR(12) NULL,
  error        VARCHAR(300) NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_bot_log_org ON wa_bot_log (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_bot_log_phone ON wa_bot_log (org_id, phone10, created_at DESC);

-- 2 ---------------------------------------------------------- Scholarships
CREATE TABLE IF NOT EXISTS scholarship (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         BIGINT NOT NULL REFERENCES organisation(id),
  enrolment_id   BIGINT NOT NULL REFERENCES enrolment(id),
  branch_id      BIGINT NULL, vertical_id BIGINT NULL, pipeline_id BIGINT NULL, campaign_id BIGINT NULL,
  counsellor_id  BIGINT NULL, team_id BIGINT NULL,
  scholarship_type VARCHAR(8) NOT NULL CHECK (scholarship_type IN ('percent', 'amount')),
  value          NUMERIC(12,2) NOT NULL,
  amount_minor   BIGINT NOT NULL,                  -- the computed ₹ (paise) it takes off the net fee
  reason         TEXT NOT NULL,
  status         VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by   BIGINT NULL,
  decided_by     BIGINT NULL,
  decided_at     TIMESTAMPTZ NULL,
  remarks        TEXT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ NULL,
  deleted_by     BIGINT NULL
);
CREATE INDEX IF NOT EXISTS idx_scholarship_enrolment ON scholarship (enrolment_id) WHERE deleted_at IS NULL;
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS scholarship_minor BIGINT NOT NULL DEFAULT 0;

-- 3 ------------------------------------------------------- Shared Documents
CREATE TABLE IF NOT EXISTS shared_doc_folder (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES organisation(id),
  name        VARCHAR(120) NOT NULL,
  created_by  BIGINT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ NULL
);
CREATE TABLE IF NOT EXISTS shared_doc (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       BIGINT NOT NULL REFERENCES organisation(id),
  folder_id    BIGINT NULL REFERENCES shared_doc_folder(id),
  title        VARCHAR(200) NOT NULL,
  description  TEXT NULL,
  file_name    VARCHAR(255) NOT NULL,
  mime         VARCHAR(120) NULL,
  size_bytes   BIGINT NOT NULL DEFAULT 0,
  r2_key       VARCHAR(400) NULL,
  content      BYTEA NULL,
  share_scope  VARCHAR(10) NOT NULL DEFAULT 'all' CHECK (share_scope IN ('all', 'branch', 'vertical', 'role')),
  branch_id    BIGINT NULL, vertical_id BIGINT NULL, role_id BIGINT NULL,
  downloads    INT NOT NULL DEFAULT 0,
  uploaded_by  BIGINT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ NULL,
  deleted_by   BIGINT NULL
);
CREATE INDEX IF NOT EXISTS idx_shared_doc_org ON shared_doc (org_id, created_at DESC) WHERE deleted_at IS NULL;

-- 4 ------------------------------------------------------------------ Salary
CREATE TABLE IF NOT EXISTS salary_structure (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          BIGINT NOT NULL REFERENCES organisation(id),
  employee_id     BIGINT NOT NULL UNIQUE,
  basic_minor     BIGINT NOT NULL DEFAULT 0,
  hra_minor       BIGINT NOT NULL DEFAULT 0,
  allowance_minor BIGINT NOT NULL DEFAULT 0,
  pf_pct          NUMERIC(5,2) NOT NULL DEFAULT 0,     -- employee PF, % of basic
  esi_pct         NUMERIC(5,2) NOT NULL DEFAULT 0,     -- employee ESI, % of gross
  pt_minor        BIGINT NOT NULL DEFAULT 0,           -- professional tax per month
  tds_minor       BIGINT NOT NULL DEFAULT 0,           -- TDS per month
  effective_from  DATE NULL,
  updated_by      BIGINT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payroll_run (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES organisation(id),
  period      VARCHAR(7) NOT NULL,                     -- YYYY-MM
  branch_id   BIGINT NULL,
  status      VARCHAR(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'finalised')),
  gross_minor BIGINT NOT NULL DEFAULT 0,
  net_minor   BIGINT NOT NULL DEFAULT 0,
  created_by  BIGINT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalised_at TIMESTAMPTZ NULL,
  deleted_at  TIMESTAMPTZ NULL
);
CREATE TABLE IF NOT EXISTS payslip (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id        BIGINT NOT NULL REFERENCES payroll_run(id) ON DELETE CASCADE,
  employee_id   BIGINT NOT NULL,
  days_in_month INT NOT NULL,
  paid_days     NUMERIC(5,1) NOT NULL,
  earnings      JSONB NOT NULL DEFAULT '{}',
  deductions    JSONB NOT NULL DEFAULT '{}',
  gross_minor   BIGINT NOT NULL DEFAULT 0,
  deduction_minor BIGINT NOT NULL DEFAULT 0,
  net_minor     BIGINT NOT NULL DEFAULT 0,
  UNIQUE (run_id, employee_id)
);

-- 5 ------------------------------------------------------- Tracked keywords
CREATE TABLE IF NOT EXISTS tracked_keyword (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES organisation(id),
  keyword     VARCHAR(80) NOT NULL,
  category    VARCHAR(40) NULL,                    -- course / competitor / objection / other
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  BIGINT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tracked_keyword ON tracked_keyword (org_id, lower(keyword)) WHERE deleted_at IS NULL;

-- 6 ------------------------------------------------------------ permissions
INSERT INTO permission (key, module, action) VALUES
  ('scholarship.read', 'scholarship', 'read'), ('scholarship.request', 'scholarship', 'request'),
  ('scholarship.approve', 'scholarship', 'approve'), ('scholarship.delete', 'scholarship', 'delete'),
  ('shared_doc.read', 'shared_doc', 'read'), ('shared_doc.upload', 'shared_doc', 'upload'),
  ('shared_doc.delete', 'shared_doc', 'delete'),
  ('payroll.read', 'payroll', 'read'), ('payroll.manage', 'payroll', 'manage')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('scholarship.read', 'Super Admin', 'all'), ('scholarship.read', 'Organization Admin', 'all'),
      ('scholarship.read', 'Branch Manager', 'branch'), ('scholarship.read', 'Vertical Manager', 'vertical'),
      ('scholarship.read', 'Accountant', 'branch'), ('scholarship.read', 'Academic Admin', 'branch'),
      ('scholarship.read', 'Counsellor', 'own'), ('scholarship.read', 'Team Leader', 'team'),
      ('scholarship.request', 'Super Admin', 'all'), ('scholarship.request', 'Organization Admin', 'all'),
      ('scholarship.request', 'Branch Manager', 'branch'), ('scholarship.request', 'Vertical Manager', 'vertical'),
      ('scholarship.request', 'Accountant', 'branch'), ('scholarship.request', 'Academic Admin', 'branch'),
      ('scholarship.request', 'Counsellor', 'own'), ('scholarship.request', 'Team Leader', 'team'),
      ('scholarship.approve', 'Super Admin', 'all'), ('scholarship.approve', 'Organization Admin', 'all'),
      ('scholarship.approve', 'Branch Manager', 'branch'), ('scholarship.approve', 'Vertical Manager', 'vertical'),
      ('scholarship.approve', 'Academic Admin', 'branch'),
      ('scholarship.delete', 'Super Admin', 'all'), ('scholarship.delete', 'Organization Admin', 'all'),
      ('shared_doc.read', 'Super Admin', 'all'), ('shared_doc.read', 'Organization Admin', 'all'),
      ('shared_doc.read', 'Branch Manager', 'all'), ('shared_doc.read', 'Vertical Manager', 'all'),
      ('shared_doc.read', 'Academic Admin', 'all'), ('shared_doc.read', 'Academic Coordinator', 'all'),
      ('shared_doc.read', 'Accountant', 'all'), ('shared_doc.read', 'Counsellor', 'all'),
      ('shared_doc.read', 'HR Manager', 'all'), ('shared_doc.read', 'Marketing Manager', 'all'),
      ('shared_doc.read', 'Team Leader', 'all'), ('shared_doc.read', 'Telecaller', 'all'), ('shared_doc.read', 'Trainer', 'all'),
      ('shared_doc.upload', 'Super Admin', 'all'), ('shared_doc.upload', 'Organization Admin', 'all'),
      ('shared_doc.upload', 'Branch Manager', 'all'), ('shared_doc.upload', 'Vertical Manager', 'all'),
      ('shared_doc.upload', 'Academic Admin', 'all'), ('shared_doc.upload', 'HR Manager', 'all'),
      ('shared_doc.upload', 'Marketing Manager', 'all'), ('shared_doc.upload', 'Team Leader', 'all'),
      ('shared_doc.delete', 'Super Admin', 'all'), ('shared_doc.delete', 'Organization Admin', 'all'),
      ('payroll.read', 'Super Admin', 'all'), ('payroll.read', 'Organization Admin', 'all'), ('payroll.read', 'HR Manager', 'all'),
      ('payroll.read', 'Accountant', 'all'),
      ('payroll.manage', 'Super Admin', 'all'), ('payroll.manage', 'Organization Admin', 'all'), ('payroll.manage', 'HR Manager', 'all')
    ) AS t(pkey, role_name, scope) LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope FROM role ro, permission p
     WHERE ro.name = r.role_name AND p.key = r.pkey
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;
