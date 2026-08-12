-- 068: Student CUSTOM FIELDS — values column, mirroring lead.custom_fields.
-- Custom-field DEFINITIONS already live in custom_field_def (migration 004) and support
-- entity='student'. Their VALUES had nowhere to persist on a student — the student aggregate
-- carried no custom_fields block and a PATCH with {custom_fields:{...}} was a no-op. This adds
-- the SAME storage leads use (a jsonb column, keyed by field_key) so there is ONE code path.
-- Idempotent (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS). Re-runnable.
ALTER TABLE student ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_student_custom_gin ON student USING GIN (custom_fields);
