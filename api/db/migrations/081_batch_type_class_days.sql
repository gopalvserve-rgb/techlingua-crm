-- =============================================================================
-- 081 — BATCH TYPE + CLASS DAYS + FREQUENCY (client feedback)
--
-- The Add/Edit Batch form gains three fields so a batch describes HOW it runs, and
-- student attendance can track against the batch's class days:
--
--   batch_type  — a seeded catalog value (Regular / Fast Track / Weekend / Weekday /
--                 Intensive / Crash Course / Online / Corporate / Customized). Mirrors the
--                 batch_status_def catalog pattern from migration 080 (code + label + ordering).
--   class_days  — the ISO weekday numbers a batch meets (Mon=1 … Sun=7), stored as int[].
--                 Attendance is EXPECTED/marked only on these days. Empty {} = unrestricted
--                 (legacy back-compat — every existing batch keeps working, nothing breaks).
--   frequency   — daily | weekdays | weekends | custom. Frequency DERIVES class_days server-side
--                 (Daily→[1..7], Weekdays→[1..5], Weekends→[6,7], Custom→user-selected). Both
--                 are stored explicitly (frequency is the intent, class_days is the resolved set).
--
-- Idempotent throughout (IF NOT EXISTS / ON CONFLICT / guarded), schema-guard style.
-- =============================================================================

-- 1 ------------------------------------------------ the batch-type catalog + seed
CREATE TABLE IF NOT EXISTS batch_type_def (
  code     VARCHAR(24) PRIMARY KEY,
  label    VARCHAR(48) NOT NULL,
  ordering INT NOT NULL DEFAULT 0
);

INSERT INTO batch_type_def (code, label, ordering) VALUES
  ('regular',      'Regular',      10),
  ('fast_track',   'Fast Track',   20),
  ('weekend',      'Weekend',      30),
  ('weekday',      'Weekday',      40),
  ('intensive',    'Intensive',    50),
  ('crash_course', 'Crash Course', 60),
  ('online',       'Online',       70),
  ('corporate',    'Corporate',    80),
  ('customized',   'Customized',   90)
ON CONFLICT (code) DO NOTHING;

-- 2 ------------------------------------------------ batch columns (guarded)
ALTER TABLE batch ADD COLUMN IF NOT EXISTS batch_type VARCHAR(24) NOT NULL DEFAULT 'regular';
ALTER TABLE batch ADD COLUMN IF NOT EXISTS class_days INT[]       NOT NULL DEFAULT '{}';
ALTER TABLE batch ADD COLUMN IF NOT EXISTS frequency  VARCHAR(16) NOT NULL DEFAULT 'custom';

-- 3 ------------------------------------------------ BACKFILL (deterministic, idempotent)
-- Every existing batch: batch_type 'regular', class_days '{}' (unrestricted), frequency 'custom'.
-- The column defaults already applied these to existing rows; make it explicit + safe for re-run.
UPDATE batch SET batch_type = 'regular' WHERE batch_type IS NULL;
UPDATE batch SET class_days  = '{}'      WHERE class_days  IS NULL;
UPDATE batch SET frequency   = 'custom'  WHERE frequency   IS NULL;

-- 4 ------------------------------------------------ CHECK constraints + FK to catalog + index
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'batch_frequency_check') THEN
    ALTER TABLE batch
      ADD CONSTRAINT batch_frequency_check
      CHECK (frequency IN ('daily','weekdays','weekends','custom'));
  END IF;
  -- class_days must be a subset of the 7 ISO weekdays (1..7). An empty array trivially passes.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'batch_class_days_check') THEN
    ALTER TABLE batch
      ADD CONSTRAINT batch_class_days_check
      CHECK (class_days <@ ARRAY[1,2,3,4,5,6,7]);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'batch_type_fk') THEN
    ALTER TABLE batch
      ADD CONSTRAINT batch_type_fk FOREIGN KEY (batch_type) REFERENCES batch_type_def(code);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_batch_type ON batch (batch_type) WHERE deleted_at IS NULL;
