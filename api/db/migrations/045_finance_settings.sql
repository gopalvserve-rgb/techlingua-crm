-- =============================================================================
-- 045 — FINANCE SETTINGS: DISCOUNT / SCHOLARSHIP / CAPPING LIMIT (% AND ₹)
--
-- The client asked for a Finance Settings area (Settings › Administration) where a
-- PERMITTED user configures — BOTH by percentage AND by absolute amount —
--   1) the allowed DISCOUNT       {percent, amount}
--   2) the allowed SCHOLARSHIP    {percent, amount}
--   3) the hard CAPPING LIMIT     {percent, amount}  — the ceiling nobody may cross
--      unless they hold the override permission.
--
-- MODEL
--   `finance_setting` — ONE row per scope. Scope is org-wide (vertical_id IS NULL) or
--   PER-VERTICAL, resolved "most specific wins" exactly like number_series (029) and
--   channel_config: (vertical) -> (org-wide). Per-vertical is consistent with the
--   product's per-vertical SMTP / per-vertical Razorpay gateway.
--
-- MONEY RULE (029, non-negotiable): every money value is BIGINT MINOR UNITS (paise);
--   percentages are NUMERIC(6,3). NULL on any field = "not enforced" (blank = off).
--
-- CAP SEMANTICS (documented in docs/dev/35 and enforced in finance-settings.service.ts):
--   A discount D on base B is allowed for a NORMAL user iff, for the applicable kind,
--     · D <= (effective percent cap)% of B   (when a percent cap is set), AND
--     · D <= (effective amount cap)          (when an amount cap is set).
--   BOTH must hold — the STRICTER binds. Either side blank = that side not enforced.
--   The effective cap is the STRICTER of the kind's own cap and the hard capping limit.
--   A user holding `finance.override` may exceed it; everyone else is rejected with a
--   clear message. Only `finance.manage` may CHANGE these values.
--
-- Idempotent throughout (IF NOT EXISTS / ON CONFLICT DO NOTHING).
-- =============================================================================

CREATE TABLE IF NOT EXISTS finance_setting (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id                BIGINT NOT NULL REFERENCES organisation(id),
  vertical_id           BIGINT NULL REFERENCES vertical(id),   -- NULL = org-wide default
  discount_max_pct      NUMERIC(6,3) NULL CHECK (discount_max_pct   IS NULL OR (discount_max_pct   >= 0 AND discount_max_pct   <= 100)),
  discount_max_minor    BIGINT       NULL CHECK (discount_max_minor IS NULL OR  discount_max_minor >= 0),
  scholarship_max_pct   NUMERIC(6,3) NULL CHECK (scholarship_max_pct   IS NULL OR (scholarship_max_pct   >= 0 AND scholarship_max_pct   <= 100)),
  scholarship_max_minor BIGINT       NULL CHECK (scholarship_max_minor IS NULL OR  scholarship_max_minor >= 0),
  cap_max_pct           NUMERIC(6,3) NULL CHECK (cap_max_pct   IS NULL OR (cap_max_pct   >= 0 AND cap_max_pct   <= 100)),
  cap_max_minor         BIGINT       NULL CHECK (cap_max_minor IS NULL OR  cap_max_minor >= 0),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by            BIGINT NULL REFERENCES "user"(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_finance_setting
  ON finance_setting (org_id, COALESCE(vertical_id, 0));

-- Seed ONE org-wide default row with every cap NULL (nothing enforced). This changes NO
-- existing behaviour until the client sets a cap.
INSERT INTO finance_setting (org_id, vertical_id)
SELECT o.id, NULL FROM organisation o
ON CONFLICT (org_id, COALESCE(vertical_id, 0)) DO NOTHING;

INSERT INTO permission (key, module, action) VALUES
  ('finance.read',     'finance', 'read'),
  ('finance.manage',   'finance', 'manage'),
  ('finance.override', 'finance', 'override')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('finance.read',     'Super Admin',        'all'),
      ('finance.read',     'Organization Admin', 'all'),
      ('finance.read',     'Marketing Manager',  'all'),
      ('finance.read',     'Branch Manager',     'branch'),
      ('finance.read',     'Vertical Manager',   'vertical'),
      ('finance.read',     'Team Leader',        'team'),
      ('finance.read',     'Counsellor',         'own'),
      ('finance.manage',   'Super Admin',        'all'),
      ('finance.manage',   'Organization Admin', 'all'),
      ('finance.override', 'Super Admin',        'all'),
      ('finance.override', 'Organization Admin', 'all'),
      ('finance.override', 'Branch Manager',     'branch'),
      ('finance.override', 'Vertical Manager',   'vertical')
    ) AS v(pkey, role_name, scope)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope
      FROM role ro, permission p
     WHERE ro.name = r.role_name AND p.key = r.pkey
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;
