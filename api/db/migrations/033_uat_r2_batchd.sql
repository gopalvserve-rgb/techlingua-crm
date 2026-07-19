-- ============================================================================
-- 033 — UAT ROUND 2, BATCH D: Quick Contact / Walk-in / Referral / Campaign
--   #20  Referral — an Assigned Counsellor, stored on the referral row so the
--        Edit form prefills it and it owns the created lead (like Walk-in does).
--   #23  Campaign — "Who will be managing this campaign?" — a MULTI-USER field,
--        a management/visibility role kept SEPARATE from the distribution agent
--        pool (managers are NEVER auto-assigned leads).
--   #24  Campaign Settings — per-campaign, per-agent PAUSE flag so a paused agent
--        is skipped by round-robin / conditional distribution and resumes when
--        re-activated.
--
-- Idempotent: IF NOT EXISTS on every DDL; safe to re-run.
-- ============================================================================

-- #20 — Referral assigned counsellor (nullable: an unset referral still falls
-- back to campaign distribution, exactly as before).
ALTER TABLE referral ADD COLUMN IF NOT EXISTS assigned_counsellor_id BIGINT REFERENCES "user"(id);

-- #23 — Campaign managers. A join row per (campaign, user). This is NOT the
-- distribution agent pool (campaign.distribution_config.agent_user_ids); a
-- manager here receives NO auto-assigned leads. The set is replaced wholesale
-- on each campaign save.
CREATE TABLE IF NOT EXISTS campaign_manager (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campaign_id BIGINT NOT NULL REFERENCES campaign(id) ON DELETE CASCADE,
  user_id     BIGINT NOT NULL REFERENCES "user"(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_manager ON campaign_manager(campaign_id, user_id);
CREATE INDEX IF NOT EXISTS idx_campaign_manager_user ON campaign_manager(user_id);

-- #24 — Per-campaign, per-agent pause. A row exists only when the agent has
-- been touched; paused = TRUE means "skip this agent in distribution". The
-- distribution engine (LeadIngestionService.resolvePool) filters the pool by
-- this flag, so a paused agent is skipped by round-robin / conditional and
-- resumes the instant it is set back to FALSE.
CREATE TABLE IF NOT EXISTS campaign_agent_pause (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campaign_id BIGINT NOT NULL REFERENCES campaign(id) ON DELETE CASCADE,
  user_id     BIGINT NOT NULL REFERENCES "user"(id),
  paused      BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_agent_pause ON campaign_agent_pause(campaign_id, user_id);
CREATE INDEX IF NOT EXISTS idx_campaign_agent_pause_active
  ON campaign_agent_pause(campaign_id) WHERE paused;
