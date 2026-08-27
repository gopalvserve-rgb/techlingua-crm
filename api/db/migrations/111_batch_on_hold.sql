-- =============================================================================
-- 111 — BATCH STATUS: add "On Hold" (27aug Batch C, item 2)
--
-- Adds an 8th lifecycle code `on_hold` alongside the 7 from migration 080. It is a MANUAL
-- status (like suspended): set explicitly by a user and it STICKS (the date logic never
-- overrides it); resuming clears the pin and re-derives from dates. Widens the CHECK and
-- the batch_status_def catalogue. Idempotent.
-- =============================================================================

INSERT INTO batch_status_def (code, label, meaning, is_manual, is_terminal, ordering) VALUES
  ('on_hold', 'On Hold', 'Batch put on hold (e.g. awaiting minimum enrolment or a decision)', TRUE, FALSE, 35)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE batch DROP CONSTRAINT IF EXISTS batch_status_check;
ALTER TABLE batch
  ADD CONSTRAINT batch_status_check
  CHECK (status IN ('upcoming','active','completed','cancelled','expired','archived','suspended','on_hold'));
