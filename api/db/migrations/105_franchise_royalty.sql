-- ===========================================================================
-- 105 — FRANCHISE & ROYALTY (Phase 4 Batch 1, dev/136)
--
-- The system is single-tenant, multi-branch, with a FUTURE FRANCHISE layer
-- (PROJECT_DOCUMENTATION Phase 4). A franchise OPERATES one or more BRANCHES;
-- a franchise's data = everything under its mapped branches, so every rollup
-- (revenue collected, net revenue, dues, royalty) is computed by scoping the
-- SAME finance sources the Finance Dashboard uses (fee_receipt for collected,
-- approved refund for refunds, enrolment.net_fee for booked net revenue) to the
-- franchise's branch_ids. Nothing here forks a second copy of money.
--
-- ROYALTY / REVENUE-SHARE is a per-franchise (or reusable template) plan with an
-- effective date range and one of four models — % of collected revenue, % of net
-- revenue, a fixed monthly fee, or a TIERED plan whose royalty % varies by revenue
-- band (royalty_slab, resolved deterministically like the incentive slabs of 103).
-- An optional monthly minimum guarantee floors the payable.
--
-- This batch lays the FOUNDATION + ROYALTY. Franchise-owner login/RBAC, a partner
-- self-service portal, royalty invoicing/payment tracking and franchise-level
-- targets are DEFERRED to the next Phase-4 batch.
-- ===========================================================================

