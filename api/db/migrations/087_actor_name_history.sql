-- =============================================================================
-- 087 — USER-RENAME HISTORY PRESERVATION (client feedback)
--
-- "If a user name is changed, all past CRM activity remains recorded under the OLD
--  name, and all future activity is recorded under the NEW name."
--
-- Problem: audit_log and lead_activity store only actor_id and the READ path joins
-- live to "user".name — so renaming a user retroactively rewrites the actor label on
-- every historical row. Fix: snapshot the actor's display name at write time into an
-- actor_name column, and render history from that snapshot (not a live join).
--
-- Strategy (smallest correct change):
--   1. Add actor_name TEXT to audit_log and lead_activity.
--   2. A BEFORE INSERT trigger stamps actor_name := "user".name when the row is written
--      (only if not already supplied and actor_id is set). This centralises the snapshot
--      across ALL 40+ insert sites (services, interceptor, background workers) — no per-
--      call code change, and it can never be forgotten.
--   3. Backfill existing rows from the CURRENT user name (best-effort baseline — past
--      names are unrecoverable; NEW renames from here on preserve correctly).
--   4. The READ path (audit.controller, leads.activities) switches to the stored snapshot.
--
-- A later rename only changes "user".name, which affects FUTURE inserts (new snapshot);
-- historical rows keep their stamped actor_name. Idempotent / guarded throughout.
-- =============================================================================

-- 1. Snapshot columns -------------------------------------------------------
ALTER TABLE audit_log     ADD COLUMN IF NOT EXISTS actor_name TEXT;
ALTER TABLE lead_activity ADD COLUMN IF NOT EXISTS actor_name TEXT;

-- 2. Trigger function: stamp the acting user's current name at insert time ---
CREATE OR REPLACE FUNCTION snapshot_actor_name() RETURNS trigger AS $$
BEGIN
  IF NEW.actor_name IS NULL AND NEW.actor_id IS NOT NULL THEN
    SELECT name INTO NEW.actor_name FROM "user" WHERE id = NEW.actor_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_snapshot_actor_name ON audit_log;
CREATE TRIGGER trg_snapshot_actor_name
  BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION snapshot_actor_name();

DROP TRIGGER IF EXISTS trg_snapshot_actor_name ON lead_activity;
CREATE TRIGGER trg_snapshot_actor_name
  BEFORE INSERT ON lead_activity
  FOR EACH ROW EXECUTE FUNCTION snapshot_actor_name();

-- 3. Backfill existing rows from the current user name (baseline snapshot) ---
UPDATE audit_log a
   SET actor_name = u.name
  FROM "user" u
 WHERE u.id = a.actor_id
   AND a.actor_name IS NULL;

UPDATE lead_activity a
   SET actor_name = u.name
  FROM "user" u
 WHERE u.id = a.actor_id
   AND a.actor_name IS NULL;
