-- 015 — Soft delete with impact preview (client request), every module.
--
-- SEMANTICS (deleted != inactive):
--   * deleted_at IS NOT NULL marks a row soft-deleted: hidden from ALL lists,
--     dropdowns, KPIs, summaries, dedupe checks and scoping lookups by default.
--   * Children / related records are NOT deleted ("if I press delete on branch,
--     then only branch not delete, all leads and campaign related to branch").
--     They stay fully intact and visible in their own lists; where a child
--     renders its path, a deleted ancestor shows with a "(deleted)" suffix
--     (display joins deliberately include deleted rows).
--   * By-ID GET of a deleted row -> 404. Restore = Administration > Deleted
--     Items (Super Admin / Org Admin), blocked (409) while an ancestor in the
--     row's path is itself deleted.
--   * NOT deletable: the organisation, system roles, the Super Admin user,
--     and a user's own account (all 400 at the API).

-- 1) deleted_at / deleted_by on every deletable table -------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'branch', 'vertical', 'pipeline', 'pipeline_stage', 'campaign', 'source',
    'state', 'city',
    'm_source', 'm_course', 'm_qualification', 'm_budget', 'm_status',
    'm_tag', 'm_followup_type', 'm_disposition',
    '"user"', 'team', 'role', 'lead', 'follow_up', 'custom_field_def'
  ] LOOP
    EXECUTE format('ALTER TABLE %s ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL', t);
    EXECUTE format('ALTER TABLE %s ADD COLUMN IF NOT EXISTS deleted_by BIGINT NULL', t);
  END LOOP;
END $$;

-- 2) partial indexes where the live-rows filter is hot ------------------------
CREATE INDEX IF NOT EXISTS idx_lead_alive_phone    ON lead (phone)        WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_lead_alive_campaign ON lead (campaign_id)  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_lead_alive_branch   ON lead (branch_id)    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fu_alive_lead       ON follow_up (lead_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_vertical_alive      ON vertical (branch_id)   WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pipeline_alive      ON pipeline (vertical_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_campaign_alive      ON campaign (pipeline_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_source_alive        ON source (campaign_id)   WHERE deleted_at IS NULL;

-- 3) permission-catalog sync (seed only runs once; existing DBs get the new
--    keys here — mirrors PERMISSION_CATALOG in src/rbac/permission-catalog.ts)
INSERT INTO permission (key, module, action) VALUES
  ('branch.delete',       'branch',       'delete'),
  ('vertical.delete',     'vertical',     'delete'),
  ('pipeline.delete',     'pipeline',     'delete'),
  ('campaign.delete',     'campaign',     'delete'),
  ('source.delete',       'source',       'delete'),
  ('master.delete',       'master',       'delete'),
  ('user.delete',         'user',         'delete'),
  ('custom_field.delete', 'custom_field', 'delete'),
  ('deleted.manage',      'deleted',      'manage')
ON CONFLICT (key) DO NOTHING;

-- 4) default grants: Super Admin + Org Admin -> every delete key + deleted.manage
--    (record_scope 'all'); Branch Manager -> lead/follow-up delete only (branch).
INSERT INTO role_permission (role_id, permission_id, record_scope)
SELECT r.id, p.id, 'all'
  FROM role r CROSS JOIN permission p
 WHERE r.is_system AND r.name IN ('Super Admin', 'Organization Admin')
   AND (p.action = 'delete' OR p.key = 'deleted.manage')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permission (role_id, permission_id, record_scope)
SELECT r.id, p.id, 'branch'
  FROM role r CROSS JOIN permission p
 WHERE r.is_system AND r.name = 'Branch Manager'
   AND p.key IN ('lead.delete', 'followup.delete')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- 5) audit action vocabulary: soft-delete restores are audited as 'restore'
DO $$
DECLARE c TEXT;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'audit_log'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%action%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE audit_log DROP CONSTRAINT %I', c); END IF;
  ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check
    CHECK (action IN ('create','update','delete','restore','login','export','transfer','permission_change'));
END $$;
