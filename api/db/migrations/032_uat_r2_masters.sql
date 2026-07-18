-- ============================================================================
-- 032 — UAT ROUND 2, BATCH A: masters restructure
--   #5  Training        — was a hard-coded Online/Offline/Hybrid/Bootcamp select
--   #18 Purpose of Visit — was a hard-coded walk-in select
--   #19 Walk-in Status   — was a hard-coded list (+ CHECK constraint on walk_in.status)
--
-- Each becomes a first-class generic master (m_<name>), so the client manages the
-- values himself in Administration › Masters, exactly like Course / Status / Source.
--
-- Idempotent: IF NOT EXISTS on every DDL; seeds guarded by NOT EXISTS-per-row so a
-- re-run (or a value the client has since renamed/removed) is never re-inserted.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Generic master tables — the m_source shape (001) + soft-delete columns (015).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS m_training (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id BIGINT NOT NULL REFERENCES organisation(id),
  name VARCHAR(120) NOT NULL, code VARCHAR(40),
  sort_order INT NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT TRUE,
  meta JSONB NOT NULL DEFAULT '{}', parent_id BIGINT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT, deleted_at TIMESTAMPTZ NULL, deleted_by BIGINT NULL
);

CREATE TABLE IF NOT EXISTS m_visit_purpose (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id BIGINT NOT NULL REFERENCES organisation(id),
  name VARCHAR(120) NOT NULL, code VARCHAR(40),
  sort_order INT NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT TRUE,
  meta JSONB NOT NULL DEFAULT '{}', parent_id BIGINT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT, deleted_at TIMESTAMPTZ NULL, deleted_by BIGINT NULL
);

CREATE TABLE IF NOT EXISTS m_walkin_status (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id BIGINT NOT NULL REFERENCES organisation(id),
  name VARCHAR(120) NOT NULL, code VARCHAR(40),
  sort_order INT NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT TRUE,
  meta JSONB NOT NULL DEFAULT '{}', parent_id BIGINT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT, deleted_at TIMESTAMPTZ NULL, deleted_by BIGINT NULL
);

-- de-dup indexes (008 pattern): per org, active rows, case-insensitive on name & code.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['m_training','m_visit_purpose','m_walkin_status'] LOOP
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS uq_%s_active_name ON %I (org_id, lower(name)) WHERE is_active', t, t);
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS uq_%s_active_code ON %I (org_id, lower(code)) WHERE is_active AND code IS NOT NULL', t, t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Seeds — the values that were hard-coded, so NOTHING regresses. One org (single
-- tenant); each row guarded so a re-run or a client edit is never clobbered.
-- ---------------------------------------------------------------------------
DO $$
DECLARE org_id BIGINT;
BEGIN
  SELECT id INTO org_id FROM organisation ORDER BY id LIMIT 1;
  IF org_id IS NULL THEN RETURN; END IF;   -- fresh DB: seed.ts seeds these instead

  -- #5 Training (was: Online / Offline / Hybrid / Bootcamp)
  INSERT INTO m_training (org_id, name, code, sort_order)
  SELECT org_id, v.name, v.code, v.ord
    FROM (VALUES ('Online','ONLINE',0),('Offline','OFFLINE',1),('Hybrid','HYBRID',2),('Bootcamp','BOOTCAMP',3)) AS v(name,code,ord)
   WHERE NOT EXISTS (SELECT 1 FROM m_training m WHERE m.org_id = org_id AND lower(m.name) = lower(v.name));

  -- #18 Purpose of Visit (was: Admission enquiry / Fee query / Document submission / Other)
  INSERT INTO m_visit_purpose (org_id, name, code, sort_order)
  SELECT org_id, v.name, v.code, v.ord
    FROM (VALUES ('Admission enquiry','ADM_ENQ',0),('Fee query','FEE_QUERY',1),('Document submission','DOC_SUB',2),('Other','OTHER',3)) AS v(name,code,ord)
   WHERE NOT EXISTS (SELECT 1 FROM m_visit_purpose m WHERE m.org_id = org_id AND lower(m.name) = lower(v.name));

  -- #19 Walk-in Status. Codes MATCH the existing walk_in.status values so every stored
  -- row keeps rendering; the client can now add his own (e.g. No-show) from Masters.
  INSERT INTO m_walkin_status (org_id, name, code, sort_order)
  SELECT org_id, v.name, v.code, v.ord
    FROM (VALUES ('Waiting','waiting',0),('In progress','in_progress',1),('Converted','converted',2),('Closed','closed',3)) AS v(name,code,ord)
   WHERE NOT EXISTS (SELECT 1 FROM m_walkin_status m WHERE m.org_id = org_id AND lower(m.code) = lower(v.code));
END $$;

-- ---------------------------------------------------------------------------
-- #19 — the walk-in status is now MASTER-DRIVEN, so drop the hard-coded CHECK that
-- would reject any client-added value. Backend validation (capture.service) now
-- validates against the master's active codes instead (base codes kept as a fallback).
-- ---------------------------------------------------------------------------
ALTER TABLE walk_in DROP CONSTRAINT IF EXISTS walk_in_status_check;
