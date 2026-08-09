-- =============================================================================
-- 046 — STUDENT FULL PROFILE FIELDS (client request, Aug 2026)
--
-- The Add/Edit Student form must capture the full admission field set, grouped into
-- sections: Identity, Contact, Family/Guardian, Address, ID Proofs, Education. Migration
-- 044 created `student` with the CRM seam columns only (name/phone/email/scope/enrolment);
-- this migration adds the ACADEMIC / ADMISSION columns the client will filter and report on.
--
-- REAL COLUMNS, not a JSONB blob: the client wants to filter/report on many of these
-- (gender, dob cohort, admission date, state/city, qualification), and a column is the only
-- thing you can index and GROUP BY. (Same call migration 029 made for the numbering series.)
--
-- SENSITIVE: aadhaar / pan / passport are stored AS-IS (no transform) and MUST NOT be logged
-- (the service never echoes them; there is no request-body logger — see students.spec).
--
-- lead_id BECOMES NULLABLE: 044 made it NOT NULL because a student was only ever a converted
-- lead. The Add Student form creates a student DIRECTLY (no lead), so lead_id is now optional.
-- `uq_student_lead` is a partial unique index and Postgres treats NULLs as distinct, so any
-- number of lead-less students coexist while one-live-student-per-lead still holds for converts.
--
-- Idempotent throughout (ADD COLUMN IF NOT EXISTS / guarded). Re-runnable.
-- =============================================================================

-- lead-less students (direct Add) — drop the NOT NULL 044 put on lead_id.
ALTER TABLE student ALTER COLUMN lead_id DROP NOT NULL;

-- ---- Identity -------------------------------------------------------------
ALTER TABLE student ADD COLUMN IF NOT EXISTS enrollment_no      VARCHAR(48)  NULL;
ALTER TABLE student ADD COLUMN IF NOT EXISTS dob                DATE         NULL;
ALTER TABLE student ADD COLUMN IF NOT EXISTS gender             VARCHAR(16)  NULL;
ALTER TABLE student ADD COLUMN IF NOT EXISTS nationality        VARCHAR(64)  NULL;
ALTER TABLE student ADD COLUMN IF NOT EXISTS registration_date  DATE         NULL;
ALTER TABLE student ADD COLUMN IF NOT EXISTS admission_date     DATE         NULL;

-- ---- Contact (phone already exists = Primary Mobile; email already exists) --
ALTER TABLE student ADD COLUMN IF NOT EXISTS whatsapp_phone     VARCHAR(32)  NULL;
ALTER TABLE student ADD COLUMN IF NOT EXISTS alt_phone          VARCHAR(32)  NULL;

-- ---- Family / Guardian ----------------------------------------------------
ALTER TABLE student ADD COLUMN IF NOT EXISTS father_name        VARCHAR(160) NULL;
ALTER TABLE student ADD COLUMN IF NOT EXISTS father_mobile      VARCHAR(32)  NULL;
ALTER TABLE student ADD COLUMN IF NOT EXISTS guardian_name      VARCHAR(160) NULL;
ALTER TABLE student ADD COLUMN IF NOT EXISTS guardian_mobile    VARCHAR(32)  NULL;
ALTER TABLE student ADD COLUMN IF NOT EXISTS guardian_email     VARCHAR(160) NULL;
ALTER TABLE student ADD COLUMN IF NOT EXISTS guardian_relation  VARCHAR(24)  NULL;

-- ---- Address (state/city are the real masters, so we can filter/report) ----
ALTER TABLE student ADD COLUMN IF NOT EXISTS address_line1      VARCHAR(200) NULL;
ALTER TABLE student ADD COLUMN IF NOT EXISTS address_line2      VARCHAR(200) NULL;
ALTER TABLE student ADD COLUMN IF NOT EXISTS landmark           VARCHAR(160) NULL;
ALTER TABLE student ADD COLUMN IF NOT EXISTS country            VARCHAR(80)  NULL;
ALTER TABLE student ADD COLUMN IF NOT EXISTS state_id           BIGINT       NULL REFERENCES state(id);
ALTER TABLE student ADD COLUMN IF NOT EXISTS city_id            BIGINT       NULL REFERENCES city(id);
ALTER TABLE student ADD COLUMN IF NOT EXISTS district           VARCHAR(120) NULL;
ALTER TABLE student ADD COLUMN IF NOT EXISTS pincode            VARCHAR(12)  NULL;
ALTER TABLE student ADD COLUMN IF NOT EXISTS permanent_address  TEXT         NULL;
ALTER TABLE student ADD COLUMN IF NOT EXISTS current_address    TEXT         NULL;

-- ---- ID Proofs (sensitive — stored as-is, never logged) -------------------
ALTER TABLE student ADD COLUMN IF NOT EXISTS id_proof_type      VARCHAR(32)  NULL;
ALTER TABLE student ADD COLUMN IF NOT EXISTS id_proof_number    VARCHAR(80)  NULL;
ALTER TABLE student ADD COLUMN IF NOT EXISTS aadhaar            VARCHAR(20)  NULL;
ALTER TABLE student ADD COLUMN IF NOT EXISTS pan                VARCHAR(20)  NULL;
ALTER TABLE student ADD COLUMN IF NOT EXISTS passport           VARCHAR(40)  NULL;

-- ---- Education ------------------------------------------------------------
ALTER TABLE student ADD COLUMN IF NOT EXISTS qualification         VARCHAR(160) NULL;
ALTER TABLE student ADD COLUMN IF NOT EXISTS institution           VARCHAR(200) NULL;
ALTER TABLE student ADD COLUMN IF NOT EXISTS board_university      VARCHAR(200) NULL;
ALTER TABLE student ADD COLUMN IF NOT EXISTS passing_year          INT          NULL;
ALTER TABLE student ADD COLUMN IF NOT EXISTS previous_institution  VARCHAR(200) NULL;

-- Enrollment No is unique within the org when set (auto series OR manual entry).
CREATE UNIQUE INDEX IF NOT EXISTS uq_student_enrollment_no
  ON student (org_id, enrollment_no) WHERE enrollment_no IS NOT NULL AND deleted_at IS NULL;

-- Report/filter helpers on the columns the client asked to slice by.
CREATE INDEX IF NOT EXISTS idx_student_state  ON student (state_id)  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_student_gender ON student (gender)    WHERE deleted_at IS NULL;
