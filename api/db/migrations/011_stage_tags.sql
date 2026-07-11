-- 011: Pipeline Stage Configurator (client mockup, 2026-07-11).
-- Per-stage free-text tags (chips: Cold / Warm / Hot / ...) stored as a JSONB
-- string array. Purely descriptive for now — no automation fires on them.
ALTER TABLE pipeline_stage ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb;
