-- ============================================================================
-- 095 — COURSE TYPE MASTER (dev/106, client: "Add a Course Type master")
--
-- Course Type used to be a FIXED seeded catalog (course_type_def, migration 082) exposed
-- read-only via GET /courses/type-catalog — users could NOT add their own types. This makes
-- Course Type a real, self-manageable generic master (m_course_type) exactly like every other
-- master (state / city / tag / status / source / course): CRUD via /api/masters/course_type,
-- add/edit/delete in Administration > Masters, and the course form's Course Type dropdown reads
-- from it with the inline + Master quick-add.
--
-- Back-compat: a course stores the picked Course Type as the LABEL text in m_course.meta
-- (meta->>'course_type', e.g. 'Diploma'). The master's NAME is kept == that label, so every
-- existing course keeps rendering/filtering. The 6 original catalog values are migrated in, plus
-- any DISTINCT course_type already stored on a course (so nothing a client set is ever orphaned).
--
-- Idempotent: IF NOT EXISTS on DDL; every seed guarded by NOT EXISTS-per-row.
-- ============================================================================

-- Generic master table — the m_source shape (001) + soft-delete columns (015),
-- identical to m_training / m_visit_purpose / m_walkin_status (032).
CREATE TABLE IF NOT EXISTS m_course_type (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id BIGINT NOT NULL REFERENCES organisation(id),
  name VARCHAR(120) NOT NULL, code VARCHAR(40),
  sort_order INT NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT TRUE,
  meta JSONB NOT NULL DEFAULT '{}', parent_id BIGINT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT, deleted_at TIMESTAMPTZ NULL, deleted_by BIGINT NULL
);

-- de-dup indexes (008 pattern): per org, active rows, case-insensitive on name & code.
CREATE UNIQUE INDEX IF NOT EXISTS uq_m_course_type_active_name ON m_course_type (org_id, lower(name)) WHERE is_active;
CREATE UNIQUE INDEX IF NOT EXISTS uq_m_course_type_active_code ON m_course_type (org_id, lower(code)) WHERE is_active AND code IS NOT NULL;

-- Seeds — (a) the original 6 course_type_def values so NOTHING regresses, and (b) any DISTINCT
-- course_type already stored on a course that isn't one of them (a client could have typed one
-- before this master existed). name == the label already in m_course.meta->>'course_type'.
DO $$
DECLARE v_org BIGINT;
BEGIN
  SELECT id INTO v_org FROM organisation ORDER BY id LIMIT 1;
  IF v_org IS NULL THEN RETURN; END IF;   -- fresh DB: seed.ts seeds this instead

  -- (a) the original 6
  INSERT INTO m_course_type (org_id, name, code, sort_order)
  SELECT v_org, v.name, v.code, v.ord
    FROM (VALUES
            ('Diploma',          'DIPLOMA',  10),
            ('Certificate',      'CERT',     20),
            ('Foundation',       'FOUND',    30),
            ('Crash Course',     'CRASH',    40),
            ('Advanced Diploma', 'ADVDIP',   50),
            ('Workshop',         'WORKSHOP', 60)
         ) AS v(name, code, ord)
   WHERE NOT EXISTS (SELECT 1 FROM m_course_type m WHERE m.org_id = v_org AND lower(m.name) = lower(v.name));

  -- (b) any course_type already stored on a course but not yet a master row (no data loss)
  INSERT INTO m_course_type (org_id, name, sort_order)
  SELECT v_org, t.ct, 100 + (row_number() OVER (ORDER BY t.ct))::int
    FROM (SELECT DISTINCT trim(meta->>'course_type') AS ct
            FROM m_course
           WHERE deleted_at IS NULL AND COALESCE(trim(meta->>'course_type'), '') <> '') t
   WHERE NOT EXISTS (SELECT 1 FROM m_course_type m WHERE m.org_id = v_org AND lower(m.name) = lower(t.ct));
END $$;
