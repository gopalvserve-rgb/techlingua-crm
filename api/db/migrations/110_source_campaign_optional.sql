-- =============================================================================
-- 110 — SOURCE: CAMPAIGN OPTIONAL + RECONCILE THE TWO SOURCE MASTERS (27aug Batch C, item 1)
--
-- Two "source" concepts existed and confused the client:
--   * the campaign-scoped `source` table  — the "Lead Source" a lead is captured through
--     (lead.source_id -> source.id). Surfaced as the Marketing "Lead Source Master" screen.
--   * the generic master `m_source`        — the reusable catalogue of source NAMES,
--     surfaced as Administration > Masters > "Sources" and as the walk-in
--     "How did you hear about us?" list.
--
-- RECONCILIATION (item 1b): `m_source` is now the ONE canonical catalogue of source names.
-- Every campaign-scoped `source` row is GUARANTEED to be backed by a canonical `m_source`
-- (source.master_source_id). The API find-or-creates the m_source by name on source
-- create/update, so the two screens can never diverge — the Lead Source Master picks a
-- canonical source name (optionally scoped to a campaign) and the Masters "Sources" list
-- is that same canonical catalogue. This migration BACKFILLS the link for existing rows.
--
-- ITEM 1a — a Lead Source no longer REQUIRES a campaign: a source can exist org-wide with
-- no campaign. The denormalised path columns are made NULLABLE so an org-level source has
-- no Branch/Vertical/Pipeline/Campaign. Existing rows (all campaign-scoped) are untouched;
-- lead.source_id references never break.
-- Idempotent throughout.
-- =============================================================================

-- 1 ---- path columns become NULLABLE (org-level sources have no campaign path)
ALTER TABLE source ALTER COLUMN campaign_id DROP NOT NULL;
ALTER TABLE source ALTER COLUMN pipeline_id DROP NOT NULL;
ALTER TABLE source ALTER COLUMN vertical_id DROP NOT NULL;
ALTER TABLE source ALTER COLUMN branch_id   DROP NOT NULL;

-- 2 ---- BACKFILL the canonical link: every source name must exist in m_source, and the
--        source must point at it. Case-insensitive match; create the missing catalogue rows.
DO $$
DECLARE r RECORD; oid BIGINT; mid BIGINT;
BEGIN
  SELECT id INTO oid FROM organisation ORDER BY id LIMIT 1;
  IF oid IS NULL THEN RETURN; END IF;
  FOR r IN SELECT DISTINCT btrim(name) AS nm FROM source
            WHERE master_source_id IS NULL AND btrim(COALESCE(name,'')) <> '' LOOP
    SELECT id INTO mid FROM m_source
      WHERE org_id = oid AND lower(name) = lower(r.nm) AND deleted_at IS NULL
      ORDER BY id LIMIT 1;
    IF mid IS NULL THEN
      INSERT INTO m_source (org_id, name, is_active, meta)
      VALUES (oid, r.nm, TRUE, '{}'::jsonb) RETURNING id INTO mid;
    END IF;
    UPDATE source SET master_source_id = mid, updated_at = now()
      WHERE master_source_id IS NULL AND lower(btrim(name)) = lower(r.nm);
  END LOOP;
END $$;
