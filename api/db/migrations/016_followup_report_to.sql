-- 016 — Client update #5: task "Report To" (the person the assignee reports progress to).
-- NEW field, independent of created_by: "Reported by Me" in My Tasks keeps meaning
-- "tasks I created" (created_by = me). Optional / nullable; user deletion clears it.
ALTER TABLE follow_up ADD COLUMN IF NOT EXISTS report_to_id INT;
DO $$ BEGIN
  ALTER TABLE follow_up ADD CONSTRAINT fk_followup_report_to
    FOREIGN KEY (report_to_id) REFERENCES "user"(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_followup_report_to ON follow_up(report_to_id);
