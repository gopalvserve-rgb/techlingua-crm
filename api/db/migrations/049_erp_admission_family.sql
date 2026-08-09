-- =============================================================================
-- 049 — ERP ADMISSION FORM + STUDENT FAMILY / SIBLINGS (Phase 2, Batch 3)
--
-- Two features on top of the Phase-2 student model:
--
--  1) ONLINE ADMISSION FORM — a PUBLIC, key-authenticated self-serve form a prospective
--     student fills themselves (same public-endpoint pattern as the website-form capture and
--     the login-free parent report view). Staff generate a per-branch/vertical (or org-wide)
--     form LINK in the app; the public URL renders the ~45 student fields; a submit creates a
--     PENDING `admission` (NOT a live student). Staff review the queue and APPROVE (→ creates
--     the student via the existing student create) or REJECT with a reason.
--        · admission_form — the generated public links (unguessable form_key, rotatable).
--        · admission      — one submission; the full payload lives in JSONB `data`, with the
--                           scope + list/filter columns denormalised alongside.
--     admission_no is minted from the numbering series (kind 'admission', ADM-) ON APPROVAL.
--
--  2) FAMILY / SIBLINGS — a `family_group` groups students of one family. student.family_group_id
--     links them; siblings are simply the other members of the group (symmetric, discoverable
--     from EITHER student). Feeds the Phase-3 sibling discount.
--
-- Scope: admission_form + admission denormalise branch_id + vertical_id so the ScopeResolver
-- filters them like every other module. Idempotent (IF NOT EXISTS / ON CONFLICT). Re-runnable.
-- =============================================================================

-- 1) admission_form — the public, key-authenticated links --------------------
CREATE TABLE IF NOT EXISTS admission_form (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES organisation(id),
  branch_id     BIGINT NULL REFERENCES branch(id),
  vertical_id   BIGINT NULL REFERENCES vertical(id),
  course_id     BIGINT NULL REFERENCES m_course(id),
  title         VARCHAR(160) NOT NULL DEFAULT 'Admission Form',
  form_key      VARCHAR(48) NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  submissions   INT NOT NULL DEFAULT 0,
  created_by    BIGINT NULL REFERENCES "user"(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ NULL,
  deleted_by    BIGINT NULL REFERENCES "user"(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_admission_form_key ON admission_form (form_key) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_admission_form_scope ON admission_form (branch_id, vertical_id) WHERE deleted_at IS NULL;

-- 2) admission — a pending submission ----------------------------------------
CREATE TABLE IF NOT EXISTS admission (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES organisation(id),
  form_id       BIGINT NULL REFERENCES admission_form(id),
  branch_id     BIGINT NOT NULL REFERENCES branch(id),
  vertical_id   BIGINT NOT NULL REFERENCES vertical(id),
  course_id     BIGINT NULL REFERENCES m_course(id),
  owner_id      BIGINT NULL REFERENCES "user"(id),
  admission_no  VARCHAR(64) NULL,
  full_name     VARCHAR(160) NOT NULL,
  phone         VARCHAR(32) NULL,
  email         VARCHAR(160) NULL,
  data          JSONB NOT NULL DEFAULT '{}'::jsonb,
  status        VARCHAR(16) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected')),
  student_id    BIGINT NULL REFERENCES student(id),
  reject_reason TEXT NULL,
  reviewed_by   BIGINT NULL REFERENCES "user"(id),
  reviewed_at   TIMESTAMPTZ NULL,
  source_ip     VARCHAR(64) NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ NULL,
  deleted_by    BIGINT NULL REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS idx_admission_scope  ON admission (branch_id, vertical_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_admission_status ON admission (status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_admission_course ON admission (course_id) WHERE deleted_at IS NULL;

-- 3) family_group + student.family_group_id ----------------------------------
CREATE TABLE IF NOT EXISTS family_group (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES organisation(id),
  label       VARCHAR(160) NULL,
  created_by  BIGINT NULL REFERENCES "user"(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE student ADD COLUMN IF NOT EXISTS family_group_id BIGINT NULL REFERENCES family_group(id);
CREATE INDEX IF NOT EXISTS idx_student_family ON student (family_group_id) WHERE family_group_id IS NOT NULL AND deleted_at IS NULL;

-- 4) Numbering — 'admission' (ADM-) is created lazily by NumberingService (KIND_DEFAULTS).

-- 5) Permissions --------------------------------------------------------------
INSERT INTO permission (key, module, action) VALUES
  ('admission.read',   'admission', 'read'),
  ('admission.manage', 'admission', 'manage'),
  ('admission.review', 'admission', 'review'),
  ('admission.delete', 'admission', 'delete')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('admission.read',   'Super Admin',        'all'),
      ('admission.read',   'Organization Admin', 'all'),
      ('admission.read',   'Branch Manager',     'branch'),
      ('admission.read',   'Vertical Manager',   'vertical'),
      ('admission.read',   'Team Leader',        'team'),
      ('admission.read',   'Academic Coordinator','all'),
      ('admission.manage', 'Super Admin',        'all'),
      ('admission.manage', 'Organization Admin', 'all'),
      ('admission.manage', 'Branch Manager',     'branch'),
      ('admission.manage', 'Vertical Manager',   'vertical'),
      ('admission.review', 'Super Admin',        'all'),
      ('admission.review', 'Organization Admin', 'all'),
      ('admission.review', 'Branch Manager',     'branch'),
      ('admission.review', 'Vertical Manager',   'vertical'),
      ('admission.delete', 'Super Admin',        'all'),
      ('admission.delete', 'Organization Admin', 'all'),
      ('admission.delete', 'Branch Manager',     'branch')
    ) AS v(pkey, role_name, scope)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope
      FROM role ro, permission p
     WHERE ro.name = r.role_name AND p.key = r.pkey
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;
