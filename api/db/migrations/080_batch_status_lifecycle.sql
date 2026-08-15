-- =============================================================================
-- 080 — BATCH STATUS LIFECYCLE (client feedback)
--
-- A batch now carries a lifecycle STATUS drawn from 7 codes:
--   upcoming  — confirmed but classes have not started
--   active    — classes are currently running
--   completed — all scheduled classes/course activities completed   (manual)
--   cancelled — batch cancelled before/after starting                (manual)
--   expired   — end date passed without a formal completion/closure  (auto)
--   archived  — historical batch retained for records/reporting      (manual)
--   suspended — batch temporarily paused                             (manual)
--
-- DERIVATION vs MANUAL (India-first, IST):
--   The three DATE-DERIVED statuses (upcoming / active / expired) are computed from the
--   batch's start_date/end_date in the app timezone (Asia/Kolkata):
--       today < start_date            -> upcoming
--       start_date <= today <= end_date (or no bound) -> active
--       today > end_date              -> expired
--   The four MANUAL statuses (completed / cancelled / suspended / archived) are set
--   explicitly by a user and STICK — the date logic never overrides them. status_is_manual
--   marks a batch as manually pinned. A suspended batch can RESUME (clears the pin,
--   re-derives from dates). See batch.service.ts (deriveBatchStatus / refreshBatchStatuses /
--   changeStatus) — the same rule lives once in code; this migration mirrors it for backfill.
--
-- Mirrors the student-status lifecycle (073/074): a seeded catalog + a CHECK on the column +
-- a status-history audit trail. Idempotent throughout (IF NOT EXISTS / ON CONFLICT / guarded).
-- =============================================================================

-- 1 ------------------------------------------------ the status catalog + seed
CREATE TABLE IF NOT EXISTS batch_status_def (
  code        VARCHAR(24) PRIMARY KEY,
  label       VARCHAR(48) NOT NULL,
  meaning     VARCHAR(200) NOT NULL,
  is_manual   BOOLEAN NOT NULL DEFAULT FALSE,
  is_terminal BOOLEAN NOT NULL DEFAULT FALSE,
  ordering    INT NOT NULL DEFAULT 0
);

INSERT INTO batch_status_def (code, label, meaning, is_manual, is_terminal, ordering) VALUES
  ('upcoming',  'Upcoming',  'Batch is confirmed but classes have not started',            FALSE, FALSE, 10),
  ('active',    'Active',    'Classes are currently running',                              FALSE, FALSE, 20),
  ('suspended', 'Suspended', 'Batch temporarily paused',                                   TRUE,  FALSE, 30),
  ('completed', 'Completed', 'All scheduled classes/course activities completed',          TRUE,  TRUE,  40),
  ('cancelled', 'Cancelled', 'Batch cancelled before or after starting',                   TRUE,  TRUE,  50),
  ('expired',   'Expired',   'Batch end date passed without formal completion/closure',    FALSE, TRUE,  60),
  ('archived',  'Archived',  'Historical batch retained for records/reporting',            TRUE,  TRUE,  70)
ON CONFLICT (code) DO NOTHING;

-- 2 ------------------------------------------------ widen batch.status + metadata
ALTER TABLE batch DROP CONSTRAINT IF EXISTS batch_status_check;
ALTER TABLE batch ALTER COLUMN status TYPE VARCHAR(24);
ALTER TABLE batch ALTER COLUMN status SET DEFAULT 'upcoming';

ALTER TABLE batch ADD COLUMN IF NOT EXISTS status_is_manual  BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE batch ADD COLUMN IF NOT EXISTS status_reason     TEXT NULL;
ALTER TABLE batch ADD COLUMN IF NOT EXISTS status_changed_by BIGINT NULL REFERENCES "user"(id);
ALTER TABLE batch ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ NULL;

-- 3 ------------------------------------------------ BACKFILL (guarded, idempotent, deterministic)
-- Legacy terminal statuses (completed / cancelled) were user intent -> keep + pin as manual.
UPDATE batch
   SET status_is_manual = TRUE,
       status_changed_at = COALESCE(status_changed_at, now())
 WHERE status IN ('completed', 'cancelled')
   AND status_is_manual = FALSE;

-- Everything else (the legacy 'active' default) is auto -> derive from dates (IST). No dates:
-- 'active' if the batch already has students, else 'upcoming' (documented sane default).
UPDATE batch b
   SET status = CASE
        WHEN b.start_date IS NOT NULL AND (now() AT TIME ZONE 'Asia/Kolkata')::date < b.start_date THEN 'upcoming'
        WHEN b.end_date   IS NOT NULL AND (now() AT TIME ZONE 'Asia/Kolkata')::date > b.end_date   THEN 'expired'
        WHEN b.start_date IS NULL AND b.end_date IS NULL THEN
             (CASE WHEN EXISTS (SELECT 1 FROM student st WHERE st.batch_id = b.id AND st.deleted_at IS NULL)
                   THEN 'active' ELSE 'upcoming' END)
        ELSE 'active'
       END
 WHERE b.status_is_manual = FALSE;

-- 4 ------------------------------------------------ CHECK over the 7 codes + FK to catalog + index
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'batch_status_check') THEN
    ALTER TABLE batch
      ADD CONSTRAINT batch_status_check
      CHECK (status IN ('upcoming','active','completed','cancelled','expired','archived','suspended'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'batch_status_fk') THEN
    ALTER TABLE batch
      ADD CONSTRAINT batch_status_fk FOREIGN KEY (status) REFERENCES batch_status_def(code);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_batch_status ON batch (status) WHERE deleted_at IS NULL;

-- 5 ------------------------------------------------ the transition history
CREATE TABLE IF NOT EXISTS batch_status_history (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      BIGINT NOT NULL REFERENCES organisation(id),
  branch_id   BIGINT NULL REFERENCES branch(id),
  vertical_id BIGINT NULL REFERENCES vertical(id),
  batch_id    BIGINT NOT NULL REFERENCES batch(id),
  from_status VARCHAR(24) NULL,
  to_status   VARCHAR(24) NOT NULL,
  is_manual   BOOLEAN NOT NULL DEFAULT FALSE,
  reason      TEXT NULL,
  changed_by  BIGINT NULL REFERENCES "user"(id),
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_batch_status_hist_batch ON batch_status_history (batch_id, changed_at DESC);

-- No new permission — the change-status action reuses batch.update (batch create/update are
-- already restricted to Academic Admin / Branch·Vertical Manager / Org·Super Admin, 044 + 070).
