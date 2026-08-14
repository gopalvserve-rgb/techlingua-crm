-- =============================================================================
-- 079 — VERTICAL-WISE STUDENT ID (client feedback)
--
-- "Student ID needs to be generated vertical-wise for multiple enrolments."
--
-- The internal master identifier `student.student_no` (STU-) is UNCHANGED — it stays the
-- record key (non-breaking). This migration ADDS a NEW dimension: a display Student ID
-- minted PER (student, vertical), from the numbering series scoped to that branch+vertical
-- (Indian-FY aware, like invoices/refunds), so a student enrolled across two verticals gets
-- TWO distinct IDs — one per vertical.
--
--   * new numbering kind `student_vertical` (prefix SID-, reset per Indian FY) — the code
--     side (numbering.service.ts) registers the default; here we seed the org-wide row so the
--     backfill and the first live allocation share one counter.
--   * new table `student_vertical_id` — one row per (student, vertical), UNIQUE, holding the
--     minted display number. Minted the FIRST time a student gets an enrolment in a vertical;
--     reused for every further enrolment in the same vertical.
--   * BACKFILL — every existing (student, vertical) pair that already has an enrolment gets a
--     minted number, ordered by the earliest enrolment so numbering is STABLE + deterministic,
--     drawn from the org-wide series counter (most-specific-wins: no per-vertical rows exist
--     yet, so all draw from the org series — the same rule STU-/EMP-/INV- already use).
--
-- Idempotent + re-runnable (IF NOT EXISTS / ON CONFLICT / NOT EXISTS guards; GREATEST keeps
-- the live counter from ever regressing).
-- =============================================================================

-- 1) the per-(student, vertical) display-ID table -----------------------------
CREATE TABLE IF NOT EXISTS student_vertical_id (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id               BIGINT NOT NULL REFERENCES organisation(id),
  student_id           BIGINT NOT NULL REFERENCES student(id),
  branch_id            BIGINT NULL REFERENCES branch(id),
  vertical_id          BIGINT NOT NULL REFERENCES vertical(id),
  student_vertical_no  VARCHAR(64) NOT NULL,
  issued_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by           BIGINT NULL REFERENCES "user"(id),
  CONSTRAINT uq_student_vertical UNIQUE (student_id, vertical_id)
);
CREATE INDEX IF NOT EXISTS idx_student_vertical_id_vertical ON student_vertical_id (vertical_id);
CREATE INDEX IF NOT EXISTS idx_student_vertical_id_student  ON student_vertical_id (student_id);

-- 2) seed the org-wide numbering series + backfill existing (student, vertical) pairs
DO $$
DECLARE
  v_org        BIGINT;
  v_series_id  BIGINT;
  v_prefix     TEXT;
  v_padding    INT;
  rec          RECORD;
  v_token      TEXT;
  v_seq        BIGINT;
  v_no         TEXT;
  v_cur_token  TEXT;
BEGIN
  SELECT id INTO v_org FROM organisation ORDER BY id LIMIT 1;
  IF v_org IS NULL THEN RETURN; END IF;

  INSERT INTO number_series (org_id, kind, prefix, next_number, padding, reset_period)
  VALUES (v_org, 'student_vertical', 'SID-', 1, 4, 'fy')
  ON CONFLICT (org_id, kind, COALESCE(branch_id, 0), COALESCE(vertical_id, 0)) DO NOTHING;

  SELECT id, prefix, padding INTO v_series_id, v_prefix, v_padding
    FROM number_series
   WHERE org_id = v_org AND kind = 'student_vertical' AND branch_id IS NULL AND vertical_id IS NULL;

  CREATE TEMP TABLE _sv_counter (token TEXT PRIMARY KEY, n BIGINT) ON COMMIT DROP;

  FOR rec IN
    SELECT sub.student_id, sub.vertical_id, sub.branch_id, sub.first_created
      FROM (
        SELECT e.student_profile_id AS student_id, e.vertical_id,
               MIN(e.branch_id) AS branch_id, MIN(e.created_at) AS first_created
          FROM enrolment e
         WHERE e.deleted_at IS NULL AND e.student_profile_id IS NOT NULL AND e.vertical_id IS NOT NULL
         GROUP BY e.student_profile_id, e.vertical_id
      ) sub
     WHERE NOT EXISTS (SELECT 1 FROM student_vertical_id svi
                        WHERE svi.student_id = sub.student_id AND svi.vertical_id = sub.vertical_id)
       AND EXISTS (SELECT 1 FROM student s WHERE s.id = sub.student_id AND s.deleted_at IS NULL)
     ORDER BY sub.first_created ASC, sub.student_id ASC, sub.vertical_id ASC
  LOOP
    v_token := CASE WHEN EXTRACT(MONTH FROM rec.first_created) >= 4
                    THEN to_char(rec.first_created, 'YYYY') || '-' || lpad(((EXTRACT(YEAR FROM rec.first_created)::int + 1) % 100)::text, 2, '0')
                    ELSE (EXTRACT(YEAR FROM rec.first_created)::int - 1)::text || '-' || lpad((EXTRACT(YEAR FROM rec.first_created)::int % 100)::text, 2, '0')
               END;
    INSERT INTO _sv_counter(token, n) VALUES (v_token, 1)
      ON CONFLICT (token) DO UPDATE SET n = _sv_counter.n + 1
      RETURNING n INTO v_seq;
    v_no := v_prefix || v_token || '/' || lpad(v_seq::text, v_padding, '0');
    INSERT INTO student_vertical_id (org_id, student_id, branch_id, vertical_id, student_vertical_no, issued_at, created_by)
      VALUES (v_org, rec.student_id, rec.branch_id, rec.vertical_id, v_no, rec.first_created, NULL)
      ON CONFLICT (student_id, vertical_id) DO NOTHING;
  END LOOP;

  -- advance the live counter to continue from the CURRENT Indian FY (never regress)
  v_cur_token := CASE WHEN EXTRACT(MONTH FROM now()) >= 4
                      THEN to_char(now(), 'YYYY') || '-' || lpad(((EXTRACT(YEAR FROM now())::int + 1) % 100)::text, 2, '0')
                      ELSE (EXTRACT(YEAR FROM now())::int - 1)::text || '-' || lpad((EXTRACT(YEAR FROM now())::int % 100)::text, 2, '0')
                 END;
  UPDATE number_series ns
     SET next_number  = GREATEST(ns.next_number, COALESCE((SELECT n FROM _sv_counter WHERE token = v_cur_token), 0) + 1),
         period_token = v_cur_token,
         updated_at   = now()
   WHERE ns.id = v_series_id;
END $$;
