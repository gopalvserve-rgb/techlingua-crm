-- =============================================================================
-- 112 — BATCH ↔ COURSE LEVELS (27aug Batch C, item 3)
--
-- A batch may optionally target one or more of its course's levels (A1/A2/…). When the
-- course has levels the Add/Edit Batch form shows an OPTIONAL Course Level multi-select;
-- when the course has none the selector is hidden and no rows are written. Snapshot of the
-- level code/label is kept so a later master edit never blanks a batch's history.
-- Idempotent.
-- =============================================================================

CREATE TABLE IF NOT EXISTS batch_level (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          BIGINT NOT NULL REFERENCES organisation(id),
  batch_id        BIGINT NOT NULL REFERENCES batch(id) ON DELETE CASCADE,
  course_level_id BIGINT NULL REFERENCES course_level(id),  -- may go NULL if the master level is removed
  code            VARCHAR(64) NOT NULL,                     -- level code snapshot, e.g. 'A1'
  label           VARCHAR(96) NULL,                         -- optional display label (defaults to code)
  ordering        INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_batch_level_batch ON batch_level (batch_id, ordering);
CREATE UNIQUE INDEX IF NOT EXISTS ux_batch_level_batch_code ON batch_level (batch_id, lower(code));
