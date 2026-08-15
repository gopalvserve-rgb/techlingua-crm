-- =============================================================================
-- 083 — BATCH DELIVERY MODE + DESCRIPTION (client feedback #10 / #11)
--
-- The Batch gains two fields so a batch records HOW it is delivered and a free-text note, and
-- the Batch list can filter on delivery mode:
--
--   delivery_mode — Offline / Online / Hybrid. Reuses the SAME seeded catalog the Course uses
--                   (course_delivery_def, migration 082; code == label, human-readable), so the
--                   dropdown option, stored value, filter value and column display never drift.
--                   A CHECK + FK to course_delivery_def keeps it to the three valid values.
--   description   — free text.
--
-- Backfill (deterministic, idempotent): every existing batch → delivery_mode 'Offline', EXCEPT a
-- batch whose batch_type is 'online' derives 'Online' (a sensible default; still fully settable).
-- description is left null until the client sets it (no fake data).
--
-- Idempotent throughout (IF NOT EXISTS / guarded), schema-guard style (mirrors 081).
-- =============================================================================

-- 1 ------------------------------------------------ batch columns (guarded)
ALTER TABLE batch ADD COLUMN IF NOT EXISTS delivery_mode VARCHAR(24) NOT NULL DEFAULT 'Offline';
ALTER TABLE batch ADD COLUMN IF NOT EXISTS description   TEXT;

-- 2 ------------------------------------------------ BACKFILL (deterministic, idempotent)
-- Existing rows already got 'Offline' from the column default; make it explicit + safe for re-run,
-- and let an 'online' batch_type sensibly default to 'Online'.
UPDATE batch SET delivery_mode = 'Offline' WHERE delivery_mode IS NULL;
UPDATE batch SET delivery_mode = 'Online'
 WHERE batch_type = 'online' AND COALESCE(delivery_mode, '') IN ('', 'Offline')
   AND deleted_at IS NULL;

-- 3 ------------------------------------------------ CHECK + FK to the shared delivery catalog + index
DO $$
BEGIN
  -- Guard: only add the FK when the catalog table exists (082 ran first in ordered boot).
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'course_delivery_def')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'batch_delivery_mode_fk') THEN
    ALTER TABLE batch
      ADD CONSTRAINT batch_delivery_mode_fk FOREIGN KEY (delivery_mode)
      REFERENCES course_delivery_def(code);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'batch_delivery_mode_check') THEN
    ALTER TABLE batch
      ADD CONSTRAINT batch_delivery_mode_check
      CHECK (delivery_mode IN ('Offline','Online','Hybrid'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_batch_delivery_mode ON batch (delivery_mode) WHERE deleted_at IS NULL;
