-- 022 — audit_log.action must accept 'handout' (Sprint 2 / WS4)
--
-- The on-demand hand-out writes ONE audit row per claim, inside the claim
-- transaction, with action = 'handout' (leads/handout.service.ts). audit_log.action
-- is an enumerated CHECK (006, widened by 015 for 'restore' and 019 for 'merge') and
-- did not list it — so EVERY hand-out rolled back on that insert and the agent got
-- zero leads. Found by the live smoke; the in-memory test double enforced no
-- constraints, so the unit suite could not see it (it does now: handout.testkit.ts
-- validates the action against this same list).
--
-- Its own file, not a patch to 021: the runner is filename-keyed and 021 was already
-- recorded as applied on the live DB.
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE audit_log ADD  CONSTRAINT audit_log_action_check
  CHECK (action IN ('create','update','delete','login','export','transfer',
                    'permission_change','merge','restore','handout'));
