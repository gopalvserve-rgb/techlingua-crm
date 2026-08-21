-- ============================================================================
-- 097 — LEVEL MASTER (dev/114, client: "Add a Level master also in Settings")
--
-- Course LEVELS (A1, A2, B1, B2, C1, C2, …) used to be a FIXED seeded catalog
-- (course_level_def, migration 082) exposed read-only via GET /courses/level-catalog —
-- users could NOT add their own level codes. This makes Level a real, self-manageable
-- generic master (m_level) exactly like the Course Type master (dev/106, m_course_type)
-- and every other master (state / city / tag / status / source / course): CRUD via
-- /api/masters/level, add/edit/delete in Administration > Masters, and the course form's
-- Level picker reads from it with the inline + Master quick-add.
--
-- TWO level concepts (unchanged): this master is the CATALOG of level CODES (the dropdown
-- OPTIONS, A1..C2) — NOT the per-course `course_level` fee rows (091). A course's actual
-- levels+fees stay in course_level; those rows store the level code as text.
--
-- Back-compat: course_level.code and m_course.meta->>'level' store the level as the LABEL
-- text (e.g. 'A1'). The master's NAME is kept == that label, so every existing course-level
-- row and course keeps rendering/filtering with no data migration. The original 10 catalog
-- values (A1, A2, B1, B2, C1, C2, Beginner, Intermediate, Advanced, Expert) are migrated in,
-- plus any DISTINCT level already stored on a course_level row or a course (so nothing a
-- client set is ever orphaned).
--
-- Idempotent: IF NOT EXISTS on DDL; every seed guarded by NOT EXISTS-per-row.
-- ============================================================================

-- Generic master table — the m_source shape (001) + soft-delete columns (015),
-- identical to m_course_type (095) / m_training / m_visit_purpose / m_walkin_status (032).
CREATE TABLE IF NOT EXISTS m_level (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id BIGINT NOT NULL REFERENCES organisation(id),
  name VARCHAR(120) NOT NULL, code VARCHAR(40),
  sort_order INT NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT TRUE,
  meta JSONB NOT NULL DEFAULT '{}', parent_id BIGINT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT, deleted_at TIMESTAMPTZ NULL, deleted_by BIGINT NULL
);

-- de-dup indexes (008 pattern): per org, active rows, case-insensitive on name & code.
CREATE UNIQUE INDEX IF NOT EXISTS uq_m_level_active_name ON m_level (org_id, lower(name)) WHERE is_active;
CREATE UNIQUE INDEX IF NOT EXISTS uq_m_level_active_code ON m_level (org_id, lower(code)) WHERE is_active AND code IS NOT NULL;

-- Seeds — (a) the original course_level_def catalog values so NOTHING regresses, (b) any DISTINCT
-- level already stored on a per-course course_level row, and (c) any DISTINCT level already stored
-- on a course's meta->>'level'. name == code == the label already used everywhere (e.g. 'A1').
DO $$
DECLARE v_org BIGINT;
BEGIN
  SELECT id INTO v_org FROM organisation ORDER BY id LIMIT 1;
  IF v_org IS NULL THEN RETURN; END IF;   -- fresh DB: seed.ts seeds this instead

  -- (a) the original catalog (A1, A2, B1, B2, C1, C2, Beginner, Intermediate, Advanced, Expert)
  INSERT INTO m_level (org_id, name, code, sort_order)
  SELECT v_org, d.label, d.code, d.ordering
    FROM course_level_def d
   WHERE NOT EXISTS (SELECT 1 FROM m_level m WHERE m.org_id = v_org AND lower(m.name) = lower(d.label));

  -- (b) any level already used on a per-course course_level row but not yet a master row
  INSERT INTO m_level (org_id, name, sort_order)
  SELECT v_org, t.lv, 200 + (row_number() OVER (ORDER BY t.lv))::int
    FROM (SELECT DISTINCT trim(code) AS lv
            FROM course_level
           WHERE COALESCE(trim(code), '') <> '') t
   WHERE NOT EXISTS (SELECT 1 FROM m_level m WHERE m.org_id = v_org AND lower(m.name) = lower(t.lv));

  -- (c) any level stored on a course's meta but not yet a master row (no data loss)
  INSERT INTO m_level (org_id, name, sort_order)
  SELECT v_org, t.lv, 300 + (row_number() OVER (ORDER BY t.lv))::int
    FROM (SELECT DISTINCT trim(meta->>'level') AS lv
            FROM m_course
           WHERE deleted_at IS NULL AND COALESCE(trim(meta->>'level'), '') <> '') t
   WHERE NOT EXISTS (SELECT 1 FROM m_level m WHERE m.org_id = v_org AND lower(m.name) = lower(t.lv));
END $$;
