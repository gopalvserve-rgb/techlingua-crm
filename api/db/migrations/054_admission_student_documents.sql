-- =============================================================================
-- 054 — ADMISSION / STUDENT DOCUMENT ATTACHMENTS (education + KYC)
--
-- The public online admission form (migration 049) captures the applicant's ~45 profile
-- fields as JSONB. Client Aug 2026: the applicant must also be able to UPLOAD supporting
-- files — a Photo, Aadhaar, PAN, the highest-qualification marksheet/certificate, and any
-- number of "other" documents. Staff must see + download each on the review screen, and on
-- APPROVE the documents must carry over to the created student (shown on the student profile
-- ID & Documents tab).
--
-- STORAGE CHOICE: the file BYTES live in Postgres as BYTEA (small KYC/education docs, capped
-- at 5 MB each, a handful per applicant). Cloudflare R2 is configured-but-not-serving, so we
-- deliberately do NOT depend on it; when R2 is live it becomes the store for LARGE files
-- (video, bulk material) while these small identity docs can stay in-DB or migrate later.
--
-- ONE table serves both phases of a document's life: while pending it is linked by
-- admission_id; on approve the same rows gain student_id (admission_id kept for provenance).
-- Idempotent (IF NOT EXISTS). Re-runnable.
-- =============================================================================

CREATE TABLE IF NOT EXISTS student_document (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES organisation(id),
  admission_id  BIGINT NULL REFERENCES admission(id),
  student_id    BIGINT NULL REFERENCES student(id),
  doc_type      VARCHAR(32)  NOT NULL DEFAULT 'other',
  file_name     VARCHAR(200) NOT NULL,
  mime          VARCHAR(100) NOT NULL,
  size_bytes    INTEGER      NOT NULL DEFAULT 0,
  content       BYTEA        NOT NULL,
  uploaded_by   BIGINT NULL REFERENCES "user"(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ NULL,
  deleted_by    BIGINT NULL REFERENCES "user"(id)
);

CREATE INDEX IF NOT EXISTS idx_student_document_admission ON student_document (admission_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_student_document_student   ON student_document (student_id)   WHERE deleted_at IS NULL;
