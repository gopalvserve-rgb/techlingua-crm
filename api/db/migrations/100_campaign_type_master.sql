-- ============================================================================
-- 100 — CAMPAIGN TYPE MASTER (dev/131, task #213 item 4 — client:
--   "make the campaign form's Campaign Type a self-manageable master")
--
-- Campaign Type used to be a HARD-CODED inline <select> in the Create/Edit Campaign form
-- (Digital / Print / Event / Referral Drive / Tele-calling). This makes it a real generic
-- master (m_campaign_type) exactly like Course Type (095) / Level (097): CRUD via
-- /api/masters/campaign_type, add/edit/delete in Administration > Masters, and the campaign
-- form's Campaign Type dropdown reads it with the inline + Master quick-add.
--
-- Back-compat: a campaign stores the picked type as the LABEL text in campaign.campaign_type
-- (e.g. 'Digital'). The master's NAME is kept == that label, so every existing campaign keeps
-- rendering/filtering. The 5 original hard-coded values are seeded, plus any DISTINCT
-- campaign_type already stored on a campaign (so nothing a client set is ever orphaned).
--
-- Idempotent: IF NOT EXISTS on DDL; every seed guarded by NOT EXISTS-per-row.
-- ============================================================================

CREATE TABLE IF NOT EXISTS m_campaign_type (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id BIGINT NOT NULL REFERENCES organisation(id),
  name VARCHAR(120) NOT NULL, code VARCHAR(40),
  sort_order INT NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT TRUE,
  meta JSONB NOT NULL DEFAULT '{}', parent_id BIGINT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT, deleted_at TIMESTAMPTZ NULL, deleted_by BIGINT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_m_campaign_type_active_name ON m_campaign_type (org_id, lower(name)) WHERE is_active;
CREATE UNIQUE INDEX IF NOT EXISTS uq_m_campaign_type_active_code ON m_campaign_type (org_id, lower(code)) WHERE is_active AND code IS NOT NULL;

DO $$
DECLARE v_org BIGINT;
BEGIN
  SELECT id INTO v_org FROM organisation ORDER BY id LIMIT 1;
  IF v_org IS NULL THEN RETURN; END IF;   -- fresh DB: seed.ts seeds this instead

  -- (a) the original 5 hard-coded values so NOTHING regresses
  INSERT INTO m_campaign_type (org_id, name, code, sort_order)
  SELECT v_org, v.name, v.code, v.ord
    FROM (VALUES
            ('Digital',        'DIGITAL',     10),
            ('Print',          'PRINT',       20),
            ('Event',          'EVENT',       30),
            ('Referral Drive', 'REFERRAL',    40),
            ('Tele-calling',   'TELECALLING', 50)
         ) AS v(name, code, ord)
   WHERE NOT EXISTS (SELECT 1 FROM m_campaign_type m WHERE m.org_id = v_org AND lower(m.name) = lower(v.name));

  -- (b) any campaign_type already stored on a campaign but not yet a master row (no data loss)
  INSERT INTO m_campaign_type (org_id, name, sort_order)
  SELECT v_org, t.ct, 100 + (row_number() OVER (ORDER BY t.ct))::int
    FROM (SELECT DISTINCT trim(campaign_type) AS ct
            FROM campaign
           WHERE deleted_at IS NULL AND COALESCE(trim(campaign_type), '') <> '') t
   WHERE NOT EXISTS (SELECT 1 FROM m_campaign_type m WHERE m.org_id = v_org AND lower(m.name) = lower(t.ct));
END $$;
