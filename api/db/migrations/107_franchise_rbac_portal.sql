-- ===========================================================================
-- 107 — FRANCHISE OWNER RBAC · PARTNER PORTAL · TARGETS · COMPLIANCE
--        (Phase 4 Batch 3, dev/138 — the FINAL franchise batch; COMPLETES Phase 4)
--
-- Batches 1-2 (105/106) shipped franchise records + branch mapping, royalty plans /
-- statements / invoices / payments / ageing, agreements, onboarding, territory and
-- franchise reports — but all HEAD-OFFICE / admin-only. This batch adds:
--
--   1) A FRANCHISE OWNER system role + a franchise<->owner-user link, so a franchise
--      owner logs in and sees ONLY their franchise's mapped branches' data. Enforcement
--      is at the API layer: the RBAC scope resolver stamps the owner's branch_ids onto
--      every ResolvedScope and buildScopeWhere AND-narrows every branch-bearing query to
--      it (leads / students / finance / everything). ADDITIVE — Super Admin and the
--      existing branch-scoped roles are untouched.
--   2) A PARTNER SELF-SERVICE PORTAL (owner view) — reuses the Batch-1/2 rollups fixed
--      to the logged-in owner's franchise (no franchise selector).
--   3) FRANCHISE TARGETS & PERFORMANCE — per-franchise target setting (admissions,
--      revenue, collection, enrolments) + target-vs-actual + a head-office leaderboard.
--      New table franchise_target (chosen over overloading target_definition: a franchise
--      is not one of target_definition's target_for units, and the actuals come from a
--      DIFFERENT source — the franchise's branches — so a dedicated grain is cleaner).
--   4) COMPLIANCE & AUDITS — a per-franchise compliance checklist materialised from a
--      seeded default TEMPLATE (agreement valid, GST filed, royalty up to date, KYC, …),
--      each item status + due date + evidence (R2), plus an audit view that reuses the
--      existing audit_log filtered to franchise-critical entities (no new audit table).
--
-- Idempotent throughout. No fake franchise data is seeded (only a compliance TEMPLATE +
-- the role). Backfills so live rows keep working.
-- ===========================================================================

-- 1 ------------------------------------------------ franchise <-> owner-user link
ALTER TABLE franchise ADD COLUMN IF NOT EXISTS owner_user_id BIGINT NULL REFERENCES "user"(id);
CREATE INDEX IF NOT EXISTS idx_franchise_owner_user ON franchise (owner_user_id) WHERE deleted_at IS NULL;

-- A franchise may expose the portal to more than one user (owner + partner staff). The
-- primary owner is franchise.owner_user_id; franchise_user is the general mapping. Either
-- link makes the user a "franchise owner" for scoping (RbacDataService.loadFranchiseScope).
CREATE TABLE IF NOT EXISTS franchise_user (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       BIGINT NOT NULL REFERENCES organisation(id),
  franchise_id BIGINT NOT NULL REFERENCES franchise(id) ON DELETE CASCADE,
  user_id      BIGINT NOT NULL REFERENCES "user"(id),
  role         VARCHAR(16) NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'staff')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (franchise_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_franchise_user_user ON franchise_user (user_id);

-- 2 --------------------------------------------------------------- permissions
INSERT INTO permission (key, module, action) VALUES
  ('franchise_portal.read',       'franchise_portal',     'read'),
  ('franchise_target.read',       'franchise_target',     'read'),
  ('franchise_target.manage',     'franchise_target',     'manage'),
  ('franchise_compliance.read',   'franchise_compliance', 'read'),
  ('franchise_compliance.manage', 'franchise_compliance', 'manage')
ON CONFLICT (key) DO NOTHING;

-- 3 --------------------------------------------- the Franchise Owner system role (per org)
DO $$
DECLARE o RECORD;
BEGIN
  FOR o IN SELECT id FROM organisation LOOP
    INSERT INTO role (org_id, name, is_system, description)
    SELECT o.id, 'Franchise Owner', TRUE,
           'System role: Franchise Owner - a franchise partner. Sees ONLY their franchise''s mapped branches'' data (read-only portal): dashboard, students/enrolments, collections, royalty statements & invoices, targets and compliance. Cannot see other franchises or head-office-only data.'
    WHERE NOT EXISTS (SELECT 1 FROM role WHERE org_id = o.id AND name = 'Franchise Owner');
  END LOOP;
END $$;

-- 4 ------------------------------------------------------------ role grants
-- Franchise Owner gets READ permissions at record_scope 'all'; the franchise-owner LAYER
-- (buildScopeWhere) then AND-narrows every branch-bearing read to their franchise's
-- branch_ids, so 'all' here means "all of MY franchise", never head office. No create/
-- update/delete on operational data — the portal is read-only. The two admin roles get
-- the four new target/compliance/portal permissions @ 'all'.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('dashboard.read',             'Franchise Owner', 'all'),
      ('notification.read',          'Franchise Owner', 'all'),
      ('master.read',                'Franchise Owner', 'all'),
      ('lead.read',                  'Franchise Owner', 'all'),
      ('followup.read',              'Franchise Owner', 'all'),
      ('student.read',               'Franchise Owner', 'all'),
      ('batch.read',                 'Franchise Owner', 'all'),
      ('enrolment.read',             'Franchise Owner', 'all'),
      ('fee.read',                   'Franchise Owner', 'all'),
      ('finance.read',               'Franchise Owner', 'all'),
      ('franchise.read',             'Franchise Owner', 'all'),
      ('royalty.read',               'Franchise Owner', 'all'),
      ('franchise_portal.read',      'Franchise Owner', 'all'),
      ('franchise_target.read',      'Franchise Owner', 'all'),
      ('franchise_compliance.read',  'Franchise Owner', 'all'),
      ('franchise_portal.read',       'Super Admin',        'all'),
      ('franchise_portal.read',       'Organization Admin', 'all'),
      ('franchise_target.read',       'Super Admin',        'all'),
      ('franchise_target.read',       'Organization Admin', 'all'),
      ('franchise_target.manage',     'Super Admin',        'all'),
      ('franchise_target.manage',     'Organization Admin', 'all'),
      ('franchise_compliance.read',   'Super Admin',        'all'),
      ('franchise_compliance.read',   'Organization Admin', 'all'),
      ('franchise_compliance.manage', 'Super Admin',        'all'),
      ('franchise_compliance.manage', 'Organization Admin', 'all')
    ) AS v(pkey, role_name, scope)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope
      FROM role ro, permission p
     WHERE ro.name = r.role_name AND p.key = r.pkey
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;

