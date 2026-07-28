-- =============================================================================
-- 040 — DUPLICACY SCOPE NORMALISATION (client change, Jul 2026)
--
-- The campaign "Check for Duplicates" SCOPE options are now exactly:
--   this_campaign · this_vertical · this_branch · global
-- The `this_pipeline` option was REMOVED at the client's explicit request.
--
-- Any campaign whose duplicacy_config.check_scope is still 'this_pipeline' is
-- normalised to 'this_campaign' — the narrowest, safest scope (a campaign lives
-- under exactly one pipeline, so campaign scope is never wider than the old
-- pipeline scope; it can only be narrower). findDuplicate() and the config
-- validator also coerce a stray 'this_pipeline' at runtime, so this migration is
-- belt-and-braces and safe to re-run.
--
-- Idempotent: the UPDATE only touches rows that still read 'this_pipeline'; a
-- second run matches nothing.
-- =============================================================================
UPDATE campaign
   SET duplicacy_config = jsonb_set(
         COALESCE(duplicacy_config, '{}'::jsonb),
         '{check_scope}',
         '"this_campaign"'::jsonb,
         true)
 WHERE duplicacy_config ->> 'check_scope' = 'this_pipeline';
