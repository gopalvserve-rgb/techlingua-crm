-- Client 10 Nov 2026 (point 2): the Course column stayed empty for Facebook / imported leads.
-- The lead form answer ("french_language", "Russian", "BCA") rarely equals a Course master name,
-- so course_id stayed NULL and the answer only survived inside the creation note.
--
-- course_text keeps the course exactly as the source sent it. The list shows it when no master
-- course is linked, and Course Management "Custom names" (m_course.meta.aliases) link it to a
-- master course — new leads at ingest, existing leads whenever a course is saved.
ALTER TABLE lead ADD COLUMN IF NOT EXISTS course_text TEXT;
CREATE INDEX IF NOT EXISTS ix_lead_course_text_unlinked ON lead (id)
  WHERE course_id IS NULL AND course_text IS NOT NULL AND deleted_at IS NULL;