-- 1 ----------------------------------------------------------------- franchise
CREATE TABLE IF NOT EXISTS franchise (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          BIGINT NOT NULL REFERENCES organisation(id),
  name            VARCHAR(160) NOT NULL,
  code            VARCHAR(40)  NOT NULL,
  owner_name      VARCHAR(160) NULL,
  owner_email     VARCHAR(160) NULL,
  owner_phone     VARCHAR(40)  NULL,
  address         TEXT NULL,
  city            VARCHAR(120) NULL,
  gst_no          VARCHAR(20)  NULL,
  status          VARCHAR(16) NOT NULL DEFAULT 'prospect'
                  CHECK (status IN ('prospect', 'onboarding', 'active', 'suspended', 'terminated')),
  agreement_start DATE NULL,
  agreement_end   DATE NULL,
  note            TEXT NULL,
  created_by      BIGINT NULL REFERENCES "user"(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ NULL,
  deleted_by      BIGINT NULL REFERENCES "user"(id),
  CHECK (agreement_end IS NULL OR agreement_start IS NULL OR agreement_end >= agreement_start)
);
-- code is unique per org among LIVE franchises (a soft-deleted code may be reused)
CREATE UNIQUE INDEX IF NOT EXISTS uq_franchise_code
  ON franchise (org_id, lower(code)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_franchise_org ON franchise (org_id) WHERE deleted_at IS NULL;

-- 2 --------------------------------------------------- franchise -> branch (join)
-- A franchise operates specific branches. A branch belongs to AT MOST ONE
-- franchise (uq_franchise_branch_once) so franchise rollups never double-count.
CREATE TABLE IF NOT EXISTS franchise_branch (
  franchise_id BIGINT NOT NULL REFERENCES franchise(id) ON DELETE CASCADE,
  branch_id    BIGINT NOT NULL REFERENCES branch(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (franchise_id, branch_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_franchise_branch_once ON franchise_branch (branch_id);
CREATE INDEX IF NOT EXISTS idx_franchise_branch_fr ON franchise_branch (franchise_id);

-- 3 ------------------------------------------------------------- royalty_plan
-- franchise_id NULL = a reusable template a franchise can be linked to; otherwise
-- the plan is owned by that franchise. model + percent/fixed_amount + tier slabs
-- + optional monthly minimum guarantee, all within an effective date range.
CREATE TABLE IF NOT EXISTS royalty_plan (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id              BIGINT NOT NULL REFERENCES organisation(id),
  franchise_id        BIGINT NULL REFERENCES franchise(id) ON DELETE CASCADE,
  name                VARCHAR(160) NOT NULL,
  model               VARCHAR(20) NOT NULL DEFAULT 'percent_collected'
                      CHECK (model IN ('percent_collected', 'percent_net', 'fixed', 'tiered')),
  percent             NUMERIC(7, 4) NOT NULL DEFAULT 0 CHECK (percent >= 0 AND percent <= 100),
  fixed_amount_minor  BIGINT NOT NULL DEFAULT 0 CHECK (fixed_amount_minor >= 0),
  min_guarantee_minor BIGINT NOT NULL DEFAULT 0 CHECK (min_guarantee_minor >= 0),
  tier_basis          VARCHAR(10) NOT NULL DEFAULT 'collected'
                      CHECK (tier_basis IN ('collected', 'net')),
  effective_from      DATE NOT NULL,
  effective_to        DATE NULL,
  status              VARCHAR(8) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  note                TEXT NULL,
  created_by          BIGINT NULL REFERENCES "user"(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ NULL,
  deleted_by          BIGINT NULL REFERENCES "user"(id),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX IF NOT EXISTS idx_royalty_plan_org ON royalty_plan (org_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_royalty_plan_fr  ON royalty_plan (franchise_id) WHERE deleted_at IS NULL;

-- 4 ------------------------------------------------------------- royalty_slab
-- TIERED bands by revenue amount (paise). RESOLUTION (mirrored by resolveRoyaltySlab
-- in royalty.util.ts): the earned band for a revenue base is the slab with the
-- GREATEST min_amount_minor that is <= the base; max_amount_minor is a DISPLAY bound
-- only. The band's percent applies to the WHOLE base (flat within the band).
CREATE TABLE IF NOT EXISTS royalty_slab (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_id          BIGINT NOT NULL REFERENCES royalty_plan(id) ON DELETE CASCADE,
  min_amount_minor BIGINT NOT NULL DEFAULT 0 CHECK (min_amount_minor >= 0),
  max_amount_minor BIGINT NULL CHECK (max_amount_minor IS NULL OR max_amount_minor >= min_amount_minor),
  percent          NUMERIC(7, 4) NOT NULL DEFAULT 0 CHECK (percent >= 0 AND percent <= 100),
  label            VARCHAR(60) NOT NULL DEFAULT 'Band',
  sort_order       INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_royalty_slab_plan ON royalty_slab (plan_id, min_amount_minor);

-- 5 -------------------------------------------------------------- permissions
INSERT INTO permission (key, module, action) VALUES
  ('franchise.read',   'franchise', 'read'),
  ('franchise.create', 'franchise', 'create'),
  ('franchise.update', 'franchise', 'update'),
  ('franchise.delete', 'franchise', 'delete'),
  ('royalty.read',     'royalty',   'read'),
  ('royalty.manage',   'royalty',   'manage')
ON CONFLICT (key) DO NOTHING;

-- 5b ------------------------------------------------------------- role grants
-- Franchise & Royalty is a head-office / owner concern -- granted to the two admin
-- roles at 'all'. Franchise-owner (own-franchise-only) roles are a LATER batch.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('franchise.read',   'Super Admin',        'all'),
      ('franchise.create', 'Super Admin',        'all'),
      ('franchise.update', 'Super Admin',        'all'),
      ('franchise.delete', 'Super Admin',        'all'),
      ('royalty.read',     'Super Admin',        'all'),
      ('royalty.manage',   'Super Admin',        'all'),
      ('franchise.read',   'Organization Admin', 'all'),
      ('franchise.create', 'Organization Admin', 'all'),
      ('franchise.update', 'Organization Admin', 'all'),
      ('franchise.delete', 'Organization Admin', 'all'),
      ('royalty.read',     'Organization Admin', 'all'),
      ('royalty.manage',   'Organization Admin', 'all')
    ) AS v(pkey, role_name, scope)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope
      FROM role ro, permission p
     WHERE ro.name = r.role_name AND p.key = r.pkey
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;

-- No franchise rows are seeded -- the module opens empty and the operator creates a
-- real franchise mapping a real branch (foundation batch: structure only).
