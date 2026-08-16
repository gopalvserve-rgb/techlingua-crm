-- 088 — Returning-student (alumni) flag on leads (dev/95, client item 1).
-- When a NEW lead's contact (E.164 phone / email) matches an EXISTING converted student,
-- the lead is still created but flagged so staff see it is a returning student, with a
-- reference to the matched student. Guarded / idempotent (ADD COLUMN IF NOT EXISTS).

ALTER TABLE lead ADD COLUMN IF NOT EXISTS is_existing_student BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE lead ADD COLUMN IF NOT EXISTS existing_student_id  BIGINT NULL REFERENCES student(id);

-- lookup helper for the (few) flagged leads that reference a student
CREATE INDEX IF NOT EXISTS idx_lead_existing_student
  ON lead(existing_student_id) WHERE existing_student_id IS NOT NULL;