-- 5 -------------------------------------------------------------- franchise_target
CREATE TABLE IF NOT EXISTS franchise_target (
  id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id                  BIGINT NOT NULL REFERENCES organisation(id),
  franchise_id            BIGINT NOT NULL REFERENCES franchise(id) ON DELETE CASCADE,
  name                    VARCHAR(160) NOT NULL,
  period_type             VARCHAR(12) NOT NULL DEFAULT 'monthly'
                          CHECK (period_type IN ('monthly', 'quarterly', 'half_yearly', 'yearly', 'custom')),
  period_start            DATE NOT NULL,
  period_end              DATE NOT NULL,
  admissions_target       INT    NOT NULL DEFAULT 0 CHECK (admissions_target >= 0),
  enrolments_target       INT    NOT NULL DEFAULT 0 CHECK (enrolments_target >= 0),
  revenue_target_minor    BIGINT NOT NULL DEFAULT 0 CHECK (revenue_target_minor >= 0),
  collection_target_minor BIGINT NOT NULL DEFAULT 0 CHECK (collection_target_minor >= 0),
  note                    TEXT NULL,
  created_by              BIGINT NULL REFERENCES "user"(id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at              TIMESTAMPTZ NULL,
  deleted_by              BIGINT NULL REFERENCES "user"(id),
  CHECK (period_end >= period_start)
);
CREATE INDEX IF NOT EXISTS idx_franchise_target_fr ON franchise_target (franchise_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_franchise_target_org ON franchise_target (org_id) WHERE deleted_at IS NULL;

-- 6 ------------------------------------------ franchise compliance (template + items)
CREATE TABLE IF NOT EXISTS franchise_compliance_template (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id     BIGINT NOT NULL REFERENCES organisation(id),
  title      VARCHAR(160) NOT NULL,
  category   VARCHAR(40) NOT NULL DEFAULT 'general',
  sort_order INT NOT NULL DEFAULT 0,
  UNIQUE (org_id, title)
);

CREATE TABLE IF NOT EXISTS franchise_compliance_item (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES organisation(id),
  franchise_id  BIGINT NOT NULL REFERENCES franchise(id) ON DELETE CASCADE,
  title         VARCHAR(160) NOT NULL,
  category      VARCHAR(40) NOT NULL DEFAULT 'general',
  status        VARCHAR(16) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'compliant', 'non_compliant', 'na')),
  due_date      DATE NULL,
  evidence_key  TEXT NULL,
  evidence_name VARCHAR(200) NULL,
  note          TEXT NULL,
  sort_order    INT NOT NULL DEFAULT 0,
  completed_by  BIGINT NULL REFERENCES "user"(id),
  completed_at  TIMESTAMPTZ NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fr_compliance_item_fr ON franchise_compliance_item (franchise_id);

DO $$
DECLARE o RECORD;
BEGIN
  FOR o IN SELECT id FROM organisation LOOP
    INSERT INTO franchise_compliance_template (org_id, title, category, sort_order)
    SELECT o.id, t.title, t.category, t.sort_order
      FROM (VALUES
        ('Franchise agreement signed & valid',        'legal',       10),
        ('KYC of owner complete',                      'legal',       20),
        ('GST registration valid & returns filed',     'statutory',   30),
        ('Statutory documents on file (PAN/licences)', 'statutory',   40),
        ('Royalty up to date (no overdue invoices)',   'finance',     50),
        ('Fee structure follows brand policy',         'finance',     60),
        ('Brand & signage standards adhered',          'brand',       70),
        ('Trainer / staff credentials verified',       'academics',   80),
        ('Student data & privacy compliance',          'operations',  90)
      ) AS t(title, category, sort_order)
    WHERE NOT EXISTS (
      SELECT 1 FROM franchise_compliance_template x WHERE x.org_id = o.id AND x.title = t.title
    );
  END LOOP;
END $$;
