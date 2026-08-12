-- =============================================================================
-- 066 — ASSESSMENT / TEST MODULE · BATCH D: RESULTS, GRADING, CERTIFICATES
--
-- Builds on Batch A (Question Bank, 063), B (Tests, 064) and C (Attempts, 065). Adds the
-- RESULT layer: a configurable GRADE SCHEME (India default seeded), server-computed grade +
-- percentage cached on an evaluated attempt, and CERTIFICATES for passed students — each with
-- a per-branch/vertical FY certificate number, a generated PDF persisted to Cloudflare R2
-- (r2_key only, never on disk) and a public VERIFY code.
--
--   1) grade_scheme + grade_band     — editable grading bands; India default seeded.
--   2) assessment.grade_scheme_id    — a test may pin a scheme (else the org default).
--   3) assessment_attempt cache      — grade_label + percentage at evaluation time (backfilled).
--   4) assessment_certificate        — issued/revoked certs (cert no + verify_code + pdf_r2_key).
--   5) permissions + role grants.
--   6) A guarded, clearly-marked [DEMO] seed. Idempotent throughout.
-- =============================================================================

-- 1 ------------------------------------------------------------------- grade_scheme
CREATE TABLE IF NOT EXISTS grade_scheme (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES organisation(id),
  branch_id     BIGINT NULL REFERENCES branch(id),
  vertical_id   BIGINT NULL REFERENCES vertical(id),
  name          VARCHAR(120) NOT NULL,
  is_default    BOOLEAN NOT NULL DEFAULT false,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_by    BIGINT NULL REFERENCES "user"(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ NULL,
  deleted_by    BIGINT NULL REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS idx_grade_scheme_scope ON grade_scheme (branch_id, vertical_id) WHERE deleted_at IS NULL;
-- at most ONE default scheme per org (partial unique)
CREATE UNIQUE INDEX IF NOT EXISTS uq_grade_scheme_default
  ON grade_scheme (org_id) WHERE is_default AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS grade_band (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scheme_id     BIGINT NOT NULL REFERENCES grade_scheme(id) ON DELETE CASCADE,
  label         VARCHAR(16) NOT NULL,
  min_pct       NUMERIC(6,2) NOT NULL CHECK (min_pct >= 0 AND min_pct <= 100),
  max_pct       NUMERIC(6,2) NOT NULL CHECK (max_pct >= 0 AND max_pct <= 100),
  is_pass       BOOLEAN NOT NULL DEFAULT true,
  ordering      INT NOT NULL DEFAULT 1,
  CHECK (min_pct < max_pct)
);
CREATE INDEX IF NOT EXISTS idx_grade_band_scheme ON grade_band (scheme_id, ordering);

-- 2 --------------------------------------------------- assessment.grade_scheme_id
ALTER TABLE assessment ADD COLUMN IF NOT EXISTS grade_scheme_id BIGINT NULL REFERENCES grade_scheme(id);

-- 3 ------------------------------- assessment_attempt cache (grade_label, percentage)
ALTER TABLE assessment_attempt ADD COLUMN IF NOT EXISTS grade_label VARCHAR(16) NULL;
ALTER TABLE assessment_attempt ADD COLUMN IF NOT EXISTS percentage NUMERIC(6,2) NULL;

-- 4 ------------------------------------------------------------ assessment_certificate
CREATE TABLE IF NOT EXISTS assessment_certificate (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          BIGINT NOT NULL REFERENCES organisation(id),
  branch_id       BIGINT NULL REFERENCES branch(id),
  vertical_id     BIGINT NULL REFERENCES vertical(id),
  pipeline_id     BIGINT NULL REFERENCES pipeline(id),
  team_id         BIGINT NULL REFERENCES team(id),
  student_id      BIGINT NOT NULL REFERENCES student(id),
  assessment_id   BIGINT NULL REFERENCES assessment(id),
  attempt_id      BIGINT NULL REFERENCES assessment_attempt(id),
  certificate_no  VARCHAR(60) NOT NULL,
  title           VARCHAR(200) NOT NULL,
  grade_label     VARCHAR(16) NULL,
  percentage      NUMERIC(6,2) NULL,
  issued_on       DATE NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Kolkata')::date,
  pdf_r2_key      VARCHAR(400) NULL,
  verify_code     VARCHAR(48) NOT NULL,
  status          VARCHAR(10) NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','revoked')),
  revoked_at      TIMESTAMPTZ NULL,
  revoked_by      BIGINT NULL REFERENCES "user"(id),
  revoke_reason   TEXT NULL,
  issued_by       BIGINT NULL REFERENCES "user"(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ NULL,
  deleted_by      BIGINT NULL REFERENCES "user"(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_asmt_cert_verify ON assessment_certificate (verify_code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_asmt_cert_no ON assessment_certificate (org_id, certificate_no) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_asmt_cert_student   ON assessment_certificate (student_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_asmt_cert_assess    ON assessment_certificate (assessment_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_asmt_cert_scope     ON assessment_certificate (branch_id, vertical_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_asmt_cert_status    ON assessment_certificate (status) WHERE deleted_at IS NULL;

-- 5 ------------------------------------------------------------- permissions + grants
INSERT INTO permission (key, module, action) VALUES
  ('grade_scheme.read',            'grade_scheme', 'read'),
  ('grade_scheme.create',          'grade_scheme', 'create'),
  ('grade_scheme.update',          'grade_scheme', 'update'),
  ('grade_scheme.delete',          'grade_scheme', 'delete'),
  ('assessment_certificate.read',   'assessment_certificate', 'read'),
  ('assessment_certificate.issue',  'assessment_certificate', 'issue'),
  ('assessment_certificate.revoke', 'assessment_certificate', 'revoke'),
  ('assessment_certificate.delete', 'assessment_certificate', 'delete')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('grade_scheme.read',              'Super Admin',          'all'),
      ('grade_scheme.read',              'Organization Admin',   'all'),
      ('grade_scheme.read',              'Academic Coordinator', 'branch'),
      ('grade_scheme.read',              'Trainer',              'branch'),
      ('grade_scheme.read',              'Branch Manager',       'branch'),
      ('grade_scheme.read',              'Vertical Manager',     'vertical'),
      ('grade_scheme.create',            'Super Admin',          'all'),
      ('grade_scheme.create',            'Organization Admin',   'all'),
      ('grade_scheme.create',            'Academic Coordinator', 'branch'),
      ('grade_scheme.update',            'Super Admin',          'all'),
      ('grade_scheme.update',            'Organization Admin',   'all'),
      ('grade_scheme.update',            'Academic Coordinator', 'branch'),
      ('grade_scheme.delete',            'Super Admin',          'all'),
      ('grade_scheme.delete',            'Organization Admin',   'all'),
      ('assessment_certificate.read',    'Super Admin',          'all'),
      ('assessment_certificate.read',    'Organization Admin',   'all'),
      ('assessment_certificate.read',    'Academic Coordinator', 'branch'),
      ('assessment_certificate.read',    'Trainer',              'branch'),
      ('assessment_certificate.read',    'Branch Manager',       'branch'),
      ('assessment_certificate.read',    'Vertical Manager',     'vertical'),
      ('assessment_certificate.read',    'Counsellor',           'own'),
      ('assessment_certificate.issue',   'Super Admin',          'all'),
      ('assessment_certificate.issue',   'Organization Admin',   'all'),
      ('assessment_certificate.issue',   'Academic Coordinator', 'branch'),
      ('assessment_certificate.issue',   'Trainer',              'branch'),
      ('assessment_certificate.revoke',  'Super Admin',          'all'),
      ('assessment_certificate.revoke',  'Organization Admin',   'all'),
      ('assessment_certificate.revoke',  'Academic Coordinator', 'branch'),
      ('assessment_certificate.delete',  'Super Admin',          'all'),
      ('assessment_certificate.delete',  'Organization Admin',   'all'),
      ('assessment_certificate.delete',  'Academic Coordinator', 'branch')
    ) AS v(pkey, role_name, scope)
  LOOP
    INSERT INTO role_permission (role_id, permission_id, record_scope)
    SELECT ro.id, p.id, r.scope
      FROM role ro, permission p
     WHERE ro.name = r.role_name AND p.key = r.pkey
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END LOOP;
END $$;

-- 6a ----------------------------------------------- seed the India DEFAULT grade scheme
DO $$
DECLARE v_org BIGINT; v_scheme BIGINT;
BEGIN
  SELECT id INTO v_org FROM organisation ORDER BY id LIMIT 1;
  IF v_org IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM grade_scheme WHERE org_id = v_org AND is_default AND deleted_at IS NULL) THEN RETURN; END IF;

  INSERT INTO grade_scheme (org_id, name, is_default, active)
    VALUES (v_org, 'India Standard (Default)', true, true)
    RETURNING id INTO v_scheme;

  -- Contiguous 0-100 bands; resolution picks the highest band whose min_pct <= pct.
  INSERT INTO grade_band (scheme_id, label, min_pct, max_pct, is_pass, ordering) VALUES
    (v_scheme, 'Fail', 0,   50,  false, 1),
    (v_scheme, 'C',    50,  60,  true,  2),
    (v_scheme, 'B',    60,  70,  true,  3),
    (v_scheme, 'B+',   70,  80,  true,  4),
    (v_scheme, 'A',    80,  90,  true,  5),
    (v_scheme, 'A+',   90,  100, true,  6);
END $$;

-- 6b -------------------------------- number series for assessment certificates (FY reset)
INSERT INTO number_series (org_id, kind, prefix, next_number, padding, reset_period)
  SELECT id, 'assessment_certificate', 'ACRT-', 1, 4, 'fy' FROM organisation ORDER BY id LIMIT 1
  ON CONFLICT DO NOTHING;

-- 6c -------------- backfill grade_label + percentage on already-EVALUATED attempts
DO $$
DECLARE v_org BIGINT;
BEGIN
  SELECT id INTO v_org FROM organisation ORDER BY id LIMIT 1;
  IF v_org IS NULL THEN RETURN; END IF;

  UPDATE assessment_attempt at
     SET percentage = ROUND((at.total_score / at.max_score) * 100, 2),
         grade_label = (
           SELECT gb.label FROM grade_band gb
             JOIN grade_scheme gs ON gs.id = gb.scheme_id
            WHERE gs.org_id = v_org AND gs.is_default AND gs.deleted_at IS NULL
              AND gb.min_pct <= ROUND((at.total_score / at.max_score) * 100, 2)
            ORDER BY gb.min_pct DESC LIMIT 1)
   WHERE at.status = 'evaluated' AND at.deleted_at IS NULL
     AND at.total_score IS NOT NULL AND at.max_score > 0
     AND at.percentage IS NULL;
END $$;

-- 6d ---------------------------------- [DEMO] certificate for the evaluated IT mock attempt
DO $$
DECLARE
  v_org BIGINT; att RECORD; v_pct NUMERIC; v_grade VARCHAR; v_title VARCHAR;
BEGIN
  SELECT id INTO v_org FROM organisation ORDER BY id LIMIT 1;
  IF v_org IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM assessment_certificate WHERE verify_code = 'DEMOCERT7K2P9XQ4') THEN RETURN; END IF;

  SELECT at.id, at.student_id, at.branch_id, at.vertical_id, at.assessment_id,
         at.total_score, at.max_score, a.title AS assessment_title
    INTO att
    FROM assessment_attempt at
    JOIN assessment a ON a.id = at.assessment_id
   WHERE at.org_id = v_org AND at.status = 'evaluated' AND at.is_passed IS TRUE
     AND at.deleted_at IS NULL AND at.max_score > 0
   ORDER BY at.id LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  v_pct := ROUND((att.total_score / att.max_score) * 100, 2);
  SELECT gb.label INTO v_grade FROM grade_band gb
     JOIN grade_scheme gs ON gs.id = gb.scheme_id
    WHERE gs.org_id = v_org AND gs.is_default AND gs.deleted_at IS NULL AND gb.min_pct <= v_pct
    ORDER BY gb.min_pct DESC LIMIT 1;
  v_title := 'Certificate of Achievement — ' || att.assessment_title;

  INSERT INTO assessment_certificate (org_id, branch_id, vertical_id, student_id, assessment_id, attempt_id,
      certificate_no, title, grade_label, percentage, verify_code, status)
    VALUES (v_org, att.branch_id, att.vertical_id, att.student_id, att.assessment_id, att.id,
      'ACRT-DEMO/0001', v_title, v_grade, v_pct, 'DEMOCERT7K2P9XQ4', 'issued');
END $$;
