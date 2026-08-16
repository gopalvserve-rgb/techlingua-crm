-- 089_id_remodel.sql — CLIENT ID RE-MODEL (dev/97)
-- Three distinct student identifiers, each in the client's LITERAL format `<CODE>-<YEAR>-<NNN>`
-- (calendar year in IST, 3-digit zero-padded sequence):
--   * Student ID    = student.customer_no          = <CENTRE_CODE>-<YEAR>-<NNN>   e.g. VP001-2026-001
--   * Roll Number   = student_vertical_id.student_vertical_no = <VERTICAL_CODE>-<YEAR>-<NNN>  e.g. BCL-2026-001
--   * Enrolment No  = enrolment.enrolment_no        = <COURSE_CODE>-<YEAR>-<NNN>   e.g. ENGA1-2026-001
--
-- NON-BREAKING: numeric FKs (student.id, enrolment.id, student_vertical_id.id, student.enrolment_id)
-- are untouched — only DISPLAY STRINGS change, and no table joins on those strings (only ILIKE
-- search filters + the unique index uq_enrolment_no, which per-course+year sequencing keeps unique).
-- student.student_no (STU-xxxx) stays as the stable internal id; customer_no is a NEW display column.
-- Guarded / idempotent: additive DDL is IF NOT EXISTS; backfills touch only NULL / old-format rows.

-- 1. NEW display Student ID column (kept SEPARATE from student_no so internal ids stay stable).
ALTER TABLE student ADD COLUMN IF NOT EXISTS customer_no VARCHAR(60);

-- 2. Per-(scope, code, year) atomic counter for the three coded formats. One INSERT ... ON CONFLICT
--    DO UPDATE per allocation, so the PK row lock is the mutex (no read-modify-write, no race).
CREATE TABLE IF NOT EXISTS coded_number_seq (
  org_id     BIGINT      NOT NULL,
  scope      VARCHAR(20) NOT NULL,   -- 'student' | 'roll' | 'enrolment'
  code       VARCHAR(40) NOT NULL,   -- centre / vertical / course code (UPPER)
  year       INT         NOT NULL,
  next_seq   INT         NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, scope, code, year)
);

