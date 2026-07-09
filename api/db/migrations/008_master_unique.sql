-- 008: masters de-duplication — the inline "＋ Master" modal (and the masters admin)
-- must get a clean 409 instead of silently inserting duplicates.
-- Rules: per org, ACTIVE rows only (deactivate + re-add stays possible), case-insensitive.
-- City names are unique per parent state (two states may share a city name).

-- Safety: deactivate pre-existing active duplicates (keep the oldest row) so the
-- unique indexes can always be created on a live database.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['state','m_source','m_course','m_qualification','m_budget','m_status','m_tag','m_followup_type','m_disposition'] LOOP
    EXECUTE format(
      'UPDATE %I x SET is_active = FALSE, updated_at = now()
        WHERE x.is_active AND x.id <> (SELECT MIN(y.id) FROM %I y WHERE y.is_active AND y.org_id = x.org_id AND lower(y.name) = lower(x.name))
          AND EXISTS (SELECT 1 FROM %I y WHERE y.is_active AND y.org_id = x.org_id AND lower(y.name) = lower(x.name) AND y.id < x.id)', t, t, t);
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS uq_%s_active_name ON %I (org_id, lower(name)) WHERE is_active', t, t);
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS uq_%s_active_code ON %I (org_id, lower(code)) WHERE is_active AND code IS NOT NULL', t, t);
  END LOOP;
END $$;

UPDATE city x SET is_active = FALSE, updated_at = now()
 WHERE x.is_active AND EXISTS (
   SELECT 1 FROM city y
    WHERE y.is_active AND y.org_id = x.org_id AND y.parent_id IS NOT DISTINCT FROM x.parent_id
      AND lower(y.name) = lower(x.name) AND y.id < x.id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_city_active_name ON city (org_id, COALESCE(parent_id, 0), lower(name)) WHERE is_active;
CREATE UNIQUE INDEX IF NOT EXISTS uq_city_active_code ON city (org_id, lower(code)) WHERE is_active AND code IS NOT NULL;
