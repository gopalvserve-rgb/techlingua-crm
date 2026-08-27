-- =============================================================================
-- 113 — ENROLMENT BATCH ASSIGN (27aug Batch C, items 4 & 5)
--
-- Batch assignment becomes reachable from the STUDENT side and per-ENROLMENT: enrolment.batch_id
-- (the unused seam from 044) is now written by the Student Management "Assign Batch" action, so a
-- student with multiple enrolments can have a batch per course. Adds a lookup index + an
-- assigned-at stamp. No hard block on an incomplete admission step — assignment is allowed with a
-- warning. Existing rows untouched (batch_id stays NULL until assigned).
-- Idempotent.
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_enrolment_batch ON enrolment (batch_id) WHERE batch_id IS NOT NULL;
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS batch_assigned_at TIMESTAMPTZ NULL;
ALTER TABLE enrolment ADD COLUMN IF NOT EXISTS batch_assigned_by BIGINT NULL REFERENCES "user"(id);
