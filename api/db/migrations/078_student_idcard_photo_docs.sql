-- =============================================================================
-- 078 — STUDENT PROFILE ENHANCEMENTS (client feedback item 6):
--        Student Photo · Student ID Card · Course display · Upload Document
--
-- No NEW tables are needed: the profile PHOTO and the KYC/education/misc DOCUMENTS both
-- reuse the existing `student_document` table (migration 054; `content` relaxed to NULL +
-- `r2_key` added in migration 061), so uploads are R2-only (only the object key is stored).
-- The printable STUDENT ID CARD is a generated PDF persisted to Cloudflare R2 and indexed in
-- `generated_document` (migration 061) under kind `student_id_card` — no schema change.
--
-- This migration only adds a partial index that makes the per-student "current photo" lookup
-- (WHERE student_id = ? AND doc_type = 'photo') — run on every profile load AND every ID-card
-- render — an index seek instead of a scan. Idempotent + re-runnable.
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_student_document_photo
  ON student_document (student_id, id DESC)
  WHERE doc_type = 'photo' AND deleted_at IS NULL;
