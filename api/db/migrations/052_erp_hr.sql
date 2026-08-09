-- =============================================================================
-- 052 — ERP BASIC HR (Phase 2, Batch 6) — no statutory payroll
--
-- Three modules on India-first foundations (Indian mobile/E.164, IST dates, India leave types):
--   1) EMPLOYEE DIRECTORY   — an employee register: code (numbering EMP-), name, optional link to
--                             a user account, designation, department, branch/vertical, date of
--                             joining, employment type, contact, personal, status, reporting mgr.
--   2) STAFF ATTENDANCE     — daily attendance per employee (present/absent/half_day/leave/holiday)
--                             for a date, marked by HR/manager or self check-in. Monthly sheet per
--                             branch + a per-employee summary. (Mirrors the academics attendance
--                             pattern — this is for STAFF, not students.)
--   3) LEAVES               — configurable leave types (Casual/Sick/Earned/Unpaid), a balance per
--                             employee/type/year, a leave application (apply → approve/reject), and
--                             on approval it deducts the balance and marks those days as Leave in
--                             attendance. Manager approves; nobody approves their own.
--
-- Scope: employee / hr_attendance / leave_application DENORMALISE branch_id (+ vertical_id) so the
-- ScopeResolver filters them like every branch-scoped module. leave_type is an org-wide master.
--
-- Idempotent throughout (IF NOT EXISTS / guarded / ON CONFLICT DO NOTHING). Re-runnable. Table
-- order respects FK dependencies (employee before hr_attendance/leave_*; leave_type before balances).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) employee — the employee register. Branch-scoped. reporting_manager_id self-refs employee.
--    user_id optionally links to a "user" account (staff ARE users; an employee record may or may
--    not have a login).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employee (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id              BIGINT NOT NULL REFERENCES organisation(id),
  employee_code       VARCHAR(48) NOT NULL,
  name                VARCHAR(200) NOT NULL,
  user_id             BIGINT NULL REFERENCES "user"(id),
  designation         VARCHAR(120) NULL,
  department          VARCHAR(40) NULL,          -- Sales / Academics / Finance / Admin / Marketing
  branch_id           BIGINT NOT NULL REFERENCES branch(id),
  vertical_id         BIGINT NULL REFERENCES vertical(id),
  date_of_joining     DATE NULL,
  employment_type     VARCHAR(16) NOT NULL DEFAULT 'full_time'
                        CHECK (employment_type IN ('full_time', 'part_time', 'contract')),
  phone               VARCHAR(24) NULL,          -- Indian mobile / E.164
  email               VARCHAR(160) NULL,
  dob                 DATE NULL,
  gender              VARCHAR(12) NULL,          -- male / female / other
  status              VARCHAR(12) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  reporting_manager_id BIGINT NULL REFERENCES employee(id),
  notes               TEXT NULL,
  created_by          BIGINT NULL REFERENCES "user"(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ NULL,
  deleted_by          BIGINT NULL REFERENCES "user"(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_code ON employee (org_id, lower(employee_code)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_employee_branch ON employee (branch_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_employee_status ON employee (status) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2) hr_attendance — daily STAFF attendance (one row per employee per date). Branch-scoped.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hr_attendance (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES organisation(id),
  employee_id   BIGINT NOT NULL REFERENCES employee(id),
  branch_id     BIGINT NOT NULL REFERENCES branch(id),
  vertical_id   BIGINT NULL REFERENCES vertical(id),
  att_date      DATE NOT NULL,
  status        VARCHAR(12) NOT NULL CHECK (status IN ('present', 'absent', 'half_day', 'leave', 'holiday')),
  mode          VARCHAR(12) NOT NULL DEFAULT 'staff' CHECK (mode IN ('staff', 'self', 'system')),
  remarks       TEXT NULL,
  marked_by     BIGINT NULL REFERENCES "user"(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ NULL,
  deleted_by    BIGINT NULL REFERENCES "user"(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_att_emp_date ON hr_attendance (employee_id, att_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_hr_att_branch_date ON hr_attendance (branch_id, att_date DESC);

-- ---------------------------------------------------------------------------
-- 3a) leave_type — configurable org-wide master. Seeded with India leave types.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leave_type (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES organisation(id),
  name          VARCHAR(80) NOT NULL,
  code          VARCHAR(16) NOT NULL,
  is_paid       BOOLEAN NOT NULL DEFAULT TRUE,
  default_annual_quota NUMERIC(6,1) NOT NULL DEFAULT 0,   -- days/year granted by default
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_leave_type_code ON leave_type (org_id, lower(code)) WHERE deleted_at IS NULL;

-- 3b) leave_balance — per employee, per type, per calendar year. used <= allocated is a soft cap
--     (a manager can still approve into negative for Unpaid; the app enforces the policy).
CREATE TABLE IF NOT EXISTS leave_balance (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES organisation(id),
  employee_id   BIGINT NOT NULL REFERENCES employee(id),
  leave_type_id BIGINT NOT NULL REFERENCES leave_type(id),
  year          INT NOT NULL,
  allocated     NUMERIC(6,1) NOT NULL DEFAULT 0,
  used          NUMERIC(6,1) NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_leave_balance ON leave_balance (employee_id, leave_type_id, year);

-- 3c) leave_application — apply → approve/reject. Branch-scoped (+ owner = applied_by).
CREATE TABLE IF NOT EXISTS leave_application (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES organisation(id),
  employee_id   BIGINT NOT NULL REFERENCES employee(id),
  leave_type_id BIGINT NOT NULL REFERENCES leave_type(id),
  branch_id     BIGINT NOT NULL REFERENCES branch(id),
  vertical_id   BIGINT NULL REFERENCES vertical(id),
  from_date     DATE NOT NULL,
  to_date       DATE NOT NULL,
  days          NUMERIC(5,1) NOT NULL DEFAULT 1,
  reason        TEXT NULL,
  status        VARCHAR(12) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  applied_by    BIGINT NULL REFERENCES "user"(id),
  decided_by    BIGINT NULL REFERENCES "user"(id),
  decided_at    TIMESTAMPTZ NULL,
  decision_note TEXT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ NULL,
  deleted_by    BIGINT NULL REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS idx_leave_app_emp ON leave_application (employee_id, from_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leave_app_status ON leave_application (status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leave_app_branch ON leave_application (branch_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 4) Seed the India leave types (idempotent; only the first org, like every other master).
-- ---------------------------------------------------------------------------
INSERT INTO leave_type (org_id, name, code, is_paid, default_annual_quota)
SELECT o.id, v.name, v.code, v.is_paid, v.quota
  FROM organisation o
  CROSS JOIN (VALUES
    ('Casual Leave', 'CL', TRUE, 12),
    ('Sick Leave',   'SL', TRUE, 12),
    ('Earned Leave', 'EL', TRUE, 15),
    ('Unpaid Leave', 'LWP', FALSE, 0)
  ) AS v(name, code, is_paid, quota)
 WHERE o.id = (SELECT id FROM organisation ORDER BY id LIMIT 1)
   AND NOT EXISTS (SELECT 1 FROM leave_type lt WHERE lt.org_id = o.id AND lower(lt.code) = lower(v.code) AND lt.deleted_at IS NULL);

-- ---------------------------------------------------------------------------
-- 5) Permissions — employee.* / hr_attendance.* / leave.* + role grants.
-- ---------------------------------------------------------------------------
INSERT INTO permission (key, module, action) VALUES
  ('employee.read', 'employee', 'read'),
  ('employee.create', 'employee', 'create'),
  ('employee.update', 'employee', 'update'),
  ('employee.delete', 'employee', 'delete'),
  ('hr_attendance.read', 'hr_attendance', 'read'),
  ('hr_attendance.mark', 'hr_attendance', 'mark'),
  ('hr_attendance.delete', 'hr_attendance', 'delete'),
  ('leave.read', 'leave', 'read'),
  ('leave.create', 'leave', 'create'),
  ('leave.approve', 'leave', 'approve'),
  ('leave.manage', 'leave', 'manage'),
  ('leave.delete', 'leave', 'delete')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- employee directory (branch-scoped)
      ('employee.read',   'Super Admin',        'all'),
      ('employee.read',   'Organization Admin', 'all'),
      ('employee.read',   'Branch Manager',     'branch'),
      ('employee.read',   'Vertical Manager',   'vertical'),
      ('employee.read',   'Team Leader',        'branch'),
      ('employee.create', 'Super Admin',        'all'),
      ('employee.create', 'Organization Admin', 'all'),
      ('employee.create', 'Branch Manager',     'branch'),
      ('employee.create', 'Vertical Manager',   'vertical'),
      ('employee.update', 'Super Admin',        'all'),
      ('employee.update', 'Organization Admin', 'all'),
      ('employee.update', 'Branch Manager',     'branch'),
      ('employee.update', 'Vertical Manager',   'vertical'),
      ('employee.delete', 'Super Admin',        'all'),
      ('employee.delete', 'Organization Admin', 'all'),
      ('employee.delete', 'Branch Manager',     'branch'),
      -- staff attendance (branch-scoped)
      ('hr_attendance.read',   'Super Admin',        'all'),
      ('hr_attendance.read',   'Organization Admin', 'all'),
      ('hr_attendance.read',   'Branch Manager',     'branch'),
      ('hr_attendance.read',   'Vertical Manager',   'vertical'),
      ('hr_attendance.read',   'Team Leader',        'branch'),
      ('hr_attendance.mark',   'Super Admin',        'all'),
      ('hr_attendance.mark',   'Organization Admin', 'all'),
      ('hr_attendance.mark',   'Branch Manager',     'branch'),
      ('hr_attendance.mark',   'Vertical Manager',   'vertical'),
      ('hr_attendance.mark',   'Team Leader',        'branch'),
      ('hr_attendance.delete', 'Super Admin',        'all'),
      ('hr_attendance.delete', 'Organization Admin', 'all'),
      ('hr_attendance.delete', 'Branch Manager',     'branch'),
      -- leaves (branch-scoped + own). A Counsellor can apply for and see their OWN leave.
      ('leave.read',    'Super Admin',        'all'),
      ('leave.read',    'Organization Admin', 'all'),
      ('leave.read',    'Branch Manager',     'branch'),
      ('leave.read',    'Vertical Manager',   'vertical'),
      ('leave.read',    'Team Leader',        'branch'),
      ('leave.read',    'Counsellor',         'own'),
      ('leave.create',  'Super Admin',        'all'),
      ('leave.create',  'Organization Admin', 'all'),
      ('leave.create',  'Branch Manager',     'branch'),
      ('leave.create',  'Vertical Manager',   'vertical'),
      ('leave.create',  'Team Leader',        'branch'),
      ('leave.create',  'Counsellor',         'own'),
      ('leave.approve', 'Super Admin',        'all'),
      ('leave.approve', 'Organization Admin', 'all'),
      ('leave.approve', 'Branch Manager',     'branch'),
      ('leave.approve', 'Vertical Manager',   'vertical'),
      ('leave.approve', 'Team Leader',        'branch'),
      ('leave.manage',  'Super Admin',        'all'),
      ('leave.manage',  'Organization Admin', 'all'),
      ('leave.delete',  'Super Admin',        'all'),
      ('leave.delete',  'Organization Admin', 'all'),
      ('leave.delete',  'Branch Manager',     'branch')
    ) AS v(pkey, role_name, scope)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope
      FROM role ro, permission p
     WHERE ro.name = r.role_name AND p.key = r.pkey
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;
