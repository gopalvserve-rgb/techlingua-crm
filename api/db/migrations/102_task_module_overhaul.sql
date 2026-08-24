-- 102 — crm18aug-v2 Batch 2: MY TASK module overhaul (client docx "My task").
-- Tasks and follow-ups share the follow_up table. This migration makes a task first-class:
--   * a "Related To" entity link (entity_type + entity_id) so a task can point at any record
--     of a chosen TYPE (Lead, Student, Admission, Enrollment, Course, Batch, Payment, Invoice,
--     Follow-up, Employer, Placement, Trainer, Staff) — NOT just its lead;
--   * a user-set Task Status (in_progress / on_hold / completed); "overdue" is DERIVED at read
--     time (pending + past due), never stored;
--   * completion / outcome tracking (completion_note + completed_by; completed_at already exists);
--   * a `kind` flag so the lead activity timeline can label a task as "Task" (not "Follow-up").
-- Everything is nullable / defaulted so existing rows keep working (backfill below).

-- 1) Related-To entity link -----------------------------------------------------
ALTER TABLE follow_up ADD COLUMN IF NOT EXISTS entity_type VARCHAR(24);
ALTER TABLE follow_up ADD COLUMN IF NOT EXISTS entity_id   BIGINT;
CREATE INDEX IF NOT EXISTS idx_followup_entity ON follow_up(entity_type, entity_id)
  WHERE entity_type IS NOT NULL;

-- 2) Task Status (user-set) — overdue is derived, so it is NOT a stored value --
ALTER TABLE follow_up ADD COLUMN IF NOT EXISTS task_status VARCHAR(16) NOT NULL DEFAULT 'in_progress';
DO $$ BEGIN
  ALTER TABLE follow_up ADD CONSTRAINT chk_followup_task_status
    CHECK (task_status IN ('in_progress','on_hold','completed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_followup_task_status ON follow_up(task_status);

-- 3) Completion / outcome tracking ---------------------------------------------
ALTER TABLE follow_up ADD COLUMN IF NOT EXISTS completion_note TEXT;
ALTER TABLE follow_up ADD COLUMN IF NOT EXISTS completed_by    BIGINT;
DO $$ BEGIN
  ALTER TABLE follow_up ADD CONSTRAINT fk_followup_completed_by
    FOREIGN KEY (completed_by) REFERENCES "user"(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 4) kind flag: 'task' | 'follow_up' (the timeline label reflects the real type) --
ALTER TABLE follow_up ADD COLUMN IF NOT EXISTS kind VARCHAR(12) NOT NULL DEFAULT 'follow_up';
DO $$ BEGIN
  ALTER TABLE follow_up ADD CONSTRAINT chk_followup_kind CHECK (kind IN ('task','follow_up'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 5) Backfill — nothing breaks: existing DONE rows become 'completed', the rest stay
--    'in_progress' (the column default). completed_at is already populated for done rows;
--    completed_by is left NULL for historical rows (unknown actor).
UPDATE follow_up SET task_status = 'completed' WHERE status = 'done' AND task_status <> 'completed';
