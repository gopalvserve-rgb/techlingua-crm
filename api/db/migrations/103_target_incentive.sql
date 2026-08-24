-- ===========================================================================
-- 103 — TARGET & INCENTIVE (dev/134)
--
-- The Sprint-5 "Monthly Target" (monthly_target) was a single-metric target
-- (admissions + revenue) for a counsellor / branch / vertical. The client's
-- "Target & Incentive" spec asks for a RICHER target — a named target with a
-- Target-For of Individual / Team / Branch / Vertical / Course, a Period of
-- Monthly / Quarterly / Half-Yearly / Yearly / Custom, SIX metrics (Leads,
-- Walk-ins, Admissions, Revenue, Collection, Meetings) and a linked Incentive
-- Plan whose achievement SLABS compute an earned incentive.
--
-- WHY NEW TABLES, NOT AN ALTER OF monthly_target:
--   monthly_target is still read by the Sprint-3 dashboard's "This month vs
--   target" bar (/performance/targets/dashboard) and by the Sprint-6 reports.
--   The new target_definition sits ALONGSIDE it, the old table is left intact,
--   and every ACTIVE monthly_target row is BACKFILLED into target_definition.
--
-- The Incentive Plan is a DEDICATED TABLE (incentive_plan + incentive_slab),
-- NOT a generic m_* master: a plan is an ordered set of achievement slabs with
-- money on each — structure a generic (name, code, meta) master cannot hold.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS incentive_plan (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES organisation(id),
  name          VARCHAR(160) NOT NULL,
  applicable_to VARCHAR(10) NOT NULL DEFAULT 'user'
                CHECK (applicable_to IN ('branch', 'vertical', 'user')),
  metric        VARCHAR(16) NOT NULL DEFAULT 'admissions'
                CHECK (metric IN ('admissions', 'revenue', 'collection', 'leads', 'walkin', 'meeting')),
  status        VARCHAR(8) NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'inactive')),
  note          TEXT NULL,
  created_by    BIGINT NULL REFERENCES "user"(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ NULL,
  deleted_by    BIGINT NULL REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS idx_incentive_plan_org ON incentive_plan (org_id) WHERE deleted_at IS NULL;

-- RESOLUTION RULE (mirrored EXACTLY by resolveIncentive() in incentive.service.ts):
-- the earned slab for an achievement % is the slab with the GREATEST min_pct
-- that is <= the achievement %. max_pct is a DISPLAY bound only, so a decimal
-- achievement (69.5%) and an exact boundary (100%) both resolve deterministically.
CREATE TABLE IF NOT EXISTS incentive_slab (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_id      BIGINT NOT NULL REFERENCES incentive_plan(id) ON DELETE CASCADE,
  min_pct      NUMERIC(6, 2) NOT NULL CHECK (min_pct >= 0),
  max_pct      NUMERIC(6, 2) NULL CHECK (max_pct IS NULL OR max_pct >= min_pct),
  tier         VARCHAR(20) NOT NULL DEFAULT 'good',
  emoji        VARCHAR(8) NULL,
  label        VARCHAR(60) NOT NULL,
  amount_minor BIGINT NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
  sort_order   INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_incentive_slab_plan ON incentive_slab (plan_id, min_pct);

CREATE TABLE IF NOT EXISTS target_definition (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         BIGINT NOT NULL REFERENCES organisation(id),
  name           VARCHAR(160) NOT NULL,
  target_for     VARCHAR(10) NOT NULL
                 CHECK (target_for IN ('user', 'team', 'branch', 'vertical', 'course')),
  user_id        BIGINT NULL REFERENCES "user"(id),
  team_id        BIGINT NULL REFERENCES team(id),
  branch_id      BIGINT NULL REFERENCES branch(id),
  vertical_id    BIGINT NULL REFERENCES vertical(id),
  course_id      BIGINT NULL REFERENCES m_course(id),
  period_type    VARCHAR(12) NOT NULL DEFAULT 'monthly'
                 CHECK (period_type IN ('monthly', 'quarterly', 'half_yearly', 'yearly', 'custom')),
  period_start   DATE NOT NULL,
  period_end     DATE NOT NULL,
  CHECK (period_end > period_start),
  leads_target        INT    NOT NULL DEFAULT 0 CHECK (leads_target >= 0),
  walkins_target      INT    NOT NULL DEFAULT 0 CHECK (walkins_target >= 0),
  admissions_target   INT    NOT NULL DEFAULT 0 CHECK (admissions_target >= 0),
  revenue_target_minor    BIGINT NOT NULL DEFAULT 0 CHECK (revenue_target_minor >= 0),
  collection_target_minor BIGINT NOT NULL DEFAULT 0 CHECK (collection_target_minor >= 0),
  meetings_target     INT    NOT NULL DEFAULT 0 CHECK (meetings_target >= 0),
  incentive_plan_id   BIGINT NULL REFERENCES incentive_plan(id),
  note           TEXT NULL,
  created_by     BIGINT NULL REFERENCES "user"(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ NULL,
  deleted_by     BIGINT NULL REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS idx_target_def_scope
  ON target_definition (target_for, branch_id, vertical_id, user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_target_def_period
  ON target_definition (period_start, period_end) WHERE deleted_at IS NULL;

-- BACKFILL every ACTIVE monthly_target into target_definition (idempotent).
INSERT INTO target_definition
  (org_id, name, target_for, user_id, branch_id, vertical_id,
   period_type, period_start, period_end,
   admissions_target, revenue_target_minor, note, created_by, created_at)
SELECT
  mt.org_id,
  'Monthly target — ' || to_char(mt.period, 'Mon YYYY'),
  mt.scope_type,
  mt.user_id, mt.branch_id, mt.vertical_id,
  'monthly', mt.period, (mt.period + INTERVAL '1 month')::date,
  mt.enrolment_target, mt.revenue_target_minor, mt.note, mt.created_by, mt.created_at
FROM monthly_target mt
WHERE mt.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM target_definition td
     WHERE td.org_id = mt.org_id AND td.target_for = mt.scope_type
       AND td.period_start = mt.period AND td.period_type = 'monthly'
       AND COALESCE(td.user_id, 0) = COALESCE(mt.user_id, 0)
       AND COALESCE(td.branch_id, 0) = COALESCE(mt.branch_id, 0)
       AND COALESCE(td.vertical_id, 0) = COALESCE(mt.vertical_id, 0)
  );

-- SEED an EXAMPLE incentive plan with the client's 8 tiers (all editable).
DO $$
DECLARE
  v_org  BIGINT;
  v_plan BIGINT;
BEGIN
  SELECT id INTO v_org FROM organisation ORDER BY id LIMIT 1;
  IF v_org IS NULL THEN RETURN; END IF;

  IF NOT EXISTS (SELECT 1 FROM incentive_plan WHERE org_id = v_org AND name = 'Admissions Incentive (example)') THEN
    INSERT INTO incentive_plan (org_id, name, applicable_to, metric, status, note)
    VALUES (v_org, 'Admissions Incentive (example)', 'user', 'admissions', 'active',
            'Seeded example — every threshold and amount is editable.')
    RETURNING id INTO v_plan;

    INSERT INTO incentive_slab (plan_id, min_pct, max_pct, tier, emoji, label, amount_minor, sort_order) VALUES
      (v_plan,   0,  49.99, 'critical',    '🔴', 'Critical',         0,        1),
      (v_plan,  50,  69.99, 'below',       '🟠', 'Below Target',     0,        2),
      (v_plan,  70,  79.99, 'near',        '🟡', 'Near Target',      0,        3),
      (v_plan,  80,  89.99, 'good',        '🟢', 'Good',             200000,   4),
      (v_plan,  90,  99.99, 'strong',      '🟢', 'Strong',           400000,   5),
      (v_plan, 100, 109.99, 'achieved',    '🔵', 'Target Achieved',  700000,   6),
      (v_plan, 110, 124.99, 'excellent',   '🟣', 'Excellent',        1000000,  7),
      (v_plan, 125,   NULL, 'exceptional', '🏆', 'Exceptional',      1500000,  8);
  END IF;
END $$;
