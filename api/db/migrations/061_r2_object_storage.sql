-- =============================================================================
-- 061 — CLOUDFLARE R2 IS NOW THE SINGLE FILE / ASSET STORE
--
-- Client directive (Aug 2026): EVERY file/asset must live in Cloudflare R2 — nothing on
-- the Railway server disk, and NO binary blobs in the database. The DB stores only the R2
-- object key (+ metadata); the bytes live in the `techlingua` bucket.
--
-- This migration:
--   1. Adds `r2_key` to `student_document` and RELAXES `content` to NULL, so a NEW
--      admission/KYC upload stores the R2 key (content stays NULL). Any pre-existing
--      bytea rows remain readable; new writes go to R2. (Fresh app — expected zero old rows.)
--   2. Creates `generated_document` — the durable index of every PDF we generate
--      (certificate / report card / GST invoice / quotation / fee receipt / refund voucher
--      / purchase order). On issue/serve the PDF is uploaded to R2 and its key recorded
--      here; the download path streams from / presigns R2. The PDF bytes are NEVER written
--      to the server disk and NEVER stored as a DB blob — only the key lives here.
--
-- Idempotent (IF NOT EXISTS / conditional). Re-runnable.
-- =============================================================================

-- 1 --------------------------------------------------------------- student_document
ALTER TABLE student_document ADD COLUMN IF NOT EXISTS r2_key VARCHAR(400) NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'student_document' AND column_name = 'content' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE student_document ALTER COLUMN content DROP NOT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_student_document_r2 ON student_document (r2_key) WHERE r2_key IS NOT NULL;

-- 2 --------------------------------------------------------------- generated_document
CREATE TABLE IF NOT EXISTS generated_document (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT NULL REFERENCES organisation(id),
  kind          VARCHAR(40)  NOT NULL,
  ref_id        BIGINT       NOT NULL,
  doc_no        VARCHAR(80)  NULL,
  r2_key        VARCHAR(400) NOT NULL,
  content_type  VARCHAR(100) NOT NULL DEFAULT 'application/pdf',
  size_bytes    INTEGER      NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_generated_document_kind_ref ON generated_document (kind, ref_id);

-- 3 --------------------------------------------------------------- report_export
-- The Report Builder export (Excel/PDF/CSV) was stored as BYTEA. Route it to R2: on render
-- the file goes to R2 (r2_key), download streams from / presigns R2. Legacy bytea still read.
ALTER TABLE report_export ADD COLUMN IF NOT EXISTS r2_key VARCHAR(400) NULL;

-- 4 --------------------------------------------------------------- message_attachment
-- Email attachments (scheduled report delivery) were BYTEA. Route to R2 too; the mailer
-- fetches the bytes from R2 at send time. Relax the NOT NULL so an R2-backed row needs no bytes.
ALTER TABLE message_attachment ADD COLUMN IF NOT EXISTS r2_key VARCHAR(400) NULL;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'message_attachment' AND column_name = 'bytes' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE message_attachment ALTER COLUMN bytes DROP NOT NULL;
  END IF;
END $$;
