-- ============================================================================
-- 127 — CALENDAR EVENT REMINDERS (client call, Oct 2026)
--
-- Follow-ups already remind their owner; calendar events did not. `reminded_at` is the
-- same exactly-once claim follow_up uses. Events already in the past are stamped so the
-- first sweep does not announce them. Editing an event's start time clears the claim.
-- ============================================================================

ALTER TABLE calendar_event ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMPTZ;
UPDATE calendar_event SET reminded_at = now() WHERE starts_at <= now() AND reminded_at IS NULL;
