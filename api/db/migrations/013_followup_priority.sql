-- 013 — Client update #4: follow-up / task priority (low | medium | high).
-- Badge + inline edit in My Tasks & Follow-ups; sorted by priority within due date.
ALTER TABLE follow_up ADD COLUMN IF NOT EXISTS priority VARCHAR(6) NOT NULL DEFAULT 'medium';
DO $$ BEGIN
  ALTER TABLE follow_up ADD CONSTRAINT chk_followup_priority CHECK (priority IN ('low','medium','high'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_followup_priority ON follow_up(priority);
