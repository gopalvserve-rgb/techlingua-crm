-- ============================================================================
-- 123 — STAGE TYPE MASTER (client, Oct 2026)
--
-- "In pipeline creation there should be a Stage Type master to create more, and the stage
--  type should appear after every stage (Won, Lost, …)."
--
-- A pipeline stage's stage_type (open | won | lost, migration 002) is the BEHAVIOUR the whole
-- app relies on — conversion counts, won/lost filters, closed-lead re-open, hand-outs. That
-- stays. This adds a self-manageable master of NAMED stage types (e.g. "Enrolled", "Not
-- Interested", "Demo Done"), each of which BEHAVES AS open / won / lost (meta.behaviour), and
-- stores the chosen name on the stage so every stage can show its type.
--
-- Additive and idempotent. Existing stages get the name of their behaviour (Open / Won / Lost).
-- ============================================================================
CREATE TABLE IF NOT EXISTS m_stage_type (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id BIGINT NOT NULL REFERENCES organisation(id),
  name VARCHAR(120) NOT NULL, code VARCHAR(40),
  sort_order INT NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT TRUE,
  meta JSONB NOT NULL DEFAULT '{}', parent_id BIGINT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT, deleted_at TIMESTAMPTZ NULL, deleted_by BIGINT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_m_stage_type_active_name ON m_stage_type (org_id, lower(name)) WHERE is_active;
CREATE UNIQUE INDEX IF NOT EXISTS uq_m_stage_type_active_code ON m_stage_type (org_id, lower(code)) WHERE is_active AND code IS NOT NULL;

-- seed the three built-in behaviours (name == behaviour label)
INSERT INTO m_stage_type (org_id, name, code, sort_order, meta)
SELECT o.id, v.name, v.code, v.ord, jsonb_build_object('behaviour', v.beh)
  FROM (SELECT id FROM organisation ORDER BY id LIMIT 1) o
 CROSS JOIN (VALUES ('Open', 'OPEN', 1, 'open'), ('Won', 'WON', 2, 'won'), ('Lost', 'LOST', 3, 'lost')) AS v(name, code, ord, beh)
 WHERE NOT EXISTS (SELECT 1 FROM m_stage_type m WHERE m.org_id = o.id AND lower(m.name) = lower(v.name));

-- the named type shown on each stage (its behaviour stays in stage_type)
ALTER TABLE pipeline_stage ADD COLUMN IF NOT EXISTS stage_type_name VARCHAR(120) NULL;
UPDATE pipeline_stage SET stage_type_name = initcap(stage_type) WHERE stage_type_name IS NULL;
