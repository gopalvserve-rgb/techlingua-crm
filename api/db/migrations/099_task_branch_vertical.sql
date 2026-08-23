-- 099 — Client Aug 2026 (#2): Branch + Vertical are first-class on a Task (follow_up).
-- Optional / nullable; the Add/Edit Task form now captures them and they persist here.
-- When unset, the task inherits the related lead's branch/vertical (COALESCE in the read).
ALTER TABLE follow_up ADD COLUMN IF NOT EXISTS branch_id INT;
ALTER TABLE follow_up ADD COLUMN IF NOT EXISTS vertical_id INT;
DO $$ BEGIN
  ALTER TABLE follow_up ADD CONSTRAINT fk_followup_branch
    FOREIGN KEY (branch_id) REFERENCES branch(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE follow_up ADD CONSTRAINT fk_followup_vertical
    FOREIGN KEY (vertical_id) REFERENCES vertical(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_followup_branch ON follow_up(branch_id);
CREATE INDEX IF NOT EXISTS idx_followup_vertical ON follow_up(vertical_id);
