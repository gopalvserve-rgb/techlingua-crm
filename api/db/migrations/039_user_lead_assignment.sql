-- =============================================================================
-- 039 — PER-USER LEAD-ASSIGNMENT SWITCH (Users row action #8)
--
-- A GLOBAL, per-user flag controlling whether the campaign distribution engine
-- hands NEW leads to this user. This is distinct from account status:
--
--   status = 'disabled'        -> the user CANNOT LOG IN, and is skipped everywhere
--                                 (owner/reassign guards already reject a disabled user).
--   lead_assignment_enabled=F  -> the user CAN log in and work their existing leads,
--                                 but the round-robin / conditional distribution SKIPS
--                                 them for NEW hand-outs. Re-enabling resumes instantly.
--
-- Interaction with the CAMPAIGN-level pause (campaign_agent_pause, UAT-R2 #24):
--   * campaign_agent_pause is PER CAMPAIGN — the agent is skipped in that one pool.
--   * lead_assignment_enabled is ORG-WIDE — the user is skipped in EVERY pool.
--   A user disabled globally is skipped even in campaigns where they are not paused.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, default TRUE so every existing user keeps
-- receiving leads exactly as before. No backfill needed.
-- =============================================================================
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS lead_assignment_enabled BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN "user".lead_assignment_enabled IS
  'Global per-user switch: when FALSE the lead distribution engine skips this user for NEW lead hand-out. Distinct from status=disabled (which blocks login). Campaign-level pause (campaign_agent_pause) is per-campaign; this is org-wide.';