-- 3. The FIXED, configurable org/centre code (default VP001), editable in Settings. Seed once.
INSERT INTO app_setting (key, value)
VALUES ('student_centre_code', '{"code":"VP001"}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------------------------
-- BACKFILL — deterministic, ordered by creation, into the new formats.
-- ---------------------------------------------------------------------------------------------

-- 4. Student ID (customer_no): one per student, sequence per (centre, IST-year of joining).
WITH cc AS (SELECT COALESCE(NULLIF(value->>'code',''),'VP001') AS code FROM app_setting WHERE key='student_centre_code'),
seq AS (
  SELECT s.id,
         (SELECT code FROM cc) AS code,
         EXTRACT(YEAR FROM (s.created_at AT TIME ZONE 'Asia/Kolkata'))::int AS yr,
         row_number() OVER (
           PARTITION BY EXTRACT(YEAR FROM (s.created_at AT TIME ZONE 'Asia/Kolkata'))
           ORDER BY s.created_at, s.id) AS n
    FROM student s
   WHERE s.deleted_at IS NULL AND s.customer_no IS NULL
)
UPDATE student s
   SET customer_no = seq.code || '-' || seq.yr || '-' || lpad(seq.n::text, 3, '0')
  FROM seq WHERE seq.id = s.id;

-- 5. Roll Number: ensure a student_vertical_id row for every existing (student, vertical) pair —
--    home vertical + every enrolment vertical — numbered per (vertical code, IST-year of the pair).
WITH pairs AS (
  SELECT s.id AS student_id, s.vertical_id, s.branch_id, s.org_id, s.created_at AS ts
    FROM student s
   WHERE s.deleted_at IS NULL AND s.vertical_id IS NOT NULL
  UNION ALL
  SELECT s.id, e.vertical_id, e.branch_id, s.org_id, e.created_at
    FROM student s
    JOIN enrolment e ON (e.student_profile_id = s.id OR e.id = s.enrolment_id)
   WHERE s.deleted_at IS NULL AND e.deleted_at IS NULL AND e.vertical_id IS NOT NULL
),
dedup AS (
  SELECT DISTINCT ON (student_id, vertical_id)
         student_id, vertical_id, branch_id, org_id, ts
    FROM pairs
   ORDER BY student_id, vertical_id, ts
),
numbered AS (
  SELECT d.student_id, d.vertical_id, d.branch_id, d.org_id,
         upper(v.code) AS vcode,
         EXTRACT(YEAR FROM (d.ts AT TIME ZONE 'Asia/Kolkata'))::int AS yr,
         row_number() OVER (
           PARTITION BY upper(v.code), EXTRACT(YEAR FROM (d.ts AT TIME ZONE 'Asia/Kolkata'))
           ORDER BY d.ts, d.student_id) AS n
    FROM dedup d JOIN vertical v ON v.id = d.vertical_id
)
INSERT INTO student_vertical_id (org_id, student_id, branch_id, vertical_id, student_vertical_no, created_by)
SELECT org_id, student_id, branch_id, vertical_id,
       vcode || '-' || yr || '-' || lpad(n::text, 3, '0'), NULL
  FROM numbered
ON CONFLICT (student_id, vertical_id) DO NOTHING;

-- 5b. Any PRE-EXISTING vertical-wise ids still in the old SID-YYYY-YY/NNNN format → new format.
WITH numbered AS (
  SELECT svi.id, upper(v.code) AS vcode,
         EXTRACT(YEAR FROM (svi.issued_at AT TIME ZONE 'Asia/Kolkata'))::int AS yr,
         row_number() OVER (
           PARTITION BY upper(v.code), EXTRACT(YEAR FROM (svi.issued_at AT TIME ZONE 'Asia/Kolkata'))
           ORDER BY svi.issued_at, svi.id) AS n
    FROM student_vertical_id svi JOIN vertical v ON v.id = svi.vertical_id
   WHERE svi.student_vertical_no LIKE 'SID-%'
)
UPDATE student_vertical_id svi
   SET student_vertical_no = numbered.vcode || '-' || numbered.yr || '-' || lpad(numbered.n::text, 3, '0')
  FROM numbered WHERE numbered.id = svi.id;

-- 6. Enrolment No: reformat existing ENR-YYYY/NNNN → <COURSE_CODE>-<YEAR>-<NNN>, per (course, IST-year).
WITH numbered AS (
  SELECT e.id,
         upper(COALESCE(NULLIF(c.code,''),'CRS')) AS ccode,
         EXTRACT(YEAR FROM (e.created_at AT TIME ZONE 'Asia/Kolkata'))::int AS yr,
         row_number() OVER (
           PARTITION BY upper(COALESCE(NULLIF(c.code,''),'CRS')),
                        EXTRACT(YEAR FROM (e.created_at AT TIME ZONE 'Asia/Kolkata'))
           ORDER BY e.created_at, e.id) AS n
    FROM enrolment e LEFT JOIN m_course c ON c.id = e.course_id
   WHERE e.deleted_at IS NULL AND e.enrolment_no LIKE 'ENR-%'
)
UPDATE enrolment e
   SET enrolment_no = numbered.ccode || '-' || numbered.yr || '-' || lpad(numbered.n::text, 3, '0')
  FROM numbered WHERE numbered.id = e.id;

-- ---------------------------------------------------------------------------------------------
-- SEED coded_number_seq so future mints CONTINUE the sequence (parse the just-written numbers so
-- the seed is independent of any timestamp/timezone quirk). Codes never contain '-', so split_part
-- is exact: part1=code, part2=year, part3=seq.
-- ---------------------------------------------------------------------------------------------
INSERT INTO coded_number_seq (org_id, scope, code, year, next_seq)
SELECT org_id, 'student', upper(split_part(customer_no,'-',1)), split_part(customer_no,'-',2)::int,
       MAX(split_part(customer_no,'-',3)::int) + 1
  FROM student
 WHERE deleted_at IS NULL AND customer_no ~ '^[A-Za-z0-9]+-[0-9]{4}-[0-9]{3,}$'
 GROUP BY org_id, upper(split_part(customer_no,'-',1)), split_part(customer_no,'-',2)::int
ON CONFLICT (org_id, scope, code, year) DO UPDATE SET next_seq = GREATEST(coded_number_seq.next_seq, EXCLUDED.next_seq);

INSERT INTO coded_number_seq (org_id, scope, code, year, next_seq)
SELECT org_id, 'roll', upper(split_part(student_vertical_no,'-',1)), split_part(student_vertical_no,'-',2)::int,
       MAX(split_part(student_vertical_no,'-',3)::int) + 1
  FROM student_vertical_id
 WHERE student_vertical_no ~ '^[A-Za-z0-9]+-[0-9]{4}-[0-9]{3,}$'
 GROUP BY org_id, upper(split_part(student_vertical_no,'-',1)), split_part(student_vertical_no,'-',2)::int
ON CONFLICT (org_id, scope, code, year) DO UPDATE SET next_seq = GREATEST(coded_number_seq.next_seq, EXCLUDED.next_seq);

INSERT INTO coded_number_seq (org_id, scope, code, year, next_seq)
SELECT org_id, 'enrolment', upper(split_part(enrolment_no,'-',1)), split_part(enrolment_no,'-',2)::int,
       MAX(split_part(enrolment_no,'-',3)::int) + 1
  FROM enrolment
 WHERE deleted_at IS NULL AND enrolment_no ~ '^[A-Za-z0-9]+-[0-9]{4}-[0-9]{3,}$'
 GROUP BY org_id, upper(split_part(enrolment_no,'-',1)), split_part(enrolment_no,'-',2)::int
ON CONFLICT (org_id, scope, code, year) DO UPDATE SET next_seq = GREATEST(coded_number_seq.next_seq, EXCLUDED.next_seq);
