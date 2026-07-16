-- ===========================================================================
-- 030 — Sprint-5 defect fixes (QA-14)
--
-- DEF-S5-04 — DeepSeek and Gemini must be INDEPENDENT credentials.
--
-- `channel_config` has carried exactly one row per (org, channel, vertical) since
-- migration 026:
--
--   CREATE UNIQUE INDEX uq_channel_config ON channel_config
--     (org_id, channel, COALESCE(vertical_id, -1)) WHERE deleted_at IS NULL;
--
-- That is RIGHT for every channel where the providers are ALTERNATIVES — switching SMS
-- from MSG91 to Twilio must replace the gateway, because two live SMS gateways on one
-- vertical is an ambiguity that `resolve()` would eventually resolve wrongly.
--
-- It is WRONG for `ai`. DeepSeek and Gemini share `channel = 'ai'` but are not
-- alternatives: PROJECT_STATUS §4.8 offers "DeepSeek AND/OR Gemini", and the Phase-2
-- features will pick per task. Sharing a row meant saving one SILENTLY OVERWROTE the
-- other in place, with no warning (live: both returned id 17). Today it is strictly OR.
--
-- So: `ai` is keyed on the provider as well; every other channel is untouched.
--
-- IDEMPOTENT, and safe to run against a live database with rows in it.
-- ===========================================================================

-- 1) The general rule, minus `ai`. Recreated rather than altered — a partial unique
--    index's predicate cannot be changed in place.
DROP INDEX IF EXISTS uq_channel_config;

CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_config ON channel_config
  (org_id, channel, COALESCE(vertical_id, -1))
  WHERE deleted_at IS NULL AND channel <> 'ai';

-- 2) `ai` — one row per PROVIDER per vertical, so the two keys coexist.
CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_config_ai ON channel_config
  (org_id, channel, provider, COALESCE(vertical_id, -1))
  WHERE deleted_at IS NULL AND channel = 'ai';

-- ---------------------------------------------------------------------------
-- NOTE ON EXISTING DATA: nothing to migrate. Any `ai` row already stored is a single
-- (channel, vertical) row that trivially satisfies the new, STRICTLY WEAKER index — the
-- client can now simply add the second provider. No row is rewritten, no key is dropped,
-- and re-running this migration is a no-op. (On the live DB `channel_config` is empty
-- anyway: QA-14 hard-deleted its 7 test rows and Gopal has supplied nothing yet.)
-- ---------------------------------------------------------------------------
