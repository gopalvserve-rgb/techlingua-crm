-- 139 — WORKSPACE › SHARED DOCUMENTS, completed (client 12 Nov 2026: "This module is incomplete").
--   · sub-folders (a folder inside a folder, any depth, with breadcrumbs)
--   · version history: "upload a new version" keeps every earlier file, each downloadable
--   · a document can be linked to a lead or a student (and listed from there)
--   · edit / move a document (the API had the method but no route)
ALTER TABLE shared_doc_folder ADD COLUMN IF NOT EXISTS parent_id BIGINT NULL REFERENCES shared_doc_folder(id);
ALTER TABLE shared_doc ADD COLUMN IF NOT EXISTS lead_id BIGINT NULL REFERENCES lead(id);
ALTER TABLE shared_doc ADD COLUMN IF NOT EXISTS student_id BIGINT NULL REFERENCES student(id);
ALTER TABLE shared_doc ADD COLUMN IF NOT EXISTS version_no INT NOT NULL DEFAULT 1;
ALTER TABLE shared_doc ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NULL;
ALTER TABLE shared_doc ADD COLUMN IF NOT EXISTS updated_by BIGINT NULL;
CREATE INDEX IF NOT EXISTS idx_shared_doc_lead ON shared_doc (lead_id) WHERE deleted_at IS NULL AND lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shared_doc_student ON shared_doc (student_id) WHERE deleted_at IS NULL AND student_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS shared_doc_version (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_id       BIGINT NOT NULL REFERENCES shared_doc(id) ON DELETE CASCADE,
  version_no   INT NOT NULL,
  file_name    VARCHAR(255) NOT NULL,
  mime         VARCHAR(120) NULL,
  size_bytes   BIGINT NOT NULL DEFAULT 0,
  r2_key       VARCHAR(400) NULL,
  content      BYTEA NULL,
  note         VARCHAR(300) NULL,
  uploaded_by  BIGINT NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  replaced_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (doc_id, version_no)
);
