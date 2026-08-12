-- 062: Student BRANCH transfer history + attendance HALF_DAY status.
-- Idempotent. Two independent client changes ride together:
--   (1) a student may be moved from one Branch (and Vertical/Batch) to another — a
--       re-parent recorded in student_transfer (from/to branch+vertical+batch, who, why);
--   (2) the academic attendance status set gains 'half_day' so the roster letter-buttons
--       can offer P / A / H / L / E.

-- ---------------------------------------------------------------------------
-- (1) Attendance: add 'half_day' to the status CHECK (was present/absent/late/excused).
--     'half_day' is 8 chars — fits the existing VARCHAR(12). Drop-then-add is idempotent.
-- ---------------------------------------------------------------------------
ALTER TABLE attendance DROP CONSTRAINT IF EXISTS attendance_status_check;
ALTER TABLE attendance
  ADD CONSTRAINT attendance_status_check
  CHECK (status IN ('present', 'absent', 'late', 'excused', 'half_day'));

-- ---------------------------------------------------------------------------
-- (2) Student branch transfer — one row per move. Mirrors batch_transfer (047) but at the
--     Branch/Vertical level. from_* may be NULL (defensive); to_branch is always set.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS student_transfer (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id           BIGINT NOT NULL REFERENCES organisation(id),
  student_id       BIGINT NOT NULL REFERENCES student(id),
  from_branch_id   BIGINT NULL REFERENCES branch(id),
  to_branch_id     BIGINT NOT NULL REFERENCES branch(id),
  from_vertical_id BIGINT NULL REFERENCES vertical(id),
  to_vertical_id   BIGINT NULL REFERENCES vertical(id),
  from_batch_id    BIGINT NULL REFERENCES batch(id),
  to_batch_id      BIGINT NULL REFERENCES batch(id),
  reason           TEXT NULL,
  transferred_by   BIGINT NULL REFERENCES "user"(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_student_transfer_student
  ON student_transfer (student_id, created_at DESC);
